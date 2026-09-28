import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyNativeTaskUpdate, validateNativeTaskPlan, validateNativeTaskSnapshot } from '../dist/index.js';
const identity = { sessionId: 'session-1', conversationId: 'c0f117a2-cc31-465e-8f31-97c4fffaee91', runId: 'fdc4ef4e-5e1c-494d-860d-c47708dc477c', requestId: 'request-1', workerGeneration: 1 };
const taskId = '74b5ba80-fc6c-4e0d-9454-f203f3ad7981';
const at = '2026-09-28T11:00:00.000Z';
const plan = () => ({ goal: 'Fix status refresh', steps: [{ id: 'state', title: 'Make status authoritative', dependsOn: [], status: 'pending' }], criteria: [{ id: 'resync', description: 'Out-of-order snapshots retain newest state', stepIds: ['state'], kind: 'command' }] });
const create = (value = plan()) => applyNativeTaskUpdate(null, { identity, taskId, mutationId: 'create', expectedRevision: 0, mutation: { type: 'plan', plan: value } }, at);
const update = (task, mutation, extra = {}) => applyNativeTaskUpdate(task, { identity: task.identity, taskId, mutationId: `mutation-${task.revision}`, expectedRevision: task.revision, mutation, ...extra }, at);
const workspace = (fingerprint = 'a'.repeat(64), complete = true) => ({ fingerprint, complete, rootFingerprint: 'b'.repeat(64), files: [], scope: ['ordinary project files'], issues: [], capturedAt: at });
const changes = { complete: true, added: [], modified: [], removed: [], attribution: 'observed_since_task_start', truncated: false };
function withWorkspace(task) { const current = workspace(); return update(task, { type: 'workspace', baseline: current, current, changes }); }
function evidence(task, overrides = {}) { return { id: `e-${task.revision}`, identity: task.identity, stepIds: ['state'], criterionIds: ['resync'], source: 'manual', status: 'passed', reason: 'Human reviewed this condition', planRevision: task.planRevision, acceptanceRevision: task.acceptanceRevision, workspaceFingerprint: 'a'.repeat(64), workspaceComplete: true, toolCallId: 'call-1', command: { executable: 'node', argv: ['--test'], cwd: '/project' }, exitCode: 0, createdAt: at, ...overrides }; }
function verified() {
  const proposed = plan(); proposed.steps[0].status = 'implemented';
  let task = withWorkspace(create(proposed));
  task = update(task, { type: 'evidence', evidence: evidence(task) });
  return update(task, { type: 'review', status: 'approved', reason: 'Reviewed coverage and independent result' });
}

