#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { App } from './App.js';
import { loadConfig } from './config/index.js';
import path from 'node:path';

// Find config — walk up from CWD or use project root
const configPath = findConfigPath();
const config = loadConfig(configPath);

render(React.createElement(App, { config }));

function findConfigPath(): string {
  // Try CWD first
  const cwd = process.cwd();
  const cwdConfig = path.join(cwd, 'shepherds-pi.yaml');
  try {
    require('fs').accessSync(cwdConfig);
    return cwdConfig;
  } catch { /* not found */ }

  // Fall back to the directory where this script lives (dev mode)
  const scriptDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const scriptConfig = path.join(scriptDir, 'shepherds-pi.yaml');
  try {
    require('fs').accessSync(scriptConfig);
    return scriptConfig;
  } catch { /* not found */ }

  // Last resort: just use CWD
  return cwdConfig;
}
