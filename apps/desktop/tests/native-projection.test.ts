import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { NativeRunStore } from '@cc-desk/agent-node/run-store';
import type { BeginRunRequest, RunResult, ToolCall, PreparedTool, ApprovalDecision, ModelRequestDiagnostic } from '@cc-desk/agent-core';
import { estimateResponsesInputTokens } from '@cc-desk/agent-node/responses-model';
import { NativeProjection, MISSING_NATIVE_CONTEXT_MESSAGE, renameNativeProjection } from '../src/main/engines/native/projection';
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
  return { directory, id, conversationId, session, events, errors, projection, create, req, get store() { return store; }, setActive(value: boolean) { active = value; }, reopen: async () => { await store.close(); store = await NativeRunStore.open({ rootDirectory: path.join(directory, 'native'), conversationId }); }, finish: async (status: RunResult['status'] = 'completed') => {
    const result: RunResult = { identity: req.identity, status, reason: status, modelRequests: 1, toolCalls: 0, usage: { inputTokens: 10, outputTokens: 5 }, context: store.loadContext()!, committed: true };
    await store.append(req.identity, { type: 'run_finished', result });
  }, dispose: async () => { projection.flush(); await store.close(); await fs.rm(directory, { recursive: true, force: true }); } };
}
const assistant = (text: string) => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });

test('text deltas notify at most once per 50 ms without cloning the conversation, and approval publishes immediately', async t => {
  const f = await fixture();
  try {
    await f.store.beginRun(f.req); await f.projection.hydrate(f.id, f.store);
    const emitted: string[] = [];
    f.events.subscribe(event => { if (event.type === 'conversation.changed') emitted.push(event.taskState); });
    const snapshot = f.projection.snapshot.bind(f.projection);
    t.mock.method(f.projection, 'snapshot', () => { throw new Error('notification must not build a full snapshot'); });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    for (let index = 0; index < 200; index++) f.projection.event(f.id, { type: 'text_delta', identity: f.req.identity, text: 'a' });
    assert.equal(snapshot(f.id).messages.at(-1)?.text, 'a'.repeat(200), 'coalescing never drops stream content');
    assert.deepEqual(emitted, []);
    t.mock.timers.tick(49); assert.deepEqual(emitted, []);
    t.mock.timers.tick(1); assert.deepEqual(emitted, ['thinking']);
    f.projection.event(f.id, { type: 'text_delta', identity: f.req.identity, text: 'b' });
    f.projection.approval(f.id, { requestId: 'question', kind: 'question', toolName: 'question', input: {}, createdAt: new Date().toISOString() });
    assert.deepEqual(emitted, ['thinking', 'waiting_input']);
    assert.equal(snapshot(f.id).messages.at(-1)?.text, 'a'.repeat(200) + 'b');
    t.mock.timers.tick(1000); assert.deepEqual(emitted, ['thinking', 'waiting_input'], 'approval drains the old timer');
  } finally { f.projection.flush(); t.mock.timers.reset(); await f.dispose(); }
});

test('flush, forget and durable termination drain streaming notifications without late timers', async t => {
  const f = await fixture();
  try {
    await f.store.beginRun(f.req); await f.projection.hydrate(f.id, f.store);
    const emitted: string[] = [];
    f.events.subscribe(event => { if (event.type === 'conversation.changed') emitted.push(event.taskState); });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    f.projection.event(f.id, { type: 'text_delta', identity: f.req.identity, text: 'flush' });
    f.projection.flush(); assert.deepEqual(emitted, ['thinking']);
    t.mock.timers.tick(1000); assert.equal(emitted.length, 1);
    f.projection.event(f.id, { type: 'text_delta', identity: f.req.identity, text: 'forget' });
    f.projection.forget(f.id); assert.deepEqual(emitted, ['thinking', 'thinking']);
    t.mock.timers.tick(1000); assert.equal(emitted.length, 2, 'forget must not recreate the discarded entry');
    await f.projection.hydrate(f.id, f.store); emitted.length = 0;
    f.projection.event(f.id, { type: 'text_delta', identity: f.req.identity, text: 'uncommitted' });
    await f.finish(); await f.projection.hydrate(f.id, f.store);
    assert.deepEqual(emitted, ['completed'], 'a durable terminal record publishes immediately');
    assert.equal(f.projection.snapshot(f.id).messages.some(message => message.text === 'uncommitted'), false);
    t.mock.timers.tick(1000); assert.deepEqual(emitted, ['completed']);
  } finally { f.projection.flush(); t.mock.timers.reset(); await f.dispose(); }
});

