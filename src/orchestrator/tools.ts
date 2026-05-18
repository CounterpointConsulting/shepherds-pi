import { Type } from 'typebox';
import { defineTool, type ToolDefinition } from '@mariozechner/pi-coding-agent';
import type { OrchestratorEventBus } from './event-bus.js';
import type { ShepherdsDB } from '../db/index.js';
import type { ShepherdsPiConfig } from '../config/index.js';
import { getGitToken } from '../config/index.js';
import { loadPersona } from '../persona/index.js';
import { spawnAgent } from '../agent/spawner.js';
import { WorktreeManager, type WorktreeLease } from '../git/worktree-manager.js';
import { finalizeAgentChanges } from '../git/host-git-manager.js';
import simpleGit from 'simple-git';
import crypto from 'node:crypto';

// ─── Tool factory ────────────────────────────────────────────────

export function createOrchestratorTools(deps: {
  eventBus: OrchestratorEventBus;
  db: ShepherdsDB;
  config: ShepherdsPiConfig;
  getRunId: () => string;
}): ToolDefinition[] {
  const { eventBus, db, config, getRunId } = deps;

  const worktreeManager = config.git.repoMode === 'worktree'
    ? new WorktreeManager({
      repoPath: config.project.repoPath,
      worktreesDir: config.git.worktreesDir,
      resetBeforeRun: config.git.resetWorktreeBeforeRun,
      acquireStepTimeoutMs: 90_000,
    })
    : null;

  return [
    createSpawnAgentTool(eventBus, db, config, getRunId, worktreeManager),
    createSpawnAgentsTool(eventBus, db, config, getRunId, worktreeManager),
    createBranchTool(eventBus, config),
    listBranchesTool(config),
    getBranchDiffTool(config),
    readPlanTool(db, getRunId),
    updatePlanTool(eventBus, db, getRunId),
    readRunLogTool(db, getRunId),
    askUserTool(eventBus),
    updateGoalStatusTool(eventBus, db, getRunId),
  ];
}

// ─── Parameter schemas ───────────────────────────────────────────

const SpawnAgentParams = Type.Object({
  persona: Type.String({ description: 'Persona name (e.g., "dba", "code-reviewer")' }),
  instructions: Type.String({ description: 'Task instructions for the agent' }),
  branch: Type.Optional(Type.String({ description: 'Git branch for the agent to work on' })),
  context: Type.Optional(Type.String({ description: 'Additional context for the agent' })),
});

const SpawnAgentsParams = Type.Object({
  agents: Type.Array(Type.Object({
    persona: Type.String({ description: 'Persona name' }),
    instructions: Type.String({ description: 'Task instructions' }),
    branch: Type.Optional(Type.String({ description: 'Git branch' })),
    context: Type.Optional(Type.String({ description: 'Additional context' })),
  })),
});

const CreateBranchParams = Type.Object({
  name: Type.String({ description: 'Branch name (e.g., "feat/user-auth")' }),
  base: Type.Optional(Type.String({ description: 'Base branch', default: 'dev' })),
});

const GetBranchDiffParams = Type.Object({
  branch: Type.String({ description: 'Feature branch' }),
  base: Type.Optional(Type.String({ description: 'Base branch', default: 'dev' })),
});

const UpdatePlanParams = Type.Object({
  plan: Type.String({ description: 'Plan as JSON string' }),
});

const ReadRunLogParams = Type.Object({
  filter: Type.Optional(Type.String({ description: "Filter: 'all', 'agents', 'branches', 'plan', 'latest'" })),
  since: Type.Optional(Type.String({ description: 'ISO timestamp — only events after this time' })),
});

const AskUserParams = Type.Object({
  question: Type.String({ description: 'Question to ask the user' }),
});

const UpdateGoalStatusParams = Type.Object({
  status: Type.String({
    description: 'New status',
    enum: ['planning', 'executing', 'reviewing', 'testing', 'merging', 'completed', 'failed', 'blocked'],
  }),
  message: Type.Optional(Type.String({ description: 'Optional status message' })),
});

// ─── spawn_agent ─────────────────────────────────────────────────

function assertGitModeCompatibility(config: ShepherdsPiConfig): void {
  if (config.git.gitOpsMode === 'host' && config.git.repoMode !== 'worktree') {
    throw new Error('git.git_ops_mode=host requires git.repo_mode=worktree');
  }
}

