#!/usr/bin/env node
/**
 * Test script for the agent runtime.
 *
 * This proves the core agent loop:
 * 1. Load config + persona
 * 2. Build Docker image (if needed)
 * 3. Spawn an agent container
 * 4. Monitor its output
 * 5. Read the structured result
 *
 * Usage:
 *   npx tsx src/test/spawn-agent.ts [persona] [instructions]
 *
 * Examples:
 *   npx tsx src/test/spawn-agent.ts architect "Analyze this codebase and suggest improvements"
 *   npx tsx src/test/spawn-agent.ts dba "Create a migration for a users table"
 *
 * Environment variables:
 *   OPENROUTER_API_KEY - Required for the agent's LLM access
 *   GIT_URL            - Repository URL (defaults to current git remote)
 *   GIT_TOKEN          - Personal access token for git
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig, findConfig, getGitToken } from '../config/index.js';
import { loadPersona } from '../persona/index.js';
import { spawnAgent, ensureImage } from '../agent/spawner.js';
import { WorktreeManager, type WorktreeLease } from '../git/worktree-manager.js';
import { finalizeAgentChanges } from '../git/host-git-manager.js';
import { ShepherdsDB } from '../db/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const personaName = process.argv[2] ?? 'architect';
  const instructions = process.argv[3] ?? 'Analyze this codebase and list the top 3 improvements you would recommend.';

  console.log('━━━ Shepherds Pi — Agent Runtime Test ━━━\n');

  // ─── Load config ──────────────────────────────────────────────
  const configPath = findConfig(process.cwd());
  if (!configPath) {
    console.error('No shepherds-pi.yaml found. Run from project root.');
    process.exit(1);
  }
  const config = loadConfig(configPath);
  console.log(`Config loaded from: ${configPath}`);
  console.log(`Project: ${config.project.name}`);
  console.log(`Docker image: ${config.docker.image}`);
  console.log(`Personas dir: ${config.personasDir}`);

  // ─── Load persona ─────────────────────────────────────────────
  const personaDir = path.join(config.personasDir, personaName);
  const persona = loadPersona(personaName, personaDir);
  if (!persona) {
    console.error(`Persona "${personaName}" not found at ${personaDir}`);
    console.error('Available personas: architect, dba, typescript-api-dev, typescript-react-dev, code-reviewer, web-tester, integrator');
    process.exit(1);
  }
  console.log(`\nPersona: ${persona.name}`);
  console.log(`Model: ${persona.model}`);
  console.log(`System prompt: ${persona.systemPrompt.substring(0, 80)}...`);

  // ─── Validate API key ─────────────────────────────────────────
  if (!config.openrouter.apiKey) {
    // Try reading from pi's auth storage
    try {
      const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? '';
      const authPath = path.join(homeDir, '.pi', 'agent', 'auth.json');
      const authData = JSON.parse(fs.readFileSync(authPath, 'utf-8'));
      config.openrouter.apiKey = authData?.openrouter?.key ?? '';
    } catch { /* ignore */ }
  }

  if (!config.openrouter.apiKey) {
    console.error('\nOPENROUTER_API_KEY not set. Set it in environment or shepherds-pi.yaml.');
    process.exit(1);
  }
  console.log(`API key: ${config.openrouter.apiKey.substring(0, 12)}...`);

  // ─── Determine git URL ────────────────────────────────────────
  let gitUrl = process.env.GIT_URL ?? '';
  if (!gitUrl) {
    // Try to get from current repo
    try {
      const { execSync } = await import('node:child_process');
      gitUrl = execSync('git remote get-url origin', { encoding: 'utf-8' }).trim();
      // Convert SSH to HTTPS if needed
      if (gitUrl.startsWith('git@')) {
        gitUrl = gitUrl.replace('git@github.com:', 'https://github.com/');
        gitUrl = gitUrl.replace(/\.git$/, '');
      }
      console.log(`\nGit URL (auto-detected): ${gitUrl}`);
    } catch {
      console.error('\nCould not detect git URL. Set GIT_URL environment variable.');
      process.exit(1);
    }
  }

  let gitToken = '';
  const needsGitToken = config.git.repoMode === 'clone' || config.git.gitOpsMode === 'container';
  if (needsGitToken) {
    gitToken = await getGitToken(config.agent.gitTokenEnv);
    if (!gitToken) {
      console.log(`\nWarning: ${config.agent.gitTokenEnv} not set. Clone may work for public repos, push may be skipped/fail.`);
    } else {
      console.log(`Git token: ${gitToken.substring(0, 8)}...`);
    }
  }

  // ─── Ensure Docker image ──────────────────────────────────────
  console.log('\nChecking Docker image...');
  try {
    await ensureImage(config.docker.image);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\nFailed to ensure Docker image: ${message}`);
    console.error('Run: npm run docker:build');
    process.exit(1);
  }

  // ─── Init DB ──────────────────────────────────────────────────
  const dbPath = path.join(config.project.repoPath, '.shepherds-pi', 'shepherds.db');
  const db = new ShepherdsDB(dbPath);

  const runId = `test-${Date.now()}`;
  db.createRun(runId, `Test: ${personaName} — ${instructions.substring(0, 50)}`);
  db.updateRunStatus(runId, 'executing');
  db.appendLog(runId, 'goal_set', { goal: instructions }, `Test spawn: ${personaName}`);

  // ─── Spawn agent ──────────────────────────────────────────────
  const agentId = `${personaName}-test-${Date.now()}`;
  const branchName = process.env.SHEPHERDS_TEST_BRANCH
    ?? (config.git.repoMode === 'worktree' ? `shepherds-test/${Date.now()}` : config.project.devBranch);

  const worktreeManager = config.git.repoMode === 'worktree'
    ? new WorktreeManager({
      repoPath: config.project.repoPath,
      worktreesDir: config.git.worktreesDir,
      resetBeforeRun: config.git.resetWorktreeBeforeRun,
    })
    : null;

  let lease: WorktreeLease | null = null;

  console.log(`\nSpawning agent: ${agentId}`);
  console.log(`Branch: ${branchName}`);
  console.log(`Instructions: ${instructions}`);
  console.log('─'.repeat(50));

  db.createAgentRun({
    id: agentId,
    run_id: runId,
    step_id: null,
    persona: persona.name,
    model: persona.model,
    instructions,
    context: null,
    branch: branchName,
    container_id: null,
    status: 'spawning',
    result: null,
    started_at: new Date().toISOString(),
    completed_at: null,
  });

  db.appendLog(runId, 'agent_spawned', { agentId, persona: persona.name, branch: branchName }, `Agent spawned: ${agentId}`);

  const startTime = Date.now();

  try {
    if (worktreeManager) {
      lease = await worktreeManager.acquire({
        branch: branchName,
        baseBranch: config.project.devBranch,
        agentId,
      });
      console.log(`Using worktree: ${lease.worktreePath}`);
    }

    const result = await spawnAgent({
      agentId,
      persona,
      instructions,
      branch: branchName,
      repoMode: config.git.repoMode,
      gitOpsMode: config.git.gitOpsMode,
      worktreePath: lease?.worktreePath,
      gitUrl: config.git.repoMode === 'clone' ? gitUrl : undefined,
      gitToken,
      config,
      onEvent: (event) => {
        // Surface container stderr for diagnosis
        if (event.type === 'container_stderr') {
          console.log(`  📦 ${event.line}`);
          return;
        }
        // Print key events
        if (event.type === 'agent_start') {
          console.log('[agent_start]');
        } else if (event.type === 'turn_start') {
          console.log('[turn_start]');
        } else if (event.type === 'tool_execution_start') {
          const name = (event as Record<string, unknown>).toolName ?? 'unknown';
          const args = (event as Record<string, unknown>).args ?? {};
          // Show a compact version of what the agent is doing
          if (name === 'read') console.log(`  📖 Reading: ${(args as Record<string, unknown>).path ?? ''}`);
          else if (name === 'write') console.log(`  ✏️  Writing: ${(args as Record<string, unknown>).path ?? ''}`);
          else if (name === 'edit') console.log(`  🔧 Editing: ${(args as Record<string, unknown>).path ?? ''}`);
          else if (name === 'bash') console.log(`  💻 Running: ${String((args as Record<string, unknown>).command ?? '').substring(0, 60)}`);
          else console.log(`  🔧 Tool: ${name}`);
        } else if (event.type === 'agent_end') {
          console.log('[agent_end]');
        }
      },
      onStdout: () => {
        // Don't print raw JSON lines — the onEvent handler covers the interesting ones
      },
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log('─'.repeat(50));
    console.log(`\nAgent exited with code: ${result.exitCode} (${elapsed}s)`);

    let agentStatus: 'done' | 'failed' = 'failed';
    if (result.result && result.exitCode === 0) {
      agentStatus = (result.result.status === 'success' || result.result.status === 'approved') ? 'done' : 'failed';
    }

    if (agentStatus === 'done' && config.git.gitOpsMode === 'host') {
      if (!lease) {
        throw new Error('Host git mode enabled but no worktree lease is available for finalization.');
      }

      const hostGit = await finalizeAgentChanges({
        worktreePath: lease.worktreePath,
        branch: branchName,
        persona: persona.name,
        agentId,
        result: result.result,
        authorName: config.git.authorName,
        authorEmail: config.git.authorEmail,
      });

      console.log(`Host git finalize: changed=${hostGit.changed}, pushed=${hostGit.pushed}, branch=${hostGit.branch}`);
      if (hostGit.commitSha) {
        console.log(`Host commit: ${hostGit.commitSha.substring(0, 8)} ${hostGit.commitMessage ?? ''}`.trim());
      }
    }

    if (result.result) {
      console.log('\n━━━ Agent Result ━━━');
      console.log(JSON.stringify(result.result, null, 2));
      db.updateAgentStatus(agentId, agentStatus, JSON.stringify(result.result));

      if (agentStatus === 'done') {
        db.appendLog(runId, 'agent_completed', { agentId, status: result.result.status }, `Agent completed: ${agentId} — ${result.result.summary}`);
      } else {
        db.appendLog(runId, 'agent_failed', { agentId, status: result.result.status }, `Agent failed: ${agentId} — ${result.result.summary}`);
      }
    } else {
      console.log('\n⚠️  No result.json produced by agent.');
      db.updateAgentStatus(agentId, 'failed');
      db.appendLog(runId, 'agent_failed', { agentId }, `Agent failed: ${agentId} — no result`);
    }

    db.updateRunStatus(runId, agentStatus === 'done' ? 'completed' : 'failed');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\n❌ Agent spawn failed: ${message}`);
    db.updateAgentStatus(agentId, 'failed');
    db.updateRunStatus(runId, 'failed');
  } finally {
    if (lease) {
      worktreeManager?.release(lease.leaseId);
    }
    db.close();
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
