import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createModelRequestDiagnostic } from '@cc-desk/agent-core';
import { NativeRunStore } from '../dist/run-store.js';

const digest = value => createHash('sha256').update(value).digest('hex');
const usage = { inputTokens: 20, outputTokens: 3, totalTokens: 23, cacheReadInputTokens: 5, cacheCreationInputTokens: 2, nonCachedInputTokens: 13 };
const providerUsage = { raw: { input_tokens: 20, output_tokens: 3, cached_tokens: 5, cache_write_tokens: 2 }, normalization: 'openai-inclusive-input' };
async function fixture(t) {
  const rootDirectory = await mkdtemp(path.join(tmpdir(), 'native-usage-diagnostics-')), conversationId = randomUUID();
  let store = await NativeRunStore.open({ rootDirectory, conversationId });
  const request = { identity: { sessionId: 'session', conversationId, runId: randomUUID(), requestId: randomUUID(), workerGeneration: 1 }, input: 'private-user-text', inputDigest: 'digest', userItems: [{ role: 'user', content: 'private-user-text' }], protocol: { id: 'openai-responses', version: 1 }, configuration: {}, policyRevision: 'policy' };
  await store.beginRun(request);
  t.after(async () => { await store.close().catch(() => {}); await rm(rootDirectory, { recursive: true, force: true }); });
  return { request, get store() { return store; }, reopen: async () => { await store.close(); store = await NativeRunStore.open({ rootDirectory, conversationId }); } };
}
const response = () => ({ type: 'model_response', response: { outputItems: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }], toolCalls: [], finishReason: 'completed', usage, providerUsage } });
const makeDiagnostic = (identity, context, purpose = 'normal') => createModelRequestDiagnostic({ identity, requestKey: `${identity.runId}:${identity.requestId}:1`, attempt: 1, purpose, context, tools: [], model: 'k3[1M]', estimatedInputTokens: 99, estimateMethod: 'utf8_bytes', estimateSource: 'fallback', host: { now: () => 100, digest } });

test('request diagnostics deduplicate by request and phase and raw/cache fields survive journal replay', async t => {
  const f = await fixture(t), identity = f.request.identity;
  await f.store.append(identity, { type: 'model_request_started', attempt: 1 });
  const diagnostic = await makeDiagnostic(identity, f.store.loadContext());
  const receipt = await f.store.append(identity, { type: 'model_request_diagnostic', diagnostic });
  assert.deepEqual(await f.store.append(identity, { type: 'model_request_diagnostic', diagnostic }), receipt);
  await assert.rejects(f.store.append(identity, { type: 'model_request_diagnostic', diagnostic: { ...diagnostic, estimatedInputTokens: 100 } }), { code: 'payload_mismatch' });
  const finished = { ...diagnostic, phase: 'finished', requestSent: true, finishedAt: 101, elapsedMs: 1, outcome: 'completed', usage, providerUsage };
  await f.store.append(identity, { type: 'model_request_diagnostic', diagnostic: finished });
  await f.store.append(identity, response());
  const result = { identity, status: 'completed', reason: 'model_completed', modelRequests: 1, toolCalls: 0, usage, context: f.store.loadContext(), committed: true };
  await assert.rejects(f.store.append(identity, { type: 'run_finished', result: { ...result, usage: { inputTokens: 1, outputTokens: 3, totalTokens: 4, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, nonCachedInputTokens: 1 } } }), { code: 'invalid_usage' });
  await f.store.append(identity, { type: 'run_finished', result });
  await f.reopen();
  assert.deepEqual(f.store.lookupSubmission(identity.requestId).result.usage, usage);
  const diagnostics = f.store.replay().filter(record => record.event.type === 'model_request_diagnostic');
  assert.equal(diagnostics.length, 2);
  assert.deepEqual(diagnostics[1].event.diagnostic.providerUsage, providerUsage);
  assert.equal(diagnostics[1].event.diagnostic.model, 'k3[1M]');
  assert.equal(JSON.stringify(diagnostics).includes('private-user-text'), false);
  assert.equal(f.store.recoveryRequired, false);
});

test('diagnostic identities, strict fields, transitions and normalized usage cannot be forged', async t => {
  const f = await fixture(t), identity = f.request.identity;
  await f.store.append(identity, { type: 'model_request_started', attempt: 1 });
  const diagnostic = await makeDiagnostic(identity, f.store.loadContext());
  for (const modified of [{ ...diagnostic, body: 'private' }, { ...diagnostic, identity: { ...identity, workerGeneration: 2 } }, { ...diagnostic, attempt: 2 }, { ...diagnostic, phase: 'finished', outcome: 'completed', finishedAt: 101 }]) {
    await assert.rejects(f.store.append(identity, { type: 'model_request_diagnostic', diagnostic: modified }));
  }
  await f.store.append(identity, { type: 'model_request_diagnostic', diagnostic });
  await assert.rejects(f.store.append(identity, response()), { code: 'invalid_record' });
  await f.store.append(identity, { type: 'model_request_diagnostic', diagnostic: { ...diagnostic, phase: 'finished', finishedAt: 101, outcome: 'completed', usage, providerUsage } });
  await assert.rejects(f.store.append(identity, { ...response(), response: { ...response().response, usage: { ...usage, inputTokens: 21 } } }), { code: 'invalid_usage' });
  await f.store.append(identity, response());
});

test('recovery retains cache counts and excludes a separately stored summary diagnostic from cumulative usage', async t => {
  const f = await fixture(t), identity = f.request.identity;
  await f.store.append(identity, { type: 'model_request_started', attempt: 1 });
  await f.store.append(identity, response());
  const summaryIdentity = { ...identity, runId: randomUUID(), requestId: `in-turn:${identity.runId}` };
  const started = { ...await makeDiagnostic(summaryIdentity, f.store.loadContext(), 'summary_in_run'), parentRunId: identity.runId };
  await f.store.recordModelDiagnostic(started);
  await f.store.recordModelDiagnostic({ ...started, phase: 'finished', finishedAt: 101, outcome: 'completed', requestSent: true, usage, providerUsage });
  await f.reopen();
  const recovered = await f.store.resolveRecovery({ ...f.store.getRecoveryReport(), resourcesVerified: true });
  assert.deepEqual(recovered.usage, usage, 'telemetry is not an additional charge receipt');
  assert.equal(recovered.modelRequests, 1);
});