function normalizeRemoteUrl(url: string): string {
  if (!url) return '';
  if (url.startsWith('git@')) {
    return url.replace('git@github.com:', 'https://github.com/').replace(/\.git$/, '');
  }
  return url;
}

async function resolveGitUrl(config: ShepherdsPiConfig): Promise<string> {
  let gitUrl = process.env.GIT_URL ?? '';
  if (gitUrl) return normalizeRemoteUrl(gitUrl);

  try {
    const git = simpleGit(config.project.repoPath);
    gitUrl = (await git.getRemotes(true)).find(r => r.name === 'origin')?.refs?.fetch ?? '';
    return normalizeRemoteUrl(gitUrl);
  } catch {
    return '';
  }
}

async function resolveGitToken(config: ShepherdsPiConfig): Promise<string> {
  const needsToken = config.git.repoMode === 'clone' || config.git.gitOpsMode === 'container';
  if (!needsToken) return '';
  return getGitToken(config.agent.gitTokenEnv);
}

async function acquireWorktreeLease(
  worktreeManager: WorktreeManager | null,
  config: ShepherdsPiConfig,
  branch: string,
  agentId: string,
): Promise<WorktreeLease | null> {
  if (config.git.repoMode !== 'worktree') return null;
  if (!worktreeManager) throw new Error('Worktree mode enabled, but no worktree manager is configured.');
  return worktreeManager.acquire({
    branch,
    baseBranch: config.project.devBranch,
    agentId,
  });
}

type HostGitFinalizeOutcome = Awaited<ReturnType<typeof finalizeAgentChanges>>;
type SpawnLogMode = 'single' | 'parallel';

interface ExecuteAgentSpec {
  eventBus: OrchestratorEventBus;
  db: ShepherdsDB;
  config: ShepherdsPiConfig;
  worktreeManager: WorktreeManager | null;
  runId: string;
  personaName: string;
  instructions: string;
  context?: string;
  branch?: string;
  logMode: SpawnLogMode;
}

type ExecuteAgentResult =
  | {
    ok: true;
    agentId: string;
    spawnResult: Awaited<ReturnType<typeof spawnAgent>>;
    status: 'done' | 'failed';
    hostGit: HostGitFinalizeOutcome | null;
  }
  | {
    ok: false;
    agentId?: string;
    error: string;
  };

