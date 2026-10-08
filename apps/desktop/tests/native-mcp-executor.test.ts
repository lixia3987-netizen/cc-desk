import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { runAgent } from '@cc-desk/agent-core';
import { NativeRunStore } from '@cc-desk/agent-node/run-store';
import { ResponsesModel } from '@cc-desk/agent-node/responses-model';
import { StateStore } from '../src/main/store';
import { ExecutionEvents } from '../src/main/execution/events';
import { ConnectionStore } from '../src/main/engines/native/connections';
import { NativeCredentialStore } from '../src/main/engines/native/credentials';
import { NativeMcpConnectionStore } from '../src/main/engines/native/mcp-connections';
import { NativeStructuredExecutor, type NativeExecutorOptions } from '../src/main/engines/native/structured-executor';
import { createNativeConfig } from '../src/main/engines/native/config';
// Both model and MCP requests terminate on real local HTTP fixtures.
// @ts-expect-error Local test-only ESM fixture has no declarations.
import { startResponsesFixture, assistantMessage, functionCall } from '../../../packages/agent-node/tests/fixtures/responses-server.mjs';
// @ts-expect-error Shared test-only ESM fixture has no declarations.
import { listenOnFetchLoopback } from '../../../packages/agent-node/tests/fixtures/fetch-loopback.mjs';

type Worker = NonNullable<NativeExecutorOptions['worker']>;
type Body = { input: Array<Record<string, unknown>>; tools: Array<{ name: string; description: string }> };
type Handler = (request: { body: Body; index: number }) => { output: unknown[] };
type McpTool = { name: string; description: string; inputSchema: Record<string, unknown> };
type RpcRequest = { jsonrpc: string; id: number | string; method: string; params?: Record<string, unknown> };
const modelSecret = 'sk-native-mcp-model-fixture';
const mcpSecret = 'native-mcp-credential-fixture';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const inlineWorker: Worker = options => runAgent({ ...options.request, signal: options.signal }, {
  model: new ResponsesModel(options.model), tools: options.tools, store: options.store, approvals: options.approvals,
  host: { now: Date.now, digest: hash, emit: options.onEvent,
    deadline: (timeout, parent) => {
      const controller = new AbortController(), abort = () => controller.abort();
      const timer = setTimeout(abort, timeout); parent.addEventListener('abort', abort, { once: true });
      if (parent.aborted) abort();
      return { signal: controller.signal, dispose: () => { clearTimeout(timer); parent.removeEventListener('abort', abort); } };
    },
  },
});

async function startMcpFixture(expectedArguments: Record<string, unknown> = { note: 'approved fixture note' }) {
  const requests: RpcRequest[] = [], errors: unknown[] = [], sockets = new Set<Socket>();
  const tool: McpTool = { name: 'record_note', description: 'Record the explicitly approved note.', inputSchema: {
    type: 'object', properties: { note: { type: 'string' } }, required: ['note'], additionalProperties: false,
  } };
  let disconnectCall = false;
  const server = http.createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST'); assert.equal(request.url, '/mcp');
      assert.equal(request.headers.authorization, `Bearer ${mcpSecret}`);
      assert.equal(request.headers['mcp-protocol-version'], '2026-07-28');
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length; assert.ok(bytes <= 1024 * 1024); chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as RpcRequest;
      requests.push(body); assert.equal(body.jsonrpc, '2.0');
      let result: Record<string, unknown>;
      switch (body.method) {
        case 'server/discover': result = { resultType: 'complete', supportedVersions: ['2026-07-28'],
          capabilities: { tools: {} }, _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'local-mcp-fixture', version: '1.0.0' } } }; break;
        case 'tools/list': result = { resultType: 'complete', tools: [structuredClone(tool)] }; break;
        case 'tools/call':
          assert.equal(body.params?.name, tool.name);
          assert.deepEqual(body.params?.arguments, expectedArguments);
          if (disconnectCall) { response.destroy(); return; }
          result = { resultType: 'complete', content: [{ type: 'text', text: 'Recorded the approved note.' }] }; break;
        default: throw new Error(`Unexpected MCP method: ${body.method}`);
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
    } catch (error) {
      errors.push(error);
      if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end('{"error":"local MCP fixture assertion failed"}');
    }
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await listenOnFetchLoopback(server);
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, requests, errors, tool,
    count: (method: string) => requests.filter(request => request.method === method).length,
    disconnectNextCall() { disconnectCall = true; },
    async close() { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); },
  };
}

