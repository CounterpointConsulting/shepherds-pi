import { computeUsageFromJsonl, computeUsageFromEvents } from '../agent/usage.js';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

// Build a synthetic transcript with the pi event shape. Usage appears on
// message_start, message_update AND message_end — only message_end assistant
// turns must be counted.
function assistantMsg(type: string, model: string, u: {
  input: number; output: number; cacheRead?: number; total: number; cost: number;
}): string {
  return JSON.stringify({
    type,
    message: {
      role: 'assistant',
      model,
      usage: {
        input: u.input,
        output: u.output,
        cacheRead: u.cacheRead ?? 0,
        cacheWrite: 0,
        totalTokens: u.total,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: u.cost },
      },
    },
  });
}

const lines = [
  JSON.stringify({ type: 'session', version: 3 }),
  JSON.stringify({ type: 'agent_start' }),
  // A user message with no usage — ignored.
  JSON.stringify({ type: 'message_end', message: { role: 'user', content: [] } }),
  // Turn 1: start + update carry usage but MUST NOT be counted; end counts.
  assistantMsg('message_start', 'grok-4.5', { input: 999, output: 999, total: 999, cost: 9.99 }),
  assistantMsg('message_update', 'grok-4.5', { input: 500, output: 250, total: 750, cost: 5.0 }),
  assistantMsg('message_end', 'grok-4.5', { input: 100, output: 50, cacheRead: 1000, total: 1150, cost: 0.01 }),
  // Turn 2: different model.
  assistantMsg('message_end', 'sonnet-4', { input: 200, output: 80, total: 280, cost: 0.02 }),
  // garbage line — tolerated.
  'not json at all',
  '',
];

const raw = lines.join('\n');
const totals = computeUsageFromJsonl(raw);

assert(totals.assistantTurns === 2, `expected 2 assistant turns, got ${totals.assistantTurns}`);
assert(totals.inputTokens === 300, `expected input 300, got ${totals.inputTokens}`);
assert(totals.outputTokens === 130, `expected output 130, got ${totals.outputTokens}`);
assert(totals.totalTokens === 1430, `expected total 1430, got ${totals.totalTokens}`);
assert(totals.cacheReadTokens === 1000, `expected cacheRead 1000, got ${totals.cacheReadTokens}`);
assert(Math.abs(totals.costUsd - 0.03) < 1e-9, `expected cost 0.03, got ${totals.costUsd}`);
assert(Object.keys(totals.byModel).length === 2, `expected 2 models, got ${Object.keys(totals.byModel).length}`);
assert(totals.byModel['grok-4.5'].assistantTurns === 1, 'grok should have 1 turn');
assert(Math.abs(totals.byModel['grok-4.5'].costUsd - 0.01) < 1e-9, 'grok cost should be 0.01');
assert(totals.byModel['sonnet-4'].totalTokens === 280, 'sonnet total should be 280');
console.log('Test 1: usage from jsonl (message_end assistant only) → PASS');

// Empty / no-usage input.
const empty = computeUsageFromEvents([{ type: 'session' }, { type: 'agent_start' }]);
assert(empty.assistantTurns === 0 && empty.costUsd === 0, 'empty should be zero');
console.log('Test 2: empty input → PASS');

console.log('✅ Usage test passed');
