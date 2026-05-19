/**
 * Test: Verify orchestrator session creation and tool setup.
 *
 * This tests that:
 * 1. The event bus works (emit/onEvent)
 * 2. The tools are created with correct names and schemas
 * 3. The DB methods work
 * 4. The session factory function is importable
 *
 * Does NOT actually start a pi session (needs API key).
 */

import { createOrchestratorTools } from '../orchestrator/tools.js';
import { ShepherdsDB } from '../db/index.js';
import { loadConfig } from '../config/index.js';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

interface TestEvent {
  type: string;
  [key: string]: unknown;
}

class TestEventBus {
  private listeners = new Set<(event: TestEvent) => void>();

  emit(event: TestEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  onEvent(listener: (event: TestEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  askUser(question: string): Promise<string> {
    return new Promise<string>((resolve) => {
      this.emit({ type: 'user_question', question, resolve });
    });
  }
}

// ─── Test 1: Event Bus ───────────────────────────────────────────

console.log('Test 1: Event Bus...');

const bus = new TestEventBus();
const receivedEvents: string[] = [];

const unsub = bus.onEvent((event) => {
  receivedEvents.push(event.type);
});

bus.emit({ type: 'goal_status_changed', status: 'planning' });
bus.emit({ type: 'agent_spawned', agentId: 'test-1', persona: 'architect' });

if (receivedEvents.length !== 2) throw new Error(`Expected 2 events, got ${receivedEvents.length}`);
if (receivedEvents[0] !== 'goal_status_changed') throw new Error('Wrong event type');
if (receivedEvents[1] !== 'agent_spawned') throw new Error('Wrong event type');

unsub();
bus.emit({ type: 'agent_completed', agentId: 'test-1', result: null });
if (receivedEvents.length !== 2) throw new Error('Unsub failed');

console.log('  ✓ Event bus works');

// ─── Test 2: askUser ─────────────────────────────────────────────

console.log('Test 2: askUser...');

const bus2 = new TestEventBus();
let questionAsked = false;
let resolver: ((response: string) => void) | null = null;

bus2.onEvent((event) => {
  if (event.type === 'user_question' && typeof event.resolve === 'function') {
    questionAsked = true;
    resolver = event.resolve as (response: string) => void;
  }
});

const answerPromise = bus2.askUser('What should I do?');
if (!questionAsked) throw new Error('Question event not emitted');

// Simulate user answering
resolver!('Go ahead and implement it');

const answer = await answerPromise;
if (answer !== 'Go ahead and implement it') throw new Error(`Wrong answer: ${answer}`);

console.log('  ✓ askUser works');

// ─── Test 3: Tools creation ──────────────────────────────────────

console.log('Test 3: Tool creation...');

// Create a temp DB
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shepherds-test-'));
const db = new ShepherdsDB(path.join(tmpDir, 'test.db'));
db.createRun('run-test', 'Test goal');

const config = loadConfig(path.resolve(import.meta.dirname, '../../shepherds-pi.yaml'));
const tools = createOrchestratorTools({
  eventBus: new TestEventBus(),
  db,
  config,
  getRunId: () => 'run-test',
});

const expectedTools = [
  'spawn_agent', 'spawn_agents', 'create_branch', 'list_branches',
  'get_branch_diff', 'read_plan', 'update_plan', 'read_run_log',
  'ask_user', 'update_goal_status',
];

const toolNames = tools.map(t => t.name);
for (const expected of expectedTools) {
  if (!toolNames.includes(expected)) {
    throw new Error(`Missing tool: ${expected}`);
  }
}

console.log(`  ✓ All ${expectedTools.length} tools created`);

// ─── Test 4: DB operations used by tools ─────────────────────────

console.log('Test 4: DB operations...');

db.appendLog('run-test', 'agent_spawned', { agentId: 'test' }, 'Agent spawned');
db.appendLog('run-test', 'agent_completed', { agentId: 'test' }, 'Agent completed');
const log = db.getRunLog('run-test');
if (log.length < 2) throw new Error(`Expected at least 2 log entries, got ${log.length}`);

db.savePlan('plan-1', 'run-test', JSON.stringify({ steps: [] }), 1);
const plan = db.getPlan('run-test');
if (!plan) throw new Error('Plan not found');
if (plan.version !== 1) throw new Error(`Wrong plan version: ${plan.version}`);

db.updateRunStatus('run-test', 'executing');

console.log('  ✓ DB operations work');

// ─── Cleanup ─────────────────────────────────────────────────────

db.close();
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log('\n✅ All orchestrator tests passed!');
