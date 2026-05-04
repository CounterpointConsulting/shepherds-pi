/**
 * Pure event translator.
 *
 * Converts pi SDK `AgentSessionEvent`s and `OrchestratorEvent`s into a
 * list of `Delta`s that describe how the goal's snapshot should change.
 *
 * Deliberately free of side effects: no DB writes, no notifications, no
 * logging, no I/O. The manager takes the returned deltas and applies
 * them (including any DB refresh the delta implies). This makes the
 * translator trivially unit-testable — feed it a list of events and
 * assert the deltas.
 *
 * Why this exists: every buggy UI behaviour so far has been a subtle
 * interaction in this event-handling code. Isolating it as pure logic
 * means regressions can be caught by fast tests rather than by running
 * the whole TUI and eyeballing the chat pane.
 */

import type { AgentSessionEvent } from '@mariozechner/pi-coding-agent';
import type { ThinkingContent } from '@mariozechner/pi-ai';
import type { ChatMessage, GoalStatus } from '../types.js';
import type { GoalSnapshot, AskUserPending } from './state.js';
import type { OrchestratorEvent } from './event-bus.js';
import { getToolLabel, getToolSummary } from './labels.js';

// ─── Delta language ──────────────────────────────────────────────

/**
 * A single unit of intended change. The manager translates each into
 * (a) a snapshot transformation and/or (b) a DB refresh.
 *
 * `notifyNow` is a metadata flag: if any delta in a batch carries it,
 * the manager flushes pending notifications immediately instead of
 * waiting for the throttle window.
 */
export type Delta =
  | { kind: 'add-message'; message: ChatMessage; notifyNow?: boolean }
  | { kind: 'replace-thinking'; content: string; makeMessage: () => ChatMessage }
  | { kind: 'remove-thinking' }
  | { kind: 'set-goal-status'; status: GoalStatus; notifyNow?: boolean }
  | { kind: 'refresh-agents' }
  | { kind: 'refresh-plan' }
  | { kind: 'set-ask-user'; pending: AskUserPending }
  | { kind: 'clear-ask-user' };

// ─── Context passed to the translator ────────────────────────────
// The manager supplies a clock + id generator so tests can control
// both. In production these are Date.now + nanoid-like helpers.

export interface TranslatorContext {
  goalId: string;
  now: () => string;          // ISO timestamp
  nextMessageId: () => string;
}

function makeCoordMessage(ctx: TranslatorContext, content: string): ChatMessage {
  return {
    id: ctx.nextMessageId(),
    goalId: ctx.goalId,
    role: 'coordinator',
    content,
    timestamp: ctx.now(),
  };
}

function makeToolMessage(
  ctx: TranslatorContext,
  content: string,
  meta: ChatMessage['meta'],
): ChatMessage {
  return {
    id: ctx.nextMessageId(),
    goalId: ctx.goalId,
    role: 'tool_notification',
    content,
    timestamp: ctx.now(),
    meta,
  };
}

function makeUserAskMessage(ctx: TranslatorContext, question: string): ChatMessage {
  return {
    id: ctx.nextMessageId(),
    goalId: ctx.goalId,
    role: 'ask_user',
    content: question,
    timestamp: ctx.now(),
  };
}

// ─── Pi SDK session events ───────────────────────────────────────

/**
 * Translate one pi SDK event into zero or more deltas.
 *
 * Design notes:
 *   - `message_start` is the reliable "assistant is working" signal.
 *     We also handle `turn_start` defensively in case the SDK emits
 *     only one of them.
 *   - `message_update` is intentionally ignored: streaming text causes
 *     flicker and the final content arrives via `message_end` anyway.
 *   - `message_end` branches on what the message contains:
 *       text        → replace thinking with the text
 *       tool call   → replace thinking with a thinking preview (or
 *                     remove the placeholder if no thinking blocks)
 *       thinking    → replace thinking placeholder with a preview
 *   - `agent_end` carries `notifyNow`: the user cares about knowing
 *     orchestration is done immediately, not up-to-300ms later.
 */
