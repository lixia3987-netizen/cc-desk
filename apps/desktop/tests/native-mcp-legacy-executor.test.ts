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
// Real loopback fixtures exercise model serialization and the MCP transport together.
// @ts-expect-error Local test-only ESM fixture has no declarations.
import { startResponsesFixture, assistantMessage, functionCall } from '../../../packages/agent-node/tests/fixtures/responses-server.mjs';
// @ts-expect-error Shared test-only ESM fixture has no declarations.
import { listenOnFetchLoopback } from '../../../packages/agent-node/tests/fixtures/fetch-loopback.mjs';

type Worker = NonNullable<NativeExecutorOptions['worker']>;
type RpcRequest = { jsonrpc: string; id?: number | string; method: string; params?: Record<string, unknown> };
type RecordedRequest = { method: string; session?: string; body?: RpcRequest };
type FixtureOptions = {
  initializeFailure?: boolean;
  deleteMode?: 'normal' | 'unsupported' | 'hang';
  callMode?: 'normal' | 'hold' | 'not_found' | 'echo_session';
  catalogEcho?: boolean;
};
const protocolVersion = '2025-11-25' as const;
const modelSecret = 'sk-native-legacy-mcp-model-fixture';
const mcpSecret = 'native-legacy-mcp-credential-fixture';
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

async function startMcpFixture(options: FixtureOptions = {}) {
  const requests: RecordedRequest[] = [], errors: unknown[] = [], sessions: string[] = [], sockets = new Set<Socket>();
  const tool = { name: 'record_note', description: 'Record the explicitly approved note.', inputSchema: {
    type: 'object', properties: { note: { type: 'string' } }, required: ['note'], additionalProperties: false,
  } };
  const server = http.createServer(async (request, response) => {
    try {
      assert.equal(request.url, '/mcp');
      assert.equal(request.headers.authorization, `Bearer ${mcpSecret}`);
      const session = request.headers['mcp-session-id'] as string | undefined;
      if (request.method === 'DELETE') {
        assert.equal(request.headers['mcp-protocol-version'], protocolVersion);
        requests.push({ method: 'DELETE', session }); assert.ok(session && sessions.includes(session));
        if (options.deleteMode === 'hang') return;
        response.writeHead(options.deleteMode === 'unsupported' ? 405 : 204); response.end(); return;
      }
      assert.equal(request.method, 'POST');
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of request) { bytes += chunk.length; assert.ok(bytes <= 1024 * 1024); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as RpcRequest;
      requests.push({ method: body.method, session, body }); assert.equal(body.jsonrpc, '2.0');
      if (body.method === 'initialize') {
        assert.equal(request.headers['mcp-protocol-version'], undefined, 'the initialization body negotiates the selected version');
        assert.equal(session, undefined, 'a new run never resumes an old HTTP session');
        assert.equal(body.params?.protocolVersion, protocolVersion);
        assert.ok(body.params?.clientInfo); assert.deepEqual(body.params?.capabilities, {});
        if (options.initializeFailure) { response.writeHead(503); response.end(); return; }
        const next = `legacy-session-${randomUUID()}`; sessions.push(next);
        response.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': next });
        response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {
          protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'local-legacy-mcp-fixture', version: '1.0.0' },
        } })); return;
      }
      assert.equal(request.headers['mcp-protocol-version'], protocolVersion);
      assert.ok(session && sessions.includes(session), 'all initialized requests bind the returned session');
      if (body.method === 'notifications/initialized' || body.method === 'notifications/cancelled') {
        assert.equal(body.id, undefined);
        response.writeHead(202); response.end(); return;
      }
      let result: Record<string, unknown>;
      if (body.method === 'tools/list') {
        result = { tools: [{ ...structuredClone(tool), ...(options.catalogEcho ? { description: `Session echo: ${session}` } : {}) }] };
      } else if (body.method === 'tools/call') {
        assert.equal(body.params?.name, tool.name); assert.deepEqual(body.params?.arguments, { note: 'approved fixture note' });
        if (options.callMode === 'hold') return;
        if (options.callMode === 'not_found') { response.writeHead(404); response.end(); return; }
        result = { content: [{ type: 'text', text: options.callMode === 'echo_session' ? `Session echo: ${session}` : 'Recorded the approved note.' }] };
      } else throw new Error(`Unexpected MCP method: ${body.method}`);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
    } catch (error) {
      errors.push(error);
      if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end('{"error":"local legacy MCP fixture assertion failed"}');
    }
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await listenOnFetchLoopback(server);
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, requests, errors, sessions, tool, options,
    count: (method: string) => requests.filter(request => request.method === method).length,
    async waitFor(method: string) {
      const deadline = Date.now() + 5_000;
      while (!requests.some(request => request.method === method)) {
        if (Date.now() > deadline) throw new Error(`Expected ${method} within five seconds.`);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    },
    async close() { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); },
  };
}

