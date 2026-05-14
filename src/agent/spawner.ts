import Docker from 'dockerode';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import type { PersonaConfig } from '../persona/index.js';
import type { ShepherdsPiConfig, RepoMode, GitOpsMode } from '../config/index.js';
import { getModuleDir } from '../utils.js';
import { generateFunnyContainerName } from './container-name.js';

export interface SpawnOptions {
  agentId: string;
  persona: PersonaConfig;
  instructions: string;
  context?: string;
  branch?: string;
  repoMode: RepoMode;
  gitOpsMode: GitOpsMode;
  worktreePath?: string;
  gitUrl?: string;
  gitToken?: string;
  config: ShepherdsPiConfig;
  /** Abort signal to cancel the agent mid-run (also triggers container.kill) */
  signal?: AbortSignal;
  /** Called with parsed JSON events from the agent's pi stdout */
  onEvent?: (event: Record<string, unknown>) => void;
  /** Called with raw stdout lines */
  onStdout?: (line: string) => void;
}

export interface SpawnResult {
  exitCode: number;
  result: AgentResultJson | null;
  events: Record<string, unknown>[];
  timedOut: boolean;
  containerName: string;
}

export interface AgentResultJson {
  status: string;
  summary: string;
  [key: string]: unknown;
}

/**
 * Spawn a Docker container running pi with the given persona and instructions.
 * Returns when the container exits.
 *
 * Security posture:
 *   - Runs as non-root uid 1000
 *   - ReadonlyRootfs with explicit writable binds only
 *   - CapDrop: ALL, no-new-privileges
 *   - PidsLimit + NanoCpus + Memory caps
 *   - Secrets (git token, OpenRouter key) delivered via tmpfs-mounted files,
 *     never as container env vars or CLI args (keeps them out of `docker
 *     inspect`, `ps`, and the image layer)
 *   - Timeout enforced: container is killed after config.agent.timeoutMinutes.
 *     The cleanup (timer, abort listener, container.remove, tmpdir delete,
 *     secret-file scrub) runs in a finally block so it still executes if
 *     the log stream or container.wait throws.
 *
 * This function is silent — all status flows through onEvent/onStdout
 * callbacks so the caller (orchestrator) controls how output reaches the
 * user (e.g. via Ink TUI, not console.log).
 */
