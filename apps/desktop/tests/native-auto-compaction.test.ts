import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { runAgent, type ModelContext, type ToolDefinition } from '@cc-desk/agent-core';
import { NativeRunStore } from '@cc-desk/agent-node/run-store';
import { ResponsesModel, estimateResponsesInputTokens } from '@cc-desk/agent-node/responses-model';
import { StateStore } from '../src/main/store';
import { ExecutionEvents } from '../src/main/execution/events';
import { ConnectionStore } from '../src/main/engines/native/connections';
import { NativeStructuredExecutor, type NativeExecutorOptions } from '../src/main/engines/native/structured-executor';
import { createNativeConfig } from '../src/main/engines/native/config';
// The model is a local HTTP/SSE server; no remote model or credential is used.
// @ts-expect-error Local test-only ESM fixture has no declarations.
import { startResponsesFixture, assistantMessage, functionCall } from '../../../packages/agent-node/tests/fixtures/responses-server.mjs';

type Worker = NonNullable<NativeExecutorOptions['worker']>;
type WorkerOptions = Parameters<Worker>[0];
type FixtureBody = { input: Array<Record<string, unknown>>; tools: unknown[]; max_output_tokens: number; instructions?: string };
type Handler = (request: { body: FixtureBody; index: number }) => { output?: unknown[]; hang?: boolean };
const secret = 'sk-auto-compaction-local-fixture';
const summary = '历史目标：只检查 fixture.txt，不得删除文件。早期检查已完成，保留最新一轮约束与已记录工具结果。';
const firstGoal = '最初目标：只检查 fixture.txt，不能删除文件。';
const latestGoal = '最新完整轮：读取 fixture.txt，保留用户编辑。';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const deferred = () => {
  let resolve!: () => void;
  return { promise: new Promise<void>(yes => { resolve = yes; }), resolve: () => resolve() };
};
async function waitFor(promise: Promise<void>) {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Controlled worker did not reach its expected checkpoint within 10 seconds.')), 10_000); })]);
  } finally { clearTimeout(timer); }
}
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
const defaultHandler: Handler = ({ body, index }) => {
  if (!body.tools.length) return { output: [assistantMessage(`summary-${index}`, summary)] };
  const lastInput = body.input.filter(item => item.role === 'user').at(-1)?.content;
  if (lastInput === latestGoal && !body.input.some(item => item.type === 'function_call_output' && item.call_id === 'latest-read')) {
    return { output: [functionCall('latest-read', 'read_file', { path: 'fixture.txt' })] };
  }
  return { output: [assistantMessage(`answer-${index}`, `已记录结果 ${index}。` + 'historical verified fixture details. '.repeat(120))] };
};
async function fixture(options: { worker?: Worker; handler?: Handler } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-auto-compaction-'));
  const data = path.join(directory, 'data'), project = path.join(directory, 'project');
  await fs.mkdir(project); await fs.writeFile(path.join(project, 'fixture.txt'), 'original\n');
  await fs.writeFile(path.join(project, 'AGENTS.md'), 'Do not modify unrelated files.\n');
  const server = await startResponsesFixture({ handler: options.handler ?? defaultHandler, assertReplay: false });
  let store = new StateStore(data), executor: NativeStructuredExecutor;
  const connectionOptions = { isConnectionActive: (id: string) => executor?.isConnectionActive(id) ?? false };
  let connections = new ConnectionStore(data, connectionOptions);
  const created = connections.upsert({ name: 'local', protocol: 'responses', baseURL: server.baseURL, model: 'auto-compaction-fixture', allowLoopbackHttp: true, enabled: true, auth: { mode: 'memory' } });
  const connectionId = created.id;
  connections.setCredential({ id: connectionId, revision: created.revision, mode: 'memory', secret });
  const id = randomUUID(), conversationId = randomUUID(), projectId = randomUUID();
  store.change(state => {
    state.projects.push({ id: projectId, path: project, name: 'project', createdAt: new Date().toISOString() });
    state.sessions.push({ id, projectId, title: 'automatic context compaction', kind: 'agent', cwd: project,
      execution: { providerId: 'native', mode: 'structured', conversationId },
      engineConfig: createNativeConfig({ schemaVersion: 1, options: { connectionId } }),
      started: false, status: 'idle', archived: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  });
  const events = new ExecutionEvents();
  const calls: Array<{ summary: boolean; input: string; budget: WorkerOptions['request']['budget']; instructions: string | undefined; definitions: readonly ToolDefinition[] }> = [];
  const worker: Worker = async request => {
    if (request.request.configuration.purpose === 'context_summary') {
      const snapshot = executor.snapshot(id);
      assert.ok((snapshot.nativeRun?.workerGeneration ?? 0) < request.request.identity.workerGeneration, 'preflight generation must not become snapshot authority before a durable task run starts');
    }
    calls.push({ summary: request.request.configuration.purpose === 'context_summary', input: request.request.input,
      budget: structuredClone(request.request.budget), instructions: request.model.instructions, definitions: structuredClone(request.model.toolDefinitions ?? []) });
    return (options.worker ?? inlineWorker)(request);
  };
  executor = new NativeStructuredExecutor(store, connections, events, { worker });
  await executor.initialize();
  const readLedger = async () => {
    const ledger = await NativeRunStore.open({ rootDirectory: path.join(data, 'native', 'conversations'), conversationId });
    try { return { records: ledger.replay(), context: ledger.loadContext(), runs: ledger.listRuns(), compaction: ledger.getLastCompaction() }; }
    finally { await ledger.close(); }
  };
  return { directory, data, project, id, conversationId, connectionId, server, calls, readLedger,
    get store() { return store; }, get executor() { return executor; }, get connections() { return connections; },
    async seed() {
      for (const input of [firstGoal, '第二轮：继续检查已完成的工作。', latestGoal]) {
        const result = await executor.send(id, input); assert.equal(result.success, true, JSON.stringify(result));
      }
      assert.equal(executor.snapshot(id).nativeContextMaintenance?.canCompact, true);
      assert.equal(server.requests.length, 4, 'seed contains three complete turns including a real read result');
    },
    async configure(changes: Record<string, unknown>) {
      const config = structuredClone(store.state.sessions.find(item => item.id === id)!.engineConfig);
      Object.assign(config.options, changes); await executor.updateConfig(id, config);
    },
    async estimate(input: string) {
      const context = (await readLedger()).context!;
      const pending: ModelContext = { ...context, items: [...context.items, { role: 'user', content: input }] };
      const previous = calls.filter(call => !call.summary).at(-1)!;
      return estimateResponsesInputTokens(pending, previous.instructions, previous.definitions);
    },
    async enableAtThreshold(input: string, changes: Record<string, unknown> = {}) {
      const maxInputTokens = Math.floor(await this.estimate(input) / 0.95);
      await this.configure({ autoCompact: 'before_send', maxInputTokens, ...changes });
      return maxInputTokens;
    },
    async restart(withCredential = true) {
      await executor.shutdown(); store = new StateStore(data); connections = new ConnectionStore(data, connectionOptions);
      if (withCredential) {
        const connection = connections.list().connections.find(item => item.id === connectionId)!;
        connections.setCredential({ id: connectionId, revision: connection.revision, mode: 'memory', secret });
      }
      executor = new NativeStructuredExecutor(store, connections, events, { worker }); await executor.initialize();
    },
    async dispose() { await executor.shutdown().catch(() => {}); await server.close(); store.flush(); await fs.rm(directory, { recursive: true, force: true }); },
  };
}

for (const mode of ['default_off', 'below_threshold'] as const) test(`automatic compaction makes no summary request when ${mode}`, async () => {
  const f = await fixture();
  try {
    await f.seed(); const input = '继续下一轮';
    const before = await f.readLedger();
    if (mode === 'default_off') {
      assert.equal(f.store.state.sessions.find(item => item.id === f.id)!.engineConfig.options.autoCompact, 'off');
      await f.configure({ maxInputTokens: Math.floor(await f.estimate(input) / 0.95) });
    } else await f.configure({ autoCompact: 'before_send', maxInputTokens: Math.ceil(await f.estimate(input) / 0.89) });
    const result = await f.executor.send(f.id, input);
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(f.server.requests.length, 5); assert.equal(f.calls.some(call => call.summary), false);
    assert.deepEqual(f.server.requests[4].input.slice(0, before.context!.items.length), before.context!.items);
    assert.equal((await f.readLedger()).records.some(record => record.event.type === 'context_compaction_attempted'), false);
  } finally { await f.dispose(); }
});

for (const trigger of ['new_input', 'changed_project_instructions', 'changed_claude_instructions', 'changed_project_skill'] as const) test(`automatic compaction includes ${trigger} in the pending request estimate`, async () => {
  const f = await fixture();
  try {
    const skill = '.agents/skills/compact/SKILL.md';
    if (trigger === 'changed_claude_instructions') await fs.writeFile(path.join(f.project, 'CLAUDE.md'), 'Preserve the recorded task goal.\n');
    if (trigger === 'changed_project_skill') {
      await fs.mkdir(path.dirname(path.join(f.project, skill)), { recursive: true });
      await fs.writeFile(path.join(f.project, skill), 'Retain the current task constraints.\n');
      await f.configure({ projectSkills: [skill] });
    }
    await f.seed(); let input = '继续下一轮';
    const baseEstimate = await f.estimate(input), limit = Math.ceil(baseEstimate / 0.85);
    const addition = 'x'.repeat(Math.ceil(limit * 0.92) - baseEstimate);
    await f.configure({ autoCompact: 'before_send', maxInputTokens: limit });
    if (trigger === 'new_input') input += addition;
    else await fs.appendFile(path.join(f.project, trigger === 'changed_project_skill' ? skill : trigger === 'changed_claude_instructions' ? 'CLAUDE.md' : 'AGENTS.md'), addition);
    const result = await f.executor.send(f.id, input);
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(f.server.requests.length, 6, 'one summary precedes one ordinary request');
    assert.deepEqual(f.server.requests[4].tools, []); assert.ok(f.server.requests[5].tools.length > 0);
    assert.equal(f.server.requests[5].input.at(-1).content, input);
    if (trigger !== 'new_input') assert.ok(f.server.requests[5].instructions.includes(addition), 'the task uses freshly read instructions');
    assert.deepEqual(f.server.errors, []);
  } finally { await f.dispose(); }
});

test('automatic compaction rereads selected Skills changed during the summary before dispatching the task', async () => {
  const skill = '.claude/skills/compact/SKILL.md';
  const beforeContent = 'SKILL_BEFORE_SUMMARY', afterContent = 'SKILL_AFTER_SUMMARY';
  let f: Awaited<ReturnType<typeof fixture>>;
  f = await fixture({ worker: async options => {
    const result = await inlineWorker(options);
    if (options.request.configuration.purpose === 'context_summary') await fs.writeFile(path.join(f.project, skill), afterContent);
    return result;
  } });
  try {
    await fs.mkdir(path.dirname(path.join(f.project, skill)), { recursive: true });
    await fs.writeFile(path.join(f.project, skill), beforeContent);
    await f.configure({ projectSkills: [skill] }); await f.seed();
    const input = '压缩后按最新Skill继续'; await f.enableAtThreshold(input);
    const result = await f.executor.send(f.id, input);
    assert.equal(result.success, true, JSON.stringify(result)); assert.equal(f.server.requests.length, 6);
    assert.deepEqual(f.server.requests[4].tools, []);
    assert.doesNotMatch(f.server.requests[4].instructions, /SKILL_BEFORE_SUMMARY/, 'project Skills cannot become the summarizer policy');
    assert.match(f.server.requests[5].instructions, /SKILL_AFTER_SUMMARY/);
    assert.doesNotMatch(f.server.requests[5].instructions, /SKILL_BEFORE_SUMMARY/);
    const sources = (await f.readLedger()).runs.at(-1)!.configuration.instructions as Array<{ path: string; hash: string }>;
    assert.equal(sources.find(source => source.path === skill)?.hash, digest(afterContent));
    assert.deepEqual(f.server.errors, []);
  } finally { await f.dispose(); }
});

test('automatic compaction preserves the original goal and latest tool pair, debits task budgets and persists one attempt before network', async () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  f = await fixture({ worker: async options => {
    if (options.request.configuration.purpose === 'context_summary') {
      const journal = await fs.readFile(path.join(f.data, 'native', 'conversations', f.conversationId, 'journal.jsonl'), 'utf8');
      const records = journal.trimEnd().split('\n').map(line => JSON.parse(line));
      assert.equal(records.at(-1).event.type, 'context_compaction_attempted', 'summary dispatch follows the awaited durable attempt record');
      assert.equal(f.server.requests.length, 4);
      const result = await inlineWorker(options);
      await new Promise(resolve => setTimeout(resolve, 30));
      return result;
    }
    return inlineWorker(options);
  } });
  try {
    await f.seed(); const before = await f.readLedger(), input = '压缩后继续';
    await f.enableAtThreshold(input, { maxModelRequests: 5, maxActiveMs: 5000 });
    const result = await f.executor.send(f.id, input, [], undefined, { requestId: 'successful-auto' });
    assert.equal(result.success, true, JSON.stringify(result));
    const after = await f.readLedger();
    assert.equal(f.server.requests.length, 6); assert.equal(f.calls.filter(call => call.summary).length, 1);
    const summaryCall = f.calls.find(call => call.summary)!; const taskCall = f.calls.at(-1)!;
    assert.equal(summaryCall.budget!.maxModelRequests, 1); assert.equal(taskCall.budget!.maxModelRequests, 4);
    assert.ok(taskCall.budget!.maxActiveMs! <= 4975, 'the ordinary task receives only the remaining active time');
    assert.deepEqual(f.server.requests[4].tools, []); assert.ok(f.server.requests[4].max_output_tokens <= 4096);
    const sent = f.server.requests[5].input;
    assert.deepEqual(sent[0], before.context!.items[0]);
    const latestIndex = before.context!.items.findIndex(item => typeof item === 'object' && item !== null && !Array.isArray(item) && item.role === 'user' && item.content === latestGoal);
    assert.ok(latestIndex > 0);
    assert.deepEqual(sent.slice(-1 - (before.context!.items.length - latestIndex), -1), before.context!.items.slice(latestIndex));
    assert.ok(sent.some((item: Record<string, unknown>) => item.type === 'function_call' && item.call_id === 'latest-read'));
    assert.ok(sent.some((item: Record<string, unknown>) => item.type === 'function_call_output' && item.call_id === 'latest-read'));
    assert.ok(JSON.stringify(sent).includes(summary));
    assert.equal(JSON.stringify(f.server.requests[4].input).includes('最新完整轮'), false, 'the retained latest turn is not summarized again');
    assert.deepEqual(after.records.slice(0, before.records.length), before.records);
    assert.equal(after.records.filter(record => record.event.type === 'context_compaction_attempted').length, 1);
    assert.equal(after.records.filter(record => record.event.type === 'context_compacted').length, 1);
    assert.equal(after.runs.length, 4, 'summary work is not an extra ordinary task turn');
    assert.ok(after.compaction!.afterBytes < after.compaction!.beforeBytes);
    assert.equal(JSON.stringify(after.records).includes(secret), false);
    await f.restart(false);
    const duplicate = await f.executor.send(f.id, input, [], undefined, { requestId: 'successful-auto' });
    assert.equal(duplicate.success, true); assert.equal(f.server.requests.length, 6, 'durable terminal retry needs neither credentials nor another model request');
    assert.deepEqual(f.server.errors, []);
  } finally { await f.dispose(); }
});

test('automatic summary cannot increase the configured total model request budget', async () => {
  let seeded = false;
  const f = await fixture({ handler: request => seeded && request.body.tools.length
    ? { output: [functionCall('budget-read', 'read_file', { path: 'fixture.txt' })] }
    : defaultHandler(request) });
  try {
    await f.seed(); seeded = true; const input = '只允许剩余一次模型请求';
    await f.enableAtThreshold(input, { maxModelRequests: 2 });
    const result = await f.executor.send(f.id, input);
    assert.equal(result.success, false, 'a tool loop cannot send a third request after summary + task');
    assert.equal(f.server.requests.length, 6); assert.equal(f.calls.at(-1)!.budget!.maxModelRequests, 1);
    const run = (await f.readLedger()).runs.at(-1)!;
    assert.equal(run.result!.status, 'budget_exhausted'); assert.equal(run.result!.modelRequests, 1);
    assert.equal(run.tools[0].completed?.result.status, 'completed', 'the one permitted task response can still execute its safe local tool');
  } finally { await f.dispose(); }
});

for (const reason of ['single_request_budget', 'new_input_exceeds_budget'] as const) test(`automatic compaction avoids a billable summary when ${reason}`, async () => {
  const f = await fixture();
  try {
    await f.seed(); const before = await f.readLedger(); let input = '本次请求无法完整执行';
    const limit = await f.enableAtThreshold(input, reason === 'single_request_budget' ? { maxModelRequests: 1 } : {});
    if (reason === 'new_input_exceeds_budget') input = 'x'.repeat(limit + 1);
    const result = await f.executor.send(f.id, input);
    assert.equal(result.success, false); assert.equal(f.server.requests.length, 4);
    assert.equal(f.calls.some(call => call.summary), false, 'unusable request budgets cannot spend a summary request');
    assert.deepEqual(await f.readLedger(), before, 'preflight rejection creates neither an attempt nor an ordinary task');
  } finally { await f.dispose(); }
});

test('a near-limit conversation without an older complete prefix proceeds without automatic summary', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.executor.send(f.id, firstGoal)).success, true);
    assert.equal(f.executor.snapshot(f.id).nativeContextMaintenance?.canCompact, false);
    const input = '第二轮尚无可压缩的早期历史'; await f.enableAtThreshold(input);
    assert.equal((await f.executor.send(f.id, input)).success, true);
    assert.equal(f.server.requests.length, 2); assert.equal(f.calls.some(call => call.summary), false);
    assert.equal((await f.readLedger()).records.some(record => record.event.type === 'context_compaction_attempted'), false);
  } finally { await f.dispose(); }
});

