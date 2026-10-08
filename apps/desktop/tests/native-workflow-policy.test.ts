import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { Socket, AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { runAgent } from '@cc-desk/agent-core';
import { ResponsesModel } from '@cc-desk/agent-node/responses-model';
import { NativeRunStore } from '@cc-desk/agent-node/run-store';
import { StateStore } from '../src/main/store';
import { ExecutionEvents } from '../src/main/execution/events';
import { WorkflowEngine, type WorkflowEngineOptions } from '../src/main/workflows';
import type { WorkflowBudget, WorkflowToolPolicy } from '../src/shared/workflows';
import { ConnectionStore } from '../src/main/engines/native/connections';
import { NativeMcpConnectionStore } from '../src/main/engines/native/mcp-connections';
import { NativeCredentialStore } from '../src/main/engines/native/credentials';
import { NativeStructuredExecutor, type NativeExecutorOptions } from '../src/main/engines/native/structured-executor';
import { createNativeConfig } from '../src/main/engines/native/config';
// @ts-expect-error Shared loopback Responses fixture has no declarations.
import { startResponsesFixture, functionCall, assistantMessage } from '../../../packages/agent-node/tests/fixtures/responses-server.mjs';
// @ts-expect-error Shared test-only ESM fixture has no declarations.
import { listenOnFetchLoopback } from '../../../packages/agent-node/tests/fixtures/fetch-loopback.mjs';

type Scenario = 'read-only' | 'standard' | 'simple' | 'fail-once' | 'tool-budget' | 'approval-time';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const inline: NonNullable<NativeExecutorOptions['worker']> = options => runAgent({ ...options.request, signal: options.signal }, {
  model: new ResponsesModel(options.model), tools: options.tools, store: options.store, approvals: options.approvals,
  contextMaintenance: options.contextMaintenance,
  host: { now: Date.now, digest: hash, emit: options.onEvent, consumeBudget: options.consumeBudget,
    deadline: (ms, parent) => { const controller = new AbortController(), abort = () => controller.abort(), timer = setTimeout(abort, ms);
      parent.addEventListener('abort', abort, { once: true }); if (parent.aborted) abort();
      return { signal: controller.signal, dispose() { clearTimeout(timer); parent.removeEventListener('abort', abort); } }; },
  },
});
async function mcpFixture() {
  const requests: Array<{ method: string; params?: { name?: string } }> = [], errors: unknown[] = [], sockets = new Set<Socket>();
  const server = http.createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST'); assert.equal(request.url, '/mcp'); assert.equal(request.headers.authorization, 'Bearer mcp-policy-fixture');
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); requests.push(body);
      assert.ok(['server/discover', 'tools/list', 'tools/call'].includes(body.method));
      if (body.method === 'tools/call') { assert.equal(body.params.name, 'record_note'); assert.deepEqual(body.params.arguments, { note: 'approved' }); }
      const result = body.method === 'server/discover' ? { resultType: 'complete', supportedVersions: ['2026-07-28'], capabilities: { tools: {} } }
        : body.method === 'tools/list' ? { resultType: 'complete', tools: [{ name: 'record_note', description: 'Write an approved external note', inputSchema: { type: 'object', properties: { note: { type: 'string' } } } }] }
        : { resultType: 'complete', content: [{ type: 'text', text: 'external effect completed' }] };
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
    } catch (error) { errors.push(error); response.writeHead(500, { 'Content-Type': 'application/json' }); response.end('{"error":"local fixture assertion failed"}'); }
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await listenOnFetchLoopback(server);
  return { endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, requests, errors,
    count: () => requests.filter(item => item.method === 'tools/call').length,
    async close() { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
async function fixture(scenario: Scenario) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-workflow-policy-')), data = path.join(directory, 'data'), project = path.join(directory, 'project');
  await fs.mkdir(project); await fs.writeFile(path.join(project, 'source.txt'), 'original\n');
  const mcp = await mcpFixture();
  const server = await startResponsesFixture({ assertReplay: false, handler: ({ body, index }: { body: { tools: Array<{ name: string }>; input: Array<{ type: string; call_id?: string; output?: string }> }; index: number }) => {
    const done = new Map(body.input.filter(item => item.type === 'function_call_output').map(item => [item.call_id, JSON.parse(item.output!)]));
    const call = (id: string, name: string, input: unknown) => ({ output: [functionCall(id, name, input)] });
    if (scenario === 'read-only' && index === 0) return { output: [
      functionCall('forbidden-patch', 'apply_patch', { path: 'source.txt', expectedHash: hash('original\n'), content: 'unauthorized\n' }),
      functionCall('forbidden-command', 'run_command', { executable: process.execPath, argv: ['-e', 'require("node:fs").writeFileSync("command.txt","unauthorized")'], cwd: '.' }),
      functionCall('forbidden-mcp', 'mcp_unadvertised_record_note', { note: 'unauthorized' }),
    ] };
    if (scenario === 'fail-once' && index === 0) return { httpStatus: 503, raw: 'private remote failure' };
    if (scenario === 'tool-budget' && index === 0) return { output: [0, 1, 2].map(number => functionCall(`read-${number}`, 'read_file', { path: 'source.txt' })) };
    if (scenario === 'standard' || scenario === 'approval-time') {
      if (!done.has('read')) return call('read', 'read_file', { path: 'source.txt' });
      if (!done.has('patch')) return call('patch', 'apply_patch', { path: 'source.txt', expectedHash: done.get('read').output.hash, content: 'approved\n' });
      if (scenario === 'standard' && !done.has('command')) return call('command', 'run_command', { executable: process.execPath,
        argv: ['-e', 'require("node:fs").writeFileSync("command.txt","approved\\n")'], cwd: '.' });
      if (scenario === 'standard' && !done.has('mcp')) {
        const tool = body.tools.find(item => item.name.startsWith('mcp_')); assert.ok(tool, 'standard stage must retain selected MCP catalog');
        return call('mcp', tool.name, { note: 'approved' });
      }
    }
    return { output: [assistantMessage(`final-${index}`, 'Actual stage ended')] };
  } });
  const store = new StateStore(data), connections = new ConnectionStore(data), events = new ExecutionEvents();
  const initial = connections.upsert({ name: 'policy fixture', protocol: 'responses', baseURL: server.baseURL,
    model: 'fixture-model', enabled: true, allowLoopbackHttp: true, auth: { mode: 'memory' } });
  const connection = connections.setCredential({ id: initial.id, revision: initial.revision, mode: 'memory', secret: 'sk-policy-fixture' });
  const mcps = new NativeMcpConnectionStore(data, new NativeCredentialStore());
  const remote = mcps.upsert({ name: 'external fixture', endpoint: mcp.endpoint, enabled: true, allowLoopbackHttp: true, auth: { mode: 'memory' } });
  mcps.setCredential({ id: remote.id, revision: remote.revision, mode: 'memory', secret: 'mcp-policy-fixture' });
  const id = randomUUID(), projectId = randomUUID(), conversationId = randomUUID();
  store.change(state => { state.projects.push({ id: projectId, name: 'project', path: project, createdAt: new Date().toISOString() });
    state.sessions.push({ id, projectId, title: 'policy integration', kind: 'agent', cwd: project,
      execution: { providerId: 'native', mode: 'structured', conversationId },
      engineConfig: createNativeConfig({ schemaVersion: 1, options: { connectionId: connection.id, mcpConnections: [remote.id] } }),
      started: false, archived: false, status: 'idle', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }); });
  let executor = new NativeStructuredExecutor(store, connections, events, { worker: inline, mcpConnections: mcps }); await executor.initialize();
  const approvals: string[] = [], handled = new Set<string>();
  const unsubscribe = events.subscribe(event => { if (event.type !== 'conversation.changed') return;
    for (const pending of executor.snapshot(id).pending) if (!handled.has(pending.requestId)) {
      handled.add(pending.requestId); approvals.push(pending.toolName!);
      if (scenario === 'read-only') queueMicrotask(() => executor.respond(id, pending.requestId, { behavior: 'deny' }));
    } });
  const engineOptions: WorkflowEngineOptions = { nativePoliciesEnabled: true,
    getSession: () => ({ sessionId: id, projectId, providerId: 'native', executionMode: 'structured', cwd: project }),
    runStage: (sessionId, prompt, title, submission) => executor.send(sessionId, prompt, [], title, submission), cancelSession: sessionId => executor.stop(sessionId),
    inspectNativeTask: receipt => executor.inspectTaskReceipt(receipt), };
  let engine = new WorkflowEngine(data, engineOptions);
  return { project, server, mcp, approvals, get engine() { return engine; },
    create: (toolPolicy: WorkflowToolPolicy = 'standard', budget?: WorkflowBudget, stages = 1) => engine.create({ sessionId: id, goal: 'Enforce actual policy and cumulative budgets',
      stages: Array.from({ length: stages }, (_, index) => ({ id: `stage-${index}`, title: `Stage ${index}`, instruction: 'Perform only the allowed step', toolPolicy,
        dependsOn: index ? [`stage-${index - 1}`] : [] })), ...(budget ? { budget } : {}) }),
    async pending(name: string) { for (let count = 0; count < 500; count++) { const value = executor.snapshot(id).pending.find(item => name === 'mcp_' ? item.toolName?.startsWith(name) : item.toolName === name);
        if (value) return value; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error(`No ${name} approval reached`); },
    approve: (requestId: string) => executor.respond(id, requestId, { behavior: 'allow' }),
    async ledger() { const ledger = await NativeRunStore.open({ rootDirectory: path.join(data, 'native', 'conversations'), conversationId });
      try { return { records: ledger.replay(), runs: ledger.listRuns() }; } finally { await ledger.close(); } },
    async restart() { await engine.shutdown(); await executor.shutdown(); executor = new NativeStructuredExecutor(store, connections, events, { worker: inline, mcpConnections: mcps });
      await executor.initialize(); engine = new WorkflowEngine(data, engineOptions); },
    async dispose() { unsubscribe(); await engine.shutdown(); await executor.shutdown(); await server.close(); await mcp.close(); store.flush(); await fs.rm(directory, { recursive: true, force: true }); },
  };
}

test('actual Native read-only workflow excludes write, command and MCP capabilities and refuses forged calls without effects', async () => {
  const f = await fixture('read-only');
  try {
    const run = f.create('read_only'); f.engine.start(run.id); await f.engine.wait(run.id);
    assert.equal(f.server.requests.length, 2); assert.deepEqual(f.approvals, []);
    for (const request of f.server.requests) assert.ok(request.tools.every((tool: { name: string }) => tool.name !== 'apply_patch' && tool.name !== 'run_command' && !tool.name.startsWith('mcp_')));
    assert.equal(await fs.readFile(path.join(f.project, 'source.txt'), 'utf8'), 'original\n');
    await assert.rejects(fs.stat(path.join(f.project, 'command.txt')), { code: 'ENOENT' });
    assert.equal(f.mcp.requests.length, 0, 'local read-only stages do not even open the configured external service');
    const ledger = await f.ledger(); assert.equal(ledger.records.filter(record => record.event.type === 'tool_prepared').length, 0);
    assert.deepEqual(f.server.errors, []); assert.deepEqual(f.mcp.errors, []);
  } finally { await f.dispose(); }
});

test('actual Native standard workflow preserves separate approvals before file, command and external effects', async () => {
  const f = await fixture('standard');
  try {
    const run = f.create(); f.engine.start(run.id);
    const patch = await f.pending('apply_patch'); assert.equal(await fs.readFile(path.join(f.project, 'source.txt'), 'utf8'), 'original\n'); f.approve(patch.requestId);
    const command = await f.pending('run_command'); await assert.rejects(fs.stat(path.join(f.project, 'command.txt')), { code: 'ENOENT' }); f.approve(command.requestId);
    const remote = await f.pending('mcp_'); assert.equal(f.mcp.count(), 0); f.approve(remote.requestId);
    assert.equal((await f.engine.wait(run.id)).status, 'completed');
    assert.deepEqual(f.approvals.slice(0, 2), ['apply_patch', 'run_command']); assert.match(f.approvals[2], /^mcp_/); assert.equal(f.approvals.length, 3);
    assert.equal(await fs.readFile(path.join(f.project, 'source.txt'), 'utf8'), 'approved\n');
    assert.equal(await fs.readFile(path.join(f.project, 'command.txt'), 'utf8'), 'approved\n'); assert.equal(f.mcp.count(), 1);
    assert.deepEqual(f.server.errors, []); assert.deepEqual(f.mcp.errors, []);
  } finally { await f.dispose(); }
});

test('actual workflow request budgets accumulate across stages and restart and stop before another stage dispatch', async () => {
  const f = await fixture('simple');
  try {
    const run = f.create('standard', { maxModelRequests: 2, maxToolCalls: 5, maxActiveMs: 10_000 }, 3); f.engine.start(run.id);
    const stopped = await f.engine.wait(run.id); assert.equal(stopped.status, 'interrupted'); assert.equal(stopped.usage?.modelRequests, 2);
    assert.deepEqual(stopped.stages.map(stage => stage.attempts), [1, 1, 0]); assert.equal(f.server.requests.length, 2);
    await f.restart(); f.engine.continue(run.id); await f.engine.wait(run.id); assert.equal(f.server.requests.length, 2);
    assert.equal((await f.ledger()).records.filter(record => record.event.type === 'model_request_started').length, 2);
  } finally { await f.dispose(); }
});

test('a failed actual model request remains charged against workflow allowance when explicitly retried after restart', async () => {
  const f = await fixture('fail-once');
  try {
    const run = f.create('standard', { maxModelRequests: 2, maxToolCalls: 5, maxActiveMs: 10_000 }, 2); f.engine.start(run.id);
    const failed = await f.engine.wait(run.id); assert.equal(failed.status, 'failed'); assert.equal(failed.usage?.modelRequests, 1);
    await f.restart(); f.engine.retry(run.id); const stopped = await f.engine.wait(run.id);
    assert.equal(stopped.status, 'interrupted'); assert.equal(stopped.usage?.modelRequests, 2);
    assert.deepEqual(stopped.stages.map(stage => stage.attempts), [2, 0]); assert.equal(f.server.requests.length, 2);
    assert.equal((await f.ledger()).records.filter(record => record.event.type === 'model_request_failed').length, 1);
  } finally { await f.dispose(); }
});

test('actual host tool budget stops a complete batch at its exact capacity and cannot refill on workflow retry', async () => {
  const f = await fixture('tool-budget');
  try {
    const run = f.create('standard', { maxModelRequests: 5, maxToolCalls: 2, maxActiveMs: 10_000 }); f.engine.start(run.id);
    const failed = await f.engine.wait(run.id); assert.equal(failed.status, 'failed'); assert.equal(failed.usage?.toolCalls, 2);
    const ledger = await f.ledger(); assert.equal(ledger.records.filter(record => record.event.type === 'tool_prepared').length, 2);
    assert.equal(f.server.requests.length, 1);
    await f.restart(); f.engine.retry(run.id); await f.engine.wait(run.id); assert.equal(f.server.requests.length, 1);
  } finally { await f.dispose(); }
});

test('approval waiting beyond the whole workflow active-time ceiling does not consume that execution allowance', async () => {
  const f = await fixture('approval-time');
  try {
    const run = f.create('standard', { maxModelRequests: 5, maxToolCalls: 5, maxActiveMs: 5000 }); f.engine.start(run.id);
    const patch = await f.pending('apply_patch'); await new Promise(resolve => setTimeout(resolve, 5500)); f.approve(patch.requestId);
    const done = await f.engine.wait(run.id); assert.equal(done.status, 'completed');
    assert.ok(done.usage && done.usage.activeMs < 5000, `approval wait was incorrectly charged: ${JSON.stringify(done.usage)}`);
    assert.equal(await fs.readFile(path.join(f.project, 'source.txt'), 'utf8'), 'approved\n');
  } finally { await f.dispose(); }
});
