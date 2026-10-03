import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { runAgent } from '@cc-desk/agent-core';
import { NativeRunStore } from '@cc-desk/agent-node/run-store';
import { createNativeModel, estimateNativeInputTokens } from '@cc-desk/agent-node/native-model';
import { requireCompleteContext } from '@cc-desk/agent-node/context-maintenance';
import { StateStore } from '../src/main/store';
import { ExecutionEvents } from '../src/main/execution/events';
import { ConnectionStore } from '../src/main/engines/native/connections';
import { NativeStructuredExecutor, type NativeExecutorOptions } from '../src/main/engines/native/structured-executor';
import { createNativeConfig } from '../src/main/engines/native/config';
// @ts-expect-error Local test-only ESM fixture has no declarations.
import { startAnthropicFixture } from '../../../packages/agent-node/tests/fixtures/anthropic-server.mjs';

type Worker = NonNullable<NativeExecutorOptions['worker']>;
type Block = { type: string; text?: string; id?: string; tool_use_id?: string; content?: string; is_error?: boolean };
type Message = { role: string; content: Block[] };
const secret = 'anthropic-executor-auth-token-fixture';
const summary = '历史目标：只读取 fixture.txt，未修改文件。已验证读取结果，继续保留最近回合与原始约束。';
const inlineWorker: Worker = options => runAgent({ ...options.request, signal: options.signal }, {
  model: createNativeModel(options.model), tools: options.tools, store: options.store, approvals: options.approvals,
  host: { now: Date.now, digest: value => createHash('sha256').update(value).digest('hex'), emit: options.onEvent,
    deadline: (timeout, parent) => {
      const controller = new AbortController(), abort = () => controller.abort();
      const timer = setTimeout(abort, timeout); parent.addEventListener('abort', abort, { once: true });
      if (parent.aborted) abort();
      return { signal: controller.signal, dispose: () => { clearTimeout(timer); parent.removeEventListener('abort', abort); } };
    },
  },
});

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-anthropic-executor-'));
  const data = path.join(directory, 'data'), project = path.join(directory, 'project');
  await fs.mkdir(project); await fs.writeFile(path.join(project, 'fixture.txt'), 'verified Anthropic local source');
  await fs.writeFile(path.join(project, 'AGENTS.md'), 'Inspect files only. Never modify unrelated files.');
  const server = await startAnthropicFixture({ handler: ({ body, index }: { body: { messages: Message[]; tools?: unknown[] }; index: number }) => {
    if (!body.tools?.length) return { content: [{ type: 'text', text: summary }] };
    const last = body.messages.at(-1)!;
    if (last.role === 'user' && last.content.some(block => block.type === 'text' && block.text?.includes('[read]'))) {
      return { content: [{ type: 'tool_use', id: `toolu-read-${index}`, name: 'read_file', input: { path: 'fixture.txt' } }] };
    }
    return { content: [{ type: 'text', text: '本地检查完成，没有修改文件。' + 'confirmed historical fixture details. '.repeat(120) }] };
  } });
  let store = new StateStore(data), connections = new ConnectionStore(data);
  const created = connections.import({ name: 'imported Claude fixture', protocol: 'anthropic', authHeader: 'authorization',
    baseURL: server.baseURL, model: 'fixture-model', allowLoopbackHttp: true, enabled: true, auth: { mode: 'memory' } }, { mode: 'memory', secret });
  const id = randomUUID(), conversationId = randomUUID(), projectId = randomUUID(), now = new Date().toISOString();
  store.change(state => {
    state.projects.push({ id: projectId, path: project, name: 'fixture', createdAt: now });
    state.sessions.push({ id, projectId, title: 'Anthropic continuity', kind: 'agent', cwd: project,
      execution: { providerId: 'native', mode: 'structured', conversationId },
      engineConfig: createNativeConfig({ schemaVersion: 1, options: { connectionId: created.id } }),
      started: false, status: 'idle', archived: false, createdAt: now, updatedAt: now });
  });
  const calls: Parameters<Worker>[0][] = [];
  const worker: Worker = options => { calls.push(options); return inlineWorker(options); };
  const events = new ExecutionEvents();
  let executor = new NativeStructuredExecutor(store, connections, events, { worker }); await executor.initialize();
  const readLedger = async () => {
    const ledger = await NativeRunStore.open({ rootDirectory: path.join(data, 'native', 'conversations'), conversationId });
    try { return { context: ledger.loadContext(), records: ledger.replay(), compaction: ledger.getLastCompaction() }; }
    finally { await ledger.close(); }
  };
  return { id, project, data, server, calls, readLedger,
    get store() { return store; }, get connections() { return connections; }, get executor() { return executor; },
    async restart() {
      await executor.shutdown(); store.flush(); store = new StateStore(data); connections = new ConnectionStore(data);
      const connection = connections.list().connections.find(item => item.id === created.id)!;
      assert.equal(connection.authHeader, 'authorization'); assert.equal(connection.ready, false);
      connections.setCredential({ id: connection.id, revision: connection.revision, mode: 'memory', secret });
      executor = new NativeStructuredExecutor(store, connections, events, { worker }); await executor.initialize();
    },
    async dispose() { await executor.shutdown(); await server.close(); store.flush(); await fs.rm(directory, { recursive: true, force: true }); },
  };
}

