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
type Mode = 'normal' | 'invalid-summary' | 'cancel-summary' | 'instructions-changed' | 'empty-final';
const secret = 'sk-in-turn-executor-local-fixture';
const input = 'Keep the original engineering goal intact; inspect the file and retain human verification.';
const summary = '历史目标与约束保持不变。已建立检查计划并读取 fixture.txt；人工验收仍未执行。继续读取当前任务，不能根据模型文字宣称验收通过。';
const padding = 'ordinary historical observation '.repeat(730);
const inline: NonNullable<NativeExecutorOptions['worker']> = options => runAgent({ ...options.request, signal: options.signal }, {
  model: createNativeModel(options.model), tools: options.tools, store: options.store, approvals: options.approvals,
  contextMaintenance: options.contextMaintenance,
  host: { now: Date.now, digest: text => createHash('sha256').update(text).digest('hex'), emit: options.onEvent,
    wait: (ms, signal) => new Promise<void>((resolve, reject) => {
      const cancel = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); reject(new Error('cancelled')); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, ms);
      signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) cancel();
    }),
    deadline: (ms, parent) => {
      const controller = new AbortController(), abort = () => controller.abort(), timer = setTimeout(abort, ms);
      parent.addEventListener('abort', abort, { once: true }); if (parent.aborted) abort();
      return { signal: controller.signal, dispose() { clearTimeout(timer); parent.removeEventListener('abort', abort); } };
    },
  },
});

async function fixture(protocol: Protocol, options: { mode?: Mode; autoCompact?: string; maxModelRequests?: number; toolOnlyBoundary?: boolean; retryBeforeOrdinary?: boolean } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-in-turn-executor-'));
  const project = path.join(directory, 'project'), data = path.join(directory, 'data'); await fs.mkdir(project);
  await fs.writeFile(path.join(project, 'fixture.txt'), options.toolOnlyBoundary ? 'large bounded file observation\n'.repeat(2000) : 'original content remains unchanged\n');
  // Distinct files make real inspection progress; repeatedly reading the same
  // unchanged file is deliberately blocked by N3-03 after three batches.
  for (const index of [1, 2, 3]) await fs.copyFile(path.join(project, 'fixture.txt'), path.join(project, `fixture-${index}.txt`));
  await fs.writeFile(path.join(project, 'AGENTS.md'), 'Preserve user files; never invent a verification result.');
  await fs.writeFile(path.join(project, 'CLAUDE.md'), 'Keep the current task and evidence references.');
  let ordinary = 0, summaries = 0, retryFired = false, summaryEntered!: () => void;
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
      if (options.retryBeforeOrdinary && !retryFired) { retryFired = true; return { httpStatus: 503, raw: 'temporary failure' }; }
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
      if (index <= 3) return call(`read-${index}`, 'read_file', { path: `fixture-${index}.txt` }, options.toolOnlyBoundary ? '' : `${index}: ${padding}`);
      if (index === 4) return call('task-after-history', 'read_task', {});
      if (options.mode === 'empty-final') return protocol === 'responses' ? { output: [] } : { message: { role: 'assistant', content: '' } };
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
        ...(options.retryBeforeOrdinary ? { modelRetry: 'safe_transient' } : {}),
        maxInputTokens: options.toolOnlyBoundary ? 40000 : 90000, maxModelRequests: options.maxModelRequests ?? 10 } }), started: false, archived: false, status: 'idle',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  });
  const worker: NonNullable<NativeExecutorOptions['worker']> = async request => {
    const result = await inline(request);
    if (options.mode === 'instructions-changed' && request.request.configuration.purpose === 'context_summary') {
      await fs.appendFile(path.join(project, 'CLAUDE.md'), '\nNew rule added while the summary was in flight.');
    }
    return result;
  };
  let executor = new NativeStructuredExecutor(store, connections, events, { worker }); await executor.initialize();
  return { id, project, server, summaryStarted, get executor() { return executor; }, get summaries() { return summaries; }, get ordinary() { return ordinary; },
    send: () => executor.send(id, input, [], undefined, { requestId: 'in-turn-submission' }),
    async ledger() {
      const ledger = await NativeRunStore.open({ rootDirectory: path.join(data, 'native', 'conversations'), conversationId });
      try { return { runs: ledger.listRuns(), records: ledger.replay(), context: ledger.loadContext(), recovery: ledger.getRecoveryReport() }; } finally { await ledger.close(); }
    },
    async restart() { await executor.shutdown(); executor = new NativeStructuredExecutor(store, connections, events, { worker }); await executor.initialize(); },
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
    const maintenance = f.executor.snapshot(f.id).nativeContextMaintenance!.inTurn!;
    assert.equal(maintenance.status, 'committed');
    assert.deepEqual(maintenance.summaryUsage, { inputTokens: 11, outputTokens: 7 });
    assert.ok(Math.abs(maintenance.summaryCostUSD! - 0.000078) < 1e-12);
    const totalCost = f.executor.snapshot(f.id).usage?.costUSD; assert.ok(typeof totalCost === 'number');
    assert.ok(Math.abs(totalCost - 0.000546) < 1e-12, 'total cost includes the summary exactly once');
    assert.equal(await fs.readFile(path.join(f.project, 'fixture.txt'), 'utf8'), 'original content remains unchanged\n');
    const requests = f.server.requests.length, task = f.executor.snapshot(f.id).nativeTask;
    await f.restart(); assert.equal((await f.send()).success, true);
    assert.equal(f.server.requests.length, requests); assert.equal(f.executor.snapshot(f.id).nativeTask!.taskId, task!.taskId);
    assert.deepEqual((await f.ledger()).context, ledger.context);
    assert.deepEqual(f.executor.snapshot(f.id).nativeContextMaintenance!.inTurn, maintenance);
  } finally { await f.dispose(); }
});

