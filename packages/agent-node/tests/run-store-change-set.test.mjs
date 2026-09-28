import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NativeRunStore } from '../dist/run-store.js';

function preview(count = 3) {
  const value = { schemaVersion: 1, digest: 'a'.repeat(64), atomic: false,
    files: Array.from({ length: count }, (_, index) => ({ index, path: `file-${index}.txt`, kind: 'replace', beforeHash: 'b'.repeat(64), afterHash: 'c'.repeat(64), beforeBytes: 3, afterBytes: 3, diff: '-old\n+new', lineEndings: { before: 'none', after: 'none' }, noFinalNewline: { before: true, after: true } })),
    totalContentBytes: count * 3, previewBytes: 0 };
  while (value.previewBytes !== Buffer.byteLength(JSON.stringify(value))) value.previewBytes = Buffer.byteLength(JSON.stringify(value));
  return value;
}
async function fixture(t, options = {}) {
  const rootDirectory = await mkdtemp(path.join(tmpdir(), 'native-change-ledger-'));
  const conversationId = randomUUID();
  let store = await NativeRunStore.open({ rootDirectory, conversationId, ...options });
  const identity = { sessionId: 'session', conversationId, runId: randomUUID(), requestId: randomUUID(), workerGeneration: 1 };
  const call = { id: 'batch', name: 'apply_change_set', arguments: '{"changes":[]}' };
  const plan = preview();
  const prepared = { call, definition: { name: call.name, description: 'Apply', inputSchema: {}, risk: 'write' }, input: { changes: [] }, inputDigest: 'input-digest', policyRevision: 'policy', requiresApproval: true, preconditions: { changeSet: plan } };
  const approval = { binding: { ...identity, toolCallId: call.id, inputDigest: prepared.inputDigest, policyRevision: 'policy' }, decision: 'approved', expiresAt: Date.now() + 60000 };
  await store.beginRun({ identity, input: 'Apply files', inputDigest: 'digest', userItems: [{ role: 'user', content: 'Apply files' }], protocol: { id: 'openai.responses', version: 1 }, configuration: {}, policyRevision: 'policy' });
  await store.append(identity, { type: 'model_response', response: { outputItems: [{ type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments }], toolCalls: [call], finishReason: 'tool_calls', usage: null } });
  t.after(async () => { await store.close().catch(() => {}); await rm(rootDirectory, { recursive: true, force: true }); });
  const event = (index, status, extra = {}) => ({ changeSetDigest: plan.digest, index, path: plan.files[index].path, status, beforeHash: plan.files[index].beforeHash, afterHash: plan.files[index].afterHash, ...extra });
  return { get store() { return store; }, identity, call, plan, prepared, approval, event,
    prepare: () => store.append(identity, { type: 'tool_prepared', prepared, approval }),
    record: (index, status, extra) => store.recordChangeSetEvent(identity, call, event(index, status, extra)),
    reopen: async () => { await store.close(); store = await NativeRunStore.open({ rootDirectory, conversationId }); },
  };
}
function complete(f, states, status = 'completed') {
  const output = { digest: f.plan.digest, atomic: false, status, receiptCommitted: status !== 'unknown', files: states.map((state, index) => { const { changeSetDigest, ...file } = f.event(index, state); return file; }) };
  return f.store.append(f.identity, { type: 'tool_completed', call: f.call, result: { status: status === 'partial' ? 'failed' : status === 'not_applied' ? 'not_executed' : status, output }, resultItems: [{ type: 'function_call_output', call_id: f.call.id, output: JSON.stringify(output) }] });
}

test('only host API accepts exact approved file receipts and workers cannot forge host events', async t => {
  const f = await fixture(t);
  await assert.rejects(f.record(0, 'prepared'), { code: 'not_prepared' });
  await f.prepare();
  for (const type of ['change_set_file', 'run_recovered', 'context_compacted', 'startup_closed']) {
    await assert.rejects(f.store.append(f.identity, { type, toolCallId: f.call.id, progress: f.event(0, 'prepared') }), { code: 'invalid_record' });
  }
  await assert.rejects(f.store.recordChangeSetEvent({ ...f.identity, workerGeneration: 2 }, f.call, f.event(0, 'prepared')), { code: 'stale_owner' });
  await assert.rejects(f.store.recordChangeSetEvent(f.identity, { ...f.call, arguments: '{}' }, f.event(0, 'prepared')), { code: 'payload_mismatch' });
  for (const change of [{ path: 'other.txt' }, { changeSetDigest: 'd'.repeat(64) }, { beforeHash: null }, { afterHash: 'd'.repeat(64) }]) await assert.rejects(f.record(0, 'prepared', change), { code: 'payload_mismatch' });
  for (const errorCode of ['not a code', 123, { code: 'error' }]) await assert.rejects(f.record(0, 'prepared', { errorCode }), { code: 'invalid_record' });
  await f.record(0, 'prepared');
  assert.deepEqual(f.store.getToolState(f.identity.runId, f.call.id).changeSetProgress.map(({ seq, ...receipt }) => receipt), [f.event(0, 'prepared')]);
});