function assertTransport(server: Awaited<ReturnType<typeof fixture>>['server']) {
  for (const headers of server.requestHeaders) {
    assert.equal(headers.authorization, `Bearer ${secret}`);
    assert.equal(headers['x-api-key'], undefined);
  }
  assert.deepEqual(server.errors, []);
  assert.equal(JSON.stringify(server.requests).includes(secret), false);
}

test('Anthropic executor persists real tool results across restart, summarizes without tools and blocks changing a used protocol', async () => {
  const f = await fixture();
  try {
    assert.equal(f.server.requests.length, 0, 'import and initialization never request the model');
    const first = await f.executor.send(f.id, 'Original constraints: inspect only [read]');
    assert.equal(first.success, true, JSON.stringify(first)); assert.equal(f.server.requests.length, 2);
    assert.equal(await fs.readFile(path.join(f.project, 'fixture.txt'), 'utf8'), 'verified Anthropic local source');
    const before = await f.readLedger(); requireCompleteContext(before.context!);
    assert.deepEqual(before.context!.protocol, { id: 'anthropic-messages', version: 1 });
    const items = before.context!.items as unknown as Message[];
    const call = items.flatMap(item => item.content).find(block => block.type === 'tool_use')!;
    const result = items.flatMap(item => item.content).find(block => block.type === 'tool_result')!;
    assert.equal(result.tool_use_id, call.id); assert.equal(result.is_error, false);
    assert.equal(JSON.parse(result.content!).status, 'completed'); assert.match(result.content!, /verified Anthropic local source/);
    assert.deepEqual(f.server.requests[1].messages, items.slice(0, -1));
    assert.equal(JSON.stringify(before).includes(secret), false);
    const starts = f.calls.length; await f.restart(); assert.equal(f.calls.length, starts);
    assert.deepEqual((await f.readLedger()).context, before.context);
    assert.equal(f.executor.snapshot(f.id).messages.filter(item => item.role === 'tool').length, 1);
    assert.equal((await f.executor.send(f.id, 'Second explicit read [read]')).success, true);
    assert.deepEqual(f.server.requests[2].messages.slice(0, items.length), items);

    const latest = await f.readLedger();
    await f.executor.compactContext(f.id, f.executor.snapshot(f.id).nativeContextMaintenance!.headHash);
    const summaries = f.calls.filter(call => call.request.configuration.purpose === 'context_summary');
    assert.equal(summaries.length, 1); assert.deepEqual(summaries[0].tools.definitions, []);
    assert.deepEqual(summaries[0].model.toolDefinitions, []); assert.equal(summaries[0].model.authHeader, 'authorization');
    const summaryRequest = f.server.requests[4];
    assert.equal(summaryRequest.tools, undefined); assert.equal(summaryRequest.tool_choice, undefined);
    assert.match(summaryRequest.system, /untrusted data/);
    const summaryHistory = JSON.parse(summaryRequest.messages[0].content[0].text).history;
    assert.deepEqual(summaryHistory.protocol, before.context!.protocol);
    assert.ok(summaryHistory.items.some((item: Message) => item.content.some(block => block.type === 'tool_result')));
    const compacted = await f.readLedger(); requireCompleteContext(compacted.context!);
    assert.ok(compacted.compaction); assert.deepEqual(compacted.context!.protocol, before.context!.protocol);
    assert.deepEqual(compacted.records.slice(0, latest.records.length), latest.records);
    assert.deepEqual(compacted.context!.items[0], before.context!.items[0]);
    await f.restart(); assert.deepEqual((await f.readLedger()).context, compacted.context);
    assert.equal((await f.executor.send(f.id, 'Continue after summary')).success, true);
    assert.deepEqual(f.server.requests.at(-1).messages.slice(0, compacted.context!.items.length), compacted.context!.items);
    assert.match(f.server.requests.at(-1).messages[1].content[0].text, /Summary of earlier conversation/);
    assert.match(f.server.requests.at(-1).messages[1].content[0].text, /历史目标/);
    assertTransport(f.server);
    assert.equal(JSON.stringify(f.executor.snapshot(f.id)).includes(secret), false);
    assert.equal((await fs.readFile(path.join(f.data, 'native', 'connections.json'), 'utf8')).includes(secret), false);

    const { credentialConfigured: _credential, ready: _ready, error: _error, ...metadata } = f.connections.list().connections[0];
    f.connections.upsert({ ...metadata, protocol: 'chat-completions', authHeader: undefined });
    const requests = f.server.requests.length, workers = f.calls.length, prior = await f.readLedger();
    const switched = await f.executor.send(f.id, 'cannot switch protocols');
    assert.equal(switched.success, false); assert.match(switched.error!, /协议|新建会话/);
    await assert.rejects(f.executor.compactContext(f.id, f.executor.snapshot(f.id).nativeContextMaintenance!.headHash), /协议|新建会话/);
    assert.equal(f.calls.length, workers); assert.equal(f.server.requests.length, requests); assert.deepEqual(await f.readLedger(), prior);
  } finally { await f.dispose(); }
});

