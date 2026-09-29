import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { runAgent } from '@cc-desk/agent-core';
import { NativeRunStore } from '@cc-desk/agent-node/run-store';
import { ResponsesModel } from '@cc-desk/agent-node/responses-model';
import { StateStore } from '../src/main/store';
import { ExecutionEvents } from '../src/main/execution/events';
import { ConnectionStore } from '../src/main/engines/native/connections';
import { NativeStructuredExecutor, type NativeExecutorOptions } from '../src/main/engines/native/structured-executor';
import { createNativeConfig } from '../src/main/engines/native/config';
// @ts-expect-error Shared local Responses protocol fixture has no declarations.
import { startResponsesFixture, assistantMessage, functionCall } from '../../../packages/agent-node/tests/fixtures/responses-server.mjs';

const inline: NonNullable<NativeExecutorOptions['worker']> = options => runAgent({ ...options.request, signal: options.signal }, {
  model: new ResponsesModel(options.model), tools: options.tools, store: options.store, approvals: options.approvals,
  host: { now: Date.now, digest: value => createHash('sha256').update(value).digest('hex'), emit: options.onEvent,
    deadline: (ms, parent) => {
      const controller = new AbortController(), abort = () => controller.abort(), timer = setTimeout(abort, ms);
      parent.addEventListener('abort', abort, { once: true }); if (parent.aborted) abort();
      return { signal: controller.signal, dispose() { clearTimeout(timer); parent.removeEventListener('abort', abort); } };
    },
  },
});
type Outcome = 'completed' | 'error';
async function fixture(outcomes: [Outcome, Outcome], crashCurrent = false) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-historical-receipt-'));
  const data = path.join(directory, 'data'), project = path.join(directory, 'project');
  await fs.mkdir(project); await fs.writeFile(path.join(project, 'fixture.txt'), 'preserved source\n');
  const server = await startResponsesFixture({ assertReplay: false, handler: ({ body }: { body: { input: Array<{ role?: string; type?: string; call_id?: string }> } }) => {
    const turn = body.input.filter(item => item.role === 'user').length;
    const callId = `read-${turn}`;
    if (!body.input.some(item => item.type === 'function_call_output' && item.call_id === callId)) {
      return { output: [functionCall(callId, 'read_file', { path: 'fixture.txt' })] };
    }
    return outcomes[turn - 1] === 'completed' ? { output: [assistantMessage(`answer-${turn}`, `Completed turn ${turn}.`)] }
      : { httpStatus: 401, raw: 'fixture authentication failure' };
  } });
  const store = new StateStore(data), connections = new ConnectionStore(data), events = new ExecutionEvents();
  const initial = connections.upsert({ name: 'historical receipt fixture', protocol: 'responses', baseURL: server.baseURL,
    model: 'fixture-model', enabled: true, allowLoopbackHttp: true, auth: { mode: 'memory' } });
  const connection = connections.setCredential({ id: initial.id, revision: initial.revision, mode: 'memory', secret: 'sk-historical-fixture-only' });
  const id = randomUUID(), conversationId = randomUUID(), projectId = randomUUID();
  store.change(state => {
    state.projects.push({ id: projectId, name: 'project', path: project, createdAt: new Date().toISOString() });
    state.sessions.push({ id, projectId, title: 'historical receipts', kind: 'agent', cwd: project,
      execution: { providerId: 'native', mode: 'structured', conversationId },
      engineConfig: createNativeConfig({ schemaVersion: 1, options: { connectionId: connection.id } }),
      started: false, archived: false, status: 'idle', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  });
  let starts = 0;
  const worker: NonNullable<NativeExecutorOptions['worker']> = async options => {
    starts++;
    if (crashCurrent && options.request.identity.requestId === 'current') {
      const model = new ResponsesModel(options.model);
      await options.store.beginRun({ ...options.request, inputDigest: createHash('sha256').update(options.request.input).digest('hex'),
        userItems: model.userItems(options.request.input), protocol: model.protocol });
      throw new Error('fixture worker crash after durable acceptance');
    }
    return inline(options);
  };
  let executor = new NativeStructuredExecutor(store, connections, events, { worker });
  await executor.initialize();
  const state = () => {
    const snapshot = executor.snapshot(id), session = store.state.sessions.find(item => item.id === id)!;
    return { taskState: snapshot.taskState, error: snapshot.error, nativeRun: snapshot.nativeRun,
      usage: snapshot.usage, context: snapshot.context, messages: snapshot.messages,
      sessionTaskState: session.taskState, sessionStatus: session.status, sessionError: session.error };
  };
  return { id, server, store, project, get executor() { return executor; }, get starts() { return starts; }, state,
    async ledger() {
      const ledger = await NativeRunStore.open({ rootDirectory: path.join(data, 'native', 'conversations'), conversationId });
      try { return ledger.replay(); } finally { await ledger.close(); }
    },
    async restart() { await executor.shutdown(); executor = new NativeStructuredExecutor(store, connections, events, { worker }); await executor.initialize(); },
    async dispose() { await executor.shutdown().catch(() => {}); await server.close(); store.flush(); await fs.rm(directory, { recursive: true, force: true }); },
  };
}

async function runHistory(f: Awaited<ReturnType<typeof fixture>>, outcomes: [Outcome, Outcome]) {
  const first = await f.executor.send(f.id, 'First task', [], undefined, { requestId: 'historical' });
  const second = await f.executor.send(f.id, 'Current task', [], undefined, { requestId: 'current' });
  assert.equal(first.success, outcomes[0] === 'completed'); assert.equal(second.success, outcomes[1] === 'completed');
  assert.equal(f.executor.snapshot(f.id).taskState, outcomes[1]);
  assert.equal(f.executor.snapshot(f.id).nativeRun?.requestId, 'current');
  assert.equal(f.server.requests.length, 4); assert.deepEqual(f.server.errors, []);
  const records = await f.ledger();
  assert.equal(records.filter(record => record.event.type === 'tool_completed').length, 2);
  return { first, state: f.state(), records };
}

async function assertCurrentPreserved(f: Awaited<ReturnType<typeof fixture>>, baseline: Awaited<ReturnType<typeof runHistory>>) {
  assert.deepEqual(f.state(), baseline.state, 'historical receipt results must not replace current run state');
  await f.executor.hydrate(f.id);
  assert.deepEqual(f.state(), baseline.state, 'refresh must keep the current run outcome');
  await f.restart();
  assert.deepEqual(f.state(), baseline.state, 'restart must agree with the visible current run outcome');
  assert.deepEqual(await f.ledger(), baseline.records, 'receipt lookup cannot append or replay model/tool work');
  assert.equal(f.server.requests.length, 4); assert.equal(f.starts, 2);
  assert.equal(await fs.readFile(path.join(f.project, 'fixture.txt'), 'utf8'), 'preserved source\n');
}

test('historical success receipt never releases a newer crashed run recovery barrier', async () => {
  const f = await fixture(['completed', 'error'], true);
  try {
    const first = await f.executor.send(f.id, 'First task', [], undefined, { requestId: 'historical' });
    assert.equal(first.success, true);
    const crashed = await f.executor.send(f.id, 'Current task', [], undefined, { requestId: 'current' });
    assert.equal(crashed.success, false); assert.equal(f.executor.recoveryRequired(f.id), true);
    const state = f.state(), records = await f.ledger();
    assert.equal(state.taskState, 'error'); assert.equal(state.nativeRun?.requestId, 'current');
    assert.equal(records.filter(record => record.event.type === 'tool_completed').length, 1);
    const receipt = await f.executor.send(f.id, 'First task', [], undefined, { requestId: 'historical' });
    assert.deepEqual(receipt, first, 'the executed historical submission still returns its original receipt');
    assert.equal(f.executor.recoveryRequired(f.id), true); assert.deepEqual(f.state(), state);
    await f.executor.hydrate(f.id); assert.deepEqual(f.state(), state);
    await f.restart(); assert.equal(f.executor.recoveryRequired(f.id), true); assert.deepEqual(f.state(), state);
    const blocked = await f.executor.send(f.id, 'Cannot dispatch while recovery is unresolved', [], undefined, { requestId: 'blocked-new' });
    assert.equal(blocked.success, false); assert.equal(f.executor.recoveryRequired(f.id), true);
    assert.equal(f.executor.snapshot(f.id).taskState, 'error');
    assert.deepEqual(await f.ledger(), records); assert.equal(f.server.requests.length, 2); assert.equal(f.starts, 2);
  } finally { await f.dispose(); }
});

for (const outcomes of [['completed', 'error'], ['error', 'completed']] as const) {
  test(`historical ${outcomes[0]} receipt preserves current ${outcomes[1]} state across refresh and restart`, async () => {
    const f = await fixture([...outcomes]);
    try {
      const baseline = await runHistory(f, [...outcomes]);
      const receipt = await f.executor.send(f.id, 'First task', [], undefined, { requestId: 'historical' });
      assert.deepEqual(receipt, baseline.first);
      await assertCurrentPreserved(f, baseline);
    } finally { await f.dispose(); }
  });
}

for (const current of ['completed', 'error'] as const) for (const mismatch of ['payload', 'configuration', 'task'] as const) {
  test(`rejected historical ${mismatch} mismatch preserves current ${current} state`, async () => {
    const outcomes: [Outcome, Outcome] = ['completed', current], f = await fixture(outcomes);
    try {
      const baseline = await runHistory(f, outcomes);
      if (mismatch === 'configuration') {
        const config = structuredClone(f.store.state.sessions.find(item => item.id === f.id)!.engineConfig);
        config.options.maxOutputTokens = 1024;
        await f.executor.updateConfig(f.id, config);
      }
      const receipt = await f.executor.send(f.id, mismatch === 'payload' ? 'Changed historical input' : 'First task', [], undefined,
        { requestId: 'historical', ...(mismatch === 'task' ? { nativeTaskId: randomUUID() } : {}) });
      assert.equal(receipt.success, false); assert.match(receipt.error ?? '', /提交标识.*不同/);
      await assertCurrentPreserved(f, baseline);
    } finally { await f.dispose(); }
  });
}
