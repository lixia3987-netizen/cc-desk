import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { runAgent, type RunResult } from '@cc-desk/agent-core';
import type { NativeTaskPlan, NativeTaskSnapshot } from '@cc-desk/contracts/native-task';
import { ResponsesModel } from '@cc-desk/agent-node/responses-model';
import { StateStore } from '../src/main/store';
import { ExecutionEvents } from '../src/main/execution/events';
import { WorkflowEngine, type WorkflowEngineOptions } from '../src/main/workflows';
import { workflowNativeReceiptSchema } from '../src/main/workflow-schema';
import { ConnectionStore } from '../src/main/engines/native/connections';
import { NativeStructuredExecutor, type NativeExecutorOptions } from '../src/main/engines/native/structured-executor';
import { nativeExecutionReceipt } from '../src/main/engines/native/execution-receipt';
import { createNativeConfig } from '../src/main/engines/native/config';
// @ts-expect-error Shared local Responses protocol fixture has no declarations.
import { startResponsesFixture, functionCall, assistantMessage } from '../../../packages/agent-node/tests/fixtures/responses-server.mjs';

const plan: NativeTaskPlan = { goal: 'Check the existing file without changing it',
  steps: [{ id: 'check', title: 'Read and verify existing source', dependsOn: [], status: 'implemented' }],
  criteria: [{ id: 'content', description: 'The actual source is unchanged and its check succeeds', stepIds: ['check'], kind: 'command' }] };
