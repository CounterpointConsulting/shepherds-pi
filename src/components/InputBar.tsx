import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';

export function InputBar({ value, onChange, onSubmit, askUserActive, focusZone }: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  askUserActive: boolean;
  focusZone: 'chat' | 'agents';
}) {
  const [internalValue, setInternalValue] = useState('');

  useInput((input, key) => {
    // Only capture input when chat zone is focused
    // (agent zone uses arrows/enter for navigation)
    if (focusZone !== 'chat') return;

    if (key.return) {
      if (internalValue.trim()) {
        onSubmit(internalValue);
        setInternalValue('');
      }
      return;
    }

    if (key.backspace || key.delete) {
      setInternalValue(prev => prev.slice(0, -1));
      return;
    }

    // Ignore control characters
    if (input && !key.ctrl && !key.meta) {
      setInternalValue(prev => prev + input);
    }
  });

  const borderColor = askUserActive ? 'yellow' : 'gray';
  const borderStyle = askUserActive ? 'bold' : 'single';
  const prompt = askUserActive ? '? Coordinator is waiting...' : 'PI';

  return (
    <Box borderStyle={borderStyle} borderColor={borderColor} paddingX={1}>
      <Text color={askUserActive ? 'yellow' : 'cyan'} bold={askUserActive}>
        {prompt}{' '}
      </Text>
      <Text>
        {internalValue}
        <Text dimColor>|</Text>
      </Text>
      {internalValue.length === 0 && (
        <Text dimColor>Type a message... (Enter to send)</Text>
      )}
    </Box>
  );
}