async function executeAgentRun(spec: ExecuteAgentSpec): Promise<ExecuteAgentResult> {
  const {
    eventBus,
    db,
    config,
    worktreeManager,
    runId,
    personaName,
    instructions,
    context,
    branch,
    logMode,
  } = spec;

  assertGitModeCompatibility(config);

  const persona = loadPersona(personaName, `${config.personasDir}/${personaName}`);
  if (!persona) {
    return {
      ok: false,
      error: `Persona "${personaName}" not found`,
    };
  }

  const agentId = `${personaName}-${crypto.randomUUID().substring(0, 8)}`;
  const branchName = branch ?? config.project.devBranch;
  let lease: WorktreeLease | null = null;

  db.createAgentRun({
    id: agentId,
    run_id: runId,
    step_id: null,
    persona: persona.name,
    model: persona.model,
    instructions,
    context: context ?? null,
    branch: branchName,
    container_id: null,
    status: 'spawning',
    result: null,
    started_at: new Date().toISOString(),
    completed_at: null,
  });

  const spawnSummary = logMode === 'parallel'
    ? `Agent spawned (parallel): ${agentId} on ${branchName}`
    : `Agent spawned: ${agentId} (${persona.name}) on ${branchName}`;

  db.appendLog(runId, 'agent_spawned', { agentId, persona: persona.name, branch: branchName }, spawnSummary);
  eventBus.emit({ type: 'agent_spawned', agentId, persona: persona.name, branch: branchName });

  try {
    if (config.git.repoMode === 'worktree') {
      db.appendLog(
        runId,
        'agent_worktree_acquiring',
        { agentId, branch: branchName },
        `Acquiring worktree for ${agentId} on ${branchName}`,
      );
      eventBus.emit({
        type: 'agent_event',
        agentId,
        event: { type: 'worktree_acquiring', branch: branchName },
      });
    }

    lease = await acquireWorktreeLease(worktreeManager, config, branchName, agentId);
    if (lease) {
      db.appendLog(
        runId,
        'agent_worktree_acquired',
        { agentId, leaseId: lease.leaseId, branch: lease.branch, worktreePath: lease.worktreePath },
        `Worktree acquired for ${agentId} on ${lease.branch}`,
      );
      eventBus.emit({
        type: 'agent_event',
        agentId,
        event: { type: 'worktree_acquired', branch: lease.branch, worktreePath: lease.worktreePath },
      });
    }

    const gitUrl = config.git.repoMode === 'clone' ? await resolveGitUrl(config) : undefined;
    if (config.git.repoMode === 'clone' && !gitUrl) {
      throw new Error('Could not determine git URL for clone mode. Set GIT_URL or configure origin remote.');
    }

    const gitToken = await resolveGitToken(config);

    db.updateAgentStatus(agentId, 'running');

    const spawnResult = await spawnAgent({
      agentId,
      persona,
      instructions,
      context,
      branch: branchName,
      repoMode: config.git.repoMode,
      gitOpsMode: config.git.gitOpsMode,
      worktreePath: lease?.worktreePath,
      gitUrl,
      gitToken,
      config,
      onEvent: (event) => {
        if (event.type === 'container_started' && typeof event.containerName === 'string') {
          db.updateAgentContainer(agentId, event.containerName);
          eventBus.emit({
            type: 'agent_event',
            agentId,
            event: {
              ...event,
              persona: persona.name,
              branch: branchName,
            },
          });
          return;
        }

        eventBus.emit({ type: 'agent_event', agentId, event });
      },
    });

    let status: 'done' | 'failed' = spawnResult.exitCode === 0 ? 'done' : 'failed';
    let failReason = spawnResult.timedOut
      ? `Timed out after ${config.agent.timeoutMinutes} minutes`
      : `Exit code ${spawnResult.exitCode}`;

    let hostGit: HostGitFinalizeOutcome | null = null;

    if (status === 'done' && config.git.gitOpsMode === 'host') {
      if (!lease) {
        status = 'failed';
        failReason = 'Host git finalization requested, but no worktree lease was acquired.';
      } else {
        try {
          hostGit = await finalizeAgentChanges({
            worktreePath: lease.worktreePath,
            branch: branchName,
            persona: persona.name,
            agentId,
            result: spawnResult.result,
            authorName: config.git.authorName,
            authorEmail: config.git.authorEmail,
          });

          db.appendLog(
            runId,
            'agent_host_git_finalized',
            { agentId, ...hostGit },
            hostGit.changed
              ? `Host git finalized for ${agentId} (${hostGit.commitSha?.slice(0, 8) ?? 'no sha'})`
              : `Host git found no file changes for ${agentId}`,
          );

          eventBus.emit({
            type: 'agent_event',
            agentId,
            event: { type: 'host_git_finalized', ...hostGit },
          });
        } catch (err: unknown) {
          status = 'failed';
          const message = err instanceof Error ? err.message : String(err);
          failReason = `Host git finalize failed: ${message}`;
          eventBus.emit({
            type: 'agent_event',
            agentId,
            event: { type: 'host_git_failed', error: message },
          });
        }
      }
    }

    db.updateAgentStatus(agentId, status, spawnResult.result ? JSON.stringify(spawnResult.result) : undefined);

    if (status === 'done') {
      const completedSummary = logMode === 'parallel'
        ? `Agent completed: ${agentId}`
        : `Agent completed: ${agentId} — ${spawnResult.result?.summary ?? 'no summary'}`;

      db.appendLog(runId, 'agent_completed', { agentId }, completedSummary);
      eventBus.emit({ type: 'agent_completed', agentId, result: spawnResult.result });
    } else {
      db.appendLog(runId, 'agent_failed', { agentId, exitCode: spawnResult.exitCode, timedOut: spawnResult.timedOut }, `Agent failed: ${agentId} — ${failReason}`);
      eventBus.emit({ type: 'agent_failed', agentId, error: failReason });
    }

    return {
      ok: true,
      agentId,
      spawnResult,
      status,
      hostGit,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    db.updateAgentStatus(agentId, 'failed');
    db.appendLog(runId, 'agent_failed', { agentId, error: message }, `Agent failed: ${agentId} — ${message}`);
    eventBus.emit({ type: 'agent_failed', agentId, error: message });

    return {
      ok: false,
      agentId,
      error: message,
    };
  } finally {
    if (lease) {
      worktreeManager?.release(lease.leaseId);
      db.appendLog(
        runId,
        'agent_worktree_released',
        { agentId, leaseId: lease.leaseId, branch: lease.branch },
        `Worktree released for ${agentId} on ${lease.branch}`,
      );
    }
  }
}

function createSpawnAgentTool(
  eventBus: OrchestratorEventBus,
  db: ShepherdsDB,
  config: ShepherdsPiConfig,
  getRunId: () => string,
  worktreeManager: WorktreeManager | null,
): ToolDefinition<typeof SpawnAgentParams> {
  return defineTool({
    name: 'spawn_agent',
    label: 'Spawn Agent',
    description:
      'Spawn a single agent container with a specific persona and instructions. ' +
      'Blocks until the agent completes and returns its structured result.',
    parameters: SpawnAgentParams,
    promptSnippet: 'Spawn an agent to implement, review, or test code',
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { persona: personaName, instructions, branch, context } = params;
      const runId = getRunId();

      const outcome = await executeAgentRun({
        eventBus,
        db,
        config,
        worktreeManager,
        runId,
        personaName,
        instructions,
        context,
        branch,
        logMode: 'single',
      });

      if (!outcome.ok) {
        return {
          content: [{ type: 'text' as const, text: `Error spawning agent: ${outcome.error}` }],
          details: { error: true } as unknown as Record<string, unknown>,
        };
      }

      const { agentId, spawnResult, status, hostGit } = outcome;
      const resultText = spawnResult.result
        ? JSON.stringify(spawnResult.result, null, 2)
        : `Agent ${spawnResult.timedOut ? 'timed out' : `exited with code ${spawnResult.exitCode}`}. No structured result was produced.`;

      return {
        content: [{ type: 'text' as const, text: resultText }],
        details: {
          agentId,
          exitCode: spawnResult.exitCode,
          status,
          timedOut: spawnResult.timedOut,
          hostGit,
        } as Record<string, unknown>,
      };
    },
  });
}

