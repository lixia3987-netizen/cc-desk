import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NativeRunStore } from '../dist/run-store.js';
import { contextPendingCalls, requireCompleteContext, nativeToolResultItems, nativeResponseCalls, isNativeTextSummary } from '../dist/context-maintenance.js';

const protocol = { id: 'openai-chat-completions', version: 1 };
const call = { id: 'read-1', name: 'read_file', arguments: '{"path":"a.txt"}' };
const message = (text, calls = []) => ({ role: 'assistant', content: text,
  ...(calls.length ? { tool_calls: calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })) } : {}) });
const request = (conversationId, input = 'Keep original user constraints') => ({
  identity: { sessionId: 'session', conversationId, runId: randomUUID(), requestId: randomUUID(), workerGeneration: 1 },
  input, inputDigest: input, userItems: [{ role: 'user', content: input }], protocol,
  configuration: { connectionId: 'fixture', protocol: 'chat-completions', model: 'fixture' }, policyRevision: 'policy',
});
const response = (calls = [], text = 'Long original result. '.repeat(400)) => ({ type: 'model_response', response: {
  outputItems: [message(text, calls)], toolCalls: calls, finishReason: calls.length ? 'tool_calls' : 'completed', usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
} });
async function fixture(t) {
  const rootDirectory = await mkdtemp(path.join(tmpdir(), 'chat-context-')), conversationId = randomUUID();
  let store = await NativeRunStore.open({ rootDirectory, conversationId });
  t.after(async () => { await store.close(); await rm(rootDirectory, { recursive: true, force: true }); });
  return { conversationId, get store() { return store; }, async reopen() { await store.close(); store = await NativeRunStore.open({ rootDirectory, conversationId }); } };
}
async function turn(f, input, calls = []) {
  const req = request(f.conversationId, input); await f.store.beginRun(req); await f.store.append(req.identity, response(calls));
  for (const current of calls) {
    const result = { status: 'denied', output: 'User denied; no execution' };
    await f.store.append(req.identity, { type: 'tool_completed', call: current, result, resultItems: nativeToolResultItems(protocol, current, result) });
  }
  await f.store.append(req.identity, { type: 'run_finished', result: { identity: req.identity, status: 'completed', reason: 'model_completed', modelRequests: 1, toolCalls: calls.length, usage: null, context: f.store.loadContext(), committed: true } });
  return req;
}

test('chat native messages retain ordered parallel calls and tool result pairing', () => {
  const second = { ...call, id: 'read-2' };
  const context = { protocol, items: [{ role: 'user', content: 'task' }, message(null, [call, second])] };
  assert.deepEqual(contextPendingCalls(context), [call, second]);
  assert.throws(() => requireCompleteContext(context), { code: 'pending_tools' });
  context.items.push(...nativeToolResultItems(protocol, second, { status: 'denied', output: 'no' }));
  assert.deepEqual(contextPendingCalls(context), [call]);
  context.items.push(...nativeToolResultItems(protocol, call, { status: 'completed', output: 'text' }));
  requireCompleteContext(context);
  assert.deepEqual(nativeResponseCalls(protocol, [message(null, [call])]), [call]);
});

for (const [name, items, extra] of [
  ['missing call result', [message(null, [call]), { role: 'user', content: 'cannot skip call' }]],
  ['unmatched tool result', [{ role: 'tool', tool_call_id: 'missing', content: '{}' }]],
  ['duplicate call IDs', [message(null, [call, call])]],
  ['Responses item', [{ type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments }]],
  ['hidden vendor reasoning', [{ role: 'assistant', content: 'text', reasoning_content: 'opaque continuation' }]],
  ['continuation metadata', [message('text')], { continuation: 'unsupported' }],
  ['future version', [message('text')], { protocol: { ...protocol, version: 2 } }],
]) test(`chat context rejects ${name}`, () => {
  assert.throws(() => contextPendingCalls({ protocol, items, ...extra }), { code: 'unsupported_protocol' });
});

