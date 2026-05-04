/**
 * OrchestratorManager — wiring layer between pi sessions and the TUI.
 *
 * Responsibilities (and only these):
 *   1. Goal lifecycle: start / switch / dispose / accept user messages
 *   2. Session wiring: subscribe to pi SDK events and the orchestrator
 *      event bus, route them through the pure translator
 *   3. Apply deltas to the goal snapshot + trigger DB refresh when a
 *      delta asks for it
 *   4. Schedule or flush notifications via NotifyScheduler
 *
 * Everything else lives elsewhere:
 *   - Event translation          → translator.ts (pure, testable)
 *   - Snapshot transformations   → state.ts
 *   - Tool label/icon strings    → labels.ts
 *   - Notification throttling    → notify.ts
 *
 * The manager never mutates snapshot fields in place. Each delta
 * produces a new snapshot; unchanged goals keep the same reference,
 * so React.memo can skip re-rendering unrelated panes.
 */

import type { AgentSessionEvent } from '@mariozechner/pi-coding-agent';
import type { ShepherdsPiConfig } from '../config/index.js';
import type { DbAgentRun } from '../db/index.js';
import type {
  Goal, GoalStatus, AgentRun, AgentStatus, AgentResult,
  ChatMessage, Plan, PlanStep,
} from '../types.js';
import {
  createOrchestratorSession,
  startOrchestrator,
  type OrchestratorSession,
} from './session.js';
import type { OrchestratorEvent, OrchestratorEventBus } from './event-bus.js';
import {
  createSnapshot,
  withAgents,
  withAskUser,
  withGoal,
  withMessageAppended,
  withPlan,
  withThinkingRemoved,
  withThinkingReplaced,
  type GoalSnapshot,
} from './state.js';
import {
  translateBusEvent,
  translatePiEvent,
  type Delta,
  type TranslatorContext,
} from './translator.js';
import { NotifyScheduler } from './notify.js';

export type StateChangeCallback = () => void;

// ─── Internal per-goal bookkeeping ──────────────────────────────
// `snapshot` is swapped atomically by applyDeltas.

interface GoalBinding {
  snapshot: GoalSnapshot;
  session: OrchestratorSession | null;
  unsubPi: (() => void) | null;
  unsubBus: (() => void) | null;
}

// ─── Manager ────────────────────────────────────────────────────

export class OrchestratorManager {
  private config: ShepherdsPiConfig;
  private bindings: Map<string, GoalBinding> = new Map();
  private notifier = new NotifyScheduler();
  private _activeGoalId: string | null = null;
  private messageCounter = 0;

  constructor(config: ShepherdsPiConfig) {
    this.config = config;
  }

  // ─── Public state accessors ───────────────────────────────────

  get activeGoalId(): string | null {
    return this._activeGoalId;
  }

  get allGoals(): Goal[] {
    return [...this.bindings.values()].map(b => b.snapshot.goal);
  }

  getActiveGoal(): Goal | null {
    return this._activeGoalId
      ? this.bindings.get(this._activeGoalId)?.snapshot.goal ?? null
      : null;
  }

  getActiveSession(): OrchestratorSession | null {
    return this._activeGoalId
      ? this.bindings.get(this._activeGoalId)?.session ?? null
      : null;
  }

  // These return the snapshot's field — same reference across renders
  // when nothing changed, so React.memo downstream can skip work.
  getMessages(goalId: string): ReadonlyArray<ChatMessage> {
    return this.bindings.get(goalId)?.snapshot.messages ?? EMPTY_MESSAGES;
  }

  getAgents(goalId: string): ReadonlyArray<AgentRun> {
    return this.bindings.get(goalId)?.snapshot.agents ?? EMPTY_AGENTS;
  }

  getPlan(goalId: string): Plan | null {
    return this.bindings.get(goalId)?.snapshot.plan ?? null;
  }

  getAskUserQuestion(goalId: string): string | null {
    return this.bindings.get(goalId)?.snapshot.askUser?.question ?? null;
  }

  onChange(callback: StateChangeCallback): () => void {
    return this.notifier.subscribe(callback);
  }

  // ─── Goal lifecycle ──────────────────────────────────────────

