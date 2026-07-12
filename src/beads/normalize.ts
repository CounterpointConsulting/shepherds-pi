import type { NormalizedBead } from './types.js';

const DISPATCH_RE = /shepherd\.dispatch_count\s*=\s*(\d+)/i;

export function parseDispatchCount(notes: string | undefined | null): number {
  if (!notes) return 0;
  const match = notes.match(DISPATCH_RE);
  if (!match) return 0;
  const n = Number.parseInt(match[1] ?? '0', 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export function setDispatchCountInNotes(notes: string | undefined | null, count: number): string {
  const next = `shepherd.dispatch_count=${Math.max(0, Math.floor(count))}`;
  const existing = notes?.trim() ?? '';
  if (!existing) return next;
  if (DISPATCH_RE.test(existing)) {
    return existing.replace(DISPATCH_RE, next);
  }
  return `${existing}\n${next}`;
}

export function appendNoteLine(notes: string | undefined | null, line: string): string {
  const stamp = new Date().toISOString();
  const entry = `[${stamp}] ${line}`;
  const existing = notes?.trim() ?? '';
  return existing ? `${existing}\n${entry}` : entry;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => asString(v)).filter(Boolean);
}

function extractId(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (value && typeof value === 'object' && 'id' in value) {
    const id = (value as { id?: unknown }).id;
    return typeof id === 'string' && id.trim() ? id : null;
  }
  return null;
}

function dependencyIds(
  issue: Record<string, unknown>,
  key: 'dependencies' | 'dependents',
  typeFilter?: string,
): string[] {
  const raw = issue[key];
  if (!Array.isArray(raw)) return [];
  const ids: string[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const rec = entry as Record<string, unknown>;
    const depType = asString(rec.dependency_type || rec.type);
    if (typeFilter && depType && depType !== typeFilter) continue;
    const id = extractId(rec);
    if (id) ids.push(id);
  }
  return ids;
}

/** Normalize a single raw bead JSON object from `bd --json`. */
export function normalizeBead(raw: unknown): NormalizedBead | null {
  if (!raw || typeof raw !== 'object') return null;
  const issue = raw as Record<string, unknown>;
  const id = asString(issue.id);
  if (!id) return null;

  const notes = asString(issue.notes);
  const labels = asStringArray(issue.labels);

  // dependencies: issues this one depends on (blockers / parents)
  // dependents: issues that depend on this one
  const blockedBy = dependencyIds(issue, 'dependencies', 'blocks');
  const parentFromDep = dependencyIds(issue, 'dependencies', 'parent-child')[0] ?? null;
  const blocks = dependencyIds(issue, 'dependents', 'blocks');

  return {
    id,
    title: asString(issue.title),
    status: asString(issue.status) || 'open',
    priority: asNumber(issue.priority, 2),
    type: asString(issue.issue_type || issue.type) || 'task',
    description: asString(issue.description),
    acceptance: asString(issue.acceptance_criteria || issue.acceptance),
    notes,
    labels,
    assignee: issue.assignee == null || issue.assignee === '' ? null : asString(issue.assignee),
    parent: extractId(issue.parent) ?? parentFromDep,
    blockedBy,
    blocks,
    dispatchCount: parseDispatchCount(notes),
    closeReason: issue.close_reason == null || issue.close_reason === ''
      ? null
      : asString(issue.close_reason),
  };
}

/** Prefer array payloads; unwrap single objects; tolerate envelopes. */
export function extractIssueList(data: unknown): unknown[] {
  if (data == null) return [];
  if (Array.isArray(data)) return data;
  if (typeof data === 'object') {
    const rec = data as Record<string, unknown>;
    if (Array.isArray(rec.data)) return rec.data;
    if (Array.isArray(rec.issues)) return rec.issues;
    if (rec.id) return [data];
  }
  return [];
}

export function normalizeBeads(data: unknown): NormalizedBead[] {
  return extractIssueList(data)
    .map(normalizeBead)
    .filter((b): b is NormalizedBead => b != null);
}

export function normalizeOne(data: unknown): NormalizedBead | null {
  const list = normalizeBeads(data);
  return list[0] ?? null;
}

export function roleLabel(role: string): string {
  return `role:${role}`;
}

export function personaLabel(persona: string): string {
  return `persona:${persona}`;
}

export function buildCreateLabels(input: {
  labels?: string[];
  role?: string;
  persona?: string;
}): string[] {
  const set = new Set<string>();
  for (const label of input.labels ?? []) {
    if (label.trim()) set.add(label.trim());
  }
  if (input.role) set.add(roleLabel(input.role));
  if (input.persona) set.add(personaLabel(input.persona));
  return [...set];
}

export function buildDescription(input: {
  description?: string;
  branch?: string;
  persona?: string;
  role?: string;
}): string {
  const parts: string[] = [];
  if (input.description?.trim()) parts.push(input.description.trim());

  const meta: string[] = [];
  if (input.role) meta.push(`Role: ${input.role}`);
  if (input.persona) meta.push(`Persona: ${input.persona}`);
  if (input.branch) meta.push(`Branch: ${input.branch}`);
  if (meta.length > 0) {
    parts.push(['## Shepherd metadata', ...meta.map((m) => `- ${m}`)].join('\n'));
  }
  return parts.join('\n\n') || 'Created by shepherds-pi coordinator.';
}
