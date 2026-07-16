import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import simpleGit from 'simple-git';

/**
 * Host-side branch integration.
 *
 * All git mutation happens on the HOST via an EPHEMERAL, DETACHED worktree
 * created under <worktreesDir>/.integration/. The coordinator and agents never
 * run git themselves — the coordinator invokes the merge_branch tool, and (on
 * conflict) a resolver agent only edits files in the worktree while the host
 * performs every git operation.
 *
 * Model (consistent with the rest of the system, which is origin-centric):
 *   - fetch origin
 *   - `git worktree add --detach <tmp> origin/<target>`
 *   - `git merge --no-ff --no-edit origin/<source>`
 *   - clean  -> commit (implicit via merge) + `push origin HEAD:<target>`, cleanup
 *   - conflict -> leave the worktree in place with conflict markers, report the
 *                 conflicted files so a resolver agent can fix them; the host
 *                 then finalizeMerge()s (add -A, commit, push) and cleans up.
 *
 * The detached worktree never checks out the target branch as a branch, so it
 * cannot collide with an agent worktree that has the target checked out.
 */

export interface AttemptMergeInput {
  repoPath: string;
  worktreesDir: string;
  source: string;
  target: string;
  authorName: string;
  authorEmail: string;
  noFf: boolean;
}

export type AttemptMergeResult =
  | { status: 'clean'; target: string; source: string; commitSha: string; worktreePath: null }
  | { status: 'up-to-date'; target: string; source: string; worktreePath: null }
  | { status: 'conflict'; target: string; source: string; worktreePath: string; conflictedFiles: string[] }
  | { status: 'error'; target: string; source: string; message: string; worktreePath: null };

export interface FinalizeMergeInput {
  repoPath: string;
  worktreePath: string;
  source: string;
  target: string;
  authorName: string;
  authorEmail: string;
}

export type FinalizeMergeResult =
  | { status: 'clean'; target: string; source: string; commitSha: string }
  | { status: 'unresolved'; target: string; source: string; remainingMarkers: string[] }
  | { status: 'error'; target: string; source: string; message: string };

function integrationRoot(worktreesDir: string): string {
  return path.join(worktreesDir, '.integration');
}

function newIntegrationWorktreePath(worktreesDir: string, target: string): string {
  const safe = target.replace(/[^a-zA-Z0-9._-]+/g, '__').replace(/^\.+/, 'branch');
  const rand = crypto.randomUUID().slice(0, 8);
  return path.join(integrationRoot(worktreesDir), `${safe}-${rand}`);
}

/**
 * Remove an ephemeral integration worktree (best effort). Always safe to call.
 */
export async function cleanupIntegrationWorktree(repoPath: string, worktreePath: string): Promise<void> {
  const git = simpleGit(repoPath);
  try {
    await git.raw(['worktree', 'remove', '--force', worktreePath]);
  } catch {
    // Fall back to manual removal if git refuses (e.g. path already gone).
    try {
      fs.rmSync(worktreePath, { recursive: true, force: true });
    } catch { /* ignore */ }
  }
  try {
    await git.raw(['worktree', 'prune']);
  } catch { /* ignore */ }
}

