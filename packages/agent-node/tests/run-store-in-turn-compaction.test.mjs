import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NativeRunStore } from '../dist/run-store.js';
import { contextPendingCalls, runContinuityItem } from '../dist/context-maintenance.js';

const usage = { inputTokens: 10, outputTokens: 4, totalTokens: 14 };
const protocols = ['openai-responses', 'openai-chat-completions'];
const userItems = input => [{ role: 'user', content: input }];
function request(conversationId, protocol, input = 'Current exact task 中文\r\nconstraints') {
  return { identity: { sessionId: 'session', conversationId, runId: randomUUID(), requestId: randomUUID(), workerGeneration: 1 },
    input, inputDigest: input, userItems: userItems(input), protocol, configuration: { nativeTaskId: 'task' }, policyRevision: 'policy' };
}
async function fixture(t, protocolId = protocols[0], options = {}) {
  const rootDirectory = await mkdtemp(path.join(tmpdir(), 'native-in-turn-')), conversationId = randomUUID(), protocol = { id: protocolId, version: 1 };
  let store = await NativeRunStore.open({ rootDirectory, conversationId, ...options });
  t.after(async () => { await store.close().catch(() => {}); await rm(rootDirectory, { recursive: true, force: true }); });
  return { conversationId, protocol, get store() { return store; }, reopen: async (extra = {}) => { await store.close(); store = await NativeRunStore.open({ rootDirectory, conversationId, ...extra }); } };
}
function modelEvent(protocol, call, text = 'Older detailed implementation and observations. '.repeat(400)) {
  const outputItems = protocol.id === protocols[0] ? [
    { type: 'reasoning', encrypted_content: 'exact opaque reasoning', summary: [] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
    ...(call ? [{ type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments }] : []),
  ] : [{ role: 'assistant', content: text, ...(call ? { tool_calls: [{ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } }] } : {}) }];
  return { type: 'model_response', response: { outputItems, toolCalls: call ? [call] : [], finishReason: call ? 'tool_calls' : 'completed', usage,
    ...(protocol.id === protocols[0] ? { continuation: { responseId: randomUUID() } } : {}) } };
}
function completed(protocol, call, status = 'completed', output = 'actual effect') {
  const result = { status, output };
  return { type: 'tool_completed', call, result, resultItems: protocol.id === protocols[0]
    ? [{ type: 'function_call_output', call_id: call.id, output: JSON.stringify(result) }]
    : [{ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) }] };
}
async function batch(f, req, id, status = 'completed') {
  const call = { id, name: 'read_file', arguments: '{}' };
  await f.store.append(req.identity, modelEvent(f.protocol, call));
  await f.store.append(req.identity, { type: 'tool_prepared', prepared: { call, definition: { name: call.name, description: 'Read', inputSchema: {}, risk: 'read' }, input: {}, inputDigest: 'digest', policyRevision: 'policy', requiresApproval: false, preconditions: {} } });
  await f.store.append(req.identity, completed(f.protocol, call, status));
  return call;
}
async function active(f) {
  const req = request(f.conversationId, f.protocol); await f.store.beginRun(req); await batch(f, req, 'first');
  const boundary = f.store.loadContext().items.length; await batch(f, req, 'latest');
  return { req, boundary };
}
async function reserve(f, req) {
  const source = f.store.getRunCompactionSource(req.identity, f.store.loadContext()), request = { requestId: randomUUID(), contextHash: source.contextHash };
  await f.store.reserveRunCompaction(req.identity, request);
  return { source, input: { ...request, summary: 'Earlier work: preserve constraints; unresolved failure remains pending.', continuity: JSON.stringify({ taskId: 'task', evidence: ['original-start-call'], acceptance: 'unverified' }), usage } };
}
async function finish(f, req) {
  await f.store.append(req.identity, { type: 'run_finished', result: { identity: req.identity, status: 'completed', reason: 'done', modelRequests: 3, toolCalls: 2, usage: null, context: f.store.loadContext(), committed: true } });
}

