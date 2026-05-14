import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { ShepherdsDB } from '../db/index.js';
import { OrchestratorEventBus, type OrchestratorEvent } from '../orchestrator/event-bus.js';
import { createOrchestratorTools } from '../orchestrator/tools.js';
import type { ShepherdsPiConfig } from '../config/index.js';

function run(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, stdio: 'pipe', encoding: 'utf-8' }).trim();
}

function hasDocker(): boolean {
  try {
    execSync('docker info', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function getFirstText(result: unknown): string {
  if (!isRecord(result)) return '';
  const content = result.content;
  if (!Array.isArray(content)) return '';
  const firstText = content.find((c): c is { type: string; text: string } => {
    return isRecord(c) && c.type === 'text' && typeof c.text === 'string';
  });
  return firstText?.text ?? '';
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTool(value: unknown): value is { name: string; execute: (...args: unknown[]) => Promise<unknown> } {
  return isRecord(value) && typeof value.name === 'string' && typeof value.execute === 'function';
}

let toolCallCounter = 0;

async function executeTool(tools: unknown[], name: string, params: Record<string, unknown>): Promise<unknown> {
  const tool = tools.find((t): t is { name: string; execute: (...args: unknown[]) => Promise<unknown> } => {
    return isTool(t) && t.name === name;
  });

  if (!tool) {
    throw new Error(`Tool "${name}" not found`);
  }

  toolCallCounter += 1;
  return tool.execute(
    `tool-call-${toolCallCounter}`,
    params,
    undefined,
    undefined,
    undefined,
  );
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function stopProcess(proc: ChildProcess | null, timeoutMs: number = 3000): Promise<void> {
  if (!proc) return;
  if (proc.exitCode !== null) return;

  await new Promise<void>((resolve) => {
    let settled = false;

    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        // ignore
      }
      done();
    }, timeoutMs);

    proc.once('exit', () => {
      clearTimeout(timer);
      done();
    });

    try {
      proc.kill('SIGTERM');
    } catch {
      clearTimeout(timer);
      done();
    }
  });
}

async function removeDirWithRetries(dirPath: string, attempts: number = 8, waitMs: number = 150): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      fs.rmSync(dirPath, { recursive: true, force: true });
      return;
    } catch {
      if (i === attempts - 1) throw new Error(`Could not remove temp directory after ${attempts} attempts: ${dirPath}`);
      await delay(waitMs);
    }
  }
}

async function getFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Could not determine ephemeral port')));
        return;
      }

      const port = address.port;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

function startGitDaemon(basePath: string, port: number): ChildProcess {
  // NOTE (Windows/git-for-windows): `git daemon` can reject absolute paths
  // in combination with --base-path, printing usage and exiting 129.
  // Starting it from `cwd=basePath` with relative path arguments is reliable.
  return spawn(
    'git',
    [
      'daemon',
      '--reuseaddr',
      '--export-all',
      '--enable=receive-pack',
      '--base-path=.',
      '--log-destination=none',
      `--port=${port}`,
      '.',
    ],
    {
      cwd: basePath,
      stdio: ['ignore', 'ignore', 'ignore'],
    },
  );
}

async function waitForGitDaemon(port: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      run(`git ls-remote git://127.0.0.1:${port}/remote.git`, process.cwd());
      return;
    } catch {
      await delay(125);
    }
  }

  throw new Error(`git daemon did not become ready on port ${port}`);
}

function resolveContainerGitHost(imageName: string, port: number): string | null {
  const candidates = ['host.docker.internal', '172.17.0.1'];

  for (const host of candidates) {
    try {
      execSync(
        `docker run --rm --entrypoint sh ${imageName} -c "git ls-remote git://${host}:${port}/remote.git >/dev/null 2>&1"`,
        { stdio: 'pipe' },
      );
      return host;
    } catch {
      // try next candidate
    }
  }

  return null;
}

