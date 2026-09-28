import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { NativeRunStore } from '@cc-desk/agent-node/run-store';
import type { BeginRunRequest, RunResult, ToolCall, PreparedTool, ApprovalDecision } from '@cc-desk/agent-core';
import { estimateResponsesInputTokens } from '@cc-desk/agent-node/responses-model';
import { NativeProjection, MISSING_NATIVE_CONTEXT_MESSAGE } from '../src/main/engines/native/projection';
import { ExecutionEvents } from '../src/main/execution/events';
import type { Session } from '../src/shared/types';

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-projection-'));
  const id = randomUUID(), conversationId = randomUUID();
  let store = await NativeRunStore.open({ rootDirectory: path.join(directory, 'native'), conversationId });
  const session: Session = { id, projectId: 'project', title: 'Native', kind: 'agent', cwd: directory, execution: { providerId: 'native', mode: 'structured', conversationId }, started: true, engineConfig: { schemaVersion: 1, options: {} }, status: 'running', archived: false, createdAt: '2026-09-25T00:00:00.000Z', updatedAt: '2026-09-25T00:00:00.000Z' };
  let active = true;
  const events = new ExecutionEvents();
  const errors: Error[] = [];
  const create = () => new NativeProjection(directory, events, () => session, () => active, (_id, error) => errors.push(error));
  const projection = create();
  const req: BeginRunRequest = { identity: { sessionId: id, conversationId, runId: randomUUID(), requestId: randomUUID(), workerGeneration: 1 }, input: 'Please fix searchneedle', inputDigest: 'digest', userItems: [{ role: 'user', content: 'Please fix searchneedle' }], protocol: { id: 'openai-responses', version: 1 }, configuration: { model: 'fixture-model' }, policyRevision: 'alpha-1' };
  return { directory, id, conversationId, session, errors, projection, create, req, get store() { return store; }, setActive(value: boolean) { active = value; }, reopen: async () => { await store.close(); store = await NativeRunStore.open({ rootDirectory: path.join(directory, 'native'), conversationId }); }, finish: async (status: RunResult['status'] = 'completed') => {
    const result: RunResult = { identity: req.identity, status, reason: status, modelRequests: 1, toolCalls: 0, usage: { inputTokens: 10, outputTokens: 5 }, context: store.loadContext()!, committed: true };
    await store.append(req.identity, { type: 'run_finished', result });
  }, dispose: async () => { projection.flush(); await store.close(); await fs.rm(directory, { recursive: true, force: true }); } };
}
const assistant = (text: string) => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });

test('durable response replaces stream preview, preserves provider-only data outside UI, and survives restart', async () => {
  const f = await fixture();
  try {
    await f.store.beginRun(f.req); await f.projection.hydrate(f.id, f.store);
    f.projection.event(f.id, { type: 'text_delta', identity: f.req.identity, text: 'Partial answer' });
    assert.equal(f.projection.snapshot(f.id).messages.at(-1)?.text, 'Partial answer');
    const opaque = 'encrypted-provider-reasoning-never-export';
    await f.store.append(f.req.identity, { type: 'model_response', response: { outputItems: [{ type: 'reasoning', encrypted_content: opaque, role: 'assistant', content: opaque }, { type: 'future_opaque', role: 'assistant', content: opaque }, assistant('Complete answer')], toolCalls: [], continuation: { opaque }, finishReason: 'completed', usage: null } });
    await f.projection.hydrate(f.id, f.store);
    const messages = f.projection.snapshot(f.id).messages;
    assert.deepEqual(messages.map(message => message.text), [f.req.input, 'Complete answer']);
    assert.equal(messages[0].id, `${f.req.identity.runId}:user`);
    assert.match(messages[1].id, /:response:\d+:2$/);
    await f.finish(); await f.projection.hydrate(f.id, f.store); f.setActive(false);
    f.projection.event(f.id, { type: 'text_delta', identity: f.req.identity, text: 'late after terminal' });
    const snapshot = f.projection.snapshot(f.id);
    assert.equal(snapshot.messages.some(message => message.text.includes('late after terminal')), false);
    assert.equal(snapshot.taskState, 'completed'); assert.equal(snapshot.model, 'fixture-model'); assert.equal(snapshot.usage?.inputTokens, 10);
    const file = f.projection.exportPath(f.id); const before = await fs.readFile(file, 'utf8');
    assert.equal(before.includes(opaque), false); assert.equal(before.includes('Partial answer'), false);
    await f.reopen(); const restored = f.create(); await restored.hydrate(f.id, f.store);
    assert.deepEqual(restored.snapshot(f.id).messages, snapshot.messages);
    assert.equal(await fs.readFile(file, 'utf8'), before, 'restart rebuild does not append duplicate journal records');
    assert.equal((await restored.search(f.id, 'searchneedle')).hits.length, 1); restored.flush();
  } finally { await f.dispose(); }
});

