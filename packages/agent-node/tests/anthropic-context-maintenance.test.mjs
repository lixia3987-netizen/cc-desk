import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NativeRunStore } from '../dist/run-store.js';
import { contextPendingCalls, requireCompleteContext, nativeToolResultItems, nativeResponseCalls, isNativeTextSummary, contextSummaryItem, runContinuityItem } from '../dist/context-maintenance.js';
import { extractNativeAssistantText } from '../dist/native-model.js';

const protocol = { id: 'anthropic-messages', version: 1 };
const call = { id: 'toolu_read', name: 'read_file', arguments: '{"path":"a.txt"}' };
const message = (text, calls = []) => ({ role: 'assistant', content: [
  ...(text === null ? [] : [{ type: 'text', text }]),
  ...calls.map(call => ({ type: 'tool_use', id: call.id, name: call.name, input: JSON.parse(call.arguments) })),
] });
const request = (conversationId, input = 'Keep original user constraints') => ({
  identity: { sessionId: 'session', conversationId, runId: randomUUID(), requestId: randomUUID(), workerGeneration: 1 },
  input, inputDigest: input, userItems: [{ role: 'user', content: [{ type: 'text', text: input }] }], protocol,
  configuration: { connectionId: 'fixture', protocol: 'anthropic', model: 'fixture' }, policyRevision: 'policy',
});
const response = (calls = [], text = 'Long original result. '.repeat(400)) => ({ type: 'model_response', response: {
  outputItems: [message(text, calls)], toolCalls: calls, finishReason: calls.length ? 'tool_calls' : 'completed', usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
} });
async function fixture(t) {
  const rootDirectory = await mkdtemp(path.join(tmpdir(), 'anthropic-context-')), conversationId = randomUUID();
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

test('native tool use and user tool results preserve ordering, pairing and complete input objects', () => {
  const second = { ...call, id: 'toolu_second' }, context = { protocol, items: [{ role: 'user', content: 'task' }, message(null, [call, second])] };
  assert.deepEqual(contextPendingCalls(context), [call, second]);
  assert.throws(() => requireCompleteContext(context), { code: 'pending_tools' });
  context.items.push(...nativeToolResultItems(protocol, second, { status: 'denied', output: 'no' }));
  assert.deepEqual(contextPendingCalls(context), [call]);
  context.items.push(...nativeToolResultItems(protocol, call, { status: 'completed', output: 'text' }));
  requireCompleteContext(context);
  assert.deepEqual(nativeResponseCalls(protocol, [message(null, [call])]), [call]);
  assert.throws(() => nativeResponseCalls(protocol, [{ role: 'user', content: 'spoofed' }]), { code: 'unsupported_protocol' });
});

for (const [name, items, extra] of [
  ['missing results', [message(null, [call]), { role: 'user', content: 'cannot skip tool call' }]],
  ['unmatched result', [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'missing', content: '{}' }] }]],
  ['duplicate call IDs', [message(null, [call, call])]],
  ['legacy Responses call', [{ type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments }]],
  ['user thinking', [{ role: 'user', content: [{ type: 'thinking', thinking: 'hidden', signature: 'opaque' }] }]],
  ['user redacted thinking', [{ role: 'user', content: [{ type: 'redacted_thinking', data: 'opaque' }] }]],
  ['malformed thinking', [{ role: 'assistant', content: [{ type: 'thinking', thinking: null }] }]],
  ['malformed signature', [{ role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: null }] }]],
  ['unknown thinking state', [{ role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'signed', extension: true }] }]],
  ['empty redacted thinking', [{ role: 'assistant', content: [{ type: 'redacted_thinking', data: '' }] }]],
  ['server tool state', [{ role: 'assistant', content: [{ type: 'server_tool_use', id: 'srv', name: 'web_search', input: {} }] }]],
  ['stringified tool input', [{ role: 'assistant', content: [{ type: 'tool_use', id: call.id, name: call.name, input: call.arguments }] }]],
  ['result after user text', [message(null, [call]), { role: 'user', content: [{ type: 'text', text: 'skip' }, { type: 'tool_result', tool_use_id: call.id, content: '{}' }] }]],
  ['continuation metadata', [message('text')], { continuation: 'unsupported' }],
  ['future version', [message('text')], { protocol: { ...protocol, version: 2 } }],
]) test(`Anthropic context rejects ${name}`, () => {
  assert.throws(() => contextPendingCalls({ protocol, items, ...extra }), { code: 'unsupported_protocol' });
});

