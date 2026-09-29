import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NativeRunStore } from '../dist/run-store.js';

const protocol = { id: 'openai-responses', version: 1 };
const sha = value => createHash('sha256').update(value).digest('hex');
function request(conversationId, input = 'Original goal', extra = {}) {
  return { identity: { sessionId: 'session', conversationId, runId: randomUUID(), requestId: randomUUID(), workerGeneration: 1 },
    input, inputDigest: sha(input), userItems: [{ role: 'user', content: input }], protocol,
    configuration: { model: 'fixture' }, policyRevision: 'policy', ...extra };
}
async function turn(store, conversationId, input = 'Next instruction', extra = {}) {
  const req = request(conversationId, input, extra);
  await store.beginRun(req);
  await store.append(req.identity, { type: 'model_response', response: {
    outputItems: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Detailed previous work. '.repeat(400) }] }],
    toolCalls: [], finishReason: 'completed', usage: null, continuation: { responseId: randomUUID() },
  } });
  const result = { identity: req.identity, status: 'completed', modelRequests: 1, toolCalls: 0, usage: null, context: store.loadContext(), committed: true };
  await store.append(req.identity, { type: 'run_finished', result });
  return { req, result };
}
async function fixture(t, { turns = 2, ...options } = {}) {
  const rootDirectory = await mkdtemp(path.join(tmpdir(), 'native-auto-compaction-')), conversationId = randomUUID();
  let store = await NativeRunStore.open({ rootDirectory, conversationId, ...options });
  t.after(async () => { await store.close().catch(() => {}); await rm(rootDirectory, { recursive: true, force: true }); });
  const completed = [];
  for (let i = 0; i < turns; i++) completed.push(await turn(store, conversationId, `Goal ${i}`));
  return { rootDirectory, conversationId, completed, get store() { return store; }, reopen: async (extra = {}) => {
    await store.close(); store = await NativeRunStore.open({ rootDirectory, conversationId, ...extra }); return store;
  } };
}
function reservation(store, extra = {}) {
  return { requestId: randomUUID(), inputDigest: sha('new instruction'), configurationDigest: sha('configuration'), expectedHash: store.replay().at(-1).hash, ...extra };
}
function automaticPlan(store, requestId, extra = {}) {
  return store.planContextCompaction({ summary: 'Earlier work completed; preserve goals and pending items.', expectedHash: store.getCompactionSource().expectedHash, automaticRequestId: requestId, ...extra });
}

