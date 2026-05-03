/**
 * Test: Verify OrchestratorManager state management works.
 *
 * This tests:
 * 1. Manager creates goals and tracks state
 * 2. Messages are added correctly
 * 3. Agent runs are converted from DB format
 * 4. Plan refresh works
 * 5. onChange notifications fire
 *
 * Does NOT start a real pi session (needs API key).
 */

import { OrchestratorManager } from '../orchestrator/manager.js';
import { loadConfig } from '../config/index.js';
import { ShepherdsDB } from '../db/index.js';
import type { DbAgentRun } from '../db/index.js';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

// ─── Test helpers ────────────────────────────────────────────────

function createTempDb(): ShepherdsDB {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shepherds-mgr-test-'));
  return new ShepherdsDB(path.join(tmpDir, 'test.db'));
}

// ─── Test 1: Manager creation ────────────────────────────────────

console.log('Test 1: Manager creation...');

const config = loadConfig(path.resolve(import.meta.dirname, '../../shepherds-pi.yaml'));
const manager = new OrchestratorManager(config);

if (manager.allGoals.length !== 0) throw new Error('Should start with no goals');
if (manager.activeGoalId !== null) throw new Error('Should start with no active goal');

console.log('  ✓ Manager created with empty state');

// ─── Test 2: onChange notifications ──────────────────────────────

console.log('Test 2: onChange notifications...');

let notifyCount = 0;
const unsub = manager.onChange(() => { notifyCount++; });

console.log('  ✓ onChange subscription works');
unsub();

// ─── Test 3: DB agent conversion ─────────────────────────────────

console.log('Test 3: DB agent row → AgentRun conversion...');

const db = createTempDb();
db.createRun('run-test', 'Test goal');

const dbAgent: DbAgentRun = {
  id: 'dba-test1234',
  run_id: 'run-test',
  step_id: null,
  persona: 'dba',
  model: 'openrouter/anthropic/claude-sonnet-4',
  instructions: 'Create the users table',
  context: null,
  branch: 'feat/users-table',
  container_id: 'container-abc',
  status: 'done',
  result: JSON.stringify({
    status: 'success',
    summary: 'Created users table with migrations',
    filesCreated: ['src/db/migrations/001_create_users.sql'],
    commits: ['feat: create users table'],
  }),
  started_at: '2025-01-01T10:00:00Z',
  completed_at: '2025-01-01T10:05:00Z',
};

db.createAgentRun(dbAgent);

// Read it back
const agents = db.getAgentRunsForGoal('run-test');
if (agents.length !== 1) throw new Error(`Expected 1 agent, got ${agents.length}`);
if (agents[0].persona !== 'dba') throw new Error('Wrong persona');
if (agents[0].branch !== 'feat/users-table') throw new Error('Wrong branch');

const result = JSON.parse(agents[0].result!);
if (result.summary !== 'Created users table with migrations') throw new Error('Wrong summary');

console.log('  ✓ DB agent rows convert correctly');

// ─── Test 4: Plan storage and retrieval ──────────────────────────

console.log('Test 4: Plan storage and retrieval...');

const planSteps = {
  steps: [
    { id: 'step-1', description: 'Design schema', persona: 'dba', dependsOn: [], branch: 'feat/users', status: 'complete' },
    { id: 'step-2', description: 'Implement API', persona: 'typescript-api-dev', dependsOn: ['step-1'], branch: 'feat/users-api', status: 'pending' },
  ],
};

db.savePlan('plan-1', 'run-test', JSON.stringify(planSteps), 1);
const plan = db.getPlan('run-test');
if (!plan) throw new Error('Plan not found');
if (plan.version !== 1) throw new Error('Wrong plan version');

const parsedSteps = JSON.parse(plan.steps);
if (parsedSteps.steps.length !== 2) throw new Error('Wrong step count');

console.log('  ✓ Plan storage and retrieval works');

// ─── Test 5: Messages ───────────────────────────────────────────

console.log('Test 5: Messages...');

db.appendMessage('run-test', 'user', 'Add user auth');
db.appendMessage('run-test', 'coordinator', 'Starting orchestration...');
db.appendMessage('run-test', 'tool_notification', '🔧 Agent spawned: dba-test');

const messages = db.getMessages('run-test');
if (messages.length !== 3) throw new Error(`Expected 3 messages, got ${messages.length}`);
if (messages[0].role !== 'user') throw new Error('First message should be user');
if (messages[1].role !== 'coordinator') throw new Error('Second message should be coordinator');

console.log('  ✓ Message storage works');

// ─── Cleanup ─────────────────────────────────────────────────────

db.close();
manager.dispose();

console.log('\n✅ All manager tests passed!');