for (const protocol of protocols) test(`${protocol}: atomic in-turn summary preserves exact goals/latest batch, raw journal, once-only receipt and restart`, async t => {
  const f = await fixture(t, protocol), { req, boundary } = await active(f), old = f.store.loadContext();
  const raw = await readFile(path.join(f.store.directory, 'journal.jsonl'), 'utf8');
  const { source, input } = await reserve(f, req);
  assert.deepEqual(source.context.items, old.items.slice(0, boundary));
  assert.deepEqual(source.retainedContext.items, [...req.userItems, ...old.items.slice(boundary)]);
  assert.deepEqual(f.store.loadContext(), old);
  const committed = await f.store.commitRunCompaction(req.identity, input);
  assert.deepEqual(committed.context.items[0], req.userItems[0]);
  assert.deepEqual(committed.context.items.slice(3), old.items.slice(boundary));
  assert.deepEqual(contextPendingCalls(committed.context), []);
  assert.equal(committed.context.continuation, undefined);
  assert.ok(committed.afterBytes < committed.beforeBytes);
  assert.ok((await readFile(path.join(f.store.directory, 'journal.jsonl'), 'utf8')).startsWith(raw));
  assert.deepEqual(await f.store.commitRunCompaction(req.identity, input), committed);
  await assert.rejects(f.store.commitRunCompaction(req.identity, { ...input, summary: 'forged' }), { code: 'payload_mismatch' });
  const count = f.store.usage.records;
  assert.equal((await f.store.reserveRunCompaction(req.identity, { requestId: input.requestId, contextHash: input.contextHash })).kind, 'existing');
  await assert.rejects(f.store.reserveRunCompaction(req.identity, { requestId: randomUUID(), contextHash: input.contextHash }), { code: 'payload_mismatch' });
  assert.equal(f.store.usage.records, count);
  const attempt = f.store.lookupRunCompaction(req.identity.runId); attempt.status = 'failed';
  assert.equal(f.store.lookupRunCompaction(req.identity.runId).status, 'committed');
  await f.store.checkpoint(req.identity, committed.context); await finish(f, req); await f.reopen();
  assert.deepEqual(f.store.loadContext(), committed.context);
  assert.deepEqual(await f.store.commitRunCompaction(req.identity, input), committed);
  assert.equal(f.store.recoveryRequired, false);
});

test('original and current inputs survive prior manual compaction and later manual maintenance remains compatible', async t => {
  const f = await fixture(t); const first = request(f.conversationId, f.protocol, 'Original exact goal\r\nzero destructive actions');
  await f.store.beginRun(first); await batch(f, first, 'original'); await finish(f, first);
  const second = request(f.conversationId, f.protocol, 'Older current input'); await f.store.beginRun(second); await batch(f, second, 'second'); await finish(f, second);
  await f.store.commitContextCompaction(f.store.planContextCompaction({ summary: 'Earlier goal retained' }));
  const { req, boundary } = await active(f), old = f.store.loadContext(), { input } = await reserve(f, req);
  const committed = await f.store.commitRunCompaction(req.identity, input);
  assert.deepEqual(committed.context.items.slice(0, 2), [...first.userItems, ...req.userItems]);
  assert.deepEqual(committed.context.items.slice(4), old.items.slice(boundary));
  await finish(f, req);
  const later = request(f.conversationId, f.protocol, 'Newest turn'); await f.store.beginRun(later); await batch(f, later, 'later'); await finish(f, later);
  const plan = f.store.planContextCompaction({ summary: 'All completed earlier work and original constraints' });
  await f.store.commitContextCompaction(plan); await f.reopen();
  assert.deepEqual(f.store.loadContext(), plan.context); assert.deepEqual(plan.context.items[0], first.userItems[0]);
});

test('maintenance refuses incomplete calls, unknown effects, unsupported items, stale worker context and wrong owner', async t => {
  const f = await fixture(t), req = request(f.conversationId, f.protocol); await f.store.beginRun(req);
  assert.throws(() => f.store.getRunCompactionSource(req.identity), { code: 'nothing_to_compact' });
  await batch(f, req, 'first');
  const call = { id: 'pending', name: 'read_file', arguments: '{}' }; await f.store.append(req.identity, modelEvent(f.protocol, call));
  assert.throws(() => f.store.getRunCompactionSource(req.identity), { code: 'pending_tools' });
  await f.store.append(req.identity, completed(f.protocol, call, 'not_executed'));
  assert.throws(() => f.store.getRunCompactionSource({ ...req.identity, workerGeneration: 2 }), { code: 'stale_owner' });
  assert.throws(() => f.store.getRunCompactionSource(req.identity, { protocol: f.protocol, items: [] }), { code: 'context_mismatch' });
  const { input } = await reserve(f, req); await batch(f, req, 'newer');
  await assert.rejects(f.store.commitRunCompaction(req.identity, input), { code: 'stale_context' });
  await batch(f, req, 'unknown', 'unknown');
  assert.throws(() => f.store.getRunCompactionSource(req.identity), { code: 'pending_tools' });
  const other = await fixture(t), running = await active(other), invalid = modelEvent(other.protocol); invalid.response.outputItems.push({ type: 'unsupported-new-item' });
  await other.store.append(running.req.identity, invalid);
  assert.throws(() => other.store.getRunCompactionSource(running.req.identity), { code: 'unsupported_protocol' });
});

