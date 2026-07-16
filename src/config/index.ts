import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

export interface ProjectConfig {
  name: string;
  repoPath: string;
  devBranch: string;
  mainBranch: string;
}

export interface DockerConfig {
  image: string;
  workingDir: string;
}

export interface OpenRouterConfig {
  apiKey: string;
}

export interface CoordinatorConfig {
  model: string;
  thinkingLevel: string;
}

export interface AgentConfig {
  timeoutMinutes: number;
  maxRetries: number;
  gitTokenEnv: string;
}

export type RepoMode = 'clone' | 'worktree';
export type GitOpsMode = 'container' | 'host';

export interface GitConfig {
  repoMode: RepoMode;
  gitOpsMode: GitOpsMode;
  worktreesDir: string;
  authorName: string;
  authorEmail: string;
  resetWorktreeBeforeRun: boolean;
  /** Max time (ms) to wait for a busy branch lease before failing the spawn. */
  leaseWaitTimeoutMs: number;
  /** Poll interval (ms) while waiting for a busy branch lease to free up. */
  leaseWaitPollMs: number;
  /** Per-step timeout (ms) for long-running git ops during worktree acquire. */
  acquireStepTimeoutMs: number;
}

export interface BeadsConfig {
  /** When true, coordinator uses Beads as the work-graph plan of record. */
  enabled: boolean;
  /** `bd` binary name or absolute path. */
  binary: string;
  /** Directory containing `.beads/` (default project.repoPath). */
  repoPath: string;
  /** Reject spawn_agent without beadId when enabled. */
  requireBeadOnSpawn: boolean;
  /** Max implement dispatches before stuck detection. */
  stuckDispatchLimit: number;
  /** Audit actor passed to bd --actor. */
  actor: string;
}

export interface ShepherdsPiConfig {
  version: number;
  project: ProjectConfig;
  docker: DockerConfig;
  openrouter: OpenRouterConfig;
  coordinator: CoordinatorConfig;
  personasDir: string;
  agent: AgentConfig;
  git: GitConfig;
  beads: BeadsConfig;
}

/**
 * Load .env file from config directory into process.env.
 * Lines with KEY=VALUE format. Comments (#) and blank lines ignored.
 */
function loadEnvFile(configDir: string): void {
  const envPath = path.join(configDir, '.env');
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;

    const key = trimmed.substring(0, eqIndex).trim();
    let value = trimmed.substring(eqIndex + 1).trim();

    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    // Don't overwrite existing env vars
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

export function loadConfig(configPath: string): ShepherdsPiConfig {
  const raw = fs.readFileSync(configPath, 'utf-8');
  const parsed = yaml.load(raw) as Record<string, unknown>;

  const project = parsed.project as Record<string, unknown> ?? {};
  const docker = parsed.docker as Record<string, unknown> ?? {};
  const openrouter = parsed.openrouter as Record<string, unknown> ?? {};
  const coordinator = parsed.coordinator as Record<string, unknown> ?? {};
  const agent = parsed.agent as Record<string, unknown> ?? {};
  const git = parsed.git as Record<string, unknown> ?? {};
  const beads = parsed.beads as Record<string, unknown> ?? {};

  const configDir = path.dirname(path.resolve(configPath));

  // Load .env file from project root (before resolving any env vars)
  loadEnvFile(configDir);

  // Resolve env vars in API key
  let apiKey = resolveEnvVars(openrouter.api_key as string ?? '');

  // If still empty, try environment directly
  if (!apiKey) {
    apiKey = process.env.OPENROUTER_API_KEY ?? '';
  }

  // If still empty, try reading from pi's auth storage
  if (!apiKey) {
    try {
      const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? '';
      const authPath = path.join(homeDir, '.pi', 'agent', 'auth.json');
      const authData = JSON.parse(fs.readFileSync(authPath, 'utf-8'));
      apiKey = authData?.openrouter?.key ?? '';
    } catch { /* ignore */ }
  }

  return {
    version: (parsed.version as number) ?? 1,
    project: {
      name: (project.name as string) ?? 'unnamed',
      repoPath: path.resolve(configDir, (project.repo_path as string) ?? '.'),
      devBranch: (project.dev_branch as string) ?? 'dev',
      mainBranch: (project.main_branch as string) ?? 'main',
    },
    docker: {
      image: (docker.image as string) ?? 'shepherds-pi-agent:latest',
      workingDir: (docker.working_dir as string) ?? '/workspace/repo',
    },
    openrouter: {
      apiKey,
    },
    coordinator: {
      model: (coordinator.model as string) ?? 'openrouter/anthropic/claude-sonnet-4',
      thinkingLevel: (coordinator.thinking_level as string) ?? 'high',
    },
    personasDir: path.resolve(configDir, (parsed.personas_dir as string) ?? './personas'),
    agent: {
      timeoutMinutes: (agent.timeout_minutes as number) ?? 30,
      maxRetries: (agent.max_retries as number) ?? 1,
      gitTokenEnv: (agent.git_token_env as string) ?? 'GIT_TOKEN',
    },
    git: {
      repoMode: ((git.repo_mode as string) === 'worktree' ? 'worktree' : 'clone'),
      gitOpsMode: ((git.git_ops_mode as string) === 'host' ? 'host' : 'container'),
      worktreesDir: path.resolve(configDir, (git.worktrees_dir as string) ?? './.shepherds-pi/worktrees'),
      authorName: (git.author_name as string) ?? 'Shepherds Pi Agent',
      authorEmail: (git.author_email as string) ?? 'agent@shepherds-pi.dev',
      resetWorktreeBeforeRun: (git.reset_worktree_before_run as boolean) ?? true,
      leaseWaitTimeoutMs: Math.max(0, (git.lease_wait_timeout_seconds as number) ?? 900) * 1000,
      leaseWaitPollMs: Math.max(500, ((git.lease_wait_poll_seconds as number) ?? 3) * 1000),
      acquireStepTimeoutMs: Math.max(1000, ((git.acquire_step_timeout_seconds as number) ?? 90) * 1000),
    },
    beads: {
      enabled: (beads.enabled as boolean) ?? false,
      binary: (beads.binary as string) ?? 'bd',
      repoPath: path.resolve(
        configDir,
        (beads.repo_path as string)
          ?? (project.repo_path as string)
          ?? '.',
      ),
      requireBeadOnSpawn: (beads.require_bead_on_spawn as boolean) ?? true,
      stuckDispatchLimit: (beads.stuck_dispatch_limit as number) ?? 10,
      actor: (beads.actor as string) ?? 'shepherds-coordinator',
    },
  };
}

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{(\w+)\}/g, (_, varName) => {
    return process.env[varName] ?? '';
  });
}

export function findConfig(startDir: string): string | null {
  let dir = path.resolve(startDir);
  while (true) {
    const candidate = path.join(dir, 'shepherds-pi.yaml');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Get git token. Resolution order:
 * 1. Environment variable (or .env file)
 * 2. Git credential manager
 */
export async function getGitToken(envVarName: string = 'GIT_TOKEN'): Promise<string> {
  // Try env var first (already loaded from .env by loadConfig)
  const envToken = process.env[envVarName];
  if (envToken) return envToken;

  // Try git credential manager
  try {
    const { execSync } = await import('node:child_process');
    const credOutput = execSync('git credential fill', {
      input: 'protocol=https\nhost=github.com\n',
      encoding: 'utf-8',
    });
    const passwordMatch = credOutput.match(/password=(.+)/);
    if (passwordMatch) return passwordMatch[1];
  } catch { /* ignore */ }

  return '';
}
