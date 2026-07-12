import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  appendNoteLine,
  buildCreateLabels,
  buildDescription,
  normalizeBead,
  normalizeBeads,
  normalizeOne,
  parseDispatchCount,
  setDispatchCountInNotes,
} from './normalize.js';
import type {
  BeadsClientOptions,
  BeadsCreateInput,
  BeadsRunResult,
  BeadsUpdateInput,
  NormalizedBead,
} from './types.js';

/**
 * Host-side wrapper around the `bd` CLI.
 * Serializes mutations with a mutex (embedded SQLite/Dolt is single-writer).
 */
export class BeadsClient {
  private readonly opts: BeadsClientOptions;
  private queue: Promise<void> = Promise.resolve();

  constructor(opts: Partial<BeadsClientOptions> & Pick<BeadsClientOptions, 'cwd'>) {
    this.opts = {
      binary: opts.binary ?? 'bd',
      cwd: opts.cwd,
      forceLocalRepo: opts.forceLocalRepo ?? true,
      actor: opts.actor ?? 'shepherds-coordinator',
      timeoutMs: opts.timeoutMs ?? 60_000,
    };
  }

  get cwd(): string {
    return this.opts.cwd;
  }

  isInitialized(): boolean {
    const beadsDir = path.join(this.opts.cwd, '.beads');
    if (!fs.existsSync(beadsDir)) return false;
    try {
      return fs.readdirSync(beadsDir).some((name) =>
        name === 'beads.db' || name.endsWith('.db') || name === 'issues.jsonl' || name === 'config.yaml'
      );
    } catch {
      return false;
    }
  }

  async version(): Promise<string> {
    const result = await this.run(['version'], { json: false });
    if (!result.ok) throw new Error(result.error ?? 'bd version failed');
    return (result.stdout || result.stderr).trim();
  }

  async prime(full = true): Promise<string> {
    const args = ['prime'];
    if (full) args.push('--full');
    const result = await this.run(args, { json: false });
    if (!result.ok) throw new Error(result.error ?? 'bd prime failed');
    return result.stdout.trim();
  }

  async ready(options: {
    label?: string;
    limit?: number;
    parent?: string;
  } = {}): Promise<NormalizedBead[]> {
    const args = ['ready', '-n', String(options.limit ?? 20)];
    if (options.label) args.push('--label', options.label);
    if (options.parent) args.push('--parent', options.parent);
    const result = await this.run(args);
    if (!result.ok) throw new Error(result.error ?? 'bd ready failed');
    return normalizeBeads(result.data);
  }

  async list(options: {
    label?: string;
    status?: string;
    parent?: string;
    type?: string;
    limit?: number;
    all?: boolean;
  } = {}): Promise<NormalizedBead[]> {
    const args = ['list', '-n', String(options.limit ?? 50)];
    if (options.label) args.push('--label', options.label);
    if (options.status) args.push('--status', options.status);
    if (options.parent) args.push('--parent', options.parent);
    if (options.type) args.push('--type', options.type);
    if (options.all) args.push('--all');
    const result = await this.run(args);
    if (!result.ok) throw new Error(result.error ?? 'bd list failed');
    return normalizeBeads(result.data);
  }

  async show(id: string): Promise<NormalizedBead> {
    const result = await this.run(['show', id]);
    if (!result.ok) throw new Error(result.error ?? `bd show ${id} failed`);
    const bead = normalizeOne(result.data);
    if (!bead) throw new Error(`bd show ${id} returned no issue`);
    return bead;
  }

  async create(input: BeadsCreateInput): Promise<NormalizedBead> {
    return this.withLock(async () => {
      const args = ['create', input.title, '-t', input.type ?? 'task', '-p', String(input.priority ?? 2)];

      const description = buildDescription({
        description: input.description,
        branch: input.branch,
        persona: input.persona,
        role: input.role,
      });
      args.push('--description', description);

      if (input.acceptance) args.push('--acceptance', input.acceptance);
      if (input.parentId) args.push('--parent', input.parentId);

      const labels = buildCreateLabels({
        labels: input.labels,
        role: input.role,
        persona: input.persona,
      });
      if (labels.length > 0) args.push('--labels', labels.join(','));

      const notes = input.notes?.trim()
        ? setDispatchCountInNotes(input.notes, parseDispatchCount(input.notes))
        : 'shepherd.dispatch_count=0';
      args.push('--notes', notes);

      if (this.opts.forceLocalRepo) args.push('--repo', '.');

      const result = await this.run(args, { locked: true });
      if (!result.ok) throw new Error(result.error ?? 'bd create failed');
      const bead = normalizeOne(result.data);
      if (!bead) throw new Error('bd create returned no issue');
      // `bd create --json` often omits labels; refresh via show so role/persona
      // labels are visible to tools and seeds ready/label filters correctly.
      if (labels.length > 0 || input.parentId) {
        return this.showUnlocked(bead.id);
      }
      return bead;
    });
  }