for (const mode of ['invalid_tool', 'not_smaller'] as const) test(`failed automatic summary ${mode} keeps context and cannot be charged again for the same context after restart`, async () => {
  const f = await fixture({ handler: request => request.body.tools.length ? defaultHandler(request) : {
    output: mode === 'invalid_tool' ? [functionCall('forbidden-write', 'apply_patch', { path: 'fixture.txt', expectedHash: digest('original\n'), content: 'forbidden\n' })]
      : [assistantMessage('large-summary', 'x'.repeat(25_000))],
  } });
  try {
    await f.seed(); const before = await f.readLedger(), input = '自动摘要失败';
    await f.enableAtThreshold(input);
    const first = await f.executor.send(f.id, input, [], undefined, { requestId: 'failed-auto' });
    assert.equal(first.success, false); assert.equal(f.server.requests.length, 5);
    assert.deepEqual((await f.readLedger()).context, before.context);
    assert.equal((await f.readLedger()).runs.length, before.runs.length, 'the ordinary turn never starts');
    assert.equal(await fs.readFile(path.join(f.project, 'fixture.txt'), 'utf8'), 'original\n');
    assert.equal(f.executor.attention().length, 0);
    assert.equal((await f.executor.send(f.id, input, [], undefined, { requestId: 'failed-auto' })).success, false);
    await f.restart();
    assert.equal((await f.executor.send(f.id, input, [], undefined, { requestId: 'failed-auto' })).success, false);
    assert.equal((await f.executor.send(f.id, '不同请求也不能默默重复计费', [], undefined, { requestId: 'new-request-same-context' })).success, false);
    assert.equal(f.server.requests.length, 5);
    const after = await f.readLedger();
    assert.deepEqual(after.context, before.context);
    assert.equal(after.records.filter(record => record.event.type === 'context_compaction_attempted').length, 1);
    assert.equal(after.records.some(record => record.event.type === 'context_compacted'), false);
    await f.configure({ autoCompact: 'off', maxInputTokens: 64_000 });
    const continued = await f.executor.send(f.id, input, [], undefined, { requestId: 'failed-auto' });
    assert.equal(continued.success, true, JSON.stringify(continued));
    assert.equal(f.server.requests.length, 6, 'explicitly disabling automatic compaction can resume the same paused queue item');
    assert.ok(f.server.requests[5].tools.length > 0);
    assert.deepEqual(f.server.requests[5].input.slice(0, before.context!.items.length), before.context!.items);
    assert.equal(f.calls.filter(call => call.summary).length, 1, 'the same request identifier never repeats its failed summary');
    assert.deepEqual(f.server.errors, []);
  } finally { await f.dispose(); }
});

