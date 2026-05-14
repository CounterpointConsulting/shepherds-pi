import simpleGit from 'simple-git';

export interface HostGitFinalizeInput {
  worktreePath: string;
  branch: string;
  persona: string;
  agentId: string;
  result: unknown;
  authorName: string;
  authorEmail: string;
}

export interface HostGitFinalizeResult {
  changed: boolean;
  pushed: boolean;
  branch: string;
  commitSha?: string;
  commitMessage?: string;
}

/**
 * Finalize agent changes on the host side (git add/commit/push).
 */
export async function finalizeAgentChanges(input: HostGitFinalizeInput): Promise<HostGitFinalizeResult> {
  const git = simpleGit(input.worktreePath);

  await git.addConfig('user.name', input.authorName, false, 'local');
  await git.addConfig('user.email', input.authorEmail, false, 'local');

  const status = await git.status();
  if (status.files.length === 0) {
    return {
      changed: false,
      pushed: false,
      branch: input.branch,
    };
  }

  await git.add(['-A']);

  const commitMessage = selectCommitMessage(input.result, input.persona, input.agentId);
  await git.commit(commitMessage);

  const commitSha = (await git.revparse(['HEAD'])).trim();

  let pushed = false;
  try {
    await git.push('origin', `HEAD:${input.branch}`);
    pushed = true;
  } catch {
    // Fall back to explicit set-upstream push when remote branch doesn't exist yet.
    await git.raw(['push', '--set-upstream', 'origin', input.branch]);
    pushed = true;
  }

  return {
    changed: true,
    pushed,
    branch: input.branch,
    commitSha,
    commitMessage,
  };
}

function selectCommitMessage(result: unknown, persona: string, agentId: string): string {
  if (isRecord(result)) {
    const commits = result.commits;
    if (Array.isArray(commits)) {
      const first = commits.find((x): x is string => typeof x === 'string' && x.trim().length > 0);
      if (first) return first.trim();
    }
  }

  return `feat: ${persona} changes (${agentId})`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
