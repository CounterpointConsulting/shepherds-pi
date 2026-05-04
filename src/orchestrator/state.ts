/**
 * GoalSnapshot — an immutable view of one goal's state.
 *
 * Every state-changing operation returns a new snapshot rather than
 * mutating the old one. This gives the React TUI stable reference
 * equality for unchanged fields so `React.memo`-wrapped components
 * can skip re-rendering when their slice of state didn't change.
 *
 * The manager keeps a `Map<goalId, GoalSnapshot>`. When a delta is
 * applied to one goal, only that entry gets a new snapshot; other
 * goals' snapshots retain their old references.
 */

import type { Goal, AgentRun, ChatMessage, Plan } from '../types.js';

/** Thinking-placeholder markers — content strings we recognize for targeted replacement. */
export const THINKING_PLACEHOLDER = '🤖 Thinking...';
export const THINKING_PREVIEW_PREFIX = '💭';

export interface AskUserPending {
  question: string;
  resolve: (response: string) => void;
}

export interface GoalSnapshot {
  readonly goal: Goal;
  readonly messages: ReadonlyArray<ChatMessage>;
  readonly agents: ReadonlyArray<AgentRun>;
  readonly plan: Plan | null;
  readonly askUser: AskUserPending | null;
}

/**
 * Create a fresh snapshot with empty collections.
 */
export function createSnapshot(goal: Goal, initialMessages: ChatMessage[] = []): GoalSnapshot {
  return Object.freeze({
    goal: Object.freeze({ ...goal }),
    messages: Object.freeze([...initialMessages]),
    agents: Object.freeze([]) as ReadonlyArray<AgentRun>,
    plan: null,
    askUser: null,
  });
}

// ─── Transformations ─────────────────────────────────────────────
// Each returns a new snapshot with exactly one field changed. The
// caller composes them. Unchanged fields keep their same reference
// so downstream `===` checks and React.memo both work.

export function withGoal(snap: GoalSnapshot, patch: Partial<Goal>): GoalSnapshot {
  return Object.freeze({
    ...snap,
    goal: Object.freeze({ ...snap.goal, ...patch, updatedAt: new Date().toISOString() }),
  });
}

export function withMessageAppended(snap: GoalSnapshot, message: ChatMessage): GoalSnapshot {
  return Object.freeze({
    ...snap,
    messages: Object.freeze([...snap.messages, message]),
  });
}

/**
 * Replace the most recent coordinator message if and only if it is a
 * thinking placeholder. Otherwise append as a new message.
 *
 * Placeholder recognition: content === THINKING_PLACEHOLDER, or starts
 * with THINKING_PREVIEW_PREFIX (for thinking-preview messages we may
 * have inserted ourselves on a prior tool call).
 */
export function withThinkingReplaced(
  snap: GoalSnapshot,
  newContent: string,
  makeMessage: () => ChatMessage,
): GoalSnapshot {
  for (let i = snap.messages.length - 1; i >= 0; i--) {
    const m = snap.messages[i];
    if (m.role !== 'coordinator') continue;
    if (m.content === THINKING_PLACEHOLDER || m.content.startsWith(THINKING_PREVIEW_PREFIX)) {
      const replaced = { ...m, content: newContent };
      const next = snap.messages.slice();
      next[i] = replaced;
      return Object.freeze({ ...snap, messages: Object.freeze(next) });
    }
    // Last coordinator message is real content — don't clobber it
    break;
  }
  return withMessageAppended(snap, makeMessage());
}

/**
 * Remove the most recent coordinator message iff it is the literal
 * THINKING_PLACEHOLDER. Thinking *previews* are left alone — they are
 * meaningful content (a summary of the model's reasoning) and should
 * survive subsequent turns.
 */
export function withThinkingRemoved(snap: GoalSnapshot): GoalSnapshot {
  for (let i = snap.messages.length - 1; i >= 0; i--) {
    const m = snap.messages[i];
    if (m.role !== 'coordinator') continue;
    if (m.content === THINKING_PLACEHOLDER) {
      const next = snap.messages.slice();
      next.splice(i, 1);
      return Object.freeze({ ...snap, messages: Object.freeze(next) });
    }
    // Last coordinator message is real content or a preview — leave it
    break;
  }
  return snap;
}

export function withAgents(snap: GoalSnapshot, agents: ReadonlyArray<AgentRun>): GoalSnapshot {
  return Object.freeze({ ...snap, agents: Object.freeze([...agents]) });
}

export function withPlan(snap: GoalSnapshot, plan: Plan | null): GoalSnapshot {
  return Object.freeze({ ...snap, plan });
}

export function withAskUser(snap: GoalSnapshot, askUser: AskUserPending | null): GoalSnapshot {
  return Object.freeze({ ...snap, askUser });
}