test('projection repair after missing UI acknowledgement is idempotent beyond bounded 400-message snapshot', async () => {
  const f = await fixture();
  try {
    await f.store.beginRun(f.req);
    await f.store.append(f.req.identity, { type: 'model_response', response: { outputItems: Array.from({ length: 525 }, (_, index) => assistant(`reply-${index}`)), toolCalls: [], finishReason: 'completed', usage: null } });
    await f.finish(); f.setActive(false);
    await f.projection.hydrate(f.id, f.store);
    assert.equal(f.projection.snapshot(f.id).messages.length, 400);
    const file = f.projection.exportPath(f.id); const first = await fs.readFile(file, 'utf8');
    await f.projection.hydrate(f.id, f.store); assert.equal(await fs.readFile(file, 'utf8'), first);
    f.projection.forget(f.id); await f.projection.hydrate(f.id, f.store); assert.equal(await fs.readFile(file, 'utf8'), first);
    const hit = (await f.projection.search(f.id, 'reply-0')).hits[0];
    const page = await f.projection.page(f.id, { around: hit.id });
    assert(page.messages.some(message => message.text === 'reply-0')); assert.equal(page.incomplete, false);
    assert.equal(first.split('\n').filter(line => line && JSON.parse(line).type === 'message').length, 526);
  } finally { await f.dispose(); }
});

test('tool projection replaces prepared state with result, pending approvals remain transient', async () => {
  const f = await fixture();
  try {
    const call: ToolCall = { id: 'tool-one', name: 'apply_patch', arguments: '{"path":"a.txt"}' };
    const prepared: PreparedTool = { call, definition: { name: 'apply_patch', description: 'Write', risk: 'write', inputSchema: {} }, input: { path: 'a.txt' }, inputDigest: 'tool-hash', policyRevision: 'alpha-1', requiresApproval: true, preconditions: { hash: 'before' } };
    const approval: ApprovalDecision = { decision: 'approved', expiresAt: Date.now() + 1000, binding: { ...f.req.identity, toolCallId: call.id, inputDigest: prepared.inputDigest, policyRevision: 'alpha-1' } };
    await f.store.beginRun(f.req);
    await f.store.append(f.req.identity, { type: 'model_response', response: { outputItems: [{ type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments }], toolCalls: [call], finishReason: 'tool_calls', usage: null } });
    await f.projection.hydrate(f.id, f.store);
    f.projection.approval(f.id, { requestId: 'permission', toolName: call.name, input: prepared.input, kind: 'permission', createdAt: new Date().toISOString() });
    assert.equal(f.projection.snapshot(f.id).taskState, 'waiting_approval');
    f.projection.approval(f.id, undefined);
    await f.store.append(f.req.identity, { type: 'tool_prepared', prepared, approval }); await f.projection.hydrate(f.id, f.store);
    assert.equal(f.projection.snapshot(f.id).taskState, 'tool_running');
    await f.store.append(f.req.identity, { type: 'tool_completed', call, result: { status: 'completed', output: 'file changed' }, resultItems: [{ type: 'function_call_output', call_id: call.id, output: 'file changed' }] });
    await f.projection.hydrate(f.id, f.store);
    const tools = f.projection.snapshot(f.id).messages.filter(message => message.role === 'tool');
    assert.equal(tools.length, 1); assert.equal(tools[0].text, 'file changed'); assert.deepEqual(tools[0].input, { path: 'a.txt' });
    assert.equal((await f.projection.page(f.id)).messages.filter(message => message.role === 'tool').length, 1);
    await f.finish(); await f.projection.hydrate(f.id, f.store);
    assert.deepEqual(f.projection.snapshot(f.id).pending, []);
    assert.equal((await fs.readFile(f.projection.exportPath(f.id), 'utf8')).includes('permission'), false);
  } finally { await f.dispose(); }
});

