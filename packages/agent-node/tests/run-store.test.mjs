import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { NativeRunStore } from '../dist/run-store.js';

const protocol = { id: 'openai.responses', version: 1 };
const call = { id: 'call-one', name: 'write_file', arguments: '{"path":"a.txt","text":"hello"}' };
const prepared = {
  call, definition: { name: 'write_file', description: 'Write', inputSchema: { type: 'object' }, risk: 'write' },
  input: { path: 'a.txt', text: 'hello' }, inputDigest: 'tool-digest', policyRevision: 'alpha-1', requiresApproval: true,
  preconditions: { hash: 'before', instructionHash: 'instructions', owner: 'host-issued-token' },
};
function request(conversationId, overrides = {}) {
  return {
    identity: { sessionId: 'session-one', conversationId, runId: randomUUID(), requestId: randomUUID(), workerGeneration: 1 },
    input: 'Fix the bug', inputDigest: 'host-digest', userItems: [{ role: 'user', content: 'Fix the bug' }],
    protocol, configuration: { connectionId: 'local', model: 'test-model' }, policyRevision: 'alpha-1', ...overrides,
  };
}
function approval(identity) {
  return { binding: { ...identity, toolCallId: call.id, inputDigest: prepared.inputDigest, policyRevision: 'alpha-1' }, decision: 'approved', expiresAt: 12345 };
}
function modelResponse(toolCalls = [call]) {
  return { type: 'model_response', response: {
    outputItems: [{ type: 'reasoning', encrypted_content: 'opaque-provider-data' }, ...toolCalls.map(item => ({ type: 'function_call', call_id: item.id, name: item.name, arguments: item.arguments }))],
    toolCalls, continuation: { phase: 'analysis', opaque: ['provider', { version: 2 }] }, finishReason: toolCalls.length ? 'tool_calls' : 'completed', usage: { inputTokens: 20, outputTokens: 10 },
  } };
}
function completion(item = call, status = 'completed') {
  return { type: 'tool_completed', call: item, result: { status, output: 'written', effects: { afterHash: 'after' } }, resultItems: [{ type: 'function_call_output', call_id: item.id, output: 'written' }] };
}
async function finish(store, req, status = 'completed') {
  const result = { identity: req.identity, status, reason: status, modelRequests: 1, toolCalls: 1, usage: null, context: store.loadContext(), committed: true };
  await store.append(req.identity, { type: 'run_finished', result });
  return result;
}
async function fixture(t, options = {}) {
  const rootDirectory = await mkdtemp(path.join(tmpdir(), 'native-store-'));
  const conversationId = randomUUID();
  let store = await NativeRunStore.open({ rootDirectory, conversationId, ...options });
  t.after(async () => { await store.close().catch(() => {}); await rm(rootDirectory, { recursive: true, force: true }); });
  return { rootDirectory, conversationId, get store() { return store; }, reopen: async (extra = {}) => {
    await store.close(); store = await NativeRunStore.open({ rootDirectory, conversationId, ...extra }); return store;
  } };
}

test('complete provider items, continuation and tool results survive clean restart and a second turn', async t => {
  const f = await fixture(t);
  const req = request(f.conversationId);
  assert.deepEqual((await f.store.beginRun(req)).context.items, req.userItems);
  const response = modelResponse();
  await f.store.append(req.identity, response);
  await f.store.checkpoint(req.identity, f.store.loadContext());
  await f.store.ensureCapacity(req.identity, 65536);
  await f.store.append(req.identity, { type: 'tool_prepared', prepared, approval: approval(req.identity) });
  await f.store.append(req.identity, completion());
  await f.store.checkpoint(req.identity, f.store.loadContext());
  const result = await finish(f.store, req);
  const expected = structuredClone(result.context);
  await f.reopen();
  assert.deepEqual(f.store.loadContext(), expected);
  assert.equal(f.store.recoveryRequired, false);
  assert.deepEqual(f.store.listRuns()[0].result, result);
  const next = request(f.conversationId, { input: 'Continue', userItems: [{ role: 'user', content: 'Continue' }] });
  assert.deepEqual((await f.store.beginRun(next)).context.items, [...expected.items, ...next.userItems]);
  await f.store.append(next.identity, { type: 'model_response', response: { outputItems: [{ role: 'assistant', content: 'Done' }], toolCalls: [], finishReason: 'completed', usage: null } });
  assert.equal(f.store.loadContext().continuation, undefined);
  await finish(f.store, next);
});