async function fixture(options: FixtureOptions & { workerFailure?: boolean; modelReplay?: boolean } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-mcp-legacy-executor-'));
  const data = path.join(directory, 'data'), project = path.join(directory, 'project');
  await fs.mkdir(project); await fs.writeFile(path.join(project, 'AGENTS.md'), 'Only perform approved operations.\n');
  const server = await startResponsesFixture({ assertReplay: options.modelReplay, handler: ({ body }: { body: {
    input: Array<Record<string, unknown>>; tools: Array<{ name: string }>;
  } }) => {
    const turn = body.input.filter(item => item.role === 'user').length, callId = `turn-${turn}-legacy-mcp`;
    const result = body.input.find(item => item.type === 'function_call_output' && item.call_id === callId);
    if (result) return { output: [assistantMessage(`done-${turn}`, `MCP result: ${JSON.parse(String(result.output)).status}`)] };
    return { output: [functionCall(callId, body.tools.find(item => item.name.startsWith('mcp_'))!.name, { note: 'approved fixture note' })] };
  } });
  const mcp = await startMcpFixture(options), mcps = [mcp];
  const store = new StateStore(data), connections = new ConnectionStore(data);
  const model = connections.upsert({ name: 'local', protocol: 'responses', baseURL: server.baseURL,
    model: 'legacy-mcp-fixture', allowLoopbackHttp: true, enabled: true, auth: { mode: 'memory' } });
  connections.setCredential({ id: model.id, revision: model.revision, mode: 'memory', secret: modelSecret });
  let executor: NativeStructuredExecutor;
  const mcpConnections = new NativeMcpConnectionStore(data, new NativeCredentialStore(), {
    isConnectionActive: id => Boolean(executor?.isMcpConnectionActive(id)),
  });
  const addConnection = (service: Awaited<ReturnType<typeof startMcpFixture>>) => {
    const connection = mcpConnections.upsert({ name: 'local legacy MCP', endpoint: service.url, protocolVersion,
      allowLoopbackHttp: true, enabled: true, auth: { mode: 'memory' } });
    return mcpConnections.setCredential({ id: connection.id, revision: connection.revision, mode: 'memory', secret: mcpSecret });
  };
  const mcpConnection = addConnection(mcp), projectId = randomUUID();
  store.change(state => { state.projects.push({ id: projectId, path: project, name: 'project', createdAt: new Date().toISOString() }); });
  const addSession = () => {
    const id = randomUUID(), conversationId = randomUUID();
    store.change(state => { state.sessions.push({ id, projectId, title: 'Legacy MCP fixture', kind: 'agent', cwd: project,
      execution: { providerId: 'native', mode: 'structured', conversationId },
      engineConfig: createNativeConfig({ schemaVersion: 1, options: { connectionId: model.id, mcpConnections: [mcpConnection.id] } }),
      started: false, status: 'idle', archived: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }); });
    return { id, conversationId };
  };
  const { id, conversationId } = addSession(), events = new ExecutionEvents(), workerPayloads: unknown[] = [];
  executor = new NativeStructuredExecutor(store, connections, events, { mcpConnections, worker: workerOptions => {
    workerPayloads.push(structuredClone({ request: workerOptions.request, model: workerOptions.model, definitions: workerOptions.tools.definitions }));
    if (options.workerFailure) return Promise.reject(new Error('Local worker failed before the first model request.'));
    return inlineWorker(workerOptions);
  } });
  await executor.initialize();
  return { data, project, id, conversationId, server, mcp, mcpConnection, store, executor, mcpConnections, workerPayloads, addSession,
    async addMcp(extraOptions: FixtureOptions = {}) { const service = await startMcpFixture(extraOptions); mcps.push(service); return { service, connection: addConnection(service) }; },
    async configure(selection: string[]) {
      const config = structuredClone(store.state.sessions.find(item => item.id === id)!.engineConfig);
      config.options = { ...config.options, mcpConnections: selection }; await executor.updateConfig(id, config);
    },
    async ledger() {
      const ledger = await NativeRunStore.open({ rootDirectory: path.join(data, 'native', 'conversations'), conversationId });
      try { return { runs: ledger.listRuns(), records: ledger.replay(), context: ledger.loadContext() }; }
      finally { await ledger.close(); }
    },
    approval() {
      const current = executor.attention()[0]; if (current) return Promise.resolve(current);
      return new Promise<ReturnType<NativeStructuredExecutor['attention']>[number]>((resolve, reject) => {
        const timer = setTimeout(() => { off(); reject(new Error('Expected MCP approval within ten seconds.')); }, 10_000);
        const off = events.subscribe(() => {
          const pending = executor.attention()[0];
          if (pending) { clearTimeout(timer); off(); resolve(pending); }
        });
      });
    },
    async dispose() {
      executor.interrupt(id);
      await server.close(); for (const service of mcps) await service.close();
      await executor.shutdown().catch(() => {}); store.flush(); await fs.rm(directory, { recursive: true, force: true });
    },
  };
}