const modelHandler: Handler = ({ body }) => {
  const turn = body.input.filter(item => item.role === 'user').length;
  const callId = `turn-${turn}-mcp`;
  const result = body.input.find(item => item.type === 'function_call_output' && item.call_id === callId);
  if (result) return { output: [assistantMessage(`done-${turn}`, `MCP result: ${JSON.parse(String(result.output)).status}`)] };
  const tool = body.tools.find(item => item.name.startsWith('mcp_'));
  return { output: tool ? [functionCall(callId, tool.name, { note: 'approved fixture note' })] : [assistantMessage(`done-${turn}`, 'No MCP server selected.')] };
};

async function fixture(options: { handler?: Handler; worker?: Worker; mcpArguments?: Record<string, unknown> } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-mcp-executor-'));
  const data = path.join(directory, 'data'), project = path.join(directory, 'project');
  await fs.mkdir(project); await fs.writeFile(path.join(project, 'AGENTS.md'), 'Only perform approved operations.\n');
  const server = await startResponsesFixture({ handler: options.handler ?? modelHandler });
  const mcp = await startMcpFixture(options.mcpArguments), mcps = [mcp];
  let store = new StateStore(data), connections = new ConnectionStore(data);
  const modelConnection = connections.upsert({ name: 'local', protocol: 'responses', baseURL: server.baseURL, model: 'mcp-fixture', allowLoopbackHttp: true, enabled: true, auth: { mode: 'memory' } });
  connections.setCredential({ id: modelConnection.id, revision: modelConnection.revision, mode: 'memory', secret: modelSecret });
  let executor: NativeStructuredExecutor;
  const makeMcpConnections = () => new NativeMcpConnectionStore(data, new NativeCredentialStore(), {
    isConnectionActive: (id: string) => Boolean(executor?.isMcpConnectionActive(id)),
  });
  let mcpConnections = makeMcpConnections();
  const addMcp = (service: Awaited<ReturnType<typeof startMcpFixture>>, name = 'local MCP') => {
    const connection = mcpConnections.upsert({ name, endpoint: service.url,
      allowLoopbackHttp: true, enabled: true, auth: { mode: 'memory' } });
    return mcpConnections.setCredential({ id: connection.id, revision: connection.revision, mode: 'memory', secret: mcpSecret });
  };
  const mcpConnection = addMcp(mcp);
  const id = randomUUID(), conversationId = randomUUID(), projectId = randomUUID();
  store.change(state => {
    state.projects.push({ id: projectId, path: project, name: 'project', createdAt: new Date().toISOString() });
    state.sessions.push({ id, projectId, title: 'MCP fixture', kind: 'agent', cwd: project,
      execution: { providerId: 'native', mode: 'structured', conversationId },
      engineConfig: createNativeConfig({ schemaVersion: 1, options: { connectionId: modelConnection.id } }),
      started: false, status: 'idle', archived: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  });
  const events = new ExecutionEvents();
  executor = new NativeStructuredExecutor(store, connections, events, { worker: options.worker ?? inlineWorker, mcpConnections });
  await executor.initialize();
  return { data, project, id, conversationId, server, mcp, mcpConnection,
    get store() { return store; }, get executor() { return executor; }, get mcpConnections() { return mcpConnections; },
    async addMcp() { const service = await startMcpFixture(); mcps.push(service); return { service, connection: addMcp(service, 'second local MCP') }; },
    async configure(selection: string[], options: Record<string, unknown> = {}) {
      const config = structuredClone(store.state.sessions.find(item => item.id === id)!.engineConfig);
      config.options = { ...config.options, ...options, mcpConnections: selection }; await executor.updateConfig(id, config);
    },
    async ledger() {
      const ledger = await NativeRunStore.open({ rootDirectory: path.join(data, 'native', 'conversations'), conversationId });
      try { return { runs: ledger.listRuns(), records: ledger.replay(), context: ledger.loadContext() }; }
      finally { await ledger.close(); }
    },
    async restart(withCredentials = true) {
      await executor.shutdown(); store = new StateStore(data); connections = new ConnectionStore(data); mcpConnections = makeMcpConnections();
      if (withCredentials) {
        const model = connections.list().connections.find(item => item.id === modelConnection.id)!;
        connections.setCredential({ id: model.id, revision: model.revision, mode: 'memory', secret: modelSecret });
        for (const connection of mcpConnections.list().connections) mcpConnections.setCredential({ id: connection.id, revision: connection.revision, mode: 'memory', secret: mcpSecret });
      }
      executor = new NativeStructuredExecutor(store, connections, events, { worker: options.worker ?? inlineWorker, mcpConnections });
      await executor.initialize();
    },
    approval() {
      const current = executor.attention()[0]; if (current) return Promise.resolve(current);
      return new Promise<ReturnType<NativeStructuredExecutor['attention']>[number]>((resolve, reject) => {
        const timer = setTimeout(() => { off(); reject(new Error('Expected MCP approval within 10 seconds.')); }, 10_000);
        const off = events.subscribe(() => {
          const pending = executor.attention()[0];
          if (pending) { clearTimeout(timer); off(); resolve(pending); }
        });
      });
    },
    async dispose() { await executor.shutdown().catch(() => {}); await server.close(); for (const service of mcps) await service.close(); store.flush(); await fs.rm(directory, { recursive: true, force: true }); },
  };
}

test('MCP is opt-in; an approved call executes once and full context survives restart and continuation', async () => {
  const f = await fixture(); let pending: ReturnType<NativeStructuredExecutor['send']> | undefined;
  try {
    assert.deepEqual(f.store.state.sessions.find(item => item.id === f.id)!.engineConfig.options.mcpConnections, []);
    const unselected = await f.executor.send(f.id, 'no selection');
    assert.equal(unselected.success, true, JSON.stringify(unselected));
    assert.equal(f.mcp.requests.length, 0); assert.ok(f.server.requests[0].tools.every((tool: { name: string }) => !tool.name.startsWith('mcp_')));
    await f.configure([f.mcpConnection.id]);
    pending = f.executor.send(f.id, 'record note', [], undefined, { requestId: 'mcp-approved' });
    const approval = await f.approval();
    assert.equal(f.mcp.count('tools/call'), 0, 'catalog discovery grants no tool execution');
    assert.match(approval.toolName, /^mcp_/);
    assert.deepEqual(f.executor.snapshot(f.id).pending[0].input.arguments, { note: 'approved fixture note' });
    const pendingText = JSON.stringify(f.executor.snapshot(f.id).pending);
    assert.equal(pendingText.includes(modelSecret), false); assert.equal(pendingText.includes(mcpSecret), false);
    f.executor.respond(f.id, approval.requestId, { behavior: 'allow' });
    const result = await pending;
    assert.equal(result.success, true, JSON.stringify(result)); assert.match(result.summary, /completed/);
    assert.equal(f.mcp.count('tools/call'), 1);
    const before = await f.ledger();
    assert.equal(JSON.stringify(before.records).includes(modelSecret), false); assert.equal(JSON.stringify(before.records).includes(mcpSecret), false);
    const callsBefore = f.mcp.requests.length, modelBefore = f.server.requests.length;
    await f.restart(false);
    const duplicate = await f.executor.send(f.id, 'record note', [], undefined, { requestId: 'mcp-approved' });
    assert.equal(duplicate.success, true, JSON.stringify(duplicate));
    assert.equal(f.mcp.requests.length, callsBefore); assert.equal(f.server.requests.length, modelBefore);
    assert.deepEqual(await f.ledger(), before, 'receipt replay never resolves credentials, discovers or calls MCP');
    await f.restart();
    pending = f.executor.send(f.id, 'continue with another approved note', [], undefined, { requestId: 'mcp-continuation' });
    const continuedApproval = await f.approval();
    f.executor.respond(f.id, continuedApproval.requestId, { behavior: 'allow' });
    assert.equal((await pending).success, true); assert.equal(f.mcp.count('tools/call'), 2);
    assert.deepEqual(f.server.requests[modelBefore].input.slice(0, before.context!.items.length), before.context!.items);
    assert.deepEqual(f.server.errors, []); assert.deepEqual(f.mcp.errors, []);
  } finally { await f.dispose(); await pending; }
});

test('MCP arguments named preconditions remain visible in approval and are dispatched unchanged', async () => {
  const input = { note: 'approved fixture note', preconditions: { target: 'production', confirmed: true } };
  const f = await fixture({ mcpArguments: input, handler: ({ body }) => {
    if (body.input.some(item => item.type === 'function_call_output')) return { output: [assistantMessage('done', 'Approved production argument preserved.')] };
    const tool = body.tools.find(item => item.name.startsWith('mcp_'))!;
    return { output: [functionCall('argument-collision', tool.name, input)] };
  } });
  let pending: ReturnType<NativeStructuredExecutor['send']> | undefined;
  try {
    f.mcp.tool.inputSchema = { type: 'object', properties: {
      note: { type: 'string' }, preconditions: { type: 'object', properties: { target: { type: 'string' }, confirmed: { type: 'boolean' } },
        required: ['target', 'confirmed'], additionalProperties: false },
    }, required: ['note', 'preconditions'], additionalProperties: false };
    await f.configure([f.mcpConnection.id]); pending = f.executor.send(f.id, 'approve the complete arguments');
    const approval = await f.approval(), displayed = f.executor.snapshot(f.id).pending[0].input;
    assert.deepEqual(displayed.arguments, input, 'approval keeps the remote preconditions parameter, including its target');
    assert.ok(displayed.preconditions); assert.notDeepEqual(displayed.preconditions, input.preconditions, 'host approval bindings have a separate container');
    assert.equal(f.mcp.count('tools/call'), 0);
    f.executor.respond(f.id, approval.requestId, { behavior: 'allow' });
    const result = await pending; assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(f.mcp.count('tools/call'), 1);
    assert.deepEqual(f.mcp.requests.find(request => request.method === 'tools/call')!.params!.arguments, input);
    const prepared = (await f.ledger()).records.find(record => record.event.type === 'tool_prepared');
    assert.ok(prepared?.event.type === 'tool_prepared'); assert.deepEqual(prepared.event.prepared.input, input);
    assert.deepEqual(f.mcp.errors, []); assert.deepEqual(f.server.errors, []);
  } finally { await f.dispose(); await pending; }
});

test('denied MCP approval persists a denied result and sends no remote tool call', async () => {
  const f = await fixture(); let pending: ReturnType<NativeStructuredExecutor['send']> | undefined;
  try {
    await f.configure([f.mcpConnection.id]); pending = f.executor.send(f.id, 'deny this note');
    const approval = await f.approval(); f.executor.respond(f.id, approval.requestId, { behavior: 'deny' });
    const result = await pending; assert.equal(result.success, true, JSON.stringify(result)); assert.match(result.summary, /denied/);
    assert.equal(f.mcp.count('tools/call'), 0); assert.equal(f.executor.attention().length, 0);
    const completed = (await f.ledger()).records.find(record => record.event.type === 'tool_completed');
    assert.ok(completed?.event.type === 'tool_completed'); assert.equal(completed.event.result.status, 'denied');
    assert.deepEqual(f.mcp.errors, []);
  } finally { await f.dispose(); await pending; }
});

test('active MCP selection and connection edits are rejected; an explicit next-turn replacement takes effect', async () => {
  const f = await fixture(); let pending: ReturnType<NativeStructuredExecutor['send']> | undefined;
  try {
    const second = await f.addMcp(); await f.configure([f.mcpConnection.id]);
    pending = f.executor.send(f.id, 'first server'); const approval = await f.approval();
    await assert.rejects(f.configure([second.connection.id]), /停止运行/);
    assert.throws(() => f.mcpConnections.setCredential({ id: f.mcpConnection.id, revision: f.mcpConnection.revision, mode: 'memory', secret: 'replacement-not-in-use' }), /运行|使用|占用/);
    f.executor.respond(f.id, approval.requestId, { behavior: 'allow' }); assert.equal((await pending).success, true);
    assert.equal(f.mcp.count('tools/call'), 1); assert.equal(second.service.requests.length, 0);
    const firstCount = f.mcp.requests.length;
    await f.configure([second.connection.id]);
    pending = f.executor.send(f.id, 'second server'); const nextApproval = await f.approval();
    assert.notEqual(nextApproval.toolName, approval.toolName, 'same remote name on different servers has distinct local identity');
    f.executor.respond(f.id, nextApproval.requestId, { behavior: 'allow' }); assert.equal((await pending).success, true);
    assert.equal(f.mcp.requests.length, firstCount); assert.equal(second.service.count('tools/call'), 1);
    assert.deepEqual(new StateStore(f.data).state.sessions.find(item => item.id === f.id)!.engineConfig.options.mcpConnections, [second.connection.id]);
    assert.deepEqual(f.mcp.errors, []); assert.deepEqual(second.service.errors, []);
  } finally { await f.dispose(); await pending; }
});

test('a catalog change while approval is pending invalidates the approved MCP operation before dispatch', async () => {
  const f = await fixture(); let pending: ReturnType<NativeStructuredExecutor['send']> | undefined;
  try {
    await f.configure([f.mcpConnection.id]); pending = f.executor.send(f.id, 'do not approve changed catalog');
    const approval = await f.approval(); f.mcp.tool.description = 'Catalog changed after the user saw the original request.';
    f.executor.respond(f.id, approval.requestId, { behavior: 'allow' }); await pending;
    assert.equal(f.mcp.count('tools/call'), 0); assert.equal(f.executor.recoveryRequired(f.id), false);
    const result = f.server.requests.at(-1).input.find((item: Record<string, unknown>) => item.type === 'function_call_output');
    assert.deepEqual(JSON.parse(result.output), { status: 'failed', output: { error: 'tool_preconditions_changed', executed: false } });
    assert.deepEqual(f.mcp.errors, []);
  } finally { await f.dispose(); await pending; }
});

test('a disconnected dispatched MCP call remains unknown and blocks retries across restart', async () => {
  const f = await fixture(); let pending: ReturnType<NativeStructuredExecutor['send']> | undefined;
  try {
    await f.configure([f.mcpConnection.id]); f.mcp.disconnectNextCall();
    pending = f.executor.send(f.id, 'uncertain note', [], undefined, { requestId: 'mcp-uncertain' });
    const approval = await f.approval(); f.executor.respond(f.id, approval.requestId, { behavior: 'allow' });
    const result = await pending; assert.equal(result.success, false); assert.equal(f.mcp.count('tools/call'), 1);
    assert.equal(f.executor.recoveryRequired(f.id), true); assert.equal(f.executor.snapshot(f.id).nativeRecovery?.tools.unknown, 1);
    const before = await f.ledger(), count = f.mcp.requests.length, modelCount = f.server.requests.length;
    await f.restart(false);
    for (const [input, requestId] of [['uncertain note', 'mcp-uncertain'], ['please retry', 'mcp-retry']]) {
      assert.equal((await f.executor.send(f.id, input, [], undefined, { requestId })).success, false);
    }
    assert.equal(f.executor.recoveryRequired(f.id), true); assert.equal(f.mcp.requests.length, count); assert.equal(f.server.requests.length, modelCount);
    assert.deepEqual(await f.ledger(), before); assert.deepEqual(f.mcp.errors, []);
  } finally { await f.dispose(); await pending; }
});

test('project instruction changes while MCP approval is pending invalidate dispatch', async () => {
  const f = await fixture(); let pending: ReturnType<NativeStructuredExecutor['send']> | undefined;
  try {
    await f.configure([f.mcpConnection.id]); pending = f.executor.send(f.id, 'use unchanged project instructions');
    const approval = await f.approval();
    await fs.writeFile(path.join(f.project, 'AGENTS.md'), 'Updated project policy: review the operation again.\n');
    f.executor.respond(f.id, approval.requestId, { behavior: 'allow' }); await pending;
    assert.equal(f.mcp.count('tools/call'), 0); assert.equal(f.executor.recoveryRequired(f.id), false);
    const result = f.server.requests.at(-1).input.find((item: Record<string, unknown>) => item.type === 'function_call_output');
    assert.deepEqual(JSON.parse(result.output), { status: 'failed', output: { error: 'tool_preconditions_changed', executed: false } });
    assert.deepEqual(f.mcp.errors, []);
  } finally { await f.dispose(); await pending; }
});

test('a catalog echoing the MCP credential is rejected before model, approval or durable run acceptance', async () => {
  const f = await fixture();
  try {
    await f.configure([f.mcpConnection.id]); f.mcp.tool.description = `Accidental credential echo: ${mcpSecret}`;
    const result = await f.executor.send(f.id, 'do not persist leaked catalog');
    assert.equal(result.success, false); assert.equal(f.server.requests.length, 0); assert.equal(f.mcp.count('tools/call'), 0);
    assert.deepEqual(f.executor.attention(), []); assert.equal((await f.ledger()).runs.length, 0);
    assert.equal(JSON.stringify(await f.ledger()).includes(mcpSecret), false);
    assert.equal(JSON.stringify(f.executor.snapshot(f.id)).includes(mcpSecret), false); assert.equal(JSON.stringify(result).includes(mcpSecret), false);
    assert.deepEqual(f.mcp.errors, []);
  } finally { await f.dispose(); }
});

test('MCP input schemas consume the input budget and block the model before its first request', async () => {
  const f = await fixture();
  try {
    await f.configure([f.mcpConnection.id], { maxInputTokens: 8192 });
    f.mcp.tool.inputSchema = { type: 'object', properties: { note: { type: 'string', description: 'large MCP schema '.repeat(600) } }, required: ['note'] };
    const result = await f.executor.send(f.id, 'record note');
    assert.equal(result.success, false); assert.equal(f.server.requests.length, 0); assert.equal(f.mcp.count('tools/call'), 0);
    assert.ok(f.mcp.count('tools/list') > 0, 'the selected schema was fetched before the budget was evaluated');
    assert.match(result.error!, /预算|上下文/); assert.equal(f.executor.recoveryRequired(f.id), false);
    assert.deepEqual(f.mcp.errors, []);
  } finally { await f.dispose(); }
});
