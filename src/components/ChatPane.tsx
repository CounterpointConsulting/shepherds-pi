import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import type { ChatMessage, GoalStatus } from '../types.js';

const statusLabel: Record<GoalStatus, string> = {
  planning: '📋 Planning',
  executing: '⚡ Executing',
  reviewing: '🔍 Reviewing',
  testing: '🧪 Testing',
  merging: '🔀 Merging',
  completed: '✅ Completed',
  failed: '❌ Failed',
  blocked: '⚠️ Blocked',
};

/** Max lines for a single message's content (prevents one long message from eating all rows) */
const MAX_LINES_PER_MESSAGE = 8;

/**
 * Count the number of lines in a string.
 */
function countLines(text: string): number {
  if (!text) return 1;
  return text.split('\n').length;
}

/**
 * Truncate text to at most maxLines lines, appending "…" to the last line if truncated.
 */
function truncateLines(text: string, maxLines: number): string {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;
  return lines.slice(0, maxLines).join('\n') + '…';
}

/**
 * Estimate the rendered height (terminal rows) of a message.
 * We overestimate to ensure we never overflow.
 */
function estimateMessageHeight(msg: ChatMessage, contentWidth: number): number {
  const lines = countLines(msg.content);
  // Each line can wrap: rough overestimate
  const wrappedLines = msg.content.split('\n').reduce((sum, line) => {
    return sum + Math.max(1, Math.ceil((line.length + 1) / Math.max(contentWidth, 10)));
  }, 0);

  switch (msg.role) {
    case 'user':
    case 'coordinator':
    case 'ask_user':
      return 1 + Math.min(wrappedLines, MAX_LINES_PER_MESSAGE); // header + content
    case 'tool_notification':
      return Math.min(wrappedLines, MAX_LINES_PER_MESSAGE);
    default:
      return 1;
  }
}

interface ChatPaneProps {
  messages: ReadonlyArray<ChatMessage>;
  goalStatus: GoalStatus | undefined;
  maxRows: number;
  contentWidth: number;
}

export function ChatPane({ messages, goalStatus, maxRows, contentWidth }: ChatPaneProps) {
  // Reserve 1 row for the header line
  const availableRows = Math.max(maxRows - 1, 3);

  // Walk backwards from latest messages to fill available rows
  const { visibleMessages, hasMore } = useMemo(() => {
    const vis: ChatMessage[] = [];
    let usedRows = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      const rows = estimateMessageHeight(messages[i], contentWidth);
      if (usedRows + rows > availableRows) break;
      usedRows += rows;
      vis.unshift(messages[i]);
    }
    return { visibleMessages: vis, hasMore: vis.length < messages.length };
  }, [messages, availableRows, contentWidth]);

  return (
    <Box flexDirection="column">
      {/* Header — 1 row */}
      <Box paddingX={1}>
        <Text bold color="cyan">Chat</Text>
        {goalStatus && (
          <>
            <Text dimColor> │ </Text>
            <Text color={goalStatus === 'completed' ? 'green' : goalStatus === 'failed' ? 'red' : 'yellow'}>
              {statusLabel[goalStatus]}
            </Text>
          </>
        )}
        {hasMore && (
          <>
            <Text dimColor> │ </Text>
            <Text dimColor>↑ {messages.length - visibleMessages.length} earlier</Text>
          </>
        )}
      </Box>

      {/* Messages — strictly limited to availableRows */}
      <Box flexDirection="column" paddingX={1}>
        {visibleMessages.map(msg => (
          <ChatMessageRow key={msg.id} message={msg} maxLines={MAX_LINES_PER_MESSAGE} />
        ))}
        {messages.length === 0 && (
          <Text dimColor> No messages yet. Type a goal to get started.</Text>
        )}
      </Box>
    </Box>
  );
}

function ChatMessageRow({ message, maxLines }: { message: ChatMessage; maxLines: number }) {
  const time = new Date(message.timestamp).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  const truncated = truncateLines(message.content, maxLines);

  switch (message.role) {
    case 'user':
      return (
        <Box flexDirection="column">
          <Box>
            <Text dimColor>{time} </Text>
            <Text bold color="green">You:</Text>
          </Box>
          <Text wrap="wrap">{truncated}</Text>
        </Box>
      );

    case 'coordinator':
      return (
        <Box flexDirection="column">
          <Box>
            <Text dimColor>{time} </Text>
            <Text bold color="cyan">🐑:</Text>
          </Box>
          <Text wrap="wrap">{truncated}</Text>
        </Box>
      );

    case 'tool_notification': {
      const icon = getToolIcon(message.meta?.toolName);
      const color = getToolColor(message.meta?.toolName);
      return (
        <Box>
          <Text dimColor>{time} </Text>
          <Text color={color}>{icon} </Text>
          <Text dimColor wrap="wrap">{truncated}</Text>
        </Box>
      );
    }

    case 'ask_user':
      return (
        <Box flexDirection="column">
          <Box>
            <Text dimColor>{time} </Text>
            <Text bold color="yellow">❓ Coordinator asks:</Text>
          </Box>
          <Text color="yellow" wrap="wrap">{truncated}</Text>
        </Box>
      );

    default:
      return null;
  }
}

function getToolIcon(toolName?: string): string {
  switch (toolName) {
    case 'spawn_agent': return '🔧';
    case 'spawn_agents': return '🔧';
    case 'create_branch': return '🌿';
    case 'update_plan': return '📋';
    case 'read_run_log': return '📖';
    case 'ask_user': return '❓';
    case 'compaction': return '🔄';
    case 'container': return '📦';
    default: return '⚡';
  }
}

function getToolColor(toolName?: string): string {
  switch (toolName) {
    case 'spawn_agent': return 'blue';
    case 'spawn_agents': return 'blue';
    case 'create_branch': return 'green';
    case 'update_plan': return 'magenta';
    case 'ask_user': return 'yellow';
    default: return 'gray';
  }
}
