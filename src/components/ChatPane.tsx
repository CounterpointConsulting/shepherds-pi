import React from 'react';
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

export function ChatPane({ messages, goalStatus }: {
  messages: ChatMessage[];
  goalStatus: GoalStatus | undefined;
}) {
  return (
    <Box flexDirection="column" flexGrow={1}>
      {/* Chat header */}
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
      </Box>

      {/* Messages */}
      <Box flexDirection="column" flexGrow={1} paddingX={1} overflowY="hidden">
        {messages.map(msg => (
          <ChatMessageRow key={msg.id} message={msg} />
        ))}
        {messages.length === 0 && (
          <Text dimColor> No messages yet. Type a goal to get started.</Text>
        )}
      </Box>
    </Box>
  );
}

function ChatMessageRow({ message }: { message: ChatMessage }) {
  const time = new Date(message.timestamp).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  switch (message.role) {
    case 'user':
      return (
        <Box>
          <Text dimColor>{time} </Text>
          <Text bold color="green">You: </Text>
          <Text>{truncate(message.content, 120)}</Text>
        </Box>
      );

    case 'coordinator':
      return (
        <Box flexDirection="column">
          <Box>
            <Text dimColor>{time} </Text>
            <Text bold color="cyan">🐑: </Text>
          </Box>
          <Text>{truncate(message.content, 300)}</Text>
        </Box>
      );

    case 'tool_notification': {
      const icon = getToolIcon(message.meta?.toolName);
      const color = getToolColor(message.meta?.toolName);
      return (
        <Box>
          <Text dimColor>{time} </Text>
          <Text color={color}>{icon} </Text>
          <Text dimColor>{truncate(message.content, 100)}</Text>
        </Box>
      );
    }

    case 'ask_user':
      return (
        <Box>
          <Text dimColor>{time} </Text>
          <Text bold color="yellow">❓ Coordinator asks: </Text>
          <Text color="yellow">{truncate(message.content, 100)}</Text>
        </Box>
      );

    default:
      return null;
  }
}

function getToolIcon(toolName?: string): string {
  switch (toolName) {
    case 'spawn_agent': return '🔧';
    case 'create_branch': return '🌿';
    case 'update_plan': return '📋';
    case 'read_run_log': return '📖';
    case 'ask_user': return '❓';
    default: return '⚡';
  }
}

function getToolColor(toolName?: string): string {
  switch (toolName) {
    case 'spawn_agent': return 'blue';
    case 'create_branch': return 'green';
    case 'update_plan': return 'magenta';
    case 'ask_user': return 'yellow';
    default: return 'gray';
  }
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.substring(0, maxLen - 3) + '...';
}
