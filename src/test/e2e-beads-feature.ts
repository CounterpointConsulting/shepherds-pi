/**
 * End-to-end: coordinator tools implement a feature using Beads as the
 * work graph (Option B pipeline) and real Docker agent containers.
 *
 * Flow exercised:
 *   1. beads graph create (epic → implement / review / test / integrate)
 *   2. beads_dep quality gates
 *   3. beads_ready / beads_claim
 *   4. spawn_agent with beadId (implement → host-git finalize)
 *   5. beads_close implement (pipeline)
 *   6. parallel review + test spawns
 *   7. integrate spawn + epic close
 *   8. guards: missing beadId rejected; plan tools absent; dispatch notes
 *
 * Requires: Docker + `bd` on PATH. Skips cleanly if either is missing.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { ShepherdsDB } from '../db/index.js';
import { createOrchestratorTools } from '../orchestrator/tools.js';
import type { ShepherdsPiConfig } from '../config/index.js';
import { parseDispatchCount } from '../beads/normalize.js';

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

function hasBd(): boolean {
  const r = spawnSync('bd', ['version'], { encoding: 'utf-8', shell: false });
  return r.status === 0;
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function parseToolJson(result: unknown): unknown {
  const text = getFirstText(result);
  assertCondition(text.trim().length > 0, 'Tool returned empty text');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Tool did not return JSON: ${text.slice(0, 400)}`);
  }
}

function issueFromTool(result: unknown): Record<string, unknown> {
  const payload = parseToolJson(result);
  assertCondition(isRecord(payload) && payload.ok !== false, `Tool error: ${getFirstText(result)}`);
  assertCondition(isRecord(payload.normalized), 'Missing normalized payload');
  const norm = payload.normalized as Record<string, unknown>;
  if (isRecord(norm.issue)) return norm.issue;
  if (Array.isArray(norm.issues) && isRecord(norm.issues[0])) {
    return norm.issues[0] as Record<string, unknown>;
  }
  throw new Error(`Could not extract issue from tool result: ${getFirstText(result).slice(0, 400)}`);
}

function issuesFromTool(result: unknown): Record<string, unknown>[] {
  const payload = parseToolJson(result);
  assertCondition(isRecord(payload) && payload.ok !== false, `Tool error: ${getFirstText(result)}`);
  assertCondition(isRecord(payload.normalized), 'Missing normalized payload');
  const norm = payload.normalized as Record<string, unknown>;
  if (Array.isArray(norm.issues)) {
    return norm.issues.filter(isRecord) as Record<string, unknown>[];
  }
  if (isRecord(norm.issue)) return [norm.issue];
  return [];
}

let toolCallCounter = 0;

async function executeTool(
  tools: unknown[],
  name: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  const tool = tools.find((t): t is { name: string; execute: Function } => {
    return isRecord(t) && t.name === name && typeof t.execute === 'function';
  });
  if (!tool) {
    throw new Error(`Tool "${name}" not found. Available: ${
      tools.map((t) => (isRecord(t) ? String(t.name) : '?')).join(', ')
    }`);
  }

  toolCallCounter += 1;
  return tool.execute(`tool-call-${toolCallCounter}`, params, undefined, undefined, undefined);
}

async function main(): Promise<void> {
  if (!hasDocker()) {
    console.log('⚠️ Docker is not available/running. Skipping e2e beads feature test.');
    return;
  }
  if (!hasBd()) {
    console.log('⚠️ bd is not on PATH. Skipping e2e beads feature test.');
    return;
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shepherds-e2e-beads-'));
  const remoteDir = path.join(tmpRoot, 'remote.git');
  const seedDir = path.join(tmpRoot, 'seed');
  const repoDir = path.join(tmpRoot, 'repo');
  const worktreesDir = path.join(tmpRoot, 'worktrees');
  const personasDir = path.join(tmpRoot, 'personas');
  const imageDir = path.join(tmpRoot, 'agent-image');
  const dbPath = path.join(tmpRoot, '.shepherds-pi', 'shepherds.db');
  const imageName = `shepherds-pi-e2e-beads-${Date.now().toString(36)}-${process.pid}`;

  let db: ShepherdsDB | null = null;

  try {
    console.log('━━━ E2E: Beads feature pipeline (implement → review/test → integrate) ━━━\n');

    // ─── Deterministic agent image ───────────────────────────────────
    // Instructions protocol (first whitespace-delimited token):
    //   implement:<path>:<body>  → write file
    //   review:ok                → append REVIEW_OK to review-log.txt
    //   test:ok                  → append TEST_OK to test-log.txt
    //   integrate:ok             → append INTEGRATE_OK to integrate-log.txt
    //   FAIL                     → exit non-zero
    fs.mkdirSync(imageDir, { recursive: true });
    fs.writeFileSync(path.join(imageDir, 'Dockerfile'), [
      'FROM alpine:3.20',
      'RUN adduser -D -u 1000 node',
      'COPY entrypoint.sh /entrypoint.sh',
      'RUN chmod +x /entrypoint.sh',
      'ENTRYPOINT ["/entrypoint.sh"]',
      '',
    ].join('\n'), 'utf-8');

    // Note: keep shell simple for Windows path write + alpine ash.
    const entrypoint = `#!/bin/sh
set -eu

if [ "\${REPO_MODE:-}" != "mounted" ]; then
  echo "Expected REPO_MODE=mounted" >&2
  exit 11
fi

if [ "\${GIT_OPS_MODE:-}" != "host" ]; then
  echo "Expected GIT_OPS_MODE=host" >&2
  exit 12
fi

INSTRUCTIONS=""
if [ -f /tmp/instructions.txt ]; then
  INSTRUCTIONS=$(cat /tmp/instructions.txt)
fi

if [ "$INSTRUCTIONS" = "FAIL" ]; then
  echo "intentional failure" >&2
  exit 23
fi

TOKEN=$(printf '%s\\n' "$INSTRUCTIONS" | awk '{print $1}')
SUMMARY="ok"

case "$TOKEN" in
  implement:*)
    rest=\${TOKEN#implement:}
    fpath=\${rest%%:*}
    body=\${rest#*:}
    if [ -z "$fpath" ] || [ "$fpath" = "$rest" ]; then
      echo "bad implement instruction: $TOKEN" >&2
      exit 30
    fi
    mkdir -p "$(dirname "/workspace/repo/$fpath")"
    printf '%s\\n' "$body" > "/workspace/repo/$fpath"
    SUMMARY="implemented"
    ;;
  review:ok)
    echo "REVIEW_OK" >> /workspace/repo/review-log.txt
    SUMMARY="review-passed"
    ;;
  test:ok)
    echo "TEST_OK" >> /workspace/repo/test-log.txt
    SUMMARY="test-passed"
    ;;
  integrate:ok)
    echo "INTEGRATE_OK" >> /workspace/repo/integrate-log.txt
    SUMMARY="integrate-prepared"
    ;;
  *)
    echo "unknown instruction token: $TOKEN" >&2
    exit 31
    ;;
esac

mkdir -p /output
printf '%s\\n' "{\\"status\\":\\"success\\",\\"summary\\":\\"$SUMMARY\\",\\"commits\\":[\\"test: e2e beads\\"]}" > /output/result.json
echo "e2e-agent-done:$SUMMARY"
`;
    fs.writeFileSync(path.join(imageDir, 'entrypoint.sh'), entrypoint, 'utf-8');

    console.log(`[setup] Building image ${imageName}`);
    run(`docker build -t ${imageName} .`, imageDir);

    // ─── Git remote + host repo ──────────────────────────────────────
    fs.mkdirSync(remoteDir, { recursive: true });
    run('git init --bare', remoteDir);

    fs.mkdirSync(seedDir, { recursive: true });
    run('git init -b main', seedDir);
    run('git config user.name "Test User"', seedDir);
    run('git config user.email "test@example.com"', seedDir);
    fs.writeFileSync(path.join(seedDir, 'README.md'), '# beads e2e seed\n', 'utf-8');
    run('git add README.md', seedDir);
    run('git commit -m "seed"', seedDir);
    run('git checkout -b dev', seedDir);
    run(`git remote add origin "${remoteDir}"`, seedDir);
    run('git push -u origin main dev', seedDir);
    run(`git clone "${remoteDir}" "${repoDir}"`, tmpRoot);
    run('git config user.name "Shepherds Host"', repoDir);
    run('git config user.email "host@shepherds-pi.dev"', repoDir);

    // ─── Beads init in repo ──────────────────────────────────────────
    console.log('[setup] bd init');
    run('bd init --prefix e2e --quiet', repoDir);

    // ─── Personas ────────────────────────────────────────────────────
    for (const name of ['implementer', 'reviewer', 'tester', 'integrator']) {
      const dir = path.join(personasDir, name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SYSTEM.md'), `You are a deterministic ${name} E2E agent.`, 'utf-8');
      fs.writeFileSync(path.join(dir, 'model.txt'), 'openrouter/test-model', 'utf-8');
    }

    // ─── Config + tools (beads ON) ───────────────────────────────────
    const config: ShepherdsPiConfig = {
      version: 1,
      project: {
        name: 'e2e-beads-project',
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
        leaseWaitTimeoutMs: 900_000,
        leaseWaitPollMs: 3_000,
        acquireStepTimeoutMs: 90_000,
      },
      beads: {
        enabled: true,
        binary: 'bd',
        repoPath: repoDir,
        requireBeadOnSpawn: true,
        stuckDispatchLimit: 10,
        actor: 'shepherds-e2e',
      },
    };

    db = new ShepherdsDB(dbPath);
    const runId = `run-beads-${Date.now().toString(36)}`;
    db.createRun(runId, 'Implement GET /health via Beads pipeline');

    const eventBus = new TestEventBus();
    const events: OrchestratorEvent[] = [];
    const unsubscribe = eventBus.onEvent((e) => events.push(e));

    const tools = createOrchestratorTools({
      eventBus,
      db,
      config,
      getRunId: () => runId,
    });

    const toolNames = new Set(
      tools.map((t) => (isRecord(t) ? String(t.name) : '')).filter(Boolean),
    );

    // ─── Guard: plan tools unregistered; beads tools present ─────────
    console.log('[1/12] tool surface (beads on, plan off)');
    for (const name of [
      'beads_prime', 'beads_ready', 'beads_create', 'beads_create_many', 'beads_dep',
      'beads_claim', 'beads_close', 'beads_show', 'beads_list', 'beads_update',
      'beads_reopen', 'beads_remember', 'spawn_agent', 'spawn_agents',
    ]) {
      assertCondition(toolNames.has(name), `Expected tool ${name}`);
    }
    assertCondition(!toolNames.has('read_plan'), 'read_plan should be unregistered in beads mode');
    assertCondition(!toolNames.has('update_plan'), 'update_plan should be unregistered in beads mode');

    // ─── Missing beadId must fail ────────────────────────────────────
    console.log('[2/12] spawn without beadId is rejected');
    const noBead = await executeTool(tools as unknown[], 'spawn_agent', {
      persona: 'implementer',
      instructions: 'implement:should-not-run.txt:nope',
      branch: 'dev',
    });
    const noBeadText = getFirstText(noBead);
    assertCondition(
      noBeadText.toLowerCase().includes('beadid') || noBeadText.toLowerCase().includes('bead'),
      `Expected beadId error, got: ${noBeadText}`,
    );
    assertCondition(
      isRecord(noBead) && isRecord(noBead.details) && noBead.details.error === true,
      'spawn without beadId should mark error details',
    );

    // ─── Materialize work graph ──────────────────────────────────────
    console.log('[3/12] beads_prime');
    const prime = await executeTool(tools as unknown[], 'beads_prime', {});
    const primePayload = parseToolJson(prime);
    assertCondition(isRecord(primePayload) && primePayload.ok === true, 'prime should succeed');
    assertCondition(typeof primePayload.text === 'string' && primePayload.text.length > 0, 'prime should return text');

    console.log('[4/12] create epic + tasks + deps');
    const epicIssue = issueFromTool(await executeTool(tools as unknown[], 'beads_create', {
      title: 'Add GET /health endpoint',
      type: 'epic',
      priority: 1,
      description: 'Ship a health check endpoint returning {ok:true}',
    }));
    const epicId = String(epicIssue.id);

    const manyResult = await executeTool(tools as unknown[], 'beads_create_many', {
      items: [
        {
          title: 'Implement health endpoint',
          type: 'task',
          priority: 1,
          parentId: epicId,
          description: 'Write feature/src/health.json with ok=true',
          acceptance: 'feature/src/health.json exists and contains "ok": true',
          role: 'implement',
          persona: 'implementer',
          branch: 'feat/health-e2e',
          labels: ['e2e'],
        },
        {
          title: 'Review health endpoint',
          type: 'task',
          priority: 1,
          parentId: epicId,
          description: 'Code review of health endpoint',
          role: 'review',
          persona: 'reviewer',
          branch: 'feat/health-e2e',
          labels: ['gate:review', 'e2e'],
        },
        {
          title: 'Test health endpoint',
          type: 'task',
          priority: 1,
          parentId: epicId,
          description: 'Verify health acceptance criteria',
          acceptance: 'feature/src/health.json content verifies ok:true',
          role: 'test',
          persona: 'tester',
          branch: 'feat/health-e2e',
          labels: ['gate:test', 'e2e'],
        },
        {
          title: 'Integrate health endpoint',
          type: 'task',
          priority: 2,
          parentId: epicId,
          description: 'Merge after gates',
          role: 'integrate',
          persona: 'integrator',
          branch: 'feat/health-e2e',
          labels: ['e2e'],
        },
      ],
    });
    const createdIssues = issuesFromTool(manyResult);
    assertCondition(
      createdIssues.length === 4,
      `Expected 4 child tasks, got ${createdIssues.length}: ${getFirstText(manyResult).slice(0, 400)}`,
    );

    const byRole = (role: string): Record<string, unknown> => {
      const found = createdIssues.find((i) => {
        const labels = Array.isArray(i.labels) ? i.labels.map(String) : [];
        return labels.includes(`role:${role}`);
      });
      assertCondition(found, `Missing role:${role} bead in ${createdIssues.map((i) => i.id).join(',')}`);
      return found!;
    };

    const impl = byRole('implement');
    const review = byRole('review');
    const testBead = byRole('test');
    const integrate = byRole('integrate');
    const implId = String(impl.id);
    const reviewId = String(review.id);
    const testId = String(testBead.id);
    const integrateId = String(integrate.id);

    await executeTool(tools as unknown[], 'beads_dep', { from: implId, to: reviewId, type: 'blocks' });
    await executeTool(tools as unknown[], 'beads_dep', { from: implId, to: testId, type: 'blocks' });
    await executeTool(tools as unknown[], 'beads_dep', { from: reviewId, to: integrateId, type: 'blocks' });
    await executeTool(tools as unknown[], 'beads_dep', { from: testId, to: integrateId, type: 'blocks' });

    // ─── Ready: only implement ───────────────────────────────────────
    console.log('[5/12] beads_ready before implement');
    let ready1 = issuesFromTool(await executeTool(tools as unknown[], 'beads_ready', {
      limit: 50,
      parent: epicId,
    }));
    if (ready1.length === 0) {
      ready1 = issuesFromTool(await executeTool(tools as unknown[], 'beads_ready', { limit: 50 }));
    }
    const readyIds = new Set(ready1.map((i) => String(i.id)));
    assertCondition(readyIds.has(implId), `implement should be ready; ready=${[...readyIds].join(',')}`);
    assertCondition(!readyIds.has(reviewId), 'review must be blocked by implement');
    assertCondition(!readyIds.has(testId), 'test must be blocked by implement');
    assertCondition(!readyIds.has(integrateId), 'integrate must be blocked by gates');

    // ─── Feature branch ──────────────────────────────────────────────
    const featureBranch = 'feat/health-e2e';
    console.log(`[6/12] create_branch ${featureBranch}`);
    const br = await executeTool(tools as unknown[], 'create_branch', {
      name: featureBranch,
      base: 'dev',
    });
    const brText = getFirstText(br);
    assertCondition(
      brText.includes('created') || brText.includes(featureBranch),
      `create_branch failed: ${brText}`,
    );

    // ─── Implement ───────────────────────────────────────────────────
    console.log('[7/12] claim + spawn implement');
    const claimed = issueFromTool(await executeTool(tools as unknown[], 'beads_claim', { id: implId }));
    assertCondition(claimed.status === 'in_progress', `implement not in_progress: ${claimed.status}`);

    const implSpawn = await executeTool(tools as unknown[], 'spawn_agent', {
      persona: 'implementer',
      instructions: 'implement:feature/src/health.json:{"ok":true,"source":"e2e-beads"}',
      branch: featureBranch,
      beadId: implId,
      context: 'Implement the health endpoint artifact for e2e',
    });
    assertCondition(
      isRecord(implSpawn) && isRecord(implSpawn.details) && implSpawn.details.status === 'done',
      `implement spawn failed: ${getFirstText(implSpawn)}`,
    );
    assertCondition(
      isRecord(implSpawn.details) && implSpawn.details.beadId === implId,
      'spawn details should include beadId',
    );

    run('git fetch origin', repoDir);
    const healthBlob = run(`git show origin/${featureBranch}:feature/src/health.json`, repoDir);
    assertCondition(healthBlob.includes('"ok"') && healthBlob.includes('true'), `health.json bad: ${healthBlob}`);

    const afterImplShow = issueFromTool(await executeTool(tools as unknown[], 'beads_show', { id: implId }));
    assertCondition(
      Number(afterImplShow.dispatchCount) >= 1
        || parseDispatchCount(String(afterImplShow.notes ?? '')) >= 1,
      'dispatch_count should increment after spawn',
    );
    assertCondition(
      String(afterImplShow.notes ?? '').toLowerCase().includes('done')
        || String(afterImplShow.notes ?? '').includes('agent result')
        || String(afterImplShow.notes ?? '').includes('spawn'),
      `implement notes should append agent result: ${String(afterImplShow.notes ?? '').slice(0, 200)}`,
    );

    // Pipeline Option B: close implement after delivery
    console.log('[8/12] close implement (pipeline)');
    const closedImpl = issueFromTool(await executeTool(tools as unknown[], 'beads_close', {
      id: implId,
      reason: 'delivered host-git ok',
      evidence: `health.json pushed on ${featureBranch}`,
    }));
    assertCondition(closedImpl.status === 'closed', 'implement should be closed');

    // ─── Gates ready + parallel review/test ──────────────────────────
    console.log('[9/12] ready gates + parallel review/test');
    const ready2 = issuesFromTool(await executeTool(tools as unknown[], 'beads_ready', { limit: 50 }));
    const ready2Ids = new Set(ready2.map((i) => String(i.id)));
    assertCondition(ready2Ids.has(reviewId), 'review should be ready after implement close');
    assertCondition(ready2Ids.has(testId), 'test should be ready after implement close');
    assertCondition(!ready2Ids.has(integrateId), 'integrate still blocked');

    // Gates share the same feature branch. Worktree + host-git leases are exclusive
    // per branch, so we spawn them sequentially here and still cover beadId
    // binding for both roles. (Parallel independent branches are covered by the
    // worktree handoff e2e; beads_spawn ordering is the critical bit here.)
    for (const gate of [
      { beadId: reviewId, persona: 'reviewer', instructions: 'review:ok' },
      { beadId: testId, persona: 'tester', instructions: 'test:ok' },
    ]) {
      // Auto-claim + dispatch on spawn (Option B does not require pre-claim).
      const r = await executeTool(tools as unknown[], 'spawn_agent', {
        persona: gate.persona,
        instructions: gate.instructions,
        branch: featureBranch,
        beadId: gate.beadId,
      });
      assertCondition(
        isRecord(r) && isRecord(r.details) && r.details.status === 'done',
        `gate ${gate.beadId} spawn failed: ${getFirstText(r)}`,
      );
    }

    const gateRuns = db.getAgentRunsForGoal(runId).filter((r) => r.step_id === reviewId || r.step_id === testId);
    assertCondition(
      gateRuns.filter((r) => r.status === 'done').length >= 2,
      'expected both gate agent runs done with step_id = bead id',
    );

    run('git fetch origin', repoDir);
    const reviewLog = run(`git show origin/${featureBranch}:review-log.txt`, repoDir);
    const testLog = run(`git show origin/${featureBranch}:test-log.txt`, repoDir);
    assertCondition(reviewLog.includes('REVIEW_OK'), 'review-log missing REVIEW_OK');
    assertCondition(testLog.includes('TEST_OK'), 'test-log missing TEST_OK');

    await executeTool(tools as unknown[], 'beads_close', {
      id: reviewId,
      reason: 'review passed',
      evidence: 'REVIEW_OK on branch',
    });
    await executeTool(tools as unknown[], 'beads_close', {
      id: testId,
      reason: 'tests passed',
      evidence: 'TEST_OK on branch',
    });

    // ─── Integrate ───────────────────────────────────────────────────
    console.log('[10/12] integrate');
    const ready3 = issuesFromTool(await executeTool(tools as unknown[], 'beads_ready', { limit: 50 }));
    const ready3Ids = new Set(ready3.map((i) => String(i.id)));
    assertCondition(ready3Ids.has(integrateId), 'integrate should be ready after gates close');

    const intSpawn = await executeTool(tools as unknown[], 'spawn_agent', {
      persona: 'integrator',
      instructions: 'integrate:ok',
      branch: featureBranch,
      beadId: integrateId,
    });
    assertCondition(
      isRecord(intSpawn) && isRecord(intSpawn.details) && intSpawn.details.status === 'done',
      `integrate spawn failed: ${getFirstText(intSpawn)}`,
    );

    await executeTool(tools as unknown[], 'beads_close', {
      id: integrateId,
      reason: 'merged (e2e simulated)',
      evidence: 'INTEGRATE_OK',
    });
    await executeTool(tools as unknown[], 'beads_close', {
      id: epicId,
      reason: 'all children complete',
      evidence: 'feature pipeline passed',
    });

    const epicClosed = issueFromTool(await executeTool(tools as unknown[], 'beads_show', { id: epicId }));
    assertCondition(epicClosed.status === 'closed', 'epic should be closed');

    // ─── Goal status + run log ───────────────────────────────────────
    console.log('[11/12] goal status + run log integrity');
    await executeTool(tools as unknown[], 'update_goal_status', {
      status: 'completed',
      message: 'health endpoint pipeline done',
    });
    const runRow = db.getRun(runId);
    assertCondition(runRow?.status === 'completed', 'run status should be completed');

    const log = db.getRunLog(runId);
    const types = new Set(log.map((e) => e.event_type));
    for (const t of ['bead_created', 'bead_dispatch', 'agent_completed', 'bead_closed', 'status_changed']) {
      assertCondition(types.has(t), `run_log missing ${t}`);
    }

    const implRuns = db.getAgentRunsForGoal(runId).filter((r) => r.step_id === implId);
    assertCondition(implRuns.length >= 1 && implRuns.every((r) => r.status === 'done'), 'implement agent_run missing/failed');

    // ─── Remember + list memory ──────────────────────────────────────
    console.log('[12/12] beads_remember + list');
    const mem = issueFromTool(await executeTool(tools as unknown[], 'beads_remember', {
      insight: 'Health endpoint file lives at feature/src/health.json',
    }));
    assertCondition(
      Array.isArray(mem.labels) && (mem.labels as string[]).includes('memory'),
      'memory bead should have memory label',
    );

    const listed = issuesFromTool(await executeTool(tools as unknown[], 'beads_list', {
      all: true,
      limit: 50,
    }));
    const listedIds = new Set(listed.map((i) => String(i.id)));
    assertCondition(listedIds.has(epicId) || listedIds.has(implId), 'list should include epic or implement bead');

    const finalBranchFiles = run(`git ls-tree -r --name-only origin/${featureBranch}`, repoDir).split('\n');
    for (const f of ['feature/src/health.json', 'review-log.txt', 'test-log.txt', 'integrate-log.txt']) {
      assertCondition(finalBranchFiles.includes(f), `branch missing ${f}`);
    }

    const hostGitEvents = events.filter((e) => {
      return e.type === 'agent_event' && isRecord(e.event) && e.event.type === 'host_git_finalized';
    });
    assertCondition(hostGitEvents.length >= 3, `expected multiple host_git_finalized, got ${hostGitEvents.length}`);

    unsubscribe();

    console.log('\n✅ E2E beads feature pipeline passed');
    console.log(`   epic=${epicId} implement=${implId} review=${reviewId} test=${testId} integrate=${integrateId}`);
    console.log(`   branch=${featureBranch} agent_runs=${db.getAgentRunsForGoal(runId).length} log_events=${log.length}`);
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
    try {
      run(`docker rmi -f ${imageName}`, tmpRoot);
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      console.warn(`cleanup: could not fully remove ${tmpRoot}`);
    }
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`\n❌ E2E beads feature test failed: ${message}`);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
