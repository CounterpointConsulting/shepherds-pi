import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { resolveConfigPath } from '../config/resolve-config.js';
import { loadConfig, getGitToken } from '../config/index.js';
import { loadPersonas } from '../persona/index.js';

export interface DoctorCommandOptions {
  configPath?: string;
}

type CheckStatus = 'pass' | 'fail' | 'warn';

interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
}

export async function runDoctorCommand(options: DoctorCommandOptions): Promise<number> {
  const results: CheckResult[] = [];

  // Node version
  const nodeMajor = parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  if (nodeMajor >= 20) {
    results.push({ name: 'Node.js version', status: 'pass', detail: `v${process.versions.node}` });
  } else {
    results.push({
      name: 'Node.js version',
      status: 'fail',
      detail: `v${process.versions.node}`,
      fix: 'Install Node.js 20+ and rerun doctor.',
    });
  }

  // Docker daemon
  const dockerInfo = run('docker', ['info']);
  if (dockerInfo.ok) {
    results.push({ name: 'Docker daemon', status: 'pass', detail: 'Docker is reachable' });
  } else {
    results.push({
      name: 'Docker daemon',
      status: 'fail',
      detail: dockerInfo.stderr || dockerInfo.error || 'docker info failed',
      fix: 'Start Docker Desktop (or Docker Engine) and ensure `docker` is on PATH.',
    });
  }

  // Git repo
  const gitRepo = run('git', ['rev-parse', '--is-inside-work-tree']);
  if (gitRepo.ok && gitRepo.stdout.trim() === 'true') {
    results.push({ name: 'Git repository', status: 'pass', detail: 'Current directory is a git repo' });
  } else {
    results.push({
      name: 'Git repository',
      status: 'fail',
      detail: 'Current directory is not inside a git work tree',
      fix: 'Run inside your project repo (or run `git init`).',
    });
  }

  let configPath: string | null = null;
  let config: ReturnType<typeof loadConfig> | null = null;

  try {
    configPath = resolveConfigPath({ configPath: options.configPath });
    results.push({ name: 'Configuration file', status: 'pass', detail: configPath });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    results.push({
      name: 'Configuration file',
      status: 'fail',
      detail: msg,
      fix: 'Run `shepherds-pi init` in your project root (or use --config).',
    });
  }

  if (configPath) {
    try {
      config = loadConfig(configPath);
      results.push({ name: 'Config parse', status: 'pass', detail: 'shepherds-pi.yaml parsed successfully' });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({
        name: 'Config parse',
        status: 'fail',
        detail: msg,
        fix: 'Fix shepherds-pi.yaml syntax and required fields.',
      });
    }
  }

  if (config) {
    const personas = loadPersonas(config.personasDir);
    if (personas.size > 0) {
      results.push({
        name: 'Personas directory',
        status: 'pass',
        detail: `${config.personasDir} (${personas.size} personas)`,
      });
    } else {
      results.push({
        name: 'Personas directory',
        status: 'fail',
        detail: `${config.personasDir} (no personas found)`,
        fix: 'Run `shepherds-pi init` (or set personas_dir to a valid directory).',
      });
    }

    if (config.openrouter.apiKey) {
      results.push({ name: 'OpenRouter key', status: 'pass', detail: 'Resolved from env/.env/pi auth' });
    } else {
      results.push({
        name: 'OpenRouter key',
        status: 'fail',
        detail: 'OPENROUTER_API_KEY not resolved',
        fix: 'Set OPENROUTER_API_KEY in .env/environment or run `pi --login openrouter`.',
      });
    }

    const needsGitToken = config.git.repoMode === 'clone' || config.git.gitOpsMode === 'container';
    if (needsGitToken) {
      const gitToken = await getGitToken(config.agent.gitTokenEnv);
      if (gitToken) {
        results.push({
          name: 'Git token',
          status: 'pass',
          detail: `Resolved (${config.agent.gitTokenEnv} or git credential manager)`,
        });
      } else {
        results.push({
          name: 'Git token',
          status: 'fail',
          detail: `Missing (${config.agent.gitTokenEnv})`,
          fix: `Set ${config.agent.gitTokenEnv} in .env/environment or configure git credential manager.`,
        });
      }
    } else {
      results.push({
        name: 'Git token',
        status: 'warn',
        detail: 'Not required in worktree+host git mode',
      });
    }

    const imageInspect = run('docker', ['image', 'inspect', config.docker.image]);
    if (imageInspect.ok) {
      results.push({ name: 'Agent image', status: 'pass', detail: `Found ${config.docker.image}` });
    } else {
      results.push({
        name: 'Agent image',
        status: 'warn',
        detail: `Not found locally: ${config.docker.image}`,
        fix: 'Run `shepherds-pi setup` to pull/build the image.',
      });
    }

    // Beads work-graph (optional; required only when enabled)
    if (config.beads.enabled) {
      const version = run(config.beads.binary, ['version']);
      if (version.ok) {
        const detail = (version.stdout || version.stderr).trim().split('\n')[0] ?? 'bd available';
        results.push({ name: 'Beads CLI', status: 'pass', detail });
      } else {
        results.push({
          name: 'Beads CLI',
          status: 'fail',
          detail: version.stderr || version.error || 'bd not found',
          fix: `Install beads (https://github.com/gastownhall/beads) and ensure \`${config.beads.binary}\` is on PATH, or set beads.binary.`,
        });
      }

      const beadsDir = path.join(config.beads.repoPath, '.beads');
      if (fs.existsSync(beadsDir)) {
        results.push({ name: 'Beads database', status: 'pass', detail: beadsDir });
      } else {
        results.push({
          name: 'Beads database',
          status: 'fail',
          detail: `Missing ${beadsDir}`,
          fix: `Run \`cd "${config.beads.repoPath}" && bd init\` (optionally --stealth), or set beads.enabled: false.`,
        });
      }
    } else {
      results.push({
        name: 'Beads work graph',
        status: 'warn',
        detail: 'Disabled (beads.enabled: false) — using free-form plan tools',
      });
    }
  }

  printResults(results);

  const failCount = results.filter(r => r.status === 'fail').length;
  return failCount > 0 ? 1 : 0;
}

function run(command: string, args: string[]): {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
} {
  const result = spawnSync(command, args, {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return {
    ok: result.status === 0,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error?.message,
  };
}

function printResults(results: CheckResult[]): void {
  console.log('Shepherds Pi doctor\n');

  for (const result of results) {
    const symbol = result.status === 'pass'
      ? '✅'
      : result.status === 'warn'
        ? '⚠️ '
        : '❌';

    console.log(`${symbol} ${result.name}: ${result.detail}`);
    if (result.fix) {
      console.log(`   Fix: ${result.fix}`);
    }
  }

  const passCount = results.filter(r => r.status === 'pass').length;
  const warnCount = results.filter(r => r.status === 'warn').length;
  const failCount = results.filter(r => r.status === 'fail').length;

  console.log(`\nSummary: ${passCount} passed, ${warnCount} warnings, ${failCount} failed`);
}
