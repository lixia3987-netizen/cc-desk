import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { canonicalJson, contextHasUserImages } from '@cc-desk/agent-core';
import { NativeRunStore } from '../dist/run-store.js';
import { contextPendingCalls } from '../dist/context-maintenance.js';

const protocols = ['openai-responses', 'openai-chat-completions'];
const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
async function fixture(t, id, options = {}) {
  const rootDirectory = await realpath(await mkdtemp(path.join(tmpdir(), 'native-image-maintenance-'))), conversationId = randomUUID();
  const protocol = { id, version: 1 };
  let store = await NativeRunStore.open({ rootDirectory, conversationId, ...options });
  t.after(async () => { await store.close().catch(() => {}); await rm(rootDirectory, { recursive: true, force: true }); });
  return { rootDirectory, conversationId, protocol, get store() { return store; }, async reopen() {
    await store.close(); store = await NativeRunStore.open({ rootDirectory, conversationId });
  } };
}
function request(f, input, withImage = false) {
  const chat = f.protocol.id === protocols[1];
  return { identity: { sessionId: 'session', conversationId: f.conversationId, runId: randomUUID(), requestId: randomUUID(), workerGeneration: 1 },
    input, inputDigest: input, protocol: f.protocol, configuration: {}, policyRevision: 'policy',
    userItems: [{ role: 'user', content: withImage ? [
      { type: chat ? 'text' : 'input_text', text: input },
      chat ? { type: 'image_url', image_url: { url: image, detail: 'auto' } } : { type: 'input_image', image_url: image, detail: 'auto' },
    ] : input }] };
}
async function batch(f, req, id = randomUUID()) {
  const chat = f.protocol.id === protocols[1], call = { id, name: 'read_file', arguments: '{}' };
  const text = 'Detailed earlier text, evidence and unresolved observations. '.repeat(200);
  const outputItems = chat ? [{ role: 'assistant', content: text, tool_calls: [{ id, type: 'function', function: { name: call.name, arguments: call.arguments } }] }]
    : [{ type: 'reasoning', encrypted_content: 'exact opaque reasoning', summary: [] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
      { type: 'function_call', call_id: id, name: call.name, arguments: call.arguments }];
  await f.store.append(req.identity, { type: 'model_response', response: { outputItems, toolCalls: [call], finishReason: 'tool_calls', usage,
    ...(chat ? {} : { continuation: { responseId: randomUUID() } }) } });
  await f.store.append(req.identity, { type: 'tool_prepared', prepared: { call,
    definition: { name: call.name, description: 'Read', inputSchema: {}, risk: 'read' }, input: {}, inputDigest: 'digest',
    policyRevision: 'policy', requiresApproval: false, preconditions: {} } });
  const result = { status: 'completed', output: `durable ${id}` };
  await f.store.append(req.identity, { type: 'tool_completed', call, result, resultItems: chat
    ? [{ role: 'tool', tool_call_id: id, content: JSON.stringify(result) }]
    : [{ type: 'function_call_output', call_id: id, output: JSON.stringify(result) }] });
}
async function finish(f, req) {
  await f.store.append(req.identity, { type: 'run_finished', result: { identity: req.identity, status: 'completed', reason: 'done',
    modelRequests: 2, toolCalls: 2, usage: null, context: f.store.loadContext(), committed: true } });
}
async function turn(f, text, withImage = false) {
  const req = request(f, text, withImage); await f.store.beginRun(req); await batch(f, req); await finish(f, req); return req;
}
async function reserveRun(f, req, summary = 'Short summary of earlier text.') {
  const source = f.store.getRunCompactionSource(req.identity, f.store.loadContext());
  const input = { requestId: randomUUID(), contextHash: source.contextHash, summary, continuity: 'Unverified task progress and original evidence remain available.', usage };
  await f.store.reserveRunCompaction(req.identity, input);
  return { source, input };
}

for (const protocol of protocols) {
  test(`${protocol}: manual compaction keeps the first image turn and entire ordered suffix across restart and re-compaction`, async t => {
    const f = await fixture(t, protocol), first = await turn(f, 'Exact original goal 中文\r\nconstraints');
    const firstBoundary = f.store.loadContext().items.length;
    await turn(f, 'Older plain text');
    const boundary = f.store.loadContext().items.length;
    const pictured = await turn(f, 'First pictured request', true);
    await turn(f, 'Later text must remain exact'); await turn(f, 'Second pictured request', true);
    const old = f.store.loadContext(), source = f.store.getCompactionSource();
    assert.deepEqual(source.context.items, old.items.slice(0, boundary));
    assert.equal(contextHasUserImages(source.context), false);
    assert.deepEqual(source.retainedContext.items, [...first.userItems, ...old.items.slice(boundary)]);
    const moreRecent = f.store.getCompactionSource({ keepRecentTurns: 4 });
    assert.deepEqual(moreRecent.context.items, old.items.slice(0, firstBoundary));
    assert.equal(contextHasUserImages(moreRecent.context), false);
    const largerSuffix = f.store.planContextCompaction({ summary: 'Text summary with more recent turns retained.', keepRecentTurns: 4 });
    assert.equal(largerSuffix.retainedTurns.length, 4);
    assert.deepEqual(largerSuffix.context.items.slice(2), old.items.slice(firstBoundary));
    const raw = await readFile(path.join(f.store.directory, 'journal.jsonl'), 'utf8');
    const plan = f.store.planContextCompaction({ summary: 'First text summary. '.repeat(100), expectedHash: source.expectedHash });
    assert.deepEqual(plan.context.items.slice(2), old.items.slice(boundary));
    assert.equal(plan.retainedTurns.length, 3);
    assert.deepEqual(contextPendingCalls(plan.context), []);
    assert.equal(plan.context.continuation, undefined);
    await assert.rejects(f.store.commitContextCompaction({ ...plan, context: { ...plan.context, items: plan.context.items.slice(0, 2) } }), { code: 'invalid_record' });
    const receipt = await f.store.commitContextCompaction(plan);
    assert.deepEqual(await f.store.commitContextCompaction(plan), receipt);
    assert.ok((await readFile(path.join(f.store.directory, 'journal.jsonl'), 'utf8')).startsWith(raw));
    await f.reopen();
    assert.deepEqual(f.store.loadContext(), plan.context);
    assert.deepEqual(await NativeRunStore.readSubmission(f, pictured.identity.runId), pictured);
    const secondSource = f.store.getCompactionSource();
    assert.equal(contextHasUserImages(secondSource.context), false);
    const second = f.store.planContextCompaction({ summary: 'Short text history.' });
    assert.deepEqual(second.context.items.slice(2), old.items.slice(boundary));
    await f.store.commitContextCompaction(second); await f.reopen();
    assert.deepEqual(f.store.loadContext(), second.context);
    assert.deepEqual(f.store.lookupSubmission(pictured.identity.requestId).request, pictured);
  });

  test(`${protocol}: automatic reservation binds the unchanged full image context while summarizing only older text`, async t => {
    const f = await fixture(t, protocol); await turn(f, 'Original text');
    const boundary = f.store.loadContext().items.length;
    await turn(f, 'Image input', true); await turn(f, 'Newest full turn');
    const old = f.store.loadContext(), source = f.store.getCompactionSource();
    const req = { requestId: randomUUID(), inputDigest: 'a'.repeat(64), configurationDigest: 'b'.repeat(64), expectedHash: source.expectedHash };
    await f.store.reserveAutoCompaction(req);
    const plan = f.store.planContextCompaction({ summary: 'Earlier text only.', expectedHash: f.store.getCompactionSource().expectedHash, automaticRequestId: req.requestId, usage });
    await f.store.commitContextCompaction(plan); await f.reopen();
    assert.equal(f.store.lookupAutoCompaction(req.requestId).status, 'committed');
    assert.deepEqual(f.store.loadContext().items.slice(2), old.items.slice(boundary));
    assert.deepEqual(await f.store.reserveAutoCompaction(req), { kind: 'existing', attempt: f.store.lookupAutoCompaction(req.requestId) });
  });

  for (const imageInCurrentTurn of [false, true]) test(`${protocol}: in-turn compaction retains complete image suffix and all turn/batch mappings (current image=${imageInCurrentTurn})`, async t => {
    const f = await fixture(t, protocol), first = await turn(f, 'Exact original goal');
    const boundary = f.store.loadContext().items.length;
    if (!imageInCurrentTurn) await turn(f, 'Earlier pictured request', true);
    const req = request(f, 'Exact current request', imageInCurrentTurn);
    await f.store.beginRun(req); await batch(f, req); await batch(f, req);
    const old = f.store.loadContext(), { source, input } = await reserveRun(f, req, 'Detailed text summary. '.repeat(100));
    assert.equal(contextHasUserImages(source.context), false);
    assert.deepEqual(source.context.items, old.items.slice(0, boundary));
    assert.deepEqual(source.retainedContext.items, [...first.userItems, ...old.items.slice(boundary)]);
    const receipt = await f.store.commitRunCompaction(req.identity, input);
    assert.deepEqual(receipt.context.items.slice(3), old.items.slice(boundary));
    assert.equal(receipt.context.items.filter(item => canonicalJson(item) === canonicalJson(req.userItems[0])).length, 1);
    assert.deepEqual(contextPendingCalls(receipt.context), []);
    const compacted = f.store.replay().at(-1).event.plan;
    assert.equal(compacted.retainedTurns.length, imageInCurrentTurn ? 1 : 2);
    assert.equal(compacted.retainedBatches.length, imageInCurrentTurn ? 2 : 3);
    await finish(f, req); await f.reopen();
    assert.deepEqual(f.store.loadContext(), receipt.context);
    const next = request(f, 'Next text-only active request');
    await f.store.beginRun(next); await batch(f, next); await batch(f, next);
    const laterOld = f.store.loadContext(), again = await reserveRun(f, next);
    assert.equal(contextHasUserImages(again.source.context), false);
    const later = await f.store.commitRunCompaction(next.identity, again.input);
    assert.deepEqual(later.context.items.slice(3), laterOld.items.slice(3));
    await finish(f, next); await f.reopen();
    assert.deepEqual(f.store.loadContext(), later.context);
    assert.deepEqual(await NativeRunStore.readSubmission(f, req.identity.runId), req);
  });

  test(`${protocol}: a first-turn image has no compressible prefix and reserves no automatic/in-turn request`, async t => {
    const f = await fixture(t, protocol), first = request(f, 'First image request', true);
    await f.store.beginRun(first); await batch(f, first); await batch(f, first);
    const original = f.store.loadContext(), count = f.store.usage.records;
    assert.throws(() => f.store.getRunCompactionSource(first.identity), { code: 'image_context_compaction_unsupported' });
    await assert.rejects(f.store.reserveRunCompaction(first.identity, { requestId: randomUUID(), contextHash: 'a'.repeat(64) }), { code: 'image_context_compaction_unsupported' });
    assert.equal(f.store.usage.records, count); assert.deepEqual(f.store.loadContext(), original);
    await finish(f, first); await turn(f, 'Later text');
    const idleCount = f.store.usage.records;
    assert.throws(() => f.store.getCompactionSource(), { code: 'image_context_compaction_unsupported' });
    await assert.rejects(f.store.reserveAutoCompaction({ requestId: randomUUID(), inputDigest: 'a'.repeat(64), configurationDigest: 'b'.repeat(64), expectedHash: f.store.replay().at(-1).hash }), { code: 'image_context_compaction_unsupported' });
    assert.equal(f.store.usage.records, idleCount);
    await f.reopen(); assert.equal(f.store.recoveryRequired, false);
  });

  test(`${protocol}: earlier pure-text compaction remains readable after an image turn and a later image-preserving compaction`, async t => {
    const f = await fixture(t, protocol); await turn(f, 'Original text'); await turn(f, 'Recent text');
    const legacy = f.store.planContextCompaction({ summary: 'Earlier pure text summary.' });
    assert.deepEqual(Object.keys(legacy).sort(), ['expectedHash', 'sourceSeq', 'summary', 'keepRecentTurns', 'beforeBytes', 'afterBytes', 'context', 'retainedTurns'].sort());
    await f.store.commitContextCompaction(legacy); await f.reopen();
    const boundary = f.store.loadContext().items.length;
    await turn(f, 'First later image', true); await turn(f, 'Later text');
    const old = f.store.loadContext(), source = f.store.getCompactionSource();
    assert.deepEqual(source.context.items, old.items.slice(0, boundary));
    const plan = f.store.planContextCompaction({ summary: 'Earlier text, compacted again.' });
    await f.store.commitContextCompaction(plan); await f.reopen();
    assert.deepEqual(f.store.loadContext().items.slice(2), old.items.slice(boundary));
  });

  test(`${protocol}: lost image-preserving in-turn commit acknowledgment replays one full suffix and no second summary`, async t => {
    let armed = false;
    const f = await fixture(t, protocol, { fault: (point, type) => {
      if (armed && point === 'after_sync' && type === 'run_context_compacted') throw new Error('lost image compaction acknowledgment');
    } });
    await turn(f, 'Older text');
    const boundary = f.store.loadContext().items.length;
    const req = request(f, 'Pictured current goal', true);
    await f.store.beginRun(req); await batch(f, req); await batch(f, req);
    const old = f.store.loadContext(), { input } = await reserveRun(f, req);
    armed = true;
    await assert.rejects(f.store.commitRunCompaction(req.identity, input), /lost image compaction acknowledgment/);
    assert.equal(f.store.recoveryRequired, true);
    await f.reopen();
    assert.deepEqual(f.store.loadContext().items.slice(3), old.items.slice(boundary));
    assert.equal(f.store.lookupRunCompaction(req.identity.runId).status, 'committed');
    const reservation = await f.store.reserveRunCompaction(req.identity, { requestId: input.requestId, contextHash: input.contextHash });
    assert.equal(reservation.kind, 'existing');
    assert.deepEqual(await NativeRunStore.readSubmission(f, req.identity.runId), req);
  });
}