function assertNoSessionEcho(f: Awaited<ReturnType<typeof fixture>>, ...values: unknown[]) {
  const text = JSON.stringify(values);
  for (const secret of [...f.mcp.sessions, mcpSecret]) assert.equal(text.includes(secret), false, 'MCP transport material must stay out of model, worker and persisted data');
}

test('legacy MCP initializes once per run, reuses its session through approval, then deletes and starts fresh on the next run', async () => {
  const f = await fixture(); let pending: ReturnType<NativeStructuredExecutor['send']> | undefined;
  try {
    for (let turn = 1; turn <= 2; turn++) {
      pending = f.executor.send(f.id, `approved turn ${turn}`, [], undefined, { requestId: `legacy-approved-${turn}` });
      const approval = await f.approval(); assert.equal(f.mcp.count('initialize'), turn);
      assert.equal(f.mcp.count('notifications/initialized'), turn); assert.equal(f.mcp.count('tools/call'), turn - 1);
      assertNoSessionEcho(f, approval, f.executor.snapshot(f.id));
      f.executor.respond(f.id, approval.requestId, { behavior: 'allow' });
      const result = await pending; assert.equal(result.success, true, JSON.stringify(result)); assert.match(result.summary, /completed/);
      assert.equal(f.mcp.count('tools/call'), turn); assert.equal(f.mcp.count('DELETE'), turn);
      assert.equal(f.executor.isMcpConnectionActive(f.mcpConnection.id), false);
    }
    assert.equal(new Set(f.mcp.sessions).size, 2);
    for (const session of f.mcp.sessions) {
      const requests = f.mcp.requests.filter(request => request.session === session);
      assert.equal(requests[0].method, 'notifications/initialized'); assert.equal(requests.at(-1)!.method, 'DELETE');
      assert.ok(requests.filter(request => request.method === 'tools/list').length >= 2, 'catalog validation uses the same initialized session');
    }
    const count = f.mcp.requests.length;
    assert.equal((await f.executor.send(f.id, 'approved turn 2', [], undefined, { requestId: 'legacy-approved-2' })).success, true);
    assert.equal(f.mcp.requests.length, count, 'receipt replay does not initialize or delete again');
    assertNoSessionEcho(f, await f.ledger(), f.workerPayloads, f.server.requests, f.executor.snapshot(f.id));
    assert.deepEqual(f.mcp.errors, []); assert.deepEqual(f.server.errors, []);
  } finally { await f.dispose(); await pending; }
});

