import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

const MIGRATIONS = [
  // Migration 1: Initial schema
  `
    CREATE TABLE IF NOT EXISTS runs (
      id            TEXT PRIMARY KEY,
      goal          TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'planning',
      created_at    TEXT DEFAULT (datetime('now')),
      updated_at    TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS plans (
      id            TEXT PRIMARY KEY,
      run_id        TEXT NOT NULL REFERENCES runs(id),
      steps         TEXT NOT NULL,
      version       INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS agent_runs (
      id            TEXT PRIMARY KEY,
      run_id        TEXT NOT NULL REFERENCES runs(id),
      step_id       TEXT,
      persona       TEXT NOT NULL,
      model         TEXT NOT NULL,
      instructions  TEXT NOT NULL,
      context       TEXT,
      branch        TEXT,
      container_id  TEXT,
      status        TEXT NOT NULL DEFAULT 'spawning',
      result        TEXT,
      started_at    TEXT DEFAULT (datetime('now')),
      completed_at  TEXT
    );

    CREATE TABLE IF NOT EXISTS run_log (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id        TEXT NOT NULL REFERENCES runs(id),
      timestamp     TEXT NOT NULL,
      event_type    TEXT NOT NULL,
      payload       TEXT NOT NULL DEFAULT '{}',
      summary       TEXT
    );

    CREATE TABLE IF NOT EXISTS messages (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id        TEXT NOT NULL REFERENCES runs(id),
      role          TEXT NOT NULL,
      content       TEXT NOT NULL,
      created_at    TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY
    );

    INSERT INTO schema_version VALUES (1);
  `,
];

export class ShepherdsDB {
  private db: Database.Database;

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  private migrate(): void {
    const currentVersion = this.getVersion();
    for (let i = currentVersion; i < MIGRATIONS.length; i++) {
      this.db.exec(MIGRATIONS[i]);
    }
  }

  private getVersion(): number {
    const table = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'").get() as { name: string } | undefined;
    if (!table) return 0;
    const row = this.db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number | null };
    return row.v ?? 0;
  }

  close(): void {
    this.db.close();
  }

  // ─── Runs ──────────────────────────────────────────────────────

  createRun(id: string, goal: string): void {
    this.db.prepare('INSERT INTO runs (id, goal) VALUES (?, ?)').run(id, goal);
  }

  getRun(id: string): DbRun | undefined {
    return this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as DbRun | undefined;
  }

  updateRunStatus(id: string, status: string): void {
    this.db.prepare("UPDATE runs SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, id);
  }

  updateRunGoal(id: string, goal: string): void {
    this.db.prepare("UPDATE runs SET goal = ?, updated_at = datetime('now') WHERE id = ?").run(goal, id);
  }

  listRuns(): DbRun[] {
    return this.db.prepare('SELECT * FROM runs ORDER BY created_at DESC').all() as DbRun[];
  }

  // ─── Plans ─────────────────────────────────────────────────────

  savePlan(id: string, runId: string, steps: string, version: number): void {
    this.db.prepare('INSERT OR REPLACE INTO plans (id, run_id, steps, version) VALUES (?, ?, ?, ?)')
      .run(id, runId, steps, version);
  }

  getPlan(runId: string): DbPlan | undefined {
    return this.db.prepare('SELECT * FROM plans WHERE run_id = ?').get(runId) as DbPlan | undefined;
  }

  // ─── Agent Runs ────────────────────────────────────────────────

  createAgentRun(agent: DbAgentRun): void {
    this.db.prepare(`INSERT INTO agent_runs (id, run_id, step_id, persona, model, instructions, context, branch, container_id, status, result, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      agent.id, agent.run_id, agent.step_id, agent.persona,
      agent.model, agent.instructions, agent.context,
      agent.branch, agent.container_id, agent.status,
      agent.result, agent.completed_at
    );
  }

  updateAgentStatus(id: string, status: string, result?: string): void {
    if (result !== undefined) {
      this.db.prepare("UPDATE agent_runs SET status = ?, result = ?, completed_at = datetime('now') WHERE id = ?")
        .run(status, result, id);
    } else {
      this.db.prepare("UPDATE agent_runs SET status = ? WHERE id = ?").run(status, id);
    }
  }

  updateAgentContainer(id: string, containerId: string): void {
    this.db.prepare('UPDATE agent_runs SET container_id = ? WHERE id = ?').run(containerId, id);
  }

  getAgentRun(id: string): DbAgentRun | undefined {
    return this.db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(id) as DbAgentRun | undefined;
  }

  getAgentRunsForGoal(runId: string): DbAgentRun[] {
    return this.db.prepare('SELECT * FROM agent_runs WHERE run_id = ? ORDER BY started_at').all(runId) as DbAgentRun[];
  }

  // ─── Run Log ───────────────────────────────────────────────────

  appendLog(runId: string, eventType: string, payload: Record<string, unknown>, summary: string): void {
    this.db.prepare('INSERT INTO run_log (run_id, timestamp, event_type, payload, summary) VALUES (?, datetime(\'now\'), ?, ?, ?)')
      .run(runId, eventType, JSON.stringify(payload), summary);
  }

  getRunLog(runId: string, since?: string, filter?: string): DbRunLogEntry[] {
    let sql = 'SELECT * FROM run_log WHERE run_id = ?';
    const params: unknown[] = [runId];
    if (since) {
      sql += ' AND timestamp > ?';
      params.push(since);
    }
    if (filter && filter !== 'all') {
      const eventTypes = filterToEventTypes(filter);
      if (eventTypes.length > 0) {
        sql += ` AND event_type IN (${eventTypes.map(() => '?').join(',')})`;
        params.push(...eventTypes);
      }
    }
    sql += ' ORDER BY id';
    return this.db.prepare(sql).all(...params) as DbRunLogEntry[];
  }

  // ─── Messages ──────────────────────────────────────────────────

  appendMessage(runId: string, role: string, content: string): void {
    this.db.prepare('INSERT INTO messages (run_id, role, content) VALUES (?, ?, ?)').run(runId, role, content);
  }

  getMessages(runId: string): DbMessage[] {
    return this.db.prepare('SELECT * FROM messages WHERE run_id = ? ORDER BY id').all(runId) as DbMessage[];
  }
}

// ─── DB Row Types ────────────────────────────────────────────────

export interface DbRun {
  id: string;
  goal: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface DbPlan {
  id: string;
  run_id: string;
  steps: string;
  version: number;
  created_at: string;
}

export interface DbAgentRun {
  id: string;
  run_id: string;
  step_id: string | null;
  persona: string;
  model: string;
  instructions: string;
  context: string | null;
  branch: string | null;
  container_id: string | null;
  status: string;
  result: string | null;
  started_at: string;
  completed_at: string | null;
}

export interface DbRunLogEntry {
  id: number;
  run_id: string;
  timestamp: string;
  event_type: string;
  payload: string;
  summary: string;
}

export interface DbMessage {
  id: number;
  run_id: string;
  role: string;
  content: string;
  created_at: string;
}

// ─── Helpers ─────────────────────────────────────────────────────

function filterToEventTypes(filter: string): string[] {
  switch (filter) {
    case 'agents': return ['agent_spawned', 'agent_completed', 'agent_failed'];
    case 'branches': return ['branch_created'];
    case 'plan': return ['plan_created', 'plan_updated', 'bead_created', 'bead_updated', 'bead_closed', 'bead_dispatch'];
    case 'latest': return [
      'agent_completed', 'agent_failed', 'status_changed', 'plan_created', 'plan_updated',
      'bead_created', 'bead_closed', 'bead_dispatch',
    ];
    default: return [];
  }
}