test('file effects require write-ahead then effect acknowledgement before the next file', async t => {
  const f = await fixture(t); await f.prepare();
  await assert.rejects(f.record(0, 'applied'), { code: 'invalid_record' });
  await assert.rejects(f.record(1, 'prepared'), { code: 'invalid_record' });
  await f.record(0, 'prepared');
  await assert.rejects(f.record(0, 'prepared'), { code: 'invalid_record' });
  await assert.rejects(f.record(1, 'prepared'), { code: 'invalid_record' });
  await f.record(0, 'applied');
  await f.record(1, 'prepared'); await f.record(1, 'not_applied', { errorCode: 'cancelled' });
  await assert.rejects(f.record(2, 'prepared'), { code: 'recovery_required' });
  await f.record(2, 'not_applied'); await complete(f, ['applied', 'not_applied', 'not_applied'], 'partial');
  await assert.rejects(f.record(0, 'prepared'), { code: 'not_prepared' });
});

test('unknown current file blocks later writes, preserves known prefix, and cannot become global success', async t => {
  const f = await fixture(t); await f.prepare();
  await f.record(0, 'prepared'); await f.record(0, 'applied');
  await f.record(1, 'prepared'); await f.record(1, 'unknown', { errorCode: 'write_uncertain' });
  await assert.rejects(f.record(2, 'prepared'), { code: 'recovery_required' });
  await f.record(2, 'not_applied');
  await assert.rejects(complete(f, ['applied', 'applied', 'applied']), { code: 'recovery_required' });
  await assert.rejects(complete(f, ['applied', 'applied', 'not_applied'], 'unknown'), { code: 'payload_mismatch' });
  await assert.rejects(complete(f, ['applied', 'not_applied', 'not_applied'], 'unknown'), { code: 'payload_mismatch' });
  await complete(f, ['applied', 'unknown', 'not_applied'], 'unknown');
  await f.reopen();
  assert.equal(f.store.getRecoveryReport().classification, 'unknown_effects');
  assert.equal(f.store.getToolState(f.identity.runId, f.call.id).changeSetProgress.at(-1).status, 'not_applied');
});

test('crash preserves per-file receipts but never synthesizes the final tool acknowledgement', async t => {
  const f = await fixture(t); await f.prepare();
  for (let index = 0; index < 3; index++) { await f.record(index, 'prepared'); await f.record(index, 'applied'); }
  await f.reopen();
  const tool = f.store.getToolState(f.identity.runId, f.call.id);
  assert.equal(tool.state, 'unknown'); assert.equal(tool.completed, undefined);
  assert.deepEqual(tool.changeSetProgress.filter(item => item.status === 'applied').map(item => item.index), [0, 1, 2]);
  assert.equal(f.store.getRecoveryReport().classification, 'unknown_effects');
  await assert.rejects(f.record(0, 'prepared'), { code: 'run_not_active' });
});

for (const point of ['before_append', 'after_sync']) test(`receipt failure at ${point} poisons the writer and restart retains only journal facts`, async t => {
  let receipts = 0;
  const f = await fixture(t, { fault: (actual, type) => { if (type === 'change_set_file' && actual === point && ++receipts === 2) throw new Error('injected receipt failure'); } });
  await f.prepare(); await f.record(0, 'prepared');
  await assert.rejects(f.record(0, 'applied'), /injected receipt failure/);
  await assert.rejects(f.record(1, 'prepared'), { code: 'recovery_required' });
  await f.reopen();
  const progress = f.store.getToolState(f.identity.runId, f.call.id).changeSetProgress;
  assert.deepEqual(progress.map(item => item.status), point === 'after_sync' ? ['prepared', 'applied'] : ['prepared']);
  assert.equal(f.store.getRecoveryReport().classification, 'unknown_effects');
});

test('all-file receipt and final result capacity is reserved before any file can be prepared', async t => {
  const f = await fixture(t, { limits: { maxRecords: 11 } });
  // Existing records=3; one prepared + six file receipts + result + terminal=12.
  await assert.rejects(f.prepare(), { code: 'limit_exceeded' });
  assert.equal(f.store.getToolState(f.identity.runId, f.call.id).prepared, undefined);
  await assert.rejects(f.record(0, 'prepared'), { code: 'not_prepared' });
});