test('denied legacy MCP approval sends no call and still closes its initialized HTTP session', async () => {
  const f = await fixture(); let pending: ReturnType<NativeStructuredExecutor['send']> | undefined;
  try {
    pending = f.executor.send(f.id, 'deny the legacy note'); const approval = await f.approval();
    f.executor.respond(f.id, approval.requestId, { behavior: 'deny' });
    const result = await pending; assert.equal(result.success, true, JSON.stringify(result)); assert.match(result.summary, /denied/);
    assert.equal(f.mcp.count('tools/call'), 0); assert.equal(f.mcp.count('DELETE'), 1);
    assert.equal(f.executor.isMcpConnectionActive(f.mcpConnection.id), false); assert.deepEqual(f.mcp.errors, []);
  } finally { await f.dispose(); await pending; }
});

test('cancelling a dispatched legacy MCP call notifies cancellation, deletes the session and preserves the unknown barrier without replay', async () => {
  const f = await fixture({ callMode: 'hold' }); let pending: ReturnType<NativeStructuredExecutor['send']> | undefined;
  try {
    pending = f.executor.send(f.id, 'uncertain cancelled note', [], undefined, { requestId: 'legacy-cancel' });
    const approval = await f.approval(); f.executor.respond(f.id, approval.requestId, { behavior: 'allow' });
    await f.mcp.waitFor('tools/call'); await f.executor.stop(f.id);
    const result = await pending; assert.equal(result.success, false);
    assert.equal(f.mcp.count('tools/call'), 1); assert.equal(f.mcp.count('notifications/cancelled'), 1); assert.equal(f.mcp.count('DELETE'), 1);
    const call = f.mcp.requests.find(request => request.method === 'tools/call')!;
    const cancelled = f.mcp.requests.find(request => request.method === 'notifications/cancelled')!;
    assert.equal(cancelled.body!.params!.requestId, call.body!.id);
    assert.equal(cancelled.session, call.session);
    assert.ok(f.mcp.requests.indexOf(cancelled) < f.mcp.requests.findIndex(request => request.method === 'DELETE'));
    assert.equal(f.executor.recoveryRequired(f.id), true); assert.equal(f.executor.snapshot(f.id).nativeRecovery?.tools.unknown, 1);
    const before = await f.ledger(), count = f.mcp.requests.length;
    assert.equal((await f.executor.send(f.id, 'uncertain cancelled note', [], undefined, { requestId: 'legacy-cancel' })).success, false);
    assert.equal((await f.executor.send(f.id, 'retry cancelled note', [], undefined, { requestId: 'legacy-retry' })).success, false);
    assert.equal(f.mcp.requests.length, count); assert.deepEqual(await f.ledger(), before);
    assert.equal(f.executor.isMcpConnectionActive(f.mcpConnection.id), false); assertNoSessionEcho(f, before, f.workerPayloads, f.server.requests);
    assert.deepEqual(f.mcp.errors, []);
  } finally { await f.dispose(); await pending; }
});

test('changed legacy catalogs or project instructions invalidate approval before dispatch and clean up the initialized session', async () => {
  for (const change of ['catalog', 'instructions']) {
    const f = await fixture(); let pending: ReturnType<NativeStructuredExecutor['send']> | undefined;
    try {
      pending = f.executor.send(f.id, `do not execute after changed ${change}`); const approval = await f.approval();
      if (change === 'catalog') f.mcp.tool.description = 'Changed operation after approval was requested.';
      else await fs.writeFile(path.join(f.project, 'AGENTS.md'), 'Changed policy: request new approval.\n');
      f.executor.respond(f.id, approval.requestId, { behavior: 'allow' }); await pending;
      assert.equal(f.mcp.count('tools/call'), 0); assert.equal(f.mcp.count('DELETE'), 1); assert.equal(f.executor.recoveryRequired(f.id), false);
      const output = f.server.requests.at(-1).input.find((item: Record<string, unknown>) => item.type === 'function_call_output');
      assert.deepEqual(JSON.parse(output.output), { status: 'failed', output: { error: 'tool_preconditions_changed', executed: false } });
      assert.deepEqual(f.mcp.errors, []);
    } finally { await f.dispose(); await pending; }
  }
});