test('chat safe recovery durably closes unprepared calls using native tool messages and survives reopen', async t => {
  const f = await fixture(t), req = request(f.conversationId);
  await f.store.beginRun(req); await f.store.append(req.identity, response([call])); await f.reopen();
  const report = f.store.getRecoveryReport(); assert.equal(report.classification, 'safe_to_continue');
  const resolution = await f.store.resolveRecovery({ ...report, resourcesVerified: true });
  assert.equal(resolution.status, 'cancelled');
  const last = resolution.context.items.at(-1);
  assert.equal(last.role, 'tool'); assert.equal(last.tool_call_id, call.id); assert.equal(JSON.parse(last.content).status, 'not_executed');
  requireCompleteContext(resolution.context);
  await f.reopen(); assert.deepEqual(f.store.loadContext(), resolution.context);
  assert.deepEqual(await f.store.resolveRecovery({ ...report, resourcesVerified: true }), resolution);
  await f.store.beginRun(request(f.conversationId, 'New explicit task'));
});

test('chat prepared outcome remains unknown and cannot be synthesized by recovery', async t => {
  const f = await fixture(t), req = request(f.conversationId);
  await f.store.beginRun(req); await f.store.append(req.identity, response([call]));
  await f.store.append(req.identity, { type: 'tool_prepared', prepared: { call, definition: { name: call.name, description: 'fixture', inputSchema: { type: 'object' }, risk: 'read' }, input: { path: 'a.txt' }, inputDigest: 'digest', policyRevision: 'policy', requiresApproval: false, preconditions: {} } });
  await f.reopen(); const report = f.store.getRecoveryReport(); assert.equal(report.classification, 'unknown_effects');
  await assert.rejects(f.store.resolveRecovery({ ...report, resourcesVerified: true }), { code: 'unknown_effects' });
});

test('chat compaction keeps original user, newest native tool turn, and immutable full records', async t => {
  const f = await fixture(t), original = await turn(f, 'Original exact goal');
  const beforeRecent = f.store.loadContext().items.length;
  await turn(f, 'Recent task', [call]); const before = f.store.loadContext(), records = f.store.replay();
  const source = f.store.getCompactionSource(); assert.equal(source.context.protocol.id, protocol.id);
  const plan = f.store.planContextCompaction({ summary: 'Earlier task completed; current task denied.', expectedHash: source.expectedHash, usage: { inputTokens: 12, outputTokens: 4 } });
  assert.deepEqual(plan.context.items[0], original.userItems[0]);
  assert.equal(typeof plan.context.items[1].content, 'string'); assert.equal(plan.context.items[1].type, undefined);
  assert.deepEqual(plan.context.items.slice(2), before.items.slice(beforeRecent));
  requireCompleteContext(plan.context);
  await f.store.commitContextCompaction(plan); await f.reopen();
  assert.deepEqual(f.store.loadContext(), plan.context); assert.deepEqual(f.store.replay().slice(0, records.length), records);
  const next = request(f.conversationId, 'Continue');
  assert.deepEqual((await f.store.beginRun(next)).context.items, [...plan.context.items, ...next.userItems]);
});

test('chat conversation cannot switch to Responses protocol or vice versa', async t => {
  const f = await fixture(t); await turn(f, 'first');
  await assert.rejects(f.store.beginRun({ ...request(f.conversationId, 'switch'), protocol: { id: 'openai-responses', version: 1 } }), { code: 'protocol_mismatch' });
});

test('summary allowlist excludes hidden reasoning, refusals, and tool calls', () => {
  assert.equal(isNativeTextSummary(protocol, [message('summary')]), true);
  for (const item of [message(null, [call]), { ...message('no'), refusal: 'refused' }, { ...message('no'), refusal: false }, { ...message('no'), refusal: 0 }, { ...message('text'), reasoning_content: 'hidden' }, { role: 'user', content: 'spoofed' }]) {
    assert.equal(isNativeTextSummary(protocol, [item]), false);
  }
});
