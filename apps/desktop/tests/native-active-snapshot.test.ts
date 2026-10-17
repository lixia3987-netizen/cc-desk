import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { runAgent } from '@cc-desk/agent-core';
import { ResponsesModel } from '@cc-desk/agent-node/responses-model';
import { NativeRunStore } from '@cc-desk/agent-node/run-store';
import { StateStore } from '../src/main/store';
import { ExecutionEvents } from '../src/main/execution/events';
import { ConnectionStore } from '../src/main/engines/native/connections';
import { NativeStructuredExecutor, type NativeExecutorOptions } from '../src/main/engines/native/structured-executor';
import { NativeProjection } from '../src/main/engines/native/projection';
import { NativeTaskSession } from '../src/main/engines/native/task-session';
import { createNativeConfig } from '../src/main/engines/native/config';
// @ts-expect-error Shared local HTTP/SSE fixture has no TypeScript declaration.
import { startResponsesFixture, assistantMessage, functionCall } from '../../../packages/agent-node/tests/fixtures/responses-server.mjs';

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

/** A closed gate, rather than elapsed wall time, establishes the read boundary. */
async function settlesBeforeClosedGate(operation: Promise<void>): Promise<boolean> {
  return Promise.race([operation.then(() => true), new Promise<false>(resolve => setImmediate(() => resolve(false)))]);
}