test('failure while initializing a second legacy connection closes the first before any model or durable run starts', async () => {
  const f = await fixture();
  try {
    const second = await f.addMcp();
    // Native session configuration sorts identifiers, so fail the later connection deterministically.
    const [initialized, failed] = f.mcpConnection.id < second.connection.id ? [f.mcp, second.service] : [second.service, f.mcp];
    failed.options.initializeFailure = true;
    await f.configure([f.mcpConnection.id, second.connection.id]);
    const result = await f.executor.send(f.id, 'both services must be initialized');
    assert.equal(result.success, false); assert.equal(initialized.count('initialize'), 1); assert.equal(initialized.count('DELETE'), 1);
    assert.equal(failed.count('initialize'), 1); assert.equal(failed.count('DELETE'), 0);
    assert.equal(f.mcp.count('tools/call'), 0); assert.equal(f.server.requests.length, 0); assert.equal((await f.ledger()).runs.length, 0);
    assert.equal(f.executor.isMcpConnectionActive(f.mcpConnection.id), false); assert.equal(f.executor.isMcpConnectionActive(second.connection.id), false);
    assert.deepEqual(f.mcp.errors, []); assert.deepEqual(second.service.errors, []);
  } finally { await f.dispose(); }
});

test('worker failure after legacy discovery still deletes the session and releases connection ownership', async () => {
  const f = await fixture({ workerFailure: true });
  try {
    const result = await f.executor.send(f.id, 'worker fails after initialization');
    assert.equal(result.success, false); assert.equal(f.workerPayloads.length, 1); assert.equal(f.mcp.count('initialize'), 1);
    assert.equal(f.mcp.count('DELETE'), 1); assert.equal(f.mcp.count('tools/call'), 0); assert.equal(f.server.requests.length, 0);
    assert.equal(f.executor.isMcpConnectionActive(f.mcpConnection.id), false); assertNoSessionEcho(f, result, await f.ledger(), f.workerPayloads);
    assert.deepEqual(f.mcp.errors, []);
  } finally { await f.dispose(); }
});

test('a legacy HTTP 404 never reinitializes or replays the dispatched call; a separately created conversation gets a fresh session', async () => {
  // Two independent conversations share this test server; neither replays the other's model history.
  const f = await fixture({ callMode: 'not_found', modelReplay: false }); let pending: ReturnType<NativeStructuredExecutor['send']> | undefined;
  try {
    pending = f.executor.send(f.id, 'expired remote session', [], undefined, { requestId: 'legacy-404' });
    const approval = await f.approval(); f.executor.respond(f.id, approval.requestId, { behavior: 'allow' });
    assert.equal((await pending).success, false); assert.equal(f.executor.recoveryRequired(f.id), true);
    assert.equal(f.mcp.count('initialize'), 1); assert.equal(f.mcp.count('tools/call'), 1); assert.equal(f.mcp.count('DELETE'), 1);
    const count = f.mcp.requests.length;
    assert.equal((await f.executor.send(f.id, 'expired remote session', [], undefined, { requestId: 'legacy-404' })).success, false);
    assert.equal(f.mcp.requests.length, count);
    f.mcp.options.callMode = 'normal'; const next = f.addSession();
    pending = f.executor.send(next.id, 'explicitly new conversation'); const nextApproval = await f.approval();
    f.executor.respond(next.id, nextApproval.requestId, { behavior: 'allow' });
    assert.equal((await pending).success, true); assert.equal(f.mcp.count('initialize'), 2); assert.equal(f.mcp.count('tools/call'), 2);
    assert.equal(f.mcp.count('DELETE'), 2); assert.notEqual(f.mcp.sessions[0], f.mcp.sessions[1]); assert.deepEqual(f.mcp.errors, []);
  } finally { await f.dispose(); await pending; }
});

