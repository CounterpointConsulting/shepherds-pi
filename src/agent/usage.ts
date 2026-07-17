/**
 * Token/cost usage extraction from a pi agent's JSON event stream.
 *
 * pi (in `--mode json`) emits one JSON object per line. Assistant turns carry a
 * `usage` object on their `message_end` event:
 *
 *   { type: "message_end", message: { role: "assistant", model, usage: {
 *       input, output, cacheRead, cacheWrite, totalTokens,
 *       cost: { input, output, cacheRead, cacheWrite, total } } } }
 *
 * IMPORTANT: usage also appears on `message_start` and streaming
 * `message_update` events. Summing those double/over-counts. We aggregate ONLY
 * from `message_end` events with role "assistant", which carry the final
 * authoritative usage for that turn.
 */

export interface AgentUsageTotals {
  /** Number of assistant turns (LLM responses) counted. */
  assistantTurns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number;
  /** Per-model breakdown (model id -> totals). */
  byModel: Record<string, {
    assistantTurns: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costUsd: number;
  }>;
}

function emptyTotals(): AgentUsageTotals {
  return {
    assistantTurns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    byModel: {},
  };
}

interface PiUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: { total?: number };
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * Aggregate usage from already-parsed pi events (as collected by spawnAgent).
 */
export function computeUsageFromEvents(events: Array<Record<string, unknown>>): AgentUsageTotals {
  const totals = emptyTotals();

  for (const ev of events) {
    if (ev?.type !== 'message_end') continue;
    const message = ev.message as { role?: string; model?: string; responseModel?: string; usage?: PiUsage } | undefined;
    if (!message || message.role !== 'assistant' || !message.usage) continue;

    const u = message.usage;
    const model = message.model || message.responseModel || 'unknown';
    const cost = num(u.cost?.total);
    const input = num(u.input);
    const output = num(u.output);
    const total = num(u.totalTokens);

    totals.assistantTurns += 1;
    totals.inputTokens += input;
    totals.outputTokens += output;
    totals.cacheReadTokens += num(u.cacheRead);
    totals.cacheWriteTokens += num(u.cacheWrite);
    totals.totalTokens += total;
    totals.costUsd += cost;

    const bucket = totals.byModel[model] ?? {
      assistantTurns: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0,
    };
    bucket.assistantTurns += 1;
    bucket.inputTokens += input;
    bucket.outputTokens += output;
    bucket.totalTokens += total;
    bucket.costUsd += cost;
    totals.byModel[model] = bucket;
  }

  return totals;
}

/**
 * Aggregate usage from a raw events.jsonl transcript (LF-framed JSON lines).
 * Tolerant of blank/garbage lines.
 */
export function computeUsageFromJsonl(raw: string): AgentUsageTotals {
  const events: Array<Record<string, unknown>> = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as Record<string, unknown>);
    } catch {
      // skip non-JSON line
    }
  }
  return computeUsageFromEvents(events);
}