// ─── spawn_agents (parallel) ─────────────────────────────────────

function createSpawnAgentsTool(
  eventBus: OrchestratorEventBus,
  db: ShepherdsDB,
  config: ShepherdsPiConfig,
  getRunId: () => string,
  worktreeManager: WorktreeManager | null,
): ToolDefinition<typeof SpawnAgentsParams> {
  return defineTool({
    name: 'spawn_agents',
    label: 'Spawn Agents in Parallel',
    description:
      'Spawn multiple independent agents in parallel. Use when steps have ' +
      'no dependencies. Blocks until ALL agents complete.',
    parameters: SpawnAgentsParams,
    promptSnippet: 'Spawn multiple agents in parallel for independent tasks',
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { agents } = params;
      const runId = getRunId();

      const results = await Promise.allSettled(
        agents.map(async (agentSpec, index) => {
          const outcome = await executeAgentRun({
            eventBus,
            db,
            config,
            worktreeManager,
            runId,
            personaName: agentSpec.persona,
            instructions: agentSpec.instructions,
            context: agentSpec.context,
            branch: agentSpec.branch,
            logMode: 'parallel',
          });

          if (!outcome.ok) {
            return { index, agentId: outcome.agentId, error: outcome.error };
          }

          return {
            index,
            agentId: outcome.agentId,
            result: outcome.spawnResult.result,
            exitCode: outcome.spawnResult.exitCode,
            timedOut: outcome.spawnResult.timedOut,
            status: outcome.status,
            hostGit: outcome.hostGit,
          };
        })
      );

      const output = results.map((r, i) => {
        if (r.status === 'fulfilled') {
          const val = r.value as { agentId?: string; result?: unknown; exitCode?: number; error?: string };
          if (val.error) return `Agent ${i}: ERROR — ${val.error}`;
          return `Agent ${i} (${val.agentId}): ${JSON.stringify(val.result, null, 2)}`;
        }
        return `Agent ${i}: FAILED — ${r.reason}`;
      }).join('\n\n');

      return {
        content: [{ type: 'text' as const, text: output }],
        details: { parallelCount: agents.length } as Record<string, unknown>,
      };
    },
  });
}

// ─── create_branch ───────────────────────────────────────────────

