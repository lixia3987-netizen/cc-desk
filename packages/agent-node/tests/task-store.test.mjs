import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { NativeTaskStore } from '../dist/task-store.js';
const identity = { sessionId: 's1', conversationId: 'c0f117a2-cc31-465e-8f31-97c4fffaee91', runId: 'fdc4ef4e-5e1c-494d-860d-c47708dc477c', requestId: 'r1', workerGeneration: 1 };
const taskId = '74b5ba80-fc6c-4e0d-9454-f203f3ad7981';
const plan = () => ({ goal: 'Fix refresh', steps: [{ id: 'step1', title: 'Refresh', dependsOn: [], status: 'pending' }], criteria: [] });
const request = (extra = {}) => ({ identity, taskId, mutationId: 'call-1', expectedRevision: 0, mutation: { type: 'plan', plan: plan() }, ...extra });
async function fixture(t, extra = {}) {
  const rootDirectory = await mkdtemp(path.join(os.tmpdir(), 'native-task-store-'));
  const options = { rootDirectory, conversationId: identity.conversationId, sessionId: identity.sessionId, ...extra };
  const stores = [];
  t.after(async () => { for (const store of stores) await store.close(); await rm(rootDirectory, { recursive: true, force: true }); });
  return { options, stores, file: path.join(rootDirectory, 'tasks', identity.conversationId, 'tasks.json'), open: async () => { const store = await NativeTaskStore.open(options); stores.push(store); return store; } };
}

