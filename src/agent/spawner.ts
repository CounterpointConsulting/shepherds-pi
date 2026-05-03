import Docker from 'dockerode';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import type { PersonaConfig } from '../persona/index.js';
import type { ShepherdsPiConfig } from '../config/index.js';
import { getModuleDir } from '../utils.js';

export interface SpawnOptions {
  agentId: string;
  persona: PersonaConfig;
  instructions: string;
  context?: string;
  branch?: string;
  gitUrl: string;
  gitToken: string;
  config: ShepherdsPiConfig;
  /** Called with parsed JSON events from the agent's pi stdout */
  onEvent?: (event: Record<string, unknown>) => void;
  /** Called with raw stdout lines */
  onStdout?: (line: string) => void;
}

export interface SpawnResult {
  exitCode: number;
  result: AgentResultJson | null;
  events: Record<string, unknown>[];
}

export interface AgentResultJson {
  status: string;
  summary: string;
  [key: string]: unknown;
}

/**
 * Spawn a Docker container running pi with the given persona and instructions.
 * Returns when the container exits.
 */
export async function spawnAgent(opts: SpawnOptions): Promise<SpawnResult> {
  const docker = new Docker();

  // Create temp dirs for instructions, context, and output
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shepherds-pi-agent-'));
  const instructionsFile = path.join(tmpDir, 'instructions.txt');
  const contextFile = path.join(tmpDir, 'context.txt');
  const outputDir = path.join(tmpDir, 'output');

  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(instructionsFile, opts.instructions, 'utf-8');
  fs.writeFileSync(contextFile, opts.context ?? '', 'utf-8');

  // Build environment variables
  const env: string[] = [
    `GIT_URL=${opts.gitUrl}`,
    `GIT_TOKEN=${opts.gitToken}`,
    `BRANCH_NAME=${opts.branch ?? opts.config.project.devBranch}`,
    `PERSONA_DIR=/persona`,
    `INSTRUCTIONS_FILE=/tmp/instructions.txt`,
    `CONTEXT_FILE=/tmp/context.txt`,
    `MODEL=${opts.persona.model}`,
    `OPENROUTER_API_KEY=${opts.config.openrouter.apiKey}`,
  ];

  // Build volume mounts
  const binds = [
    `${opts.persona.dir}:/persona:ro`,
    `${instructionsFile}:/tmp/instructions.txt:ro`,
    `${contextFile}:/tmp/context.txt:ro`,
    `${outputDir}:/output`,
  ];

  // Container name
  const containerName = `shepherds-pi-${opts.agentId}`;

  console.log(`Creating container: ${containerName}`);
  console.log(`  Image:   ${opts.config.docker.image}`);
  console.log(`  Model:   ${opts.persona.model}`);
  console.log(`  Branch:  ${opts.branch ?? opts.config.project.devBranch}`);

  // Create and start container
  const container = await docker.createContainer({
    Image: opts.config.docker.image,
    name: containerName,
    Env: env,
    HostConfig: {
      Binds: binds,
      // Give the container a reasonable amount of memory
      Memory: 2 * 1024 * 1024 * 1024, // 2GB
    },
    Tty: false,
    OpenStdin: false,
    StdinOnce: false,
  });

  const containerId = container.id;
  console.log(`  Container: ${containerId.substring(0, 12)}`);

  await container.start();

  // Stream stdout/stderr using dockerode's demuxStream
  const events: Record<string, unknown>[] = [];

  const logStream = await container.logs({
    stdout: true,
    stderr: true,
    follow: true,
  });

  // Create PassThrough streams for demuxed stdout/stderr
  const { PassThrough } = await import('node:stream');
  const stdoutStream = new PassThrough();
  const stderrStream = new PassThrough();

  // Demux the Docker multiplexed stream
  docker.modem.demuxStream(logStream, stdoutStream, stderrStream);

  // Process stdout (JSON events from pi --mode json)
  const stdoutLines: string[] = [];
  await new Promise<void>((resolve, reject) => {
    let stdoutBuffer = '';

    stdoutStream.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf-8');
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        stdoutLines.push(trimmed);
        opts.onStdout?.(trimmed);

        try {
          const event = JSON.parse(trimmed);
          events.push(event);
          opts.onEvent?.(event);
        } catch {
          // Not JSON — plain log line from entrypoint, skip
        }
      }
    });

    // Also capture stderr for debugging
    let stderrBuffer = '';
    stderrStream.on('data', (chunk: Buffer) => {
      stderrBuffer += chunk.toString('utf-8');
      const lines = stderrBuffer.split('\n');
      stderrBuffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) {
          console.log(`  [stderr] ${trimmed}`);
        }
      }
    });

    logStream.on('end', resolve);
    logStream.on('error', reject);
  });

  // Wait for container to finish and get exit code
  const waitResult = await container.wait();
  const exitCode = (waitResult as unknown as { StatusCode: number }).StatusCode;
  console.log(`Container exited with code: ${exitCode}`);

  // Read result.json from the mounted output dir
  let agentResult: AgentResultJson | null = null;
  const resultPath = path.join(outputDir, 'result.json');
  if (fs.existsSync(resultPath)) {
    try {
      const raw = fs.readFileSync(resultPath, 'utf-8');
      agentResult = JSON.parse(sanitizeJson(raw)) as AgentResultJson;
      console.log(`Agent result: ${agentResult.status} — ${agentResult.summary}`);
    } catch (err) {
      console.log(`Warning: result.json exists but is not valid JSON: ${err}`);
    }
  } else {
    console.log('Warning: No result.json produced by agent');
  }

  // Also check events.jsonl for debugging
  const eventsPath = path.join(outputDir, 'events.jsonl');
  if (fs.existsSync(eventsPath)) {
    console.log(`Events log: ${eventsPath} (${Math.round(fs.statSync(eventsPath).size / 1024)}KB)`);
  }

  // Cleanup: remove container
  try {
    await container.remove({ force: true });
  } catch {
    // Container already removed or error
  }

  // Cleanup: remove temp dir
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // Temp dir cleanup failed, non-critical
  }

  return {
    exitCode,
    result: agentResult,
    events,
  };
}

