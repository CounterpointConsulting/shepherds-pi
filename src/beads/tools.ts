import { Type } from 'typebox';
import { defineTool, type ToolDefinition } from '@mariozechner/pi-coding-agent';
import type { ShepherdsDB } from '../db/index.js';
import type { BeadsConfig } from '../config/index.js';
import { BeadsClient } from './client.js';
import type { BeadsCreateInput, BeadIssueType, BeadRole, NormalizedBead } from './types.js';

interface OrchestratorEventBusLike {
  emit(event: { type: string; [key: string]: unknown }): void;
}

function toolResult(payload: unknown, details: Record<string, unknown> = {}) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
    details,
  };
}

function toolError(message: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: message }, null, 2) }],
    details: { error: true } as Record<string, unknown>,
  };
}

function wrapBead(command: string, bead: NormalizedBead | NormalizedBead[]) {
  return {
    ok: true,
    command,
    normalized: Array.isArray(bead) ? { issues: bead } : { issue: bead },
  };
}

const CreateParams = Type.Object({
  title: Type.String({ description: 'Short task/epic title' }),
  type: Type.Optional(Type.String({
    description: 'Issue type',
    enum: ['epic', 'task', 'bug', 'chore', 'feature'],
  })),
  priority: Type.Optional(Type.Number({ description: 'Priority 0-4 (0=highest)', minimum: 0, maximum: 4 })),
  description: Type.Optional(Type.String({ description: 'Objective / context' })),
  acceptance: Type.Optional(Type.String({ description: 'Success criteria (required for implement tasks)' })),
  labels: Type.Optional(Type.Array(Type.String(), { description: 'Extra labels' })),
  parentId: Type.Optional(Type.String({ description: 'Parent epic or task id' })),
  branch: Type.Optional(Type.String({ description: 'Git branch for this work' })),
  persona: Type.Optional(Type.String({ description: 'Persona name (adds persona:<name> label)' })),
  role: Type.Optional(Type.String({
    description: 'Role (adds role:<name> label)',
    enum: ['implement', 'review', 'test', 'integrate', 'plan'],
  })),
  notes: Type.Optional(Type.String({ description: 'Initial notes' })),
});

const CreateManyParams = Type.Object({
  items: Type.Array(CreateParams, { description: 'Beads to create in order' }),
});

const IdParams = Type.Object({
  id: Type.String({ description: 'Bead id' }),
});

const ClaimParams = Type.Object({
  id: Type.String({ description: 'Bead id to claim' }),
  assignee: Type.Optional(Type.String({ description: 'Assignee (default coordinator)' })),
});

const CloseParams = Type.Object({
  id: Type.String({ description: 'Bead id' }),
  reason: Type.String({ description: 'Close reason (required)' }),
  evidence: Type.Optional(Type.String({ description: 'Evidence summary appended to notes' })),
});

const ReopenParams = Type.Object({
  id: Type.String({ description: 'Bead id' }),
  reason: Type.Optional(Type.String({ description: 'Why reopening' })),
});

const UpdateParams = Type.Object({
  id: Type.String({ description: 'Bead id' }),
  title: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  acceptance: Type.Optional(Type.String()),
  notes: Type.Optional(Type.String({ description: 'Replace notes entirely' })),
  notesAppend: Type.Optional(Type.String({ description: 'Append a timestamped note line' })),
  addLabels: Type.Optional(Type.Array(Type.String())),
  removeLabels: Type.Optional(Type.Array(Type.String())),
  priority: Type.Optional(Type.Number({ minimum: 0, maximum: 4 })),
  status: Type.Optional(Type.String()),
});

const DepParams = Type.Object({
  from: Type.String({ description: 'Blocker id (for blocks: from blocks to)' }),
  to: Type.String({ description: 'Blocked id' }),
  type: Type.Optional(Type.String({
    description: 'Dependency type',
    enum: ['blocks', 'parent-child', 'relates_to'],
  })),
  action: Type.Optional(Type.String({
    description: 'add or remove',
    enum: ['add', 'remove'],
  })),
});