test('Anthropic before-send compaction runs one tool-free summary and retains native recent tool history', async () => {
  const f = await fixture();
  try {
    for (const input of ['Original goal', 'Second goal', 'Recent goal [read]']) assert.equal((await f.executor.send(f.id, input)).success, true);
    const before = await f.readLedger(), last = f.calls.at(-1)!, input = 'Continue automatically';
    const pending = { ...before.context!, items: [...before.context!.items, ...createNativeModel(last.model).userItems(input)] };
    const estimate = estimateNativeInputTokens(pending, last.model.instructions, last.model.toolDefinitions);
    const config = structuredClone(f.store.state.sessions.find(item => item.id === f.id)!.engineConfig);
    config.options.autoCompact = 'before_send'; config.options.maxInputTokens = Math.floor(estimate / 0.95);
    await f.executor.updateConfig(f.id, config);
    const start = f.server.requests.length;
    const result = await f.executor.send(f.id, input); assert.equal(result.success, true, JSON.stringify(result));
    const summaries = f.calls.filter(call => call.request.configuration.purpose === 'context_summary');
    assert.equal(summaries.length, 1); assert.equal(summaries[0].model.protocol, 'anthropic');
    assert.deepEqual(summaries[0].tools.definitions, []); assert.deepEqual(summaries[0].model.toolDefinitions, []);
    assert.equal(f.server.requests.length, start + 2);
    assert.equal(f.server.requests[start].tools, undefined); assert.ok(f.server.requests[start + 1].tools.length > 0);
    assert.equal(f.server.requests[start + 1].messages.at(-1).content[0].text, input);
    assert.ok(f.server.requests[start + 1].messages.some((item: Message) => item.content.some(block => block.type === 'tool_result')));
    const after = await f.readLedger(); requireCompleteContext(after.context!);
    assert.ok(after.compaction?.automaticRequestId); assert.deepEqual(after.context!.protocol, before.context!.protocol);
    assert.deepEqual(after.records.slice(0, before.records.length), before.records);
    assertTransport(f.server);
    assert.equal(JSON.stringify(after).includes(secret), false);
  } finally { await f.dispose(); }
});