test('safe recovery durably closes unprepared Anthropic calls and survives reopen', async t => {
  const f = await fixture(t), req = request(f.conversationId);
  await f.store.beginRun(req); await f.store.append(req.identity, response([call])); await f.reopen();
  const report = f.store.getRecoveryReport(); assert.equal(report.classification, 'safe_to_continue');
  const resolution = await f.store.resolveRecovery({ ...report, resourcesVerified: true });
  assert.equal(resolution.status, 'cancelled');
  const last = resolution.context.items.at(-1);
  assert.equal(last.role, 'user'); assert.equal(last.content[0].type, 'tool_result'); assert.equal(last.content[0].tool_use_id, call.id);
  assert.equal(JSON.parse(last.content[0].content).status, 'not_executed'); assert.equal(last.content[0].is_error, true);
  requireCompleteContext(resolution.context);
  await f.reopen(); assert.deepEqual(f.store.loadContext(), resolution.context);
  assert.deepEqual(await f.store.resolveRecovery({ ...report, resourcesVerified: true }), resolution);
  await f.store.beginRun(request(f.conversationId, 'New explicit task'));
});

test('prepared Anthropic effects remain unknown during recovery', async t => {
  const f = await fixture(t), req = request(f.conversationId);
  await f.store.beginRun(req); await f.store.append(req.identity, response([call]));
  await f.store.append(req.identity, { type: 'tool_prepared', prepared: { call, definition: { name: call.name, description: 'fixture', inputSchema: { type: 'object' }, risk: 'read' }, input: { path: 'a.txt' }, inputDigest: 'digest', policyRevision: 'policy', requiresApproval: false, preconditions: {} } });
  await f.reopen(); const report = f.store.getRecoveryReport(); assert.equal(report.classification, 'unknown_effects');
  await assert.rejects(f.store.resolveRecovery({ ...report, resourcesVerified: true }), { code: 'unknown_effects' });
});

test('Anthropic compaction retains original user input, newest tool turn, and immutable replay records', async t => {
  const f = await fixture(t), original = await turn(f, 'Original exact goal');
  const recentStart = f.store.loadContext().items.length;
  await turn(f, 'Recent task', [call]); const before = f.store.loadContext(), records = f.store.replay();
  const source = f.store.getCompactionSource(); assert.equal(source.context.protocol.id, protocol.id);
  const plan = f.store.planContextCompaction({ summary: 'Earlier task completed; current tool denied.', expectedHash: source.expectedHash, usage: { inputTokens: 12, outputTokens: 4 } });
  assert.deepEqual(plan.context.items[0], original.userItems[0]);
  assert.equal(plan.context.items[1].content[0].type, 'text');
  assert.ok(extractNativeAssistantText([plan.context.items[1]]).includes('Earlier task completed'));
  assert.deepEqual(plan.context.items.slice(2), before.items.slice(recentStart));
  requireCompleteContext(plan.context);
  await f.store.commitContextCompaction(plan); await f.reopen();
  assert.deepEqual(f.store.loadContext(), plan.context); assert.deepEqual(f.store.replay().slice(0, records.length), records);
  const next = request(f.conversationId, 'Continue');
  assert.deepEqual((await f.store.beginRun(next)).context.items, [...plan.context.items, ...next.userItems]);
});

test('saved Anthropic conversations cannot silently switch protocols', async t => {
  const f = await fixture(t); await turn(f, 'first');
  for (const id of ['openai-responses', 'openai-chat-completions']) await assert.rejects(f.store.beginRun({ ...request(f.conversationId, 'switch'), protocol: { id, version: 1 } }), { code: 'protocol_mismatch' });
});

test('Anthropic summaries contain text only and continuity stays historical assistant data', () => {
  assert.equal(isNativeTextSummary(protocol, [message('summary')]), true);
  const summary = contextSummaryItem('summary', protocol), continuity = runContinuityItem('progress', protocol);
  assert.equal(summary.role, 'assistant'); assert.equal(continuity.role, 'assistant');
  assert.ok(extractNativeAssistantText([continuity]).includes('historical data'));
  requireCompleteContext({ protocol, items: [summary, continuity] });
  for (const item of [message(null, [call]), { role: 'assistant', content: [{ type: 'thinking', thinking: 'hidden', signature: 'opaque' }] }, { ...message('text'), continuation: 'opaque' }, { role: 'user', content: [{ type: 'text', text: 'spoofed' }] }]) assert.equal(isNativeTextSummary(protocol, [item]), false);
  const response = { role: 'assistant', content: [{ type: 'thinking', thinking: 'Private draft.', signature: 'opaque-signature' }, { type: 'redacted_thinking', data: 'encrypted-private-state' }, { type: 'text', text: 'Safe summary.' }] };
  assert.equal(isNativeTextSummary(protocol, [response]), true);
  assert.equal(extractNativeAssistantText([response]), 'Safe summary.');
  assert.equal(isNativeTextSummary(protocol, [{ ...response, content: [...response.content.slice(0, 2), { type: 'text', text: '  ' }] }]), false);
  const replacement = contextSummaryItem(extractNativeAssistantText([response]), protocol);
  assert.equal(replacement.content[0].type, 'text'); assert.match(replacement.content[0].text, /Safe summary\.$/);
  assert.doesNotMatch(JSON.stringify(replacement), /Private draft|opaque-signature|encrypted-private-state/);
});