test('unknown prepared effects display recovery state and never restore stale approval/stream', async () => {
  const f = await fixture();
  try {
    const call: ToolCall = { id: 'read-one', name: 'read_file', arguments: '{}' };
    await f.store.beginRun(f.req);
    await f.store.append(f.req.identity, { type: 'model_response', response: { outputItems: [], toolCalls: [call], finishReason: 'tool_calls', usage: null } });
    await f.store.append(f.req.identity, { type: 'tool_prepared', prepared: { call, definition: { name: call.name, description: '', inputSchema: {}, risk: 'read' }, input: {}, inputDigest: 'digest', policyRevision: 'alpha-1', requiresApproval: false, preconditions: {} } });
    await f.projection.hydrate(f.id, f.store);
    f.projection.event(f.id, { type: 'text_delta', identity: { ...f.req.identity, workerGeneration: 999 }, text: 'late stale frame' });
    assert.equal(f.projection.snapshot(f.id).messages.some(message => message.text.includes('late stale')), false);
    await f.reopen(); f.setActive(false);
    await f.projection.hydrate(f.id, f.store);
    const snapshot = f.projection.snapshot(f.id);
    assert.equal(snapshot.taskState, 'error'); assert.match(snapshot.error!, /Previous host/);
    assert.match(snapshot.messages.find(message => message.role === 'tool')!.text, /结果未知/);
  } finally { await f.dispose(); }
});

test('projection disk failure is reported and retry repairs it from committed ledger', async () => {
  const f = await fixture();
  try {
    await f.store.beginRun(f.req);
    const blockedPath = f.projection.exportPath(f.id); await fs.mkdir(blockedPath);
    await assert.rejects(f.projection.hydrate(f.id, f.store)); assert.equal(f.errors.length, 1);
    await fs.rm(blockedPath, { recursive: true }); await f.projection.hydrate(f.id, f.store);
    assert.equal(f.projection.snapshot(f.id).messages[0].text, f.req.input);
    assert.equal(f.store.listRuns().length, 1, 'projection retries do not create or replay an execution');
  } finally { await f.dispose(); }
});


for (const source of ['snapshot', 'journal', 'nonmessage-journal'] as const) test(`empty native ledger preserves existing ${source} evidence and keeps history read-only`, async () => {
  const f = await fixture();
  try {
    const message = { id: 'prior-native-message', turnId: 'prior-turn', role: 'assistant', text: '仍可阅读的历史 searchneedle', createdAt: f.session.createdAt };
    const file = path.join(f.directory, 'chat', f.id + (source === 'snapshot' ? '.json' : '.jsonl'));
    const original = source === 'snapshot'
      ? JSON.stringify({ sessionId: f.id, taskState: 'idle', messages: [message], pending: [] })
      : JSON.stringify(source === 'journal' ? { type: 'message', message } : { type: 'state', taskState: 'completed' }) + '\n';
    await fs.writeFile(file, original);
    await f.projection.hydrate(f.id, f.store);
    assert.equal(f.projection.hasMissingContext(f.id), true);
    assert.equal(f.projection.snapshot(f.id).sourceIncomplete, true);
    assert.equal(f.projection.snapshot(f.id).error, MISSING_NATIVE_CONTEXT_MESSAGE);
    assert.equal(f.projection.snapshot(f.id).taskState, 'error');
    assert.equal(await fs.readFile(file, 'utf8'), original, 'never delete or overwrite display-only recovery evidence');
    if (source !== 'nonmessage-journal') {
      assert.equal(f.projection.snapshot(f.id).messages[0].text, message.text);
      assert.equal((await f.projection.page(f.id)).messages[0].text, message.text);
      assert.equal((await f.projection.search(f.id, 'searchneedle')).hits[0].id, message.id);
    }
    assert.equal(f.store.loadContext(), null, 'display history is never promoted to model context');
    assert.equal(f.store.usage.records, 1);
    await f.projection.hydrate(f.id, f.store);
    f.projection.flush();
    assert.equal(await fs.readFile(file, 'utf8'), original);
    const restarted = f.create(); await restarted.hydrate(f.id, f.store);
    assert.equal(restarted.hasMissingContext(f.id), true);
    assert.equal(await fs.readFile(file, 'utf8'), original); restarted.flush();
  } finally { await f.dispose(); }
});

