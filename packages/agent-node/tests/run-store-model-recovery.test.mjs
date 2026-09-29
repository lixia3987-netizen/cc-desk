import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NativeRunStore } from '../dist/run-store.js';

const usage = { inputTokens: 10, outputTokens: 4, totalTokens: 14 };
const failure = { category: 'service_unavailable', httpStatus: 503, retryable: true };
const started = attempt => ({ type: 'model_request_started', attempt });
const failed = (attempt, extra = {}) => ({ type: 'model_request_failed', attempt, failure, partial: false, ...extra });
const response = (text = 'complete', toolCalls = []) => ({ type: 'model_response', response: { outputItems: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }, ...toolCalls.map(call => ({ type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments }))], toolCalls, finishReason: toolCalls.length ? 'tool_calls' : 'completed', usage } });
async function fixture(t, options = {}) {
  const rootDirectory = await mkdtemp(path.join(tmpdir(), 'native-model-attempts-')), conversationId = randomUUID();
  let store = await NativeRunStore.open({ rootDirectory, conversationId, ...options });
  const req = { identity: { sessionId: 'session', conversationId, runId: randomUUID(), requestId: randomUUID(), workerGeneration: 1 }, input: 'Preserve exact goal', inputDigest: 'digest', userItems: [{ role: 'user', content: 'Preserve exact goal' }], protocol: { id: 'openai-responses', version: 1 }, configuration: {}, policyRevision: 'policy' };
  await store.beginRun(req);
  t.after(async () => { await store.close().catch(() => {}); await rm(rootDirectory, { recursive: true, force: true }); });
  return { req, get store() { return store; }, append: event => store.append(req.identity, event), reopen: async () => { await store.close(); store = await NativeRunStore.open({ rootDirectory, conversationId }); }, finish: (modelRequests, extra = {}) => store.append(req.identity, { type: 'run_finished', result: { identity: req.identity, status: 'completed', reason: 'model_completed', modelRequests, toolCalls: 0, usage, context: store.loadContext(), committed: true, ...extra } }) };
}
const resolve = f => f.store.resolveRecovery({ ...f.store.getRecoveryReport(), resourcesVerified: true });

test('model attempts record each failed paid possibility without fake response or context changes', async t => {
  const f = await fixture(t), original = f.store.loadContext();
  await f.append(started(1)); await f.append(failed(1, { retryDelayMs: 500 }));
  assert.deepEqual(f.store.loadContext(), original);
  await f.append(started(2)); await f.append(response()); await f.finish(2, { usage: null });
  const result = f.store.lookupSubmission(f.req.identity.requestId).result;
  await f.reopen(); assert.equal(f.store.recoveryRequired, false);
  assert.deepEqual(f.store.lookupSubmission(f.req.identity.requestId).result, result);
  assert.equal(f.store.replay().filter(record => record.event.type === 'model_response').length, 1);
  assert.deepEqual(result.usage, null); assert.equal(result.modelRequests, 2);
});

test('strict attempts reject reused identity, mismatched outcome, concurrent request and forged terminal', async t => {
  const f = await fixture(t);
  await assert.rejects(f.append(started(2)), { code: 'invalid_record' });
  await assert.rejects(f.append(failed(1)), { code: 'pending_model_request' });
  await f.append(started(1));
  await assert.rejects(f.append(started(2)), { code: 'pending_model_request' });
  await assert.rejects(f.append(failed(2)), { code: 'pending_model_request' });
  assert.throws(() => f.store.getRunCompactionSource(f.req.identity), { code: 'pending_model_request' });
  await assert.rejects(f.finish(0, { usage: null }), { code: 'invalid_record' });
  await assert.rejects(f.finish(1, { usage: null }), { code: 'recovery_required' });
  await f.append(failed(1));
  await assert.rejects(f.append(response()), { code: 'pending_model_request' });
  await assert.rejects(f.append(failed(1)), { code: 'pending_model_request' });
  await assert.rejects(f.finish(1, { status: 'failed' }), { code: 'invalid_usage' });
  await f.finish(1, { status: 'failed', reason: 'model_service_unavailable', usage: null });
});

test('retry metadata is bounded, rejects partial replay and cannot carry provider messages or invented usage', async t => {
  const f = await fixture(t); await f.append(started(1));
  for (const extra of [{ partial: true, retryDelayMs: 500 }, { retryDelayMs: 1500 }, { retryDelayMs: -1 }, { failure: { ...failure, message: 'raw service content' } }, { usage }, { failure: { category: 'network', retryable: true } }]) await assert.rejects(f.append(failed(1, extra)), { code: 'invalid_record' });
  await f.append(failed(1, { retryDelayMs: 500 })); await f.append(started(2));
  await assert.rejects(f.append(failed(2, { retryDelayMs: 500 })), { code: 'invalid_record' });
  await f.append(failed(2, { retryDelayMs: 1500 })); await f.append(started(3));
  await assert.rejects(f.append(failed(3, { retryDelayMs: 1500 })), { code: 'invalid_record' });
  await f.append(failed(3)); await f.finish(3, { status: 'failed', reason: 'model_retry_exhausted', usage: null });
});

