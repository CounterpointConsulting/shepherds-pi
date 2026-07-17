import path from 'node:path';
import { loadConfig } from '../config/index.js';
import { resolveConfigPath } from '../config/resolve-config.js';
import { ShepherdsDB, type DbAgentRun, type DbRun } from '../db/index.js';

export interface HistoryCommandOptions {
  configPath?: string;
  /** Limit to a single run id. */
  runId?: string;
  /** Emit machine-readable JSON instead of text. */
  json?: boolean;
  /** Show only the cost/usage rollup (Layer 3). */
  costOnly?: boolean;
  /** Include full transcript dump for each agent. */
  transcripts?: boolean;
}

interface AgentUsageView {
  agentId: string;
  persona: string;
  model: string;
  branch: string | null;
  status: string;
  startedAt: string;
  completedAt: string | null;
  durationSec: number | null;
  assistantTurns: number;
  tokensInput: number;
  tokensOutput: number;
  tokensTotal: number;
  costUsd: number;
  summary: string | null;
}

interface RunView {
  run: DbRun;
  agents: AgentUsageView[];
  totals: {
    agents: number;
    assistantTurns: number;
    tokensInput: number;
    tokensOutput: number;
    tokensTotal: number;
    costUsd: number;
    byModel: Record<string, { tokensTotal: number; costUsd: number; assistantTurns: number }>;
    byPersona: Record<string, { tokensTotal: number; costUsd: number; agents: number }>;
  };
}

function num(v: number | null | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function parseSummary(result: string | null): string | null {
  if (!result) return null;
  try {
    const parsed = JSON.parse(result) as { summary?: unknown };
    return typeof parsed.summary === 'string' ? parsed.summary : null;
  } catch {
    return null;
  }
}

function durationSec(a: DbAgentRun): number | null {
  if (!a.completed_at) return null;
  const start = Date.parse(a.started_at);
  const end = Date.parse(a.completed_at);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, Math.round((end - start) / 1000));
}

