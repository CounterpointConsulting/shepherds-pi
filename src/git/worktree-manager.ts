import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import simpleGit from 'simple-git';

export interface WorktreeLease {
  leaseId: string;
  branch: string;
  baseBranch: string;
  worktreePath: string;
  agentId: string;
  acquiredAt: string;
}

interface WorktreeManagerOptions {
  repoPath: string;
  worktreesDir: string;
  resetBeforeRun: boolean;
}

interface AcquireInput {
  branch: string;
  baseBranch: string;
  agentId: string;
}

interface BranchLockPayload {
  leaseId: string;
  branch: string;
  agentId: string;
  pid: number;
  acquiredAt: string;
  hostname: string;
}

const STALE_LOCK_MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12h

/**
 * Host-side manager for branch worktrees and branch leasing.
 *
 * Locking model:
 * - in-process map (fast path)
 * - file lock in <worktreesDir>/.locks for cross-process safety
 */
export class WorktreeManager {
  private readonly repoPath: string;
  private readonly worktreesDir: string;
  private readonly resetBeforeRun: boolean;
  private readonly locksDir: string;

  private readonly activeBranchLeases = new Map<string, string>();
  private readonly leases = new Map<string, WorktreeLease>();
  private readonly leaseLockFiles = new Map<string, string>();

  constructor(options: WorktreeManagerOptions) {
    this.repoPath = options.repoPath;
    this.worktreesDir = options.worktreesDir;
    this.resetBeforeRun = options.resetBeforeRun;
    this.locksDir = path.join(this.worktreesDir, '.locks');
  }

  async acquire(input: AcquireInput): Promise<WorktreeLease> {
    const { branch, baseBranch, agentId } = input;

    const existingLeaseId = this.activeBranchLeases.get(branch);
    if (existingLeaseId) {
      throw new Error(`Branch "${branch}" is already in use by lease ${existingLeaseId}`);
    }

    await fs.promises.mkdir(this.worktreesDir, { recursive: true });
    await fs.promises.mkdir(this.locksDir, { recursive: true });

    const leaseId = `lease-${crypto.randomUUID().slice(0, 8)}`;
    let lockFilePath: string | null = null;

    try {
      lockFilePath = await this.acquireBranchFileLock(branch, {
        leaseId,
        branch,
        agentId,
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
        hostname: os.hostname(),
      });

      this.activeBranchLeases.set(branch, leaseId);

      const repoGit = simpleGit(this.repoPath);
      await repoGit.fetch('origin');

      const worktreePath = this.getWorktreePathForBranch(branch);
      await this.ensureBranchWorktree(repoGit, branch, baseBranch, worktreePath);

      if (this.resetBeforeRun) {
        await this.resetWorktree(worktreePath, branch, baseBranch);
      }

      const lease: WorktreeLease = {
        leaseId,
        branch,
        baseBranch,
        worktreePath,
        agentId,
        acquiredAt: new Date().toISOString(),
      };

      this.leases.set(leaseId, lease);
      this.leaseLockFiles.set(leaseId, lockFilePath);
      return lease;
    } catch (err) {
      if (this.activeBranchLeases.get(branch) === leaseId) {
        this.activeBranchLeases.delete(branch);
      }
      if (lockFilePath) {
        this.releaseFileLock(lockFilePath);
      }
      throw err;
    }
  }

  release(leaseId: string): void {
    const lease = this.leases.get(leaseId);
    this.leases.delete(leaseId);

    if (lease && this.activeBranchLeases.get(lease.branch) === leaseId) {
      this.activeBranchLeases.delete(lease.branch);
    }

    const lockFilePath = this.leaseLockFiles.get(leaseId);
    this.leaseLockFiles.delete(leaseId);
    if (lockFilePath) {
      this.releaseFileLock(lockFilePath);
    }
  }

  private getWorktreePathForBranch(branch: string): string {
    const { safe, hash } = safeBranchKey(branch);
    return path.join(this.worktreesDir, `${safe}-${hash}`);
  }

  private getLockFilePathForBranch(branch: string): string {
    const { safe, hash } = safeBranchKey(branch);
    return path.join(this.locksDir, `${safe}-${hash}.lock`);
  }