test('an empty native conversation without display evidence remains a valid new conversation', async () => {
  const f = await fixture();
  try {
    await f.projection.hydrate(f.id, f.store);
    assert.equal(f.projection.hasMissingContext(f.id), false);
    assert.deepEqual(f.projection.snapshot(f.id).messages, []);
    assert.equal(f.projection.snapshot(f.id).error, undefined);
    await f.store.beginRun(f.req); await f.projection.hydrate(f.id, f.store);
    assert.equal(f.projection.snapshot(f.id).messages[0].text, f.req.input);
  } finally { await f.dispose(); }
});

test('native context projection uses durable history, latest reported input, and per-run budget across restart', async () => {
  const f = await fixture();
  try {
    const definitions = [{ name: 'mcp_fixture_read', description: '工具🙂'.repeat(100), inputSchema: { type: 'object', properties: { path: { type: 'string' } } }, risk: 'command' as const }];
    f.req.configuration = { model: 'fixture-model', modelInstructions: '规则🙂', toolDefinitions: definitions, sessionOptions: { maxInputTokens: 2048 } };
    await f.store.beginRun(f.req); await f.projection.hydrate(f.id, f.store);
    let snapshot = f.projection.snapshot(f.id);
    assert.equal(snapshot.context?.budget?.maxInputTokens, 2048);
    assert.equal(snapshot.context?.budget?.estimatedInputTokens, estimateResponsesInputTokens(f.store.loadContext()!, '规则🙂', definitions));
    assert.equal(snapshot.context?.budget?.contextBytes, Buffer.byteLength(JSON.stringify(f.store.loadContext())));
    assert.equal(snapshot.context?.inputTokens, undefined); assert.equal(snapshot.context?.contextWindow, undefined);
    for (const reported of [17, 4, undefined, 0]) {
      await f.store.append(f.req.identity, { type: 'model_response', response: { outputItems: [assistant('durable response')], toolCalls: [], finishReason: 'completed', usage: reported === undefined ? null : { inputTokens: reported, outputTokens: 2 } } });
      await f.projection.hydrate(f.id, f.store);
      snapshot = f.projection.snapshot(f.id);
      assert.equal(snapshot.context?.inputTokens, reported, 'latest request is neither accumulated nor substituted when unknown');
      assert.equal(snapshot.context?.budget?.estimatedInputTokens, estimateResponsesInputTokens(f.store.loadContext()!, '规则🙂', definitions));
      assert.equal(snapshot.context?.contextWindow, undefined);
    }
    await f.finish(); await f.projection.hydrate(f.id, f.store);
    assert.equal(f.projection.snapshot(f.id).usage?.inputTokens, 10);
    const priorContextLength = f.store.loadContext()!.items.length;
    const next: BeginRunRequest = { ...f.req, identity: { ...f.req.identity, runId: randomUUID(), requestId: randomUUID(), workerGeneration: 2 }, input: 'Continue', userItems: [{ role: 'user', content: 'Continue' }], configuration: { ...f.req.configuration, sessionOptions: { maxInputTokens: 4096 } } };
    await f.store.beginRun(next); await f.projection.hydrate(f.id, f.store);
    snapshot = f.projection.snapshot(f.id);
    assert.equal(snapshot.usage, undefined, 'new run cannot inherit prior aggregate usage');
    assert.equal(snapshot.context?.inputTokens, undefined); assert.equal(snapshot.context?.measuredAt, undefined);
    assert.equal(snapshot.context?.budget?.maxInputTokens, 4096);
    assert.equal(f.store.loadContext()!.items.length, priorContextLength + 1, 'budget edits preserve prior full context');
    await f.reopen(); f.setActive(false);
    const restored = f.create(); await restored.hydrate(f.id, f.store);
    assert.deepEqual(restored.snapshot(f.id).context, snapshot.context);
    assert.equal(restored.snapshot(f.id).usage, undefined, 'interrupted run does not revive prior usage after restart');
    assert.equal(restored.snapshot(f.id).taskState, 'error'); restored.flush();
  } finally { await f.dispose(); }
});

