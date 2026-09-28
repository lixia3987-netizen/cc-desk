import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NativeRunStore } from '../dist/run-store.js';

const protocol = { id: 'openai-responses', version: 1 };
function request(conversationId, input = 'Preserve exact original goal and constraints', extra = {}) {
  return { identity: { sessionId: 'session', conversationId, runId: randomUUID(), requestId: randomUUID(), workerGeneration: 1 },
    input, inputDigest: input, userItems: [{ role: 'user', content: input }], protocol,
    configuration: { connectionId: 'local', model: 'fixture' }, policyRevision: 'policy', ...extra };
}
function response(calls = [], text = 'old detailed result '.repeat(500)) {
  return { type: 'model_response', response: { outputItems: [
    { type: 'reasoning', encrypted_content: 'unchanged opaque reasoning', summary: [] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
    ...calls.map(call => ({ type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments })),
  ], toolCalls: calls, continuation: { responseId: randomUUID() }, finishReason: calls.length ? 'tool_calls' : 'completed', usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } } };
}
function prepared(call, risk = 'read') {
  return { type: 'tool_prepared', prepared: { call, definition: { name: call.name, description: 'tool', inputSchema: { type: 'object' }, risk },
    input: {}, inputDigest: 'digest', policyRevision: 'policy', requiresApproval: false, preconditions: {} } };
}
function completion(call, status = 'completed') {
  const result = { status, output: 'durable actual outcome' };
  return { type: 'tool_completed', call, result, resultItems: [{ type: 'function_call_output', call_id: call.id, output: JSON.stringify(result) }] };
}
async function finish(store, req, status = 'completed') {
  const result = { identity: req.identity, status, reason: status, modelRequests: 1, toolCalls: 0, usage: null, context: store.loadContext(), committed: true };
  await store.append(req.identity, { type: 'run_finished', result });
  return result;
}
async function turn(store, conversationId, input = 'next task', calls = []) {
  const req = request(conversationId, input);
  await store.beginRun(req); await store.append(req.identity, response(calls));
  for (const call of calls) { await store.append(req.identity, prepared(call)); await store.append(req.identity, completion(call)); }
  await finish(store, req); return req;
}
async function fixture(t, options = {}) {
  const rootDirectory = await mkdtemp(path.join(tmpdir(), 'native-maintenance-')); const conversationId = randomUUID();
  let store = await NativeRunStore.open({ rootDirectory, conversationId, ...options });
  t.after(async () => { await store.close().catch(() => {}); await rm(rootDirectory, { recursive: true, force: true }); });
  return { rootDirectory, conversationId, get store() { return store; }, reopen: async (extra = {}) => {
    await store.close(); store = await NativeRunStore.open({ rootDirectory, conversationId, ...extra }); return store;
  } };
}
const call = { id: 'pending', name: 'read_file', arguments: '{}' };

test('safe recovery closes only unprepared calls, preserves completed outcomes and survives restart/idempotent retry', async t => {
  const f = await fixture(t), req = request(f.conversationId), completed = { ...call, id: 'done' };
  await f.store.beginRun(req); await f.store.append(req.identity, response([completed, call]));
  await f.store.append(req.identity, prepared(completed)); await f.store.append(req.identity, completion(completed));
  await f.reopen();
  const report = f.store.getRecoveryReport();
  assert.equal(report.classification, 'safe_to_continue');
  assert.deepEqual(report.tools.map(tool => tool.status), ['completed', 'not_executed']);
  const before = f.store.replay();
  await assert.rejects(f.store.resolveRecovery({ ...report, resourcesVerified: false }), { code: 'resources_unverified' });
  await assert.rejects(f.store.resolveRecovery({ ...report, expectedHash: 'stale', resourcesVerified: true }), { code: 'stale_context' });
  const result = await f.store.resolveRecovery({ ...report, resourcesVerified: true });
  assert.equal(result.status, 'cancelled'); assert.equal(f.store.recoveryRequired, false);
  assert.equal(f.store.getToolState(req.identity.runId, call.id).completed.result.status, 'not_executed');
  assert.deepEqual(f.store.getToolState(req.identity.runId, completed.id).completed, completion(completed));
  assert.deepEqual(f.store.replay().slice(0, before.length), before);
  assert.equal(f.store.replay().length, before.length + 1);
  await f.reopen();
  assert.deepEqual(await f.store.resolveRecovery({ ...report, resourcesVerified: true }), result);
  assert.deepEqual(f.store.lookupSubmission(req.identity.requestId).result, result);
  const expected = f.store.loadContext();
  const next = request(f.conversationId, 'Continue from committed results');
  assert.deepEqual((await f.store.beginRun(next)).context.items, [...expected.items, ...next.userItems]);
});