  private async acquireBranchFileLock(branch: string, payload: BranchLockPayload): Promise<string> {
    const lockFilePath = this.getLockFilePathForBranch(branch);

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const fd = fs.openSync(lockFilePath, 'wx', 0o600);
        try {
          fs.writeFileSync(fd, JSON.stringify(payload, null, 2), 'utf-8');
        } finally {
          fs.closeSync(fd);
        }
        return lockFilePath;
      } catch (err: unknown) {
        if (!isNodeErrno(err, 'EEXIST')) {
          throw err;
        }

        const existing = this.readBranchLockFile(lockFilePath);
        if (!existing || this.isStaleLock(existing)) {
          try {
            fs.unlinkSync(lockFilePath);
          } catch {
            // If another process removed/replaced it between read and unlink,
            // we'll just retry lock acquisition in the next loop iteration.
          }
          continue;
        }

        throw new Error(
          `Branch "${branch}" is locked by lease ${existing.leaseId} ` +
          `(agent ${existing.agentId}, pid ${existing.pid}, host ${existing.hostname})`,
        );
      }
    }

    throw new Error(`Could not acquire lock for branch "${branch}" after retries`);
  }

  private readBranchLockFile(lockFilePath: string): BranchLockPayload | null {
    try {
      const raw = fs.readFileSync(lockFilePath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<BranchLockPayload>;
      if (!parsed || typeof parsed !== 'object') return null;

      if (typeof parsed.leaseId !== 'string' ||
          typeof parsed.branch !== 'string' ||
          typeof parsed.agentId !== 'string' ||
          typeof parsed.pid !== 'number' ||
          typeof parsed.acquiredAt !== 'string' ||
          typeof parsed.hostname !== 'string') {
        return null;
      }

      return {
        leaseId: parsed.leaseId,
        branch: parsed.branch,
        agentId: parsed.agentId,
        pid: parsed.pid,
        acquiredAt: parsed.acquiredAt,
        hostname: parsed.hostname,
      };
    } catch {
      return null;
    }
  }

  private isStaleLock(lock: BranchLockPayload): boolean {
    const acquiredAtMs = Date.parse(lock.acquiredAt);
    if (!Number.isFinite(acquiredAtMs)) return true;

    if (!isPidAlive(lock.pid)) return true;

    const ageMs = Date.now() - acquiredAtMs;
    return ageMs > STALE_LOCK_MAX_AGE_MS;
  }

  private releaseFileLock(lockFilePath: string): void {
    try {
      fs.unlinkSync(lockFilePath);
    } catch {
      // best effort
    }
  }

  private async ensureBranchWorktree(
    repoGit: ReturnType<typeof simpleGit>,
    branch: string,
    baseBranch: string,
    worktreePath: string,
  ): Promise<void> {
    // Remove stale "missing but registered" worktree records.
    await repoGit.raw(['worktree', 'prune']);

    const existing = await this.findWorktree(repoGit, worktreePath);

    if (existing && existing.branch === branch) {
      return;
    }

    if (existing && existing.branch !== branch) {
      await repoGit.raw(['worktree', 'remove', '--force', worktreePath]);
    }

    if (fs.existsSync(worktreePath) && !existing) {
      // Path exists but wasn't matched in `worktree list` (which can happen on
      // Windows due to short-path aliasing). If it's a git worktree, reuse it.
      try {
        const wtGit = simpleGit(worktreePath);
        const inside = (await wtGit.revparse(['--is-inside-work-tree'])).trim();
        if (inside === 'true') {
          return;
        }
      } catch {
        // Not a git worktree; remove stale directory and recreate.
      }

      fs.rmSync(worktreePath, { recursive: true, force: true });
    }

    const localBranchExists = await this.refExists(repoGit, `refs/heads/${branch}`);
    const remoteBranchExists = await this.refExists(repoGit, `refs/remotes/origin/${branch}`);

    if (localBranchExists) {
      await repoGit.raw(['worktree', 'add', '-f', worktreePath, branch]);
      return;
    }

    if (remoteBranchExists) {
      await repoGit.raw(['worktree', 'add', '-f', '-b', branch, worktreePath, `origin/${branch}`]);
      return;
    }

    await repoGit.raw(['worktree', 'add', '-f', '-b', branch, worktreePath, `origin/${baseBranch}`]);
  }

  private async resetWorktree(worktreePath: string, branch: string, baseBranch: string): Promise<void> {
    const git = simpleGit(worktreePath);
    await git.fetch('origin');

    try {
      await git.checkout(branch);
    } catch {
      await git.checkoutLocalBranch(branch);
    }

    const remoteBranchExists = await this.refExists(git, `refs/remotes/origin/${branch}`);
    if (remoteBranchExists) {
      await git.reset(['--hard', `origin/${branch}`]);
    } else {
      const remoteBaseExists = await this.refExists(git, `refs/remotes/origin/${baseBranch}`);
      if (remoteBaseExists) {
        await git.reset(['--hard', `origin/${baseBranch}`]);
      }
    }

    await git.raw(['clean', '-fd']);
  }

  private async refExists(git: ReturnType<typeof simpleGit>, ref: string): Promise<boolean> {
    try {
      const out = await git.raw(['rev-parse', '--verify', '--quiet', ref]);
      return out.trim().length > 0;
    } catch {
      return false;
    }
  }

  private async findWorktree(git: ReturnType<typeof simpleGit>, targetPath: string): Promise<{ path: string; branch: string | null } | null> {
    const out = await git.raw(['worktree', 'list', '--porcelain']);
    const blocks = out.split('\n\n').map(b => b.trim()).filter(Boolean);

    const normalizedTarget = normalizePathForComparison(targetPath);

    for (const block of blocks) {
      const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
      const pathLine = lines.find(l => l.startsWith('worktree '));
      if (!pathLine) continue;

      const wtPath = pathLine.substring('worktree '.length).trim();
      if (normalizePathForComparison(wtPath) !== normalizedTarget) continue;

      const branchLine = lines.find(l => l.startsWith('branch '));
      const branchRef = branchLine?.substring('branch '.length).trim() ?? null;
      const branch = branchRef?.startsWith('refs/heads/')
        ? branchRef.substring('refs/heads/'.length)
        : branchRef;

      return { path: wtPath, branch };
    }

    return null;
  }
}

function safeBranchKey(branch: string): { safe: string; hash: string } {
  const safe = branch.replace(/[^a-zA-Z0-9._-]+/g, '__').replace(/^\.+/, 'branch');
  const hash = crypto.createHash('sha1').update(branch).digest('hex').slice(0, 8);
  return { safe, hash };
}

function normalizePathForComparison(value: string): string {
  let resolved = path.resolve(value);
  try {
    resolved = fs.realpathSync.native(resolved);
  } catch {
    // Keep resolved path when realpath cannot resolve missing targets.
  }
  return resolved.replace(/\\/g, '/').toLowerCase();
}

function isNodeErrno(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: string }).code === code;
}

function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    if (isNodeErrno(err, 'EPERM')) return true;
    return false;
  }
}