function buildRunView(db: ShepherdsDB, run: DbRun): RunView {
  const agents = db.getAgentRunsForGoal(run.id);
  const views: AgentUsageView[] = agents.map((a) => ({
    agentId: a.id,
    persona: a.persona,
    model: a.model,
    branch: a.branch,
    status: a.status,
    startedAt: a.started_at,
    completedAt: a.completed_at,
    durationSec: durationSec(a),
    assistantTurns: num(a.assistant_turns),
    tokensInput: num(a.tokens_input),
    tokensOutput: num(a.tokens_output),
    tokensTotal: num(a.tokens_total),
    costUsd: num(a.cost_usd),
    summary: parseSummary(a.result),
  }));

  const totals: RunView['totals'] = {
    agents: views.length,
    assistantTurns: 0,
    tokensInput: 0,
    tokensOutput: 0,
    tokensTotal: 0,
    costUsd: 0,
    byModel: {},
    byPersona: {},
  };

  for (const v of views) {
    totals.assistantTurns += v.assistantTurns;
    totals.tokensInput += v.tokensInput;
    totals.tokensOutput += v.tokensOutput;
    totals.tokensTotal += v.tokensTotal;
    totals.costUsd += v.costUsd;

    const m = totals.byModel[v.model] ?? { tokensTotal: 0, costUsd: 0, assistantTurns: 0 };
    m.tokensTotal += v.tokensTotal;
    m.costUsd += v.costUsd;
    m.assistantTurns += v.assistantTurns;
    totals.byModel[v.model] = m;

    const p = totals.byPersona[v.persona] ?? { tokensTotal: 0, costUsd: 0, agents: 0 };
    p.tokensTotal += v.tokensTotal;
    p.costUsd += v.costUsd;
    p.agents += 1;
    totals.byPersona[v.persona] = p;
  }

  return { run, agents: views, totals };
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function fmtCost(n: number): string {
  return `$${n.toFixed(4)}`;
}

function fmtDuration(sec: number | null): string {
  if (sec === null) return '—';
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m${s.toString().padStart(2, '0')}s`;
}

function pad(s: string, width: number): string {
  return s.length >= width ? s.slice(0, width) : s + ' '.repeat(width - s.length);
}

function printRunText(view: RunView, opts: HistoryCommandOptions, db: ShepherdsDB): void {
  const { run, agents, totals } = view;
  console.log('');
  console.log(`Run ${run.id}  [${run.status}]  ${run.created_at}`);
  console.log(`Goal: ${run.goal}`);
  console.log('');

  if (!opts.costOnly) {
    if (agents.length === 0) {
      console.log('  (no agents run yet)');
    } else {
      console.log(
        '  ' +
        pad('AGENT', 30) + pad('PERSONA', 22) + pad('STATUS', 9) +
        pad('DUR', 8) + pad('TURNS', 7) + pad('TOKENS', 10) + pad('COST', 11) + 'BRANCH',
      );
      console.log('  ' + '─'.repeat(116));
      for (const a of agents) {
        console.log(
          '  ' +
          pad(a.agentId, 30) + pad(a.persona, 22) + pad(a.status, 9) +
          pad(fmtDuration(a.durationSec), 8) + pad(String(a.assistantTurns), 7) +
          pad(fmtTokens(a.tokensTotal), 10) + pad(fmtCost(a.costUsd), 11) +
          (a.branch ?? '—'),
        );
        if (a.summary) {
          console.log('  ' + ' '.repeat(2) + `↳ ${a.summary.replace(/\s+/g, ' ').slice(0, 100)}`);
        }
        if (opts.transcripts) {
          const t = db.getAgentTranscript(a.agentId);
          if (t) {
            console.log('  ' + ' '.repeat(4) + `[transcript: ${t.event_count} events, ${t.transcript.length} bytes]`);
          }
        }
      }
    }
    console.log('');
  }

  // Cost / usage rollup (Layer 3)
  console.log('  Usage rollup:');
  console.log(`    agents=${totals.agents}  turns=${totals.assistantTurns}  ` +
    `tokens=${fmtTokens(totals.tokensTotal)} (in ${fmtTokens(totals.tokensInput)} / out ${fmtTokens(totals.tokensOutput)})  ` +
    `cost=${fmtCost(totals.costUsd)}`);

  const models = Object.entries(totals.byModel).sort((a, b) => b[1].costUsd - a[1].costUsd);
  if (models.length > 0) {
    console.log('    by model:');
    for (const [model, m] of models) {
      console.log(`      ${pad(model, 30)} turns=${pad(String(m.assistantTurns), 5)} tokens=${pad(fmtTokens(m.tokensTotal), 9)} cost=${fmtCost(m.costUsd)}`);
    }
  }
  const personas = Object.entries(totals.byPersona).sort((a, b) => b[1].costUsd - a[1].costUsd);
  if (personas.length > 0) {
    console.log('    by persona:');
    for (const [persona, p] of personas) {
      console.log(`      ${pad(persona, 30)} agents=${pad(String(p.agents), 5)} tokens=${pad(fmtTokens(p.tokensTotal), 9)} cost=${fmtCost(p.costUsd)}`);
    }
  }
}

export async function runHistoryCommand(opts: HistoryCommandOptions = {}): Promise<number> {
  const configPath = resolveConfigPath({ configPath: opts.configPath });
  const config = loadConfig(configPath);
  const dbPath = path.join(config.project.repoPath, '.shepherds-pi', 'shepherds.db');

  const db = new ShepherdsDB(dbPath);
  try {
    let runs: DbRun[];
    if (opts.runId) {
      const run = db.getRun(opts.runId);
      if (!run) {
        console.error(`❌ Run not found: ${opts.runId}`);
        return 1;
      }
      runs = [run];
    } else {
      runs = db.listRuns();
    }

    if (runs.length === 0) {
      console.log('No runs recorded yet.');
      return 0;
    }

    const views = runs.map((r) => buildRunView(db, r));

    if (opts.json) {
      console.log(JSON.stringify(opts.runId ? views[0] : views, null, 2));
      return 0;
    }

    // Grand total across all shown runs.
    const grand = { costUsd: 0, tokensTotal: 0, agents: 0 };
    for (const v of views) {
      printRunText(v, opts, db);
      grand.costUsd += v.totals.costUsd;
      grand.tokensTotal += v.totals.tokensTotal;
      grand.agents += v.totals.agents;
    }

    if (views.length > 1) {
      console.log('');
      console.log('═'.repeat(60));
      console.log(`PROJECT TOTAL: ${views.length} runs, ${grand.agents} agents, ` +
        `${fmtTokens(grand.tokensTotal)} tokens, ${fmtCost(grand.costUsd)}`);
    }

    return 0;
  } finally {
    db.close();
  }
}
