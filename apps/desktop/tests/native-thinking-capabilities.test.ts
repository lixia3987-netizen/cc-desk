import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { runAgent } from '@cc-desk/agent-core';
import { NativeRunStore } from '@cc-desk/agent-node/run-store';
import { createNativeModel, estimateNativeInputTokens } from '@cc-desk/agent-node/native-model';
import { requireCompleteContext } from '@cc-desk/agent-node/context-maintenance';
import { StateStore } from '../src/main/store';
import { ExecutionEvents } from '../src/main/execution/events';
import { ConnectionStore } from '../src/main/engines/native/connections';
import { createNativeConfig } from '../src/main/engines/native/config';
import { NativeConnectionModelCatalog } from '../src/main/engines/native/connection-models';
import { NativeModelCapabilityService } from '../src/main/engines/native/model-capabilities';
import { NativeStructuredExecutor, type NativeExecutorOptions } from '../src/main/engines/native/structured-executor';
// @ts-expect-error Local test-only ESM fixture has no declarations.
import { startAnthropicFixture } from '../../../packages/agent-node/tests/fixtures/anthropic-server.mjs';

type Worker = NonNullable<NativeExecutorOptions['worker']>;
type Block = { type: string; text?: string; thinking?: string; signature?: string; data?: string; id?: string; tool_use_id?: string; content?: string };
type Message = { role: string; content: Block[] };
const secret = 'thinking-runtime-fixture-main-only-key';
const unsigned = { type: 'thinking', thinking: 'fixture-private-unsigned-thinking 中文🙂' };
const redacted = { type: 'redacted_thinking', data: 'fixture-opaque-redacted-data' };
const signed = { type: 'thinking', thinking: 'fixture-private-signed-thinking', signature: 'fixture-preserved-signature' };
const summary = '原始目标是只读检查 fixture.txt，工具已经读取本地内容；保留原始约束与最近回合，没有修改项目文件。';
const inlineWorker: Worker = options => runAgent({ ...options.request, signal: options.signal }, {
  model: createNativeModel(options.model), tools: options.tools, store: options.store, approvals: options.approvals,
  host: { now: Date.now, digest: value => createHash('sha256').update(value).digest('hex'), emit: options.onEvent,
    deadline: (duration, parent) => {
      const controller = new AbortController(), abort = () => controller.abort(), timer = setTimeout(abort, duration);
      parent.addEventListener('abort', abort, { once: true }); if (parent.aborted) abort();
      return { signal: controller.signal, dispose: () => { clearTimeout(timer); parent.removeEventListener('abort', abort); } };
    },
  },
});

