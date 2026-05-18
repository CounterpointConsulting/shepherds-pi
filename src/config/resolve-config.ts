import fs from 'node:fs';
import path from 'node:path';
import { findConfig } from './index.js';

export interface ResolveConfigOptions {
  configPath?: string;
}

/**
 * Resolve Shepherds Pi config path.
 * Priority:
 * 1. explicit path argument
 * 2. SHEPHERDS_PI_CONFIG env var
 * 3. walk upward from CWD (findConfig)
 */
export function resolveConfigPath(options: ResolveConfigOptions = {}): string {
  if (options.configPath) {
    const resolved = path.resolve(options.configPath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Config not found: ${resolved}`);
    }
    return resolved;
  }

  const envPath = process.env.SHEPHERDS_PI_CONFIG;
  if (envPath) {
    const resolved = path.resolve(envPath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Config from SHEPHERDS_PI_CONFIG not found: ${resolved}`);
    }
    return resolved;
  }

  const discovered = findConfig(process.cwd());
  if (discovered) return discovered;

  throw new Error(
    `No shepherds-pi.yaml found from ${process.cwd()} upward. Run "shepherds-pi init" in your project root.`
  );
}