const ReadyParams = Type.Object({
  label: Type.Optional(Type.String({ description: 'Filter label (AND), e.g. role:implement' })),
  limit: Type.Optional(Type.Number({ description: 'Max issues', minimum: 1, maximum: 100 })),
  parent: Type.Optional(Type.String({ description: 'Filter to descendants of epic/task' })),
});

const ListParams = Type.Object({
  label: Type.Optional(Type.String()),
  status: Type.Optional(Type.String()),
  parent: Type.Optional(Type.String()),
  type: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: 200 })),
  all: Type.Optional(Type.Boolean({ description: 'Include closed issues' })),
});

const RememberParams = Type.Object({
  insight: Type.String({
    description:
      'Durable project insight. Stored as a labeled chore bead (bd remember is unavailable on older bd versions).',
  }),
});

function toCreateInput(params: {
  title: string;
  type?: string;
  priority?: number;
  description?: string;
  acceptance?: string;
  labels?: string[];
  parentId?: string;
  branch?: string;
  persona?: string;
  role?: string;
  notes?: string;
}): BeadsCreateInput {
  return {
    title: params.title,
    type: (params.type as BeadIssueType | undefined) ?? 'task',
    priority: params.priority,
    description: params.description,
    acceptance: params.acceptance,
    labels: params.labels,
    parentId: params.parentId,
    branch: params.branch,
    persona: params.persona,
    role: params.role as BeadRole | undefined,
    notes: params.notes,
  };
}