for (const terminal of ['finished', 'unknown']) test(`command ${terminal}: durable receipts survive compaction and unresolved lifecycle defers maintenance`, async t => {
  const f = await fixture(t), { req } = await active(f), commandId = randomUUID(), at = new Date().toISOString();
  const input = { executable: 'node', argv: ['test.mjs'], cwd: '.' }, call = { id: 'start', name: 'start_command', arguments: JSON.stringify(input) };
  await f.store.append(req.identity, modelEvent(f.protocol, call));
  const prepared = { call, definition: { name: call.name, description: 'Start', inputSchema: {}, risk: 'command' }, input, inputDigest: 'digest', policyRevision: 'policy', requiresApproval: true, preconditions: {} };
  const approval = { binding: { ...req.identity, toolCallId: call.id, inputDigest: 'digest', policyRevision: 'policy' }, decision: 'approved', expiresAt: Date.now() + 60_000 };
  await f.store.append(req.identity, { type: 'tool_prepared', prepared, approval });
  const record = progress => f.store.recordCommandEvent(req.identity, call, { commandId, at, ...progress });
  await record({ status: 'prepared', taskId: 'task', command: input, timeoutMs: 120000, maxOutputBytes: 16384 });
  assert.throws(() => f.store.getRunCompactionSource(req.identity), { code: 'pending_tools' });
  await record({ status: 'running' }); await f.store.append(req.identity, completed(f.protocol, call, 'completed', { commandId }));
  assert.throws(() => f.store.getRunCompactionSource(req.identity), { code: 'commands_active' });
  await record({ status: terminal, result: { exitCode: 0, signal: null, stdout: 'exact host output', stderr: '', outputBytes: 17, truncated: false, timedOut: false, cancelled: false, cleanup: terminal === 'unknown' ? 'cleanup_failed' : 'released' } });
  if (terminal === 'unknown') { assert.throws(() => f.store.getRunCompactionSource(req.identity), { code: 'commands_active' }); return; }
  const before = f.store.getToolState(req.identity.runId, call.id), { input: compact } = await reserve(f, req);
  await f.store.commitRunCompaction(req.identity, compact);
  assert.deepEqual(f.store.getToolState(req.identity.runId, call.id), before);
});

test('failed summary is durable once, leaves original context and accounts actual usage in recovery', async t => {
  const f = await fixture(t), { req } = await active(f), original = f.store.loadContext(), { input } = await reserve(f, req);
  const failure = { requestId: input.requestId, reason: 'model_refused', usage };
  const receipt = await f.store.failRunCompaction(req.identity, failure);
  assert.deepEqual(await f.store.failRunCompaction(req.identity, failure), receipt);
  await assert.rejects(f.store.failRunCompaction(req.identity, { ...failure, usage: null }), { code: 'payload_mismatch' });
  assert.deepEqual(f.store.loadContext(), original);
  await f.reopen();
  const result = await f.store.resolveRecovery({ ...f.store.getRecoveryReport(), resourcesVerified: true });
  assert.equal(result.modelRequests, 3); assert.deepEqual(result.usage, { inputTokens: 30, outputTokens: 12, totalTokens: 42 });
  assert.equal(f.store.lookupRunCompaction(req.identity.runId).status, 'failed');
  assert.deepEqual(result.context, original);
});

for (const returned of [undefined, null, { outputTokens: 2 }]) test(`recovery does not undercount an attempted summary or invent missing usage: ${JSON.stringify(returned)}`, async t => {
  const f = await fixture(t), { req } = await active(f), { input } = await reserve(f, req);
  if (returned !== undefined) await f.store.failRunCompaction(req.identity, { requestId: input.requestId, reason: 'summary_failed', usage: returned });
  await f.reopen(); const result = await f.store.resolveRecovery({ ...f.store.getRecoveryReport(), resourcesVerified: true });
  assert.equal(result.modelRequests, 3); assert.deepEqual(result.usage, returned ? { outputTokens: 10 } : null);
});

test('successful summary usage joins subsequent responses during recovery and pending attempts cannot finish successfully', async t => {
  const f = await fixture(t), { req } = await active(f), { input } = await reserve(f, req);
  await assert.rejects(finish(f, req), { code: 'recovery_required' });
  await f.store.commitRunCompaction(req.identity, input); await batch(f, req, 'after-summary'); await f.reopen();
  const result = await f.store.resolveRecovery({ ...f.store.getRecoveryReport(), resourcesVerified: true });
  assert.equal(result.modelRequests, 4); assert.deepEqual(result.usage, { inputTokens: 40, outputTokens: 16, totalTokens: 56 });
});