test('submission mapping is durable, returns known result, and rejects payload or session changes', async t => {
  const f = await fixture(t);
  const req = request(f.conversationId);
  await f.store.beginRun(req);
  const duplicate = { ...req, identity: { ...req.identity, runId: randomUUID(), workerGeneration: 9 } };
  assert.equal((await f.store.beginRun(duplicate)).kind, 'duplicate');
  await assert.rejects(f.store.beginRun({ ...duplicate, input: 'different' }), { code: 'payload_mismatch' });
  await assert.rejects(f.store.beginRun({ ...duplicate, identity: { ...duplicate.identity, sessionId: 'other' } }), { code: 'payload_mismatch' });
  const result = await finish(f.store, req);
  await f.reopen();
  assert.deepEqual((await f.store.beginRun(duplicate)).result, result);
  assert.deepEqual(f.store.lookupSubmission(req.identity.requestId).request, req);
  assert.equal(f.store.listRuns().length, 1);
});

test('single writer, single active run and exact generation ownership are enforced', async t => {
  const f = await fixture(t);
  await assert.rejects(NativeRunStore.open({ rootDirectory: f.rootDirectory, conversationId: f.conversationId }), { code: 'writer_locked' });
  const req = request(f.conversationId);
  await f.store.beginRun(req);
  await assert.rejects(f.store.beginRun(request(f.conversationId)), { code: 'conversation_busy' });
  await assert.rejects(f.store.append({ ...req.identity, workerGeneration: 2 }, modelResponse()), { code: 'stale_owner' });
  await assert.rejects(f.store.append({ ...req.identity, sessionId: 'other' }, modelResponse()), { code: 'stale_owner' });
  await assert.rejects(f.store.append({ ...req.identity, conversationId: randomUUID() }, modelResponse()), { code: 'invalid_identity' });
});

test('tool preparation cannot replay and completed result is idempotent by run/call identity', async t => {
  const f = await fixture(t);
  const req = request(f.conversationId);
  await f.store.beginRun(req);
  await f.store.append(req.identity, modelResponse());
  const event = { type: 'tool_prepared', prepared, approval: approval(req.identity) };
  await f.store.append(req.identity, event);
  await assert.rejects(f.store.append(req.identity, event), { code: 'tool_already_prepared' });
  await assert.rejects(f.store.append(req.identity, { ...event, prepared: { ...prepared, call: { ...call, arguments: '{}' } } }), { code: 'payload_mismatch' });
  const done = completion();
  const first = await f.store.append(req.identity, done);
  assert.deepEqual(await f.store.append(req.identity, done), first);
  await assert.rejects(f.store.append(req.identity, { ...done, result: { ...done.result, output: 'different' } }), { code: 'payload_mismatch' });
  assert.equal(f.store.getToolState(req.identity.runId, call.id).state, 'completed');
});

test('approval must bind the full identity, policy and exact input digest', async t => {
  const f = await fixture(t); const req = request(f.conversationId);
  await f.store.beginRun(req); await f.store.append(req.identity, modelResponse());
  await assert.rejects(f.store.append(req.identity, { type: 'tool_prepared', prepared }), { code: 'approval_required' });
  const stale = approval(req.identity); stale.binding.workerGeneration++;
  await assert.rejects(f.store.append(req.identity, { type: 'tool_prepared', prepared, approval: stale }), { code: 'stale_approval' });
  await assert.rejects(f.store.append(req.identity, completion()), { code: 'not_prepared' });
});

test('reopening an interrupted prepared run records unknown effects and blocks new submissions', async t => {
  const f = await fixture(t); const req = request(f.conversationId);
  await f.store.beginRun(req); await f.store.append(req.identity, modelResponse());
  await f.store.append(req.identity, { type: 'tool_prepared', prepared, approval: approval(req.identity) });
  await f.reopen();
  assert.equal(f.store.recoveryRequired, true);
  assert.equal(f.store.listRuns()[0].status, 'recovery_required');
  assert.equal(f.store.getToolState(req.identity.runId, call.id).state, 'unknown');
  await assert.rejects(f.store.beginRun(request(f.conversationId)), { code: 'conversation_busy' });
  await assert.rejects(f.store.append(req.identity, { type: 'tool_prepared', prepared, approval: approval(req.identity) }), { code: 'run_not_active' });
  assert.equal(f.store.replay().at(-1).event.type, 'run_recovered');
});

