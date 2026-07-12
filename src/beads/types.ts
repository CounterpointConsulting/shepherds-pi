/** Normalized bead shape returned to the coordinator model. */
export interface NormalizedBead {
  id: string;
  title: string;
  status: string;
  priority: number;
  type: string;
  description: string;
  acceptance: string;
  notes: string;
  labels: string[];
  assignee: string | null;
  parent: string | null;
  blockedBy: string[];
  blocks: string[];
  dispatchCount: number;
  closeReason: string | null;
}

export type BeadRole = 'implement' | 'review' | 'test' | 'integrate' | 'plan';
export type BeadIssueType = 'epic' | 'task' | 'bug' | 'chore' | 'feature';

export interface BeadsCreateInput {
  title: string;
  type?: BeadIssueType;
  priority?: number;
  description?: string;
  acceptance?: string;
  labels?: string[];
  parentId?: string;
  branch?: string;
  persona?: string;
  role?: BeadRole;
  notes?: string;
}

export interface BeadsUpdateInput {
  id: string;
  title?: string;
  description?: string;
  acceptance?: string;
  notes?: string;
  notesAppend?: string;
  addLabels?: string[];
  removeLabels?: string[];
  priority?: number;
  status?: string;
  assignee?: string;
}

export interface BeadsClientOptions {
  binary: string;
  cwd: string;
  /** Always pass --repo to create/write to avoid contributor auto-routing. */
  forceLocalRepo: boolean;
  actor: string;
  timeoutMs: number;
}

export interface BeadsRunResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  data: unknown;
  error?: string;
}
