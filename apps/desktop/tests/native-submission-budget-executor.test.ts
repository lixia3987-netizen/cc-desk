import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { runAgent } from '@cc-desk/agent-core';
import { createNativeModel } from '@cc-desk/agent-node/native-model';
import { NativeRunStore } from '@cc-desk/agent-node/run-store';
import { StateStore } from '../src/main/store';
import { ExecutionEvents } from '../src/main/execution/events';
import { ConnectionStore } from '../src/main/engines/native/connections';
import { NativeStructuredExecutor, type NativeExecutorOptions } from '../src/main/engines/native/structured-executor';
import { NativeTaskSession } from '../src/main/engines/native/task-session';
import { createNativeConfig } from '../src/main/engines/native/config';
// @ts-expect-error Local test-only protocol fixture has no declarations.
import { startResponsesFixture, functionCall, assistantMessage } from '../../../packages/agent-node/tests/fixtures/responses-server.mjs';

type AutoCompact = 'off' | 'before_send' | 'before_send_and_during_run';

async function fixture(autoCompact: AutoCompact, command = false) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-submission-budget-'));
  const data = path.join(directory, 'data'), project = path.join(directory, 'project');
  await fs.mkdir(project);
  const server = await startResponsesFixture({ assertReplay: false, handler: ({ index }: { index: number }) => {
    if (command && index === 0) return { output: [functionCall('budget-command', 'start_command', {
      executable: process.execPath, argv: ['-e', 'setTimeout(() => process.exit(0), 10)'], cwd: '.', timeoutMs: 500,
    })] };
    return { output: [assistantMessage('budget-final', 'The available operation completed.')] };
  } });
  const store = new StateStore(data), connections = new ConnectionStore(data), events = new ExecutionEvents();
  const initial = connections.upsert({ name: 'budget fixture', protocol: 'responses', baseURL: server.baseURL,
    model: 'fixture-model', enabled: true, allowLoopbackHttp: true, auth: { mode: 'memory' } });
  const connection = connections.setCredential({ id: initial.id, revision: initial.revision, mode: 'memory', secret: 'sk-submission-budget-fixture-only' });
  const id = randomUUID(), conversationId = randomUUID(), projectId = randomUUID();
  store.change(state => {
    state.projects.push({ id: projectId, name: 'budget project', path: project, createdAt: new Date().toISOString() });
    state.sessions.push({ id, projectId, title: 'submission budget', kind: 'agent', cwd: project,
      execution: { providerId: 'native', mode: 'structured', conversationId },
      engineConfig: createNativeConfig({ schemaVersion: 1, options: { connectionId: connection.id, maxActiveMs: 1000, autoCompact } }),
      started: false, archived: false, status: 'idle', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  });
  const dispatchedBudgets: number[] = [];
  const epoch = Date.now();
  const worker: NonNullable<NativeExecutorOptions['worker']> = options => {
    dispatchedBudgets.push(options.request.budget!.maxActiveMs!);
    return runAgent({ ...options.request, signal: options.signal }, {
      model: createNativeModel(options.model), tools: options.tools, store: options.store, approvals: options.approvals,
      contextMaintenance: options.contextMaintenance,
      host: { now: () => epoch + performance.now(), digest: value => createHash('sha256').update(value).digest('hex'), emit: options.onEvent,
        deadline: (ms, parent) => {
          const controller = new AbortController(), abort = () => controller.abort(), timer = setTimeout(abort, ms);
          parent.addEventListener('abort', abort, { once: true }); if (parent.aborted) abort();
          return { signal: controller.signal, dispose() { clearTimeout(timer); parent.removeEventListener('abort', abort); } };
        },
      },
    });
  };
  const executor = new NativeStructuredExecutor(store, connections, events, { worker }); await executor.initialize();
  return { id, server, executor, events, dispatchedBudgets,
    send: () => executor.send(id, 'Complete the bounded operation.', [], undefined, { requestId: 'submission-budget' }),
    async ledger() {
      const ledger = await NativeRunStore.open({ rootDirectory: path.join(data, 'native', 'conversations'), conversationId });
      try { return { runs: ledger.listRuns(), recovery: ledger.getRecoveryReport() }; } finally { await ledger.close(); }
    },
    async dispose() { await executor.shutdown().catch(() => {}); await server.close(); store.flush(); await fs.rm(directory, { recursive: true, force: true }); },
  };
}

for (const autoCompact of ['off', 'before_send', 'before_send_and_during_run'] as const) {
  test(`${autoCompact}: setup that exhausts the submission budget sends no model request without MCP`, async t => {
    const f = await fixture(autoCompact);
    let clock = 0;
    t.mock.method(performance, 'now', () => clock);
    const original = NativeTaskSession.prototype.refresh;
    t.mock.method(NativeTaskSession.prototype, 'refresh', function (this: NativeTaskSession, ledger: NativeRunStore, activeIdentity?: Parameters<NativeTaskSession['refresh']>[1]) {
      if (activeIdentity?.sessionId === f.id) clock += 1100;
      return original.call(this, ledger, activeIdentity);
    });
    try {
      const result = await f.send();
      assert.equal(f.dispatchedBudgets.length, 0, 'preflight exhaustion must stop before worker dispatch');
      assert.equal(f.server.requests.length, 0, 'an expired submission must not send a potentially billable request');
      assert.equal(result.success, false); assert.match(result.error ?? '', /时长预算/);
      assert.doesNotMatch(result.error ?? '', /自动压缩尝试已占用|摘要请求已占用/);
      assert.equal((await f.ledger()).runs.length, 0, 'no ordinary run or model attempt was started');
    } finally { await f.dispose(); }
  });

  test(`${autoCompact}: setup time is deducted from the ordinary worker budget without MCP`, async t => {
    const f = await fixture(autoCompact);
    let clock = 0;
    t.mock.method(performance, 'now', () => clock);
    const original = NativeTaskSession.prototype.refresh;
    t.mock.method(NativeTaskSession.prototype, 'refresh', function (this: NativeTaskSession, ledger: NativeRunStore, activeIdentity?: Parameters<NativeTaskSession['refresh']>[1]) {
      if (activeIdentity?.sessionId === f.id) clock += 400;
      return original.call(this, ledger, activeIdentity);
    });
    try {
      const result = await f.send();
      assert.deepEqual(f.dispatchedBudgets, [600]);
      assert.equal(result.success, true, JSON.stringify(result));
      assert.equal(f.server.requests.length, 1); assert.deepEqual(f.server.errors, []);
      assert.equal((await f.ledger()).runs[0].result!.modelRequests, 1);
    } finally { await f.dispose(); }
  });
}

test('approval waiting is excluded from the shared submission budget before a host-owned command starts', async t => {
  const f = await fixture('off', true);
  let clock = 0, approvals = 0;
  t.mock.method(performance, 'now', () => clock);
  const original = NativeTaskSession.prototype.refresh;
  t.mock.method(NativeTaskSession.prototype, 'refresh', function (this: NativeTaskSession, ledger: NativeRunStore, activeIdentity?: Parameters<NativeTaskSession['refresh']>[1]) {
    if (activeIdentity?.sessionId === f.id) clock += 400;
    return original.call(this, ledger, activeIdentity);
  });
  const seen = new Set<string>();
  const unsubscribe = f.events.subscribe(event => {
    if (event.type !== 'conversation.changed') return;
    for (const pending of f.executor.snapshot(f.id).pending) if (!seen.has(pending.requestId)) {
      seen.add(pending.requestId);
      queueMicrotask(() => { clock += 2000; approvals++; f.executor.respond(f.id, pending.requestId, { behavior: 'allow' }); });
    }
  });
  try {
    const result = await f.send();
    assert.equal(result.success, true, JSON.stringify(result)); assert.equal(approvals, 1);
    assert.deepEqual(f.dispatchedBudgets, [600]); assert.equal(f.server.requests.length, 2);
    const ledger = await f.ledger(), call = ledger.runs[0].tools.find(item => item.call.id === 'budget-command')!;
    assert.equal(call.completed?.result.status, 'completed', 'approval waiting must not exhaust host command admission');
    assert.ok(call.commandProgress?.some(event => event.status === 'running'), 'the approved command actually launched');
    assert.equal(ledger.runs[0].result!.status, 'completed'); assert.equal(ledger.recovery, null);
  } finally { unsubscribe(); await f.dispose(); }
});