test('a real dead process writer is reclaimed and its active run stays blocked for recovery', async t => {
  const rootDirectory = await mkdtemp(path.join(tmpdir(), 'native-store-crash-'));
  t.after(() => rm(rootDirectory, { recursive: true, force: true }));
  const conversationId = randomUUID(); const req = request(conversationId);
  const moduleUrl = new URL('../dist/run-store.js', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import { NativeRunStore } from ${JSON.stringify(moduleUrl)}; const store = await NativeRunStore.open(${JSON.stringify({ rootDirectory, conversationId })}); await store.beginRun(${JSON.stringify(req)}); process.exit(0);`], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const store = await NativeRunStore.open({ rootDirectory, conversationId });
  try { assert.equal(store.recoveryRequired, true); assert.equal(store.listRuns()[0].status, 'recovery_required'); } finally { await store.close(); }
});

test('normal stop records not-executed remainder and allows clean local continuation', async t => {
  const f = await fixture(t); const req = request(f.conversationId); const later = { ...call, id: 'call-two' };
  await f.store.beginRun(req); await f.store.append(req.identity, modelResponse([call, later]));
  await f.store.append(req.identity, { type: 'tool_prepared', prepared, approval: approval(req.identity) });
  await f.store.append(req.identity, completion());
  await f.store.append(req.identity, completion(later, 'not_executed'));
  await finish(f.store, req, 'cancelled');
  const expected = f.store.loadContext();
  await f.reopen();
  assert.equal(f.store.recoveryRequired, false); assert.deepEqual(f.store.loadContext(), expected);
  assert.equal((await f.store.beginRun(request(f.conversationId))).kind, 'accepted');
});

test('checkpoint is an exact committed journal index and may lag without losing context', async t => {
  const f = await fixture(t); const req = request(f.conversationId);
  await f.store.beginRun(req); await f.store.checkpoint(req.identity, f.store.loadContext());
  await assert.rejects(f.store.checkpoint(req.identity, { protocol, items: [] }), { code: 'context_mismatch' });
  await f.store.append(req.identity, modelResponse([])); await finish(f.store, req);
  const expected = f.store.loadContext();
  await f.reopen(); assert.deepEqual(f.store.loadContext(), expected);
  const copy = f.store.loadContext(); copy.items.length = 0;
  assert.deepEqual(f.store.loadContext(), expected, 'callers cannot mutate authoritative state');
});

for (const mode of ['truncated', 'corrupt', 'future']) test(`journal ${mode} fails closed`, async t => {
  const f = await fixture(t); const req = request(f.conversationId);
  await f.store.beginRun(req); await finish(f.store, req); await f.store.close();
  const file = path.join(f.store.directory, 'journal.jsonl'); let data = await readFile(file, 'utf8');
  if (mode === 'truncated') data = data.slice(0, -3);
  else if (mode === 'corrupt') data = data.replace('Fix the bug', 'Fix the BUG');
  else { const lines = data.split('\n'); const first = JSON.parse(lines[0]); first.schemaVersion = 9; lines[0] = JSON.stringify(first); data = lines.join('\n'); }
  await writeFile(file, data);
  await assert.rejects(NativeRunStore.open({ rootDirectory: f.rootDirectory, conversationId: f.conversationId }), { code: mode === 'future' ? 'unsupported_schema' : 'corrupt_store' });
});

test('future/corrupt checkpoint cannot silently fall back to an empty conversation', async t => {
  const f = await fixture(t); const req = request(f.conversationId);
  await f.store.beginRun(req); await finish(f.store, req); await f.store.checkpoint(req.identity, f.store.loadContext()); await f.store.close();
  const file = path.join(f.store.directory, 'checkpoint.json'); const data = JSON.parse(await readFile(file, 'utf8')); data.schemaVersion = 99;
  await writeFile(file, JSON.stringify(data));
  await assert.rejects(NativeRunStore.open({ rootDirectory: f.rootDirectory, conversationId: f.conversationId }), { code: 'unsupported_schema' });
});

for (const point of ['before_append', 'after_write', 'after_sync']) test(`fault at prepared ${point} never authorizes execution`, async t => {
  let armed = false; let executions = 0;
  const f = await fixture(t, { fault: (where, event) => { if (armed && where === point && event === 'tool_prepared') throw new Error('disk fault'); } });
  const req = request(f.conversationId); await f.store.beginRun(req); await f.store.append(req.identity, modelResponse()); armed = true;
  await assert.rejects((async () => { await f.store.append(req.identity, { type: 'tool_prepared', prepared, approval: approval(req.identity) }); executions++; })(), /disk fault/);
  assert.equal(executions, 0); assert.equal(f.store.recoveryRequired, true);
  await assert.rejects(f.store.append(req.identity, completion()), { code: 'recovery_required' });
  await f.reopen(); assert.equal(f.store.recoveryRequired, true);
  assert.equal(f.store.getToolState(req.identity.runId, call.id).state, point === 'before_append' ? 'requested' : 'unknown');
});

for (const point of ['before_append', 'after_sync']) test(`fault at completed ${point} never repeats an executed side effect`, async t => {
  let armed = false; let executions = 0;
  const f = await fixture(t, { fault: (where, event) => { if (armed && where === point && event === 'tool_completed') throw new Error('result fault'); } });
  const req = request(f.conversationId); await f.store.beginRun(req); await f.store.append(req.identity, modelResponse());
  await f.store.append(req.identity, { type: 'tool_prepared', prepared, approval: approval(req.identity) }); executions++; armed = true;
  await assert.rejects(f.store.append(req.identity, completion()), /result fault/);
  await f.reopen(); assert.equal(executions, 1); assert.equal(f.store.recoveryRequired, true);
  assert.equal(f.store.getToolState(req.identity.runId, call.id).state, point === 'before_append' ? 'unknown' : 'completed');
  await assert.rejects(f.store.beginRun(request(f.conversationId)), { code: 'conversation_busy' });
});

for (const point of ['before_checkpoint', 'after_checkpoint_sync', 'after_checkpoint_rename']) test(`checkpoint fault at ${point} retains journal truth and stops further work`, async t => {
  const f = await fixture(t, { fault: where => { if (where === point) throw new Error('checkpoint fault'); } });
  const req = request(f.conversationId); await f.store.beginRun(req); await f.store.append(req.identity, modelResponse([]));
  const expected = f.store.loadContext(); await assert.rejects(f.store.checkpoint(req.identity, expected), /checkpoint fault/);
  await assert.rejects(f.store.append(req.identity, modelResponse([])), { code: 'recovery_required' });
  await f.reopen(); assert.deepEqual(f.store.loadContext(), expected); assert.equal(f.store.recoveryRequired, true);
});

test('bounded records, total ledger and reserved tool capacity refuse work before side effects', async t => {
  const f = await fixture(t, { limits: { maxRecordBytes: 4096, maxJournalBytes: 16384, maxRecords: 4 } });
  const req = request(f.conversationId); await f.store.beginRun(req);
  await assert.rejects(f.store.ensureCapacity(req.identity, 65536), { code: 'limit_exceeded' });
  await assert.rejects(f.store.append(req.identity, { type: 'model_response', response: { ...modelResponse([]).response, outputItems: ['x'.repeat(8192)] } }), { code: 'limit_exceeded' });
  assert.equal(f.store.usage.records, 2);
});

test('safe UUID paths, private files, credential fields and resolved secret sentinels are enforced', async t => {
  const sentinel = 'sk-test-credential-never-persist-123';
  const f = await fixture(t, { forbiddenValues: [sentinel] });
  await assert.rejects(NativeRunStore.open({ rootDirectory: f.rootDirectory, conversationId: '../escape' }), { code: 'invalid_identity' });
  await assert.rejects(f.store.beginRun(request(f.conversationId, { configuration: { apiKey: sentinel } })), { code: 'secret_rejected' });
  await assert.rejects(f.store.beginRun(request(f.conversationId, { input: sentinel })), { code: 'secret_rejected' });
  assert.equal((await readFile(path.join(f.store.directory, 'journal.jsonl'), 'utf8')).includes(sentinel), false);
  const linkedId = randomUUID(); const outside = path.join(f.rootDirectory, 'outside'); await mkdir(outside);
  await symlink(outside, path.join(f.rootDirectory, linkedId), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(NativeRunStore.open({ rootDirectory: f.rootDirectory, conversationId: linkedId }), { code: 'unsafe_path' });
});


test('failed writer release is retryable and never leaves the closing store writable', async t => {
  const f = await fixture(t);
  const file = path.join(f.store.directory, '.writer-lock');
  const original = await readFile(file, 'utf8');
  await writeFile(file, JSON.stringify({ schemaVersion: 1, pid: process.pid, nonce: randomUUID() }));
  await assert.rejects(f.store.close(), { code: 'writer_lost' });
  await assert.rejects(f.store.beginRun(request(f.conversationId)), { code: 'store_closed' });
  await writeFile(file, original);
  await f.store.close();
  const reopened = await NativeRunStore.open({ rootDirectory: f.rootDirectory, conversationId: f.conversationId });
  await reopened.close();
});