test('a queued stream notification cannot refresh a replacement conversation or another engine', async t => {
  const f = await fixture();
  try {
    await f.store.beginRun(f.req); await f.projection.hydrate(f.id, f.store);
    const emitted: unknown[] = [];
    f.events.subscribe(event => { if (event.type === 'conversation.changed') emitted.push(event); });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    f.projection.event(f.id, { type: 'text_delta', identity: f.req.identity, text: 'old-conversation' });
    f.session.execution.conversationId = randomUUID();
    t.mock.timers.tick(50); assert.deepEqual(emitted, []);
    f.session.execution.conversationId = f.conversationId;
    f.projection.event(f.id, { type: 'text_delta', identity: f.req.identity, text: 'old-engine' });
    f.session.execution.providerId = 'claude';
    f.projection.flush(); assert.deepEqual(emitted, []);
    t.mock.timers.tick(1000); assert.deepEqual(emitted, []);
    f.session.execution.providerId = 'native';
    f.projection.event(f.id, { type: 'text_delta', identity: f.req.identity, text: 'current' });
    f.projection.flush(); assert.equal(emitted.length, 1, 'the current bound stream still publishes');
  } finally { f.projection.flush(); t.mock.timers.reset(); await f.dispose(); }
});

test('projection batches writes, retains sync and builds the bounded snapshot without rereading its committed log', async t => {
  const f = await fixture();
  try {
    await f.store.beginRun(f.req);
    for (let index = 0; index < 430; index++) await f.store.append(f.req.identity, { type: 'model_response', response: {
      outputItems: [assistant(`${index}:` + '汉字'.repeat(4000))], toolCalls: [], finishReason: 'completed', usage: { inputTokens: 10, outputTokens: 5 },
    } });
    await f.finish();
    const open = fs.open;
    let writeCalls = 0, syncCalls = 0, readCalls = 0;
    t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      if (String(args[0]).includes('.native-')) {
        const write = handle.writeFile.bind(handle), sync = handle.sync.bind(handle);
        t.mock.method(handle, 'writeFile', async (...data: Parameters<typeof handle.writeFile>) => { writeCalls++; return write(...data); });
        t.mock.method(handle, 'sync', async () => { syncCalls++; return sync(); });
      }
      return handle;
    });
    const readSync = fsSync.readSync;
    t.mock.method(fsSync, 'readSync', (...args: Parameters<typeof fsSync.readSync>) => { readCalls++; return readSync(...args); });
    await f.projection.hydrate(f.id, f.store);
    const readsAfterPublish = readCalls;
    const snapshot = f.projection.snapshot(f.id);
    assert.equal(readCalls, readsAfterPublish);
    assert.equal(readsAfterPublish, 0, 'no synchronous disk replay after the atomically published projection');
    const bytes = (await fs.stat(path.join(f.directory, 'chat', f.id + '.jsonl'))).size;
    assert.ok(writeCalls > 1 && writeCalls < 100, `${writeCalls} batched writes for ${bytes} bytes and over 860 journal events`);
    assert.equal(syncCalls, 1, 'durability is retained before atomic publication');
    assert.equal(snapshot.truncated, true);
    assert.ok(Buffer.byteLength(JSON.stringify(snapshot.messages)) < 2 * 1024 * 1024);
    assert.equal(snapshot.messages.at(-1)?.text, '429:' + '汉字'.repeat(4000));
    const restored = f.create();
    try {
      const cold = restored.snapshot(f.id);
      for (const key of ['messages', 'taskState', 'context', 'usage', 'model', 'truncated'] as const) {
        assert.deepEqual(cold[key], snapshot[key], `direct projection retains the cold JSONL ${key}`);
      }
    }
    finally { restored.flush(); }
  } finally { await f.dispose(); }
});

