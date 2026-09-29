import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { runAgent } from '@cc-desk/agent-core';
import { createNativeModel } from '@cc-desk/agent-node/native-model';
import { requireCompleteContext } from '@cc-desk/agent-node/context-maintenance';
import { NativeRunStore } from '@cc-desk/agent-node/run-store';
import { StateStore } from '../src/main/store';
import { ExecutionEvents } from '../src/main/execution/events';
import { ConnectionStore } from '../src/main/engines/native/connections';
import { NativeStructuredExecutor, type NativeExecutorOptions } from '../src/main/engines/native/structured-executor';
import { createNativeConfig } from '../src/main/engines/native/config';
// @ts-expect-error Local protocol fixture has no declarations.
import { startResponsesFixture, functionCall, assistantMessage } from '../../../packages/agent-node/tests/fixtures/responses-server.mjs';
// @ts-expect-error Local protocol fixture has no declarations.
import { startChatCompletionsFixture } from '../../../packages/agent-node/tests/fixtures/chat-completions-server.mjs';

type Protocol = 'responses' | 'chat-completions';
type Body = { input?: any[]; messages?: any[]; tools?: any[]; instructions?: string };
type Mode = 'normal' | 'invalid-summary' | 'cancel-summary';
const secret = 'sk-in-turn-executor-local-fixture';
const input = 'Keep the original engineering goal intact; inspect the file and retain human verification.';
const summary = '历史目标与约束保持不变。已建立检查计划并读取 fixture.txt；人工验收仍未执行。继续读取当前任务，不能根据模型文字宣称验收通过。';
const padding = 'ordinary historical observation '.repeat(730);
const inline: NonNullable<NativeExecutorOptions['worker']> = options => runAgent({ ...options.request, signal: options.signal }, {
  model: createNativeModel(options.model), tools: options.tools, store: options.store, approvals: options.approvals,
  contextMaintenance: options.contextMaintenance,
  host: { now: Date.now, digest: text => createHash('sha256').update(text).digest('hex'), emit: options.onEvent,
    deadline: (ms, parent) => {
      const controller = new AbortController(), abort = () => controller.abort(), timer = setTimeout(abort, ms);
      parent.addEventListener('abort', abort, { once: true }); if (parent.aborted) abort();
      return { signal: controller.signal, dispose() { clearTimeout(timer); parent.removeEventListener('abort', abort); } };
    },
  },
});

