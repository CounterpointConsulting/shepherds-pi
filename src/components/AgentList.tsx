import React from 'react';
import { Box, Text } from 'ink';
import type { AgentRun, AgentStatus } from '../types.js';

const statusIcon: Record<AgentStatus, string> = {
  spawning: '⏳',
  running: '◐',
  done: '✓',
  failed: '✗',
  blocked: '⚠',
};

const statusColor: Record<AgentStatus, string> = {
  spawning: 'yellow',
  running: 'yellow',
  done: 'green',
  failed: 'red',
  blocked: 'yellow',
};

export function AgentList({ agents, cursorIndex, selectedId }: {
  agents: AgentRun[];
  cursorIndex: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <Box flexDirection="column">
      {/* Header */}
      <Box paddingX={1}>
        <Text bold color="cyan">Agents</Text>
        <Text dimColor> ({agents.length})</Text>
      </Box>

      {/* Agent rows — compact format */}
      <Box flexDirection="column">
        {agents.map((agent, i) => {
          const isCursor = i === cursorIndex;
          const isSelected = agent.id === selectedId;
          const icon = statusIcon[agent.status];
          const color = statusColor[agent.status];

          return (
            <Box key={agent.id} paddingX={1}>
              {isCursor ? (
                <Text inverse>
                  <Text color={color}>{icon} </Text>
                  <Text bold>{agent.id}</Text>
                  <Text dimColor> {agent.persona}</Text>
                </Text>
              ) : (
                <Text>
                  <Text color={color}>{icon} </Text>
                  <Text bold={isSelected}>{agent.id}</Text>
                  <Text dimColor> {agent.persona}</Text>
                </Text>
              )}
            </Box>
          );
        })}

        {agents.length === 0 && (
          <Box paddingX={1}>
            <Text dimColor> No agents dispatched yet</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}