export function translatePiEvent(
  snap: GoalSnapshot,
  event: AgentSessionEvent,
  ctx: TranslatorContext,
): Delta[] {
  if (!('type' in event)) return [];

  switch (event.type) {
    case 'agent_start':
    case 'turn_end':
      return [];

    case 'turn_start': {
      // Belt-and-suspenders: also add thinking indicator on turn_start
      // in case message_start isn't emitted. withThinkingReplaced dedupes.
      return [{
        kind: 'replace-thinking',
        content: '🤖 Thinking...',
        makeMessage: () => makeCoordMessage(ctx, '🤖 Thinking...'),
      }];
    }

    case 'message_start': {
      const m = event.message;
      if (!m || m.role !== 'assistant') return [];
      return [{
        kind: 'replace-thinking',
        content: '🤖 Thinking...',
        makeMessage: () => makeCoordMessage(ctx, '🤖 Thinking...'),
      }];
    }

    case 'message_update':
      // Streaming text ignored — causes flicker. Final text lands via message_end.
      return [];

    case 'message_end': {
      const m = event.message;
      if (m.role !== 'assistant') return [];

      const textBlocks = m.content
        .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
        .map(c => c.text);
      const textContent = textBlocks.join('\n');
      const hasToolCall = m.content.some(c => c.type === 'toolCall');
      const thinkingBlocks = m.content
        .filter((c): c is ThinkingContent => c.type === 'thinking');

      if (textContent.trim()) {
        return [{
          kind: 'replace-thinking',
          content: textContent,
          makeMessage: () => makeCoordMessage(ctx, textContent),
        }];
      }

      if (!hasToolCall && thinkingBlocks.length > 0) {
        // Pure thinking (o3 after a tool result) — show preview
        const thinkingText = thinkingBlocks.map(t => t.thinking).join('\n');
        const preview = thinkingText.length > 500
          ? thinkingText.substring(0, 500) + '\n... (thinking continued)'
          : thinkingText;
        const content = `💭 Thinking:\n${preview}`;
        return [{
          kind: 'replace-thinking',
          content,
          makeMessage: () => makeCoordMessage(ctx, content),
        }];
      }

      if (hasToolCall && thinkingBlocks.length > 0) {
        const thinkingText = thinkingBlocks.map(t => t.thinking).join('\n');
        const preview = thinkingText.length > 300
          ? thinkingText.substring(0, 300) + '\n...'
          : thinkingText;
        const content = `💭 ${preview}`;
        return [{
          kind: 'replace-thinking',
          content,
          makeMessage: () => makeCoordMessage(ctx, content),
        }];
      }

      // Pure tool call, no thinking — clean up placeholder
      return [{ kind: 'remove-thinking' }];
    }

    case 'tool_execution_start': {
      const toolName = event.toolName;
      const label = getToolLabel(toolName);
      const summary = getToolSummary(toolName, event.args);
      return [{
        kind: 'add-message',
        message: makeToolMessage(ctx, `${label} ${summary}`, { toolName }),
      }];
    }

    case 'tool_execution_end': {
      if (!event.isError) return [];
      return [{
        kind: 'add-message',
        message: makeToolMessage(ctx, `⚠️ ${event.toolName} failed`, { toolName: event.toolName }),
      }];
    }

    case 'agent_end': {
      const deltas: Delta[] = [];
      deltas.push({ kind: 'remove-thinking' });
      if (snap.goal.status !== 'failed') {
        deltas.push({ kind: 'set-goal-status', status: 'completed', notifyNow: true });
      }
      deltas.push({
        kind: 'add-message',
        message: makeCoordMessage(ctx, '✅ Orchestration complete.'),
        notifyNow: true,
      });
      return deltas;
    }

    case 'compaction_start': {
      return [{
        kind: 'add-message',
        message: makeToolMessage(
          ctx,
          '🔄 Context compacted — coordinator will read_run_log to recover',
          { toolName: 'compaction' },
        ),
      }];
    }

    default:
      return [];
  }
}

// ─── Orchestrator event bus events ───────────────────────────────

/**
 * Translate one orchestrator-bus event into deltas.
 *
 * `agent_completed` / `agent_failed` / `user_question` all carry
 * `notifyNow`: the user is actively waiting on these, so the manager
 * flushes immediately instead of absorbing them into the throttle.
 */
export function translateBusEvent(
  _snap: GoalSnapshot,
  event: OrchestratorEvent,
  ctx: TranslatorContext,
): Delta[] {
  switch (event.type) {
    case 'goal_status_changed': {
      const deltas: Delta[] = [{
        kind: 'set-goal-status',
        status: event.status as GoalStatus,
      }];
      if (event.message) {
        deltas.push({
          kind: 'add-message',
          message: makeCoordMessage(ctx, `Status: ${event.status} — ${event.message}`),
        });
      }
      return deltas;
    }

    case 'plan_updated':
      return [{ kind: 'refresh-plan' }];

    case 'agent_spawned':
      return [
        { kind: 'refresh-agents' },
        {
          kind: 'add-message',
          message: makeToolMessage(
            ctx,
            `🔧 Agent spawned: ${event.agentId} (${event.persona})${event.branch ? ` on ${event.branch}` : ''}`,
            {
              toolName: 'spawn_agent',
              agentId: event.agentId,
              persona: event.persona,
              branch: event.branch,
            },
          ),
        },
      ];

    case 'agent_completed': {
      const summary = (event.result as { summary?: string })?.summary ?? 'done';
      return [
        { kind: 'refresh-agents' },
        {
          kind: 'add-message',
          message: makeToolMessage(
            ctx,
            `✅ Agent completed: ${event.agentId} — ${summary}`,
            { toolName: 'spawn_agent', agentId: event.agentId },
          ),
          notifyNow: true,
        },
      ];
    }

    case 'agent_failed':
      return [
        { kind: 'refresh-agents' },
        {
          kind: 'add-message',
          message: makeToolMessage(
            ctx,
            `❌ Agent failed: ${event.agentId} — ${event.error}`,
            { toolName: 'spawn_agent', agentId: event.agentId },
          ),
          notifyNow: true,
        },
      ];

    case 'agent_event': {
      const inner = event.event as Record<string, unknown>;
      if (inner?.type === 'container_stderr' && typeof inner.line === 'string') {
        return [{
          kind: 'add-message',
          message: makeToolMessage(ctx, `📦 ${inner.line}`, { toolName: 'container' }),
        }];
      }
      return [];
    }

    case 'branch_created':
      return [{
        kind: 'add-message',
        message: makeToolMessage(
          ctx,
          `🌿 Branch created: ${event.name} (from ${event.base})`,
          { toolName: 'create_branch' },
        ),
      }];

    case 'user_question':
      return [
        {
          kind: 'set-ask-user',
          pending: { question: event.question, resolve: event.resolve },
        },
        {
          kind: 'add-message',
          message: makeUserAskMessage(ctx, event.question),
          notifyNow: true,
        },
      ];

    case 'run_log_entry':
    case 'coordinator_message':
      return [];

    default:
      return [];
  }
}