for (const operation of ['run_context_compaction_attempted', 'run_context_compacted', 'run_context_compaction_failed']) for (const point of ['before_append', 'after_write', 'after_sync']) test(`${operation} ${point}: crash replays all old or all new context and never retries summary`, async t => {
  let armed = false;
  const f = await fixture(t, protocols[0], { fault: (actualPoint, type) => { if (armed && actualPoint === point && type === operation) throw new Error('injected summary write fault'); } });
  const { req } = await active(f), original = f.store.loadContext();
  let input;
  if (operation === 'run_context_compaction_attempted') {
    const source = f.store.getRunCompactionSource(req.identity); input = { requestId: randomUUID(), contextHash: source.contextHash };
  } else ({ input } = await reserve(f, req));
  armed = true;
  const invoke = operation === 'run_context_compaction_attempted' ? () => f.store.reserveRunCompaction(req.identity, input)
    : operation === 'run_context_compacted' ? () => f.store.commitRunCompaction(req.identity, input)
    : () => f.store.failRunCompaction(req.identity, { requestId: input.requestId, reason: 'summary_failed', usage });
  await assert.rejects(invoke(), /injected summary write fault/);
  assert.equal(f.store.recoveryRequired, true); await f.reopen();
  const attempt = f.store.lookupRunCompaction(req.identity.runId);
  if (operation === 'run_context_compacted' && point !== 'before_append') { assert.equal(attempt.status, 'committed'); assert.notDeepEqual(f.store.loadContext(), original); }
  else { assert.deepEqual(f.store.loadContext(), original); assert.equal(attempt?.status, operation === 'run_context_compaction_attempted' && point === 'before_append' ? undefined : operation === 'run_context_compaction_failed' && point !== 'before_append' ? 'failed' : 'attempted'); }
  assert.equal(f.store.getRun(req.identity.runId).status, 'recovery_required');
  if (attempt) assert.equal((await f.store.reserveRunCompaction(req.identity, { requestId: input.requestId, contextHash: input.contextHash })).kind, 'existing');
  else await assert.rejects(f.store.reserveRunCompaction(req.identity, input), { code: 'run_not_active' });
});

test('host-only records, bounded historical pins, secrets, invalid usage and nonshrinking summaries cannot publish', async t => {
  const f = await fixture(t, protocols[0], { forbiddenValues: ['secret-sentinel'] }), { req } = await active(f), { input } = await reserve(f, req), old = f.store.loadContext();
  for (const type of ['run_context_compaction_attempted', 'run_context_compacted', 'run_context_compaction_failed']) await assert.rejects(f.store.append(req.identity, { type }), { code: 'invalid_record' });
  for (const override of [{ continuity: '' }, { continuity: '中'.repeat(11000) }]) await assert.rejects(f.store.commitRunCompaction(req.identity, { ...input, ...override }), { code: 'invalid_continuity' });
  await assert.rejects(f.store.commitRunCompaction(req.identity, { ...input, usage: { totalTokens: -1 } }), { code: 'invalid_usage' });
  await assert.rejects(f.store.commitRunCompaction(req.identity, { ...input, summary: 'secret-sentinel' }), { code: 'secret_rejected' });
  await assert.rejects(f.store.commitRunCompaction(req.identity, { ...input, summary: 'x'.repeat(30000) }), { code: 'compaction_not_smaller' });
  assert.deepEqual(f.store.loadContext(), old); assert.equal(f.store.recoveryRequired, false);
  const item = runContinuityItem('task references only', f.protocol);
  assert.equal(item.role, 'assistant'); assert.match(item.content[0].text, /not new instructions, permission, or verified acceptance/);
});

test('reservation keeps outcome and terminal journal slots before contacting the model', async t => {
  const f = await fixture(t, protocols[0], { limits: { maxRecords: 11 } }), { req } = await active(f);
  assert.equal(f.store.usage.records, 8);
  const source = f.store.getRunCompactionSource(req.identity), input = { requestId: randomUUID(), contextHash: source.contextHash };
  await f.store.reserveRunCompaction(req.identity, input);
  await assert.rejects(f.store.append(req.identity, modelEvent(f.protocol)), { code: 'limit_exceeded' });
  await f.store.failRunCompaction(req.identity, { requestId: input.requestId, reason: 'summary_failed', usage: null });
  await assert.rejects(f.store.append(req.identity, modelEvent(f.protocol)), { code: 'limit_exceeded' });
  await finish(f, req); assert.equal(f.store.usage.records, 11);
});