export function createBeadsTools(deps: {
  client: BeadsClient;
  config: BeadsConfig;
  db?: ShepherdsDB;
  getRunId?: () => string;
  eventBus?: OrchestratorEventBusLike;
}): ToolDefinition[] {
  const { client, config, db, getRunId, eventBus } = deps;

  const log = (eventType: string, payload: Record<string, unknown>, summary: string) => {
    const runId = getRunId?.();
    if (db && runId) db.appendLog(runId, eventType, payload, summary);
    eventBus?.emit({ type: eventType, ...payload });
  };

  const beadsPrime = defineTool({
    name: 'beads_prime',
    label: 'Beads Prime',
    description: 'Load Beads workflow context and project state for the coordinator after context compaction.',
    parameters: Type.Object({}),
    promptSnippet: 'Load Beads work-graph context',
    async execute() {
      try {
        const text = await client.prime(true);
        return toolResult({ ok: true, command: 'prime', text }, { command: 'prime' });
      } catch (err: unknown) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  });

  const beadsReady = defineTool({
    name: 'beads_ready',
    label: 'Beads Ready',
    description: 'List ready work (open/in_progress issues with no open blockers). Preferred dispatch source.',
    parameters: ReadyParams,
    promptSnippet: 'List unblocked ready beads',
    async execute(_id, params) {
      try {
        const issues = await client.ready({
          label: params.label,
          limit: params.limit,
          parent: params.parent,
        });
        return toolResult(wrapBead('ready', issues), { count: issues.length });
      } catch (err: unknown) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  });

  const beadsList = defineTool({
    name: 'beads_list',
    label: 'Beads List',
    description: 'List beads filtered by parent/label/status/type.',
    parameters: ListParams,
    promptSnippet: 'List beads by filter',
    async execute(_id, params) {
      try {
        const issues = await client.list({
          label: params.label,
          status: params.status,
          parent: params.parent,
          type: params.type,
          limit: params.limit,
          all: params.all,
        });
        return toolResult(wrapBead('list', issues), { count: issues.length });
      } catch (err: unknown) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  });

  const beadsShow = defineTool({
    name: 'beads_show',
    label: 'Beads Show',
    description: 'Show one bead including acceptance, notes, labels, and dependency edges.',
    parameters: IdParams,
    promptSnippet: 'Show bead details',
    async execute(_id, params) {
      try {
        const issue = await client.show(params.id);
        return toolResult(wrapBead('show', issue), { id: issue.id });
      } catch (err: unknown) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  });

  const beadsCreate = defineTool({
    name: 'beads_create',
    label: 'Beads Create',
    description:
      'Create a bead (epic or task). For implement tasks always set acceptance criteria. Use role/persona labels for routing.',
    parameters: CreateParams,
    promptSnippet: 'Create a plan epic or task bead',
    async execute(_id, params) {
      try {
        if (params.role === 'implement' && !params.acceptance?.trim()) {
          return toolError('Implement beads require acceptance (success criteria).');
        }
        const issue = await client.create(toCreateInput(params));
        log('bead_created', { id: issue.id, title: issue.title, type: issue.type }, `Bead created: ${issue.id} — ${issue.title}`);
        return toolResult(wrapBead('create', issue), { id: issue.id });
      } catch (err: unknown) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  });

  const beadsCreateMany = defineTool({
    name: 'beads_create_many',
    label: 'Beads Create Many',
    description: 'Create multiple beads in order (for plan materialization after architect).',
    parameters: CreateManyParams,
    promptSnippet: 'Batch-create task beads from a plan',
    async execute(_id, params) {
      try {
        for (const item of params.items) {
          if (item.role === 'implement' && !item.acceptance?.trim()) {
            return toolError(`Implement bead "${item.title}" requires acceptance.`);
          }
        }
        const issues = await client.createMany(params.items.map(toCreateInput));
        for (const issue of issues) {
          log('bead_created', { id: issue.id, title: issue.title, type: issue.type }, `Bead created: ${issue.id} — ${issue.title}`);
        }
        return toolResult(wrapBead('create_many', issues), { count: issues.length });
      } catch (err: unknown) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  });

  const beadsUpdate = defineTool({
    name: 'beads_update',
    label: 'Beads Update',
    description: 'Update bead fields (title, description, acceptance, notes, labels, priority, status).',
    parameters: UpdateParams,
    promptSnippet: 'Update a bead',
    async execute(_id, params) {
      try {
        const issue = await client.update({
          id: params.id,
          title: params.title,
          description: params.description,
          acceptance: params.acceptance,
          notes: params.notes,
          notesAppend: params.notesAppend,
          addLabels: params.addLabels,
          removeLabels: params.removeLabels,
          priority: params.priority,
          status: params.status,
        });
        log('bead_updated', { id: issue.id }, `Bead updated: ${issue.id}`);
        return toolResult(wrapBead('update', issue), { id: issue.id });
      } catch (err: unknown) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  });

  const beadsClaim = defineTool({
    name: 'beads_claim',
    label: 'Beads Claim',
    description: 'Atomically claim a bead (sets in_progress). Prefer claiming before spawn_agent; spawn also auto-claims when beadId is set.',
    parameters: ClaimParams,
    promptSnippet: 'Claim a ready bead before dispatch',
    async execute(_id, params) {
      try {
        const issue = await client.claim(params.id, params.assignee ?? 'shepherds-coordinator');
        log('bead_claimed', { id: issue.id }, `Bead claimed: ${issue.id}`);
        return toolResult(wrapBead('claim', issue), { id: issue.id });
      } catch (err: unknown) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  });

  const beadsClose = defineTool({
    name: 'beads_close',
    label: 'Beads Close',
    description:
      'Close a bead with a reason. Pipeline policy: close implement when delivered + host-git finalize OK; close review/test only with verification evidence; integrate closes only after gates pass.',
    parameters: CloseParams,
    promptSnippet: 'Close a completed bead with evidence',
    async execute(_id, params) {
      try {
        if (!params.reason.trim()) return toolError('Close reason is required.');
        const issue = await client.close(params.id, params.reason, params.evidence);
        log('bead_closed', { id: issue.id, reason: params.reason }, `Bead closed: ${issue.id} — ${params.reason}`);
        return toolResult(wrapBead('close', issue), { id: issue.id });
      } catch (err: unknown) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  });

  const beadsReopen = defineTool({
    name: 'beads_reopen',
    label: 'Beads Reopen',
    description: 'Reopen a closed bead for rework (e.g. after failed review/test of related work).',
    parameters: ReopenParams,
    promptSnippet: 'Reopen a bead for rework',
    async execute(_id, params) {
      try {
        const issue = await client.reopen(params.id, params.reason);
        log('bead_reopened', { id: issue.id, reason: params.reason }, `Bead reopened: ${issue.id}`);
        return toolResult(wrapBead('reopen', issue), { id: issue.id });
      } catch (err: unknown) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  });

  const beadsDep = defineTool({
    name: 'beads_dep',
    label: 'Beads Dependency',
    description:
      'Add or remove a dependency. For blocking: from blocks to (to is not ready until from is closed). Typical gates: implement blocks review/test; review+test block integrate.',
    parameters: DepParams,
    promptSnippet: 'Link beads with blockers',
    async execute(_id, params) {
      try {
        const data = await client.dep(params.from, params.to, {
          type: (params.type as 'blocks' | 'parent-child' | 'relates_to' | undefined) ?? 'blocks',
          action: (params.action as 'add' | 'remove' | undefined) ?? 'add',
        });
        log(
          'bead_dep',
          { from: params.from, to: params.to, type: params.type ?? 'blocks', action: params.action ?? 'add' },
          `Bead dep ${params.action ?? 'add'}: ${params.from} -> ${params.to}`,
        );
        return toolResult({ ok: true, command: 'dep', data }, { from: params.from, to: params.to });
      } catch (err: unknown) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  });

  const beadsRemember = defineTool({
    name: 'beads_remember',
    label: 'Beads Remember',
    description:
      'Store a durable project insight as a labeled chore bead (status open, label memory). Use for conventions that should outlive a single run. Prefer beads for work; use run_log for this-run timeline.',
    parameters: RememberParams,
    promptSnippet: 'Remember a durable project insight',
    async execute(_id, params) {
      try {
        const issue = await client.create({
          title: params.insight.length > 80 ? `${params.insight.slice(0, 77)}...` : params.insight,
          type: 'chore',
          priority: 3,
          description: params.insight,
          labels: ['memory'],
          notes: 'shepherd.memory=1\nshepherd.dispatch_count=0',
        });
        log('bead_memory', { id: issue.id }, `Memory stored: ${issue.id}`);
        return toolResult(wrapBead('remember', issue), { id: issue.id });
      } catch (err: unknown) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  });

  // silence unused config for now (reserved for future remember-backend choice)
  void config;

  return [
    beadsPrime,
    beadsReady,
    beadsList,
    beadsShow,
    beadsCreate,
    beadsCreateMany,
    beadsUpdate,
    beadsClaim,
    beadsClose,
    beadsReopen,
    beadsDep,
    beadsRemember,
  ];
}

/**
 * Validate a bead before spawn. Throws a string message on rejection.
 * Returns the bead (after optional claim + dispatch increment is done by caller).
 */
export async function prepareBeadForSpawn(
  client: BeadsClient,
  config: BeadsConfig,
  beadId: string,
  agentId: string,
): Promise<NormalizedBead> {
  const bead = await client.show(beadId);

  if (bead.status === 'closed') {
    throw new Error(`Bead ${beadId} is closed; reopen it before spawning.`);
  }

  if (bead.labels.includes('blocked-user')) {
    throw new Error(`Bead ${beadId} is labeled blocked-user; resolve with ask_user first.`);
  }

  const isImplement = bead.labels.includes('role:implement');
  if (isImplement && bead.dispatchCount >= config.stuckDispatchLimit) {
    throw new Error(
      `Bead ${beadId} hit stuck dispatch limit (${bead.dispatchCount}/${config.stuckDispatchLimit}). ` +
      'Stop retrying, label blocked-user, and ask_user for guidance.',
    );
  }

  // Auto-claim when not already in progress
  if (bead.status !== 'in_progress') {
    try {
      await client.claim(beadId, 'shepherds-coordinator');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      // If claim races, continue when show says in_progress
      const again = await client.show(beadId);
      if (again.status !== 'in_progress') {
        throw new Error(`Failed to claim bead ${beadId}: ${message}`);
      }
    }
  }

  return client.incrementDispatchCount(beadId, agentId);
}
