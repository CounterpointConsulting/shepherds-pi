import React from 'react';
import { Box, Text } from 'ink';
import type { Plan, AgentRun, StepStatus } from '../types.js';

const stepIcon: Record<StepStatus, string> = {
  pending: '◌',
  in_progress: '⟳',
  complete: '✓',
  failed: '✗',
  blocked: '⚠',
};

const stepColor: Record<StepStatus, string> = {
  pending: 'gray',
  in_progress: 'yellow',
  complete: 'green',
  failed: 'red',
  blocked: 'yellow',
};

export function PlanView({ plan, agents }: {
  plan: Plan | null;
  agents: ReadonlyArray<AgentRun>;
}) {
  if (!plan || plan.steps.length === 0) {
    return (
      <Box flexDirection="column" flexGrow={1} paddingX={2}>
        <Text bold color="cyan">Plan</Text>
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>No plan created yet. The coordinator is still planning...</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={2}>
      {/* Header */}
      <Box borderStyle="single" borderColor="cyan" paddingX={1}>
        <Text bold color="cyan">← Back (p)</Text>
        <Text dimColor> │ </Text>
        <Text bold>Plan</Text>
        <Text dimColor> v{plan.version} · {plan.steps.length} steps</Text>
      </Box>

      {/* Steps */}
      <Box flexDirection="column" marginTop={1}>
        {plan.steps.map((step, i) => {
          const stepAgents = step.agentRunIds
            .map(id => agents.find(a => a.id === id))
            .filter(Boolean) as AgentRun[];

          return (
            <Box key={step.id} flexDirection="column" marginBottom={1}>
              <Box>
                <Text color={stepColor[step.status]}>
                  {stepIcon[step.status]}{' '}
                </Text>
                <Text bold={step.status === 'in_progress'}>
                  Step {i + 1}: {step.description}
                </Text>
                <Text dimColor> [{step.persona}]</Text>
              </Box>

              {step.branch && (
                <Box marginLeft={3}>
                  <Text dimColor>Branch: </Text>
                  <Text color="green">{step.branch}</Text>
                </Box>
              )}

              {step.dependsOn.length > 0 && (
                <Box marginLeft={3}>
                  <Text dimColor>Depends on: </Text>
                  <Text dimColor>
                    {step.dependsOn.map(depId => {
                      const depStep = plan.steps.find(s => s.id === depId);
                      const depIndex = depStep ? plan.steps.indexOf(depStep) + 1 : '?';
                      const depIcon = depStep ? stepIcon[depStep.status] : '?';
                      return `${depIcon} Step ${depIndex}`;
                    }).join(', ')}
                  </Text>
                </Box>
              )}

              {stepAgents.length > 0 && (
                <Box marginLeft={3}>
                  <Text dimColor>Agents: </Text>
                  {stepAgents.map((agent, j) => (
                    <React.Fragment key={agent.id}>
                      {j > 0 && <Text dimColor>, </Text>}
                      <Text color={agent.status === 'done' ? 'green' : agent.status === 'running' ? 'yellow' : agent.status === 'failed' ? 'red' : 'gray'}>
                        {agent.id}
                      </Text>
                      <Text dimColor>
                        ({agent.status === 'done' ? '✓' : agent.status === 'running' ? '⟳' : agent.status === 'failed' ? '✗' : '○'})
                      </Text>
                    </React.Fragment>
                  ))}
                </Box>
              )}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
