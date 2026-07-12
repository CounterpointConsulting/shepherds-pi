import assert from 'node:assert/strict';
import {
  appendNoteLine,
  buildCreateLabels,
  buildDescription,
  normalizeBead,
  normalizeBeads,
  parseDispatchCount,
  setDispatchCountInNotes,
} from '../beads/normalize.js';

// parse / set dispatch count
assert.equal(parseDispatchCount(''), 0);
assert.equal(parseDispatchCount('shepherd.dispatch_count=3'), 3);
assert.equal(parseDispatchCount('other\nshepherd.dispatch_count=7\nend'), 7);
assert.equal(setDispatchCountInNotes('', 2), 'shepherd.dispatch_count=2');
assert.equal(
  setDispatchCountInNotes('hello\nshepherd.dispatch_count=1', 4),
  'hello\nshepherd.dispatch_count=4',
);
assert.ok(appendNoteLine('a', 'b').includes('a'));
assert.ok(appendNoteLine('a', 'b').includes('b'));

// labels + description builders
assert.deepEqual(
  buildCreateLabels({ role: 'implement', persona: 'typescript-api-dev', labels: ['gate:x'] }).sort(),
  ['gate:x', 'persona:typescript-api-dev', 'role:implement'].sort(),
);
assert.ok(buildDescription({ description: 'Do it', branch: 'feat/x', role: 'implement' }).includes('Branch: feat/x'));

// normalize show payload (array form from bd show)
const rawShow = [{
  id: 'test-piz.1',
  title: 'Implement GET /health',
  description: 'Implement health',
  acceptance_criteria: 'GET /health returns 200',
  notes: 'shepherd.dispatch_count=2',
  status: 'open',
  priority: 1,
  issue_type: 'task',
  labels: ['persona:typescript-api-dev', 'role:implement'],
  parent: 'test-piz',
  dependencies: [
    { id: 'test-piz', dependency_type: 'parent-child' },
  ],
  dependents: [
    { id: 'test-piz.2', dependency_type: 'blocks' },
    { id: 'test-piz.3', dependency_type: 'blocks' },
  ],
}];

const bead = normalizeBead(rawShow[0]);
assert.ok(bead);
assert.equal(bead!.id, 'test-piz.1');
assert.equal(bead!.acceptance, 'GET /health returns 200');
assert.equal(bead!.dispatchCount, 2);
assert.equal(bead!.parent, 'test-piz');
assert.deepEqual(bead!.blocks, ['test-piz.2', 'test-piz.3']);
assert.deepEqual(bead!.blockedBy, []);

const ready = normalizeBeads([
  { id: 'a', title: 'A', status: 'open', priority: 1, issue_type: 'task' },
  { id: 'b', title: 'B', status: 'open', priority: 2, issue_type: 'epic' },
]);
assert.equal(ready.length, 2);
assert.equal(ready[1]!.type, 'epic');

console.log('beads-normalize: ok');