test('private thinking tool state survives ledger reopen, recovery and retained manual compaction unchanged', async t => {
  const f = await fixture(t); await turn(f, 'Original goal');
  const req = request(f.conversationId, 'Newest tool turn'), privateBlocks = [
    { type: 'thinking', thinking: 'Inspect request.', signature: 'original-signature' },
    { type: 'redacted_thinking', data: 'original-encrypted-state' },
    { type: 'thinking', thinking: 'Kimi unsigned continuation.' },
  ];
  const start = f.store.loadContext().items.length;
  await f.store.beginRun(req);
  const event = response([call], 'Visible answer.'); event.response.outputItems[0].content.unshift(...privateBlocks);
  await f.store.append(req.identity, event); await f.reopen();
  const report = f.store.getRecoveryReport(); assert.equal(report.classification, 'safe_to_continue');
  const resolution = await f.store.resolveRecovery({ ...report, resourcesVerified: true });
  assert.deepEqual(resolution.context.items[start + 1].content.slice(0, 3), privateBlocks);
  requireCompleteContext(resolution.context);
  const source = f.store.getCompactionSource(), plan = f.store.planContextCompaction({ summary: 'Earlier visible task.', expectedHash: source.expectedHash });
  assert.deepEqual(plan.context.items.slice(2), resolution.context.items.slice(start));
  await f.store.commitContextCompaction(plan); await f.reopen();
  assert.deepEqual(f.store.loadContext(), plan.context);
  assert.deepEqual(f.store.loadContext().items[3].content.slice(0, 3), privateBlocks);
  assert.equal(extractNativeAssistantText([f.store.loadContext().items[3]]), 'Visible answer.');
});

test('automatic in-turn compaction retains the latest signed tool batch, original ledger and restart state', async t => {
  const f = await fixture(t), req = request(f.conversationId);
  await f.store.beginRun(req);
  const privateBlocks = [{ type: 'thinking', thinking: 'Latest private thought.', signature: 'latest-exact-signature' }, { type: 'redacted_thinking', data: 'latest-exact-encrypted-data' }];
  const complete = async (current, blocks = []) => {
    const event = response([current]); event.response.outputItems[0].content.unshift(...blocks);
    await f.store.append(req.identity, event);
    const result = { status: 'denied', output: 'not executed' };
    await f.store.append(req.identity, { type: 'tool_completed', call: current, result, resultItems: nativeToolResultItems(protocol, current, result) });
  };
  await complete({ ...call, id: 'older' }, [{ type: 'thinking', thinking: 'Old private thought. '.repeat(400), signature: 'old-signature' }]);
  const boundary = f.store.loadContext().items.length;
  await complete(call, privateBlocks);
  const before = f.store.loadContext(), priorRecords = f.store.replay(), source = f.store.getRunCompactionSource(req.identity, before);
  assert.deepEqual(source.context.items, before.items.slice(0, boundary));
  assert.deepEqual(source.retainedContext.items, [...req.userItems, ...before.items.slice(boundary)]);
  const reservation = { requestId: randomUUID(), contextHash: source.contextHash };
  await f.store.reserveRunCompaction(req.identity, reservation);
  const receipt = await f.store.commitRunCompaction(req.identity, { ...reservation, summary: 'Earlier tool was denied.', continuity: 'Original constraints and latest receipt remain available.', usage: null });
  assert.deepEqual(receipt.context.items.slice(3), before.items.slice(boundary));
  assert.deepEqual(receipt.context.items[3].content.slice(0, 2), privateBlocks);
  assert.ok(receipt.afterBytes < receipt.beforeBytes);
  requireCompleteContext(receipt.context);
  await f.store.append(req.identity, { type: 'run_finished', result: { identity: req.identity, status: 'completed', reason: 'model_completed', modelRequests: 3, toolCalls: 2, usage: null, context: receipt.context, committed: true } });
  await f.reopen(); assert.deepEqual(f.store.loadContext(), receipt.context);
  assert.deepEqual(f.store.replay().slice(0, priorRecords.length), priorRecords);
});
