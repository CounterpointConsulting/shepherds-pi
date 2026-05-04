/**
 * Tests for the pure event translator.
 *
 * These exercise the code that has historically been the buggiest
 * part of the system (every "chat didn't update" / "message got lost"
 * regression lived in the old handlePiEvent/handleBusEvent). Now that
 * translation is pure, we can drive it with synthetic event streams
 * and assert on the resulting deltas + snapshot state — no Docker, no
 * DB, no pi SDK required.
 */

import type { AgentSessionEvent } from '@mariozechner/pi-coding-agent';
import { translatePiEvent, translateBusEvent, type Delta, type TranslatorContext } from '../orchestrator/translator.js';
import { createSnapshot, withMessageAppended, withThinkingRemoved, withThinkingReplaced, type GoalSnapshot, THINKING_PLACEHOLDER } from '../orchestrator/state.js';
import type { OrchestratorEvent } from '../orchestrator/event-bus.js';
import type { ChatMessage, Goal } from '../types.js';

// ─── Test harness ────────────────────────────────────────────────

let idCounter = 0;
function freshCtx(goalId = 'goal-test'): TranslatorContext {
  idCounter = 0;
  return {
    goalId,
    now: () => '2025-01-01T00:00:00.000Z',
    nextMessageId: () => `msg-${++idCounter}`,
  };
}

function freshSnapshot(): GoalSnapshot {
  const goal: Goal = {
    id: 'goal-test',
    goal: 'test goal',
    status: 'planning',
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
  };
  return createSnapshot(goal);
}

/** Apply a batch of deltas to a snapshot as the real manager would. */
function applyDeltas(snap: GoalSnapshot, deltas: ReadonlyArray<Delta>): GoalSnapshot {
  let s = snap;
  for (const d of deltas) {
    switch (d.kind) {
      case 'add-message': s = withMessageAppended(s, d.message); break;
      case 'replace-thinking': s = withThinkingReplaced(s, d.content, d.makeMessage); break;
      case 'remove-thinking': s = withThinkingRemoved(s); break;
      // status/agents/plan/ask_user tested separately
      default: break;
    }
  }
  return s;
}