async function fixture(metadata?: { context_window: number; max_input_tokens: number; max_output_tokens: number }) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ccdesk-thinking-runtime-'));
  const data = path.join(directory, 'data'), project = path.join(directory, 'project');
  await fs.mkdir(project); await fs.writeFile(path.join(project, 'fixture.txt'), 'local thinking fixture file content');
  const server = await startAnthropicFixture({ handler: ({ body, index }: { body: { messages: Message[]; tools?: unknown[] }; index: number }) => {
    if (!body.tools?.length) return { content: [signed, redacted, { type: 'text', text: summary }], splitBytes: 7 };
    const last = body.messages.at(-1)!;
    if (last.role === 'user' && last.content.some(block => block.type === 'text' && block.text?.includes('[read]'))) {
      return { content: [unsigned, redacted, { type: 'text', text: '先读取项目文件。' },
        { type: 'tool_use', id: `toolu-thinking-read-${index}`, name: 'read_file', input: { path: 'fixture.txt' } }], splitBytes: 7 };
    }
    return { content: [signed, { type: 'text', text: '本地检查已完成。' + 'Historical verified local details. '.repeat(100) }], splitBytes: 7 };
  } });
  const metadataRequests: string[] = [], gatewayErrors: unknown[] = [];
  const gateway = metadata ? createServer(async (request, response) => {
    try {
      if (request.method === 'GET') {
        metadataRequests.push(request.url!);
        assert.equal(request.url, '/v1/models/fixture-thinking-model');
        assert.equal(request.headers.authorization, `Bearer ${secret}`);
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ id: 'fixture-thinking-model', ...metadata })); return;
      }
      assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/messages');
      const chunks = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const upstream = await fetch(server.baseURL + '/v1/messages', { method: 'POST', body: Buffer.concat(chunks), headers: {
        'Content-Type': 'application/json', 'anthropic-version': request.headers['anthropic-version'] as string, authorization: request.headers.authorization!,
      } });
      response.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('Content-Type')! }); response.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (error) { gatewayErrors.push(error); response.writeHead(500); response.end('local fixture failed'); }
  }) : undefined;
  if (gateway) { gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening'); }
  const baseURL = gateway ? `http://127.0.0.1:${(gateway.address() as AddressInfo).port}` : server.baseURL;
  let store = new StateStore(data), connections = new ConnectionStore(data, { environment: { THINKING_FIXTURE_KEY: secret } });
  const connection = connections.upsert({ name: 'local thinking fixture', protocol: 'anthropic', authHeader: 'authorization',
    baseURL, model: 'fixture-thinking-model', enabled: true, allowLoopbackHttp: true, auth: { mode: 'env', variable: 'THINKING_FIXTURE_KEY' } });
  const id = randomUUID(), conversationId = randomUUID(), projectId = randomUUID(), now = new Date().toISOString();
  store.change(state => {
    state.projects.push({ id: projectId, path: project, name: 'local fixture', createdAt: now });
    state.sessions.push({ id, projectId, title: 'Thinking continuity', kind: 'agent', cwd: project,
      execution: { providerId: 'native', mode: 'structured', conversationId },
      engineConfig: createNativeConfig({ schemaVersion: 1, options: { connectionId: connection.id } }),
      started: false, status: 'idle', archived: false, createdAt: now, updatedAt: now });
  });
  const workers: Parameters<Worker>[0][] = [], worker: Worker = value => { workers.push(value); return inlineWorker(value); };
  const events = new ExecutionEvents();
  let service = metadata ? new NativeModelCapabilityService(connections, new NativeConnectionModelCatalog(connections)) : undefined;
  let executor = new NativeStructuredExecutor(store, connections, events, { modelCapabilities: service, worker }); await executor.initialize();
  const ledger = async () => {
    const saved = await NativeRunStore.open({ rootDirectory: path.join(data, 'native', 'conversations'), conversationId });
    try { return { context: saved.loadContext(), records: saved.replay(), compaction: saved.getLastCompaction() }; }
    finally { await saved.close(); }
  };
  return { id, connection, server, workers, data, project, ledger, metadataRequests, gatewayErrors,
    get store() { return store; }, get executor() { return executor; },
    async restart() {
      await executor.shutdown(); await service?.shutdown(); store.flush(); store = new StateStore(data);
      connections = new ConnectionStore(data, { environment: { THINKING_FIXTURE_KEY: secret } });
      service = metadata ? new NativeModelCapabilityService(connections, new NativeConnectionModelCatalog(connections)) : undefined;
      executor = new NativeStructuredExecutor(store, connections, events, { modelCapabilities: service, worker }); await executor.initialize();
    },
    async dispose() {
      await executor.shutdown(); await service?.shutdown();
      if (gateway) { gateway.closeAllConnections(); await new Promise<void>(resolve => gateway.close(() => resolve())); }
      await server.close(); store.flush(); await fs.rm(directory, { recursive: true, force: true });
    },
  };
}