test('budget exhaustion projects an actionable explanation without changing durable runtime reason', async () => {
  const f = await fixture();
  try {
    f.req.input = 'a'.repeat(2000); f.req.userItems = [{ role: 'user', content: f.req.input }];
    f.req.configuration = { model: 'fixture-model', sessionOptions: { maxInputTokens: 1024 } };
    await f.store.beginRun(f.req);
    await f.store.append(f.req.identity, { type: 'run_finished', result: { identity: f.req.identity, status: 'budget_exhausted', reason: 'context_budget', modelRequests: 0, toolCalls: 0, usage: null, context: f.store.loadContext()!, committed: true } });
    await f.projection.hydrate(f.id, f.store);
    const snapshot = f.projection.snapshot(f.id);
    assert.equal(snapshot.context?.budget?.status, 'exceeded');
    assert.equal(snapshot.context?.inputTokens, undefined);
    assert.deepEqual(snapshot.usage, {});
    assert.match(snapshot.error!, /上下文超过运行预算/);
    assert.equal(f.store.getRun(f.req.identity.runId)?.result?.reason, 'context_budget');
  } finally { await f.dispose(); }
});


test('native cost projection uses the durable model price snapshot across restart', async () => {
  const f = await fixture();
  try {
    const pricing = { model: 'fixture-model', inputUSDPerMillion: 2, outputUSDPerMillion: 8 };
    f.req.configuration.pricing = pricing;
    await f.store.beginRun(f.req);
    await f.store.append(f.req.identity, { type: 'model_response', response: { outputItems: [assistant('Known complete response')], toolCalls: [], finishReason: 'completed', usage: { inputTokens: 10, outputTokens: 5 } } });
    await f.finish(); await f.projection.hydrate(f.id, f.store);
    const expected = (10 * 2 + 5 * 8) / 1_000_000;
    assert.ok(Math.abs(f.projection.snapshot(f.id).usage!.costUSD! - expected) < 1e-12);
    pricing.inputUSDPerMillion = 999; pricing.outputUSDPerMillion = 999;
    f.session.engineConfig.options.model = 'changed-external-default';
    await f.reopen(); const restored = f.create(); await restored.hydrate(f.id, f.store);
    assert.ok(Math.abs(restored.snapshot(f.id).usage!.costUSD! - expected) < 1e-12, 'live connection/model edits never rewrite committed rates');
    restored.flush();
  } finally { await f.dispose(); }
});

for (const scenario of ['missing_usage', 'partial_usage', 'model_mismatch', 'no_pricing']) test(`native projection leaves cost unknown for ${scenario}`, async () => {
  const f = await fixture();
  try {
    if (scenario !== 'no_pricing') f.req.configuration.pricing = { model: scenario === 'model_mismatch' ? 'different-model' : 'fixture-model', inputUSDPerMillion: 2, outputUSDPerMillion: 8 };
    await f.store.beginRun(f.req);
    await f.store.append(f.req.identity, { type: 'model_response', response: { outputItems: [assistant('Complete response')], toolCalls: [], finishReason: 'completed', usage: scenario === 'missing_usage' ? null : scenario === 'partial_usage' ? { inputTokens: 10 } : { inputTokens: 10, outputTokens: 5 } } });
    await f.store.append(f.req.identity, { type: 'run_finished', result: { identity: f.req.identity, status: 'completed', reason: 'model_completed', modelRequests: 1, toolCalls: 0,
      usage: scenario === 'missing_usage' ? null : scenario === 'partial_usage' ? { inputTokens: 10 } : { inputTokens: 10, outputTokens: 5 }, context: f.store.loadContext()!, committed: true } });
    await f.projection.hydrate(f.id, f.store); assert.equal(f.projection.snapshot(f.id).usage?.costUSD, undefined);
    await f.reopen(); const restored = f.create(); await restored.hydrate(f.id, f.store);
    assert.equal(restored.snapshot(f.id).usage?.costUSD, undefined); restored.flush();
  } finally { await f.dispose(); }
});