test('legacy conversations without tasks read null and readonly reads create no storage', async t => {
  const f = await fixture(t); assert.equal(await NativeTaskStore.readSnapshot(f.options), null);
  assert.deepEqual(await NativeTaskStore.readAllSnapshots(f.options), []);
});
test('persisted task survives close/reopen and read-only access works with active writer', async t => {
  const f = await fixture(t); const store = await f.open(); const result = await store.apply(request());
  assert.deepEqual(await NativeTaskStore.readSnapshot(f.options), result);
  await store.close(); const second = await f.open(); assert.deepEqual(second.latest(), result); assert.equal(second.read(taskId).revision, 1);
  const detached = second.latest(); detached.steps[0].title = 'Tampered'; assert.equal(second.latest().steps[0].title, 'Refresh');
});
test('single writer ownership rejects concurrent writers', async t => {
  const f = await fixture(t); await f.open(); await assert.rejects(NativeTaskStore.open(f.options), { code: 'writer_locked' });
});
test('identical mutation is durable idempotent, collisions and stale updates fail', async t => {
  const f = await fixture(t); const store = await f.open(); const first = await store.apply(request());
  assert.deepEqual(await store.apply(request()), first);
  await assert.rejects(store.apply(request({ mutation: { type: 'plan', plan: { ...plan(), goal: 'Changed' } } })), { code: 'mutation_conflict' });
  await assert.rejects(store.apply(request({ mutationId: 'call-2' })), { code: 'revision_conflict' });
  await store.close(); const second = await f.open(); assert.deepEqual(await second.apply(request()), first);
});
test('queued concurrent writes use CAS and input cannot change while queued', async t => {
  const f = await fixture(t); const store = await f.open(); await store.apply(request());
  const input = request({ expectedRevision: 1, mutationId: 'a', mutation: { type: 'plan', plan: plan() } });
  const one = store.apply(input); input.mutation.plan.goal = 'Tampered';
  const two = store.apply(request({ expectedRevision: 1, mutationId: 'b' }));
  assert.equal((await one).goal, 'Fix refresh'); await assert.rejects(two, { code: 'revision_conflict' });
});
test('different session identities cannot open or mutate task storage', async t => {
  const f = await fixture(t); const store = await f.open(); await store.apply(request());
  await assert.rejects(store.apply(request({ identity: { ...identity, sessionId: 'other' } })), { code: 'invalid_identity' });
  await assert.rejects(NativeTaskStore.readSnapshot({ ...f.options, sessionId: 'other' }), { code: 'invalid_identity' });
});
test('failed pre-rename writes are never acknowledged and can safely retry', async t => {
  let faultPoint = 'after_sync'; const f = await fixture(t, { fault: point => { if (point === faultPoint) throw new Error('disk failure'); } });
  const store = await f.open(); await assert.rejects(store.apply(request()), /disk failure/);
  assert.equal(store.latest(), null); assert.equal(await NativeTaskStore.readSnapshot(f.options), null);
  faultPoint = ''; assert.equal((await store.apply(request())).revision, 1);
});
test('cancellation guard before rename preserves durable state and allows host finish', async t => {
  const f = await fixture(t); const store = await f.open(); await store.apply(request());
  await assert.rejects(store.apply(request({ mutationId: 'cancelled', expectedRevision: 1 }), { assertWriteAllowed: () => { throw new Error('cancelled'); } }), /cancelled/);
  assert.equal(store.latest().revision, 1);
  const final = await store.apply(request({ mutationId: 'finish', expectedRevision: 1, mutation: { type: 'finish', outcome: 'cancelled' } }));
  assert.equal(final.execution, 'ended');
});
test('post-rename failure is uncertain and poisons writer until reopened', async t => {
  let fail = true; const f = await fixture(t, { fault: point => { if (fail && point === 'after_rename') throw new Error('sync uncertain'); } });
  const store = await f.open(); await assert.rejects(store.apply(request()), /sync uncertain/); assert.equal(store.latest(), null);
  await assert.rejects(store.apply(request()), { code: 'recovery_required' });
  await store.close(); fail = false; const recovered = await f.open(); assert.equal(recovered.latest().revision, 1); assert.equal((await recovered.apply(request())).revision, 1);
});
test('checksum corruption and truncated file never become empty or successful state', async t => {
  const f = await fixture(t); const store = await f.open(); await store.apply(request()); await store.close();
  const original = await readFile(f.file, 'utf8'); const value = JSON.parse(original); value.tasks[0].goal = 'Tampered'; await writeFile(f.file, JSON.stringify(value));
  await assert.rejects(NativeTaskStore.readSnapshot(f.options), { code: 'corrupt_task_store' });
  await writeFile(f.file, original.slice(0, -4)); await assert.rejects(f.open(), { code: 'corrupt_task_store' });
});
test('external replacement is detected before overwriting and secret text is rejected', async t => {
  const f = await fixture(t, { forbiddenValues: ['s"ecret'] }); const store = await f.open();
  await assert.rejects(store.apply(request({ mutation: { type: 'plan', plan: { ...plan(), goal: 's"ecret' } } })), { code: 'secret_rejected' });
  await store.apply(request()); await writeFile(f.file, '{}');
  await assert.rejects(store.apply(request({ mutationId: 'next', expectedRevision: 1 })), { code: 'writer_lost' });
});
test('symlink task snapshot fails closed', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t); const store = await f.open(); await store.apply(request()); await store.close();
  const target = path.join(f.options.rootDirectory, 'target.json'); await writeFile(target, await readFile(f.file)); await rm(f.file); await symlink(target, f.file);
  await assert.rejects(NativeTaskStore.readSnapshot(f.options), { code: 'unsafe_path' });
});
test('explicit continuation selects old task as current without late evidence stealing latest task', async t => {
  const f = await fixture(t); const store = await f.open(); await store.apply(request());
  await store.apply(request({ mutationId: 'finish1', expectedRevision: 1, mutation: { type: 'finish', outcome: 'completed' } }));
  const secondId = randomUUID(), secondIdentity = { ...identity, runId: randomUUID(), requestId: 'r2', workerGeneration: 2 };
  await store.apply(request({ taskId: secondId, identity: secondIdentity, mutationId: 'create2' }));
  await store.apply(request({ taskId: secondId, identity: secondIdentity, mutationId: 'finish2', expectedRevision: 1, mutation: { type: 'finish', outcome: 'completed' } }));
  await store.apply(request({ mutationId: 'old_review', expectedRevision: 2, mutation: { type: 'review', status: 'rejected', reason: 'Review old task' } }));
  assert.equal(store.latest().taskId, secondId);
  const nextIdentity = { ...identity, runId: randomUUID(), requestId: 'r3', workerGeneration: 3 };
  await store.apply(request({ identity: nextIdentity, mutationId: 'continue', expectedRevision: 3, mutation: { type: 'continue', previousRunId: identity.runId } }));
  assert.equal(store.latest().taskId, taskId);
});

test('failed close retains ownership barrier and can retry the real release', async t => {
  const f = await fixture(t); const store = await f.open(); await store.apply(request());
  const lock = path.join(path.dirname(f.file), '.writer-lock');
  const original = await readFile(lock, 'utf8');
  await writeFile(lock, '{}');
  await assert.rejects(store.close(), { code: 'writer_lost' });
  await assert.rejects(store.apply(request({ mutationId: 'after-failed-close', expectedRevision: 1 })), { code: 'store_closed' });
  await writeFile(lock, original);
  await store.close();
  const reopened = await f.open(); assert.equal(reopened.latest().revision, 1);
});