test('unsigned thinking and redacted blocks persist through a real tool loop, restart and text-only compaction projection', async () => {
  const f = await fixture();
  try {
    const first = await f.executor.send(f.id, 'Original goal: inspect only [read]');
    assert.equal(first.success, true, JSON.stringify(first)); assert.equal(f.server.requests.length, 2);
    const original = await f.ledger(); requireCompleteContext(original.context!);
    const items = original.context!.items as unknown as Message[];
    assert.deepEqual(items[1].content.slice(0, 2), [unsigned, redacted]);
    assert.equal(Object.hasOwn(items[1].content[0], 'signature'), false, 'missing provider signatures are preserved as missing');
    assert.deepEqual(f.server.requests[1].messages, items.slice(0, -1));
    const call = items[1].content.find(block => block.type === 'tool_use')!, result = items[2].content[0];
    assert.equal(result.type, 'tool_result'); assert.equal(result.tool_use_id, call.id);
    assert.match(result.content!, /local thinking fixture file content/);
    assert.equal(await fs.readFile(path.join(f.project, 'fixture.txt'), 'utf8'), 'local thinking fixture file content');
    for (const hidden of [unsigned.thinking, signed.thinking, signed.signature, redacted.data]) {
      assert.equal(JSON.stringify(f.executor.snapshot(f.id)).includes(hidden), false, 'private native blocks are not visible chat messages');
    }
    await f.restart(); assert.deepEqual((await f.ledger()).context, original.context);
    const second = await f.executor.send(f.id, 'Second explicit task after restart'); assert.equal(second.success, true, JSON.stringify(second));
    assert.deepEqual(f.server.requests[2].messages.slice(0, items.length), items);
    const before = await f.ledger();
    await f.executor.compactContext(f.id, f.executor.snapshot(f.id).nativeContextMaintenance!.headHash);
    const summarizer = f.workers.find(value => value.request.configuration.purpose === 'context_summary')!;
    assert.ok(summarizer); assert.deepEqual(summarizer.tools.definitions, []); assert.deepEqual(summarizer.model.toolDefinitions, []);
    const request = f.server.requests.at(-1), history = JSON.parse(request.messages[0].content[0].text).history;
    assert.equal(history.items.some((item: Message) => item.content.some(block => ['thinking', 'redacted_thinking'].includes(block.type))), false, 'isolated summary input omits private blocks');
    assert.ok(history.items.some((item: Message) => item.content.some(block => block.type === 'tool_result')));
    assert.equal(request.tools, undefined); assert.equal(request.tool_choice, undefined);
    const compacted = await f.ledger(); requireCompleteContext(compacted.context!);
    assert.ok(compacted.compaction); assert.deepEqual(compacted.records.slice(0, before.records.length), before.records);
    assert.deepEqual((compacted.context!.items[1] as unknown as Message).content.map(block => block.type), ['text']);
    assert.match((compacted.context!.items[1] as unknown as Message).content[0].text!, /原始目标/);
    assert.ok((compacted.context!.items as unknown as Message[]).some(item => item.content.some(block => block.signature === signed.signature)), 'recent signed history remains native');
    await f.restart(); assert.deepEqual((await f.ledger()).context, compacted.context);
    const continued = await f.executor.send(f.id, 'Continue after compaction'); assert.equal(continued.success, true, JSON.stringify(continued));
    assert.deepEqual(f.server.requests.at(-1).messages.slice(0, compacted.context!.items.length), compacted.context!.items);
    assert.deepEqual(f.server.errors, []);
    for (const headers of f.server.requestHeaders) { assert.equal(headers.authorization, `Bearer ${secret}`); assert.equal(headers['x-api-key'], undefined); }
    assert.equal(JSON.stringify(await f.ledger()).includes(secret), false);
    assert.equal((await fs.readFile(path.join(f.data, 'native', 'connections.json'), 'utf8')).includes(secret), false);
  } finally { await f.dispose(); }
});