test('retrying a failed summary with automatic compaction disabled still debits its model request from the same submission', async () => {
  let retrying = false;
  const f = await fixture({ handler: request => {
    if (!request.body.tools.length) return { output: [functionCall('invalid-summary-tool', 'read_file', { path: 'fixture.txt' })] };
    if (!retrying) return defaultHandler(request);
    return { output: request.body.input.some(item => item.type === 'function_call_output' && item.call_id === 'retry-read')
      ? [assistantMessage('retry-finished', 'This reply would exceed the original two-request submission budget.')]
      : [functionCall('retry-read', 'read_file', { path: 'fixture.txt' })] };
  } });
  try {
    await f.seed(); const input = '失败摘要后保留本次总请求预算';
    await f.enableAtThreshold(input, { maxModelRequests: 2 });
    assert.equal((await f.executor.send(f.id, input, [], undefined, { requestId: 'failed-summary-budget' })).success, false);
    assert.equal(f.server.requests.length, 5);
    await f.restart(); retrying = true;
    await f.configure({ autoCompact: 'off', maxInputTokens: 64_000 });
    const result = await f.executor.send(f.id, input, [], undefined, { requestId: 'failed-summary-budget' });
    assert.equal(result.success, false, 'the retained submission cannot use summary + two ordinary requests');
    assert.equal(f.server.requests.length, 6, 'only the one remaining ordinary model request may be sent');
    assert.equal(f.calls.at(-1)!.budget!.maxModelRequests, 1);
    const run = (await f.readLedger()).runs.at(-1)!;
    assert.equal(run.result!.status, 'budget_exhausted'); assert.equal(run.result!.modelRequests, 1);
    assert.equal(run.tools[0].completed?.result.status, 'completed');
    assert.deepEqual(f.server.errors, []);
  } finally { await f.dispose(); }
});

