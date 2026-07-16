import { Type } from 'typebox';
import { defineTool, type ToolDefinition } from '@mariozechner/pi-coding-agent';
import type { ShepherdsDB } from '../db/index.js';
import type { ShepherdsPiConfig } from '../config/index.js';
import { getGitToken } from '../config/index.js';
import { loadPersona } from '../persona/index.js';
import { spawnAgent } from '../agent/spawner.js';
import { WorktreeManager, type WorktreeLease } from '../git/worktree-manager.js';
import { finalizeAgentChanges } from '../git/host-git-manager.js';
import { attemptMerge, finalizeMerge, cleanupIntegrationWorktree } from '../git/host-merge-manager.js';
import { BeadsClient } from '../beads/client.js';
import { createBeadsTools, prepareBeadForSpawn } from '../beads/tools.js';
import simpleGit from 'simple-git';
import crypto from 'node:crypto';

// ─── Tool factory ────────────────────────────────────────────────

interface OrchestratorEventBusLike {
  emit(event: { type: string; [key: string]: unknown }): void;
  askUser(question: string): Promise<string>;
}

export function createOrchestratorTools(deps: {
  eventBus?: OrchestratorEventBusLike;
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
      acquireStepTimeoutMs: config.git.acquireStepTimeoutMs,
    })
    : null;

  const beadsClient = config.beads.enabled
    ? new BeadsClient({
      binary: config.beads.binary,
      cwd: config.beads.repoPath || config.project.repoPath,
      actor: config.beads.actor,
      forceLocalRepo: true,
    })
    : null;

  const tools: ToolDefinition[] = [
    createSpawnAgentTool(eventBus, db, config, getRunId, worktreeManager, beadsClient),
    createSpawnAgentsTool(eventBus, db, config, getRunId, worktreeManager, beadsClient),
    createBranchTool(eventBus, config),
    listBranchesTool(config),
    getBranchDiffTool(config),
    mergeBranchTool(eventBus, db, config, getRunId),
  ];

  // Beads mode: work graph is the plan of record — do not dual-write free-form plan JSON.
  if (config.beads.enabled && beadsClient) {
    tools.push(
      ...createBeadsTools({
        client: beadsClient,
        config: config.beads,
        db,
        getRunId,
        eventBus,
      }),
    );
  } else {
    tools.push(readPlanTool(db, getRunId), updatePlanTool(eventBus, db, getRunId));
  }

  tools.push(
    readRunLogTool(db, getRunId),
    askUserTool(eventBus),
    updateGoalStatusTool(eventBus, db, getRunId),
  );

  return tools;
}

// ─── Parameter schemas ───────────────────────────────────────────

const SpawnAgentParams = Type.Object({
  persona: Type.String({ description: 'Persona name (e.g., "dba", "code-reviewer")' }),
  instructions: Type.String({ description: 'Task instructions for the agent' }),
  branch: Type.Optional(Type.String({ description: 'Git branch for the agent to work on' })),
  context: Type.Optional(Type.String({ description: 'Additional context for the agent' })),
  beadId: Type.Optional(Type.String({
    description: 'Beads task id this spawn fulfills (required when beads.enabled and require_bead_on_spawn)',
  })),
  requestedSkills: Type.Optional(Type.Array(Type.String(), {
    description: 'Optional skill names to prioritize (e.g. playwright-skill)',
  })),
});