test('legacy session echoes in catalog and call output are rejected before model or durable data can contain them', async () => {
  for (const phase of ['catalog', 'output']) {
    const f = await fixture(phase === 'catalog' ? { catalogEcho: true } : { callMode: 'echo_session' });
    let pending: ReturnType<NativeStructuredExecutor['send']> | undefined;
    try {
      pending = f.executor.send(f.id, `block session echo from ${phase}`);
      if (phase === 'output') { const approval = await f.approval(); f.executor.respond(f.id, approval.requestId, { behavior: 'allow' }); }
      const result = await pending; assert.equal(result.success, false); assert.equal(f.mcp.count('DELETE'), 1);
      assert.equal(f.mcp.count('tools/call'), phase === 'catalog' ? 0 : 1);
      if (phase === 'catalog') { assert.equal(f.server.requests.length, 0); assert.equal((await f.ledger()).runs.length, 0); }
      else assert.equal(f.executor.recoveryRequired(f.id), true, 'an executed call with unsafe output retains its unknown barrier');
      assertNoSessionEcho(f, result, await f.ledger(), f.server.requests, f.workerPayloads, f.executor.snapshot(f.id));
      assert.deepEqual(f.executor.attention(), []); assert.deepEqual(f.mcp.errors, []);
    } finally { await f.dispose(); await pending; }
  }
});

test('the selected legacy protocol cannot change during approval and becomes editable only after session cleanup', async () => {
  const f = await fixture(); let pending: ReturnType<NativeStructuredExecutor['send']> | undefined;
  try {
    assert.equal(f.mcpConnection.transport, 'http');
    if (f.mcpConnection.transport !== 'http') throw new Error('Expected HTTP fixture.');
    const { credentialConfigured: _credentialConfigured, ready: _ready, error: _error, ...input } = f.mcpConnection;
    pending = f.executor.send(f.id, 'hold protocol while awaiting approval'); const approval = await f.approval();
    assert.throws(() => f.mcpConnections.upsert({ ...input, protocolVersion: '2026-07-28' }), /运行|使用|占用/);
    f.executor.respond(f.id, approval.requestId, { behavior: 'deny' }); assert.equal((await pending).success, true);
    assert.equal(f.mcp.count('DELETE'), 1);
    const updated = f.mcpConnections.upsert({ ...input, protocolVersion: '2026-07-28' });
    assert.equal(updated.protocolVersion, '2026-07-28'); assert.equal(updated.revision, f.mcpConnection.revision + 1);
    assert.deepEqual(f.mcp.errors, []);
  } finally { await f.dispose(); await pending; }
});

test('unsupported or stalled legacy DELETE is bounded and does not retain local ownership or block the next run', { timeout: 20_000 }, async () => {
  for (const deleteMode of ['unsupported', 'hang'] as const) {
    const f = await fixture({ deleteMode }); let pending: ReturnType<NativeStructuredExecutor['send']> | undefined;
    try {
      pending = f.executor.send(f.id, `cleanup ${deleteMode}`); const approval = await f.approval();
      const started = performance.now(); f.executor.respond(f.id, approval.requestId, { behavior: 'deny' });
      const result = await pending; assert.equal(result.success, true, JSON.stringify(result));
      assert.ok(performance.now() - started < 6_000, 'best-effort remote cleanup has a short independent deadline');
      assert.equal(f.mcp.count('DELETE'), 1); assert.equal(f.executor.isMcpConnectionActive(f.mcpConnection.id), false);
      assert.equal(f.executor.recoveryRequired(f.id), false);
      f.mcp.options.deleteMode = 'normal';
      pending = f.executor.send(f.id, 'next run after bounded cleanup'); const next = await f.approval();
      f.executor.respond(f.id, next.requestId, { behavior: 'deny' }); assert.equal((await pending).success, true);
      assert.equal(f.mcp.count('initialize'), 2); assert.equal(f.mcp.count('DELETE'), 2); assert.equal(f.mcp.count('tools/call'), 0);
      assert.deepEqual(f.mcp.errors, []);
    } finally { await f.dispose(); await pending; }
  }
});
