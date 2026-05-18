import { spawnSync } from 'node:child_process';
import { resolveConfigPath } from '../config/resolve-config.js';
import { loadConfig } from '../config/index.js';
import { buildDockerImage } from '../agent/spawner.js';

export interface SetupCommandOptions {
  configPath?: string;
}

export async function runSetupCommand(options: SetupCommandOptions): Promise<number> {
  const configPath = resolveConfigPath({ configPath: options.configPath });
  const config = loadConfig(configPath);
  const image = config.docker.image;

  if (!isDockerAvailable()) {
    console.error('❌ Docker is not available. Start Docker and rerun setup.');
    return 1;
  }

  if (dockerImageExists(image)) {
    console.log(`✅ Agent image already present: ${image}`);
    return 0;
  }

  console.log(`Image not found locally: ${image}`);
  console.log(`Attempting to pull ${image}...`);

  const pullStatus = runInherited('docker', ['pull', image]);
  if (pullStatus === 0 && dockerImageExists(image)) {
    console.log(`✅ Pulled ${image}`);
    return 0;
  }

  console.log('\nPull failed (or image still unavailable). Building image locally...');

  try {
    await buildDockerImage(image);
    console.log(`✅ Built ${image}`);
    return 0;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`❌ Failed to build image: ${msg}`);
    return 1;
  }
}

function isDockerAvailable(): boolean {
  const result = spawnSync('docker', ['info'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  return result.status === 0;
}

function dockerImageExists(image: string): boolean {
  const result = spawnSync('docker', ['image', 'inspect', image], {
    encoding: 'utf-8',
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  return result.status === 0;
}

function runInherited(command: string, args: string[]): number {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  return result.status ?? 1;
}
