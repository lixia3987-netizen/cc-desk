import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { runAgent, type ApprovalRequest, type RunBudget, type ToolExecutionContext } from '@cc-desk/agent-core';
import { ResponsesModel } from '@cc-desk/agent-node/responses-model';
import { NativeRunStore } from '@cc-desk/agent-node/run-store';
import { StateStore } from '../src/main/store';
import { ExecutionEvents } from '../src/main/execution/events';
import { ConnectionStore } from '../src/main/engines/native/connections';
import { NativeStructuredExecutor, type NativeExecutorOptions } from '../src/main/engines/native/structured-executor';
import { createQuestionTool } from '../src/main/engines/native/question-tool';
import { createNativeConfig } from '../src/main/engines/native/config';
// @ts-expect-error Shared local protocol fixture has no declarations.
import { startResponsesFixture, functionCall, assistantMessage } from '../../../packages/agent-node/tests/fixtures/responses-server.mjs';

const secret = 'sk-question-fixture-never-display';
const input = { questions: [{ question: '采用哪个方案？', options: [{ label: 'A', description: '方案 A' }, { label: 'B' }] }] };
const answers = { '采用哪个方案？': 'B，保留现有兼容行为。' };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const inline = (budget: Partial<RunBudget> = {}): NonNullable<NativeExecutorOptions['worker']> => options => runAgent({ ...options.request, budget: { ...options.request.budget, ...budget }, signal: options.signal }, {
  model: new ResponsesModel(options.model), tools: options.tools, store: options.store, approvals: options.approvals,
  host: { now: Date.now, digest: hash, emit: options.onEvent, deadline: (ms, parent) => {
    const controller = new AbortController(), abort = () => controller.abort(), timer = setTimeout(abort, ms);
    parent.addEventListener('abort', abort, { once: true }); if (parent.aborted) abort();
    return { signal: controller.signal, dispose() { clearTimeout(timer); parent.removeEventListener('abort', abort); } };
  } },
});
async function fixture(options: { write?: boolean; repeat?: boolean; crashAfterPrepared?: boolean; budget?: Partial<RunBudget> } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-questions-')), data = path.join(directory, 'data'), project = path.join(directory, 'project');
  await fs.mkdir(project);
  const server = await startResponsesFixture({ handler: ({ index }: { index: number }) => ({ output: index === 0
    ? [functionCall('question-1', 'ask_user', input)] : index === 1 && options.repeat
    ? [functionCall('question-2', 'ask_user', input)] : index === 1 && options.write
    ? [functionCall('write-1', 'apply_patch', { path: 'answer.txt', content: 'approved answer\n', expectedHash: null })]
    : [assistantMessage('final', '已记录回答。')] }) });
  const store = new StateStore(data), connections = new ConnectionStore(data), events = new ExecutionEvents();
  const initial = connections.upsert({ name: 'question fixture', protocol: 'responses', baseURL: server.baseURL, model: 'fixture-model', enabled: true, allowLoopbackHttp: true, auth: { mode: 'memory' } });
  const connection = connections.setCredential({ id: initial.id, revision: initial.revision, mode: 'memory', secret });
  const id = randomUUID(), conversationId = randomUUID(), projectId = randomUUID();
  store.change(state => {
    state.projects.push({ id: projectId, name: 'project', path: project, createdAt: new Date().toISOString() });
    state.sessions.push({ id, projectId, title: 'questions', kind: 'agent', cwd: project, execution: { providerId: 'native', mode: 'structured', conversationId }, engineConfig: createNativeConfig({ schemaVersion: 1, options: { connectionId: connection.id } }), started: false, archived: false, status: 'idle', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  });
  const worker: NonNullable<NativeExecutorOptions['worker']> = workerOptions => inline(options.budget)(!options.crashAfterPrepared ? workerOptions : { ...workerOptions, store: { ...workerOptions.store,
    append: async (identity, event) => {
      const committed = await workerOptions.store.append(identity, event);
      if (event.type === 'tool_prepared' && event.prepared.call.name === 'ask_user') throw new Error('fixture lost worker after durable question preparation');
      return committed;
    },
  } });
  let executor = new NativeStructuredExecutor(store, connections, events, { worker });
  await executor.initialize();
  const pending = async () => {
    for (let count = 0; count < 500; count++) {
      const approval = executor.snapshot(id).pending[0]; if (approval) return approval;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('Question fixture did not reach a pending interaction');
  };
  return { id, data, project, conversationId, server, store, pending, get executor() { return executor; },
    async restart() { await executor.shutdown(); executor = new NativeStructuredExecutor(store, new ConnectionStore(data), events, { worker }); await executor.initialize(); },
    async dispose() { await executor.shutdown().catch(() => {}); await server.close(); store.flush(); await fs.rm(directory, { recursive: true, force: true }); },
  };
}

test('native questions use attention and waiting_input, persist answers and never authorize the next write', async () => {
  const f = await fixture({ write: true });
  try {
    const running = f.executor.send(f.id, '先问后改', [], undefined, { requestId: 'question-request' });
    const question = await f.pending();
    assert.equal(question.kind, 'question'); assert.deepEqual(question.questions, input.questions);
    assert.equal(f.executor.snapshot(f.id).taskState, 'waiting_input'); assert.equal(f.executor.attention()[0]?.kind, 'question');
    assert.throws(() => f.executor.respond(f.id, randomUUID(), { behavior: 'allow', answers }), /审批/);
    assert.throws(() => f.executor.respond(f.id, question.requestId, { behavior: 'allow', answers: {} }), /回答/);
    assert.throws(() => f.executor.respond(f.id, question.requestId, { behavior: 'allow', answers: { ...answers, unexpected: 'x' } }), /回答/);
    assert.throws(() => f.executor.respond(f.id, question.requestId, { behavior: 'allow', answers: { '采用哪个方案？': secret } }), /凭据/);
    assert.equal(f.executor.snapshot(f.id).pending[0]?.requestId, question.requestId, 'invalid answers keep the real question open');
    f.executor.respond(f.id, question.requestId, { behavior: 'allow', answers });
    assert.throws(() => f.executor.respond(f.id, question.requestId, { behavior: 'allow', answers }), /审批/);
    const write = await f.pending(); assert.equal(write.kind, 'permission'); assert.equal(write.toolName, 'apply_patch');
    await assert.rejects(fs.stat(path.join(f.project, 'answer.txt')), { code: 'ENOENT' });
    f.executor.respond(f.id, write.requestId, { behavior: 'deny' });
    assert.equal((await running).success, true); assert.equal(f.executor.attention().length, 0);
    await assert.rejects(fs.stat(path.join(f.project, 'answer.txt')), { code: 'ENOENT' });
    const toolOutput = f.server.requests[1].input.find((item: { type: string }) => item.type === 'function_call_output');
    assert.deepEqual(JSON.parse(toolOutput.output), { status: 'completed', output: { answers } });
    const ledger = await NativeRunStore.open({ rootDirectory: path.join(f.data, 'native', 'conversations'), conversationId: f.conversationId });
    try {
      assert.equal(ledger.listRuns()[0].tools.length, 2); assert.equal(JSON.stringify(ledger.replay()).includes(secret), false);
      assert.match(JSON.stringify(ledger.replay()), /保留现有兼容行为/);
    } finally { await ledger.close(); }
    const requests = f.server.requests.length;
    await f.restart();
    assert.equal(f.executor.snapshot(f.id).pending.length, 0, 'questions are never restored as live prompts');
    assert.equal((await f.executor.send(f.id, '先问后改', [], undefined, { requestId: 'question-request' })).success, true);
    assert.equal(f.server.requests.length, requests, 'replayed submission uses the receipt without asking again or needing a credential');
  } finally { await f.dispose(); }
});

test('denied questions produce a durable denial and identical repeat questions do not reprompt', async () => {
  const f = await fixture({ repeat: true });
  try {
    const running = f.executor.send(f.id, '拒绝回答');
    const question = await f.pending(); f.executor.respond(f.id, question.requestId, { behavior: 'deny', answers: {} });
    assert.equal((await running).success, true); assert.equal(f.executor.attention().length, 0);
    const outputs = f.server.requests[2].input.filter((item: { type: string }) => item.type === 'function_call_output').map((item: { output: string }) => JSON.parse(item.output));
    assert.deepEqual(outputs.map((item: { status: string }) => item.status), ['denied', 'denied']);
    assert.equal(outputs[1].output.error, 'approval_previously_denied');
  } finally { await f.dispose(); }
});

test('cancellation dismisses a question and rejects its stale answer', async () => {
  const f = await fixture();
  try {
    const running = f.executor.send(f.id, '取消提问'); const question = await f.pending();
    await f.executor.stop(f.id); assert.equal((await running).interrupted, true);
    assert.equal(f.executor.snapshot(f.id).pending.length, 0); assert.equal(f.executor.attention().length, 0);
    assert.throws(() => f.executor.respond(f.id, question.requestId, { behavior: 'allow', answers }), /审批/);
    assert.equal(f.server.requests.length, 1);
  } finally { await f.dispose(); }
});

test('loss after durable question preparation preserves the recovery barrier and never replays the prompt', async () => {
  const f = await fixture({ crashAfterPrepared: true });
  try {
    const running = f.executor.send(f.id, '保留回答边界', [], undefined, { requestId: 'question-crash' });
    const question = await f.pending(); f.executor.respond(f.id, question.requestId, { behavior: 'allow', answers });
    assert.equal((await running).success, false); assert.equal(f.executor.recoveryRequired(f.id), true);
    await f.restart();
    assert.equal(f.executor.snapshot(f.id).pending.length, 0); assert.equal(f.executor.attention().length, 0);
    assert.equal((await f.executor.send(f.id, '保留回答边界', [], undefined, { requestId: 'question-crash' })).success, false);
    assert.equal(f.server.requests.length, 1, 'lost answers or an unknown marker cannot silently restart the question');
    const ledger = await NativeRunStore.open({ rootDirectory: path.join(f.data, 'native', 'conversations'), conversationId: f.conversationId });
    try { assert.equal(ledger.getRecoveryReport()?.tools[0]?.status, 'unknown'); } finally { await ledger.close(); }
  } finally { await f.dispose(); }
});

test('expired questions settle without replay and waiting does not consume active execution budget', async () => {
  const expired = await fixture({ budget: { approvalTimeoutMs: 60 } });
  try {
    const running = expired.executor.send(expired.id, '等待过期'); const question = await expired.pending();
    assert.equal((await running).success, true); assert.equal(expired.executor.attention().length, 0);
    assert.throws(() => expired.executor.respond(expired.id, question.requestId, { behavior: 'allow', answers }), /审批/);
    const output = expired.server.requests[1].input.find((item: { type: string }) => item.type === 'function_call_output');
    assert.equal(JSON.parse(output.output).status, 'denied');
  } finally { await expired.dispose(); }
  const paused = await fixture({ budget: { maxActiveMs: 250, approvalTimeoutMs: 1500 } });
  try {
    const running = paused.executor.send(paused.id, '等待用户'); const question = await paused.pending();
    await new Promise(resolve => setTimeout(resolve, 350));
    paused.executor.respond(paused.id, question.requestId, { behavior: 'allow', answers });
    assert.equal((await running).success, true, 'human response time is excluded from active budget');
  } finally { await paused.dispose(); }
});

test('question schema and host answer binding reject malformed or substituted inputs', async () => {
  const identity = { sessionId: 'session', conversationId: 'conversation', runId: 'run', requestId: 'request', workerGeneration: 1 };
  const tool = createQuestionTool({ identity, forbiddenValues: [secret], assertOwnership: async () => {} });
  const context: ToolExecutionContext = { identity, policyRevision: 'policy', signal: new AbortController().signal, maxOutputBytes: 64 * 1024 };
  for (const [index, invalid] of [ { questions: [] }, { questions: [...input.questions, ...input.questions] }, { questions: [{ ...input.questions[0], options: [{ label: 'A' }, { label: 'A' }] }] }, { ...input, executable: 'x' }, { questions: [{ ...input.questions[0], question: secret }] }, ...['__proto__', 'constructor', 'toString'].map(question => ({ questions: [{ ...input.questions[0], question }] })), { questions: [{ question: '多选', multiSelect: true, options: [{ label: 'A, B' }] }] } ].entries()) {
    await assert.rejects(tool.prepare({ id: `bad-${index}`, name: 'ask_user', arguments: JSON.stringify(invalid) }, context));
  }
  const prepared = await tool.prepare({ id: 'good', name: 'ask_user', arguments: JSON.stringify(input) }, context);
  const request: ApprovalRequest = { binding: { ...identity, toolCallId: prepared.call.id, inputDigest: prepared.inputDigest, policyRevision: prepared.policyRevision }, tool: prepared.definition, input: prepared.input, preconditions: prepared.preconditions, expiresAt: Date.now() + 5000 };
  assert.throws(() => tool.questions({ ...request, binding: { ...request.binding, runId: 'other' } }), /归属|运行/);
  assert.throws(() => tool.answer(request, { '采用哪个方案？': 'x'.repeat(4001) }), /限制/);
  assert.throws(() => tool.answer({ ...request, expiresAt: Date.now() - 1 }, answers), /过期/);
  const approval = { binding: request.binding, decision: 'approved' as const, expiresAt: request.expiresAt };
  assert.equal((await tool.execute(prepared, context, approval)).status, 'not_executed', 'approval cannot fabricate a missing user answer');
  tool.answer(request, answers);
  assert.equal((await tool.execute(prepared, { ...context, identity: { ...identity, workerGeneration: 2 } }, approval)).status, 'not_executed');
  assert.deepEqual((await tool.execute(prepared, context, approval)).output, { answers });
  assert.throws(() => tool.answer(request, answers), /结束/);
});
