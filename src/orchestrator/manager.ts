/**
 * OrchestratorManager — the bridge between TUI state and orchestrator session.
 *
 * Manages multiple goals (each with its own pi session), subscribes to
 * both the pi SDK session events and the orchestrator event bus, and
 * translates events into TUI state updates.
 */

import type { AgentSession, AgentSessionEvent } from '@mariozechner/pi-coding-agent';
import type { ShepherdsPiConfig } from '../config/index.js';
import type { ShepherdsDB, DbAgentRun, DbMessage } from '../db/index.js';
import { createOrchestratorSession, startOrchestrator, type OrchestratorSession } from './session.js';
import { OrchestratorEventBus, type OrchestratorEvent } from './event-bus.js';
import type {
  Goal, GoalStatus, AgentRun, AgentStatus, AgentResult,
  ChatMessage, Plan, PlanStep,
} from '../types.js';

// ─── State change callback ──────────────────────────────────────

export type StateChangeCallback = () => void;

// ─── Manager ────────────────────────────────────────────────────

export class OrchestratorManager {
  private config: ShepherdsPiConfig;
  private goals: Map<string, GoalState> = new Map();
  private listeners: Set<StateChangeCallback> = new Set();
  private _activeGoalId: string | null = null;

  constructor(config: ShepherdsPiConfig) {
    this.config = config;
  }

  // ─── Public state accessors ───────────────────────────────────

  get activeGoalId(): string | null {
    return this._activeGoalId;
  }

  get allGoals(): Goal[] {
    return [...this.goals.values()].map(g => g.goal);
  }

  getActiveGoal(): Goal | null {
    if (!this._activeGoalId) return null;
    return this.goals.get(this._activeGoalId)?.goal ?? null;
  }

  getActiveSession(): OrchestratorSession | null {
    if (!this._activeGoalId) return null;
    return this.goals.get(this._activeGoalId)?.session ?? null;
  }

  getMessages(goalId: string): ChatMessage[] {
    return this.goals.get(goalId)?.messages ?? [];
  }

  getAgents(goalId: string): AgentRun[] {
    return this.goals.get(goalId)?.agents ?? [];
  }

  getPlan(goalId: string): Plan | null {
    return this.goals.get(goalId)?.plan ?? null;
  }

  getAskUserQuestion(goalId: string): string | null {
    return this.goals.get(goalId)?.pendingAskUser ?? null;
  }

  // ─── Subscribe to state changes ──────────────────────────────

  onChange(callback: StateChangeCallback): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  private notify() {
    for (const cb of this.listeners) cb();
  }

  // ─── Goal management ─────────────────────────────────────────