test('Windows display rename retries a transient sharing error and bounds persistent failures without removing the old target', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-rename-'));
  const source = path.join(directory, 'next.jsonl'), target = path.join(directory, 'current.jsonl');
  const rename = fs.rename;
  let calls = 0, blocked = true;
  const error = Object.assign(new Error('sharing failure'), { code: 'EPERM' });
  t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    calls++;
    if (blocked || calls === 1) throw error;
    return rename(...args);
  });
  try {
    await fs.writeFile(source, 'new'); await fs.writeFile(target, 'old');
    await assert.rejects(renameNativeProjection(source, target, 'win32'), problem => problem === error);
    assert.equal(calls, 4);
    assert.equal(await fs.readFile(target, 'utf8'), 'old');
    assert.equal(await fs.readFile(source, 'utf8'), 'new');
    calls = 0; blocked = false;
    await renameNativeProjection(source, target, 'win32');
    assert.equal(calls, 2);
    assert.equal(await fs.readFile(target, 'utf8'), 'new');
    calls = 0; blocked = true;
    await assert.rejects(renameNativeProjection(source, target, 'linux'), problem => problem === error);
    assert.equal(calls, 1, 'non-Windows failures retain their original immediate rejection');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('repeated identical host state emits once while changed status, error or request identity still publishes', async () => {
  const f = await fixture();
  const events = new ExecutionEvents(), emitted: unknown[] = [];
  events.subscribe(event => { emitted.push(event); });
  const projection = new NativeProjection(f.directory, events, () => f.session, () => false, () => {});
  try {
    projection.state(f.id, 'error', 'Recovery required');
    const initial = emitted.length;
    assert.equal(initial, 2, 'the first state publishes its journal event and conversation notification');
    for (let index = 0; index < 10; index++) projection.state(f.id, 'error', 'Recovery required');
    assert.equal(emitted.length, initial, 're-reading unchanged recovery state cannot schedule another hydration');
    projection.state(f.id, 'error', 'Different recovery error');
    assert.equal(emitted.length, initial + 2);
    projection.state(f.id, 'starting', undefined, 'request-one');
    assert.equal(emitted.length, initial + 4);
    projection.state(f.id, 'starting', undefined, 'request-one');
    assert.equal(emitted.length, initial + 4);
    projection.state(f.id, 'starting', undefined, 'request-two');
    assert.equal(emitted.length, initial + 6, 'an identical status for a new submission is a new host fact');
    projection.state(f.id, 'completed', undefined, 'request-two');
    assert.equal(emitted.length, initial + 8);
    assert.equal(projection.snapshot(f.id).taskState, 'completed');
  } finally { projection.flush(); await f.dispose(); }
});

test('Native user messages retain the host submission identity across identical text, paging and cold replay', async () => {
  const f = await fixture();
  const restored = f.create();
  try {
    await f.store.beginRun(f.req); await f.finish();
    const next = { ...f.req, identity: { ...f.req.identity, runId: randomUUID(), requestId: randomUUID(), workerGeneration: 2 } };
    await f.store.beginRun(next);
    await f.store.append(next.identity, { type: 'run_finished', result: { identity: next.identity, status: 'completed', reason: 'model_completed',
      modelRequests: 0, toolCalls: 0, usage: null, context: f.store.loadContext()!, committed: true } });
    await f.projection.hydrate(f.id, f.store);
    const users = f.projection.snapshot(f.id).messages.filter(message => message.role === 'user');
    assert.deepEqual(users.map(message => message.submissionId), [f.req.identity.requestId, next.identity.requestId]);
    assert.equal(users[0].text, users[1].text, 'repeated text remains two separate host submissions');
    assert.notEqual(users[0].id, users[1].id);
    assert.notEqual(users[0].turnId, users[0].submissionId);
    assert.deepEqual((await f.projection.page(f.id)).messages.filter(message => message.role === 'user'), users);
    f.projection.flush();
    const persisted = f.create();
    assert.deepEqual(persisted.snapshot(f.id).messages.filter(message => message.role === 'user'), users, 'display persistence retains the correlation without loading model history');
    persisted.flush();
    await f.reopen();
    await restored.hydrate(f.id, f.store);
    assert.deepEqual(restored.snapshot(f.id).messages.filter(message => message.role === 'user'), users);
  } finally { restored.flush(); await f.dispose(); }
});

test('cold history replay keeps the starting state of a newly admitted request until its own run starts', async () => {
  const f = await fixture();
  const restored = f.create();
  try {
    await f.store.beginRun(f.req); await f.finish(); await f.reopen();
    const next = { ...f.req, identity: { ...f.req.identity, runId: randomUUID(), requestId: randomUUID(), workerGeneration: 2 }, input: 'Continue the restored conversation' };
    restored.state(f.id, 'starting', undefined, next.identity.requestId);
    await restored.hydrate(f.id, f.store);
    assert.equal(restored.snapshot(f.id).taskState, 'starting', 'an old completed receipt must not finish the newly admitted request');
    assert.equal(restored.snapshot(f.id).nativeRun?.runId, f.req.identity.runId, 'display history still belongs to the old run');
    await f.store.beginRun(next); await restored.hydrate(f.id, f.store);
    assert.equal(restored.snapshot(f.id).nativeRun?.runId, next.identity.runId);
    assert.equal(restored.snapshot(f.id).taskState, 'thinking', 'the new durable run takes over its startup state');
  } finally { restored.flush(); await f.dispose(); }
});

test('a restored completed run cannot clear a newly admitted startup approval', async () => {
  const f = await fixture(), restored = f.create();
  try {
    await f.store.beginRun(f.req); await f.finish(); await f.reopen();
    const requestId = randomUUID();
    restored.state(f.id, 'waiting_approval', undefined, requestId);
    restored.approval(f.id, { requestId: 'new-startup-approval', kind: 'permission', toolName: 'mcp_stdio_startup', input: {}, createdAt: new Date().toISOString() });
    await restored.hydrate(f.id, f.store);
    assert.equal(restored.snapshot(f.id).taskState, 'waiting_approval');
    assert.deepEqual(restored.snapshot(f.id).pending.map(item => item.requestId), ['new-startup-approval']);
  } finally { restored.flush(); await f.dispose(); }
});

test('single request, peak and cumulative usage survive replay without counting diagnostic phases twice', async () => {
  const f = await fixture();
  try {
    f.req.configuration.pricing = { model: 'fixture-model', inputUSDPerMillion: 2, outputUSDPerMillion: 8, cacheReadUSDPerMillion: 0.2 };
    await f.store.beginRun(f.req);
    for (const [index, inputTokens] of [100, 40].entries()) {
      const attempt = index + 1;
      const usage = { inputTokens, outputTokens: index + 2, nonCachedInputTokens: index === 0 ? 20 : 10, cacheReadInputTokens: index === 0 ? 80 : 30, cacheCreationInputTokens: 0 };
      const providerUsage = { raw: { input_tokens: inputTokens, output_tokens: index + 2, cached_tokens: usage.cacheReadInputTokens, cache_write_tokens: 0 }, normalization: 'openai-inclusive-input' as const };
      await f.store.append(f.req.identity, { type: 'model_request_started', attempt });
      const diagnostic: ModelRequestDiagnostic = { schemaVersion: 1, requestKey: `${f.req.identity.runId}:${attempt}`, identity: f.req.identity,
        attempt, purpose: 'normal', protocol: f.req.protocol, model: 'fixture-model', phase: 'started', requestSent: false, startedAt: 1000,
        estimatedInputTokens: 500, estimateMethod: 'utf8_bytes', estimateSource: 'fallback', contextBytes: 100, contextDigest: 'a'.repeat(64), toolsetDigest: 'b'.repeat(64),
        components: { tools: { bytes: 50, digest: 'c'.repeat(64), accounting: 'serialized' } }, usage: null };
      await f.store.append(f.req.identity, { type: 'model_request_diagnostic', diagnostic });
      await f.store.append(f.req.identity, { type: 'model_request_diagnostic', diagnostic: { ...diagnostic, phase: 'request', requestSent: true, payloadBytes: 200 } });
      await f.store.append(f.req.identity, { type: 'model_request_diagnostic', diagnostic: { ...diagnostic, phase: 'finished', requestSent: true, payloadBytes: 200, finishedAt: 1010, elapsedMs: 10, usage, providerUsage, outcome: 'completed' } });
      await f.store.append(f.req.identity, { type: 'model_response', response: { outputItems: [assistant('Measured response')], toolCalls: [], finishReason: 'completed', usage, providerUsage } });
    }
    const usage = { inputTokens: 140, outputTokens: 5, nonCachedInputTokens: 30, cacheReadInputTokens: 110, cacheCreationInputTokens: 0 };
    await f.store.append(f.req.identity, { type: 'run_finished', result: { identity: f.req.identity, status: 'completed', reason: 'model_completed', modelRequests: 2, toolCalls: 0, usage, context: f.store.loadContext()!, committed: true } });
    await f.projection.hydrate(f.id, f.store);
    const snapshot = f.projection.snapshot(f.id);
    assert.equal(snapshot.context?.inputTokens, 40);
    assert.equal(snapshot.context?.peakInputTokens, 100);
    assert.equal(snapshot.context?.peakInputComplete, true);
    assert.equal(snapshot.usage?.inputTokens, 140);
    assert.equal(snapshot.usage?.costUSD, 0.000122);
    assert.deepEqual(snapshot.usage?.nativeRequests, { scope: 'parent_run_with_in_turn_summaries', recorded: 2, expected: 2, complete: true });
    assert.equal(snapshot.context?.requestUsage?.provider?.raw.cached_tokens, 30);
    assert.equal(snapshot.context?.requestDiagnostic?.payloadBytes, 200);
    assert.deepEqual(snapshot.context?.requestDiagnostic?.components.tools, { bytes: 50, accounting: 'serialized' });
    assert.doesNotMatch(JSON.stringify(snapshot.context), /cccccccccccccccc|payloadDigest|contextDigest/);
    const before = await fs.readFile(f.projection.exportPath(f.id), 'utf8');
    await f.reopen(); const restored = f.create(); await restored.hydrate(f.id, f.store);
    assert.deepEqual(restored.snapshot(f.id).context, snapshot.context);
    assert.deepEqual(restored.snapshot(f.id).usage, snapshot.usage);
    assert.equal(await fs.readFile(restored.exportPath(f.id), 'utf8'), before);
    restored.flush();
  } finally { await f.dispose(); }
});

for (const protocol of ['openai-responses', 'openai-chat-completions']) test(`Native image-only history keeps submitted metadata through pagination, export and restart: ${protocol}`, async () => {
  const f = await fixture();
  try {
    const payload = Buffer.from('private-image-payload-only-in-model-ledger');
    const image = { name: '原图-snapshot.png', mimeType: 'image/png', bytes: payload.length, sha256: createHash('sha256').update(payload).digest('hex') };
    const original = structuredClone(image), dataUrl = `data:image/png;base64,${payload.toString('base64')}`;
    f.req.input = ''; f.req.protocol = { id: protocol, version: 1 };
    f.req.userItems = [{ role: 'user', content: protocol === 'openai-responses' ? [{ type: 'input_image', image_url: dataUrl, detail: 'auto' }] : [{ type: 'image_url', image_url: { url: dataUrl, detail: 'auto' } }] }];
    f.req.configuration.imageAttachments = [image];
    await f.store.beginRun(f.req); await f.finish(); await f.projection.hydrate(f.id, f.store);
    const before = f.projection.snapshot(f.id).messages[0];
    assert.equal(before.text, ''); assert.deepEqual(before.nativeImageAttachments, [original]);
    image.name = 'changed-after-submit.jpg';
    before.nativeImageAttachments![0].name = 'renderer-cannot-rewrite.png';
    assert.deepEqual(f.projection.snapshot(f.id).messages[0].nativeImageAttachments, [original]);
    assert.deepEqual((await f.projection.page(f.id)).messages[0].nativeImageAttachments, [original]);
    assert.equal((await f.projection.search(f.id, '原图-snapshot')).hits[0].id, before.id);
    const exported = await fs.readFile(f.projection.exportPath(f.id), 'utf8');
    assert.match(exported, /原图-snapshot.png/); assert.match(exported, new RegExp(original.sha256));
    assert.ok(!exported.includes(dataUrl)); assert.ok(!exported.includes(payload.toString('base64'))); assert.ok(!exported.includes(f.directory));
    await f.reopen(); f.setActive(false); const restored = f.create();
    assert.deepEqual(restored.snapshot(f.id).messages[0].nativeImageAttachments, [original], 'display journal is readable before rebuilding model history');
    await restored.hydrate(f.id, f.store);
    assert.deepEqual(restored.snapshot(f.id).messages[0].nativeImageAttachments, [original]);
    assert.deepEqual((await restored.page(f.id)).messages[0].nativeImageAttachments, [original]);
    assert.equal(await fs.readFile(restored.exportPath(f.id), 'utf8'), exported);
    restored.flush();
  } finally { await f.dispose(); }
});

test('Native projection refuses corrupt image metadata without exporting hidden payload fields', async () => {
  const f = await fixture();
  try {
    f.req.configuration.imageAttachments = [{ name: 'image.png', mimeType: 'image/png', bytes: 100, sha256: 'a'.repeat(64), data: 'SECRET-IMAGE-PAYLOAD' }];
    await f.store.beginRun(f.req);
    await assert.rejects(f.projection.hydrate(f.id, f.store), /图片记录元数据损坏/);
    assert.equal(f.projection.snapshot(f.id).messages.length, 0);
    const exported = await fs.readFile(f.projection.exportPath(f.id), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
    assert.ok(!exported.includes('SECRET-IMAGE-PAYLOAD'));
  } finally { await f.dispose(); }
});

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
  let changes = 0;
  f.events.subscribe(event => { if (event.type === 'conversation.changed') changes++; });
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
    const initialChanges = changes;
    assert.equal(initialChanges, 1);
    const sidecar = path.join(f.directory, 'chat', f.id + '.display.json');
    const published = (await fs.stat(sidecar, { bigint: true })).mtimeNs;
    for (let index = 0; index < 3; index++) await f.projection.hydrate(f.id, f.store);
    assert.equal(changes, initialChanges, 'unchanged read-only recovery state cannot schedule another hydration');
    assert.equal((await fs.stat(sidecar, { bigint: true })).mtimeNs, published, 'an identical source does not republish its derived cache');
    const changedTime = new Date(Date.now() + 5_000);
    await fs.utimes(file, changedTime, changedTime);
    await f.projection.hydrate(f.id, f.store);
    assert.equal(changes, initialChanges + 1, 'changed display source metadata invalidates the preservation publication');
    await f.projection.hydrate(f.id, f.store);
    assert.equal(changes, initialChanges + 1);
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

test('unknown saved configuration versions preserve readable history without inventing a context budget', async () => {
  const f = await fixture();
  try {
    f.req.configuration = { model: 'fixture-model', sessionOptionsSchemaVersion: 3, sessionOptions: { maxInputTokens: 2048 } };
    await f.store.beginRun(f.req); await f.finish();
    await f.projection.hydrate(f.id, f.store);
    const snapshot = f.projection.snapshot(f.id);
    assert.equal(snapshot.messages.find(message => message.role === 'user')?.text, f.req.input);
    assert.equal(snapshot.taskState, 'completed');
    assert.equal(snapshot.context?.model, 'fixture-model');
    assert.equal(snapshot.context?.budget, undefined);
    assert.deepEqual(f.errors, []);
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
    assert.equal(snapshot.usage?.inputTokens, undefined);
    assert.equal(snapshot.usage?.nativeCost?.reason, 'missing_usage');
    assert.match(snapshot.error!, /上下文超过运行预算/);
    assert.equal(f.store.getRun(f.req.identity.runId)?.result?.reason, 'context_budget');
  } finally { await f.dispose(); }
});


test('native cost projection uses the durable model price snapshot across restart', async () => {
  const f = await fixture();
  try {
    const pricing = { model: 'fixture-model', inputUSDPerMillion: 2, outputUSDPerMillion: 8 };
    f.req.configuration.pricing = pricing;
    const usage = { inputTokens: 10, outputTokens: 5, nonCachedInputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
    await f.store.beginRun(f.req);
    await f.store.append(f.req.identity, { type: 'model_response', response: { outputItems: [assistant('Known complete response')], toolCalls: [], finishReason: 'completed', usage } });
    await f.store.append(f.req.identity, { type: 'run_finished', result: { identity: f.req.identity, status: 'completed', reason: 'model_completed', modelRequests: 1, toolCalls: 0, usage, context: f.store.loadContext()!, committed: true } });
    await f.projection.hydrate(f.id, f.store);
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
    const projectedUsage = f.projection.snapshot(f.id).usage;
    assert.equal(projectedUsage?.inputTokens, usage.inputTokens, 'known token counts stay visible without an invented whole-run cost');
    assert.equal(projectedUsage?.costUSD, undefined);
    assert.equal(projectedUsage?.nativeCost?.reason, 'incomplete_requests');
    await f.reopen(); const restored = f.create(); await restored.hydrate(f.id, f.store);
    assert.deepEqual(restored.snapshot(f.id).usage, projectedUsage); restored.flush();
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

test('failed partial output is discarded with a durable diagnostic and cannot become assistant history', async () => {
  const f = await fixture();
  try {
    await f.store.beginRun(f.req); await f.store.append(f.req.identity, { type: 'model_request_started', attempt: 1 }); await f.projection.hydrate(f.id, f.store);
    f.projection.event(f.id, { type: 'text_delta', identity: f.req.identity, text: 'UNCOMMITTED-PARTIAL' });
    assert.equal(f.projection.snapshot(f.id).messages.at(-1)?.text, 'UNCOMMITTED-PARTIAL');
    await f.store.append(f.req.identity, { type: 'model_request_failed', attempt: 1, failure: { category: 'network', retryable: false }, partial: true }); await f.projection.hydrate(f.id, f.store);
    assert.equal(f.projection.snapshot(f.id).messages.some(message => message.role === 'assistant'), false);
    assert.match(f.projection.snapshot(f.id).messages.at(-1)!.text, /未完成.*丢弃/);
    await f.store.append(f.req.identity, { type: 'run_finished', result: { identity: f.req.identity, status: 'failed', reason: 'model_partial_response', modelRequests: 1, toolCalls: 0, usage: null, context: f.store.loadContext()!, committed: true } }); await f.projection.hydrate(f.id, f.store);
    assert.equal((await fs.readFile(f.projection.exportPath(f.id), 'utf8')).includes('UNCOMMITTED-PARTIAL'), false);
    await f.reopen(); const restored = f.create(); await restored.hydrate(f.id, f.store);
    assert.deepEqual(restored.snapshot(f.id).messages, f.projection.snapshot(f.id).messages); restored.flush();
    const next = { ...f.req, identity: { ...f.req.identity, runId: randomUUID(), requestId: randomUUID(), workerGeneration: 2 } };
    await f.store.beginRun(next); await f.store.append(next.identity, { type: 'model_request_started', attempt: 1 }); await f.projection.hydrate(f.id, f.store);
    f.projection.event(f.id, { type: 'text_delta', identity: next.identity, text: 'NEW-RESPONSE' });
    assert.equal(f.projection.snapshot(f.id).messages.at(-1)?.text, 'NEW-RESPONSE');
    assert.equal(f.projection.snapshot(f.id).messages.some(message => message.text.includes('UNCOMMITTED-PARTIAL')), false);
  } finally { await f.dispose(); }
});

test('successful bounded retry keeps one assistant answer and unknown whole-run cost after restart', async () => {
  const f = await fixture();
  try {
    f.req.configuration.pricing = { model: 'fixture-model', inputUSDPerMillion: 3, outputUSDPerMillion: 15 };
    await f.store.beginRun(f.req); await f.store.append(f.req.identity, { type: 'model_request_started', attempt: 1 });
    await f.store.append(f.req.identity, { type: 'model_request_failed', attempt: 1, failure: { category: 'rate_limit', httpStatus: 429, retryable: true }, partial: false, retryDelayMs: 500 }); await f.projection.hydrate(f.id, f.store);
    assert.match(f.projection.snapshot(f.id).messages.at(-1)!.text, /重试/);
    await f.store.append(f.req.identity, { type: 'model_request_started', attempt: 2 }); await f.projection.hydrate(f.id, f.store);
    f.projection.event(f.id, { type: 'text_delta', identity: f.req.identity, text: 'temporary output' });
    await f.store.append(f.req.identity, { type: 'model_response', response: { outputItems: [assistant('Only final answer')], toolCalls: [], finishReason: 'completed', usage: { inputTokens: 10, outputTokens: 5 } } });
    await f.store.append(f.req.identity, { type: 'run_finished', result: { identity: f.req.identity, status: 'completed', reason: 'model_completed', modelRequests: 2, toolCalls: 0, usage: null, context: f.store.loadContext()!, committed: true } }); await f.projection.hydrate(f.id, f.store);
    const snapshot = f.projection.snapshot(f.id);
    assert.equal(snapshot.taskState, 'completed'); assert.equal(snapshot.usage?.inputTokens, undefined);
    assert.equal(snapshot.usage?.nativeCost?.reason, 'incomplete_requests');
    assert.deepEqual(snapshot.messages.filter(message => message.role === 'assistant').map(message => message.text), ['Only final answer']);
    await f.reopen(); const restored = f.create(); await restored.hydrate(f.id, f.store);
    assert.deepEqual(restored.snapshot(f.id).usage, snapshot.usage); assert.deepEqual(restored.snapshot(f.id).messages, snapshot.messages); restored.flush();
  } finally { await f.dispose(); }
});

for (const actualRetry of [false, true]) test(`blocked summary counts actual retries rather than scheduled waits: ${actualRetry}`, async () => {
  const f = await fixture();
  try {
    await f.store.beginRun(f.req); await f.store.append(f.req.identity, { type: 'model_request_started', attempt: 1 });
    await f.store.append(f.req.identity, { type: 'model_request_failed', attempt: 1, failure: { category: 'service_unavailable', httpStatus: 503, retryable: true }, partial: false, retryDelayMs: 500 });
    if (actualRetry) {
      await f.store.append(f.req.identity, { type: 'model_request_started', attempt: 2 });
      await f.store.append(f.req.identity, { type: 'model_request_failed', attempt: 2, failure: { category: 'authentication', httpStatus: 401, retryable: false }, partial: false });
    }
    await f.store.append(f.req.identity, { type: 'run_finished', result: { identity: f.req.identity, status: actualRetry ? 'failed' : 'cancelled', reason: actualRetry ? 'model_authentication' : 'cancelled', modelRequests: actualRetry ? 2 : 1, toolCalls: 0, usage: null, context: f.store.loadContext()!, committed: true } }); await f.projection.hydrate(f.id, f.store);
    const error = f.projection.snapshot(f.id).error ?? '';
    assert.match(error, new RegExp(`模型请求 ${actualRetry ? 2 : 1} 次`));
    assert.equal(error.includes('已执行有限重试 1 次'), actualRetry);
  } finally { await f.dispose(); }
});