  async startGoal(goalText: string): Promise<string> {
    const goalId = `goal-${Date.now().toString(36)}`;

    const goal: Goal = {
      id: goalId,
      goal: goalText,
      status: 'planning',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const initialMessage: ChatMessage = {
      id: this.nextMessageId(),
      goalId,
      role: 'user',
      content: goalText,
      timestamp: new Date().toISOString(),
    };

    this.bindings.set(goalId, {
      snapshot: createSnapshot(goal, [initialMessage]),
      session: null,
      unsubPi: null,
      unsubBus: null,
    });
    this._activeGoalId = goalId;
    this.notifier.flush();

    try {
      const session = await createOrchestratorSession({
        config: this.config,
        goal: goalText,
      });

      const binding = this.bindings.get(goalId);
      if (!binding) return goalId; // disposed while awaiting
      binding.session = session;

      this.wireSessionEvents(goalId, session);
      this.wireBusEvents(goalId, session.eventBus);

      // Show the "Starting orchestration..." marker with an immediate flush
      // since the user just submitted the goal and is waiting for feedback.
      this.applyDeltas(goalId, [{
        kind: 'add-message',
        message: this.makeCoordMsg(goalId, 'Starting orchestration...'),
        notifyNow: true,
      }]);

      startOrchestrator(session, goalText).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.applyDeltas(goalId, [
          {
            kind: 'add-message',
            message: this.makeCoordMsg(goalId, `⚠️ Orchestration error: ${msg}`),
            notifyNow: true,
          },
          { kind: 'set-goal-status', status: 'failed', notifyNow: true },
        ]);
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.applyDeltas(goalId, [
        {
          kind: 'add-message',
          message: this.makeCoordMsg(goalId, `⚠️ Failed to start: ${msg}`),
          notifyNow: true,
        },
        { kind: 'set-goal-status', status: 'failed', notifyNow: true },
      ]);
    }

    return goalId;
  }

  switchGoal(goalId: string): void {
    if (this.bindings.has(goalId)) {
      this._activeGoalId = goalId;
      this.notifier.flush();
    }
  }

  async sendUserMessage(text: string): Promise<void> {
    if (!this._activeGoalId) return;
    const binding = this.bindings.get(this._activeGoalId);
    if (!binding) return;

    const goalId = this._activeGoalId;

    // Check: is this a response to a pending ask_user?
    const pending = binding.snapshot.askUser;

    // Always add the user message first so it appears in the chat.
    this.applyDeltas(goalId, [{
      kind: 'add-message',
      message: {
        id: this.nextMessageId(),
        goalId,
        role: 'user',
        content: text,
        timestamp: new Date().toISOString(),
      },
      notifyNow: true,
    }]);

    if (pending) {
      // Resolve the Promise from the ask_user tool and clear the pending state.
      pending.resolve(text);
      this.applyDeltas(goalId, [{ kind: 'clear-ask-user' }]);
      return;
    }

    if (binding.session) {
      binding.session.session.prompt(text).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.applyDeltas(goalId, [{
          kind: 'add-message',
          message: this.makeCoordMsg(goalId, `⚠️ Error: ${msg}`),
          notifyNow: true,
        }]);
      });
    }
  }

  dispose(): void {
    this.notifier.dispose();
    for (const b of this.bindings.values()) {
      b.unsubPi?.();
      b.unsubBus?.();
    }
    this.bindings.clear();
  }

  // ─── Event wiring ────────────────────────────────────────────

  private wireSessionEvents(goalId: string, session: OrchestratorSession): void {
    const binding = this.bindings.get(goalId);
    if (!binding) return;
    binding.unsubPi = session.session.subscribe((event: AgentSessionEvent) => {
      this.handlePiEvent(goalId, event);
    });
  }

  private wireBusEvents(goalId: string, bus: OrchestratorEventBus): void {
    const binding = this.bindings.get(goalId);
    if (!binding) return;
    binding.unsubBus = bus.onEvent((event: OrchestratorEvent) => {
      this.handleBusEvent(goalId, event);
    });
  }

  private handlePiEvent(goalId: string, event: AgentSessionEvent): void {
    const binding = this.bindings.get(goalId);
    if (!binding) return;
    const deltas = translatePiEvent(
      binding.snapshot,
      event,
      this.translatorContext(goalId),
    );
    if (deltas.length > 0) this.applyDeltas(goalId, deltas);
  }

  private handleBusEvent(goalId: string, event: OrchestratorEvent): void {
    const binding = this.bindings.get(goalId);
    if (!binding) return;
    const deltas = translateBusEvent(
      binding.snapshot,
      event,
      this.translatorContext(goalId),
    );
    if (deltas.length > 0) this.applyDeltas(goalId, deltas);
  }

  // ─── Delta application ───────────────────────────────────────
  // Applies a batch of deltas atomically to one goal's snapshot.
  // Collects DB-refresh requests and runs them once at the end to
  // avoid redundant queries when multiple deltas touch the same table.

  private applyDeltas(goalId: string, deltas: ReadonlyArray<Delta>): void {
    const binding = this.bindings.get(goalId);
    if (!binding) return;

    let snap = binding.snapshot;
    let needsAgentRefresh = false;
    let needsPlanRefresh = false;
    let notifyNow = false;

    for (const d of deltas) {
      switch (d.kind) {
        case 'add-message':
          snap = withMessageAppended(snap, d.message);
          this.persistMessage(binding, d.message);
          if (d.notifyNow) notifyNow = true;
          break;

        case 'replace-thinking':
          snap = withThinkingReplaced(snap, d.content, d.makeMessage);
          break;

        case 'remove-thinking':
          snap = withThinkingRemoved(snap);
          break;

        case 'set-goal-status':
          snap = withGoal(snap, { status: d.status });
          if (d.notifyNow) notifyNow = true;
          break;

        case 'refresh-agents':
          needsAgentRefresh = true;
          break;

        case 'refresh-plan':
          needsPlanRefresh = true;
          break;

        case 'set-ask-user':
          snap = withAskUser(snap, d.pending);
          break;

        case 'clear-ask-user':
          snap = withAskUser(snap, null);
          break;
      }
    }

    if (needsAgentRefresh) snap = this.refreshAgents(binding, snap);
    if (needsPlanRefresh) snap = this.refreshPlan(binding, snap);

    binding.snapshot = snap;

    if (notifyNow) this.notifier.flush();
    else this.notifier.schedule();
  }

  // ─── DB interactions ─────────────────────────────────────────

  private persistMessage(binding: GoalBinding, message: ChatMessage): void {
    if (binding.session) {
      binding.session.db.appendMessage(binding.session.runId, message.role, message.content);
    }
  }

  private refreshAgents(binding: GoalBinding, snap: GoalSnapshot): GoalSnapshot {
    if (!binding.session) return snap;
    const dbAgents = binding.session.db.getAgentRunsForGoal(binding.session.runId);
    const agents = dbAgents.map(a => dbAgentToAgentRun(a, snap.goal.id));
    return withAgents(snap, agents);
  }

  private refreshPlan(binding: GoalBinding, snap: GoalSnapshot): GoalSnapshot {
    if (!binding.session) return snap;
    const dbPlan = binding.session.db.getPlan(binding.session.runId);
    if (!dbPlan) return withPlan(snap, null);
    try {
      const parsed = JSON.parse(dbPlan.steps) as { steps?: PlanStep[] };
      return withPlan(snap, {
        id: dbPlan.id,
        goalId: snap.goal.id,
        steps: parsed.steps ?? [],
        version: dbPlan.version,
      });
    } catch {
      return withPlan(snap, null);
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────

  private translatorContext(goalId: string): TranslatorContext {
    return {
      goalId,
      now: () => new Date().toISOString(),
      nextMessageId: () => this.nextMessageId(),
    };
  }

  /**
   * Monotonic ID generator. Using a counter instead of Date.now+random
   * guarantees uniqueness even if two messages are created in the same
   * millisecond (which happens often under throttled event bursts).
   */
  private nextMessageId(): string {
    this.messageCounter += 1;
    return `msg-${this.messageCounter.toString(36)}-${Date.now().toString(36)}`;
  }

  private makeCoordMsg(goalId: string, content: string): ChatMessage {
    return {
      id: this.nextMessageId(),
      goalId,
      role: 'coordinator',
      content,
      timestamp: new Date().toISOString(),
    };
  }
}

// ─── Stable empty references for goals we don't know about ──────
// Returning the *same* empty array across calls means React sees
// reference-equal props and can skip rendering.

const EMPTY_MESSAGES: ReadonlyArray<ChatMessage> = Object.freeze([]);
const EMPTY_AGENTS: ReadonlyArray<AgentRun> = Object.freeze([]);

// ─── DB → TUI conversion (plain function, exported for tests) ───

export function dbAgentToAgentRun(a: DbAgentRun, goalId: string): AgentRun {
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