  /**
   * Start a new goal — creates a pi session, sends the goal as the first prompt.
   */
  async startGoal(goalText: string): Promise<string> {
    const goalId = `goal-${Date.now().toString(36)}`;

    const goal: Goal = {
      id: goalId,
      goal: goalText,
      status: 'planning',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const state: GoalState = {
      goal,
      session: null,
      messages: [{
        id: `msg-${Date.now()}`,
        goalId,
        role: 'user',
        content: goalText,
        timestamp: new Date().toISOString(),
      }],
      agents: [],
      plan: null,
      pendingAskUser: null,
      askUserResolver: null,
      unsubPi: null,
      unsubBus: null,
    };

    this.goals.set(goalId, state);
    this._activeGoalId = goalId;
    this.notify();

    // Create the orchestrator session asynchronously
    try {
      const session = await createOrchestratorSession({
        config: this.config,
        goal: goalText,
      });

      state.session = session;

      // Wire up event listeners
      this.wireSessionEvents(goalId, session);
      this.wireBusEvents(goalId, session.eventBus);

      // Send the goal
      this.addMessage(goalId, 'coordinator', 'Starting orchestration...');
      this.notify();

      // Start the orchestrator (non-blocking — it runs until it needs input or finishes)
      startOrchestrator(session, goalText).catch(err => {
        const msg = err instanceof Error ? err.message : String(err);
        this.addMessage(goalId, 'coordinator', `⚠️ Orchestration error: ${msg}`);
        state.goal.status = 'failed';
        this.notify();
      });

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.addMessage(goalId, 'coordinator', `⚠️ Failed to start: ${msg}`);
      state.goal.status = 'failed';
      this.notify();
    }

    return goalId;
  }

  /**
   * Switch the active goal (for multi-goal support).
   */
  switchGoal(goalId: string): void {
    if (this.goals.has(goalId)) {
      this._activeGoalId = goalId;
      this.notify();
    }
  }

  /**
   * Send a user message to the active goal's orchestrator session.
   * If there's a pending ask_user, the response resolves it.
   * Otherwise, it's a regular prompt to the session.
   */
  async sendUserMessage(text: string): Promise<void> {
    if (!this._activeGoalId) return;
    const state = this.goals.get(this._activeGoalId);
    if (!state) return;

    this.addMessage(this._activeGoalId, 'user', text);

    // If there's a pending ask_user, resolve it
    if (state.askUserResolver) {
      state.askUserResolver(text);
      state.pendingAskUser = null;
      state.askUserResolver = null;
      this.notify();
      return;
    }

    // Otherwise, send as a prompt to the session
    if (state.session) {
      state.session.session.prompt(text).catch(err => {
        const msg = err instanceof Error ? err.message : String(err);
        this.addMessage(this._activeGoalId!, 'coordinator', `⚠️ Error: ${msg}`);
        this.notify();
      });
    }

    this.notify();
  }

  // ─── Event wiring ────────────────────────────────────────────

  private wireSessionEvents(goalId: string, session: OrchestratorSession): void {
    const state = this.goals.get(goalId)!;

    state.unsubPi = session.session.subscribe((event: AgentSessionEvent) => {
      this.handlePiEvent(goalId, event);
    });
  }

  private wireBusEvents(goalId: string, eventBus: OrchestratorEventBus): void {
    const state = this.goals.get(goalId)!;

    state.unsubBus = eventBus.onEvent((event: OrchestratorEvent) => {
      this.handleBusEvent(goalId, event);
    });
  }

  // ─── pi SDK session events ───────────────────────────────────

  private handlePiEvent(goalId: string, event: AgentSessionEvent): void {
    const state = this.goals.get(goalId);
    if (!state) return;

    if ('type' in event) {
      switch (event.type) {
        case 'agent_start':
          this.addMessage(goalId, 'coordinator', '🤖 Coordinator is thinking...');
          break;

        case 'message_end': {
          // Assistant message completed — extract text content
          const msg = event.message;
          if (msg.role === 'assistant') {
            const textContent = msg.content
              .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
              .map(c => c.text)
              .join('\n');
            if (textContent.trim()) {
              // Replace the "thinking..." message with the actual content
              this.replaceLastCoordinatorMessage(goalId, textContent);
            }
          }
          break;
        }

        case 'message_update': {
          // Stream text deltas — update the last coordinator message in place
          const msg = event.message;
          if (msg.role === 'assistant') {
            const textContent = msg.content
              .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
              .map(c => c.text)
              .join('');
            if (textContent) {
              this.updateLastCoordinatorMessage(goalId, textContent);
            }
          }
          break;
        }

        case 'tool_execution_start': {
          const toolName = event.toolName;
          const toolLabel = this.getToolLabel(toolName);
          const summary = this.getToolSummary(toolName, event.args);
          this.addMessage(goalId, 'tool_notification', `${toolLabel} ${summary}`, {
            toolName,
          });
          break;
        }

        case 'tool_execution_end': {
          // Optionally update the tool notification with result
          if (event.isError) {
            this.addMessage(goalId, 'tool_notification', `⚠️ ${event.toolName} failed`, {
              toolName: event.toolName,
            });
          }
          break;
        }

        case 'agent_end':
          if (state.goal.status !== 'failed') {
            state.goal.status = 'completed';
          }
          this.addMessage(goalId, 'coordinator', '✅ Orchestration complete.');
          break;

        case 'compaction_start':
          this.addMessage(goalId, 'tool_notification', '🔄 Context compacted — coordinator will read_run_log to recover', {
            toolName: 'compaction',
          });
          break;
      }
    }

    this.notify();
  }

  // ─── Orchestrator event bus events ───────────────────────────

  private handleBusEvent(goalId: string, event: OrchestratorEvent): void {
    const state = this.goals.get(goalId);
    if (!state) return;

    switch (event.type) {
      case 'goal_status_changed':
        state.goal.status = event.status as GoalStatus;
        state.goal.updatedAt = new Date().toISOString();
        if (event.message) {
          this.addMessage(goalId, 'coordinator', `Status: ${event.status} — ${event.message}`);
        }
        break;

      case 'plan_updated':
        this.refreshPlan(goalId);
        break;

      case 'agent_spawned':
        // Agent will be added to DB by the tool — refresh from DB
        this.refreshAgents(goalId);
        this.addMessage(goalId, 'tool_notification',
          `🔧 Agent spawned: ${event.agentId} (${event.persona})${event.branch ? ` on ${event.branch}` : ''}`,
          { toolName: 'spawn_agent', agentId: event.agentId, persona: event.persona, branch: event.branch }
        );
        break;

      case 'agent_completed':
        this.refreshAgents(goalId);
        const summary = (event.result as { summary?: string })?.summary ?? 'done';
        this.addMessage(goalId, 'tool_notification',
          `✅ Agent completed: ${event.agentId} — ${summary}`,
          { toolName: 'spawn_agent', agentId: event.agentId }
        );
        break;

      case 'agent_failed':
        this.refreshAgents(goalId);
        this.addMessage(goalId, 'tool_notification',
          `❌ Agent failed: ${event.agentId} — ${event.error}`,
          { toolName: 'spawn_agent', agentId: event.agentId }
        );
        break;

      case 'agent_event':
        // Individual tool events from agents — could be used for live stream
        // For now, just log at debug level
        break;

      case 'branch_created':
        this.addMessage(goalId, 'tool_notification',
          `🌿 Branch created: ${event.name} (from ${event.base})`,
          { toolName: 'create_branch' }
        );
        break;

      case 'user_question': {
        // The coordinator is asking the user a question
        state.pendingAskUser = event.question;
        state.askUserResolver = event.resolve;
        this.addMessage(goalId, 'ask_user', event.question);
        break;
      }
    }

    this.notify();
  }

  // ─── DB refresh helpers ──────────────────────────────────────

  private refreshAgents(goalId: string): void {
    const state = this.goals.get(goalId);
    if (!state?.session) return;

    const dbAgents = state.session.db.getAgentRunsForGoal(state.session.runId);
    state.agents = dbAgents.map(a => this.dbAgentToAgentRun(a, goalId));
  }

  private refreshPlan(goalId: string): void {
    const state = this.goals.get(goalId);
    if (!state?.session) return;

    const dbPlan = state.session.db.getPlan(state.session.runId);
    if (dbPlan) {
      try {
        const parsed = JSON.parse(dbPlan.steps);
        state.plan = {
          id: dbPlan.id,
          goalId,
          steps: (parsed.steps ?? []) as PlanStep[],
          version: dbPlan.version,
        };
      } catch {
        state.plan = null;
      }
    }
  }

  // ─── Message helpers ─────────────────────────────────────────

  private addMessage(goalId: string, role: ChatMessage['role'], content: string, meta?: ChatMessage['meta']): void {
    const state = this.goals.get(goalId);
    if (!state) return;

    state.messages.push({
      id: `msg-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      goalId,
      role,
      content,
      timestamp: new Date().toISOString(),
      meta,
    });

    // Also persist to DB
    if (state.session) {
      state.session.db.appendMessage(state.session.runId, role, content);
    }
  }

  private replaceLastCoordinatorMessage(goalId: string, content: string): void {
    const state = this.goals.get(goalId);
    if (!state) return;

    // Find the last coordinator message and replace it
    for (let i = state.messages.length - 1; i >= 0; i--) {
      if (state.messages[i].role === 'coordinator') {
        state.messages[i] = { ...state.messages[i], content };
        return;
      }
    }

    // No existing message to replace — add new one
    this.addMessage(goalId, 'coordinator', content);
  }

  private updateLastCoordinatorMessage(goalId: string, streamingText: string): void {
    const state = this.goals.get(goalId);
    if (!state) return;

    for (let i = state.messages.length - 1; i >= 0; i--) {
      if (state.messages[i].role === 'coordinator') {
        state.messages[i] = { ...state.messages[i], content: streamingText };
        return;
      }
    }

    // No existing message — add new one
    this.addMessage(goalId, 'coordinator', streamingText);
  }

  // ─── DB row → TUI type converters ────────────────────────────

  private dbAgentToAgentRun(a: DbAgentRun, goalId: string): AgentRun {
    let result: AgentResult | undefined;
    if (a.result) {
      try { result = JSON.parse(a.result) as AgentResult; } catch { /* ignore */ }
    }

    return {
      id: a.id,
      goalId,
      stepId: a.step_id,
      persona: a.persona,
      model: a.model,
      instructions: a.instructions,
      context: a.context ?? undefined,
      branch: a.branch ?? undefined,
      containerId: a.container_id ?? undefined,
      status: a.status as AgentStatus,
      result,
      startedAt: a.started_at,
      completedAt: a.completed_at ?? undefined,
    };
  }

  // ─── Label helpers ───────────────────────────────────────────

  private getToolLabel(name: string): string {
    const labels: Record<string, string> = {
      spawn_agent: '🔧',
      spawn_agents: '🔧',
      create_branch: '🌿',
      list_branches: '📋',
      get_branch_diff: '📊',
      read_plan: '📖',
      update_plan: '📝',
      read_run_log: '📜',
      ask_user: '❓',
      update_goal_status: '🔄',
    };
    return labels[name] ?? '⚡';
  }

  private getToolSummary(name: string, args: unknown): string {
    const a = args as Record<string, unknown>;
    switch (name) {
      case 'spawn_agent': return `Spawning ${a.persona} agent`;
      case 'spawn_agents': return `Spawning ${(a.agents as unknown[])?.length ?? '?'} agents`;
      case 'create_branch': return `Creating branch ${a.name}`;
      case 'read_plan': return 'Reading plan';
      case 'update_plan': return 'Updating plan';
      case 'read_run_log': return 'Reading run log';
      case 'ask_user': return String(a.question ?? 'Asking user');
      case 'update_goal_status': return `Status → ${a.status}`;
      case 'list_branches': return 'Listing branches';
      case 'get_branch_diff': return `Diff for ${a.branch}`;
      default: return name;
    }
  }

  // ─── Cleanup ─────────────────────────────────────────────────

  dispose(): void {
    for (const state of this.goals.values()) {
      state.unsubPi?.();
      state.unsubBus?.();
    }
    this.goals.clear();
  }
}

// ─── Internal goal state ────────────────────────────────────────

interface GoalState {
  goal: Goal;
  session: OrchestratorSession | null;
  messages: ChatMessage[];
  agents: AgentRun[];
  plan: Plan | null;
  pendingAskUser: string | null;
  askUserResolver: ((response: string) => void) | null;
  unsubPi: (() => void) | null;
  unsubBus: (() => void) | null;
}