test('requests cannot pass unresolved tool effects and a response cannot settle twice', async t => {
  const f = await fixture(t), call = { id: 'read', name: 'read_file', arguments: '{}' };
  await f.append(started(1)); await f.append(response('checking', [call]));
  await assert.rejects(f.append(response()), { code: 'pending_model_request' });
  await assert.rejects(f.append(started(2)), { code: 'pending_tools' });
  await f.append({ type: 'tool_completed', call, result: { status: 'unknown', output: 'unknown' }, resultItems: [{ type: 'function_call_output', call_id: call.id, output: 'unknown' }] });
  await assert.rejects(f.append(started(2)), { code: 'pending_tools' });
});

for (const outcome of ['pending', 'failed', 'response']) test(`recovery counts ${outcome} attempts and never replays or invents usage`, async t => {
  const f = await fixture(t); await f.append(started(1)); await f.append(response('first'));
  await f.append(started(2));
  if (outcome === 'failed') await f.append(failed(2));
  if (outcome === 'response') await f.append(response('second'));
  const before = f.store.loadContext(); await f.reopen();
  assert.equal(f.store.getRecoveryReport().classification, 'safe_to_continue');
  const result = await resolve(f); assert.equal(result.status, 'cancelled'); assert.equal(result.modelRequests, 2);
  assert.deepEqual(result.usage, outcome === 'response' ? { inputTokens: 20, outputTokens: 8, totalTokens: 28 } : null);
  assert.deepEqual(result.context, before);
  const count = f.store.usage.records; assert.deepEqual((await f.store.beginRun(f.req)).result, result); assert.equal(f.store.usage.records, count);
});

test('legacy response-only runs remain readable and count alongside later explicit attempts', async t => {
  const f = await fixture(t); await f.append(response('legacy')); await f.append(started(1)); await f.append(response('tracked'));
  await f.reopen(); const result = await resolve(f); assert.equal(result.modelRequests, 2); assert.deepEqual(result.usage, { inputTokens: 20, outputTokens: 8, totalTokens: 28 });
  assert.equal(f.store.replay().filter(record => record.event.type === 'model_request_started').length, 1);
});

for (const point of ['before_append', 'after_write', 'after_sync']) for (const eventType of ['model_request_started', 'model_request_failed', 'model_response']) test(`${point} ${eventType}: reopen uses only durable attempts and never auto-retries`, async t => {
  let armed = false;
  const f = await fixture(t, { fault: (at, type) => { if (armed && at === point && type === eventType) throw new Error('disk fault'); } });
  if (eventType !== 'model_request_started') await f.append(started(1));
  armed = true;
  await assert.rejects(f.append(eventType === 'model_request_started' ? started(1) : eventType === 'model_request_failed' ? failed(1) : response()), /disk fault/);
  assert.equal(f.store.recoveryRequired, true); await f.reopen(); const result = await resolve(f);
  assert.equal(result.modelRequests, eventType === 'model_request_started' && point === 'before_append' ? 0 : 1);
  assert.deepEqual(result.usage, eventType === 'model_response' && point !== 'before_append' ? usage : null);
  assert.equal(f.store.replay().filter(record => record.event.type === 'model_request_started').length, result.modelRequests);
});

test('starting a model request reserves both outcome and terminal storage before any request can be sent', async t => {
  const tooSmall = await fixture(t, { limits: { maxRecords: 4 } });
  await assert.rejects(tooSmall.append(started(1)), { code: 'limit_exceeded' }); assert.equal(tooSmall.store.usage.records, 2);
  const exact = await fixture(t, { limits: { maxRecords: 5 } });
  await exact.append(started(1)); await exact.append(failed(1, { retryDelayMs: 500 }));
  await assert.rejects(exact.append(started(2)), { code: 'limit_exceeded' });
  await exact.finish(1, { status: 'failed', reason: 'model_service_unavailable', usage: null }); assert.equal(exact.store.usage.records, 5);
});

for (const outcome of ['pending', 'failed', 'committed']) test(`summary ${outcome} and ordinary attempts use separate identities and share request budget`, async t => {
  const f = await fixture(t);
  await f.append(started(1)); await f.append(response('Old detail '.repeat(1000)));
  await f.append(started(2)); await f.append(response('Latest detail '.repeat(1000)));
  const source = f.store.getRunCompactionSource(f.req.identity), request = { requestId: randomUUID(), contextHash: source.contextHash };
  await f.store.reserveRunCompaction(f.req.identity, request);
  await assert.rejects(f.append(started(3)), { code: 'pending_model_request' });
  if (outcome === 'failed') await f.store.failRunCompaction(f.req.identity, { requestId: request.requestId, reason: 'summary_failed', usage });
  if (outcome === 'committed') await f.store.commitRunCompaction(f.req.identity, { ...request, summary: 'Older work done', continuity: 'Exact goal retained', usage });
  await f.reopen(); const result = await resolve(f);
  assert.equal(result.modelRequests, 3); assert.deepEqual(result.usage, outcome === 'pending' ? null : { inputTokens: 30, outputTokens: 12, totalTokens: 42 });
});

test('a stopped failure cannot authorize later requests, context maintenance, or completed terminal', async t => {
  const f = await fixture(t); await f.append(started(1)); await f.append(failed(1, { partial: true }));
  await assert.rejects(f.append(started(2)), { code: 'model_retry_unavailable' });
  assert.throws(() => f.store.getRunCompactionSource(f.req.identity), { code: 'pending_model_request' });
  await assert.rejects(f.finish(1, { usage: null }), { code: 'invalid_record' });
  await f.finish(1, { status: 'failed', reason: 'model_partial_response', usage: null });
});