function createBranchTool(eventBus: OrchestratorEventBus, config: ShepherdsPiConfig): ToolDefinition<typeof CreateBranchParams> {
  return defineTool({
    name: 'create_branch',
    label: 'Create Git Branch',
    description: 'Create a new git branch from a base branch and push it to the remote.',
    parameters: CreateBranchParams,
    promptSnippet: 'Create a feature branch for an agent to work in',
    async execute(_toolCallId, params) {
      const { name, base } = params;
      const baseBranch = base ?? config.project.devBranch;

      try {
        const git = simpleGit(config.project.repoPath);
        await git.fetch('origin');

        let localBranchExists = true;
        try {
          const out = await git.raw(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]);
          localBranchExists = out.trim().length > 0;
        } catch {
          localBranchExists = false;
        }

        if (!localBranchExists) {
          await git.raw(['branch', name, `origin/${baseBranch}`]);
        }

        await git.push('origin', `${name}:${name}`, ['--set-upstream']);
        eventBus.emit({ type: 'branch_created', name, base: baseBranch });

        return {
          content: [{ type: 'text' as const, text: `Branch "${name}" created from "${baseBranch}" and pushed to origin.` }],
          details: { name, base: baseBranch } as Record<string, unknown>,
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: `Error creating branch: ${message}` }],
          details: { error: true } as unknown as Record<string, unknown>,
        };
      }
    },
  });
}

// ─── list_branches ───────────────────────────────────────────────

function listBranchesTool(config: ShepherdsPiConfig): ToolDefinition {
  return defineTool({
    name: 'list_branches',
    label: 'List Git Branches',
    description: 'List all local and remote git branches.',
    parameters: Type.Object({}),
    async execute() {
      try {
        const git = simpleGit(config.project.repoPath);
        const branches = await git.branch([]);
        const lines = branches.all.map(b => `${b}${b === branches.current ? ' *' : ''}`);
        return {
          content: [{ type: 'text' as const, text: lines.join('\n') || 'No branches found' }],
          details: { branches: branches.all } as Record<string, unknown>,
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: `Error listing branches: ${message}` }],
          details: { error: true } as unknown as Record<string, unknown>,
        };
      }
    },
  });
}

// ─── get_branch_diff ─────────────────────────────────────────────

function getBranchDiffTool(config: ShepherdsPiConfig): ToolDefinition<typeof GetBranchDiffParams> {
  return defineTool({
    name: 'get_branch_diff',
    label: 'Get Branch Diff',
    description: 'Get the diff of a feature branch against its base branch.',
    parameters: GetBranchDiffParams,
    promptSnippet: 'Inspect changes on a feature branch',
    async execute(_toolCallId, params) {
      const { branch, base } = params;
      const baseBranch = base ?? config.project.devBranch;

      try {
        const git = simpleGit(config.project.repoPath);
        const diff = await git.diff([`origin/${baseBranch}...origin/${branch}`]);
        const summary = await git.diffSummary([`origin/${baseBranch}...origin/${branch}`]);

        const header = `Diff: origin/${baseBranch}...origin/${branch}\n` +
          `Files changed: ${summary.files.length}, Insertions: ${summary.insertions}, Deletions: ${summary.deletions}\n\n`;

        const truncatedDiff = diff.length > 15000
          ? diff.substring(0, 15000) + '\n... (truncated)'
          : diff;

        return {
          content: [{ type: 'text' as const, text: header + truncatedDiff }],
          details: { filesChanged: summary.files.map(f => f.file), insertions: summary.insertions, deletions: summary.deletions } as Record<string, unknown>,
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: `Error getting diff: ${message}` }],
          details: { error: true } as unknown as Record<string, unknown>,
        };
      }
    },
  });
}

// ─── read_plan ───────────────────────────────────────────────────

function readPlanTool(db: ShepherdsDB, getRunId: () => string): ToolDefinition {
  return defineTool({
    name: 'read_plan',
    label: 'Read Current Plan',
    description: 'Read the current implementation plan from the database.',
    parameters: Type.Object({}),
    promptSnippet: 'Read the current plan',
    async execute() {
      const runId = getRunId();
      const plan = db.getPlan(runId);

      if (!plan) {
        return {
          content: [{ type: 'text' as const, text: 'No plan exists yet. Use update_plan to create one.' }],
          details: {} as Record<string, unknown>,
        };
      }

      return {
        content: [{ type: 'text' as const, text: `Plan (v${plan.version}):\n${plan.steps}` }],
        details: { version: plan.version } as Record<string, unknown>,
      };
    },
  });
}