function assertEq<T>(actual: T, expected: T, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}\n  expected: ${JSON.stringify(expected)}\n  got:      ${JSON.stringify(actual)}`);
  }
}

function assert(cond: unknown, label: string): void {
  if (!cond) throw new Error(`Assertion failed: ${label}`);
}

// ─── Test 1: message_start adds a thinking placeholder ───────────

console.log('Test 1: message_start → Thinking placeholder...');
{
  const ctx = freshCtx();
  const snap = freshSnapshot();
  const event = {
    type: 'message_start',
    message: { role: 'assistant', content: [] },
  } as unknown as AgentSessionEvent;

  const deltas = translatePiEvent(snap, event, ctx);
  const next = applyDeltas(snap, deltas);

  assertEq(next.messages.length, 1, 'should add one message');
  assertEq(next.messages[0].content, THINKING_PLACEHOLDER, 'content should be thinking placeholder');
  assertEq(next.messages[0].role, 'coordinator', 'role should be coordinator');
  console.log('  ✓ thinking placeholder added');
}

// ─── Test 2: text message_end replaces thinking, doesn't clobber earlier ──

console.log('Test 2: message_end with text replaces only Thinking, not real msgs...');
{
  const ctx = freshCtx();
  let snap = freshSnapshot();

  // Prior real coordinator message (e.g. "Starting orchestration...")
  const priorMessage: ChatMessage = {
    id: 'prior',
    goalId: 'goal-test',
    role: 'coordinator',
    content: 'Starting orchestration...',
    timestamp: '2025-01-01T00:00:00.000Z',
  };
  snap = withMessageAppended(snap, priorMessage);

  // Turn starts → Thinking placeholder
  snap = applyDeltas(snap, translatePiEvent(snap, {
    type: 'message_start',
    message: { role: 'assistant', content: [] },
  } as unknown as AgentSessionEvent, ctx));

  // Turn ends with real text
  snap = applyDeltas(snap, translatePiEvent(snap, {
    type: 'message_end',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
  } as unknown as AgentSessionEvent, ctx));

  assertEq(snap.messages.length, 2, 'should have 2 messages (prior + replaced)');
  assertEq(snap.messages[0].content, 'Starting orchestration...', 'prior message preserved');
  assertEq(snap.messages[1].content, 'Done.', 'thinking replaced by text');
  console.log('  ✓ prior message preserved, thinking replaced');
}

// ─── Test 3: message_end with tool call removes only the placeholder ──

console.log('Test 3: message_end with tool call removes only Thinking placeholder...');
{
  const ctx = freshCtx();
  let snap = freshSnapshot();

  const priorMessage: ChatMessage = {
    id: 'prior',
    goalId: 'goal-test',
    role: 'coordinator',
    content: 'I will create a plan.',
    timestamp: '2025-01-01T00:00:00.000Z',
  };
  snap = withMessageAppended(snap, priorMessage);

  // Add thinking placeholder
  snap = applyDeltas(snap, translatePiEvent(snap, {
    type: 'message_start',
    message: { role: 'assistant', content: [] },
  } as unknown as AgentSessionEvent, ctx));

  assertEq(snap.messages.length, 2, 'should have prior + thinking');

  // Tool call with no thinking → remove placeholder
  snap = applyDeltas(snap, translatePiEvent(snap, {
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [{ type: 'toolCall', toolCallId: 't1', name: 'x', arguments: {} }],
    },
  } as unknown as AgentSessionEvent, ctx));

  assertEq(snap.messages.length, 1, 'thinking removed, prior preserved');
  assertEq(snap.messages[0].content, 'I will create a plan.', 'prior intact');
  console.log('  ✓ placeholder removed, prior preserved');
}

// ─── Test 4: remove-thinking never removes real messages ─────────

console.log('Test 4: remove-thinking on a real coordinator msg does nothing...');
{
  const ctx = freshCtx();
  let snap = freshSnapshot();

  const real: ChatMessage = {
    id: 'real',
    goalId: 'goal-test',
    role: 'coordinator',
    content: 'I finished the task.',
    timestamp: '2025-01-01T00:00:00.000Z',
  };
  snap = withMessageAppended(snap, real);

  // Tool-call-only message_end with nothing to remove should NOT delete
  // the real message.
  snap = applyDeltas(snap, translatePiEvent(snap, {
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [{ type: 'toolCall', toolCallId: 't1', name: 'x', arguments: {} }],
    },
  } as unknown as AgentSessionEvent, ctx));

  assertEq(snap.messages.length, 1, 'real message survives');
  assertEq(snap.messages[0].content, 'I finished the task.', 'real content intact');
  console.log('  ✓ real coordinator message survives');
}

// ─── Test 5: agent_end always flushes notification (notifyNow flag) ──

console.log('Test 5: agent_end carries notifyNow on the completion message...');
{
  const ctx = freshCtx();
  const snap = freshSnapshot();
  const deltas = translatePiEvent(snap, {
    type: 'agent_end',
    messages: [],
  } as unknown as AgentSessionEvent, ctx);

  const completionMsg = deltas.find(d =>
    d.kind === 'add-message' && d.message.content === '✅ Orchestration complete.'
  );
  assert(completionMsg, 'should have a completion message delta');
  assert(completionMsg && 'notifyNow' in completionMsg && completionMsg.notifyNow === true,
    'completion message should carry notifyNow=true');
  console.log('  ✓ agent_end produces notifyNow completion');
}

// ─── Test 6: tool_execution_start produces a tool notification ───

console.log('Test 6: tool_execution_start → tool_notification with toolName meta...');
{
  const ctx = freshCtx();
  const snap = freshSnapshot();
  const deltas = translatePiEvent(snap, {
    type: 'tool_execution_start',
    toolName: 'spawn_agent',
    args: { persona: 'dba' },
    toolCallId: 't1',
  } as unknown as AgentSessionEvent, ctx);

  assertEq(deltas.length, 1, 'one delta');
  assert(deltas[0].kind === 'add-message', 'add-message');
  if (deltas[0].kind === 'add-message') {
    assertEq(deltas[0].message.role, 'tool_notification', 'role');
    assertEq(deltas[0].message.meta?.toolName, 'spawn_agent', 'meta.toolName');
    assert(deltas[0].message.content.includes('Spawning dba'), 'label + summary');
  }
  console.log('  ✓ tool_execution_start → tool_notification');
}

// ─── Test 7: bus agent_completed carries notifyNow + refresh-agents ──

console.log('Test 7: bus agent_completed → refresh-agents + notifyNow message...');
{
  const ctx = freshCtx();
  const snap = freshSnapshot();
  const deltas = translateBusEvent(snap, {
    type: 'agent_completed',
    agentId: 'dba-abcd',
    result: { summary: 'Created users table' },
  } as OrchestratorEvent, ctx);

  assert(deltas.some(d => d.kind === 'refresh-agents'), 'refresh-agents present');
  const msgDelta = deltas.find(d => d.kind === 'add-message');
  assert(msgDelta && msgDelta.kind === 'add-message' && msgDelta.notifyNow === true,
    'message carries notifyNow');
  if (msgDelta && msgDelta.kind === 'add-message') {
    assert(msgDelta.message.content.includes('Created users table'), 'summary included');
  }
  console.log('  ✓ agent_completed → refresh + notifyNow');
}

// ─── Test 8: bus user_question sets ask-user pending + notifyNow msg ─

console.log('Test 8: bus user_question → set-ask-user + notifyNow message...');
{
  const ctx = freshCtx();
  const snap = freshSnapshot();
  const resolve = (_s: string) => { /* noop */ };
  const deltas = translateBusEvent(snap, {
    type: 'user_question',
    question: 'Which framework?',
    resolve,
  } as OrchestratorEvent, ctx);

  const setPending = deltas.find(d => d.kind === 'set-ask-user');
  assert(setPending, 'set-ask-user present');
  if (setPending && setPending.kind === 'set-ask-user') {
    assertEq(setPending.pending.question, 'Which framework?', 'question');
    assert(setPending.pending.resolve === resolve, 'resolve passed through');
  }

  const msgDelta = deltas.find(d => d.kind === 'add-message');
  assert(msgDelta && msgDelta.kind === 'add-message' && msgDelta.notifyNow === true,
    'ask_user message flushes immediately');
  console.log('  ✓ user_question → pending ask_user + notifyNow');
}

// ─── Test 9: snapshot reference equality on no-op events ─────────

console.log('Test 9: no-op events return same snapshot reference...');
{
  const ctx = freshCtx();
  const snap = freshSnapshot();
  const deltas = translatePiEvent(snap, {
    type: 'turn_end',
  } as AgentSessionEvent, ctx);
  assertEq(deltas.length, 0, 'turn_end produces no deltas');
  console.log('  ✓ no-op events return no deltas (snapshot reference preserved upstream)');
}

// ─── Test 10: streaming message_update is ignored ───────────────

console.log('Test 10: message_update is ignored (prevents flicker)...');
{
  const ctx = freshCtx();
  const snap = freshSnapshot();
  const deltas = translatePiEvent(snap, {
    type: 'message_update',
    message: { role: 'assistant', content: [{ type: 'text', text: 'partial...' }] },
  } as unknown as AgentSessionEvent, ctx);
  assertEq(deltas.length, 0, 'message_update produces no deltas');
  console.log('  ✓ message_update ignored');
}

// ─── Test 11: thinking-only message_end shows preview ───────────

console.log('Test 11: thinking-only message_end → thinking preview...');
{
  const ctx = freshCtx();
  let snap = freshSnapshot();

  snap = applyDeltas(snap, translatePiEvent(snap, {
    type: 'message_start',
    message: { role: 'assistant', content: [] },
  } as unknown as AgentSessionEvent, ctx));

  snap = applyDeltas(snap, translatePiEvent(snap, {
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [{ type: 'thinking', thinking: 'pondering the options carefully' }],
    },
  } as unknown as AgentSessionEvent, ctx));

  assertEq(snap.messages.length, 1, 'one message');
  assert(snap.messages[0].content.startsWith('💭'), 'starts with thinking marker');
  assert(snap.messages[0].content.includes('pondering the options'), 'contains thinking text');
  console.log('  ✓ thinking preview shown when no text/toolCall');
}

// ─── Summary ─────────────────────────────────────────────────────

console.log('\n✅ All translator tests passed!');
