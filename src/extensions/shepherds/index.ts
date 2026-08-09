import path from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { loadConfig, type ShepherdsPiConfig } from '../../config/index.js';
import { resolveConfigPath } from '../../config/resolve-config.js';
import { ShepherdsDB } from '../../db/index.js';
import { createOrchestratorTools } from '../../orchestrator/tools.js';

interface RuntimeState {
  config: ShepherdsPiConfig;
  db: ShepherdsDB;
  runId: string;
}

export default function shepherdsExtension(pi: ExtensionAPI): void {
  let state: RuntimeState | null = null;

  function getState(ctx: ExtensionContext): RuntimeState {
    if (state) return state;

    const configPath = resolveConfigPath({ configPath: process.env.SHEPHERDS_PI_CONFIG });
    const config = loadConfig(configPath);

    const dbDir = path.join(config.project.repoPath, '.shepherds-pi');
    const dbPath = path.join(dbDir, 'shepherds.db');
    const db = new ShepherdsDB(dbPath);

    const fallbackRunId = `run-${Date.now().toString(36)}`;
    const runId = findExistingRunId(ctx, db) ?? fallbackRunId;

    if (!db.getRun(runId)) {
      db.createRun(runId, 'Interactive shepherds-pi coordination session');
      db.appendLog(runId, 'goal_set', { source: 'extension' }, 'Shepherds extension session started');
    }

    pi.appendEntry('shepherds-run', { runId });

    state = {
      config,
      db,
      runId,
    };

    return state;
  }

  function refreshStatusWidget(ctx: ExtensionContext): void {
    const s = getState(ctx);
    const run = s.db.getRun(s.runId);
    const goal = run?.goal ?? 'n/a';
    const status = run?.status ?? 'planning';
    const agentCount = s.db.getAgentRunsForGoal(s.runId).length;
    const plan = s.db.getPlan(s.runId);

    ctx.ui.setWidget('shepherds-pi', [
      `run: ${s.runId}`,
      `status: ${status}`,
      `goal: ${goal}`,
      `agents: ${agentCount}`,
      `plan: v${plan?.version ?? 0}`,
    ]);
  }

  pi.on('session_start', async (_event, ctx) => {
    const s = getState(ctx);

    const tools = createOrchestratorTools({
      eventBus: {
        emit: (event) => {
          if (event.type === 'user_question' && typeof event.question === 'string') {
            ctx.ui.notify(`Coordinator asks: ${event.question}`, 'info');
            return;
          }

          // Surface agent container diagnostics so spawn failures are visible.
          if (event.type === 'agent_failed') {
            const err = typeof event.error === 'string' ? event.error : 'unknown error';
            ctx.ui.notify(`Agent failed (${String(event.agentId ?? '?')}):\n${err}`, 'error');
            return;
          }

          if (event.type === 'agent_event') {
            const inner = (event as { event?: { type?: string; line?: string; branch?: string } }).event;
            if (inner?.type === 'worktree_waiting') {
              ctx.ui.notify(
                `Waiting for branch "${String(inner.branch ?? '?')}" to free up (held by another agent)`,
                'warning',
              );
              return;
            }
            if (inner?.type === 'container_stderr' && typeof inner.line === 'string') {
              // Only forward likely-error lines to avoid flooding the UI.
              const line = inner.line;
              if (/error|fail|not set|missing|no such|cannot|denied|refused/i.test(line)) {
                ctx.ui.notify(`[container] ${line}`, 'warning');
              }
            }
            return;
          }
        },
        askUser: async (question: string): Promise<string> => {
          const response = await ctx.ui.input(`Question from coordinator: ${question}`, 'Type your response');
          return response ?? '';
        },
      },
      db: s.db,
      config: s.config,
      getRunId: () => s.runId,
    });

    for (const tool of tools) {
      pi.registerTool(tool);
    }

    const toolNames = tools.map(t => t.name);
    const active = new Set(pi.getActiveTools());
    for (const name of toolNames) active.add(name);
    pi.setActiveTools(Array.from(active));

    ctx.ui.notify(`Shepherds extension loaded (${toolNames.length} tools)`, 'info');
    ctx.ui.notify(
      `config: ${process.env.SHEPHERDS_PI_CONFIG ?? '(discovered)'} | ` +
      `repo_mode=${s.config.git.repoMode} git_ops_mode=${s.config.git.gitOpsMode} image=${s.config.docker.image}`,
      s.config.git.repoMode === 'clone' ? 'warning' : 'info',
    );
    refreshStatusWidget(ctx);
  });

  pi.on('tool_execution_end', async (_event, ctx) => {
    refreshStatusWidget(ctx);
  });

  pi.on('session_shutdown', async (_event, ctx) => {
    if (state) {
      state.db.close();
      state = null;
    }
    ctx.ui.setWidget('shepherds-pi', []);
  });

  pi.registerCommand('shepherd-status', {
    description: 'Show shepherds-pi run status',
    handler: async (_args, ctx) => {
      refreshStatusWidget(ctx);
      const s = getState(ctx);
      const run = s.db.getRun(s.runId);
      const msg = run
        ? `run=${s.runId} status=${run.status} goal=${run.goal}`
        : `run=${s.runId}`;
      ctx.ui.notify(msg, 'info');
    },
  });

  pi.registerTool({
    name: 'shepherd_set_goal',
    label: 'Set Shepherd Goal',
    description: 'Set or update the active shepherd run goal in the run log.',
    parameters: Type.Object({
      goal: Type.String({ description: 'Goal text for this run' }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const s = getState(ctx);
      const existing = s.db.getRun(s.runId);

      if (!existing) {
        s.db.createRun(s.runId, params.goal);
      } else {
        s.db.updateRunGoal(s.runId, params.goal);
      }

      s.db.appendLog(s.runId, 'goal_set', { goal: params.goal }, `Goal set: ${params.goal}`);
      refreshStatusWidget(ctx);

      return {
        content: [{ type: 'text' as const, text: `Goal recorded: ${params.goal}` }],
        details: { runId: s.runId } as Record<string, unknown>,
      };
    },
  });
}

function findExistingRunId(ctx: ExtensionContext, db: ShepherdsDB): string | null {
  const entries = ctx.sessionManager.getEntries();

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== 'custom') continue;
    if (entry.customType !== 'shepherds-run') continue;

    const data = entry.data as { runId?: unknown } | undefined;
    if (typeof data?.runId === 'string') {
      return data.runId;
    }
  }

  const runs = db.listRuns();
  return runs[0]?.id ?? null;
}
