#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { render } from 'ink';
import { App } from './App.js';
import { loadConfig } from './config/index.js';
import { resolveConfigPath } from './config/resolve-config.js';

export interface RunOptions {
  configPath?: string;
}

/**
 * Run the interactive TUI.
 */
export function runTui(options: RunOptions = {}): void {
  if (!process.stdin.isTTY) {
    throw new Error('Shepherds Pi requires an interactive terminal (TTY).');
  }

  const configPath = resolveConfigPath(options);
  const config = loadConfig(configPath);
  render(React.createElement(App, { config }));
}

function isDirectExecution(metaUrl: string): boolean {
  if (!process.argv[1]) return false;
  const currentFile = path.resolve(fileURLToPath(metaUrl));
  const entryFile = path.resolve(process.argv[1]);
  return currentFile === entryFile;
}

function main(): void {
  runTui();
}

if (isDirectExecution(import.meta.url)) {
  main();
}