test('recovery preserves an existing terminal receipt and records separate resolution', async t => {
  const f = await fixture(t), req = request(f.conversationId);
  await f.store.beginRun(req); await f.store.append(req.identity, response([call]));
  const original = await finish(f.store, req, 'recovery_required');
  const report = f.store.getRecoveryReport();
  const resolution = await f.store.resolveRecovery({ ...report, resourcesVerified: true });
  assert.equal(resolution.usage, null, 'an original unknown usage receipt must remain unknown');
  assert.deepEqual(f.store.lookupSubmission(req.identity.requestId).result, original);
  assert.deepEqual(f.store.getRun(req.identity.runId).recoveryResolution.result, resolution);
  await f.reopen();
  assert.deepEqual(f.store.lookupSubmission(req.identity.requestId).result, original);
  assert.deepEqual(await f.store.resolveRecovery({ ...report, resourcesVerified: true }), resolution);
  assert.equal(f.store.recoveryRequired, false);
});

test('recovery never presents partial response usage as a complete cumulative value', async t => {
  for (const missing of [null, { outputTokens: 7 }]) {
    const f = await fixture(t), req = request(f.conversationId);
    await f.store.beginRun(req); await f.store.append(req.identity, response());
    const second = response(); second.response.usage = missing;
    await f.store.append(req.identity, second); await f.reopen();
    const result = await f.store.resolveRecovery({ ...f.store.getRecoveryReport(), resourcesVerified: true });
    assert.deepEqual(result.usage, missing === null ? null : { outputTokens: 27 });
  }
});

for (const risk of ['read', 'write', 'command']) test(`prepared ${risk} without durable outcome is never unlocked or replayed`, async t => {
  const f = await fixture(t), req = request(f.conversationId);
  await f.store.beginRun(req); await f.store.append(req.identity, response([call]));
  await f.store.append(req.identity, prepared(call, risk)); await f.reopen();
  const report = f.store.getRecoveryReport(); assert.equal(report.classification, 'unknown_effects');
  await assert.rejects(f.store.resolveRecovery({ ...report, resourcesVerified: true }), { code: 'unknown_effects' });
  await assert.rejects(f.store.beginRun(request(f.conversationId)), { code: 'conversation_busy' });
});

test('durable unknown tool outcome remains blocked and unsupported protocol cannot synthesize outputs', async t => {
  const f = await fixture(t), req = request(f.conversationId);
  await f.store.beginRun(req); await f.store.append(req.identity, response([call]));
  await f.store.append(req.identity, prepared(call)); await f.store.append(req.identity, completion(call, 'unknown'));
  await finish(f.store, req, 'recovery_required');
  assert.equal(f.store.getRecoveryReport().classification, 'unknown_effects');
  const other = await fixture(t), unknown = request(other.conversationId, 'task', { protocol: { id: 'unrecognized', version: 1 } });
  await other.store.beginRun(unknown); await other.reopen();
  assert.equal(other.store.getRecoveryReport().classification, 'unsupported_protocol');
  await assert.rejects(other.store.resolveRecovery({ ...other.store.getRecoveryReport(), resourcesVerified: true }), { code: 'unsupported_protocol' });
});

