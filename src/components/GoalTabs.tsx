import React from 'react';
import { Box, Text } from 'ink';
import type { Goal, GoalStatus } from '../types.js';

const statusIcon: Record<GoalStatus, string> = {
  planning: '📋',
  executing: '⚡',
  reviewing: '🔍',
  testing: '🧪',
  merging: '🔀',
  completed: '✅',
  failed: '❌',
  blocked: '⚠️',
};

const statusColor: Record<GoalStatus, string> = {
  planning: 'yellow',
  executing: 'cyan',
  reviewing: 'magenta',
  testing: 'blue',
  merging: 'green',
  completed: 'green',
  failed: 'red',
  blocked: 'yellow',
};

export function GoalTabs({ goals, activeGoalId, onSelect }: {
  goals: Goal[];
  activeGoalId: string;
  onSelect: (goalId: string) => void;
}) {
  return (
    <Box borderStyle="single" borderColor="gray">
      <Text bold color="cyan"> 🐑 </Text>
      {goals.map((goal, i) => {
        const isActive = goal.id === activeGoalId;
        const icon = statusIcon[goal.status];
        const color = isActive ? statusColor[goal.status] : 'gray';
        const label = goal.goal.length > 28
          ? goal.goal.substring(0, 25) + '...'
          : goal.goal;

        return (
          <Box key={goal.id}>
            <Text
              color={color}
              bold={isActive}
              inverse={isActive}
            >
              {' '}{i + 1}:{icon} {label}{' '}
            </Text>
            <Text dimColor>│</Text>
          </Box>
        );
      })}
    </Box>
  );
}
