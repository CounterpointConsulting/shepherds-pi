import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { finalizeAgentChanges } from '../git/host-git-manager.js';

function run(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, stdio: 'pipe', encoding: 'utf-8' }).trim();
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shepherds-hostgit-test-'));
const remoteDir = path.join(tmpRoot, 'remote.git');
const seedDir = path.join(tmpRoot, 'seed');
const workDir = path.join(tmpRoot, 'work');

try {
  fs.mkdirSync(remoteDir, { recursive: true });
  run('git init --bare', remoteDir);

  fs.mkdirSync(seedDir, { recursive: true });
  run('git init -b main', seedDir);
  run('git config user.name "Test User"', seedDir);
  run('git config user.email "test@example.com"', seedDir);
  fs.writeFileSync(path.join(seedDir, 'README.md'), 'hello\n', 'utf-8');
  run('git add README.md', seedDir);
  run('git commit -m "seed"', seedDir);
  run(`git remote add origin "${remoteDir}"`, seedDir);
  run('git push -u origin main', seedDir);
  run('git symbolic-ref HEAD refs/heads/main', remoteDir);

  run(`git clone -b main "${remoteDir}" "${workDir}"`, tmpRoot);

  fs.writeFileSync(path.join(workDir, 'README.md'), 'hello\nworld\n', 'utf-8');

  const res1 = await finalizeAgentChanges({
    worktreePath: workDir,
    branch: 'main',
    persona: 'typescript-api-dev',
    agentId: 'agent-1',
    result: { commits: ['feat: add world line'] },
    authorName: 'Shepherds Pi Agent',
    authorEmail: 'agent@shepherds-pi.dev',
  });

  if (!res1.changed || !res1.pushed || !res1.commitSha) {
    throw new Error('Expected changed+pushed commit result');
  }

  const res2 = await finalizeAgentChanges({
    worktreePath: workDir,
    branch: 'main',
    persona: 'typescript-api-dev',
    agentId: 'agent-2',
    result: {},
    authorName: 'Shepherds Pi Agent',
    authorEmail: 'agent@shepherds-pi.dev',
  });

  if (res2.changed || res2.pushed) {
    throw new Error('Expected no-op finalize when no changes exist');
  }

  console.log('✅ Host git manager test passed');
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}