test('close drains admitted writes while refusing newly submitted writes', async t => {
  const f = await fixture(t); const store = await f.open();
  const pending = store.apply(request()); const closing = store.close();
  await assert.rejects(store.apply(request({ mutationId: 'late' })), { code: 'store_closed' });
  assert.equal((await pending).revision, 1); await closing;
  assert.equal((await NativeTaskStore.readSnapshot(f.options)).revision, 1);
});

async function locationRequest(store, excerpt = '\uFEFFconst 状态 = "ready";\r\nreturn 状态;\n') {
  const hash = createHash('sha256').update(excerpt).digest('hex');
  const workspace = { fingerprint: 'a'.repeat(64), complete: false, rootFingerprint: 'b'.repeat(64),
    files: [{ path: 'src/状态.ts', hash, bytes: Buffer.byteLength(excerpt), mode: 0o644 }], scope: ['ordinary files'], issues: ['Other files exceeded scan limit'], capturedAt: '2026-09-28T11:00:00.000Z' };
  const changes = { complete: false, added: [], modified: [], removed: [], attribution: 'observed_since_task_start', truncated: false };
  await store.apply(request());
  const task = await store.apply(request({ expectedRevision: 1, mutationId: 'scan', mutation: { type: 'workspace', baseline: workspace, current: workspace, changes } }));
  return request({ expectedRevision: task.revision, mutationId: 'location', mutation: { type: 'evidence', evidence: {
    id: 'location-1', identity, source: 'location', status: 'unverified', stepIds: ['step1'], criterionIds: [], planRevision: task.planRevision, acceptanceRevision: task.acceptanceRevision,
    workspaceFingerprint: workspace.fingerprint, workspaceComplete: workspace.complete, toolCallId: 'host-location-call', createdAt: workspace.capturedAt,
    location: { path: 'src/状态.ts', startLine: 1, endLine: 2, fileHash: hash, fileBytes: Buffer.byteLength(excerpt), excerpt, excerptHash: hash },
  } } });
}
test('location receipts roundtrip with original bytes and digest, retain idempotency and stay unverified', async t => {
  const f = await fixture(t); const store = await f.open(); const update = await locationRequest(store);
  const result = await store.apply(update); assert.equal(result.verification, 'unverified'); assert.equal(result.schemaVersion, 1);
  assert.deepEqual(await NativeTaskStore.readSnapshot(f.options), result);
  result.evidence[0].location.excerpt = 'Caller mutation'; assert.equal(store.latest().evidence[0].location.excerpt, update.mutation.evidence.location.excerpt);
  await store.close(); const reopened = await f.open(); const persisted = reopened.latest();
  assert.deepEqual(persisted.evidence[0], update.mutation.evidence); assert.deepEqual(await reopened.apply(update), persisted);
  assert.equal(createHash('sha256').update(persisted.evidence[0].location.excerpt).digest('hex'), persisted.evidence[0].location.excerptHash);
});
test('invalid location claims never advance durable task revision', async t => {
  const f = await fixture(t); const store = await f.open(); const input = await locationRequest(store); const original = await readFile(f.file, 'utf8');
  for (const mutate of [
    value => { value.mutation.evidence.status = 'passed'; },
    value => { value.mutation.evidence.location.path = '../outside.ts'; },
    value => { value.mutation.evidence.location.fileHash = 'c'.repeat(64); },
    value => { value.mutation.evidence.location.excerpt = '中'.repeat(2731); },
  ]) {
    const value = structuredClone(input); mutate(value);
    await assert.rejects(store.apply(value), { code: 'invalid_task' });
    assert.equal(store.latest().revision, 2); assert.equal(await readFile(f.file, 'utf8'), original);
  }
  assert.equal((await store.apply(input)).revision, 3);
});
test('protected credential text in a code excerpt is rejected before publication', async t => {
  const f = await fixture(t, { forbiddenValues: ['protected-location-credential'] }); const store = await f.open();
  const input = await locationRequest(store, 'const value = "protected-location-credential";\nreturn value;\n');
  await assert.rejects(store.apply(input), { code: 'secret_rejected' });
  assert.equal(store.latest().revision, 2); assert.equal(store.latest().evidence.length, 0);
  assert.equal((await readFile(f.file, 'utf8')).includes('protected-location-credential'), false);
});
