// ─── Goal / Run types ────────────────────────────────────────────

export type GoalStatus = 'planning' | 'executing' | 'reviewing' | 'testing' | 'merging' | 'completed' | 'failed' | 'blocked';

export interface Goal {
  id: string;
  goal: string;
  status: GoalStatus;
  createdAt: string;
  updatedAt: string;
}

// ─── Plan types ──────────────────────────────────────────────────

export type StepStatus = 'pending' | 'in_progress' | 'complete' | 'failed' | 'blocked';

export interface PlanStep {
  id: string;
  description: string;
  persona: string;
  dependsOn: string[];
  branch?: string;
  status: StepStatus;
  agentRunIds: string[];
}

export interface Plan {
  id: string;
  goalId: string;
  steps: PlanStep[];
  version: number;
}

// ─── Agent types ─────────────────────────────────────────────────

export type AgentStatus = 'spawning' | 'running' | 'done' | 'failed' | 'blocked';

export interface AgentRun {
  id: string;
  goalId: string;
  stepId: string | null;
  persona: string;
  model: string;
  instructions: string;
  context?: string;
  branch?: string;
  containerId?: string;
  status: AgentStatus;
  result?: AgentResult;
  startedAt: string;
  completedAt?: string;
}

export interface AgentResult {
  status: string;
  summary: string;
  approved?: boolean;
  filesModified?: string[];
  filesCreated?: string[];
  commits?: string[];
  issues?: string[];
  suggestions?: string[];
  findings?: Record<string, unknown>[];
  conflictsResolved?: string[];
  conflictsRemaining?: string[];
  testsRun?: number;
  testsPassed?: number;
  testsFailed?: number;
}

// Finding is kept for reference but agent results use Record<string, unknown>[]
// because different personas produce different finding structures.
export interface Finding {
  severity: string;
  file?: string;
  line?: number;
  description: string;
  suggestion?: string;
  remediation?: string;
  stepsToReproduce?: string[];
}

// ─── Chat types ──────────────────────────────────────────────────

export type ChatMessageRole = 'user' | 'coordinator' | 'tool_notification' | 'ask_user';

export interface ChatMessage {
  id: string;
  goalId: string;
  role: ChatMessageRole;
  content: string;
  timestamp: string;
  meta?: {
    toolName?: string;
    agentId?: string;
    persona?: string;
    branch?: string;
  };
}

// ─── Run Log ─────────────────────────────────────────────────────

export type RunLogEventType =
  | 'goal_set'
  | 'plan_created'
  | 'plan_updated'
  | 'branch_created'
  | 'agent_spawned'
  | 'agent_completed'
  | 'agent_failed'
  | 'user_message'
  | 'coordinator_message'
  | 'status_changed';

export interface RunLogEntry {
  id: number;
  goalId: string;
  timestamp: string;
  eventType: RunLogEventType;
  payload: Record<string, unknown>;
  summary: string;
}

// ─── TUI state ───────────────────────────────────────────────────

export type ViewMode = 'default' | 'agentExpanded' | 'plan';
export type FocusZone = 'chat' | 'agents';
