import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { runAgent } from '@cc-desk/agent-core';
import { NativeRunStore } from '@cc-desk/agent-node/run-store';
import { createNativeModel, estimateNativeInputTokens } from '@cc-desk/agent-node/native-model';
import { StateStore } from '../src/main/store';
import { ExecutionEvents } from '../src/main/execution/events';
import { ConnectionStore } from '../src/main/engines/native/connections';
import { NativeStructuredExecutor, type NativeExecutorOptions } from '../src/main/engines/native/structured-executor';
import { createNativeConfig } from '../src/main/engines/native/config';
import { summarizeNativeContext } from '../src/main/engines/native/context-summary';
// @ts-expect-error Local test-only ESM fixture has no declarations.
import { startChatCompletionsFixture } from '../../../packages/agent-node/tests/fixtures/chat-completions-server.mjs';

type Worker = NonNullable<NativeExecutorOptions['worker']>;
const secret = 'sk-chat-executor-fixture-secret';
const inlineWorker: Worker = options => runAgent({ ...options.request, signal: options.signal }, {
  model: createNativeModel(options.model), tools: options.tools, store: options.store, approvals: options.approvals,
  host: { now: Date.now, digest: value => createHash('sha256').update(value).digest('hex'), emit: options.onEvent,
    deadline: (timeout, parent) => { const controller = new AbortController(), abort = () => controller.abort(); const timer = setTimeout(abort, timeout); parent.addEventListener('abort', abort, { once: true }); if (parent.aborted) abort(); return { signal: controller.signal, dispose: () => { clearTimeout(timer); parent.removeEventListener('abort', abort); } }; },
  },
});
async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-chat-protocol-'));
  const data = path.join(directory, 'data'), project = path.join(directory, 'project');
  await fs.mkdir(project); await fs.writeFile(path.join(project, 'fixture.txt'), 'verified local source');
  await fs.writeFile(path.join(project, 'AGENTS.md'), 'Never modify unrelated files.');
  const server = await startChatCompletionsFixture({ handler: ({ body, index }: { body: { messages: Array<{ role: string; content: string }>; tools?: unknown[] }; index: number }) => {
    if (!body.tools?.length) return { message: { role: 'assistant', content: '历史目标：检查 fixture.txt；已完成读取，没有修改文件。保留最近回合。' } };
    const last = body.messages.at(-1)!;
    if (last.role === 'user' && last.content.includes('[read]')) return { message: { role: 'assistant', content: null, tool_calls: [{ id: `read-${index}`, type: 'function', function: { name: 'read_file', arguments: '{"path":"fixture.txt"}' } }] } };
    return { message: { role: 'assistant', content: '已完成本地检查。' + 'confirmed historical fixture details. '.repeat(120) } };
  } });
  const store = new StateStore(data), connections = new ConnectionStore(data), events = new ExecutionEvents();
  const created = connections.upsert({ name: 'chat fixture', protocol: 'chat-completions', baseURL: server.baseURL, model: 'fixture-model', allowLoopbackHttp: true, enabled: true, auth: { mode: 'memory' }, pricing: { model: 'fixture-model', inputUSDPerMillion: 2, outputUSDPerMillion: 8 } });
  connections.setCredential({ id: created.id, revision: created.revision, mode: 'memory', secret });
  const id = randomUUID(), conversationId = randomUUID(), projectId = randomUUID();
  store.change(state => {
    state.projects.push({ id: projectId, path: project, name: 'fixture', createdAt: new Date().toISOString() });
    state.sessions.push({ id, projectId, title: 'chat', kind: 'agent', cwd: project, execution: { providerId: 'native', mode: 'structured', conversationId }, engineConfig: createNativeConfig({ schemaVersion: 1, options: { connectionId: created.id } }), started: false, status: 'idle', archived: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  });
  const calls: Parameters<Worker>[0][] = [];
  const worker: Worker = options => { calls.push(options); return inlineWorker(options); };
  let executor = new NativeStructuredExecutor(store, connections, events, { worker }); await executor.initialize();
  const readLedger = async () => {
    const ledger = await NativeRunStore.open({ rootDirectory: path.join(data, 'native', 'conversations'), conversationId });
    try { return { context: ledger.loadContext(), records: ledger.replay(), compaction: ledger.getLastCompaction() }; } finally { await ledger.close(); }
  };
  return { id, connections, server, store, calls, project, readLedger, get executor() { return executor; },
    async restart() { await executor.shutdown(); executor = new NativeStructuredExecutor(store, connections, events, { worker }); await executor.initialize(); },
    async dispose() { await executor.shutdown(); await server.close(); store.flush(); await fs.rm(directory, { recursive: true, force: true }); },
  };
}

test('chat executor runs local tools and preserves native history, cost snapshot, and manual summary across restart', async () => {
  const f = await fixture();
  try {
    const first = await f.executor.send(f.id, 'Original constraints: inspect only [read]');
    assert.equal(first.success, true, JSON.stringify(first)); assert.equal(f.server.requests.length, 2);
    assert.equal(await fs.readFile(path.join(f.project, 'fixture.txt'), 'utf8'), 'verified local source');
    const before = await f.readLedger();
    assert.equal(before.context!.protocol.id, 'openai-chat-completions');
    assert.ok(before.context!.items.some(item => typeof item === 'object' && item && 'role' in item && item.role === 'tool'));
    assert.equal(JSON.stringify(before).includes(secret), false); assert.ok(f.executor.snapshot(f.id).usage?.costUSD);
    await f.restart(); assert.equal(f.executor.snapshot(f.id).messages.filter(item => item.role === 'tool').length, 1);
    assert.equal((await f.executor.send(f.id, 'Second explicit turn [read]')).success, true);
    assert.deepEqual(f.server.requests[2].messages.slice(1, before.context!.items.length + 1), before.context!.items);
    const latest = await f.readLedger(); await f.executor.compactContext(f.id, f.executor.snapshot(f.id).nativeContextMaintenance!.headHash);
    const compacted = await f.readLedger(); assert.ok(compacted.compaction); assert.equal(compacted.context!.protocol.id, 'openai-chat-completions');
    assert.equal(typeof (compacted.context!.items[1] as { content: unknown }).content, 'string');
    assert.deepEqual(compacted.records.slice(0, latest.records.length), latest.records);
    await f.restart(); assert.equal((await f.executor.send(f.id, 'Continue after summary')).success, true);
    assert.match(f.server.requests.at(-1).messages[2].content, /Summary of earlier conversation/); assert.deepEqual(f.server.errors, []);
  } finally { await f.dispose(); }
});

test('chat before-send automatic compaction uses one isolated summary with an empty tool catalog', async () => {
  const f = await fixture();
  try {
    for (const input of ['Original goal', 'Second goal', 'Recent goal [read]']) assert.equal((await f.executor.send(f.id, input)).success, true);
    const before = await f.readLedger(), last = f.calls.at(-1)!; const input = 'Continue automatically';
    const pending = { ...before.context!, items: [...before.context!.items, ...createNativeModel(last.model).userItems(input)] };
    const estimate = estimateNativeInputTokens(pending, last.model.instructions, last.model.toolDefinitions);
    const config = structuredClone(f.store.state.sessions.find(item => item.id === f.id)!.engineConfig);
    config.options.autoCompact = 'before_send'; config.options.maxInputTokens = Math.floor(estimate / 0.95);
    await f.executor.updateConfig(f.id, config);
    const result = await f.executor.send(f.id, input); assert.equal(result.success, true, JSON.stringify(result));
    const summaries = f.calls.filter(call => call.request.configuration.purpose === 'context_summary');
    assert.equal(summaries.length, 1); assert.equal(summaries[0].model.protocol, 'chat-completions'); assert.deepEqual(summaries[0].tools.definitions, []);
    const after = await f.readLedger(); assert.ok(after.compaction?.automaticRequestId);
    assert.deepEqual(after.records.slice(0, before.records.length), before.records); assert.deepEqual(f.server.errors, []);
  } finally { await f.dispose(); }
});

test('editing a used connection protocol blocks new sends and compaction before any model worker', async () => {
  const f = await fixture();
  try {
    for (const input of ['first', 'second']) assert.equal((await f.executor.send(f.id, input)).success, true);
    const { credentialConfigured: _credential, ready: _ready, error: _error, ...metadata } = f.connections.list().connections[0];
    f.connections.upsert({ ...metadata, protocol: 'responses' });
    const starts = f.calls.length, requests = f.server.requests.length, prior = await f.readLedger();
    const result = await f.executor.send(f.id, 'cannot switch'); assert.equal(result.success, false); assert.match(result.error!, /协议|新建会话/);
    await assert.rejects(f.executor.compactContext(f.id, f.executor.snapshot(f.id).nativeContextMaintenance!.headHash), /协议|新建会话/);
    assert.equal(f.calls.length, starts); assert.equal(f.server.requests.length, requests); assert.deepEqual(await f.readLedger(), prior);
  } finally { await f.dispose(); }
});

for (const [name, message] of [
  ['refusal', { role: 'assistant', content: null, refusal: 'I cannot summarize.' }],
  ['tool call', { role: 'assistant', content: null, tool_calls: [{ id: 'bad', type: 'function', function: { name: 'run_command', arguments: '{}' } }] }],
] as const) test(`chat isolated summary refuses ${name} without executing a tool`, async () => {
  const server = await startChatCompletionsFixture({ handler: () => ({ message }) });
  try {
    const identity = { sessionId: randomUUID(), conversationId: randomUUID(), runId: randomUUID(), requestId: randomUUID(), workerGeneration: 1 };
    await assert.rejects(summarizeNativeContext({ identity, context: { protocol: { id: 'openai-chat-completions', version: 1 }, items: [{ role: 'user', content: 'historical goal' }] },
      model: { protocol: 'chat-completions', baseURL: server.baseURL, model: 'fixture-model', apiKey: secret, allowLoopbackHttp: true }, maxInputTokens: 64000, maxOutputTokens: 1024, maxActiveMs: 30000, signal: new AbortController().signal, worker: inlineWorker }), { code: 'invalid_summary' });
    assert.equal(server.requests.length, 1); assert.equal(server.requests[0].tools, undefined);
  } finally { await server.close(); }
});