export async function spawnAgent(opts: SpawnOptions): Promise<SpawnResult> {
  const docker = new Docker();

  const branchName = opts.branch ?? opts.config.project.devBranch;
  const repoModeEnv = opts.repoMode === 'worktree' ? 'mounted' : 'clone';

  if (opts.repoMode === 'clone' && !opts.gitUrl) {
    throw new Error('spawnAgent: gitUrl is required in clone repo mode');
  }

  if (opts.repoMode === 'worktree' && !opts.worktreePath) {
    throw new Error('spawnAgent: worktreePath is required in worktree repo mode');
  }

  // ─── 1. Temp workspace on host ───────────────────────────────
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shepherds-pi-agent-'));
  const instructionsFile = path.join(tmpDir, 'instructions.txt');
  const contextFile = path.join(tmpDir, 'context.txt');
  const outputDir = path.join(tmpDir, 'output');
  const secretsDir = path.join(tmpDir, 'secrets');

  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(instructionsFile, opts.instructions, 'utf-8');
  fs.writeFileSync(contextFile, opts.context ?? '', 'utf-8');

  const gitTokenFile = path.join(secretsDir, 'git_token');
  const openrouterKeyFile = path.join(secretsDir, 'openrouter_key');
  const needsGitToken = opts.repoMode === 'clone' || opts.gitOpsMode === 'container';
  if (needsGitToken) {
    fs.writeFileSync(gitTokenFile, opts.gitToken ?? '', { encoding: 'utf-8', mode: 0o600 });
  }
  fs.writeFileSync(openrouterKeyFile, opts.config.openrouter.apiKey, { encoding: 'utf-8', mode: 0o600 });

  try { fs.chmodSync(outputDir, 0o777); } catch { /* best effort */ }

  const sharedUsingAgentSkillsDir = path.join(opts.config.personasDir, 'using-agent-skills');
  const hasSharedUsingAgentSkills = fs.existsSync(path.join(sharedUsingAgentSkillsDir, 'SKILL.md'));

  // ─── 2. Container env (NO secrets here) ──────────────────────
  const env: string[] = [
    `REPO_MODE=${repoModeEnv}`,
    `GIT_OPS_MODE=${opts.gitOpsMode}`,
    `GIT_URL=${opts.gitUrl ?? ''}`,
    `BRANCH_NAME=${branchName}`,
    `PERSONA_DIR=/persona`,
    `INSTRUCTIONS_FILE=/tmp/instructions.txt`,
    `CONTEXT_FILE=/tmp/context.txt`,
    `MODEL=${opts.persona.model}`,
  ];

  // ─── 3. Bind mounts ──────────────────────────────────────────
  const binds = [
    `${opts.persona.dir}:/persona:ro`,
    `${instructionsFile}:/tmp/instructions.txt:ro`,
    `${contextFile}:/tmp/context.txt:ro`,
    `${outputDir}:/output`,
    `${secretsDir}:/run/secrets:ro`,
  ];

  if (opts.repoMode === 'worktree' && opts.worktreePath) {
    binds.push(`${opts.worktreePath}:/workspace/repo`);
  }

  if (hasSharedUsingAgentSkills) {
    binds.push(`${sharedUsingAgentSkillsDir}:/shared-skills/using-agent-skills:ro`);
  }

  // ─── 4. Container config ─────────────────────────────────────
  const timeoutMs = opts.config.agent.timeoutMinutes * 60 * 1000;
  const maxNameAttempts = 12;

  const containerCreateBase = {
    Image: opts.config.docker.image,
    Env: env,
    User: '1000:1000',
    HostConfig: {
      Binds: binds,
      Memory: 2 * 1024 * 1024 * 1024,
      NanoCpus: 2_000_000_000,
      PidsLimit: 512,
      ReadonlyRootfs: true,
      SecurityOpt: ['no-new-privileges:true'],
      CapDrop: ['ALL'],
      Tmpfs: {
        '/workspace': 'rw,nosuid,size=4g,mode=1777',
        '/tmp': 'rw,noexec,nosuid,size=256m,mode=1777',
        '/home/node/.pi': 'rw,noexec,nosuid,size=64m,mode=1777',
      },
    },
    Tty: false,
    OpenStdin: false,
    StdinOnce: false,
  };

  let containerName = '';
  let container: Docker.Container | null = null;

  for (let attempt = 1; attempt <= maxNameAttempts; attempt++) {
    containerName = generateFunnyContainerName();

    try {
      container = await docker.createContainer({
        ...containerCreateBase,
        name: containerName,
      });
      break;
    } catch (err: unknown) {
      if (isContainerNameConflict(err) && attempt < maxNameAttempts) {
        continue;
      }
      throw err;
    }
  }

  if (!container) {
    throw new Error(`spawnAgent: could not generate a unique container name after ${maxNameAttempts} attempts`);
  }

  await container.start();
  opts.onEvent?.({ type: 'container_started', containerName });

  // ─── 5. Timeout + abort enforcement ──────────────────────────
  // Kill the container after timeoutMinutes. Also honor an external
  // AbortSignal so the caller (TUI) can cancel manually.
  // The try/finally below guarantees these handlers are cleaned up
  // even if the log stream or container.wait throws.
  let timedOut = false;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    container.kill({ signal: 'SIGKILL' }).catch(() => { /* best effort */ });
  }, timeoutMs);

  const abortHandler = () => {
    container.kill({ signal: 'SIGKILL' }).catch(() => { /* best effort */ });
  };
  opts.signal?.addEventListener('abort', abortHandler, { once: true });

  const events: Record<string, unknown>[] = [];
  let exitCode = -1;
  let agentResult: AgentResultJson | null = null;

  try {
    // ─── 6. Stream stdout/stderr ───────────────────────────────
    const logStream = await container.logs({
      stdout: true,
      stderr: true,
      follow: true,
    });

    const { PassThrough } = await import('node:stream');
    const stdoutStream = new PassThrough();
    const stderrStream = new PassThrough();
    docker.modem.demuxStream(logStream, stdoutStream, stderrStream);

    await new Promise<void>((resolve, reject) => {
      let stdoutBuffer = '';
      stdoutStream.on('data', (chunk: Buffer) => {
        stdoutBuffer += chunk.toString('utf-8');
        const lines = stdoutBuffer.split('\n');
        stdoutBuffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          opts.onStdout?.(trimmed);
          try {
            const event = JSON.parse(trimmed);
            events.push(event);
            opts.onEvent?.(event);
          } catch {
            // Not JSON — plain log line from entrypoint, ignore
          }
        }
      });

      let stderrBuffer = '';
      stderrStream.on('data', (chunk: Buffer) => {
        stderrBuffer += chunk.toString('utf-8');
        const lines = stderrBuffer.split('\n');
        stderrBuffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed) {
            opts.onEvent?.({ type: 'container_stderr', line: trimmed });
          }
        }
      });

      logStream.on('end', resolve);
      logStream.on('error', reject);
    });

    // ─── 7. Wait for exit ──────────────────────────────────────
    const waitResult = await container.wait();
    exitCode = (waitResult as unknown as { StatusCode: number }).StatusCode;

    // ─── 8. Read result.json ───────────────────────────────────
    const resultPath = path.join(outputDir, 'result.json');
    if (fs.existsSync(resultPath)) {
      try {
        const raw = fs.readFileSync(resultPath, 'utf-8');
        const parsed = JSON.parse(sanitizeJson(raw)) as unknown;
        agentResult = normalizeResultShape(parsed);
      } catch {
        // Invalid JSON — reported via result being null
      }
    }
  } finally {
    // ─── 9. Cleanup — always runs, even on stream errors or abort ──
    clearTimeout(timeoutHandle);
    opts.signal?.removeEventListener('abort', abortHandler);

    try {
      await container.remove({ force: true });
    } catch { /* ignore */ }

    // Best-effort overwrite of secret files before removing the tmpdir
    // (defence in depth against tmpfs-swap disclosure on old kernels).
    try {
      const zeros = Buffer.alloc(256, 0);
      if (fs.existsSync(gitTokenFile)) fs.writeFileSync(gitTokenFile, zeros);
      if (fs.existsSync(openrouterKeyFile)) fs.writeFileSync(openrouterKeyFile, zeros);
    } catch { /* ignore */ }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  }

  return {
    exitCode,
    result: agentResult,
    events,
    timedOut,
    containerName,
  };
}