  async createMany(items: BeadsCreateInput[]): Promise<NormalizedBead[]> {
    const created: NormalizedBead[] = [];
    for (const item of items) {
      created.push(await this.create(item));
    }
    return created;
  }

  async update(input: BeadsUpdateInput): Promise<NormalizedBead> {
    return this.withLock(async () => {
      let notes = input.notes;
      if (input.notesAppend) {
        const current = notes ?? (await this.showUnlocked(input.id)).notes;
        notes = appendNoteLine(current, input.notesAppend);
      }

      const args = ['update', input.id];
      if (input.title != null) args.push('--title', input.title);
      if (input.description != null) args.push('--description', input.description);
      if (input.acceptance != null) args.push('--acceptance', input.acceptance);
      if (notes != null) args.push('--notes', notes);
      if (input.priority != null) args.push('--priority', String(input.priority));
      if (input.status != null) args.push('--status', input.status);
      if (input.assignee != null) args.push('--assignee', input.assignee);
      for (const label of input.addLabels ?? []) args.push('--add-label', label);
      for (const label of input.removeLabels ?? []) args.push('--remove-label', label);

      const result = await this.run(args, { locked: true });
      if (!result.ok) throw new Error(result.error ?? `bd update ${input.id} failed`);
      const bead = normalizeOne(result.data);
      if (!bead) {
        // Some bd versions return the updated issues as an array outsourcing to show.
        return this.showUnlocked(input.id);
      }
      return bead;
    });
  }

  async claim(id: string, assignee?: string): Promise<NormalizedBead> {
    return this.withLock(async () => {
      const args = ['update', id, '--claim'];
      if (assignee) args.push('--assignee', assignee);
      const result = await this.run(args, { locked: true });
      if (!result.ok) {
        // Already claimed by coordinator is fine — return current state when status is in_progress.
        try {
          const current = await this.showUnlocked(id);
          if (current.status === 'in_progress') return current;
        } catch {
          /* fall through */
        }
        throw new Error(result.error ?? `bd claim ${id} failed`);
      }
      return normalizeOne(result.data) ?? this.showUnlocked(id);
    });
  }

  async close(id: string, reason: string, evidence?: string): Promise<NormalizedBead> {
    return this.withLock(async () => {
      if (evidence?.trim()) {
        const current = await this.showUnlocked(id);
        const notes = appendNoteLine(current.notes, `close evidence: ${evidence.trim()}`);
        const noteResult = await this.run(['update', id, '--notes', notes], { locked: true });
        if (!noteResult.ok) throw new Error(noteResult.error ?? 'failed to append close evidence');
      }

      const result = await this.run(['close', id, '--reason', reason], { locked: true });
      if (!result.ok) throw new Error(result.error ?? `bd close ${id} failed`);
      return normalizeOne(result.data) ?? this.showUnlocked(id);
    });
  }

  async reopen(id: string, reason?: string): Promise<NormalizedBead> {
    return this.withLock(async () => {
      const args = ['reopen', id];
      if (reason) args.push('--reason', reason);
      const result = await this.run(args, { locked: true });
      if (!result.ok) throw new Error(result.error ?? `bd reopen ${id} failed`);
      return normalizeOne(result.data) ?? this.showUnlocked(id);
    });
  }

  /**
   * Declare that `from` blocks `to` (to is not ready until from is closed).
   * Maps to: `bd dep <from> --blocks <to>`
   */
  async dep(
    from: string,
    to: string,
    options: { type?: 'blocks' | 'parent-child' | 'relates_to'; action?: 'add' | 'remove' } = {},
  ): Promise<unknown> {
    return this.withLock(async () => {
      const action = options.action ?? 'add';
      const type = options.type ?? 'blocks';

      if (action === 'remove') {
        const result = await this.run(['dep', 'remove', to, from], { locked: true });
        if (!result.ok) throw new Error(result.error ?? 'bd dep remove failed');
        return result.data ?? { status: 'removed' };
      }

      if (type === 'relates_to') {
        const result = await this.run(['dep', 'relate', from, to], { locked: true });
        if (!result.ok) throw new Error(result.error ?? 'bd dep relate failed');
        return result.data ?? { status: 'related' };
      }

      if (type === 'parent-child') {
        // parent-child is established primarily via --parent on create; emulate with dep add.
        const result = await this.run(['dep', 'add', to, from, '--type', 'parent-child'], { locked: true });
        if (!result.ok) throw new Error(result.error ?? 'bd dep parent-child failed');
        return result.data ?? { status: 'added', type: 'parent-child' };
      }

      // blocks: from blocks to
      const result = await this.run(['dep', from, '--blocks', to], { locked: true });
      if (!result.ok) throw new Error(result.error ?? 'bd dep --blocks failed');
      return result.data ?? { blocked_id: to, blocker_id: from, status: 'added', type: 'blocks' };
    });
  }