const inline: NonNullable<NativeExecutorOptions['worker']> = options => runAgent({ ...options.request, signal: options.signal }, {
  model: new ResponsesModel(options.model), tools: options.tools, store: options.store, approvals: options.approvals,
  host: { now: Date.now, digest: value => createHash('sha256').update(value).digest('hex'), emit: options.onEvent, deadline: (ms, parent) => {
    const controller = new AbortController(), abort = () => controller.abort(), timer = setTimeout(abort, ms);
    parent.addEventListener('abort', abort, { once: true }); if (parent.aborted) abort();
    return { signal: controller.signal, dispose() { clearTimeout(timer); parent.removeEventListener('abort', abort); } };
  } },
});
async function fixture(options: { noPlan?: boolean } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-workflow-executor-'));
  const data = path.join(directory, 'data'), project = path.join(directory, 'project');
  await fs.mkdir(project); await fs.writeFile(path.join(project, 'source.txt'), 'existing user source\n');
  const server = await startResponsesFixture({ handler: ({ body }: { body: { input: Array<{ type: string; role?: string; call_id?: string }> } }) => {
    const turn = body.input.filter(item => item.role === 'user').length, prefix = `turn-${turn}`;
    if (options.noPlan) return { output: [assistantMessage(`${prefix}-final`, 'The model claims complete acceptance without any task or evidence.')] };
    const completed = new Set(body.input.filter(item => item.type === 'function_call_output').map(item => item.call_id));
    if (turn === 1) {
      if (!completed.has(`${prefix}-plan`)) return { output: [functionCall(`${prefix}-plan`, 'update_plan', { expectedRevision: 0, plan })] };
      if (!completed.has(`${prefix}-read`)) return { output: [functionCall(`${prefix}-read`, 'read_file', { path: 'source.txt' })] };
      if (!completed.has(`${prefix}-check`)) return { output: [functionCall(`${prefix}-check`, 'run_command', {
        executable: process.execPath, argv: ['-e', 'process.stdout.write("Check exited zero; coverage still requires human review")'], cwd: '.',
      })] };
    }
    return { output: [assistantMessage(`${prefix}-final`, 'The model claims that everything passed.')] };
  } });
  const store = new StateStore(data), connections = new ConnectionStore(data), events = new ExecutionEvents();
  const initial = connections.upsert({ name: 'workflow fixture', protocol: 'responses', baseURL: server.baseURL,
    model: 'fixture-model', enabled: true, allowLoopbackHttp: true, auth: { mode: 'memory' } });
  const connection = connections.setCredential({ id: initial.id, revision: initial.revision, mode: 'memory', secret: 'sk-workflow-fixture-only' });
  const id = randomUUID(), conversationId = randomUUID(), projectId = randomUUID();
  store.change(state => {
    state.projects.push({ id: projectId, name: 'project', path: project, createdAt: new Date().toISOString() });
    state.sessions.push({ id, projectId, title: 'workflow integration', kind: 'agent', cwd: project,
      execution: { providerId: 'native', mode: 'structured', conversationId },
      engineConfig: createNativeConfig({ schemaVersion: 1, options: { connectionId: connection.id } }),
      started: false, archived: false, status: 'idle', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  });
  let executor = new NativeStructuredExecutor(store, connections, events, { worker: inline }); await executor.initialize();
  const approved = new Set<string>();
  const unsubscribe = events.subscribe(event => {
    if (event.type !== 'conversation.changed') return;
    for (const pending of executor.snapshot(id).pending) if (!approved.has(pending.requestId)) {
      approved.add(pending.requestId); queueMicrotask(() => executor.respond(id, pending.requestId, { behavior: 'allow' }));
    }
  });
  const submissions: Array<{ prompt: string; title: string; submission: Parameters<WorkflowEngineOptions['runStage']>[3] }> = [];
  const engineOptions: WorkflowEngineOptions = {
    getSession: () => ({ sessionId: id, projectId, providerId: 'native', executionMode: 'structured', cwd: project }),
    runStage: (sessionId, prompt, title, submission) => { submissions.push({ prompt, title, submission }); return executor.send(sessionId, prompt, [], title, submission); },
    cancelSession: sessionId => executor.stop(sessionId),
    inspectNativeTask: receipt => executor.inspectTaskReceipt(receipt),
  };
  let engine = new WorkflowEngine(data, engineOptions);
  const create = (dependent = false) => engine.create({ sessionId: id, goal: plan.goal, stages: [
    { id: 'check', title: 'Check', instruction: 'Read the actual file and check it', gate: 'native_task', criterionIds: ['content'] },
    ...(dependent ? [{ id: 'review', title: 'Review', instruction: 'Review the previous real output', dependsOn: ['check'] }] : []),
  ] });
  const review = async () => {
    const task = executor.snapshot(id).nativeTask!;
    await executor.reviewTask(id, { taskId: task.taskId, expectedRevision: task.revision,
      expectedWorkspaceFingerprint: task.workspace!.current.fingerprint, decision: 'passed', criterionId: 'content',
      reason: 'Reviewed the actual unchanged source and command scope; exit zero alone was insufficient.' });
  };
  return { id, project, server, create, review, get executor() { return executor; }, get engine() { return engine; },
    duplicateFirst: () => { const { prompt, title, submission } = submissions[0]; return executor.send(id, prompt, [], title, submission); },
    async restart() { await engine.shutdown(); await executor.shutdown(); executor = new NativeStructuredExecutor(store, connections, events, { worker: inline });
      await executor.initialize(); engine = new WorkflowEngine(data, engineOptions); },
    async dispose() { unsubscribe(); await engine.shutdown(); await executor.shutdown(); await server.close(); store.flush(); await fs.rm(directory, { recursive: true, force: true }); },
  };
}

test('Native executor receipts gate actual workflow stages across restart without treating model claims or exit zero as acceptance', async () => {
  const f = await fixture();
  try {
    const run = f.create(true); f.engine.start(run.id);
    const waiting = await f.engine.wait(run.id), receipt = waiting.stages[0].nativeReceipts?.[0];
    assert.equal(waiting.status, 'waiting_verification'); assert.ok(receipt, 'the actual Native executor must attach a host receipt');
    assert.equal(workflowNativeReceiptSchema.safeParse(receipt).success, true);
    assert.equal(receipt.identity.requestId, `workflow:${run.id}:check:1`);
    assert.equal(receipt.taskId, f.executor.snapshot(f.id).nativeTask!.taskId);
    assert.equal(receipt.evidence[0].source, 'command'); assert.equal(receipt.evidence[0].exitCode, 0); assert.equal(receipt.evidence[0].status, 'unverified');
    const requests = f.server.requests.length;
    assert.equal((await f.engine.verifyStage({ id: run.id, stageId: 'check', expectedAttempt: 1 })).status, 'waiting_verification');
    assert.equal(f.server.requests.length, requests);
    await f.restart();
    assert.deepEqual(f.engine.list()[0].stages[0].nativeReceipts, [receipt]);
    await f.review();
    const duplicate = await f.duplicateFirst();
    assert.deepEqual(duplicate.nativeReceipt, receipt, 'duplicate dispatch returns the immutable original receipt after human evidence changes');
    assert.equal(f.server.requests.length, requests);
    assert.equal((await f.engine.verifyStage({ id: run.id, stageId: 'check', expectedAttempt: 1 })).status, 'paused');
    assert.equal(f.server.requests.length, requests, 'human verification cannot repeat the model or command');
    f.engine.continue(run.id); const done = await f.engine.wait(run.id);
    assert.equal(done.status, 'completed'); assert.deepEqual(done.stages.map(stage => stage.attempts), [1, 1]);
    assert.equal(f.server.requests.length, requests + 1);
    assert.equal(done.stages[1].nativeReceipts?.[0].taskId, undefined, 'an unplanned follow-up cannot reuse the previous task binding');
    assert.equal(await fs.readFile(path.join(f.project, 'source.txt'), 'utf8'), 'existing user source\n');
    assert.deepEqual(f.server.errors, []);
  } finally { await f.dispose(); }
});

test('a Native execution without a task plan cannot satisfy a task gate using its final text', async () => {
  const f = await fixture({ noPlan: true });
  try {
    const run = f.create(); f.engine.start(run.id);
    const waiting = await f.engine.wait(run.id);
    assert.equal(waiting.status, 'waiting_verification'); assert.ok(waiting.stages[0].nativeReceipts?.[0]);
    assert.equal(waiting.stages[0].taskId, undefined);
    const inspected = await f.engine.verifyStage({ id: run.id, stageId: 'check', expectedAttempt: 1 });
    assert.equal(inspected.status, 'waiting_verification'); assert.match(inspected.stages[0].gateReason!, /未记录可核查/);
    assert.equal(f.server.requests.length, 1); assert.equal(f.executor.snapshot(f.id).nativeTask, undefined);
  } finally { await f.dispose(); }
});

test('Native workflow verification refreshes files and refuses stale manual evidence without dispatching any task again', async () => {
  const f = await fixture();
  try {
    const run = f.create(); f.engine.start(run.id); await f.engine.wait(run.id); await f.review();
    const requests = f.server.requests.length;
    await fs.writeFile(path.join(f.project, 'source.txt'), 'external change after review\n');
    const waiting = await f.engine.verifyStage({ id: run.id, stageId: 'check', expectedAttempt: 1 });
    assert.equal(waiting.status, 'waiting_verification'); assert.match(waiting.stages[0].gateReason!, /工作区/);
    assert.ok(f.executor.snapshot(f.id).nativeTask!.evidence.every(item => item.stale));
    assert.equal(f.server.requests.length, requests);
    await f.restart();
    assert.equal(f.engine.list()[0].status, 'waiting_verification');
    assert.equal(f.server.requests.length, requests);
  } finally { await f.dispose(); }
});

test('cancelling a Native verification wait blocks retry, continue and stale approval without repeating committed commands', async () => {
  const f = await fixture();
  try {
    const run = f.create(); f.engine.start(run.id); await f.engine.wait(run.id);
    const requests = f.server.requests.length;
    await f.engine.cancel(run.id); await f.restart();
    assert.equal(f.engine.list()[0].status, 'cancelled');
    assert.throws(() => f.engine.retry(run.id)); assert.throws(() => f.engine.continue(run.id));
    await assert.rejects(f.engine.verifyStage({ id: run.id, stageId: 'check', expectedAttempt: 1 }), /状态已变化/);
    assert.equal(f.server.requests.length, requests); assert.deepEqual(f.server.errors, []);
  } finally { await f.dispose(); }
});

function receiptFixture(): { result: RunResult; task: NativeTaskSnapshot } {
  const identity = { sessionId: randomUUID(), conversationId: randomUUID(), runId: randomUUID(), requestId: 'workflow:receipt:check:1', workerGeneration: 1 };
  const at = new Date().toISOString(), fingerprint = 'a'.repeat(64);
  const workspace = { fingerprint, complete: true, rootFingerprint: fingerprint, files: [], scope: ['.'], issues: [], capturedAt: at };
  return { result: { identity, status: 'completed', reason: 'model_completed', modelRequests: 1, toolCalls: 1, usage: null, context: { protocol: { id: 'openai-responses', version: 1 }, items: [] }, committed: true },
    task: { ...plan, schemaVersion: 1, taskId: randomUUID(), identity, revision: 1, planRevision: 1, acceptanceRevision: 1,
      execution: 'ended', verification: 'unverified', evidence: [], workspace: { baseline: workspace, current: workspace,
        changes: { added: [], modified: [], removed: [], complete: true, truncated: false, attribution: 'observed_since_task_start' } },
      history: [{ revision: 1, mutationId: randomUUID(), kind: 'plan', runId: identity.runId, at, summary: 'Plan created' }], createdAt: at, updatedAt: at } };
}

test('host workflow receipts reject tasks with any mismatched execution identity component', () => {
  const { result, task } = receiptFixture();
  for (const key of ['sessionId', 'conversationId', 'runId', 'requestId', 'workerGeneration'] as const) {
    const identity = { ...task.identity, [key]: key === 'workerGeneration' ? 2 : randomUUID() };
    const receipt = nativeExecutionReceipt(result, { ...task, identity }, 20);
    assert.equal(receipt.taskId, undefined, key); assert.deepEqual(receipt.criteria, []); assert.deepEqual(receipt.evidence, []);
    assert.deepEqual(receipt.identity, result.identity); assert.equal(workflowNativeReceiptSchema.safeParse(receipt).success, true);
  }
});

test('host workflow receipts bound valid large command metadata to the consumer size and argv limits', () => {
  for (const argv of [Array.from({ length: 256 }, () => 'arg'), Array.from({ length: 64 }, () => '界'.repeat(1000))]) {
    const { result, task } = receiptFixture();
    task.evidence = [{ id: 'command', identity: task.identity, source: 'command', status: 'unverified', criterionIds: ['content'], stepIds: ['check'],
      planRevision: 1, acceptanceRevision: 1, workspaceFingerprint: task.workspace!.current.fingerprint, workspaceComplete: true,
      toolCallId: 'command', command: { executable: 'node', argv, cwd: '.' }, exitCode: 0, createdAt: task.createdAt }];
    const receipt = nativeExecutionReceipt(result, task, 20);
    assert.equal(workflowNativeReceiptSchema.safeParse(receipt).success, true, 'valid task evidence needs a valid bounded workflow receipt');
    assert.ok(Buffer.byteLength(JSON.stringify(receipt)) <= 64 * 1024); assert.equal(receipt.truncated, true);
    assert.equal(receipt.taskId, task.taskId); assert.equal(receipt.criteria[0].id, 'content');
    assert.equal('output' in (receipt.evidence[0] ?? {}), false);
  }
});

test('UTF-8 criterion and change projections fit 64 KiB while recording omission explicitly', () => {
  const { result, task } = receiptFixture();
  task.criteria = Array.from({ length: 64 }, (_, index) => ({ id: `criterion-${index}`, description: '界'.repeat(1000), kind: 'manual', stepIds: ['check'] }));
  task.workspace!.changes.modified = Array.from({ length: 64 }, (_, index) => `src/${index}-${'界'.repeat(1000)}.ts`);
  const original = JSON.stringify(task), receipt = nativeExecutionReceipt(result, task, 20);
  assert.equal(workflowNativeReceiptSchema.safeParse(receipt).success, true);
  assert.ok(Buffer.byteLength(JSON.stringify(receipt)) <= 64 * 1024); assert.equal(receipt.truncated, true);
  assert.equal(receipt.changes?.truncated, true); assert.ok(receipt.criteria.length < task.criteria.length);
  assert.equal(JSON.stringify(task), original, 'bounding a host receipt cannot alter authoritative evidence or workspace records');
});
