import React from 'react';
import { Box, Text } from 'ink';
import type { AgentRun } from '../types.js';
import { getElapsed } from '../utils.js';

export function AgentDetail({ agent, expanded, onBack }: {
  agent: AgentRun;
  expanded: boolean;
  onBack: () => void;
}) {
  if (expanded) {
    return <AgentDetailExpanded agent={agent} onBack={onBack} />;
  }

  const elapsed = getElapsed(agent.startedAt, agent.completedAt ?? undefined);
  const statusLabel = agent.status === 'running' ? `Running (${elapsed})`
    : agent.status === 'done' ? 'Done'
    : agent.status === 'failed' ? 'Failed'
    : agent.status === 'blocked' ? 'Blocked'
    : 'Spawning';

  const statusColor = agent.status === 'running' ? 'yellow'
    : agent.status === 'done' ? 'green'
    : agent.status === 'failed' ? 'red'
    : 'yellow';

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
      <Text bold color="cyan">{agent.id}</Text>

      <Box>
        <Text dimColor>Persona:</Text>
        <Text> {agent.persona}</Text>
      </Box>

      {agent.branch && (
        <Box>
          <Text dimColor>Branch: </Text>
          <Text color="green">{agent.branch}</Text>
        </Box>
      )}

      <Box>
        <Text dimColor>Status: </Text>
        <Text color={statusColor}>{statusLabel}</Text>
      </Box>

      {agent.instructions && (
        <Box flexDirection="column">
          <Text dimColor>Instructions:</Text>
          <Text>{truncate(agent.instructions, 120)}</Text>
        </Box>
      )}

      {agent.result && (
        <Box flexDirection="column">
          <Text dimColor>Result:</Text>
          <Text color={agent.result.approved === true ? 'green' : agent.result.approved === false ? 'red' : 'cyan'}>
            {agent.result.summary}
          </Text>
        </Box>
      )}

      <Text dimColor>Enter: expand</Text>
    </Box>
  );
}

function AgentDetailExpanded({ agent, onBack }: { agent: AgentRun; onBack: () => void }) {
  const elapsed = getElapsed(agent.startedAt, agent.completedAt ?? undefined);

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      {/* Header */}
      <Box borderStyle="single" borderColor="cyan" paddingX={1}>
        <Text bold color="cyan">← Back (Esc)</Text>
        <Text dimColor> │ </Text>
        <Text bold>{agent.id}</Text>
        <Text dimColor> ({agent.persona})</Text>
        {agent.branch && (
          <>
            <Text dimColor> · </Text>
            <Text color="green">{agent.branch}</Text>
          </>
        )}
        <Text dimColor> · </Text>
        <Text color={agent.status === 'done' ? 'green' : agent.status === 'failed' ? 'red' : 'yellow'}>
          {agent.status === 'done' ? '✓ done' : agent.status === 'running' ? '⟳ running' : agent.status}
        </Text>
      </Box>

      {/* Meta */}
      <Box flexDirection="column" marginTop={1}>
        <Box>
          <Text bold>Persona: </Text>
          <Text>{agent.persona}</Text>
        </Box>
        <Box>
          <Text bold>Model:   </Text>
          <Text>{agent.model}</Text>
        </Box>
        {agent.branch && (
          <Box>
            <Text bold>Branch:  </Text>
            <Text color="green">{agent.branch}</Text>
          </Box>
        )}
        <Box>
          <Text bold>Elapsed: </Text>
          <Text>{elapsed}</Text>
        </Box>
      </Box>

      {/* Instructions */}
      <Box flexDirection="column" marginTop={1}>
        <Text bold color="cyan">Instructions:</Text>
        <Text>{agent.instructions}</Text>
      </Box>

      {/* Context */}
      {agent.context && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color="cyan">Context:</Text>
          <Text dimColor>{agent.context}</Text>
        </Box>
      )}

      {/* Live stream placeholder */}
      {agent.status === 'running' && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color="yellow">── Live Stream ──</Text>
          <Text dimColor> [10:42] Reading src/routes/auth.ts</Text>
          <Text dimColor> [10:44] Writing src/routes/auth.ts</Text>
          <Text dimColor> [10:46] Running: npm run build</Text>
          <Text dimColor> [10:47] Running: npm test</Text>
          <Text dimColor> [10:48] Editing src/middleware/auth.ts</Text>
          <Text color="yellow"> [10:49] ... still working</Text>
        </Box>
      )}

      {/* Result */}
      {agent.result && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color="cyan">── Result ──</Text>
          <Text color={agent.result.approved === true ? 'green' : agent.result.approved === false ? 'red' : 'cyan'}>
            {agent.result.status}: {agent.result.summary}
          </Text>

          {agent.result.filesCreated && agent.result.filesCreated.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <Text bold>Files created:</Text>
              {agent.result.filesCreated.map(f => (
                <Text key={f} color="green">  + {f}</Text>
              ))}
            </Box>
          )}

          {agent.result.filesModified && agent.result.filesModified.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <Text bold>Files modified:</Text>
              {agent.result.filesModified.map(f => (
                <Text key={f} color="yellow">  ~ {f}</Text>
              ))}
            </Box>
          )}

          {agent.result.commits && agent.result.commits.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <Text bold>Commits:</Text>
              {agent.result.commits.map(c => (
                <Text key={c}>  ▪ {c}</Text>
              ))}
            </Box>
          )}

          {agent.result.findings && agent.result.findings.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <Text bold>Findings:</Text>
              {agent.result.findings.map((f, i) => (
                <Box key={i} flexDirection="column">
                  <Text color={f.severity === 'critical' || f.severity === 'warning' ? 'red' : f.severity === 'suggestion' ? 'yellow' : 'blue'}>
                    {'  '}[{f.severity}] {f.description}
                  </Text>
                  {f.suggestion && <Text dimColor>{'    '}Suggestion: {f.suggestion}</Text>}
                  {f.file && <Text dimColor>{'    '}File: {f.file}</Text>}
                </Box>
              ))}
            </Box>
          )}

          {agent.result.issues && agent.result.issues.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <Text bold>Issues:</Text>
              {agent.result.issues.map((issue, i) => (
                <Text key={i} color="red">  • {issue}</Text>
              ))}
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.substring(0, maxLen - 3) + '...';
}
