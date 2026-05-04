import React from 'react';
import { Box, Text } from 'ink';
import type { AgentRun } from '../types.js';
import { getElapsed } from '../utils.js';

export function AgentDetail({ agent, expanded, onBack, maxRows }: {
  agent: AgentRun;
  expanded: boolean;
  onBack: () => void;
  /** Max terminal rows available (expanded view only) */
  maxRows?: number;
}) {
  if (expanded) {
    return <AgentDetailExpanded agent={agent} onBack={onBack} maxRows={maxRows ?? 20} />;
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

      {agent.result && (
        <Box flexDirection="column">
          <Text dimColor>Result:</Text>
          <Text color={agent.result.approved === true ? 'green' : agent.result.approved === false ? 'red' : 'cyan'}>
            {agent.result.summary}
          </Text>
        </Box>
      )}
    </Box>
  );
}

function AgentDetailExpanded({ agent, onBack, maxRows }: { agent: AgentRun; onBack: () => void; maxRows: number }) {
  const elapsed = getElapsed(agent.startedAt, agent.completedAt ?? undefined);
  const statusIcon = agent.status === 'done' ? '✓' : agent.status === 'running' ? '⟳' : agent.status === 'failed' ? '✗' : '⏳';
  const statusColor = agent.status === 'done' ? 'green' : agent.status === 'running' ? 'yellow' : agent.status === 'failed' ? 'red' : 'gray';

  // Truncate instructions to fit within maxRows
  // Reserve: header(1) + meta(4) + instructions_label(1) = 6 rows minimum
  const maxInstructionLines = Math.max(maxRows - 6, 3);
  const instructionLines = agent.instructions.split('\n');
  const truncatedInstructions = instructionLines.length > maxInstructionLines
    ? instructionLines.slice(0, maxInstructionLines).join('\n') + '…'
    : agent.instructions;

  return (
    <Box flexDirection="column">
      {/* Header bar */}
      <Box borderStyle="single" borderColor="cyan" paddingX={1}>
        <Text bold color="cyan">← Esc</Text>
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
        <Text color={statusColor}>{statusIcon} {agent.status}</Text>
      </Box>

      {/* Meta */}
      <Box flexDirection="column" paddingX={1} marginTop={1}>
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
      <Box flexDirection="column" paddingX={1}>
        <Text bold color="cyan">Instructions:</Text>
        <Text wrap="wrap">{truncatedInstructions}</Text>
      </Box>

      {/* Result (compact) */}
      {agent.result && (
        <Box flexDirection="column" paddingX={1}>
          <Text bold color="cyan">── Result ──</Text>
          <Text color={agent.result.approved === true ? 'green' : agent.result.approved === false ? 'red' : 'cyan'}>
            {agent.result.status}: {agent.result.summary}
          </Text>

          {agent.result.filesCreated && agent.result.filesCreated.length > 0 && (
            <Box flexDirection="column">
              <Text bold>Files created:</Text>
              {agent.result.filesCreated.map(f => (
                <Text key={f} color="green">  + {f}</Text>
              ))}
            </Box>
          )}

          {agent.result.filesModified && agent.result.filesModified.length > 0 && (
            <Box flexDirection="column">
              <Text bold>Files modified:</Text>
              {agent.result.filesModified.map(f => (
                <Text key={f} color="yellow">  ~ {f}</Text>
              ))}
            </Box>
          )}

          {agent.result.findings && agent.result.findings.length > 0 && (
            <Box flexDirection="column">
              <Text bold>Findings:</Text>
              {agent.result.findings.map((f, i) => (
                <FindingRow key={i} finding={f} />
              ))}
            </Box>
          )}

          {agent.result.issues && agent.result.issues.length > 0 && (
            <Box flexDirection="column">
              <Text bold>Issues:</Text>
              {agent.result.issues.map((issue, i) => (
                <Text key={i} color="red">  • {String(issue)}</Text>
              ))}
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
}

function FindingRow({ finding }: { finding: Record<string, unknown> }) {
  const severity = typeof finding.severity === 'string' ? finding.severity : 'info';
  const description = typeof finding.description === 'string' ? finding.description
    : typeof finding.message === 'string' ? finding.message
    : JSON.stringify(finding);

  const severityColor = ['critical', 'bug', 'regression'].includes(severity) ? 'red'
    : ['warning', 'ux_issue'].includes(severity) ? 'yellow'
    : 'blue';

  const file = typeof finding.file === 'string' ? finding.file : undefined;
  const line = typeof finding.line === 'number' ? finding.line : undefined;
  const location = file ? ` (${file}${line ? `:${line}` : ''})` : '';

  const suggestion = typeof finding.suggestion === 'string' ? finding.suggestion
    : typeof finding.remediation === 'string' ? finding.remediation
    : undefined;

  return (
    <Box flexDirection="column">
      <Text color={severityColor}>
        {'  '}[{severity}]{location} {description}
      </Text>
      {suggestion && <Text dimColor>{'    '}→ {suggestion}</Text>}
    </Box>
  );
}