test('automatic summary cancellation holds configuration, connection and cleanup barriers, then blocks duplicate billing after restart', async () => {
  const entered = deferred(), release = deferred();
  const f = await fixture({ worker: async options => {
    const result = await inlineWorker(options);
    if (options.request.configuration.purpose === 'context_summary') { entered.resolve(); await release.promise; }
    return result;
  } });
  try {
    await f.seed(); const before = await f.readLedger(), input = '取消自动摘要';
    await f.enableAtThreshold(input);
    const first = f.executor.send(f.id, input, [], undefined, { requestId: 'cancelled-auto' });
    const duplicate = f.executor.send(f.id, input, [], undefined, { requestId: 'cancelled-auto' });
    assert.equal(first, duplicate); await waitFor(entered.promise);
    assert.equal(f.executor.has(f.id), true); assert.equal(f.executor.activeCount, 1);
    assert.equal(f.executor.snapshot(f.id).nativeContextMaintenance?.compacting, true);
    assert.equal(f.executor.snapshot(f.id).nativeContextMaintenance?.compactionTrigger, 'automatic');
    assert.equal(f.executor.isConnectionActive(f.connectionId), true);
    await f.executor.hydrate(f.id); await f.executor.page(f.id);
    const refreshed = f.executor.snapshot(f.id);
    assert.equal(refreshed.taskState, 'thinking', 'refreshing a live automatic summary cannot report an interrupted task');
    assert.equal(refreshed.error, undefined, 'a durable attempt record is not a failed summary while its worker is active');
    assert.notEqual(refreshed.nativeContextMaintenance?.autoCompact?.blocked, true);
    assert.equal(refreshed.messages.some(message => message.text.startsWith('发送前自动压缩未完成。')), false, 'live history cannot announce that the current summary has failed');
    const config = structuredClone(f.store.state.sessions.find(item => item.id === f.id)!.engineConfig);
    await assert.rejects(f.executor.updateConfig(f.id, config));
    await assert.rejects(f.executor.stopIdle(f.id)); assert.throws(() => f.executor.forget(f.id));
    const connection = f.connections.list().connections.find(item => item.id === f.connectionId)!;
    assert.throws(() => f.connections.remove({ id: connection.id, revision: connection.revision }));
    await assert.rejects(f.executor.send(f.id, '不能并发启动新请求'));
    f.executor.interrupt(f.id);
    assert.equal(f.executor.has(f.id), true, 'stop intent does not release a summary worker awaiting physical cleanup');
    await assert.rejects(f.executor.updateConfig(f.id, config));
    await assert.rejects(f.executor.stopIdle(f.id));
    release.resolve(); const result = await first;
    assert.equal(result.success, false); assert.equal(result.interrupted, true);
    await f.executor.whenReleased(f.id);
    assert.equal(f.executor.has(f.id), false); assert.equal(f.executor.isConnectionActive(f.connectionId), false);
    assert.deepEqual((await f.readLedger()).context, before.context);
    assert.equal((await f.readLedger()).runs.length, before.runs.length);
    await f.executor.updateConfig(f.id, config); await f.executor.stopIdle(f.id);
    await f.restart();
    assert.equal((await f.executor.send(f.id, input, [], undefined, { requestId: 'cancelled-auto' })).success, false);
    assert.equal(f.server.requests.length, 5, 'a cancelled automatic summary is not retried implicitly');
  } finally { release.resolve(); await f.dispose(); }
});