const SpawnAgentsParams = Type.Object({
  agents: Type.Array(Type.Object({
    persona: Type.String({ description: 'Persona name' }),
    instructions: Type.String({ description: 'Task instructions' }),
    branch: Type.Optional(Type.String({ description: 'Git branch' })),
    context: Type.Optional(Type.String({ description: 'Additional context' })),
    beadId: Type.Optional(Type.String({ description: 'Beads task id this spawn fulfills' })),
    requestedSkills: Type.Optional(Type.Array(Type.String())),
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

const MergeBranchParams = Type.Object({
  source: Type.String({ description: 'Feature branch to merge (e.g. "feat/s1-monorepo-skeleton")' }),
  target: Type.Optional(Type.String({ description: 'Target branch to merge into (default: dev branch)' })),
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

// How long a spawn will wait for a busy branch lease before giving up is
// configurable via git.lease_wait_timeout_seconds / git.lease_wait_poll_seconds.
// Same-branch contention is normal (review/test gates run after the implementer
// on the same branch), so we queue instead of failing immediately.
function isBranchInUseError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /already in use by lease|is locked by lease/i.test(msg);
}

async function acquireWorktreeLease(
  worktreeManager: WorktreeManager | null,
  config: ShepherdsPiConfig,
  branch: string,
  agentId: string,
  onWaiting?: (info: { branch: string; waitedMs: number; error: string }) => void,
): Promise<WorktreeLease | null> {
  if (config.git.repoMode !== 'worktree') return null;
  if (!worktreeManager) throw new Error('Worktree mode enabled, but no worktree manager is configured.');

  const timeoutMs = config.git.leaseWaitTimeoutMs;
  const pollMs = config.git.leaseWaitPollMs;
  const startedAt = Date.now();
  let notified = false;

  for (;;) {
    try {
      return await worktreeManager.acquire({
        branch,
        baseBranch: config.project.devBranch,
        agentId,
      });
    } catch (err: unknown) {
      const waitedMs = Date.now() - startedAt;
      // Only wait/retry for branch-in-use contention; other errors (git failures,
      // timeouts) are surfaced immediately. A timeout of 0 disables waiting.
      if (!isBranchInUseError(err) || waitedMs >= timeoutMs) {
        if (isBranchInUseError(err)) {
          const base = err instanceof Error ? err.message : String(err);
          throw new Error(
            `${base}. Waited ${Math.round(waitedMs / 1000)}s for branch "${branch}" to free up ` +
            `before giving up (timeout ${Math.round(timeoutMs / 1000)}s). ` +
            `Another agent is holding this branch — serialize work on it or dispatch to a different branch.`,
          );
        }
        throw err;
      }
      if (!notified) {
        notified = true;
        onWaiting?.({ branch, waitedMs, error: err instanceof Error ? err.message : String(err) });
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
}

type HostGitFinalizeOutcome = Awaited<ReturnType<typeof finalizeAgentChanges>>;
type SpawnLogMode = 'single' | 'parallel';

interface ExecuteAgentSpec {
  eventBus?: OrchestratorEventBusLike;
  db: ShepherdsDB;
  config: ShepherdsPiConfig;
  worktreeManager: WorktreeManager | null;
  beadsClient: BeadsClient | null;
  runId: string;
  personaName: string;
  instructions: string;
  context?: string;
  branch?: string;
  beadId?: string;
  requestedSkills?: string[];
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
    beadsClient,
    runId,
    personaName,
    instructions,
    context,
    branch,
    beadId,
    requestedSkills,
    logMode,
  } = spec;

  assertGitModeCompatibility(config);

  if (config.beads.enabled && config.beads.requireBeadOnSpawn && !beadId) {
    return {
      ok: false,
      error: 'beads.enabled requires beadId on every spawn_agent call. Create/claim a bead first.',
    };
  }

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

  let effectiveInstructions = instructions;
  let effectiveContext = context ?? '';

  if (beadId && beadsClient) {
    try {
      const bead = await prepareBeadForSpawn(beadsClient, config.beads, beadId, agentId);
      const beadContext = {
        beadId: bead.id,
        title: bead.title,
        acceptance: bead.acceptance,
        labels: bead.labels,
        parent: bead.parent,
        dispatchCount: bead.dispatchCount,
      };
      // Keep on context (not instructions) so coordinator/directive tokens stay intact
      // for scripts and so specialists still see acceptance + bead identity.
      const acceptanceBlock = bead.acceptance
        ? `Success criteria (from bead ${bead.id}):\n${bead.acceptance}`
        : '';
      effectiveContext = [
        effectiveContext,
        `beads: ${JSON.stringify(beadContext)}`,
        acceptanceBlock,
      ].filter(Boolean).join('\n');
      db.appendLog(
        runId,
        'bead_dispatch',
        { agentId, beadId: bead.id, dispatchCount: bead.dispatchCount },
        `Dispatch bead ${bead.id} via ${agentId} (count=${bead.dispatchCount})`,
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  }

  if (requestedSkills && requestedSkills.length > 0) {
    effectiveContext = [
      effectiveContext,
      `requestedSkills: ${JSON.stringify(requestedSkills)}`,
    ].filter(Boolean).join('\n');
  }

  db.createAgentRun({
    id: agentId,
    run_id: runId,
    step_id: beadId ?? null,
    persona: persona.name,
    model: persona.model,
    instructions: effectiveInstructions,
    context: effectiveContext || null,
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
  eventBus?.emit({ type: 'agent_spawned', agentId, persona: persona.name, branch: branchName });

  try {
    if (config.git.repoMode === 'worktree') {
      db.appendLog(
        runId,
        'agent_worktree_acquiring',
        { agentId, branch: branchName },
        `Acquiring worktree for ${agentId} on ${branchName}`,
      );
      eventBus?.emit({
        type: 'agent_event',
        agentId,
        event: { type: 'worktree_acquiring', branch: branchName },
      });
    }

    lease = await acquireWorktreeLease(worktreeManager, config, branchName, agentId, (info) => {
      db.appendLog(
        runId,
        'agent_worktree_waiting',
        { agentId, branch: info.branch, error: info.error },
        `Waiting for branch "${info.branch}" to free up for ${agentId}: ${info.error}`,
      );
      eventBus?.emit({
        type: 'agent_event',
        agentId,
        event: { type: 'worktree_waiting', branch: info.branch, error: info.error },
      });
    });
    if (lease) {
      db.appendLog(
        runId,
        'agent_worktree_acquired',
        { agentId, leaseId: lease.leaseId, branch: lease.branch, worktreePath: lease.worktreePath },
        `Worktree acquired for ${agentId} on ${lease.branch}`,
      );
      eventBus?.emit({
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
      instructions: effectiveInstructions,
      context: effectiveContext || undefined,
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
          eventBus?.emit({
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

        eventBus?.emit({ type: 'agent_event', agentId, event });
      },
    });

    let status: 'done' | 'failed' = spawnResult.exitCode === 0 ? 'done' : 'failed';
    const stderrTail = spawnResult.stderr.slice(-15).join('\n');
    let failReason = spawnResult.timedOut
      ? `Timed out after ${config.agent.timeoutMinutes} minutes`
      : `Exit code ${spawnResult.exitCode}`;
    if (status === 'failed' && stderrTail) {
      failReason += `\nContainer stderr (last lines):\n${stderrTail}`;
    }
    if (status === 'failed' && spawnResult.workspaceDir) {
      failReason += `\nWorkspace preserved for inspection: ${spawnResult.workspaceDir}`;
    }

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

          eventBus?.emit({
            type: 'agent_event',
            agentId,
            event: { type: 'host_git_finalized', ...hostGit },
          });
        } catch (err: unknown) {
          status = 'failed';
          const message = err instanceof Error ? err.message : String(err);
          failReason = `Host git finalize failed: ${message}`;
          eventBus?.emit({
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

      db.appendLog(runId, 'agent_completed', { agentId, beadId }, completedSummary);
      eventBus?.emit({ type: 'agent_completed', agentId, result: spawnResult.result });
    } else {
      db.appendLog(runId, 'agent_failed', { agentId, beadId, exitCode: spawnResult.exitCode, timedOut: spawnResult.timedOut }, `Agent failed: ${agentId} — ${failReason}`);
      eventBus?.emit({ type: 'agent_failed', agentId, error: failReason });
    }

    // Coordinator closes beads explicitly (pipeline Option B). Spawn only appends notes.
    if (beadId && beadsClient) {
      const summary = status === 'done'
        ? (spawnResult.result?.summary ?? 'agent completed')
        : failReason;
      try {
        await beadsClient.appendSpawnResult(beadId, `${status}: ${summary}`);
      } catch {
        /* non-fatal: run_log still has the result */
      }
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
    eventBus?.emit({ type: 'agent_failed', agentId, error: message });

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
  eventBus: OrchestratorEventBusLike | undefined,
  db: ShepherdsDB,
  config: ShepherdsPiConfig,
  getRunId: () => string,
  worktreeManager: WorktreeManager | null,
  beadsClient: BeadsClient | null,
): ToolDefinition<typeof SpawnAgentParams> {
  return defineTool({
    name: 'spawn_agent',
    label: 'Spawn Agent',
    description:
      'Spawn a single agent container with a specific persona and instructions. ' +
      'Blocks until the agent completes and returns its structured result. ' +
      'When beads is enabled, beadId is required; spawn claims the bead and increments dispatch count but does not close it.',
    parameters: SpawnAgentParams,
    promptSnippet: 'Spawn an agent to implement, review, or test code',
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { persona: personaName, instructions, branch, context, beadId, requestedSkills } = params;
      const runId = getRunId();

      const outcome = await executeAgentRun({
        eventBus,
        db,
        config,
        worktreeManager,
        beadsClient,
        runId,
        personaName,
        instructions,
        context,
        branch,
        beadId,
        requestedSkills,
        logMode: 'single',
      });

      if (!outcome.ok) {
        return {
          content: [{ type: 'text' as const, text: `Error spawning agent: ${outcome.error}` }],
          details: { error: true } as unknown as Record<string, unknown>,
        };
      }

      const { agentId, spawnResult, status, hostGit } = outcome;
      let resultText: string;
      if (spawnResult.result) {
        resultText = JSON.stringify(spawnResult.result, null, 2);
      } else {
        const stderrTail = spawnResult.stderr.slice(-20).join('\n');
        resultText =
          `Agent ${spawnResult.timedOut ? 'timed out' : `exited with code ${spawnResult.exitCode}`}. ` +
          `No structured result was produced.` +
          (stderrTail ? `\n\nContainer stderr (last lines):\n${stderrTail}` : '') +
          (spawnResult.workspaceDir ? `\n\nWorkspace preserved for inspection: ${spawnResult.workspaceDir}` : '');
      }

      return {
        content: [{ type: 'text' as const, text: resultText }],
        details: {
          agentId,
          exitCode: spawnResult.exitCode,
          status,
          timedOut: spawnResult.timedOut,
          hostGit,
          beadId,
        } as Record<string, unknown>,
      };
    },
  });
}

// ─── spawn_agents (parallel) ─────────────────────────────────────

function createSpawnAgentsTool(
  eventBus: OrchestratorEventBusLike | undefined,
  db: ShepherdsDB,
  config: ShepherdsPiConfig,
  getRunId: () => string,
  worktreeManager: WorktreeManager | null,
  beadsClient: BeadsClient | null,
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
            beadsClient,
            runId,
            personaName: agentSpec.persona,
            instructions: agentSpec.instructions,
            context: agentSpec.context,
            branch: agentSpec.branch,
            beadId: agentSpec.beadId,
            requestedSkills: agentSpec.requestedSkills,
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

function createBranchTool(eventBus: OrchestratorEventBusLike | undefined, config: ShepherdsPiConfig): ToolDefinition<typeof CreateBranchParams> {
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
        eventBus?.emit({ type: 'branch_created', name, base: baseBranch });

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

// ─── merge_branch ────────────────────────────────────────────────

// How many times to spawn the integrator resolver on a single conflicted merge
// before giving up and reporting to the coordinator.
const MAX_CONFLICT_RESOLVE_ATTEMPTS = 3;

/**
 * Spawn the integrator persona against an EXISTING integration worktree that
 * still contains conflict markers, and have it write resolved file contents.
 * The agent only edits files; the host performs all git. Returns the raw spawn
 * result so callers can inspect exit/status.
 */
async function spawnConflictResolver(args: {
  db: ShepherdsDB;
  config: ShepherdsPiConfig;
  runId: string;
  worktreePath: string;
  source: string;
  target: string;
  conflictedFiles: string[];
  attempt: number;
}): Promise<{ ok: boolean; agentId: string; error?: string }> {
  const { db, config, runId, worktreePath, source, target, conflictedFiles, attempt } = args;

  const persona = loadPersona('integrator', `${config.personasDir}/integrator`);
  if (!persona) {
    return { ok: false, agentId: 'integrator-missing', error: 'integrator persona not found' };
  }

  const agentId = `integrator-resolve-${crypto.randomUUID().substring(0, 8)}`;
  const fileList = conflictedFiles.map((f) => `  - ${f}`).join('\n');
  const instructions =
    `A host-side merge of branch "${source}" into "${target}" hit conflicts. You are working ` +
    `directly in the integration worktree at /workspace/repo, which contains the in-progress ` +
    `merge with conflict markers.\n\n` +
    `Resolve ALL merge conflicts by editing these files so they contain the correct, coherent ` +
    `merged result (no <<<<<<<, =======, >>>>>>> markers left):\n${fileList}\n\n` +
    `Rules:\n` +
    `- Preserve intent from BOTH sides; prefer the feature branch ("${source}") when changes ` +
    `overlap, unless that clearly breaks other work on "${target}".\n` +
    `- Do NOT run any git command (host-managed git: .git here is a host worktree pointer and ` +
    `git will fail). Just edit the files.\n` +
    `- Do NOT add new features; only reconcile the conflict.\n` +
    `- When done, ensure the project still builds/typechecks if quick to verify.\n` +
    `Write /output/result.json summarizing what you reconciled.`;

  const context =
    `Conflict resolution attempt ${attempt} of ${MAX_CONFLICT_RESOLVE_ATTEMPTS}. ` +
    `Integration worktree is a detached checkout at the tip of "${target}" with "${source}" ` +
    `being merged in. Only the listed files are conflicted.`;

  db.createAgentRun({
    id: agentId,
    run_id: runId,
    step_id: null,
    persona: persona.name,
    model: persona.model,
    instructions,
    context,
    branch: target,
    container_id: null,
    status: 'spawning',
    result: null,
    started_at: new Date().toISOString(),
    completed_at: null,
  });
  db.appendLog(runId, 'merge_conflict_resolve_spawned', { agentId, source, target, conflictedFiles }, `Spawned conflict resolver ${agentId} for ${source} -> ${target}`);

  try {
    // Mount the integration worktree directly (host-managed git so no in-container
    // git ops, no token needed). This bypasses the lease manager on purpose: the
    // worktree already exists and is owned by this merge operation.
    const gitToken = await resolveGitToken(config);
    const spawnResult = await spawnAgent({
      agentId,
      persona,
      instructions,
      context,
      branch: target,
      repoMode: 'worktree',
      gitOpsMode: 'host',
      worktreePath,
      gitToken,
      config,
    });
    const status = spawnResult.exitCode === 0 ? 'done' : 'failed';
    db.updateAgentStatus(agentId, status, spawnResult.result ? JSON.stringify(spawnResult.result) : undefined);
    if (status === 'failed') {
      return { ok: false, agentId, error: `resolver exited with code ${spawnResult.exitCode}` };
    }
    return { ok: true, agentId };
  } catch (err: unknown) {
    db.updateAgentStatus(agentId, 'failed');
    return { ok: false, agentId, error: err instanceof Error ? err.message : String(err) };
  }
}

function mergeBranchTool(
  eventBus: OrchestratorEventBusLike | undefined,
  db: ShepherdsDB,
  config: ShepherdsPiConfig,
  getRunId: () => string,
): ToolDefinition<typeof MergeBranchParams> {
  return defineTool({
    name: 'merge_branch',
    label: 'Merge Branch',
    description:
      'Integrate a feature branch into a target branch (default: dev) on the HOST. ' +
      'Performs a --no-ff merge in an ephemeral integration worktree; clean merges are ' +
      'committed and pushed automatically. On conflicts, an integrator agent is spawned ' +
      'to resolve them (it edits files; the host does all git), then the merge is finalized. ' +
      'The coordinator never touches the filesystem — this tool owns all git operations.',
    parameters: MergeBranchParams,
    promptSnippet: 'Merge a reviewed+tested feature branch into the integration branch',
    async execute(_toolCallId, params) {
      const runId = getRunId();
      const source = params.source;
      const target = params.target ?? config.project.devBranch;

      if (config.git.repoMode !== 'worktree') {
        return {
          content: [{ type: 'text' as const, text: 'merge_branch requires git.repo_mode=worktree (host-managed integration).' }],
          details: { error: true } as unknown as Record<string, unknown>,
        };
      }

      db.appendLog(runId, 'merge_started', { source, target }, `Merging ${source} -> ${target}`);
      eventBus?.emit({ type: 'merge_started', source, target });

      const attempt = await attemptMerge({
        repoPath: config.project.repoPath,
        worktreesDir: config.git.worktreesDir,
        source,
        target,
        authorName: config.git.authorName,
        authorEmail: config.git.authorEmail,
        noFf: true,
      });

      if (attempt.status === 'clean' || attempt.status === 'up-to-date') {
        const msg = attempt.status === 'clean'
          ? `Merged ${source} into ${target} (${attempt.commitSha.slice(0, 8)}) and pushed.`
          : `${target} already contains ${source}; nothing to merge.`;
        db.appendLog(runId, 'merge_completed', { source, target, status: attempt.status }, msg);
        eventBus?.emit({ type: 'merge_completed', source, target, status: attempt.status });
        return { content: [{ type: 'text' as const, text: msg }], details: { source, target, status: attempt.status } as Record<string, unknown> };
      }

      if (attempt.status === 'error') {
        const msg = `Merge of ${source} into ${target} failed: ${attempt.message}`;
        db.appendLog(runId, 'merge_failed', { source, target, message: attempt.message }, msg);
        eventBus?.emit({ type: 'merge_failed', source, target, error: attempt.message });
        return { content: [{ type: 'text' as const, text: msg }], details: { error: true, source, target } as unknown as Record<string, unknown> };
      }

      // ─── Conflict path: spawn resolver agent(s), then finalize on host ───
      const worktreePath = attempt.worktreePath;
      let conflictedFiles = attempt.conflictedFiles;
      db.appendLog(runId, 'merge_conflict', { source, target, conflictedFiles }, `Merge ${source} -> ${target} has ${conflictedFiles.length} conflicted file(s)`);
      eventBus?.emit({ type: 'merge_conflict', source, target, conflictedFiles });

      try {
        for (let attemptNo = 1; attemptNo <= MAX_CONFLICT_RESOLVE_ATTEMPTS; attemptNo++) {
          const resolver = await spawnConflictResolver({
            db, config, runId, worktreePath, source, target, conflictedFiles, attempt: attemptNo,
          });
          if (!resolver.ok) {
            db.appendLog(runId, 'merge_conflict_resolve_failed', { attempt: attemptNo, error: resolver.error }, `Resolver attempt ${attemptNo} failed: ${resolver.error}`);
            continue;
          }

          const fin = await finalizeMerge({
            repoPath: config.project.repoPath,
            worktreePath,
            source,
            target,
            authorName: config.git.authorName,
            authorEmail: config.git.authorEmail,
          });

          if (fin.status === 'clean') {
            const msg = `Merged ${source} into ${target} after resolving conflicts (${fin.commitSha.slice(0, 8)}) and pushed.`;
            db.appendLog(runId, 'merge_completed', { source, target, status: 'resolved', attempts: attemptNo }, msg);
            eventBus?.emit({ type: 'merge_completed', source, target, status: 'resolved' });
            return { content: [{ type: 'text' as const, text: msg }], details: { source, target, status: 'resolved', attempts: attemptNo } as Record<string, unknown> };
          }

          if (fin.status === 'unresolved') {
            conflictedFiles = fin.remainingMarkers;
            db.appendLog(runId, 'merge_conflict_unresolved', { attempt: attemptNo, remaining: fin.remainingMarkers }, `Resolver attempt ${attemptNo} left markers in ${fin.remainingMarkers.length} file(s)`);
            continue;
          }

          // finalize error
          const msg = `Merge finalize of ${source} into ${target} failed: ${fin.message}`;
          db.appendLog(runId, 'merge_failed', { source, target, message: fin.message }, msg);
          eventBus?.emit({ type: 'merge_failed', source, target, error: fin.message });
          return { content: [{ type: 'text' as const, text: msg }], details: { error: true, source, target } as unknown as Record<string, unknown> };
        }

        // Exhausted attempts — leave nothing behind, report to coordinator.
        const msg =
          `Could not automatically merge ${source} into ${target} after ${MAX_CONFLICT_RESOLVE_ATTEMPTS} ` +
          `resolver attempts. Remaining conflicted files:\n${conflictedFiles.map((f) => `  - ${f}`).join('\n')}\n` +
          `Ask the user how to proceed, or dispatch a fresh integrator with more specific guidance.`;
        db.appendLog(runId, 'merge_failed', { source, target, conflictedFiles, exhausted: true }, `Merge ${source} -> ${target} unresolved after ${MAX_CONFLICT_RESOLVE_ATTEMPTS} attempts`);
        eventBus?.emit({ type: 'merge_failed', source, target, error: 'unresolved conflicts' });
        return { content: [{ type: 'text' as const, text: msg }], details: { error: true, source, target, conflictedFiles } as unknown as Record<string, unknown> };
      } finally {
        // Always clean up the ephemeral integration worktree.
        await cleanupIntegrationWorktree(config.project.repoPath, worktreePath);
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

function updatePlanTool(eventBus: OrchestratorEventBusLike | undefined, db: ShepherdsDB, getRunId: () => string): ToolDefinition<typeof UpdatePlanParams> {
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
      eventBus?.emit({ type: 'plan_updated', steps });

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

function askUserTool(eventBus: OrchestratorEventBusLike | undefined): ToolDefinition<typeof AskUserParams> {
  return defineTool({
    name: 'ask_user',
    label: 'Ask User',
    description: 'Ask the user a question and wait for their response.',
    parameters: AskUserParams,
    promptSnippet: 'Ask the user for clarification or guidance',
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (eventBus) {
        const response = await eventBus.askUser(params.question);
        return {
          content: [{ type: 'text' as const, text: response }],
          details: {} as Record<string, unknown>,
        };
      }

      if (!ctx.hasUI) {
        return {
          content: [{ type: 'text' as const, text: 'Unable to ask user: interactive UI is not available.' }],
          details: { cancelled: true } as Record<string, unknown>,
        };
      }

      // Put the question in the dialog title (not placeholder) so it is visible
      // in UIs/clients that do not render input placeholders.
      const response = await ctx.ui.input(`Question from coordinator: ${params.question}`, 'Type your response');
      return {
        content: [{ type: 'text' as const, text: response ?? '' }],
        details: { cancelled: response == null } as Record<string, unknown>,
      };
    },
  });
}

// ─── update_goal_status ──────────────────────────────────────────

function updateGoalStatusTool(eventBus: OrchestratorEventBusLike | undefined, db: ShepherdsDB, getRunId: () => string): ToolDefinition<typeof UpdateGoalStatusParams> {
  return defineTool({
    name: 'update_goal_status',
    label: 'Update Goal Status',
    description: 'Update the current goal status to signal progress.',
    parameters: UpdateGoalStatusParams,
    async execute(_toolCallId, params) {
      const runId = getRunId();
      db.updateRunStatus(runId, params.status);
      db.appendLog(runId, 'status_changed', { status: params.status, message: params.message }, `Status: ${params.status}`);
      eventBus?.emit({ type: 'goal_status_changed', status: params.status, message: params.message });

      return {
        content: [{ type: 'text' as const, text: `Goal status updated to: ${params.status}` }],
        details: {} as Record<string, unknown>,
      };
    },
  });
}