test('a failed request followed by in-turn compaction consumes both budgets while total usage stays unknown', { timeout: 25000 }, async () => {
  const f = await fixture('responses', { retryBeforeOrdinary: true });
  try {
    const result = await f.send(); assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(f.ordinary, 6); assert.equal(f.summaries, 1); assert.equal(f.server.requests.length, 8);
    const ledger = await f.ledger(), run = ledger.runs[0].result!;
    assert.equal(run.modelRequests, 8); assert.equal(run.usage, null);
    assert.equal(ledger.records.filter(record => record.event.type === 'model_request_started').length, 7);
    assert.equal(ledger.records.filter(record => record.event.type === 'run_context_compaction_attempted').length, 1);
    assert.equal(ledger.records.filter(record => record.event.type === 'tool_completed').length, 5);
    assert.equal(f.executor.snapshot(f.id).nativeContextMaintenance!.inTurn!.status, 'committed');
    assert.equal(f.executor.snapshot(f.id).usage?.costUSD, undefined);
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
    const resultReceipt = (await f.ledger()).runs[0].result!;
    assert.equal(resultReceipt.modelRequests, 5);
    assert.deepEqual(resultReceipt.usage, { inputTokens: 55, outputTokens: 35, totalTokens: 90 }, 'a complete rejected summary still contributes its known service usage');
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

test('CLAUDE instruction changes during summary prevent committing or resuming the old policy', { timeout: 20000 }, async () => {
  const f = await fixture('responses', { mode: 'instructions-changed' });
  try {
    const result = await f.send(); assert.equal(result.success, false);
    assert.equal(f.summaries, 1); assert.equal(f.ordinary, 4);
    const ledger = await f.ledger(); assert.equal(JSON.stringify(ledger.context).includes(summary), false);
    assert.equal(f.executor.snapshot(f.id).nativeContextMaintenance!.inTurn!.status, 'failed');
    assert.deepEqual(ledger.runs[0].result!.usage, { inputTokens: 55, outputTokens: 35, totalTokens: 90 });
  } finally { await f.dispose(); }
});

for (const phase of ['before', 'after'] as const) test(`${phase} publication failure cannot checkpoint the old context or repeat the summary after restart`, { timeout: 20000 }, async () => {
  const f = await fixture('responses');
  const original = NativeRunStore.prototype.commitRunCompaction;
  let injected = false;
  NativeRunStore.prototype.commitRunCompaction = async function (...args) {
    if (args[0].sessionId !== f.id) return original.apply(this, args);
    injected = true;
    if (phase === 'after') await original.apply(this, args);
    throw new Error(`Injected ${phase} compaction publication failure`);
  };
  try {
    const result = await f.send(); assert.equal(result.success, false); assert.equal(injected, true);
    assert.equal(f.summaries, 1); assert.equal(f.ordinary, 4);
    const ledger = await f.ledger();
    assert.equal(JSON.stringify(ledger.context).includes(summary), phase === 'after');
    assert.equal(ledger.records.filter(record => record.event.type === 'run_context_compacted').length, phase === 'after' ? 1 : 0);
    assert.equal(ledger.records.some(record => record.event.type === 'run_finished'), false);
    const requests = f.server.requests.length;
    NativeRunStore.prototype.commitRunCompaction = original;
    await f.restart(); assert.equal((await f.send()).success, false);
    assert.equal(f.server.requests.length, requests); assert.deepEqual((await f.ledger()).context, ledger.context);
  } finally { NativeRunStore.prototype.commitRunCompaction = original; await f.dispose(); }
});

for (const protocol of ['responses', 'chat-completions'] as const) test(`${protocol}: an empty final model response cannot turn host continuity or earlier commentary into a workflow summary`, { timeout: 25000 }, async () => {
  const f = await fixture(protocol, { mode: 'empty-final' });
  try {
    const result = await f.send(); assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(f.summaries, 1); assert.equal(result.summary, '');
    assert.ok(JSON.stringify((await f.ledger()).context).includes(summary), 'the final context really contains synthetic historical assistant content');
    const requests = f.server.requests.length;
    await f.restart(); const duplicate = await f.send();
    assert.equal(duplicate.success, true); assert.equal(duplicate.summary, ''); assert.equal(f.server.requests.length, requests);
  } finally { await f.dispose(); }
});

for (const protocol of ['responses', 'chat-completions'] as const) test(`${protocol}: cancellation after a tool-only compaction commit never exposes host continuity as a workflow summary`, { timeout: 25000 }, async () => {
  const f = await fixture(protocol, { toolOnlyBoundary: true });
  const original = NativeRunStore.prototype.commitRunCompaction;
  let injected = false;
  NativeRunStore.prototype.commitRunCompaction = async function (...args) {
    const receipt = await original.apply(this, args);
    if (args[0].sessionId === f.id) { injected = true; void f.executor.stop(f.id).catch(() => {}); }
    return receipt;
  };
  try {
    const result = await f.send(); assert.equal(injected, true); assert.equal(f.summaries, 1);
    assert.equal(result.success, false); assert.equal(result.interrupted, true); assert.equal(result.summary, '');
    const ledger = await f.ledger(); assert.ok(JSON.stringify(ledger.context).includes(summary));
    const last = ledger.records.findLast(record => record.event.type === 'model_response')!;
    assert.equal(last.event.type, 'model_response');
    if (last.event.type === 'model_response') assert.ok(last.event.response.toolCalls.length > 0, 'latest raw response is the textless tool batch');
    const requests = f.server.requests.length;
    NativeRunStore.prototype.commitRunCompaction = original;
    await f.restart(); const duplicate = await f.send();
    assert.equal(duplicate.success, false); assert.equal(duplicate.summary, ''); assert.equal(f.server.requests.length, requests);
  } finally { NativeRunStore.prototype.commitRunCompaction = original; await f.dispose(); }
});