test('reservation is durable before model use, does not alter context, create a run or require recovery, and getters return clones', async t => {
  const f = await fixture(t), request = reservation(f.store), before = f.store.loadContext(), runs = f.store.listRuns();
  const prior = f.store.replay();
  const result = await f.store.reserveAutoCompaction(request);
  assert.equal(result.kind, 'reserved');
  assert.deepEqual(result.attempt, { ...request, contextHash: result.attempt.contextHash, seq: prior.length + 1, createdAt: result.attempt.createdAt, status: 'attempted' });
  assert.match(result.attempt.contextHash, /^[0-9a-f]{64}$/);
  assert.ok(Number.isFinite(Date.parse(result.attempt.createdAt)));
  const journal = (await readFile(path.join(f.store.directory, 'journal.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(journal.at(-1).event.type, 'context_compaction_attempted');
  assert.equal(journal.at(-1).identity, undefined);
  assert.deepEqual(f.store.loadContext(), before); assert.deepEqual(f.store.listRuns(), runs);
  assert.equal(f.store.recoveryRequired, false); assert.equal(f.store.getRecoveryReport(), null);
  result.attempt.status = 'committed';
  f.store.lookupAutoCompaction(request.requestId).inputDigest = 'tampered';
  f.store.getAutoCompactionForCurrentContext().contextHash = 'tampered';
  await f.reopen();
  assert.deepEqual(f.store.loadContext(), before); assert.deepEqual(f.store.listRuns(), runs);
  assert.equal(f.store.lookupAutoCompaction(request.requestId).status, 'attempted');
  assert.equal(f.store.lookupAutoCompaction(request.requestId).inputDigest, request.inputDigest);
  assert.match(f.store.getAutoCompactionForCurrentContext().contextHash, /^[0-9a-f]{64}$/);
  assert.equal(f.store.recoveryRequired, false);
});

test('same request or same complete context allows only one durable reservation, including after restart', async t => {
  const f = await fixture(t), req = reservation(f.store);
  const [first, simultaneous] = await Promise.all([f.store.reserveAutoCompaction(req), f.store.reserveAutoCompaction(req)]);
  assert.equal(first.kind, 'reserved'); assert.equal(simultaneous.kind, 'existing');
  const count = f.store.usage.records;
  assert.deepEqual(await f.store.reserveAutoCompaction(req), { kind: 'existing', attempt: first.attempt });
  const another = reservation(f.store, { inputDigest: sha('another input'), configurationDigest: sha('another configuration') });
  assert.deepEqual(await f.store.reserveAutoCompaction(another), { kind: 'existing', attempt: first.attempt });
  assert.equal(f.store.lookupAutoCompaction(another.requestId), undefined);
  await f.reopen();
  assert.deepEqual(await f.store.reserveAutoCompaction(req), { kind: 'existing', attempt: first.attempt });
  assert.deepEqual(await f.store.reserveAutoCompaction(reservation(f.store)), { kind: 'existing', attempt: first.attempt });
  assert.equal(f.store.usage.records, count);
});

test('request IDs cannot change input or configuration, even once the conversation changes', async t => {
  const f = await fixture(t), req = reservation(f.store);
  await f.store.reserveAutoCompaction(req);
  for (const changed of [{ inputDigest: sha('different') }, { configurationDigest: sha('different') }]) {
    await assert.rejects(f.store.reserveAutoCompaction({ ...req, ...changed }), { code: 'payload_mismatch' });
  }
  await turn(f.store, f.conversationId, 'Actual new turn');
  assert.equal(f.store.getAutoCompactionForCurrentContext(), null);
  assert.equal((await f.store.reserveAutoCompaction({ ...req, expectedHash: f.store.getCompactionSource().expectedHash })).kind, 'existing');
  await assert.rejects(f.store.reserveAutoCompaction({ ...req, inputDigest: sha('different') }), { code: 'payload_mismatch' });
  const next = await f.store.reserveAutoCompaction(reservation(f.store));
  assert.equal(next.kind, 'reserved'); assert.notEqual(next.attempt.contextHash, f.store.lookupAutoCompaction(req.requestId).contextHash);
});

test('automatic compaction binds the reservation, commits once, preserves original submission receipt and replays after restart', async t => {
  const f = await fixture(t), req = reservation(f.store), original = f.completed[0];
  await f.store.reserveAutoCompaction(req);
  const plan = automaticPlan(f.store, req.requestId, { usage: { inputTokens: 30, outputTokens: 5, totalTokens: 35 } });
  const committed = await f.store.commitContextCompaction(plan);
  const attempt = f.store.lookupAutoCompaction(req.requestId);
  assert.equal(attempt.status, 'committed'); assert.equal(attempt.compactionSeq, committed.seq);
  assert.equal(f.store.getLastCompaction().automaticRequestId, req.requestId);
  assert.equal(f.store.getAutoCompactionForCurrentContext(), null);
  assert.deepEqual(await f.store.commitContextCompaction(plan), committed);
  await f.reopen();
  assert.deepEqual(f.store.lookupAutoCompaction(req.requestId), attempt);
  assert.deepEqual(f.store.loadContext(), plan.context);
  assert.deepEqual(f.store.lookupSubmission(original.req.identity.requestId).result, original.result);
  assert.deepEqual(await f.store.commitContextCompaction(plan), committed);
  assert.equal((await f.store.reserveAutoCompaction(req)).kind, 'existing');
  await turn(f.store, f.conversationId, 'Later actual work');
  await f.store.commitContextCompaction(f.store.planContextCompaction({ summary: 'Newer manual summary' }));
  await f.reopen();
  assert.deepEqual(await f.store.commitContextCompaction(plan), committed, 'old automatic receipt survives later compactions');
  assert.deepEqual(f.store.lookupAutoCompaction(req.requestId), attempt);
  await assert.rejects(f.store.commitContextCompaction({ ...plan, summary: 'Different summary' }), { code: 'payload_mismatch' });
});

test('automatic plans cannot forge a reservation or reuse it after context change', async t => {
  const f = await fixture(t), req = reservation(f.store);
  assert.throws(() => automaticPlan(f.store, req.requestId), { code: 'auto_compaction_unavailable' });
  await f.store.reserveAutoCompaction(req);
  assert.throws(() => automaticPlan(f.store, req.requestId, { expectedHash: req.expectedHash }), { code: 'stale_context' });
  assert.throws(() => automaticPlan(f.store, req.requestId, { expectedHash: undefined }), { code: 'stale_context' });
  const plan = automaticPlan(f.store, req.requestId);
  await assert.rejects(f.store.commitContextCompaction({ ...plan, automaticRequestId: randomUUID() }), { code: 'auto_compaction_unavailable' });
  await turn(f.store, f.conversationId, 'Changed context');
  assert.throws(() => automaticPlan(f.store, req.requestId), { code: 'stale_context' });
  await assert.rejects(f.store.commitContextCompaction(plan), { code: 'stale_context' });
  assert.equal(f.store.lookupAutoCompaction(req.requestId).status, 'attempted');
});

test('manual compaction stays compatible and does not misreport an attempted automatic summary as committed', async t => {
  const f = await fixture(t);
  const oldPlan = f.store.planContextCompaction({ summary: 'Manual before automatic feature' });
  assert.equal('automaticRequestId' in oldPlan, false);
  const oldReceipt = await f.store.commitContextCompaction(oldPlan);
  await f.reopen(); assert.deepEqual(await f.store.commitContextCompaction(oldPlan), oldReceipt);
  assert.equal('automaticRequestId' in f.store.getLastCompaction(), false);
  await turn(f.store, f.conversationId, 'New work');
  const req = reservation(f.store); await f.store.reserveAutoCompaction(req);
  await f.store.commitContextCompaction(f.store.planContextCompaction({ summary: 'Explicit manual retry after automatic failure' }));
  await f.reopen();
  assert.equal(f.store.lookupAutoCompaction(req.requestId).status, 'attempted');
  assert.equal(f.store.lookupAutoCompaction(req.requestId).compactionSeq, undefined);
  assert.equal('automaticRequestId' in f.store.getLastCompaction(), false);
});

for (const point of ['before_append', 'after_write', 'after_sync']) {
  test(`ambiguous reservation ${point} never authorizes model use; reopening restores durable deduplication`, async t => {
    const f = await fixture(t), req = reservation(f.store), original = f.store.loadContext();
    await f.reopen({ fault: (candidate, event) => { if (candidate === point && event === 'context_compaction_attempted') throw new Error('reservation fault'); } });
    await assert.rejects(f.store.reserveAutoCompaction(req), /reservation fault/);
    assert.equal(f.store.recoveryRequired, true);
    await assert.rejects(f.store.reserveAutoCompaction(req), { code: 'recovery_required' });
    await f.reopen();
    assert.deepEqual(f.store.loadContext(), original); assert.equal(f.store.recoveryRequired, false);
    if (point === 'before_append') {
      assert.equal(f.store.lookupAutoCompaction(req.requestId), undefined);
      assert.equal((await f.store.reserveAutoCompaction(req)).kind, 'reserved');
    } else {
      assert.equal(f.store.lookupAutoCompaction(req.requestId).status, 'attempted');
      assert.equal((await f.store.reserveAutoCompaction(req)).kind, 'existing');
      assert.equal((await f.store.reserveAutoCompaction(reservation(f.store))).kind, 'existing');
    }
  });
}

test('automatic committed receipt survives an ambiguous fsync acknowledgement', async t => {
  const f = await fixture(t), req = reservation(f.store);
  await f.store.reserveAutoCompaction(req); const plan = automaticPlan(f.store, req.requestId);
  await f.reopen({ fault: (point, event) => { if (point === 'after_sync' && event === 'context_compacted') throw new Error('compaction receipt fault'); } });
  await assert.rejects(f.store.commitContextCompaction(plan), /compaction receipt fault/);
  await f.reopen();
  assert.equal(f.store.lookupAutoCompaction(req.requestId).status, 'committed');
  assert.deepEqual(await f.store.commitContextCompaction(plan), { seq: f.store.lookupAutoCompaction(req.requestId).compactionSeq });
  assert.deepEqual(f.store.loadContext(), plan.context);
});

test('reservation rejects stale heads, malformed identities, credentials and exhausted journal limits', async t => {
  const f = await fixture(t), req = reservation(f.store), count = f.store.usage.records;
  await assert.rejects(f.store.reserveAutoCompaction({ ...req, expectedHash: '0'.repeat(64) }), { code: 'stale_context' });
  for (const invalid of [{ requestId: '' }, { requestId: 'x'.repeat(257) }, { requestId: 'a\0b' }, { inputDigest: 'not-a-hash' }, { configurationDigest: 'F'.repeat(64) }, { expectedHash: 'wrong' }]) {
    await assert.rejects(f.store.reserveAutoCompaction({ ...req, ...invalid }), { code: 'invalid_record' });
  }
  assert.equal(f.store.usage.records, count);
  await f.reopen({ forbiddenValues: ['secret-request-id'] });
  await assert.rejects(f.store.reserveAutoCompaction({ ...req, requestId: 'secret-request-id' }), { code: 'secret_rejected' });
  assert.equal(f.store.lookupAutoCompaction('secret-request-id'), undefined);
  await f.reopen({ limits: { maxRecords: count } });
  await assert.rejects(f.store.reserveAutoCompaction(req), { code: 'limit_exceeded' });
  assert.equal(f.store.lookupAutoCompaction(req.requestId), undefined);
});

test('reservation requires a complete supported idle context with a compressible prefix and no recovery barrier', async t => {
  const f = await fixture(t, { turns: 1 });
  await assert.rejects(f.store.reserveAutoCompaction(reservation(f.store)), { code: 'nothing_to_compact' });
  await turn(f.store, f.conversationId);
  const req = request(f.conversationId); await f.store.beginRun(req);
  await assert.rejects(f.store.reserveAutoCompaction(reservation(f.store)), { code: 'conversation_busy' });
  await f.reopen();
  await assert.rejects(f.store.reserveAutoCompaction(reservation(f.store)), { code: 'conversation_busy' });
  const unsupported = await fixture(t, { turns: 0 });
  await turn(unsupported.store, unsupported.conversationId, 'First', { protocol: { id: 'future', version: 1 } });
  await turn(unsupported.store, unsupported.conversationId, 'Second', { protocol: { id: 'future', version: 1 } });
  await assert.rejects(unsupported.store.reserveAutoCompaction(reservation(unsupported.store)), { code: 'unsupported_protocol' });
  const broken = await fixture(t, { turns: 1 });
  const second = request(broken.conversationId); await broken.store.beginRun(second);
  await broken.store.append(second.identity, { type: 'model_response', response: { outputItems: [{ type: 'function_call_output', call_id: 'missing', output: 'orphan' }], toolCalls: [], finishReason: 'completed', usage: null } });
  await broken.store.append(second.identity, { type: 'run_finished', result: { identity: second.identity, status: 'completed', modelRequests: 1, toolCalls: 0, usage: null, context: broken.store.loadContext(), committed: true } });
  await assert.rejects(broken.store.reserveAutoCompaction(reservation(broken.store)), { code: 'unsupported_protocol' });
});