test('plan creates stable identity/revisions and cannot directly supply verification', () => {
  const task = create(); assert.equal(task.verification, 'unverified'); assert.equal(task.revision, 1); assert.equal(task.planRevision, 1);
  assert.throws(() => create({ ...plan(), verification: 'passed' }), { code: 'invalid_task' });
  assert.throws(() => create({ ...plan(), steps: [{ ...plan().steps[0], status: 'verified' }] }), { code: 'invalid_task' });
});
test('plan validates bounds, duplicate identifiers, unknown dependencies and cycles', () => {
  const bad = [ { ...plan(), goal: 'x'.repeat(4001) }, { ...plan(), steps: Array(65).fill(plan().steps[0]) }, { ...plan(), steps: [plan().steps[0], plan().steps[0]] }, { ...plan(), steps: [{ ...plan().steps[0], dependsOn: ['missing'] }] }, { ...plan(), steps: [{ ...plan().steps[0], dependsOn: ['state'] }] }, { ...plan(), steps: [{ ...plan().steps[0], status: 'blocked' }] }, { ...plan(), criteria: [{ ...plan().criteria[0], stepIds: ['missing'] }] } ];
  for (const value of bad) assert.throws(() => validateNativeTaskPlan(value), { code: 'invalid_task' });
});
test('a completed dependent step requires implemented prerequisites', () => {
  const value = plan(); value.steps.push({ id: 'test', title: 'Test', status: 'implemented', dependsOn: ['state'] });
  assert.throws(() => validateNativeTaskPlan(value), { code: 'invalid_task' });
  value.steps[0].status = 'implemented'; validateNativeTaskPlan(value);
});
test('identity and optimistic revision reject stale or cross-session writes', () => {
  const task = create();
  for (const partial of [{ sessionId: 'other' }, { runId: 'ac644cd7-8223-4bd1-bf39-a21c6b2371a2' }, { workerGeneration: 2 }]) assert.throws(() => update(task, { type: 'plan', plan: plan() }, { identity: { ...identity, ...partial } }), { code: 'invalid_identity' });
  assert.throws(() => update(task, { type: 'plan', plan: plan() }, { expectedRevision: 0 }), { code: 'revision_conflict' });
});
test('step declarations preserve plan version, structural and criteria changes invalidate their versions', () => {
  let task = create(); let proposed = plan(); proposed.steps[0].status = 'implemented';
  task = update(task, { type: 'plan', plan: proposed }); assert.equal(task.planRevision, 1);
  proposed.goal = 'Another goal'; task = update(task, { type: 'plan', plan: proposed }); assert.equal(task.planRevision, 2);
  proposed.criteria[0].description = 'Check all refresh races'; task = update(task, { type: 'plan', plan: proposed }); assert.equal(task.acceptanceRevision, 2);
});
test('a condition result and completion never imply acceptance with unfinished steps', () => {
  let task = withWorkspace(create()); task = update(task, { type: 'evidence', evidence: evidence(task) });
  assert.equal(task.verification, 'unverified'); task = update(task, { type: 'finish', outcome: 'completed' }); assert.equal(task.verification, 'unverified');
  assert.throws(() => update(task, { type: 'review', status: 'approved', reason: 'review' }), { code: 'verification_incomplete' });
});
test('passing requires implemented steps, current scoped evidence and explicit human coverage review', () => {
  const task = verified(); assert.equal(task.verification, 'passed'); validateNativeTaskSnapshot(task);
  let empty = plan(); empty.steps[0].status = 'implemented'; empty.criteria = [];
  assert.throws(() => update(withWorkspace(create(empty)), { type: 'review', status: 'approved', reason: 'No checks supplied' }), { code: 'verification_incomplete' });
});
test('failed and incomplete or truncated command evidence cannot become passing', () => {
  const task = withWorkspace(create());
  for (const overrides of [{ source: 'command' }, { source: 'command', exitCode: 1 }, { workspaceComplete: false }, { source: 'command', truncated: true }, { workspaceFingerprint: 'c'.repeat(64) }]) assert.throws(() => update(task, { type: 'evidence', evidence: evidence(task, overrides) }), { code: 'invalid_task' });
  const failed = update(task, { type: 'evidence', evidence: evidence(task, { status: 'failed', exitCode: 1 }) }); assert.equal(failed.verification, 'failed');
});
test('evidence is bound to exact run and plan, and ids cannot be recycled', () => {
  let task = withWorkspace(create()); const record = evidence(task);
  assert.throws(() => update(task, { type: 'evidence', evidence: { ...record, planRevision: 2 } }), { code: 'invalid_identity' });
  assert.throws(() => update(task, { type: 'evidence', evidence: { ...record, identity: { ...identity, workerGeneration: 2 } } }), { code: 'invalid_identity' });
  task = update(task, { type: 'evidence', evidence: record }); assert.throws(() => update(task, { type: 'evidence', evidence: record }), { code: 'invalid_task' });
});
test('external file change makes evidence stale and clears human review', () => {
  let task = verified(); task = update(task, { type: 'workspace', current: workspace('c'.repeat(64)), changes });
  assert.equal(task.verification, 'stale'); assert.equal(task.review, undefined); assert.equal(task.evidence[0].stale, true);
});
test('changing acceptance conditions or removing steps preserves stale historical evidence', () => {
  let task = verified(); const value = { goal: 'New scope', steps: [{ id: 'new', title: 'New', dependsOn: [], status: 'pending' }], criteria: [] };
  task = update(task, { type: 'plan', plan: value }); assert.equal(task.evidence.length, 1); assert.equal(task.verification, 'stale'); validateNativeTaskSnapshot(task);
});
test('baseline is immutable and missing initial baseline is rejected', () => {
  const task = create(); assert.throws(() => update(task, { type: 'workspace', current: workspace(), changes }), { code: 'invalid_task' });
  assert.throws(() => update(withWorkspace(task), { type: 'workspace', baseline: workspace('c'.repeat(64)), current: workspace(), changes }), { code: 'invalid_task' });
});
test('finish interrupts unfinished active steps and prevents late plan writes', () => {
  const value = plan(); value.steps[0].status = 'in_progress'; let task = create(value);
  task = update(task, { type: 'finish', outcome: 'cancelled' }); assert.equal(task.steps[0].status, 'interrupted');
  assert.throws(() => update(task, { type: 'plan', plan: plan() }), { code: 'task_ended' });
});
test('only exact explicit continuation can rebind an ended task and late old run updates fail', () => {
  let task = update(create(), { type: 'finish', outcome: 'completed' });
  const newer = { ...identity, runId: 'ac644cd7-8223-4bd1-bf39-a21c6b2371a2', requestId: 'next', workerGeneration: 2 };
  assert.throws(() => update(task, { type: 'continue', previousRunId: newer.runId }, { identity: newer }), { code: 'invalid_identity' });
  task = update(task, { type: 'continue', previousRunId: identity.runId }, { identity: newer }); assert.equal(task.identity.runId, newer.runId);
  assert.throws(() => update(task, { type: 'plan', plan: plan() }, { identity }), { code: 'invalid_identity' });
});
test('persisted verification tampering and malformed history are rejected', () => {
  const task = create(); assert.throws(() => validateNativeTaskSnapshot({ ...task, verification: 'passed' }), { code: 'invalid_task' });
  assert.throws(() => validateNativeTaskSnapshot({ ...task, history: [] }), { code: 'invalid_task' });
});
