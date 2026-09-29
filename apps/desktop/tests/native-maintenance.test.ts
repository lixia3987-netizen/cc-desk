import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { runAgent, type ApprovalDecision, type ToolExecutionContext } from '@cc-desk/agent-core';
import { NativeRunStore } from '@cc-desk/agent-node/run-store';
import { ResponsesModel } from '@cc-desk/agent-node/responses-model';
import { StateStore } from '../src/main/store';
import { ExecutionEvents } from '../src/main/execution/events';
import { ConnectionStore } from '../src/main/engines/native/connections';
import { NativeStructuredExecutor, type NativeExecutorOptions } from '../src/main/engines/native/structured-executor';
import { createNativeConfig } from '../src/main/engines/native/config';
// Real HTTP/SSE fixture, shared with utilityProcess and packaged acceptance.
// @ts-expect-error Local test-only ESM fixture has no declarations.
import { startResponsesFixture, assistantMessage, functionCall } from '../../../packages/agent-node/tests/fixtures/responses-server.mjs';

type Worker = NonNullable<NativeExecutorOptions['worker']>;
type FixtureBody = { input: Array<Record<string, unknown>>; tools: unknown[]; max_output_tokens: number; instructions?: string };
type FixtureResponse = { output?: unknown[]; hang?: boolean; usage?: { input_tokens: number; output_tokens: number; total_tokens: number } };
type Handler = (request: { body: FixtureBody; index: number }) => FixtureResponse | Promise<FixtureResponse>;
const secret = 'sk-native-maintenance-test-never-persist';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const inlineWorker: Worker = options => runAgent({ ...options.request, signal: options.signal }, {
  model: new ResponsesModel(options.model), tools: options.tools, store: options.store, approvals: options.approvals,
  host: { now: Date.now, digest, emit: options.onEvent,
    deadline: (timeout, parent) => {
      const controller = new AbortController(), abort = () => controller.abort();
      const timer = setTimeout(abort, timeout); parent.addEventListener('abort', abort, { once: true });
      if (parent.aborted) abort();
      return { signal: controller.signal, dispose: () => { clearTimeout(timer); parent.removeEventListener('abort', abort); } };
    },
  },
});
const summary = '原始任务要求只修改 fixture.txt；早期修改已完成且测试通过。保留最近一轮约束；尚未完成的工作由用户在下一轮明确提出。';
const defaultHandler: Handler = ({ body, index }) => ({ output: [assistantMessage(`message-${index}`, body.tools.length ? `历史记录 ${index}：` + '已核查项目文件与约束。'.repeat(300) : summary)] });
async function fixture(options: { worker?: Worker; handler?: Handler } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-maintenance-'));
  const data = path.join(directory, 'data'), project = path.join(directory, 'project');
  await fs.mkdir(project); await fs.writeFile(path.join(project, 'fixture.txt'), 'original\n');
  await fs.writeFile(path.join(project, 'AGENTS.md'), 'Do not modify unrelated files.\n');
  const server = await startResponsesFixture({ handler: options.handler ?? defaultHandler, assertReplay: false });
  let store = new StateStore(data), executor: NativeStructuredExecutor;
  const connectionOptions = { isConnectionActive: (id: string) => executor?.isConnectionActive(id) ?? false };
  let connections = new ConnectionStore(data, connectionOptions);
  const created = connections.upsert({ name: 'local', protocol: 'responses', baseURL: server.baseURL, model: 'maintenance-fixture', allowLoopbackHttp: true, enabled: true, auth: { mode: 'memory' } });
  const connectionId = created.id;
  connections.setCredential({ id: connectionId, revision: created.revision, mode: 'memory', secret });
  const id = randomUUID(), conversationId = randomUUID(), projectId = randomUUID();
  store.change(state => {
    state.projects.push({ id: projectId, path: project, name: 'project', createdAt: new Date().toISOString() });
    state.sessions.push({ id, projectId, title: 'native maintenance', kind: 'agent', cwd: project,
      execution: { providerId: 'native', mode: 'structured', conversationId },
      engineConfig: createNativeConfig({ schemaVersion: 1, options: { connectionId } }),
      started: false, status: 'idle', archived: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  });
  const events = new ExecutionEvents();
  const worker = options.worker ?? inlineWorker;
  executor = new NativeStructuredExecutor(store, connections, events, { worker });
  await executor.initialize();
  const pending = new Set<string>();
  const unsubscribe = events.subscribe(event => {
    if (event.type !== 'conversation.changed') return;
    for (const approval of executor.snapshot(id).pending) if (!pending.has(approval.requestId)) {
      pending.add(approval.requestId);
      queueMicrotask(() => executor.respond(id, approval.requestId, { behavior: 'allow' }));
    }
  });
  const readLedger = async () => {
    const ledger = await NativeRunStore.open({ rootDirectory: path.join(data, 'native', 'conversations'), conversationId });
    try { return { records: ledger.replay(), context: ledger.loadContext(), runs: ledger.listRuns(), recovery: ledger.getRecoveryReport(), compaction: ledger.getLastCompaction() }; }
    finally { await ledger.close(); }
  };
  return { directory, data, project, id, conversationId, server, connectionId, readLedger,
    get store() { return store; }, get connections() { return connections; }, get executor() { return executor; },
    async seed() {
      for (const input of ['最初目标：只修改 fixture.txt，不能删除文件。', '第二轮：保留已完成的验证。', '最新约束：保留用户编辑并继续检查。']) {
        const result = await executor.send(id, input);
        assert.equal(result.success, true, JSON.stringify(result));
      }
      assert.equal(executor.snapshot(id).nativeContextMaintenance?.canCompact, true);
    },
    async restart(withCredential = true) {
      await executor.shutdown(); store = new StateStore(data); connections = new ConnectionStore(data, connectionOptions);
      if (withCredential) {
        const view = connections.list().connections.find(item => item.id === connectionId)!;
        connections.setCredential({ id: connectionId, revision: view.revision, mode: 'memory', secret });
      }
      executor = new NativeStructuredExecutor(store, connections, events, { worker });
      await executor.initialize();
    },
    async dispose() { unsubscribe(); await executor.shutdown().catch(() => {}); await server.close(); store.flush(); await fs.rm(directory, { recursive: true, force: true }); },
  };
}

/** Simulate worker loss around a real approved filesystem side effect, using the host-owned durable store. */
function crashWorker(persistResult: boolean): Worker {
  let crashed = false;
  return async options => {
    if (crashed) return inlineWorker(options);
    crashed = true;
    const model = new ResponsesModel(options.model), identity = options.request.identity;
    const accepted = await options.store.beginRun({ ...options.request, inputDigest: digest(options.request.input), userItems: model.userItems(options.request.input), protocol: model.protocol });
    assert.equal(accepted.kind, 'accepted');
    if (accepted.kind !== 'accepted') throw new Error('fixture expected a new run');
    const response = await model.generate({ identity, context: accepted.context, tools: options.tools.definitions, maxOutputTokens: 512, signal: options.signal, onEvent: () => {} });
    await options.store.append(identity, { type: 'model_response', response });
    const call = response.toolCalls[0];
    const context: ToolExecutionContext = { identity, policyRevision: options.request.policyRevision, signal: options.signal, maxOutputBytes: 64 * 1024 };
    const prepared = await options.tools.prepare(call, context);
    const approval: ApprovalDecision = await options.approvals.request({ binding: { ...identity, toolCallId: call.id, inputDigest: prepared.inputDigest, policyRevision: prepared.policyRevision }, tool: prepared.definition, input: prepared.input, preconditions: prepared.preconditions, expiresAt: Date.now() + 30_000 }, options.signal);
    assert.equal(approval.decision, 'approved');
    await options.store.ensureCapacity(identity, 64 * 1024);
    await options.tools.validate(prepared, context);
    await options.store.append(identity, { type: 'tool_prepared', prepared, approval });
    const result = await options.tools.execute(prepared, context, approval);
    assert.equal(result.status, 'completed');
    if (persistResult) await options.store.append(identity, { type: 'tool_completed', call, result, resultItems: model.toolResultItems(call, result) });
    throw new Error('controlled worker loss after real filesystem mutation');
  };
}
const recoveryHandler: Handler = ({ index }) => index === 0 ? {
  output: [functionCall('committed-write', 'apply_patch', { path: 'fixture.txt', expectedHash: digest('original\n'), content: 'written once\n' }),
    functionCall('never-started', 'run_command', { executable: process.execPath, argv: ['-e', 'throw Error("must never replay")'], cwd: '.' })],
} : { output: [assistantMessage(`resumed-${index}`, '依据已保存结果开始新一轮，不重放旧工具。')] };

test('safe crash recovery is explicit, durable and starts a new turn without replaying completed or never-started tools', async () => {
  const f = await fixture({ worker: crashWorker(true), handler: recoveryHandler });
  try {
    const first = await f.executor.send(f.id, '执行一次修改', [], undefined, { requestId: 'crashed-submission' });
    assert.equal(first.success, false); assert.equal(await fs.readFile(path.join(f.project, 'fixture.txt'), 'utf8'), 'written once\n');
    const view = f.executor.snapshot(f.id).nativeRecovery!;
    assert.equal(view.status, 'recoverable'); assert.deepEqual(view.tools, { completed: 1, notExecuted: 1, unknown: 0 });
    const before = await f.readLedger();
    assert.equal((await f.executor.send(f.id, '未确认前不能继续')).success, false);
    assert.equal(f.server.requests.length, 1);
    await assert.rejects(f.executor.resumeRecovery(f.id, '0'.repeat(64)));
    assert.deepEqual((await f.readLedger()).records, before.records);
    await f.executor.resumeRecovery(f.id, view.headHash);
    await f.executor.resumeRecovery(f.id, view.headHash);
    assert.equal(f.executor.recoveryRequired(f.id), false);
    const resolved = await f.readLedger();
    assert.deepEqual(resolved.records.slice(0, before.records.length), before.records);
    assert.equal(resolved.records.filter(record => record.event.type === 'recovery_resolved').length, 1);
    assert.equal(resolved.runs[0].tools.find(tool => tool.call.id === 'never-started')?.completed?.result.status, 'not_executed');
    const duplicate = await f.executor.send(f.id, '执行一次修改', [], undefined, { requestId: 'crashed-submission' });
    assert.equal(duplicate.success, false); assert.equal(f.server.requests.length, 1, 'old submission returns its durable terminal receipt');
    await f.restart();
    assert.equal(f.executor.snapshot(f.id).nativeRecovery, undefined);
    const next = await f.executor.send(f.id, '确认现场后继续', [], undefined, { requestId: 'new-submission' });
    assert.equal(next.success, true, JSON.stringify(next)); assert.equal(f.server.requests.length, 2);
    const nextInput = f.server.requests[1].input;
    assert.ok(nextInput.some((item: Record<string, unknown>) => item.type === 'function_call_output' && item.call_id === 'committed-write'));
    assert.ok(nextInput.some((item: Record<string, unknown>) => item.type === 'function_call_output' && item.call_id === 'never-started' && String(item.output).includes('not_executed')));
    assert.equal(await fs.readFile(path.join(f.project, 'fixture.txt'), 'utf8'), 'written once\n');
    assert.equal((await f.readLedger()).runs.length, 2);
    assert.deepEqual(f.server.errors, []);
  } finally { await f.dispose(); }
});

test('prepared tool with an unrecorded real side effect cannot resume, including after acknowledgement and restart', async () => {
  const f = await fixture({ worker: crashWorker(false), handler: recoveryHandler });
  try {
    assert.equal((await f.executor.send(f.id, '执行但结果丢失')).success, false);
    assert.equal(await fs.readFile(path.join(f.project, 'fixture.txt'), 'utf8'), 'written once\n');
    const view = f.executor.snapshot(f.id).nativeRecovery!;
    assert.equal(view.status, 'blocked'); assert.deepEqual(view.tools, { completed: 0, notExecuted: 1, unknown: 1 });
    const before = await f.readLedger();
    await assert.rejects(f.executor.resumeRecovery(f.id, view.headHash));
    await f.executor.confirmRecovery(f.id);
    await assert.rejects(f.executor.resumeRecovery(f.id, view.headHash));
    await f.restart();
    assert.equal(f.executor.snapshot(f.id).nativeRecovery?.status, 'acknowledged');
    assert.equal((await f.executor.send(f.id, '不得重放未知工具')).success, false);
    assert.deepEqual((await f.readLedger()).records, before.records);
    assert.equal(f.server.requests.length, 1);
  } finally { await f.dispose(); }
});

test('manual compaction makes one tool-free request and preserves raw history, first goal, latest full turn and restart idempotency', async () => {
  const f = await fixture();
  try {
    await f.seed();
    const before = await f.readLedger(), display = f.executor.snapshot(f.id).messages;
    const head = f.executor.snapshot(f.id).nativeContextMaintenance!.headHash;
    await f.executor.compactContext(f.id, head);
    const after = await f.readLedger();
    assert.equal(f.server.requests.length, 4);
    assert.deepEqual(f.server.requests[3].tools, []);
    assert.ok(f.server.requests[3].max_output_tokens <= 4096);
    assert.equal(after.runs.length, before.runs.length, 'summary work is not a task turn or extra durable submission');
    assert.deepEqual(after.records.slice(0, before.records.length), before.records, 'original journal is append-only');
    assert.deepEqual(f.executor.snapshot(f.id).messages.slice(0, display.length), display, 'display history is never replaced by the summary');
    assert.deepEqual(after.context!.items[0], before.context!.items[0]);
    assert.deepEqual(after.context!.items.slice(-2), before.context!.items.slice(-2), 'latest complete user/assistant turn remains exact');
    assert.ok(JSON.stringify(after.context).includes(summary));
    assert.ok(after.compaction!.afterBytes < after.compaction!.beforeBytes);
    assert.deepEqual(after.compaction!.usage, { inputTokens: 11, outputTokens: 7, totalTokens: 18 }, 'summary actual usage is preserved separately from task runs');
    const sentHistory = JSON.parse(String(f.server.requests[3].input[0].content)).history;
    assert.equal(JSON.stringify(sentHistory).includes('最新约束'), false, 'retained latest turn is excluded from billed summary input');
    const metrics = f.executor.snapshot(f.id).nativeContextMaintenance!.lastCompaction!;
    assert.equal(metrics.beforeBytes, after.compaction!.beforeBytes); assert.equal(metrics.afterBytes, after.compaction!.afterBytes);
    await f.executor.compactContext(f.id, head);
    assert.equal(f.server.requests.length, 4);
    await f.restart(false);
    assert.deepEqual((await f.readLedger()).context, after.context);
    assert.deepEqual(f.executor.snapshot(f.id).nativeContextMaintenance!.lastCompaction, metrics);
    await f.executor.compactContext(f.id, head);
    assert.equal(f.server.requests.length, 4, 'durable duplicate requires no credential and sends no second model request');
    assert.deepEqual((await f.readLedger()).records, after.records);
    const connection = f.connections.list().connections.find(item => item.id === f.connectionId)!;
    f.connections.setCredential({ id: connection.id, revision: connection.revision, mode: 'memory', secret });
    assert.equal((await f.executor.send(f.id, '压缩和重启后继续')).success, true);
    assert.deepEqual(f.server.requests[4].input.slice(0, after.context!.items.length), after.context!.items, 'next turn uses the restored compacted context');
    assert.equal(JSON.stringify(after.records).includes(secret), false);
    assert.deepEqual(f.server.errors, []);
  } finally { await f.dispose(); }
});

test('compaction cancellation retains resource locks through worker cleanup and leaves the original context untouched', async () => {
  let entered!: () => void, released!: () => void;
  const began = new Promise<void>(resolve => { entered = resolve; });
  const cleanup = new Promise<void>(resolve => { released = resolve; });
  const worker: Worker = async options => {
    if (options.request.configuration.purpose !== 'context_summary') return inlineWorker(options);
    const result = await inlineWorker(options);
    entered(); await cleanup; return result;
  };
  const f = await fixture({ worker });
  try {
    await f.seed(); const before = await f.readLedger();
    const head = f.executor.snapshot(f.id).nativeContextMaintenance!.headHash;
    const compact = f.executor.compactContext(f.id, head);
    const duplicate = f.executor.compactContext(f.id, head);
    assert.equal(duplicate, compact, 'same-head concurrent submissions share one operation');
    const settled = Promise.allSettled([compact, duplicate]);
    await began;
    assert.equal(f.server.requests.length, 4); assert.equal(f.executor.has(f.id), true); assert.equal(f.executor.activeCount, 1);
    assert.equal(f.executor.snapshot(f.id).nativeContextMaintenance?.compacting, true);
    assert.equal(f.executor.isConnectionActive(f.connectionId), true);
    const config = structuredClone(f.store.state.sessions.find(item => item.id === f.id)!.engineConfig);
    await assert.rejects(f.executor.updateConfig(f.id, config));
    await assert.rejects(f.executor.stopIdle(f.id));
    assert.throws(() => f.executor.forget(f.id));
    await assert.rejects(f.executor.send(f.id, '不能同时运行'));
    const connection = f.connections.list().connections.find(item => item.id === f.connectionId)!;
    assert.throws(() => f.connections.remove({ id: connection.id, revision: connection.revision }));
    f.executor.interrupt(f.id);
    assert.equal(f.executor.has(f.id), true, 'cancel intent cannot release a live worker');
    await assert.rejects(f.executor.updateConfig(f.id, config));
    await assert.rejects(f.executor.stopIdle(f.id));
    released();
    const results = await settled;
    assert.ok(results.every(result => result.status === 'rejected'));
    await f.executor.whenReleased(f.id);
    assert.equal(f.executor.has(f.id), false); assert.equal(f.executor.isConnectionActive(f.connectionId), false);
    assert.deepEqual((await f.readLedger()).records, before.records);
    assert.deepEqual((await f.readLedger()).context, before.context);
    await f.executor.updateConfig(f.id, config); await f.executor.stopIdle(f.id);
  } finally { released(); await f.dispose(); }
});

test('oversized summary input and stale expected head reject before sending a model request or changing history', async () => {
  const f = await fixture();
  try {
    await f.seed();
    const head = f.executor.snapshot(f.id).nativeContextMaintenance!.headHash;
    assert.equal((await f.executor.send(f.id, '新的一轮改变了上下文版本')).success, true);
    const before = await f.readLedger(), requests = f.server.requests.length;
    await assert.rejects(f.executor.compactContext(f.id, head));
    assert.equal(f.server.requests.length, requests);
    const config = structuredClone(f.store.state.sessions.find(item => item.id === f.id)!.engineConfig);
    config.options.maxInputTokens = 1024;
    await f.executor.updateConfig(f.id, config);
    await assert.rejects(f.executor.compactContext(f.id, f.executor.snapshot(f.id).nativeContextMaintenance!.headHash));
    assert.equal(f.server.requests.length, requests);
    assert.deepEqual((await f.readLedger()).records, before.records);
    assert.equal(f.executor.has(f.id), false);
  } finally { await f.dispose(); }
});

for (const mode of ['tool_call', 'oversized_summary'] as const) test(`invalid summary ${mode} cannot execute tools or replace the durable context`, async () => {
  const f = await fixture({ handler: request => request.body.tools.length ? defaultHandler(request) : {
    output: mode === 'tool_call'
      ? [functionCall('forbidden-summary-write', 'apply_patch', { path: 'fixture.txt', expectedHash: digest('original\n'), content: 'forbidden\n' })]
      : [assistantMessage('oversized-summary', 'x'.repeat(33 * 1024))],
  } });
  try {
    await f.seed(); const before = await f.readLedger();
    await assert.rejects(f.executor.compactContext(f.id, f.executor.snapshot(f.id).nativeContextMaintenance!.headHash));
    assert.equal(f.server.requests.length, 4, 'failed summary is not retried');
    assert.deepEqual((await f.readLedger()).records, before.records);
    assert.equal(await fs.readFile(path.join(f.project, 'fixture.txt'), 'utf8'), 'original\n');
    assert.equal(f.executor.attention().length, 0);
    assert.equal(f.executor.has(f.id), false);
    assert.deepEqual(f.server.errors, []);
  } finally { await f.dispose(); }
});