async function main(): Promise<void> {
  if (!hasDocker()) {
    console.log('⚠️ Docker is not available/running. Skipping e2e clone+container handoff test.');
    return;
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shepherds-e2e-clone-'));
  const remoteDir = path.join(tmpRoot, 'remote.git');
  const seedDir = path.join(tmpRoot, 'seed');
  const repoDir = path.join(tmpRoot, 'repo');
  const worktreesDir = path.join(tmpRoot, 'worktrees-unused');
  const personasDir = path.join(tmpRoot, 'personas');
  const imageDir = path.join(tmpRoot, 'agent-image');
  const dbPath = path.join(tmpRoot, '.shepherds-pi', 'shepherds.db');
  const imageName = `shepherds-pi-e2e-clone-${Date.now().toString(36)}-${process.pid}`;

  const tokenEnvName = 'GIT_TOKEN_E2E_CLONE';
  const previousGitUrl = process.env.GIT_URL;
  const previousToken = process.env[tokenEnvName];

  let db: ShepherdsDB | null = null;
  let daemon: ChildProcess | null = null;

  try {
    console.log('━━━ E2E: Clone + in-container git handoff cycle ━━━\n');

    // ─── Build deterministic clone-mode image ─────────────────────────
    fs.mkdirSync(imageDir, { recursive: true });
    fs.writeFileSync(path.join(imageDir, 'Dockerfile'), [
      'FROM alpine:3.20',
      'RUN apk add --no-cache git',
      'RUN adduser -D -u 1000 node',
      'COPY entrypoint.sh /entrypoint.sh',
      'RUN chmod +x /entrypoint.sh',
      'ENTRYPOINT ["/entrypoint.sh"]',
      '',
    ].join('\n'), 'utf-8');

    fs.writeFileSync(path.join(imageDir, 'entrypoint.sh'), [
      '#!/bin/sh',
      'set -eu',
      '',
      'if [ "${REPO_MODE:-}" != "clone" ]; then',
      '  echo "Expected REPO_MODE=clone, got ${REPO_MODE:-unset}" >&2',
      '  exit 31',
      'fi',
      '',
      'if [ "${GIT_OPS_MODE:-}" != "container" ]; then',
      '  echo "Expected GIT_OPS_MODE=container, got ${GIT_OPS_MODE:-unset}" >&2',
      '  exit 32',
      'fi',
      '',
      'if [ -z "${GIT_URL:-}" ]; then',
      '  echo "GIT_URL must be set in clone mode" >&2',
      '  exit 33',
      'fi',
      '',
      'if [ ! -s /run/secrets/git_token ]; then',
      '  echo "git_token secret missing/empty in clone mode" >&2',
      '  exit 34',
      'fi',
      '',
      'if [ ! -r /run/secrets/openrouter_key ]; then',
      '  echo "openrouter_key secret is missing" >&2',
      '  exit 35',
      'fi',
      '',
      'BRANCH_NAME="${BRANCH_NAME:-dev}"',
      '',
      'git clone "$GIT_URL" /workspace/repo >/tmp/clone.log 2>&1 || {',
      '  cat /tmp/clone.log >&2',
      '  exit 36',
      '}',
      '',
      'cd /workspace/repo',
      'git fetch origin >/tmp/fetch.log 2>&1 || true',
      '',
      'if git show-ref --verify --quiet "refs/remotes/origin/${BRANCH_NAME}"; then',
      '  git checkout -B "$BRANCH_NAME" "origin/$BRANCH_NAME" >/tmp/checkout.log 2>&1 || { cat /tmp/checkout.log >&2; exit 37; }',
      'else',
      '  git checkout -B "$BRANCH_NAME" "origin/dev" >/tmp/checkout.log 2>&1 || { cat /tmp/checkout.log >&2; exit 38; }',
      'fi',
      '',
      'INSTRUCTIONS=""',
      'if [ -f /tmp/instructions.txt ]; then',
      '  INSTRUCTIONS=$(cat /tmp/instructions.txt)',
      'fi',
      '',
      'if [ "$INSTRUCTIONS" = "FAIL" ]; then',
      '  echo "intentional failure requested" >&2',
      '  exit 39',
      'fi',
      '',
      'echo "$INSTRUCTIONS" >> handoff.txt',
      'git config user.name "Container Agent"',
      'git config user.email "container-agent@example.com"',
      'git add handoff.txt',
      'git commit -m "test: container handoff" >/tmp/commit.log 2>&1 || true',
      '',
      'if ! git push origin "HEAD:$BRANCH_NAME" >/tmp/push.log 2>&1; then',
      '  git fetch origin "$BRANCH_NAME" >/tmp/fetch2.log 2>&1 || true',
      '  if git show-ref --verify --quiet "refs/remotes/origin/${BRANCH_NAME}"; then',
      '    git rebase "origin/$BRANCH_NAME" >/tmp/rebase.log 2>&1 || {',
      '      git rebase --abort >/dev/null 2>&1 || true',
      '      cat /tmp/rebase.log >&2',
      '      cat /tmp/push.log >&2',
      '      exit 40',
      '    }',
      '  fi',
      '',
      '  git push origin "HEAD:$BRANCH_NAME" >/tmp/push2.log 2>&1 || {',
      '    cat /tmp/push2.log >&2',
      '    exit 41',
      '  }',
      'fi',
      '',
      'mkdir -p /output',
      'printf "%s\\n" "{\"status\":\"success\",\"summary\":\"clone-container-ok\",\"commits\":[\"test: container handoff\"]}" > /output/result.json',
      '',
    ].join('\n'), 'utf-8');

    console.log(`Building test image: ${imageName}`);
    run(`docker build -t ${imageName} .`, imageDir);

    // ─── Initialize remote + host repo ────────────────────────────────
    fs.mkdirSync(remoteDir, { recursive: true });
    run('git init --bare', remoteDir);

    fs.mkdirSync(seedDir, { recursive: true });
    run('git init -b main', seedDir);
    run('git config user.name "Test User"', seedDir);
    run('git config user.email "test@example.com"', seedDir);
    fs.writeFileSync(path.join(seedDir, 'README.md'), '# seed\n', 'utf-8');
    run('git add README.md', seedDir);
    run('git commit -m "seed"', seedDir);
    run('git checkout -b dev', seedDir);
    run(`git remote add origin "${remoteDir}"`, seedDir);
    run('git push -u origin main dev', seedDir);

    run(`git clone "${remoteDir}" "${repoDir}"`, tmpRoot);

    // ─── Expose the remote repo via git daemon for container clone/push ──
    const daemonPort = await getFreePort();
    daemon = startGitDaemon(tmpRoot, daemonPort);
    await waitForGitDaemon(daemonPort, 5000);

    const containerHost = resolveContainerGitHost(imageName, daemonPort);
    if (!containerHost) {
      console.log('⚠️ Could not reach host git daemon from a container. Skipping clone-mode E2E test.');
      return;
    }

    const daemonUrl = `git://${containerHost}:${daemonPort}/remote.git`;
    process.env.GIT_URL = daemonUrl;
    process.env[tokenEnvName] = 'e2e-test-token';

    // ─── Create a minimal persona ─────────────────────────────────────
    const personaName = 'test-dev';
    const personaDir = path.join(personasDir, personaName);
    fs.mkdirSync(personaDir, { recursive: true });
    fs.writeFileSync(path.join(personaDir, 'SYSTEM.md'), 'You are a deterministic E2E test agent.', 'utf-8');
    fs.writeFileSync(path.join(personaDir, 'model.txt'), 'openrouter/test-model', 'utf-8');

    // ─── Build config + tools ─────────────────────────────────────────
    const config: ShepherdsPiConfig = {
      version: 1,
      project: {
        name: 'e2e-clone-project',
        repoPath: repoDir,
        devBranch: 'dev',
        mainBranch: 'main',
      },
      docker: {
        image: imageName,
        workingDir: '/workspace/repo',
      },
      openrouter: {
        apiKey: 'e2e-dummy-openrouter-key',
      },
      coordinator: {
        model: 'openrouter/test-model',
        thinkingLevel: 'minimal',
      },
      personasDir,
      agent: {
        timeoutMinutes: 2,
        maxRetries: 1,
        gitTokenEnv: tokenEnvName,
      },
      git: {
        repoMode: 'clone',
        gitOpsMode: 'container',
        worktreesDir,
        authorName: 'Shepherds Pi Agent',
        authorEmail: 'agent@shepherds-pi.dev',
        resetWorktreeBeforeRun: true,
      },
    };

    db = new ShepherdsDB(dbPath);
    const runId = `run-e2e-clone-${Date.now().toString(36)}`;
    db.createRun(runId, 'E2E clone+container handoff test');

    const eventBus = new OrchestratorEventBus();
    const events: OrchestratorEvent[] = [];
    const unsubscribe = eventBus.onEvent((event) => {
      events.push(event);
    });

    const tools = createOrchestratorTools({
      eventBus,
      db,
      config,
      getRunId: () => runId,
    });

    // ─── Case 1: branch create + sequential clone handoffs ────────────
    const featureBranch = `feat/e2e-clone-${Date.now().toString(36)}`;

    console.log(`\n[1/5] create_branch → ${featureBranch}`);
    const createBranchResult = await executeTool(tools as unknown[], 'create_branch', {
      name: featureBranch,
      base: 'dev',
    });
    const createBranchText = getFirstText(createBranchResult);
    assertCondition(createBranchText.includes('created from "dev"'), `create_branch did not succeed: ${createBranchText}`);

    console.log('[2/5] spawn_agent handoff #1 (clone+container mode)');
    const spawn1 = await executeTool(tools as unknown[], 'spawn_agent', {
      persona: personaName,
      instructions: 'agent-1',
      branch: featureBranch,
    });
    assertCondition(isRecord(spawn1) && isRecord(spawn1.details) && spawn1.details.status === 'done', 'First clone handoff run should succeed');

    console.log('[3/5] spawn_agent handoff #2 (clone+container mode)');
    const spawn2 = await executeTool(tools as unknown[], 'spawn_agent', {
      persona: personaName,
      instructions: 'agent-2',
      branch: featureBranch,
    });
    assertCondition(isRecord(spawn2) && isRecord(spawn2.details) && spawn2.details.status === 'done', 'Second clone handoff run should succeed');

    run('git fetch origin', repoDir);
    const handoffContent = run(`git show origin/${featureBranch}:handoff.txt`, repoDir);
    assertCondition(handoffContent.includes('agent-1'), 'Expected handoff.txt to include agent-1 output');
    assertCondition(handoffContent.includes('agent-2'), 'Expected handoff.txt to include agent-2 output');

    console.log('[3.5/5] get_branch_diff should include handoff.txt');
    const diffResult = await executeTool(tools as unknown[], 'get_branch_diff', {
      branch: featureBranch,
      base: 'dev',
    });
    const diffText = getFirstText(diffResult);
    assertCondition(diffText.includes('handoff.txt'), 'Expected branch diff to include handoff.txt');

    // ─── Case 2: parallel clone runs on different branches ─────────────
    console.log('[4/5] spawn_agents parallel check (different branches)');
    const parallelBranchA = `feat/e2e-clone-parallel-a-${Date.now().toString(36)}`;
    const parallelBranchB = `feat/e2e-clone-parallel-b-${Date.now().toString(36)}`;

    await executeTool(tools as unknown[], 'spawn_agents', {
      agents: [
        { persona: personaName, instructions: 'parallel-A', branch: parallelBranchA },
        { persona: personaName, instructions: 'parallel-B', branch: parallelBranchB },
      ],
    });

    const allRunsAfterParallel = db.getAgentRunsForGoal(runId);
    const parallelRuns = allRunsAfterParallel.filter(r => r.branch === parallelBranchA || r.branch === parallelBranchB);
    assertCondition(parallelRuns.length === 2, `Expected 2 parallel clone runs, got ${parallelRuns.length}`);
    assertCondition(parallelRuns.every(r => r.status === 'done'), 'Expected both parallel clone runs to succeed');

    run('git fetch origin', repoDir);
    const parallelContentA = run(`git show origin/${parallelBranchA}:handoff.txt`, repoDir);
    const parallelContentB = run(`git show origin/${parallelBranchB}:handoff.txt`, repoDir);
    assertCondition(parallelContentA.includes('parallel-A'), 'Expected parallel branch A to contain agent output');
    assertCondition(parallelContentB.includes('parallel-B'), 'Expected parallel branch B to contain agent output');

    // ─── Case 3: failed run should not poison retry ────────────────────
    const retryBranch = `feat/e2e-clone-retry-${Date.now().toString(36)}`;
    console.log('[5/5] failed run should allow retry on same branch');

    const failRun = await executeTool(tools as unknown[], 'spawn_agent', {
      persona: personaName,
      instructions: 'FAIL',
      branch: retryBranch,
    });
    assertCondition(isRecord(failRun) && isRecord(failRun.details) && failRun.details.status === 'failed',
      'Expected intentional FAIL run to fail in clone mode');

    const retryRun = await executeTool(tools as unknown[], 'spawn_agent', {
      persona: personaName,
      instructions: 'retry-success',
      branch: retryBranch,
    });
    assertCondition(isRecord(retryRun) && isRecord(retryRun.details) && retryRun.details.status === 'done',
      'Expected retry run to succeed in clone mode');

    run('git fetch origin', repoDir);
    const retryContent = run(`git show origin/${retryBranch}:handoff.txt`, repoDir);
    assertCondition(retryContent.includes('retry-success'), 'Expected retry branch to contain retry-success output');

    // ─── Mode-specific assertions ──────────────────────────────────────
    const allRuns = db.getAgentRunsForGoal(runId);
    const doneCount = allRuns.filter(r => r.status === 'done').length;
    const failedCount = allRuns.filter(r => r.status === 'failed').length;
    assertCondition(doneCount === 5 && failedCount === 1,
      `Expected done=5 and failed=1, got done=${doneCount}, failed=${failedCount}`);

    const hostGitEvents = events.filter((e): e is Extract<OrchestratorEvent, { type: 'agent_event' }> => {
      if (e.type !== 'agent_event' || !isRecord(e.event)) return false;
      return e.event.type === 'host_git_finalized' || e.event.type === 'host_git_failed';
    });
    assertCondition(hostGitEvents.length === 0, 'Clone/container mode should not emit host_git_* events');

    const worktreeEvents = events.filter((e): e is Extract<OrchestratorEvent, { type: 'agent_event' }> => {
      return e.type === 'agent_event' && isRecord(e.event) && e.event.type === 'worktree_acquired';
    });
    assertCondition(worktreeEvents.length === 0, 'Clone mode should not emit worktree_acquired events');

    const logTypes = db.getRunLog(runId).map(entry => entry.event_type);
    assertCondition(!logTypes.some(t => t.startsWith('agent_worktree_')), 'Clone mode should not produce agent_worktree_* logs');
    assertCondition(!logTypes.includes('agent_host_git_finalized'), 'Clone/container mode should not produce agent_host_git_finalized logs');

    unsubscribe();

    console.log('\n✅ E2E clone+container handoff test passed');
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }

    await stopProcess(daemon);

    if (previousGitUrl === undefined) delete process.env.GIT_URL;
    else process.env.GIT_URL = previousGitUrl;

    if (previousToken === undefined) delete process.env[tokenEnvName];
    else process.env[tokenEnvName] = previousToken;

    try {
      run(`docker rmi -f ${imageName}`, tmpRoot);
    } catch {
      // ignore
    }

    try {
      await removeDirWithRetries(tmpRoot);
    } catch {
      // best effort cleanup on Windows can race with git daemon socket teardown
    }
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`\n❌ E2E clone+container handoff test failed: ${message}`);
  process.exit(1);
});