test('chat native projection displays assistant/refusal text and protocol-specific tool budget', async () => {
  const f = await fixture();
  try {
    f.req.protocol = { id: 'openai-chat-completions', version: 1 };
    await f.store.beginRun(f.req);
    await f.store.append(f.req.identity, { type: 'model_response', response: { outputItems: [{ role: 'assistant', content: 'Native chat answer', refusal: null }], toolCalls: [], finishReason: 'completed', usage: { inputTokens: 15 } } });
    await f.finish(); await f.projection.hydrate(f.id, f.store);
    assert.equal(f.projection.snapshot(f.id).messages.at(-1)?.text, 'Native chat answer');
    assert.ok(f.projection.snapshot(f.id).context?.budget?.estimatedInputTokens);
    await f.reopen(); const restored = f.create(); await restored.hydrate(f.id, f.store);
    assert.deepEqual(restored.snapshot(f.id).messages, f.projection.snapshot(f.id).messages); restored.flush();
  } finally { await f.dispose(); }
});

test('unknown context protocol preserves readable evidence without claiming a supported budget', async () => {
  const f = await fixture();
  try {
    f.req.protocol = { id: 'future-protocol', version: 1 };
    await f.store.beginRun(f.req); await f.finish(); await f.projection.hydrate(f.id, f.store);
    assert.equal(f.projection.snapshot(f.id).messages[0].text, f.req.input);
    assert.equal(f.projection.snapshot(f.id).context?.budget, undefined);
  } finally { await f.dispose(); }
});


test('a failed later request cannot price partial reported usage as the complete native run', async () => {
  const f = await fixture();
  try {
    f.req.configuration.pricing = { model: 'fixture-model', inputUSDPerMillion: 2, outputUSDPerMillion: 8 };
    await f.store.beginRun(f.req);
    const usage = { inputTokens: 10, outputTokens: 5 };
    await f.store.append(f.req.identity, { type: 'model_response', response: { outputItems: [assistant('First response was measured')], toolCalls: [], finishReason: 'completed', usage } });
    await f.store.append(f.req.identity, { type: 'run_finished', result: { identity: f.req.identity, status: 'failed', reason: 'model_error', modelRequests: 2, toolCalls: 0, usage, context: f.store.loadContext()!, committed: true } });
    await f.projection.hydrate(f.id, f.store);
    assert.deepEqual(f.projection.snapshot(f.id).usage, usage, 'known token counts stay visible without an invented whole-run cost');
    await f.reopen(); const restored = f.create(); await restored.hydrate(f.id, f.store);
    assert.deepEqual(restored.snapshot(f.id).usage, usage); restored.flush();
  } finally { await f.dispose(); }
});

async function prepareChangeSetProjection(f: Awaited<ReturnType<typeof fixture>>) {
  const preview = { schemaVersion: 1 as const, digest: 'a'.repeat(64), atomic: false as const, files: Array.from({ length: 3 }, (_, index) => ({ index, path: `file-${index}.txt`, kind: 'replace' as const, beforeHash: 'b'.repeat(64), afterHash: 'c'.repeat(64), beforeBytes: 3, afterBytes: 3, diff: '-old\n+new', lineEndings: { before: 'none' as const, after: 'none' as const }, noFinalNewline: { before: true, after: true } })), totalContentBytes: 9, previewBytes: 0 };
  while (preview.previewBytes !== Buffer.byteLength(JSON.stringify(preview))) preview.previewBytes = Buffer.byteLength(JSON.stringify(preview));
  const call: ToolCall = { id: 'batch', name: 'apply_change_set', arguments: '{"changes":[]}' };
  const prepared: PreparedTool = { call, definition: { name: call.name, description: '', inputSchema: {}, risk: 'write' }, input: { changes: [] }, inputDigest: 'digest', policyRevision: 'alpha-1', requiresApproval: true, preconditions: { changeSet: preview } };
  const approval: ApprovalDecision = { decision: 'approved', expiresAt: Date.now() + 1000, binding: { ...f.req.identity, toolCallId: call.id, inputDigest: prepared.inputDigest, policyRevision: 'alpha-1' } };
  await f.store.beginRun(f.req);
  await f.store.append(f.req.identity, { type: 'model_response', response: { outputItems: [{ type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments }], toolCalls: [call], finishReason: 'tool_calls', usage: null } });
  await f.projection.hydrate(f.id, f.store);
  assert.equal(f.projection.snapshot(f.id).messages.at(-1)?.nativeChangeSetState, 'pending');
  await f.store.append(f.req.identity, { type: 'tool_prepared', prepared, approval });
  await f.projection.hydrate(f.id, f.store);
  assert.equal(f.projection.snapshot(f.id).messages.at(-1)?.nativeChangeSetState, 'running');
  return { preview, call, record: (index: number, status: 'prepared' | 'applied' | 'not_applied' | 'unknown') => f.store.recordChangeSetEvent(f.req.identity, call, { changeSetDigest: preview.digest, index, path: preview.files[index].path, status, beforeHash: preview.files[index].beforeHash, afterHash: preview.files[index].afterHash }) };
}