/**
 * Build the Docker image from the project's Dockerfile.
 */
export async function buildDockerImage(imageName?: string): Promise<void> {
  const docker = new Docker();
  const name = imageName ?? 'shepherds-pi-agent:latest';
  const thisDir = getModuleDir(import.meta.url);
  const dockerfilePath = path.resolve(thisDir, '../../docker');

  const stream = await docker.buildImage(
    { context: dockerfilePath, src: ['Dockerfile', 'entrypoint.sh', 'git-askpass.sh'] },
    { t: name },
  );

  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(
      stream,
      (err: Error | null) => {
        if (err) reject(err);
        else resolve();
      },
      (event: { stream?: string }) => {
        if (event.stream) process.stdout.write(event.stream);
      },
    );
  });
}

/**
 * Check if the Docker image exists locally, build if not.
 */
export async function ensureImage(imageName?: string): Promise<void> {
  const name = imageName ?? 'shepherds-pi-agent:latest';
  const docker = new Docker();

  try {
    await docker.getImage(name).inspect();
  } catch {
    await buildDockerImage(name);
  }
}

/**
 * Sanitize JSON string by escaping control characters inside string values.
 * LLMs often write result.json with literal newlines/tabs inside strings
 * instead of \n/\t, which makes JSON.parse fail.
 */
function sanitizeJson(raw: string): string {
  let result = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];

    if (escaped) {
      result += ch;
      escaped = false;
      continue;
    }

    if (ch === '\\') {
      result += ch;
      if (inString) escaped = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      result += ch;
      continue;
    }

    if (inString) {
      const code = ch.charCodeAt(0);
      if (code < 0x20) {
        switch (ch) {
          case '\n': result += '\\n'; break;
          case '\r': result += '\\r'; break;
          case '\t': result += '\\t'; break;
          case '\b': result += '\\b'; break;
          case '\f': result += '\\f'; break;
          default: result += `\\u${code.toString(16).padStart(4, '0')}`; break;
        }
        continue;
      }
    }

    result += ch;
  }

  return result;
}

/**
 * Normalize agent result payloads to the app's canonical camelCase schema.
 *
 * Older persona skills used snake_case keys (e.g. files_created), while the
 * TUI and TS types expect camelCase (filesCreated). Normalize on ingest so we
 * remain backward compatible and UI rendering stays consistent.
 */
function normalizeResultShape(value: unknown): AgentResultJson | null {
  if (!isRecord(value)) return null;
  const normalized = normalizeKeysDeep(value);
  return isRecord(normalized) ? (normalized as AgentResultJson) : null;
}

function normalizeKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeKeysDeep);
  }

  if (!isRecord(value)) {
    return value;
  }

  const keyMap: Record<string, string> = {
    files_created: 'filesCreated',
    files_modified: 'filesModified',
    conflicts_resolved: 'conflictsResolved',
    conflicts_remaining: 'conflictsRemaining',
    tests_run: 'testsRun',
    tests_passed: 'testsPassed',
    tests_failed: 'testsFailed',
    steps_to_reproduce: 'stepsToReproduce',
    depends_on: 'dependsOn',
  };

  const out: Record<string, unknown> = {};

  for (const [key, rawVal] of Object.entries(value)) {
    const normalizedKey = keyMap[key] ?? key;
    const normalizedVal = normalizeKeysDeep(rawVal);

    // If both snake_case and camelCase versions exist, keep the first value
    // encountered to avoid overwriting explicit newer fields.
    if (!(normalizedKey in out)) {
      out[normalizedKey] = normalizedVal;
    }
  }

  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isContainerNameConflict(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;

  const statusCode = (err as { statusCode?: unknown }).statusCode;
  if (statusCode === 409) return true;

  const message = (err as { message?: unknown }).message;
  return typeof message === 'string' && message.toLowerCase().includes('name is already in use');
}
