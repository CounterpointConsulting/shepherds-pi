import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { attemptMerge, finalizeMerge, cleanupIntegrationWorktree } from '../git/host-merge-manager.js';

function run(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, stdio: 'pipe', encoding: 'utf-8' }).trim();
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shepherds-merge-test-'));
const remoteDir = path.join(tmpRoot, 'remote.git');
const seedDir = path.join(tmpRoot, 'seed');
const repoDir = path.join(tmpRoot, 'repo');
const worktreesDir = path.join(tmpRoot, 'worktrees');

const AUTHOR = { authorName: 'Test Bot', authorEmail: 'bot@test.dev' };

function makeBranchFrom(base: string, branch: string, file: string, content: string): void {
  run(`git checkout -b ${branch} origin/${base}`, seedDir);
  fs.writeFileSync(path.join(seedDir, file), content, 'utf-8');
  run('git add -A', seedDir);
  run(`git commit -m "${branch} change"`, seedDir);
  run(`git push -u origin ${branch}`, seedDir);
  run('git checkout main', seedDir);
}

try {
  // ─── Setup a remote with a main branch ───────────────────────
  fs.mkdirSync(remoteDir, { recursive: true });
  run('git init --bare', remoteDir);

  fs.mkdirSync(seedDir, { recursive: true });
  run('git init -b main', seedDir);
  run('git config user.name "Seed"', seedDir);
  run('git config user.email "seed@test.dev"', seedDir);
  fs.writeFileSync(path.join(seedDir, 'base.txt'), 'base\n', 'utf-8');
  fs.writeFileSync(path.join(seedDir, 'shared.txt'), 'line1\nline2\nline3\n', 'utf-8');
  run('git add -A', seedDir);
  run('git commit -m "seed"', seedDir);
  run(`git remote add origin "${remoteDir}"`, seedDir);
  run('git push -u origin main', seedDir);

  // repoDir is the "project repo" the manager operates on
  run(`git clone "${remoteDir}" "${repoDir}"`, tmpRoot);

  // ─── Test 1: clean merge (disjoint file) ─────────────────────
  makeBranchFrom('main', 'feat/clean', 'feature-a.txt', 'hello from feat/clean\n');
  const clean = await attemptMerge({
    repoPath: repoDir, worktreesDir, source: 'feat/clean', target: 'main', noFf: true, ...AUTHOR,
  });
  assert(clean.status === 'clean', `expected clean merge, got ${clean.status} ${JSON.stringify(clean)}`);
  // Verify origin/main now contains the feature file and a merge commit.
  run('git fetch origin', repoDir);
  const log1 = run('git log --oneline origin/main', repoDir);
  assert(/Merge branch 'feat\/clean'/.test(log1) || /Merge/.test(log1), `expected merge commit in log:\n${log1}`);
  const treeFiles = run('git ls-tree -r --name-only origin/main', repoDir);
  assert(treeFiles.includes('feature-a.txt'), 'feature-a.txt should be on origin/main after clean merge');
  console.log('Test 1: clean merge → PASS');

  // ─── Test 2: up-to-date (merging same branch again) ──────────
  const again = await attemptMerge({
    repoPath: repoDir, worktreesDir, source: 'feat/clean', target: 'main', noFf: true, ...AUTHOR,
  });
  assert(again.status === 'up-to-date', `expected up-to-date, got ${again.status}`);
  console.log('Test 2: up-to-date detection → PASS');

  // ─── Test 3: conflict → resolver edit → finalize ─────────────
  // Two branches from the SAME base commit editing the same line diverge.
  // Land one clean, the other must conflict. Branch from the shared seed main
  // tip (a commit both seed and repo already have), not from a post-merge sha.
  const seedMainTip = run('git rev-parse main', seedDir);
  run(`git checkout -b feat/c1 ${seedMainTip}`, seedDir);
  fs.writeFileSync(path.join(seedDir, 'shared.txt'), 'line1\nC1\nline3\n', 'utf-8');
  run('git add -A && git commit -m c1', seedDir);
  run('git push -u origin feat/c1', seedDir);
  run('git checkout main', seedDir);
  run(`git checkout -b feat/c2 ${seedMainTip}`, seedDir);
  fs.writeFileSync(path.join(seedDir, 'shared.txt'), 'line1\nC2\nline3\n', 'utf-8');
  run('git add -A && git commit -m c2', seedDir);
  run('git push -u origin feat/c2', seedDir);
  run('git checkout main', seedDir);

  const c1 = await attemptMerge({ repoPath: repoDir, worktreesDir, source: 'feat/c1', target: 'main', noFf: true, ...AUTHOR });
  assert(c1.status === 'clean', `feat/c1 should merge clean, got ${c1.status} ${JSON.stringify(c1)}`);
  const c2 = await attemptMerge({ repoPath: repoDir, worktreesDir, source: 'feat/c2', target: 'main', noFf: true, ...AUTHOR });
  assert(c2.status === 'conflict', `feat/c2 should conflict, got ${c2.status}`);
  assert(c2.status === 'conflict' && c2.conflictedFiles.includes('shared.txt'), 'shared.txt should be conflicted');

  if (c2.status === 'conflict') {
    // Simulate the resolver agent editing the file to a resolved state.
    const abs = path.join(c2.worktreePath, 'shared.txt');
    assert(/[<]{7}|[=]{7}|[>]{7}/.test(fs.readFileSync(abs, 'utf-8')), 'worktree file should have conflict markers');
    fs.writeFileSync(abs, 'line1\nRESOLVED\nline3\n', 'utf-8');

    const fin = await finalizeMerge({
      repoPath: repoDir, worktreePath: c2.worktreePath, source: 'feat/c2', target: 'main', ...AUTHOR,
    });
    assert(fin.status === 'clean', `finalize should succeed, got ${fin.status} ${JSON.stringify(fin)}`);
    run('git fetch origin', repoDir);
    const resolved = run('git show origin/main:shared.txt', repoDir);
    assert(resolved.includes('RESOLVED'), `origin/main:shared.txt should contain RESOLVED, got:\n${resolved}`);
    console.log('Test 3: conflict → resolver edit → finalize → PASS');
  }

  // ─── Test 4: finalize refuses when markers remain ────────────
  // Use a distinct file (other.txt) so d1/d2 conflict with each other but not
  // with earlier tests' edits to shared.txt. Seed other.txt on main first.
  run(`git checkout main`, seedDir);
  run('git fetch -q origin', seedDir);
  run('git reset -q --hard origin/main', seedDir);
  fs.writeFileSync(path.join(seedDir, 'other.txt'), 'a\nb\nc\n', 'utf-8');
  run('git add -A && git commit -m other-seed', seedDir);
  run('git push origin main', seedDir);
  const d4base = run('git rev-parse main', seedDir);
  run(`git checkout -b feat/d1 ${d4base}`, seedDir);
  fs.writeFileSync(path.join(seedDir, 'other.txt'), 'a\nD1\nc\n', 'utf-8');
  run('git add -A && git commit -m d1', seedDir);
  run('git push -u origin feat/d1', seedDir);
  run('git checkout main', seedDir);
  run(`git checkout -b feat/d2 ${d4base}`, seedDir);
  fs.writeFileSync(path.join(seedDir, 'other.txt'), 'a\nD2\nc\n', 'utf-8');
  run('git add -A && git commit -m d2', seedDir);
  run('git push -u origin feat/d2', seedDir);
  run('git checkout main', seedDir);

  const d1 = await attemptMerge({ repoPath: repoDir, worktreesDir, source: 'feat/d1', target: 'main', noFf: true, ...AUTHOR });
  assert(d1.status === 'clean', `feat/d1 should merge clean, got ${d1.status} ${JSON.stringify(d1)}`);
  const d2 = await attemptMerge({ repoPath: repoDir, worktreesDir, source: 'feat/d2', target: 'main', noFf: true, ...AUTHOR });
  assert(d2.status === 'conflict', `feat/d2 should conflict, got ${d2.status}`);
  if (d2.status === 'conflict') {
    // Do NOT resolve — leave markers. finalize must report 'unresolved'.
    const finBad = await finalizeMerge({
      repoPath: repoDir, worktreePath: d2.worktreePath, source: 'feat/d2', target: 'main', ...AUTHOR,
    });
    assert(finBad.status === 'unresolved', `finalize should report unresolved, got ${finBad.status}`);
    assert(finBad.status === 'unresolved' && finBad.remainingMarkers.includes('other.txt'), 'other.txt should be listed as remaining');
    await cleanupIntegrationWorktree(repoDir, d2.worktreePath);
    console.log('Test 4: finalize refuses leftover markers → PASS');
  }

  // ─── Test 5: no leaked integration worktrees ─────────────────
  const wtList = run('git worktree list', repoDir);
  const integrationLines = wtList.split('\n').filter((l) => l.includes(`${path.sep}.integration${path.sep}`) || l.includes('/.integration/'));
  assert(integrationLines.length === 0, `expected no leaked integration worktrees, found:\n${integrationLines.join('\n')}`);
  console.log('Test 5: no leaked integration worktrees → PASS');

  console.log('✅ Host merge manager test passed');
} finally {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
}