// ─── update_plan ─────────────────────────────────────────────────

function updatePlanTool(eventBus: OrchestratorEventBus, db: ShepherdsDB, getRunId: () => string): ToolDefinition<typeof UpdatePlanParams> {
  return defineTool({
    name: 'update_plan',
    label: 'Update Plan',
    description: 'Create or update the implementation plan.',
    parameters: UpdatePlanParams,
    promptSnippet: 'Create or update the implementation plan',
    async execute(_toolCallId, params) {
      const runId = getRunId();

      let parsed: unknown;
      try { parsed = JSON.parse(params.plan); } catch {
        return {
          content: [{ type: 'text' as const, text: 'Error: plan must be valid JSON.' }],
          details: { error: true } as unknown as Record<string, unknown>,
        };
      }

      const existing = db.getPlan(runId);
      const version = existing ? existing.version + 1 : 1;
      const planId = existing ? existing.id : `plan-${crypto.randomUUID().substring(0, 8)}`;

      db.savePlan(planId, runId, params.plan, version);
      db.appendLog(runId, version === 1 ? 'plan_created' : 'plan_updated', { version }, `Plan ${version === 1 ? 'created' : 'updated'} (v${version})`);

      const steps = (parsed as { steps?: unknown[] })?.steps ?? [];
      eventBus.emit({ type: 'plan_updated', steps });

      return {
        content: [{ type: 'text' as const, text: `Plan saved (v${version}) with ${steps.length} steps.` }],
        details: { version, stepCount: steps.length } as Record<string, unknown>,
      };
    },
  });
}

// ─── read_run_log ────────────────────────────────────────────────

function readRunLogTool(db: ShepherdsDB, getRunId: () => string): ToolDefinition<typeof ReadRunLogParams> {
  return defineTool({
    name: 'read_run_log',
    label: 'Read Run Log',
    description:
      'Read the journal of everything that has happened in this run. ' +
      'Use to understand the full trajectory, especially after context compaction.',
    parameters: ReadRunLogParams,
    promptSnippet: 'Read the run log to review what has happened',
    async execute(_toolCallId, params) {
      const runId = getRunId();
      const entries = db.getRunLog(runId, params.since, params.filter);

      if (entries.length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'No run log entries found.' }],
          details: {} as Record<string, unknown>,
        };
      }

      const lines = entries.map(e => {
        const ts = new Date(e.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
        return `[${ts}] ${e.summary}`;
      });

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
        details: { entryCount: entries.length } as Record<string, unknown>,
      };
    },
  });
}

// ─── ask_user ────────────────────────────────────────────────────

function askUserTool(eventBus: OrchestratorEventBus): ToolDefinition<typeof AskUserParams> {
  return defineTool({
    name: 'ask_user',
    label: 'Ask User',
    description: 'Ask the user a question and wait for their response.',
    parameters: AskUserParams,
    promptSnippet: 'Ask the user for clarification or guidance',
    async execute(_toolCallId, params) {
      const response = await eventBus.askUser(params.question);
      return {
        content: [{ type: 'text' as const, text: response }],
        details: {} as Record<string, unknown>,
      };
    },
  });
}

// ─── update_goal_status ──────────────────────────────────────────

function updateGoalStatusTool(eventBus: OrchestratorEventBus, db: ShepherdsDB, getRunId: () => string): ToolDefinition<typeof UpdateGoalStatusParams> {
  return defineTool({
    name: 'update_goal_status',
    label: 'Update Goal Status',
    description: 'Update the current goal status to signal progress.',
    parameters: UpdateGoalStatusParams,
    async execute(_toolCallId, params) {
      const runId = getRunId();
      db.updateRunStatus(runId, params.status);
      db.appendLog(runId, 'status_changed', { status: params.status, message: params.message }, `Status: ${params.status}`);
      eventBus.emit({ type: 'goal_status_changed', status: params.status, message: params.message });

      return {
        content: [{ type: 'text' as const, text: `Goal status updated to: ${params.status}` }],
        details: {} as Record<string, unknown>,
      };
    },
  });
}
