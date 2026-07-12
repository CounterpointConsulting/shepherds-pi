/**
 * Integration test against a real `bd` binary when available.
 * Skips cleanly if bd is missing.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BeadsClient } from '../beads/client.js';

function hasBd(): boolean {
  const result = spawnSync('bd', ['version'], { encoding: 'utf-8', shell: false });
  return result.status === 0;
}

async function main(): Promise<void> {
  if (!hasBd()) {
    console.log('beads-client: skipped (bd not on PATH)');
    return;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shepherds-beads-'));
  const run = (cmd: string, args: string[]) => {
    const r = spawnSync(cmd, args, { cwd: tmp, encoding: 'utf-8', shell: false });
    if (r.status !== 0) {
      throw new Error(`${cmd} ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
    }
    return r.stdout;
  };

  try {
    run('git', ['init']);
    run('git', ['config', 'user.email', 'test@example.com']);
    run('git', ['config', 'user.name', 'test']);
    run('bd', ['init', '--prefix', 'sp', '--quiet']);

    const client = new BeadsClient({
      binary: 'bd',
      cwd: tmp,
      actor: 'shepherds-test',
      forceLocalRepo: true,
      timeoutMs: 30_000,
    });

    assert.equal(client.isInitialized(), true);

    const epic = await client.create({
      title: 'Epic health',
      type: 'epic',
      priority: 1,
      description: 'Add /health',
    });
    assert.ok(epic.id);

    const impl = await client.create({
      title: 'Implement health',
      type: 'task',
      priority: 1,
      parentId: epic.id,
      description: 'Implement endpoint',
      acceptance: 'GET /health returns 200 {ok:true}',
      role: 'implement',
      persona: 'typescript-api-dev',
      branch: 'feat/health',
    });
    assert.ok(impl.id);

    const review = await client.create({
      title: 'Review health',
      type: 'task',
      parentId: epic.id,
      description: 'Review',
      role: 'review',
      persona: 'code-reviewer',
      labels: ['gate:review'],
    });
    const testBead = await client.create({
      title: 'Verify health',
      type: 'task',
      parentId: epic.id,
      description: 'Test',
      role: 'test',
      persona: 'web-tester',
      labels: ['gate:test'],
    });
    const integrate = await client.create({
      title: 'Integrate health',
      type: 'task',
      parentId: epic.id,
      description: 'Integrate',
      role: 'integrate',
      persona: 'integrator',
    });

    await client.dep(impl.id, review.id);
    await client.dep(impl.id, testBead.id);
    await client.dep(review.id, integrate.id);
    await client.dep(testBead.id, integrate.id);

    const ready1 = await client.ready({ limit: 50 });
    const readyIds = new Set(ready1.map((b) => b.id));
    assert.ok(readyIds.has(impl.id), `implement should be ready; ready=${[...readyIds].join(',')}`);
    assert.ok(!readyIds.has(review.id), 'review should be blocked');
    assert.ok(!readyIds.has(integrate.id), 'integrate should be blocked');

    const claimed = await client.claim(impl.id);
    assert.equal(claimed.status, 'in_progress');

    const afterSpawn = await client.incrementDispatchCount(impl.id, 'agent-1');
    assert.equal(afterSpawn.dispatchCount, 1);

    const closed = await client.close(impl.id, 'delivered host-git ok', 'host finalized');
    assert.equal(closed.status, 'closed');

    const ready2 = await client.ready({ limit: 50 });
    const ready2Ids = new Set(ready2.map((b) => b.id));
    assert.ok(ready2Ids.has(review.id), 'review ready after implement close');
    assert.ok(ready2Ids.has(testBead.id), 'test ready after implement close');

    const shown = await client.show(impl.id);
    assert.equal(shown.status, 'closed');

    console.log('beads-client: ok');
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* windows file locks from bd daemon */
    }
  }
}

main().catch((err) => {
  console.error('beads-client failed:', err);
  process.exit(1);
});