test('provider limits cap real request output and persist effective budgets without raising or replacing user configuration', async () => {
  const f = await fixture({ context_window: 40000, max_input_tokens: 38000, max_output_tokens: 1024 });
  try {
    assert.equal(f.metadataRequests.length, 0); assert.equal(f.server.requests.length, 0);
    const initialOptions = structuredClone(f.store.state.sessions.find(item => item.id === f.id)!.engineConfig.options);
    const result = await f.executor.send(f.id, 'Inspect without tools'); assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(f.metadataRequests.length, 1); assert.equal(f.server.requests[0].max_tokens, 1024);
    const worker = f.workers[0]; assert.equal(worker.request.budget?.maxInputTokens, 38000); assert.equal(worker.request.budget?.maxOutputTokens, 1024);
    assert.deepEqual(worker.request.configuration.sessionOptions, initialOptions);
    assert.deepEqual(worker.request.configuration.effectiveBudget, { maxInputTokens: 38000, maxOutputTokens: 1024 });
    assert.deepEqual(f.store.state.sessions.find(item => item.id === f.id)!.engineConfig.options, initialOptions);
    const before = await f.ledger(), input = 'Second task with a lower explicit budget';
    const pending = { ...before.context!, items: [...before.context!.items, ...createNativeModel(worker.model).userItems(input)] };
    const inputBudget = estimateNativeInputTokens(pending, worker.model.instructions, worker.model.toolDefinitions) + 500;
    assert.ok(inputBudget < 38000, 'fixture must fit within a smaller explicit user limit');
    const config = createNativeConfig({ schemaVersion: 1, options: { connectionId: f.connection.id, maxInputTokens: inputBudget, maxOutputTokens: 128 } });
    await f.executor.updateConfig(f.id, config);
    const next = await f.executor.send(f.id, input); assert.equal(next.success, true, JSON.stringify(next));
    assert.equal(f.workers[1].request.budget?.maxInputTokens, inputBudget); assert.equal(f.server.requests[1].max_tokens, 128);
    assert.deepEqual(f.store.state.sessions.find(item => item.id === f.id)!.engineConfig, config);
    await f.executor.compactContext(f.id, f.executor.snapshot(f.id).nativeContextMaintenance!.headHash);
    const summaryWorker = f.workers[2]; assert.equal(summaryWorker.request.configuration.purpose, 'context_summary');
    assert.equal(summaryWorker.request.budget?.maxOutputTokens, 128); assert.equal(f.server.requests[2].max_tokens, 128);
    const context = f.executor.snapshot(f.id).context!;
    assert.equal(context.contextWindow, 40000); assert.equal(context.budget!.maxInputTokens, inputBudget);
    assert.deepEqual(context.modelCapabilities!.capabilities.maxOutputTokens, { value: 1024, source: 'provider' });
    await f.restart(); assert.deepEqual(f.executor.snapshot(f.id).context, context);
    assert.deepEqual(f.store.state.sessions.find(item => item.id === f.id)!.engineConfig, config);
    assert.deepEqual(f.gatewayErrors, []); assert.deepEqual(f.server.errors, []);
    assert.equal(JSON.stringify(await f.ledger()).includes(secret), false);
  } finally { await f.dispose(); }
});

test('context-window output reserve blocks generation for oversized input and cannot be bypassed by enabling compaction', async () => {
  const f = await fixture({ context_window: 48000, max_input_tokens: 48000, max_output_tokens: 4096 });
  try {
    const first = await f.executor.send(f.id, 'Small original goal'); assert.equal(first.success, true, JSON.stringify(first));
    const initial = structuredClone(f.store.state.sessions.find(item => item.id === f.id)!.engineConfig), worker = f.workers[0], saved = (await f.ledger()).context!;
    const adapter = createNativeModel(worker.model), empty = { ...saved, items: [...saved.items, ...adapter.userItems('')] };
    const emptyEstimate = estimateNativeInputTokens(empty, worker.model.instructions, worker.model.toolDefinitions);
    assert.ok(emptyEstimate < 47900); const input = 'a'.repeat(47900 - emptyEstimate);
    const pending = { ...saved, items: [...saved.items, ...adapter.userItems(input)] };
    assert.equal(estimateNativeInputTokens(pending, worker.model.instructions, worker.model.toolDefinitions), 47900);
    assert.ok(estimateNativeInputTokens({ protocol: saved.protocol, items: adapter.userItems(input) }, worker.model.instructions, worker.model.toolDefinitions) > 48000 - 4096, 'new input alone cannot fit after output reserve');
    assert.equal(worker.request.budget?.maxInputTokens, 48000 - 4096, 'the effective input limit reserves actual output space');
    const result = await f.executor.send(f.id, input); assert.equal(result.success, false);
    assert.match(result.error!, /预算|上限|窗口/); assert.equal(f.metadataRequests.length, 1);
    assert.equal(f.server.requests.length, 1); assert.equal(f.workers.length, 2);
    assert.equal(f.workers[1].request.budget?.maxInputTokens, 48000 - 4096, 'core receives the reduced reserve budget before it can call the model');
    const config = createNativeConfig({ ...initial, options: { ...initial.options, autoCompact: 'before_send' } });
    await f.executor.updateConfig(f.id, config); const automatic = await f.executor.send(f.id, input);
    assert.equal(automatic.success, false); assert.equal(f.server.requests.length, 1); assert.equal(f.workers.length, 2);
    assert.deepEqual(f.store.state.sessions.find(item => item.id === f.id)!.engineConfig, config);
    assert.deepEqual(f.gatewayErrors, []); assert.deepEqual(f.server.errors, []);
  } finally { await f.dispose(); }
});
