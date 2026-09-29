import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { runAgent } from '@cc-desk/agent-core';
import type { NativeTaskPlan } from '@cc-desk/contracts/native-task';
import { ResponsesModel } from '@cc-desk/agent-node/responses-model';
import { NativeRunStore } from '@cc-desk/agent-node/run-store';
import { NativeTaskStore } from '@cc-desk/agent-node/task-store';
import { StateStore } from '../src/main/store';
import { ExecutionEvents } from '../src/main/execution/events';
import { ConnectionStore } from '../src/main/engines/native/connections';
import { NativeStructuredExecutor, type NativeExecutorOptions } from '../src/main/engines/native/structured-executor';
import { createNativeConfig } from '../src/main/engines/native/config';
import type { NativeTaskReviewInput } from '../src/shared/native-task';
// @ts-expect-error Shared local Responses protocol fixture has no declarations.
import { startResponsesFixture, functionCall, assistantMessage } from '../../../packages/agent-node/tests/fixtures/responses-server.mjs';

const secret = 'sk-native-task-fixture-never-display';
const targetContent = 'existing user content\nimplemented feature\n';
const plan = (implemented = false): NativeTaskPlan => ({
  goal: 'Implement one change and report its actual verification',
  steps: [{ id: 'implement', title: 'Implement and check the feature', dependsOn: [], status: implemented ? 'implemented' : 'in_progress' }],
  criteria: [
    { id: 'command', description: 'Feature content check exits successfully', stepIds: ['implement'], kind: 'command' },
    { id: 'scope', description: 'Review scope and preservation of existing user edits', stepIds: ['implement'], kind: 'manual' },
  ],
});
type ResponseItem = { type: string; call_id?: string; output?: string; role?: string; content?: string };
function results(body: { input: ResponseItem[] }): Map<string, any> {
  return new Map(body.input.filter(item => item.type === 'function_call_output').map(item => [item.call_id!, JSON.parse(item.output!)]));
}
const inline: NonNullable<NativeExecutorOptions['worker']> = options => runAgent({ ...options.request, signal: options.signal }, {
  model: new ResponsesModel(options.model), tools: options.tools, store: options.store, approvals: options.approvals,
  host: { now: Date.now, digest: value => createHash('sha256').update(value).digest('hex'), emit: options.onEvent, deadline: (ms, parent) => {
    const controller = new AbortController(), abort = () => controller.abort(), timer = setTimeout(abort, ms);
    parent.addEventListener('abort', abort, { once: true }); if (parent.aborted) abort();
    return { signal: controller.signal, dispose() { clearTimeout(timer); parent.removeEventListener('abort', abort); } };
  } },
});
async function fixture(options: { qa?: boolean; stalePlan?: boolean; failingCommand?: boolean; planAfterWrite?: boolean } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-task-executor-')), data = path.join(directory, 'data'), project = path.join(directory, 'project');
  await fs.mkdir(project); await fs.writeFile(path.join(project, 'feature.txt'), 'existing user content\n');
  await fs.writeFile(path.join(project, 'pre-existing.txt'), 'pre-existing unrelated edits\n');
  const command = { executable: process.execPath, argv: ['-e', options.failingCommand ? 'process.stdout.write("PASS text cannot override failure");process.exitCode=7'
    : `const fs=require('node:fs');if(fs.readFileSync('feature.txt','utf8')!==${JSON.stringify(targetContent)})process.exitCode=1;else process.stdout.write('content-check-passed')`], cwd: '.' };
  const server = await startResponsesFixture({ handler: ({ body }: { body: { input: ResponseItem[] } }) => {
    const turn = body.input.filter(item => item.role === 'user').length, prefix = `t${turn}`, done = results(body);
    const call = (name: string, tool: string, input: unknown) => ({ output: [functionCall(`${prefix}-${name}`, tool, input)] });
    if (options.qa) return { output: [assistantMessage(`${prefix}-final`, '简单问答不需要任务计划。')] };
    if (turn > 1) return !done.has(`${prefix}-continue-read`) ? call('continue-read', 'read_task', {})
      : { output: [assistantMessage(`${prefix}-final`, '已读取用户明确选择继续的任务。')] };
    if (!options.planAfterWrite && !done.has(`${prefix}-plan`)) return call('plan', 'update_plan', { expectedRevision: 0, plan: plan() });
    if (!done.has(`${prefix}-read`)) return call('read', 'read_file', { path: 'feature.txt' });
    if (!done.has(`${prefix}-write`)) return call('write', 'apply_patch', { path: 'feature.txt', content: targetContent, expectedHash: done.get(`${prefix}-read`).output.hash });
    if (options.planAfterWrite && !done.has(`${prefix}-plan`)) return call('plan', 'update_plan', { expectedRevision: 0, plan: plan() });
    if (!done.has(`${prefix}-command`)) return call('command', 'run_command', command);
    if (options.stalePlan && !done.has(`${prefix}-stale-plan`)) return call('stale-plan', 'update_plan', { expectedRevision: 0, plan: { ...plan(), goal: 'STALE_GOAL_MUST_NOT_WIN' } });
    if (!done.has(`${prefix}-read-task`)) return call('read-task', 'read_task', {});
    if (done.get(`${prefix}-read-task`).status !== 'completed') return { output: [assistantMessage(`${prefix}-final`, '任务记录当前不可用，已保存的工具结果保留；请刷新核查。')] };
    if (!done.has(`${prefix}-implemented`)) return call('implemented', 'update_plan', { expectedRevision: done.get(`${prefix}-read-task`).output.task.revision, plan: plan(true) });
    return { output: [assistantMessage(`${prefix}-final`, '模型声称已全部完成并且验收通过。')] };
  } });
  const store = new StateStore(data), connections = new ConnectionStore(data), events = new ExecutionEvents();
  const initial = connections.upsert({ name: 'task fixture', protocol: 'responses', baseURL: server.baseURL, model: 'fixture-model', enabled: true, allowLoopbackHttp: true, auth: { mode: 'memory' } });
  const connection = connections.setCredential({ id: initial.id, revision: initial.revision, mode: 'memory', secret });
  const id = randomUUID(), conversationId = randomUUID(), projectId = randomUUID();
  store.change(state => {
    state.projects.push({ id: projectId, name: 'project', path: project, createdAt: new Date().toISOString() });
    state.sessions.push({ id, projectId, title: 'tasks', kind: 'agent', cwd: project, execution: { providerId: 'native', mode: 'structured', conversationId }, engineConfig: createNativeConfig({ schemaVersion: 1, options: { connectionId: connection.id } }), started: false, archived: false, status: 'idle', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  });
  let executor = new NativeStructuredExecutor(store, connections, events, { worker: inline }); await executor.initialize();
  const approved = new Set<string>(), approvals: string[] = [];
  const approve = (behavior: 'allow' | 'deny' = 'allow') => events.subscribe(event => {
    if (event.type !== 'conversation.changed') return;
    for (const pending of executor.snapshot(id).pending) if (!approved.has(pending.requestId)) {
      approved.add(pending.requestId); approvals.push(pending.toolName ?? 'unknown');
      queueMicrotask(() => { executor.respond(id, pending.requestId, { behavior }); });
    }
  });
  const pending = async () => {
    for (let count = 0; count < 500; count++) { const value = executor.snapshot(id).pending[0]; if (value) return value; await new Promise(resolve => setTimeout(resolve, 5)); }
    throw new Error('Task fixture did not reach a pending permission');
  };
  const review = async (decision: NativeTaskReviewInput['decision'], criterionId?: string, reason = 'Reviewed actual files, command receipt, coverage and remaining limitations.') => {
    const task = executor.snapshot(id).nativeTask!;
    return executor.reviewTask(id, { taskId: task.taskId, expectedRevision: task.revision,
      expectedWorkspaceFingerprint: task.workspace!.current.fingerprint, decision, ...(criterionId ? { criterionId } : {}), reason });
  };
  return { id, directory, data, project, conversationId, store, server, approve, approvals, pending, review, command,
    get executor() { return executor; },
    async restart() { await executor.shutdown(); executor = new NativeStructuredExecutor(store, connections, events, { worker: inline }); await executor.initialize(); },
    async dispose() { await executor.shutdown().catch(() => {}); await server.close(); store.flush(); await fs.rm(directory, { recursive: true, force: true }); },
  };
}

test('simple native questions remain plan-free through completion and restart', async () => {
  const f = await fixture({ qa: true });
  try {
    const result = await f.executor.send(f.id, '解释一个概念', [], undefined, { requestId: 'simple' });
    assert.equal(result.success, true); assert.equal(f.executor.snapshot(f.id).nativeTask, undefined);
    await f.restart(); assert.equal(f.executor.snapshot(f.id).nativeTask, undefined);
    assert.equal(f.server.requests.length, 1);
  } finally { await f.dispose(); }
});

test('real plan/write/command flow separates execution and verification, rejects stale plans and preserves user edits', async () => {
  const f = await fixture({ stalePlan: true }), unsubscribe = f.approve();
  try {
    const result = await f.executor.send(f.id, '执行工程任务', [], undefined, { requestId: 'engineering' });
    assert.equal(result.success, true, JSON.stringify(result)); assert.deepEqual(f.server.errors, []);
    const task = f.executor.snapshot(f.id).nativeTask!;
    assert.ok(task); assert.equal(task.execution, 'ended'); assert.equal(task.runOutcome, 'completed');
    assert.equal(task.verification, 'unverified', 'model final text and exit zero never prove task acceptance');
    assert.equal(task.steps[0].status, 'implemented'); assert.equal(task.goal, plan().goal);
    assert.deepEqual(f.approvals, ['apply_patch', 'run_command'], 'planning cannot approve a write or command');
    assert.equal(await fs.readFile(path.join(f.project, 'feature.txt'), 'utf8'), targetContent);
    assert.equal(await fs.readFile(path.join(f.project, 'pre-existing.txt'), 'utf8'), 'pre-existing unrelated edits\n');
    assert.deepEqual(task.workspace?.changes.modified, ['feature.txt']);
    const evidence = task.evidence.find(item => item.source === 'command')!;
    assert.ok(evidence); assert.deepEqual(evidence.command, f.command); assert.equal(evidence.exitCode, 0);
    assert.equal(evidence.status, 'unverified'); assert.equal(evidence.toolCallId, 't1-command');
    assert.equal(evidence.workspaceComplete, true); assert.match(evidence.output!, /content-check-passed/);
    assert.equal(task.evidence.length, 1, 'reads and plan updates do not become command evidence');
    const recorded = results(f.server.requests.at(-1));
    assert.equal(recorded.get('t1-stale-plan').status, 'failed');
    assert.equal(recorded.get('t1-implemented').status, 'completed');
    assert.equal(JSON.stringify(task).includes(secret), false);
    const ledger = await NativeRunStore.open({ rootDirectory: path.join(f.data, 'native', 'conversations'), conversationId: f.conversationId });
    try { assert.equal(ledger.listRuns()[0].result?.status, 'completed'); assert.equal(JSON.stringify(ledger.replay()).includes(secret), false); }
    finally { await ledger.close(); }
  } finally { unsubscribe(); await f.dispose(); }
});

test('criterion confirmations plus overall review are version-bound, survive restart and expire after external edits', async () => {
  const f = await fixture(), unsubscribe = f.approve();
  try {
    assert.equal((await f.executor.send(f.id, '执行并人工验收', [], undefined, { requestId: 'review' })).success, true);
    await f.review('passed', 'command');
    assert.notEqual(f.executor.snapshot(f.id).nativeTask!.verification, 'passed');
    await f.review('passed', 'scope');
    assert.notEqual(f.executor.snapshot(f.id).nativeTask!.verification, 'passed', 'individual conditions still need overall coverage review');
    await f.review('approve');
    const approved = f.executor.snapshot(f.id).nativeTask!;
    assert.equal(approved.verification, 'passed');
    await f.restart(); assert.deepEqual(f.executor.snapshot(f.id).nativeTask, approved);
    await fs.writeFile(path.join(f.project, 'feature.txt'), 'external change after verification');
    await f.executor.hydrate(f.id);
    const changed = f.executor.snapshot(f.id).nativeTask!;
    assert.equal(changed.verification, 'stale'); assert.equal(changed.review, undefined);
    assert.ok(changed.evidence.every(item => item.stale));
    assert.notEqual(changed.workspace?.current.fingerprint, approved.workspace?.current.fingerprint);
    await assert.rejects(f.executor.reviewTask(f.id, { taskId: approved.taskId, expectedRevision: approved.revision,
      expectedWorkspaceFingerprint: approved.workspace!.current.fingerprint, decision: 'approve', reason: 'stale review rejected' }));
    assert.equal(f.server.requests.length, 7, 'verification and refresh do not ask the model or rerun commands');
  } finally { unsubscribe(); await f.dispose(); }
});

test('explicit task continuation rebinds one task while duplicate submissions cannot switch identity or replay effects', async () => {
  const f = await fixture(), unsubscribe = f.approve();
  try {
    const first = await f.executor.send(f.id, '创建任务', [], undefined, { requestId: 'first' }); assert.equal(first.success, true);
    const task = f.executor.snapshot(f.id).nativeTask!, count = f.server.requests.length;
    await f.restart();
    assert.equal((await f.executor.send(f.id, '创建任务', [], undefined, { requestId: 'first' })).success, true);
    assert.equal(f.server.requests.length, count);
    const changedReplay = await f.executor.send(f.id, '创建任务', [], undefined, { requestId: 'first', nativeTaskId: task.taskId });
    assert.equal(changedReplay.success, false); assert.equal(f.server.requests.length, count);
    assert.equal((await f.executor.send(f.id, '继续这个任务', [], undefined, { requestId: 'continue', nativeTaskId: task.taskId })).success, true);
    const continued = f.executor.snapshot(f.id).nativeTask!;
    assert.equal(continued.taskId, task.taskId); assert.notEqual(continued.identity.runId, task.identity.runId);
    assert.equal(continued.identity.requestId, 'continue'); assert.equal(continued.execution, 'ended');
    assert.equal(continued.evidence.filter(item => item.source === 'command').length, 1, 'continuation reads task state without repeating its command');
    assert.equal(f.approvals.length, 2); assert.equal(f.server.requests.length, count + 2);
    const continuedResult = results(f.server.requests.at(-1)).get('t2-continue-read');
    assert.equal(continuedResult.output.task.taskId, task.taskId);
    const mismatched = await f.executor.send(f.id, '继续这个任务', [], undefined, { requestId: 'continue', nativeTaskId: randomUUID() });
    assert.equal(mismatched.success, false); assert.equal(f.server.requests.length, count + 2);
  } finally { unsubscribe(); await f.dispose(); }
});

test('cancellation while awaiting an effect preserves interrupted task state and refuses the late permission', async () => {
  const f = await fixture();
  try {
    const running = f.executor.send(f.id, '取消工程任务', [], undefined, { requestId: 'cancel' });
    const pending = await f.pending(); assert.equal(pending.toolName, 'apply_patch');
    assert.equal(f.executor.snapshot(f.id).nativeTask?.execution, 'active');
    await f.executor.stop(f.id); assert.equal((await running).interrupted, true);
    assert.throws(() => f.executor.respond(f.id, pending.requestId, { behavior: 'allow' }));
    assert.equal(await fs.readFile(path.join(f.project, 'feature.txt'), 'utf8'), 'existing user content\n');
    const task = f.executor.snapshot(f.id).nativeTask!;
    assert.notEqual(task.execution, 'active'); assert.equal(task.runOutcome, 'cancelled');
    assert.equal(task.steps[0].status, 'interrupted'); assert.notEqual(task.verification, 'passed');
    const count = f.server.requests.length;
    await f.restart(); assert.deepEqual(f.executor.snapshot(f.id).nativeTask, task); assert.equal(f.server.requests.length, count);
  } finally { await f.dispose(); }
});

test('a failed real command remains a failed check even when the model claims success', async () => {
  const f = await fixture({ failingCommand: true }), unsubscribe = f.approve();
  try {
    assert.equal((await f.executor.send(f.id, '保留失败证据')).success, true, 'operational completion remains compatible with queue acknowledgement');
    const task = f.executor.snapshot(f.id).nativeTask!, evidence = task.evidence.find(item => item.source === 'command')!;
    assert.equal(evidence.exitCode, 7); assert.equal(evidence.status, 'failed'); assert.notEqual(task.verification, 'passed');
    assert.match(evidence.output!, /PASS text/);
  } finally { unsubscribe(); await f.dispose(); }
});

test('task-plan persistence failure cannot report a successful plan or execute following effects', async () => {
  const f = await fixture(), original = NativeTaskStore.prototype.apply;
  try {
    NativeTaskStore.prototype.apply = async function (update, options) {
      if (update.mutation.type === 'plan') throw new Error('injected task storage failure');
      return original.call(this, update, options);
    };
    const result = await f.executor.send(f.id, '验证计划写盘失败');
    assert.equal(result.success, false); assert.equal(f.executor.snapshot(f.id).nativeTask, undefined);
    assert.equal(f.server.requests.length, 1, 'unknown plan persistence stops before another model request');
    assert.equal(await fs.readFile(path.join(f.project, 'feature.txt'), 'utf8'), 'existing user content\n');
    assert.equal(f.executor.snapshot(f.id).pending.length, 0);
  } finally { NativeTaskStore.prototype.apply = original; await f.dispose(); }
});

for (const failedMutation of ['finish', 'evidence'] as const) test(`a failed ${failedMutation} observer preserves the committed execution result and exposes unknown task status until refresh`, async () => {
  const f = await fixture(), unsubscribe = f.approve(), original = NativeTaskStore.prototype.apply;
  let injected = false;
  try {
    NativeTaskStore.prototype.apply = async function (update, options) {
      if (!injected && update.mutation.type === failedMutation) { injected = true; throw new Error(`injected ${failedMutation} observation failure`); }
      return original.call(this, update, options);
    };
    const result = await f.executor.send(f.id, '任务证据故障不改变队列执行回执', [], undefined, { requestId: `observer-${failedMutation}` });
    assert.equal(injected, true); assert.equal(result.success, true, JSON.stringify(result));
    assert.match(f.executor.snapshot(f.id).nativeTaskError!, /未知|不可用/);
    assert.equal(f.executor.snapshot(f.id).nativeTask, undefined);
    assert.equal(await fs.readFile(path.join(f.project, 'feature.txt'), 'utf8'), targetContent);
    const count = f.server.requests.length;
    NativeTaskStore.prototype.apply = original;
    await f.executor.hydrate(f.id);
    const refreshed = f.executor.snapshot(f.id);
    assert.equal(refreshed.nativeTaskError, undefined); assert.equal(refreshed.nativeTask?.execution, 'ended');
    assert.notEqual(refreshed.nativeTask?.verification, 'passed'); assert.equal(f.server.requests.length, count);
    assert.equal((await f.executor.send(f.id, '任务证据故障不改变队列执行回执', [], undefined, { requestId: `observer-${failedMutation}` })).success, true);
    assert.equal(f.server.requests.length, count); assert.equal(f.approvals.length, 2);
  } finally { NativeTaskStore.prototype.apply = original; unsubscribe(); await f.dispose(); }
});

test('a plan created after an approved edit still accounts for changes since the run began', async () => {
  const f = await fixture({ planAfterWrite: true }), unsubscribe = f.approve();
  try {
    assert.equal((await f.executor.send(f.id, '先检查修改，再整理任务计划')).success, true);
    assert.deepEqual(f.executor.snapshot(f.id).nativeTask?.workspace?.changes.modified, ['feature.txt']);
  } finally { unsubscribe(); await f.dispose(); }
});

test('metadata cleanup failure preserves the execution ACK and stop retries only the retained writer release', async () => {
  const f = await fixture(), unsubscribe = f.approve(), original = NativeTaskStore.prototype.close;
  let injected = false;
  try {
    NativeTaskStore.prototype.close = async function () {
      if (!injected) { injected = true; throw new Error('temporary task writer release failure'); }
      return original.call(this);
    };
    const result = await f.executor.send(f.id, '完成后模拟任务记录锁释放失败', [], undefined, { requestId: 'metadata-close' });
    assert.equal(injected, true); assert.equal(result.success, true, 'durable execution ACK must not become a failed queue item');
    assert.equal(f.executor.has(f.id), true); assert.equal(f.executor.recoveryRequired(f.id), true);
    assert.match(f.executor.snapshot(f.id).nativeTaskError!, /关闭/);
    const count = f.server.requests.length;
    await f.executor.stopAndWait(f.id);
    assert.equal(f.executor.has(f.id), false); assert.equal(f.executor.recoveryRequired(f.id), false);
    assert.equal(f.executor.snapshot(f.id).nativeTaskError, undefined);
    assert.equal(f.executor.snapshot(f.id).nativeTask?.execution, 'ended');
    assert.equal(f.server.requests.length, count, 'release retry must not restart the worker or its effects');
    assert.equal((await f.executor.send(f.id, '完成后模拟任务记录锁释放失败', [], undefined, { requestId: 'metadata-close' })).success, true);
    assert.equal(f.server.requests.length, count);
  } finally { NativeTaskStore.prototype.close = original; unsubscribe(); await f.dispose(); }
});

test('a failed idle review writer close remains owned until an explicit stop releases it', async () => {
  const f = await fixture(), unsubscribe = f.approve(), original = NativeTaskStore.prototype.close;
  let injected = false;
  try {
    assert.equal((await f.executor.send(f.id, '复核资源释放边界')).success, true);
    NativeTaskStore.prototype.close = async function () {
      if (!injected) { injected = true; throw new Error('review task writer release failure'); }
      return original.call(this);
    };
    await assert.rejects(f.review('passed', 'command'), /release failure/);
    assert.equal(f.executor.has(f.id), true);
    assert.throws(() => f.executor.forget(f.id), /资源|恢复/);
    await assert.rejects(f.executor.send(f.id, '不得在未释放的任务记录上继续'), /写入资源/);
    const count = f.server.requests.length;
    await f.executor.stopAndWait(f.id);
    assert.equal(f.executor.has(f.id), false);
    await f.executor.hydrate(f.id);
    assert.equal(f.executor.snapshot(f.id).nativeTaskError, undefined);
    assert.notEqual(f.executor.snapshot(f.id).nativeTask?.verification, 'passed');
    assert.equal(f.server.requests.length, count);
  } finally { NativeTaskStore.prototype.close = original; unsubscribe(); await f.dispose(); }
});