test('cancellation after durable automatic compaction preserves the summary and retries only the ordinary task', async () => {
  const entered = deferred(), release = deferred();
  const original = NativeRunStore.prototype.commitContextCompaction;
  NativeRunStore.prototype.commitContextCompaction = async function(plan) {
    const result = await original.call(this, plan);
    if (plan.automaticRequestId === 'commit-then-cancel') { entered.resolve(); await release.promise; }
    return result;
  };
  const f = await fixture();
  try {
    await f.seed(); const before = await f.readLedger(), input = '压缩提交后取消';
    await f.enableAtThreshold(input, { maxModelRequests: 3 });
    const pending = f.executor.send(f.id, input, [], undefined, { requestId: 'commit-then-cancel' });
    await waitFor(entered.promise); f.executor.interrupt(f.id); release.resolve();
    assert.equal((await pending).success, false); assert.equal(f.server.requests.length, 5);
    const compacted = await f.readLedger();
    assert.notDeepEqual(compacted.context, before.context); assert.ok(JSON.stringify(compacted.context).includes(summary));
    assert.equal(compacted.runs.length, before.runs.length);
    await f.restart();
    const retried = await f.executor.send(f.id, input, [], undefined, { requestId: 'commit-then-cancel' });
    assert.equal(retried.success, true, JSON.stringify(retried));
    assert.equal(f.server.requests.length, 6); assert.equal(f.calls.filter(call => call.summary).length, 1);
    assert.ok(f.server.requests[5].tools.length > 0); assert.equal(f.calls.at(-1)!.budget!.maxModelRequests, 2);
    assert.deepEqual(f.server.requests[5].input.slice(0, compacted.context!.items.length), compacted.context!.items);
    assert.equal((await f.readLedger()).records.filter(record => record.event.type === 'context_compacted').length, 1);
  } finally { release.resolve(); NativeRunStore.prototype.commitContextCompaction = original; await f.dispose(); }
});

test('a P4b terminal receipt without autoCompact remains idempotent after default normalization', async () => {
  const f = await fixture({ worker: async options => {
    const request = structuredClone(options.request);
    const sessionOptions = request.configuration.sessionOptions as Record<string, unknown>;
    delete sessionOptions.autoCompact;
    return inlineWorker({ ...options, request });
  } });
  try {
    const input = '旧版本已完成的请求';
    assert.equal((await f.executor.send(f.id, input, [], undefined, { requestId: 'legacy-p4b' })).success, true);
    const records = (await f.readLedger()).records;
    await f.restart(false);
    const result = await f.executor.send(f.id, input, [], undefined, { requestId: 'legacy-p4b' });
    assert.equal(result.success, true, JSON.stringify(result)); assert.equal(f.server.requests.length, 1);
    assert.deepEqual((await f.readLedger()).records, records);
  } finally { await f.dispose(); }
});
