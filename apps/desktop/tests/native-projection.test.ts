import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { NativeRunStore } from '@cc-desk/agent-node/run-store';
import type { BeginRunRequest, RunResult, ToolCall, PreparedTool, ApprovalDecision } from '@cc-desk/agent-core';
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
  const req: BeginRunRequest = { identity: { sessionId: id, conversationId, runId: randomUUID(), requestId: randomUUID(), workerGeneration: 1 }, input: 'Please fix searchneedle', inputDigest: 'digest', userItems: [{ role: 'user', content: 'Please fix searchneedle' }], protocol: { id: 'openai.responses', version: 1 }, configuration: { model: 'fixture-model' }, policyRevision: 'alpha-1' };
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