async function fixture(protocol: Protocol, options: { mode?: Mode; autoCompact?: string; maxModelRequests?: number } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-in-turn-executor-'));
  const project = path.join(directory, 'project'), data = path.join(directory, 'data'); await fs.mkdir(project);
  await fs.writeFile(path.join(project, 'fixture.txt'), 'original content remains unchanged\n');
  await fs.writeFile(path.join(project, 'AGENTS.md'), 'Preserve user files; never invent a verification result.');
  await fs.writeFile(path.join(project, 'CLAUDE.md'), 'Keep the current task and evidence references.');
  let ordinary = 0, summaries = 0, summaryEntered!: () => void;
  const summaryStarted = new Promise<void>(resolve => { summaryEntered = resolve; });
  const server = await (protocol === 'responses' ? startResponsesFixture : startChatCompletionsFixture)({ assertReplay: false,
    handler: ({ body }: { body: Body }) => {
      if (!body.tools?.length) {
        summaries++; summaryEntered();
        if (options.mode === 'cancel-summary') return { hang: true };
        if (options.mode === 'invalid-summary') return protocol === 'responses'
          ? { output: [functionCall('forbidden-summary-tool', 'read_file', { path: 'fixture.txt' })] }
          : { message: { role: 'assistant', content: null, tool_calls: [{ id: 'forbidden-summary-tool', type: 'function', function: { name: 'read_file', arguments: '{"path":"fixture.txt"}' } }] } };
        return protocol === 'responses' ? { output: [assistantMessage('summary', summary)] } : { message: { role: 'assistant', content: summary } };
      }
      const items = body.input ?? body.messages!.filter(item => item.role !== 'system');
      requireCompleteContext({ protocol: { id: protocol === 'responses' ? 'openai-responses' : 'openai-chat-completions', version: 1 }, items });
      const index = ordinary++;
      const call = (id: string, name: string, args: unknown, text = '') => protocol === 'responses'
        ? { output: [...(text ? [assistantMessage(`${id}-notes`, text, 'commentary')] : []), functionCall(id, name, args)] }
        : { message: { role: 'assistant', content: text || null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } };
      if (index === 0) return call('plan', 'update_plan', { expectedRevision: 0, plan: {
        goal: input, steps: [{ id: 'inspect', title: 'Inspect original file', dependsOn: [], status: 'in_progress' }],
        criteria: [{ id: 'verify-humans', description: 'Human confirms scope and relevance', stepIds: ['inspect'], kind: 'manual' }],
      } });
      if (index <= 3) return call(`read-${index}`, 'read_file', { path: 'fixture.txt' }, `${index}: ${padding}`);
      if (index === 4) return call('task-after-history', 'read_task', {});
      return protocol === 'responses' ? { output: [assistantMessage('final', '模型声称整项任务已经验收通过。')] }
        : { message: { role: 'assistant', content: '模型声称整项任务已经验收通过。' } };
    },
  });
  const store = new StateStore(data), connections = new ConnectionStore(data), events = new ExecutionEvents();
  const initial = connections.upsert({ name: 'in-turn fixture', protocol, baseURL: server.baseURL, model: 'fixture-model', enabled: true,
    allowLoopbackHttp: true, auth: { mode: 'memory' }, pricing: { model: 'fixture-model', inputUSDPerMillion: 2, outputUSDPerMillion: 8 } });
  const connection = connections.setCredential({ id: initial.id, revision: initial.revision, mode: 'memory', secret });
  const id = randomUUID(), conversationId = randomUUID(), projectId = randomUUID();
  store.change(state => {
    state.projects.push({ id: projectId, name: 'project', path: project, createdAt: new Date().toISOString() });
    state.sessions.push({ id, projectId, title: 'in-turn compaction', kind: 'agent', cwd: project,
      execution: { providerId: 'native', mode: 'structured', conversationId },
      engineConfig: createNativeConfig({ schemaVersion: 1, options: { connectionId: connection.id, autoCompact: options.autoCompact ?? 'before_send_and_during_run',
        maxInputTokens: 90000, maxModelRequests: options.maxModelRequests ?? 10 } }), started: false, archived: false, status: 'idle',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  });
  let executor = new NativeStructuredExecutor(store, connections, events, { worker: inline }); await executor.initialize();
  return { id, project, server, summaryStarted, get executor() { return executor; }, get summaries() { return summaries; }, get ordinary() { return ordinary; },
    send: () => executor.send(id, input, [], undefined, { requestId: 'in-turn-submission' }),
    async ledger() {
      const ledger = await NativeRunStore.open({ rootDirectory: path.join(data, 'native', 'conversations'), conversationId });
      try { return { runs: ledger.listRuns(), records: ledger.replay(), context: ledger.loadContext(), recovery: ledger.getRecoveryReport() }; } finally { await ledger.close(); }
    },
    async restart() { await executor.shutdown(); executor = new NativeStructuredExecutor(store, connections, events, { worker: inline }); await executor.initialize(); },
    async dispose() { await executor.shutdown().catch(() => {}); await server.close(); store.flush(); await fs.rm(directory, { recursive: true, force: true }); },
  };
}

for (const protocol of ['responses', 'chat-completions'] as const) test(`${protocol}: in-turn compaction preserves the same run, task and complete tool pairs, accounts usage and never replays after restart`, { timeout: 25000 }, async () => {
  const f = await fixture(protocol);
  try {
    const result = await f.send(); assert.equal(result.success, true, JSON.stringify(result)); assert.deepEqual(f.server.errors, []);
    assert.equal(f.summaries, 1); assert.equal(f.ordinary, 6);
    const ledger = await f.ledger(); assert.equal(ledger.runs.length, 1); assert.equal(ledger.recovery, null);
    const run = ledger.runs[0]; assert.equal(run.result!.modelRequests, 7);
    assert.deepEqual(run.result!.usage, { inputTokens: 77, outputTokens: 49, totalTokens: 126 });
    assert.equal(ledger.records.filter(record => record.event.type === 'model_response').length, 6, 'the raw ordinary responses remain intact');
    const after = f.server.requests.filter((body: Body) => body.tools?.length).at(-1) as Body;
    const encoded = JSON.stringify(after);
    assert.ok(encoded.includes(summary)); assert.ok(encoded.includes(input)); assert.ok(encoded.includes('verify-humans'));
    assert.ok(encoded.includes('read-3')); assert.ok(encoded.includes('task-after-history'));
    assert.equal(encoded.includes(secret), false);
    assert.equal(f.executor.snapshot(f.id).nativeTask!.goal, input);
    assert.notEqual(f.executor.snapshot(f.id).nativeTask!.verification, 'passed');
    assert.equal(await fs.readFile(path.join(f.project, 'fixture.txt'), 'utf8'), 'original content remains unchanged\n');
    const requests = f.server.requests.length, task = f.executor.snapshot(f.id).nativeTask;
    await f.restart(); assert.equal((await f.send()).success, true);
    assert.equal(f.server.requests.length, requests); assert.equal(f.executor.snapshot(f.id).nativeTask!.taskId, task!.taskId);
    assert.deepEqual((await f.ledger()).context, ledger.context);
  } finally { await f.dispose(); }
});

for (const autoCompact of ['off', 'before_send']) test(`${autoCompact}: an existing mode never authorizes in-turn summary requests`, { timeout: 20000 }, async () => {
  const f = await fixture('responses', { autoCompact });
  try { await f.send(); assert.equal(f.summaries, 0); assert.deepEqual(f.server.errors, []); }
  finally { await f.dispose(); }
});

test('invalid summary stops the current run without a second summary or a follow-up ordinary model request', { timeout: 20000 }, async () => {
  const f = await fixture('responses', { mode: 'invalid-summary' });
  try {
    const result = await f.send(); assert.equal(result.success, false); assert.equal(f.summaries, 1);
    assert.equal(f.ordinary, 4); assert.equal(JSON.stringify((await f.ledger()).context).includes(summary), false);
    assert.notEqual(f.executor.snapshot(f.id).nativeTask!.verification, 'passed');
  } finally { await f.dispose(); }
});

test('cancelling the summary stops the same run and never resumes its ordinary model loop', { timeout: 20000 }, async () => {
  const f = await fixture('responses', { mode: 'cancel-summary' });
  try {
    const running = f.send(); await f.summaryStarted;
    assert.equal(f.executor.snapshot(f.id).nativeContextMaintenance!.compacting, true);
    await f.executor.stop(f.id); const result = await running;
    assert.equal(result.success, false); assert.equal(f.summaries, 1); assert.equal(f.ordinary, 4);
    assert.equal(JSON.stringify((await f.ledger()).context).includes(summary), false);
  } finally { await f.dispose(); }
});

test('the last model slot cannot be consumed by an in-turn summary', { timeout: 20000 }, async () => {
  const f = await fixture('responses', { maxModelRequests: 5 });
  try { const result = await f.send(); assert.equal(result.success, false); assert.equal(f.summaries, 0); assert.ok(f.ordinary <= 5); }
  finally { await f.dispose(); }
});