test('multi-file crash projection preserves applied prefix, unknown current file and unstarted remainder', async () => {
  const f = await fixture();
  try {
    const batch = await prepareChangeSetProjection(f);
    await batch.record(0, 'prepared'); await batch.record(0, 'applied'); await batch.record(1, 'prepared');
    await f.reopen(); f.setActive(false); const restored = f.create(); await restored.hydrate(f.id, f.store);
    const message = restored.snapshot(f.id).messages.find(item => item.toolName === batch.call.name)!;
    assert.equal(message.nativeChangeSetState, 'result');
    assert.equal(message.nativeChangeSetResult?.status, 'unknown');
    assert.deepEqual(message.nativeChangeSetResult?.files.map(file => file.status), ['applied', 'unknown', 'not_applied']);
    assert.match(message.text, /不会自动重试/);
    assert.equal(f.store.getRecoveryReport()?.classification, 'unknown_effects');
    restored.flush(); const disk = f.create();
    assert.deepEqual(disk.snapshot(f.id).messages.find(item => item.toolName === batch.call.name)?.nativeChangeSetResult, message.nativeChangeSetResult);
    disk.flush();
  } finally { await f.dispose(); }
});

test('all durable file successes still show overall unknown when the final tool receipt is missing', async () => {
  const f = await fixture();
  try {
    const batch = await prepareChangeSetProjection(f);
    for (let index = 0; index < 3; index++) { await batch.record(index, 'prepared'); await batch.record(index, 'applied'); }
    await f.reopen(); await f.projection.hydrate(f.id, f.store);
    const result = f.projection.snapshot(f.id).messages.find(item => item.toolName === batch.call.name)?.nativeChangeSetResult;
    assert.equal(result?.status, 'unknown'); assert.equal(result?.receiptCommitted, false);
    assert.deepEqual(result?.files.map(file => file.status), ['applied', 'applied', 'applied']);
    assert.equal(f.projection.snapshot(f.id).taskState, 'error');
    assert.equal(f.store.getToolState(f.req.identity.runId, batch.call.id)?.completed, undefined);
  } finally { await f.dispose(); }
});

test('unknown tool output cannot overwrite host-attested per-file effects in recovered projection', async () => {
  const f = await fixture();
  try {
    const batch = await prepareChangeSetProjection(f);
    await batch.record(0, 'prepared'); await batch.record(0, 'applied'); await batch.record(1, 'prepared');
    const output = { digest: batch.preview.digest, atomic: false, status: 'unknown', receiptCommitted: false, files: batch.preview.files.map(file => ({ index: file.index, path: file.path, beforeHash: file.beforeHash, afterHash: file.afterHash, status: 'applied' })) };
    await assert.rejects(f.store.append(f.req.identity, { type: 'tool_completed', call: batch.call, result: { status: 'unknown', output }, resultItems: [] }), { code: 'payload_mismatch' });
    output.files[1].status = 'unknown'; output.files[2].status = 'not_applied';
    await f.store.append(f.req.identity, { type: 'tool_completed', call: batch.call, result: { status: 'unknown', output }, resultItems: [{ type: 'function_call_output', call_id: batch.call.id, output: JSON.stringify(output) }] });
    await f.finish('recovery_required'); await f.projection.hydrate(f.id, f.store);
    const message = f.projection.snapshot(f.id).messages.find(item => item.toolName === batch.call.name)!;
    assert.deepEqual(message.nativeChangeSetResult?.files.map(file => file.status), ['applied', 'unknown', 'not_applied']);
    assert.equal(message.nativeChangeSetResult?.status, 'unknown');
  } finally { await f.dispose(); }
});
