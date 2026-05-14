import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { WorktreeManager } from '../git/worktree-manager.js';

function run(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, stdio: 'pipe', encoding: 'utf-8' }).trim();
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shepherds-worktree-test-'));
const remoteDir = path.join(tmpRoot, 'remote.git');
const seedDir = path.join(tmpRoot, 'seed');
const repoDir = path.join(tmpRoot, 'repo');
const worktreesDir = path.join(tmpRoot, 'worktrees');

function lockPathForBranch(branch: string): string {
  const safe = branch.replace(/[^a-zA-Z0-9._-]+/g, '__').replace(/^\.+/, 'branch');
  const hash = createHash('sha1').update(branch).digest('hex').slice(0, 8);
  return path.join(worktreesDir, '.locks', `${safe}-${hash}.lock`);
}

try {
  fs.mkdirSync(remoteDir, { recursive: true });
  run('git init --bare', remoteDir);

  fs.mkdirSync(seedDir, { recursive: true });
  run('git init -b main', seedDir);
  run('git config user.name "Test User"', seedDir);
  run('git config user.email "test@example.com"', seedDir);
  fs.writeFileSync(path.join(seedDir, 'README.md'), '# seed\n', 'utf-8');
  run('git add README.md', seedDir);
  run('git commit -m "seed"', seedDir);
  run(`git remote add origin "${remoteDir}"`, seedDir);
  run('git push -u origin main', seedDir);

  run(`git clone "${remoteDir}" "${repoDir}"`, tmpRoot);

  const manager = new WorktreeManager({
    repoPath: repoDir,
    worktreesDir,
    resetBeforeRun: true,
  });

  // Cross-process lock simulation: place a fresh lock file and verify acquire fails.
  fs.mkdirSync(path.join(worktreesDir, '.locks'), { recursive: true });
  const blockedBranch = 'feat/blocked';
  const blockedLock = lockPathForBranch(blockedBranch);
  fs.writeFileSync(blockedLock, JSON.stringify({
    leaseId: 'lease-foreign',
    branch: blockedBranch,
    agentId: 'foreign-agent',
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
    hostname: 'test-host',
  }), 'utf-8');

  let crossProcessBlocked = false;
  try {
    await manager.acquire({
      branch: blockedBranch,
      baseBranch: 'main',
      agentId: 'agent-x',
    });
  } catch {
    crossProcessBlocked = true;
  }

  if (!crossProcessBlocked) {
    throw new Error('Expected branch to be blocked by lock file');
  }

  // Stale lock simulation: old timestamp should be ignored/replaced.
  fs.writeFileSync(blockedLock, JSON.stringify({
    leaseId: 'lease-stale',
    branch: blockedBranch,
    agentId: 'stale-agent',
    pid: process.pid,
    acquiredAt: new Date(Date.now() - (13 * 60 * 60 * 1000)).toISOString(),
    hostname: 'test-host',
  }), 'utf-8');

  const staleRecovered = await manager.acquire({
    branch: blockedBranch,
    baseBranch: 'main',
    agentId: 'agent-y',
  });
  manager.release(staleRecovered.leaseId);

  const lease1 = await manager.acquire({
    branch: 'feat/demo',
    baseBranch: 'main',
    agentId: 'agent-1',
  });

  if (!fs.existsSync(lease1.worktreePath)) {
    throw new Error('Expected worktree path to exist');
  }

  let lockError = false;
  try {
    await manager.acquire({
      branch: 'feat/demo',
      baseBranch: 'main',
      agentId: 'agent-2',
    });
  } catch {
    lockError = true;
  }

  if (!lockError) {
    throw new Error('Expected same-branch lease conflict');
  }

  manager.release(lease1.leaseId);

  const lease2 = await manager.acquire({
    branch: 'feat/demo',
    baseBranch: 'main',
    agentId: 'agent-3',
  });

  if (!lease2.leaseId) {
    throw new Error('Expected lease2 to exist');
  }

  manager.release(lease2.leaseId);

  console.log('✅ Worktree manager test passed');
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}