test('compaction preserves exact initial input, latest complete protocol turn, original ledger and next-turn context', async t => {
  const f = await fixture(t), first = await turn(f.store, f.conversationId, 'Original constraints: 保留中文、CRLF\r\nzero destructive actions');
  const beforeLatest = f.store.loadContext().items.length;
  await turn(f.store, f.conversationId, 'Recent complete turn', [call]);
  const originalContext = f.store.loadContext(), source = f.store.getCompactionSource();
  assert.equal(source.scope, 'prefix'); assert.deepEqual(source.context.items, originalContext.items.slice(0, beforeLatest));
  const journalFile = path.join(f.store.directory, 'journal.jsonl'), rawBefore = await readFile(journalFile, 'utf8');
  const plan = f.store.planContextCompaction({ summary: 'Goal retained; earlier checks passed. Next: continue.', expectedHash: source.expectedHash });
  assert.ok(plan.afterBytes < plan.beforeBytes);
  assert.deepEqual(plan.context.items[0], first.userItems[0]);
  assert.equal(plan.context.items[1].role, 'assistant');
  assert.deepEqual(plan.context.items.slice(2), originalContext.items.slice(beforeLatest));
  assert.equal(plan.context.continuation, undefined);
  const receipt = await f.store.commitContextCompaction(plan);
  assert.ok((await readFile(journalFile, 'utf8')).startsWith(rawBefore));
  assert.equal(f.store.getLastCompaction().expectedHash, source.expectedHash);
  assert.deepEqual(await f.store.commitContextCompaction(plan), receipt);
  await f.reopen();
  assert.deepEqual(f.store.loadContext(), plan.context);
  assert.deepEqual(await f.store.commitContextCompaction(plan), receipt);
  const next = request(f.conversationId, 'Continue');
  assert.deepEqual((await f.store.beginRun(next)).context.items, [...plan.context.items, ...next.userItems]);
});

test('repeated compaction includes the previous summary in its source and preserves the newest full turn', async t => {
  const f = await fixture(t); await turn(f.store, f.conversationId, 'first'); await turn(f.store, f.conversationId, 'second');
  await f.store.commitContextCompaction(f.store.planContextCompaction({ summary: 'First summary: preserve all constraints' }));
  await turn(f.store, f.conversationId, 'third');
  const source = f.store.getCompactionSource();
  assert.ok(JSON.stringify(source.context).includes('First summary'));
  const plan = f.store.planContextCompaction({ summary: 'Second summary: first and second progress', expectedHash: source.expectedHash });
  await f.store.commitContextCompaction(plan); await f.reopen();
  assert.deepEqual(f.store.loadContext(), plan.context);
  assert.ok(!JSON.stringify(plan.context).includes('First summary'));
  assert.ok(JSON.stringify(plan.context).includes('third'));
});

test('compaction rejects stale, forged, oversized, nonsaving or incomplete plans without modifying context', async t => {
  const f = await fixture(t); await turn(f.store, f.conversationId, 'first');
  assert.throws(() => f.store.getCompactionSource(), { code: 'nothing_to_compact' });
  await turn(f.store, f.conversationId, 'second'); const original = f.store.loadContext();
  assert.throws(() => f.store.planContextCompaction({ summary: 'x', expectedHash: 'old' }), { code: 'stale_context' });
  assert.throws(() => f.store.planContextCompaction({ summary: '中'.repeat(11_000) }), { code: 'invalid_summary' });
  assert.throws(() => f.store.planContextCompaction({ summary: 'x'.repeat(20_000) }), { code: 'compaction_not_smaller' });
  assert.throws(() => f.store.planContextCompaction({ summary: 'x', keepRecentTurns: 0 }), { code: 'invalid_limits' });
  const plan = f.store.planContextCompaction({ summary: 'short' });
  await assert.rejects(f.store.commitContextCompaction({ ...plan, context: { protocol, items: [] } }), { code: 'invalid_record' });
  assert.deepEqual(f.store.loadContext(), original);
  await turn(f.store, f.conversationId, 'newer');
  await assert.rejects(f.store.commitContextCompaction(plan), { code: 'stale_context' });
  const active = request(f.conversationId); await f.store.beginRun(active);
  assert.throws(() => f.store.getCompactionSource(), { code: 'conversation_busy' });
});