async function refExists(git: ReturnType<typeof simpleGit>, ref: string): Promise<boolean> {
  try {
    const out = await git.raw(['rev-parse', '--verify', '--quiet', ref]);
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Attempt to merge source into target on the host. On conflict, leaves the
 * integration worktree in place (with conflict markers) for a resolver agent.
 */
export async function attemptMerge(input: AttemptMergeInput): Promise<AttemptMergeResult> {
  const { repoPath, worktreesDir, source, target, authorName, authorEmail, noFf } = input;
  const repoGit = simpleGit(repoPath);

  try {
    await repoGit.fetch(['origin', '--prune']);
  } catch (err) {
    return { status: 'error', target, source, message: `git fetch failed: ${errMsg(err)}`, worktreePath: null };
  }

  if (!(await refExists(repoGit, `refs/remotes/origin/${target}`))) {
    return { status: 'error', target, source, message: `target branch origin/${target} does not exist`, worktreePath: null };
  }
  if (!(await refExists(repoGit, `refs/remotes/origin/${source}`))) {
    return { status: 'error', target, source, message: `source branch origin/${source} does not exist`, worktreePath: null };
  }

  await fs.promises.mkdir(integrationRoot(worktreesDir), { recursive: true });
  const worktreePath = newIntegrationWorktreePath(worktreesDir, target);

  try {
    await repoGit.raw(['worktree', 'prune']);
    // Detached checkout at the current target tip — never checks out the branch
    // itself, so it cannot collide with an agent worktree on `target`.
    await repoGit.raw(['worktree', 'add', '--detach', worktreePath, `origin/${target}`]);
  } catch (err) {
    await cleanupIntegrationWorktree(repoPath, worktreePath);
    return { status: 'error', target, source, message: `could not create integration worktree: ${errMsg(err)}`, worktreePath: null };
  }

  const wt = simpleGit(worktreePath);
  await wt.addConfig('user.name', authorName, false, 'local');
  await wt.addConfig('user.email', authorEmail, false, 'local');

  // Already up to date? (target already contains source.)
  try {
    const behind = (await wt.raw(['rev-list', '--count', `HEAD..origin/${source}`])).trim();
    if (behind === '0') {
      await cleanupIntegrationWorktree(repoPath, worktreePath);
      return { status: 'up-to-date', target, source, worktreePath: null };
    }
  } catch { /* fall through to a real merge attempt */ }

  const mergeArgs = ['merge', '--no-edit'];
  if (noFf) mergeArgs.push('--no-ff');
  mergeArgs.push(`origin/${source}`);

  // NOTE: simple-git does NOT throw on a merge *conflict* — it resolves with the
  // CONFLICT text. It only throws on hard errors. So we must inspect the working
  // tree status after the call regardless of whether it threw.
  let mergeThrew: unknown = null;
  try {
    await wt.raw(mergeArgs);
  } catch (err) {
    mergeThrew = err;
  }

  const status = await wt.status();
  if (status.conflicted.length > 0) {
    return {
      status: 'conflict',
      target,
      source,
      worktreePath,
      conflictedFiles: status.conflicted.slice(),
    };
  }

  if (mergeThrew) {
    // Threw but not a conflict — abort any partial merge and clean up.
    try { await wt.raw(['merge', '--abort']); } catch { /* ignore */ }
    await cleanupIntegrationWorktree(repoPath, worktreePath);
    return { status: 'error', target, source, message: `merge failed: ${errMsg(mergeThrew)}`, worktreePath: null };
  }

  // Clean merge — HEAD is now the merge commit. Push to the target ref.
  try {
    const commitSha = (await wt.revparse(['HEAD'])).trim();
    await wt.push('origin', `HEAD:${target}`);
    await cleanupIntegrationWorktree(repoPath, worktreePath);
    return { status: 'clean', target, source, commitSha, worktreePath: null };
  } catch (err) {
    await cleanupIntegrationWorktree(repoPath, worktreePath);
    return { status: 'error', target, source, message: `push failed: ${errMsg(err)}`, worktreePath: null };
  }
}

const CONFLICT_MARKER_RE = /^(<{7}|={7}|>{7})/m;

/**
 * After a resolver agent has edited the conflicted files in the integration
 * worktree, complete the merge on the host: verify no conflict markers remain,
 * stage everything, commit the merge, push to target, and clean up.
 */
export async function finalizeMerge(input: FinalizeMergeInput): Promise<FinalizeMergeResult> {
  const { repoPath, worktreePath, source, target, authorName, authorEmail } = input;

  if (!fs.existsSync(worktreePath)) {
    return { status: 'error', target, source, message: `integration worktree missing: ${worktreePath}` };
  }

  const wt = simpleGit(worktreePath);
  await wt.addConfig('user.name', authorName, false, 'local');
  await wt.addConfig('user.email', authorEmail, false, 'local');

  // Re-check which files git still considers conflicted, and scan them for
  // leftover conflict markers (agent may have edited but not fully resolved).
  const status = await wt.status();
  const suspectFiles = new Set<string>(status.conflicted);

  const remainingMarkers: string[] = [];
  for (const file of suspectFiles) {
    const abs = path.join(worktreePath, file);
    try {
      const content = fs.readFileSync(abs, 'utf-8');
      if (CONFLICT_MARKER_RE.test(content)) remainingMarkers.push(file);
    } catch {
      // Unreadable/deleted — treat as resolved (git add -A will capture deletions).
    }
  }

  if (remainingMarkers.length > 0) {
    return { status: 'unresolved', target, source, remainingMarkers };
  }

  try {
    await wt.add(['-A']);
    // Complete the merge commit. MERGE_HEAD is still set from attemptMerge, so a
    // plain commit produces the merge commit with both parents.
    await wt.commit(`Merge branch '${source}' into ${target}`);
    const commitSha = (await wt.revparse(['HEAD'])).trim();
    await wt.push('origin', `HEAD:${target}`);
    // Success: the merge lifecycle is complete, so tear down the worktree here.
    await cleanupIntegrationWorktree(repoPath, worktreePath);
    return { status: 'clean', target, source, commitSha };
  } catch (err) {
    return { status: 'error', target, source, message: `finalize failed: ${errMsg(err)}` };
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
