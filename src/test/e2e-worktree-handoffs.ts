import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { ShepherdsDB } from '../db/index.js';
import { createOrchestratorTools } from '../orchestrator/tools.js';
import type { ShepherdsPiConfig } from '../config/index.js';

interface OrchestratorEvent {
  type: string;
  [key: string]: unknown;
}

class TestEventBus {
  private listeners = new Set<(event: OrchestratorEvent) => void>();

  emit(event: OrchestratorEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  onEvent(listener: (event: OrchestratorEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  askUser(question: string): Promise<string> {
    return new Promise<string>((resolve) => {
      this.emit({ type: 'user_question', question, resolve });
    });
  }
}

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

function worktreePathForBranch(worktreesDir: string, branch: string): string {
  const safe = branch.replace(/[^a-zA-Z0-9._-]+/g, '__').replace(/^\.+/, 'branch');
  const hash = createHash('sha1').update(branch).digest('hex').slice(0, 8);
  return path.join(worktreesDir, `${safe}-${hash}`);
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

let toolCallCounter = 0;

async function executeTool(tools: unknown[], name: string, params: Record<string, unknown>): Promise<unknown> {
  const tool = tools.find((t): t is { name: string; execute: Function } => {
    return isRecord(t) && t.name === name && typeof t.execute === 'function';
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

async function main(): Promise<void> {
  if (!hasDocker()) {
    console.log('⚠️ Docker is not available/running. Skipping e2e worktree handoff test.');
    return;
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shepherds-e2e-worktree-'));
  const remoteDir = path.join(tmpRoot, 'remote.git');
  const seedDir = path.join(tmpRoot, 'seed');
  const repoDir = path.join(tmpRoot, 'repo');
  const worktreesDir = path.join(tmpRoot, 'worktrees');
  const personasDir = path.join(tmpRoot, 'personas');
  const imageDir = path.join(tmpRoot, 'agent-image');
  const dbPath = path.join(tmpRoot, '.shepherds-pi', 'shepherds.db');
  const imageName = `shepherds-pi-e2e-worktree-${Date.now().toString(36)}-${process.pid}`;

  let db: ShepherdsDB | null = null;

  try {
    console.log('━━━ E2E: Worktree + mounted-repo handoff cycle ━━━\n');

    // ─── Build a deterministic test image (no LLM calls) ──────────────
    fs.mkdirSync(imageDir, { recursive: true });
    fs.writeFileSync(path.join(imageDir, 'Dockerfile'), [
      'FROM alpine:3.20',
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
      'if [ "${REPO_MODE:-}" != "mounted" ]; then',
      '  echo "Expected REPO_MODE=mounted, got ${REPO_MODE:-unset}" >&2',
      '  exit 11',
      'fi',
      '',
      'if [ "${GIT_OPS_MODE:-}" != "host" ]; then',
      '  echo "Expected GIT_OPS_MODE=host, got ${GIT_OPS_MODE:-unset}" >&2',
      '  exit 12',
      'fi',
      '',
      'if [ ! -e /workspace/repo/.git ]; then',
      '  echo "Mounted repository missing .git" >&2',
      '  exit 13',
      'fi',
      '',
      'if [ -n "${GIT_URL:-}" ]; then',
      '  echo "GIT_URL should be empty in mounted mode" >&2',
      '  exit 14',
      'fi',
      '',
      'if [ -e /run/secrets/git_token ]; then',
      '  echo "git_token should NOT be mounted in worktree+host mode" >&2',
      '  exit 15',
      'fi',
      '',
      'if [ ! -r /run/secrets/openrouter_key ]; then',
      '  echo "openrouter_key should be mounted" >&2',
      '  exit 16',
      'fi',
      '',
      'INSTRUCTIONS=""',
      'if [ -f /tmp/instructions.txt ]; then',
      '  INSTRUCTIONS=$(cat /tmp/instructions.txt)',
      'fi',
      '',
      'if [ "$INSTRUCTIONS" = "FAIL" ]; then',
      '  echo "intentional failure requested" >&2',
      '  exit 23',
      'fi',
      '',
      'if [ "$INSTRUCTIONS" = "assert-clean" ] && [ -e /workspace/repo/dirty-from-host.tmp ]; then',
      '  echo "dirty-from-host.tmp survived reset_worktree_before_run" >&2',
      '  exit 24',
      'fi',
      '',
      'case "$INSTRUCTIONS" in',
      '  sleep:*)',
      '    TOKEN=$(echo "$INSTRUCTIONS" | cut -d" " -f1)',
      '    SECS=${TOKEN#sleep:}',
      '    sleep "$SECS"',
      '    ;;',
      'esac',
      '',
      'echo "$INSTRUCTIONS" >> /workspace/repo/handoff.txt',
      '',
      'mkdir -p /output',
      'printf "%s\\n" "{\"status\":\"success\",\"summary\":\"e2e-container-ok\",\"commits\":[\"test: e2e agent update\"]}" > /output/result.json',
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
        name: 'e2e-worktree-project',
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
        gitTokenEnv: 'GIT_TOKEN',
      },
      git: {
        repoMode: 'worktree',
        gitOpsMode: 'host',
        worktreesDir,
        authorName: 'Shepherds Pi Agent',
        authorEmail: 'agent@shepherds-pi.dev',
        resetWorktreeBeforeRun: true,
      },
    };

    db = new ShepherdsDB(dbPath);
    const runId = `run-e2e-${Date.now().toString(36)}`;
    db.createRun(runId, 'E2E worktree handoff test');

    const eventBus = new TestEventBus();
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

    // ─── Case 1: create branch + sequential handoffs on same branch ───
    const featureBranch = `feat/e2e-handoff-${Date.now().toString(36)}`;

    console.log(`\n[1/5] create_branch → ${featureBranch}`);
    const createBranchResult = await executeTool(tools as unknown[], 'create_branch', {
      name: featureBranch,
      base: 'dev',
    });
    const createBranchText = getFirstText(createBranchResult);
    assertCondition(createBranchText.includes('created from "dev"'), `create_branch did not succeed: ${createBranchText}`);

    console.log('[2/5] spawn_agent handoff #1');
    const spawn1 = await executeTool(tools as unknown[], 'spawn_agent', {
      persona: personaName,
      instructions: 'agent-1',
      branch: featureBranch,
    });
    assertCondition(isRecord(spawn1) && isRecord(spawn1.details) && spawn1.details.status === 'done', 'First handoff run should succeed');

    console.log('[3/5] spawn_agent handoff #2');
    const spawn2 = await executeTool(tools as unknown[], 'spawn_agent', {
      persona: personaName,
      instructions: 'agent-2',
      branch: featureBranch,
    });
    assertCondition(isRecord(spawn2) && isRecord(spawn2.details) && spawn2.details.status === 'done', 'Second handoff run should succeed');

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

    // ─── Case 2: reset_worktree_before_run should scrub dirty files ────
    console.log('[4/5] reset_worktree_before_run cleanup check');
    const featureWorktreePath = worktreePathForBranch(worktreesDir, featureBranch);
    fs.writeFileSync(path.join(featureWorktreePath, 'dirty-from-host.tmp'), 'dirty\n', 'utf-8');

    const spawn3 = await executeTool(tools as unknown[], 'spawn_agent', {
      persona: personaName,
      instructions: 'assert-clean',
      branch: featureBranch,
    });
    assertCondition(isRecord(spawn3) && isRecord(spawn3.details) && spawn3.details.status === 'done', 'Dirty cleanup check should succeed');

    run('git fetch origin', repoDir);
    const aheadCount = Number(run(`git rev-list --count origin/dev..origin/${featureBranch}`, repoDir));
    assertCondition(Number.isFinite(aheadCount) && aheadCount >= 3, `Expected >=3 feature commits ahead of dev, got ${aheadCount}`);

    // ─── Case 3: parallel same-branch run should enforce lease lock ────
    console.log('[5/5] spawn_agents parallel lock check (same branch)');
    const parallelBranch = `feat/e2e-parallel-${Date.now().toString(36)}`;
    await executeTool(tools as unknown[], 'spawn_agents', {
      agents: [
        { persona: personaName, instructions: 'sleep:3 parallel-A', branch: parallelBranch },
        { persona: personaName, instructions: 'parallel-B', branch: parallelBranch },
      ],
    });

    const allRuns = db.getAgentRunsForGoal(runId);
    const parallelRuns = allRuns.filter(r => r.branch === parallelBranch);
    assertCondition(parallelRuns.length === 2, `Expected 2 parallel agent runs, got ${parallelRuns.length}`);

    const parallelDone = parallelRuns.filter(r => r.status === 'done').length;
    const parallelFailed = parallelRuns.filter(r => r.status === 'failed').length;
    assertCondition(parallelDone === 1 && parallelFailed === 1,
      `Expected one parallel success + one lock failure, got done=${parallelDone}, failed=${parallelFailed}`);

    // ─── Case 4: failed run should still release lease for retry ────────
    const retryBranch = `feat/e2e-retry-${Date.now().toString(36)}`;
    console.log('[extra] failed run should release lease for retry');

    const failRun = await executeTool(tools as unknown[], 'spawn_agent', {
      persona: personaName,
      instructions: 'FAIL',
      branch: retryBranch,
    });
    assertCondition(isRecord(failRun) && isRecord(failRun.details) && failRun.details.status === 'failed', 'Expected intentional FAIL run to fail');

    const retryRun = await executeTool(tools as unknown[], 'spawn_agent', {
      persona: personaName,
      instructions: 'retry-success',
      branch: retryBranch,
    });
    assertCondition(isRecord(retryRun) && isRecord(retryRun.details) && retryRun.details.status === 'done',
      'Expected retry run on same branch to succeed (lease should have been released)');

    // ─── Events + lock cleanup assertions ───────────────────────────────
    const hostGitEvents = events.filter((e) => {
      return e.type === 'agent_event' && isRecord(e.event) && e.event.type === 'host_git_finalized';
    });

    const doneRuns = db.getAgentRunsForGoal(runId).filter(r => r.status === 'done').length;
    assertCondition(hostGitEvents.length === doneRuns,
      `Expected host_git_finalized count (${hostGitEvents.length}) to match done run count (${doneRuns})`);

    const locksDir = path.join(worktreesDir, '.locks');
    const lockFiles = fs.existsSync(locksDir)
      ? fs.readdirSync(locksDir).filter(name => name.endsWith('.lock'))
      : [];
    assertCondition(lockFiles.length === 0, `Expected no leaked lock files, found: ${lockFiles.join(', ')}`);

    unsubscribe();

    console.log('\n✅ E2E worktree handoff test passed');
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }

    try {
      run(`docker rmi -f ${imageName}`, tmpRoot);
    } catch {
      // ignore
    }

    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`\n❌ E2E worktree handoff test failed: ${message}`);
  process.exit(1);
});