  async incrementDispatchCount(id: string, agentRunId?: string): Promise<NormalizedBead> {
    return this.withLock(async () => {
      const current = await this.showUnlocked(id);
      const nextCount = current.dispatchCount + 1;
      let notes = setDispatchCountInNotes(current.notes, nextCount);
      if (agentRunId) {
        notes = appendNoteLine(notes, `spawn ${agentRunId}`);
      } else {
        notes = appendNoteLine(notes, 'spawn (dispatch_count incremented)');
      }
      const result = await this.run(['update', id, '--notes', notes], { locked: true });
      if (!result.ok) throw new Error(result.error ?? `failed to increment dispatch count for ${id}`);
      return normalizeOne(result.data) ?? this.showUnlocked(id);
    });
  }

  async appendSpawnResult(id: string, summary: string): Promise<NormalizedBead> {
    return this.update({
      id,
      notesAppend: `agent result: ${summary}`,
    });
  }

  // ─── internals ────────────────────────────────────────────────

  private showUnlocked(id: string): Promise<NormalizedBead> {
    return this.run(['show', id]).then((result) => {
      if (!result.ok) throw new Error(result.error ?? `bd show ${id} failed`);
      const bead = normalizeOne(result.data);
      if (!bead) throw new Error(`bd show ${id} returned no issue`);
      return bead;
    });
  }

  private depth = 0;

  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    // Serialize top-level mutations; allow re-entrant calls inside an active lock.
    const start = async () => {
      this.depth += 1;
      try {
        return await fn();
      } finally {
        this.depth -= 1;
      }
    };

    if (this.depth > 0) {
      return start();
    }

    const run = this.queue.then(start, start);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private run(
    args: string[],
    options: { json?: boolean; locked?: boolean } = {},
  ): Promise<BeadsRunResult> {
    const exec = () => this.exec(args, options.json !== false);
    // When already inside withLock (depth>0) or caller opted locked, just exec.
    if (options.locked || this.depth > 0) return exec();
    return this.withLock(exec);
  }

  private exec(args: string[], json: boolean): Promise<BeadsRunResult> {
    const fullArgs = [
      '--actor', this.opts.actor,
      ...(json ? ['--json'] : []),
      ...args,
    ];

    return new Promise((resolve) => {
      const child = spawn(this.opts.binary, fullArgs, {
        cwd: this.opts.cwd,
        env: {
          ...process.env,
          // Prefer non-interactive stable behavior
          NO_COLOR: '1',
        },
        windowsHide: true,
        shell: false,
      });

      let stdout = '';
      let stderr = '';
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGTERM');
        resolve({
          ok: false,
          code: null,
          stdout,
          stderr,
          data: null,
          error: `bd timed out after ${this.opts.timeoutMs}ms: ${fullArgs.join(' ')}`,
        });
      }, this.opts.timeoutMs);

      child.stdout.on('data', (chunk: Buffer | string) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });

      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          ok: false,
          code: null,
          stdout,
          stderr,
          data: null,
          error: `Failed to spawn bd (${this.opts.binary}): ${err.message}`,
        });
      });

      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);

        let data: unknown = null;
        if (json && stdout.trim()) {
          try {
            data = JSON.parse(stdout);
          } catch {
            // bd sometimes prints warnings before JSON — try last JSON blob
            const start = stdout.indexOf('{') >= 0 && (stdout.indexOf('[') < 0 || stdout.indexOf('{') < stdout.indexOf('['))
              ? stdout.indexOf('{')
              : stdout.indexOf('[');
            if (start >= 0) {
              try {
                data = JSON.parse(stdout.slice(start));
              } catch {
                data = null;
              }
            }
          }
        }

        if (code !== 0) {
          const errText = (stderr || stdout).trim() || `bd exited with code ${code}`;
          resolve({
            ok: false,
            code,
            stdout,
            stderr,
            data,
            error: errText,
          });
          return;
        }

        resolve({
          ok: true,
          code,
          stdout,
          stderr,
          data: json ? data : stdout,
        });
      });
    });
  }
}

export function parseBeadFromStdout(stdout: string): NormalizedBead | null {
  try {
    return normalizeBead(JSON.parse(stdout));
  } catch {
    return null;
  }
}