/**
 * Build the Docker image from the project's Dockerfile.
 */
export async function buildDockerImage(imageName?: string): Promise<void> {
  const docker = new Docker();
  const name = imageName ?? 'shepherds-pi-agent:latest';
  // Resolve docker directory relative to this source file
  const thisDir = getModuleDir(import.meta.url);
  const dockerfilePath = path.resolve(thisDir, '../../docker');

  console.log(`Building Docker image: ${name} from ${dockerfilePath}...`);

  const stream = await docker.buildImage(
    { context: dockerfilePath, src: ['Dockerfile', 'entrypoint.sh'] },
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

  console.log(`\n✅ Image built: ${name}`);
}

/**
 * Check if the Docker image exists locally, build if not.
 */
export async function ensureImage(imageName?: string): Promise<void> {
  const name = imageName ?? 'shepherds-pi-agent:latest';
  const docker = new Docker();

  try {
    await docker.getImage(name).inspect();
    console.log(`Image already exists: ${name}`);
  } catch {
    console.log(`Image not found: ${name}`);
    await buildDockerImage(name);
  }
}

/**
 * Sanitize JSON string by escaping control characters inside string values.
 * LLMs often write result.json with literal newlines/tabs inside strings
 * instead of \n/\t, which makes JSON.parse fail.
 */
function sanitizeJson(raw: string): string {
  // Replace control characters (0x00-0x1F) with their escaped equivalents,
  // but only inside JSON string values (between quotes).
  // Outside of strings, these characters are already invalid JSON.
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
        // Escape control characters
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