test('unknown Responses item or a broken function/result pair cannot be compressed away', async t => {
  const f = await fixture(t); await turn(f.store, f.conversationId, 'first');
  const req = request(f.conversationId, 'second'); await f.store.beginRun(req);
  const event = response(); event.response.outputItems.push({ type: 'future_server_operation', opaque: true });
  await f.store.append(req.identity, event); await finish(f.store, req);
  assert.throws(() => f.store.getCompactionSource(), { code: 'unsupported_protocol' });
  const other = await fixture(t); await turn(other.store, other.conversationId, 'first');
  const broken = request(other.conversationId, 'second'); await other.store.beginRun(broken);
  const event2 = response(); event2.response.outputItems.push({ type: 'function_call_output', call_id: 'absent', output: 'fabricated' });
  await other.store.append(broken.identity, event2); await finish(other.store, broken);
  assert.throws(() => other.store.getCompactionSource(), { code: 'unsupported_protocol' });
});

for (const operation of ['recovery_resolved', 'context_compacted']) for (const point of ['before_append', 'after_write', 'after_sync']) {
  test(`${operation} fault at ${point} leaves either the entire old or entire new state on reopen`, async t => {
    const f = await fixture(t); let invoke, expected;
    if (operation === 'recovery_resolved') {
      const req = request(f.conversationId); await f.store.beginRun(req); await f.store.append(req.identity, response([call])); await f.reopen();
      const report = f.store.getRecoveryReport();
      invoke = () => f.store.resolveRecovery({ ...report, resourcesVerified: true });
      expected = () => { assert.equal(f.store.recoveryRequired, point === 'before_append'); assert.equal(f.store.getToolState(req.identity.runId, call.id).completed?.result.status, point === 'before_append' ? undefined : 'not_executed'); };
    } else {
      await turn(f.store, f.conversationId, 'first'); await turn(f.store, f.conversationId, 'second');
      const old = f.store.loadContext(), plan = f.store.planContextCompaction({ summary: 'completed prefix' });
      invoke = () => f.store.commitContextCompaction(plan);
      expected = () => assert.deepEqual(f.store.loadContext(), point === 'before_append' ? old : plan.context);
    }
    await f.reopen({ fault: (candidate, event) => { if (candidate === point && event === operation) throw new Error('injected persistence fault'); } });
    await assert.rejects(invoke(), /injected persistence fault/);
    assert.equal(f.store.recoveryRequired, true);
    await f.reopen(); expected();
  });
}

test('compaction credentials and checkpoint limits are enforced before publishing', async t => {
  const f = await fixture(t); await turn(f.store, f.conversationId, 'first'); await turn(f.store, f.conversationId, 'second');
  await f.reopen({ forbiddenValues: ['private-sentinel-key'] });
  const plan = f.store.planContextCompaction({ summary: 'private-sentinel-key' });
  await assert.rejects(f.store.commitContextCompaction(plan), { code: 'secret_rejected' });
  assert.equal(f.store.getLastCompaction(), null);
  await f.reopen({ limits: { maxCheckpointBytes: 500 } });
  assert.throws(() => f.store.planContextCompaction({ summary: 'safe summary' }), { code: 'limit_exceeded' });
});

test('summary actual usage is validated, persisted separately and recovered after restart', async t => {
  const f = await fixture(t); await turn(f.store, f.conversationId, 'first'); await turn(f.store, f.conversationId, 'second');
  for (const usage of [{ inputTokens: -1 }, { outputTokens: 1.5 }, { totalTokens: Infinity }, { totalTokens: '3' }, { cost: 3 }]) {
    assert.throws(() => f.store.planContextCompaction({ summary: 'summary', usage }), { code: 'invalid_usage' });
  }
  const usage = { inputTokens: 123, outputTokens: 20, totalTokens: 143 };
  const plan = f.store.planContextCompaction({ summary: 'summary', usage });
  await f.store.commitContextCompaction(plan); await f.reopen();
  assert.deepEqual(f.store.getLastCompaction().usage, usage);
  assert.deepEqual(f.store.replay().at(-1).event.plan.usage, usage);
});