const inlineWorker: NonNullable<NativeExecutorOptions['worker']> = options => runAgent({ ...options.request, signal: options.signal }, {
  model: new ResponsesModel(options.model), tools: options.tools, store: options.store, approvals: options.approvals,
  contextMaintenance: options.contextMaintenance,
  host: { now: Date.now, digest: value => createHash('sha256').update(value).digest('hex'), emit: options.onEvent,
    deadline: (ms, parent) => {
      const controller = new AbortController(), abort = () => controller.abort(), timer = setTimeout(abort, ms);
      parent.addEventListener('abort', abort, { once: true }); if (parent.aborted) abort();
      return { signal: controller.signal, dispose() { clearTimeout(timer); parent.removeEventListener('abort', abort); } };
    },
  },
});

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-active-snapshot-'));
  const project = path.join(directory, 'project'), data = path.join(directory, 'data');
  await fs.mkdir(project); await fs.writeFile(path.join(project, 'fixture.txt'), 'original\n');
  const server = await startResponsesFixture({ assertReplay: false, handler: ({ body, index }: { body: { input: Array<Record<string, unknown>> }; index: number }) => {
    if (index === 0) return { output: [functionCall('approved-patch', 'apply_patch', { path: 'fixture.txt', content: 'approved once\n', expectedHash: createHash('sha256').update('original\n').digest('hex') })] };
    assert.equal(index, 1);
    const result = body.input.find(item => item.type === 'function_call_output' && item.call_id === 'approved-patch');
    assert.ok(result); assert.equal(JSON.parse(String(result.output)).status, 'completed');
    return { output: [assistantMessage('final', 'Approved edit completed with its original receipt.')] };
  } });
  const store = new StateStore(data), connections = new ConnectionStore(data), events = new ExecutionEvents();
  const created = connections.upsert({ name: 'active snapshot fixture', protocol: 'responses', baseURL: server.baseURL, model: 'fixture-model',
    allowLoopbackHttp: true, enabled: true, auth: { mode: 'memory' } });
  const connection = connections.setCredential({ id: created.id, revision: created.revision, mode: 'memory', secret: 'sk-active-snapshot-fixture' });
  const id = randomUUID(), conversationId = randomUUID(), projectId = randomUUID();
  store.change(state => {
    state.projects.push({ id: projectId, path: project, name: 'project', createdAt: new Date().toISOString() });
    state.sessions.push({ id, projectId, title: 'active snapshot', kind: 'agent', cwd: project,
      execution: { providerId: 'native', mode: 'structured', conversationId },
      engineConfig: createNativeConfig({ schemaVersion: 1, options: { connectionId: connection.id, autoCompact: 'off' } }),
      started: false, archived: false, status: 'idle', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  });
  const executor = new NativeStructuredExecutor(store, connections, events, { worker: inlineWorker });
  await executor.initialize();
  const attention = deferred();
  const unsubscribe = events.subscribe(() => { if (executor.attention().some(item => item.sessionId === id)) attention.release(); });
  return { id, conversationId, project, server, executor,
    send: () => executor.send(id, 'Edit fixture.txt only after approval.', [], undefined, { requestId: 'active-snapshot-submission' }),
    async approval(running: ReturnType<NativeStructuredExecutor['send']>) {
      await Promise.race([attention.promise, running.then(result => { throw new Error(`Run ended before real approval: ${JSON.stringify(result)}`); })]);
      const pending = executor.attention().find(item => item.sessionId === id)!;
      assert.ok(pending); assert.equal(pending.toolName, 'apply_patch'); return pending;
    },
    async ledger() {
      const ledger = await NativeRunStore.open({ rootDirectory: path.join(data, 'native', 'conversations'), conversationId });
      try { return { head: ledger.head, runs: ledger.listRuns(), records: ledger.replay(), context: ledger.loadContext() }; }
      finally { await ledger.close(); }
    },
    async dispose() { unsubscribe(); await executor.shutdown().catch(() => {}); await server.close(); store.flush(); await fs.rm(directory, { recursive: true, force: true }); },
  };
}

/** Only fixture-owned projection/task work is delayed; durable stores remain real. */
function gateDerivedReads(f: Awaited<ReturnType<typeof fixture>>, blocked = true) {
  const gate = deferred(), entered = deferred();
  const hydrate = NativeProjection.prototype.hydrate, refresh = NativeTaskSession.prototype.refresh;
  let projectionCalls = 0, taskCalls = 0;
  NativeProjection.prototype.hydrate = async function (...args) {
    if (args[0] === f.id) { projectionCalls++; entered.release(); if (blocked) await gate.promise; }
    return hydrate.apply(this, args);
  };
  NativeTaskSession.prototype.refresh = async function (...args) {
    if (args[0].conversationId === f.conversationId) { taskCalls++; if (blocked) await gate.promise; }
    return refresh.apply(this, args);
  };
  return { entered: entered.promise, release: gate.release,
    get projectionCalls() { return projectionCalls; }, get taskCalls() { return taskCalls; },
    restore() { NativeProjection.prototype.hydrate = hydrate; NativeTaskSession.prototype.refresh = refresh; },
  };
}

test('active snapshot hydration returns the current approval without waiting for projection or task metadata', async () => {
  const f = await fixture();
  let running: ReturnType<NativeStructuredExecutor['send']> | undefined;
  let hydration: Promise<void> | undefined, gate: ReturnType<typeof gateDerivedReads> | undefined;
  try {
    running = f.send(); const attention = await f.approval(running);
    const before = f.executor.snapshot(f.id), pending = before.pending.find(item => item.requestId === attention.requestId)!;
    assert.ok(pending); assert.equal(pending.toolUseId, 'approved-patch');
    gate = gateDerivedReads(f);
    hydration = f.executor.hydrate(f.id);
    assert.equal(await settlesBeforeClosedGate(hydration), true, 'active UI reads must resolve while derived projection and metadata gates remain closed');
    const after = f.executor.snapshot(f.id);
    assert.equal(gate.projectionCalls, 0); assert.equal(gate.taskCalls, 0);
    assert.deepEqual(after.pending, before.pending); assert.deepEqual(f.executor.attention(), [attention]);
    assert.equal(await fs.readFile(path.join(f.project, 'fixture.txt'), 'utf8'), 'original\n');
    assert.equal(f.server.requests.length, 1, 'reading an approval cannot resume the model or authorize its tool');
    gate.release(); gate.restore(); await hydration;
    f.executor.respond(f.id, attention.requestId, { behavior: 'allow' });
    const result = await running; assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(await fs.readFile(path.join(f.project, 'fixture.txt'), 'utf8'), 'approved once\n');
    assert.deepEqual(f.server.errors, []); assert.equal(f.server.requests.length, 2);
    const receipt = await f.ledger();
    assert.equal(receipt.runs.length, 1); assert.equal(receipt.runs[0].result!.committed, true);
    assert.equal(receipt.records.filter(record => record.event.type === 'tool_completed' && record.event.call.id === 'approved-patch').length, 1);
    gate = gateDerivedReads(f, false);
    await f.executor.hydrate(f.id);
    assert.ok(gate.projectionCalls > 0, 'idle hydration still validates the derived projection');
    assert.ok(gate.taskCalls > 0, 'idle hydration still refreshes durable task/workspace metadata');
    assert.deepEqual(await f.ledger(), receipt, 'idle display/metadata refresh cannot rewrite the original execution receipt');
  } finally {
    gate?.release(); gate?.restore(); await hydration?.catch(() => {});
    await f.executor.stop(f.id).catch(() => {}); await running?.catch(() => {}); await f.dispose();
  }
});

test('a new active UI read bypasses older idle hydration while actual execution still waits for its ownership barrier', async () => {
  const f = await fixture(), gate = gateDerivedReads(f);
  let running: ReturnType<NativeStructuredExecutor['send']> | undefined;
  let hydration: Promise<void> | undefined, activeHydration: Promise<void> | undefined;
  let originalSettled = false;
  try {
    hydration = f.executor.hydrate(f.id).then(() => { originalSettled = true; });
    await Promise.race([gate.entered, hydration.then(() => { throw new Error('Idle derived-read gate was not entered'); })]);
    assert.equal(gate.projectionCalls, 1); assert.equal(originalSettled, false);
    running = f.send(); assert.equal(f.executor.has(f.id), true);
    activeHydration = f.executor.hydrate(f.id);
    assert.equal(await settlesBeforeClosedGate(activeHydration), true, 'active UI read must not reuse the older blocked idle-hydration promise');
    const snapshot = f.executor.snapshot(f.id);
    assert.equal(snapshot.taskState, 'starting'); assert.deepEqual(snapshot.pending, []);
    assert.equal(originalSettled, false); assert.equal(gate.projectionCalls, 1); assert.equal(gate.taskCalls, 0);
    assert.equal(f.server.requests.length, 0, 'actual execution must still wait for the original hydration/writer barrier');
    assert.equal(await fs.readFile(path.join(f.project, 'fixture.txt'), 'utf8'), 'original\n');
    gate.release(); gate.restore(); await hydration;
    const attention = await f.approval(running);
    assert.equal(f.server.requests.length, 1); assert.equal(await fs.readFile(path.join(f.project, 'fixture.txt'), 'utf8'), 'original\n');
    f.executor.respond(f.id, attention.requestId, { behavior: 'allow' });
    const result = await running; assert.equal(result.success, true, JSON.stringify(result));
    assert.deepEqual(f.server.errors, []); assert.equal(f.server.requests.length, 2);
    const receipt = await f.ledger(); assert.equal(receipt.runs.length, 1); assert.equal(receipt.runs[0].result!.committed, true);
    assert.equal(receipt.records.filter(record => record.event.type === 'tool_completed' && record.event.call.id === 'approved-patch').length, 1);
  } finally {
    gate.release(); gate.restore(); await hydration?.catch(() => {}); await activeHydration?.catch(() => {});
    await f.executor.stop(f.id).catch(() => {}); await running?.catch(() => {}); await f.dispose();
  }
});
