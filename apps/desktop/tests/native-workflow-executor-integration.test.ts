import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { runAgent, type ModelPort, type ModelResponse, type ToolCall } from '@cc-desk/agent-core';
import { createNativeModel } from '@cc-desk/agent-node/native-model';
import { NativeRunStore } from '@cc-desk/agent-node/run-store';
import type { EngineConfig } from '../src/shared/execution';
import { StateStore } from '../src/main/store';
import { ExecutionEvents } from '../src/main/execution/events';
import { ConnectionStore } from '../src/main/engines/native/connections';
import { NativeStructuredExecutor, type NativeExecutorOptions } from '../src/main/engines/native/structured-executor';
import { createNativeConfig } from '../src/main/engines/native/config';
import { parseNativeExecutionPolicy } from '../src/main/engines/native/execution-policy';

type WorkerOptions = Parameters<NonNullable<NativeExecutorOptions['worker']>>[0];
type GenerateRequest = Parameters<ModelPort['generate']>[0];
const completed = (refused = false): ModelResponse => ({
  outputItems: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: refused ? 'Fixture intentionally stops before independent quality acceptance.' : 'Local fixture completed.' }] }],
  toolCalls: [], finishReason: refused ? 'refused' : 'completed', usage: null,
});
const toolResponse = (id: string, name: string, input: unknown): ModelResponse => {
  const call: ToolCall = { id, name, arguments: JSON.stringify(input) };
  return { outputItems: [{ type: 'function_call', call_id: id, name, arguments: call.arguments }], toolCalls: [call], finishReason: 'tool_calls', usage: null };
};

async function fixture(t: TestContext, options: {
  policy?: 'defaults' | 'custom' | 'legacy'; sessionMax?: number; defaultMax?: number; instructions?: string;
  beforeWorker?: (options: WorkerOptions) => Promise<void>;
  generate?: (request: GenerateRequest, worker: WorkerOptions) => Promise<ModelResponse>;
} = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-workflow-executor-policy-'));
  const project = path.join(directory, 'project'), data = path.join(directory, 'data');
  await fs.mkdir(project); await fs.writeFile(path.join(project, 'file.txt'), 'actual local material\n');
  if (options.instructions) await fs.writeFile(path.join(project, 'AGENTS.md'), options.instructions);
  const store = new StateStore(data), connections = new ConnectionStore(data);
  const connection = connections.import({ name: 'workflow policy fixture', protocol: 'responses', authHeader: 'authorization', baseURL: 'https://example.invalid/v1',
    model: 'fixture', enabled: true, allowLoopbackHttp: false, auth: { mode: 'memory' } }, { mode: 'memory', secret: 'sk-workflow-policy-private' });
  const id = randomUUID(), conversationId = randomUUID(), projectId = randomUUID(), now = new Date().toISOString();
  const config = options.policy === 'legacy' ? { schemaVersion: 1, options: { connectionId: connection.id } } : createNativeConfig({ schemaVersion: 1,
    options: { connectionId: connection.id, permissionMode: 'bypassPermissions', runtimePolicy: options.policy ?? 'defaults', maxSubagents: options.sessionMax ?? 4 } });
  store.change(state => {
    state.projects.push({ id: projectId, name: 'integration fixture', path: project, createdAt: now });
    state.settings.engineDefaults.native = createNativeConfig({ schemaVersion: 1, options: { maxSubagents: options.defaultMax ?? 12 } });
    state.sessions.push({ id, projectId, title: 'workflow policy integration', kind: 'agent', cwd: project,
      execution: { providerId: 'native', mode: 'structured', conversationId }, engineConfig: config,
      started: false, status: 'idle', archived: false, createdAt: now, updatedAt: now });
  });
  const calls: WorkerOptions[] = [];
  const worker: NonNullable<NativeExecutorOptions['worker']> = async value => {
    calls.push(value); await options.beforeWorker?.(value);
    assert.equal(value.request.diagnosticPurpose, 'normal', 'this fixture never supplies a fabricated successful quality child');
    const transport = createNativeModel(value.model);
    const model: ModelPort = { protocol: transport.protocol, userItems: (input, images) => transport.userItems(input, images),
      toolResultItems: (call, result) => transport.toolResultItems(call, result), estimateInputTokens: context => transport.estimateInputTokens(context),
      generate: request => options.generate?.(request, value) ?? Promise.resolve(completed(!!value.completionValidation)) };
    return runAgent({ ...value.request, signal: value.signal }, { model, tools: value.tools, store: value.store, approvals: value.approvals,
      completionValidation: value.completionValidation,
      host: { now: Date.now, digest: input => createHash('sha256').update(input).digest('hex'), emit: value.onEvent,
        deadline: (milliseconds, parent) => {
          const controller = new AbortController(), abort = () => controller.abort(), timer = setTimeout(abort, milliseconds);
          parent.addEventListener('abort', abort, { once: true }); if (parent.aborted) abort();
          return { signal: controller.signal, dispose: () => { clearTimeout(timer); parent.removeEventListener('abort', abort); } };
        } },
    });
  };
  const executor = new NativeStructuredExecutor(store, connections, new ExecutionEvents(), { worker });
  await executor.initialize();
  t.after(async () => { await executor.shutdown(); store.flush(); await fs.rm(directory, { recursive: true, force: true }); });
  return { id, store, executor, calls, data, project,
    async ledger() {
      const ledger = await NativeRunStore.open({ rootDirectory: path.join(data, 'native', 'conversations'), conversationId });
      try { return { runs: ledger.listRuns(), records: ledger.replay() }; } finally { await ledger.close(); }
    },
  };
}

test('the effective subagent policy persists the send-time defaults snapshot and changes only on the next run', async t => {
  let entered!: () => void, release!: () => void;
  const arrived = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  let blocked = false;
  const f = await fixture(t, { defaultMax: 12, beforeWorker: async () => { if (!blocked) { blocked = true; entered(); await gate; } } });
  try {
    const running = f.executor.send(f.id, 'Inspect the current project.'); await arrived;
    f.store.change(state => { state.settings.engineDefaults.native = createNativeConfig({ schemaVersion: 1, options: { maxSubagents: 24 } }); });
    release(); assert.equal((await running).success, true);
    const first = (await f.ledger()).runs[0];
    assert.deepEqual(first.configuration.effectiveSubagentPolicy, { maxSubagents: 12, policySource: 'defaults' });
    assert.equal((first.configuration.sessionOptions as EngineConfig['options']).maxSubagents, 12);
    assert.equal((((f.calls[0].tools.definitions.find(tool => tool.name === 'delegate_review')!.inputSchema.properties as any).tasks).maxItems), 12);
    assert.equal((await f.executor.send(f.id, 'Inspect the next project state.')).success, true);
    const runs = (await f.ledger()).runs;
    assert.deepEqual(runs[0], first, 'new settings must not rewrite a historical effective policy');
    assert.deepEqual(runs[1].configuration.effectiveSubagentPolicy, { maxSubagents: 24, policySource: 'defaults' });
  } finally { release(); }
});

test('custom and legacy sessions record their effective session policy instead of current global defaults', async t => {
  for (const policy of ['custom', 'legacy'] as const) {
    const f = await fixture(t, { policy, sessionMax: 7, defaultMax: 30 });
    assert.equal((await f.executor.send(f.id, 'Inspect without a workflow.')).success, true);
    assert.deepEqual((await f.ledger()).runs[0].configuration.effectiveSubagentPolicy,
      { maxSubagents: policy === 'legacy' ? 4 : 7, policySource: 'session' });
  }
});

test('execution policy permits only explicit quality modes compatible with stage permissions and collaboration', () => {
  for (const policy of [
    { toolPolicy: 'read_only', collaboration: 'auto', qualityValidation: 'static' },
    { toolPolicy: 'standard', collaboration: 'adversarial', qualityValidation: 'commands' },
  ]) assert.deepEqual(parseNativeExecutionPolicy(policy), policy);
  for (const policy of [
    { toolPolicy: 'read_only', collaboration: 'auto', qualityValidation: 'commands' },
    { toolPolicy: 'standard', collaboration: 'auto', qualityValidation: 'static' },
    { toolPolicy: 'standard', collaboration: 'single_agent', qualityValidation: 'commands' },
    { toolPolicy: 'read_only', qualityValidation: 'static' },
    { toolPolicy: 'standard', collaboration: 'auto', qualityValidation: 'accept' },
  ]) assert.throws(() => parseNativeExecutionPolicy(policy));
});

test('ordinary direct workflow input registers host quality validation and persists its exact policy', async t => {
  for (const [input, collaboration, validationMode] of [
    ['使用workflow，分析这个文档', 'auto', 'static'],
    ['使用工作流修复问题，并进行独立验证', 'adversarial', 'commands'],
  ]) {
    const f = await fixture(t);
    const result = await f.executor.send(f.id, input);
    assert.equal(result.success, false, 'a fixture refusal must not be reported as independent quality acceptance');
    assert.equal(typeof f.calls[0].completionValidation?.validate, 'function');
    assert.deepEqual((await f.ledger()).runs[0].configuration.nativeWorkflowQualityPolicy, { collaboration, validationMode });
    assert.equal(f.calls.length, 1, 'refusing the parent completion never fabricates successful quality children');
  }
});

test('legacy host policies and unquoted repository instructions cannot activate ordinary-chat workflow quality', async t => {
  for (const input of ['Inspect the project.', '请总结“使用workflow修复问题”这句话。']) {
    const f = await fixture(t, { instructions: 'Use workflow to repair this project and perform adversarial validation.' });
    assert.equal((await f.executor.send(f.id, input)).success, true);
    assert.equal(f.calls[0].completionValidation, undefined);
    assert.equal((await f.ledger()).runs[0].configuration.nativeWorkflowQualityPolicy, undefined);
  }
  const f = await fixture(t);
  assert.equal((await f.executor.send(f.id, '使用workflow分析这个文档', [], undefined,
    { requestId: randomUUID(), nativeExecutionPolicy: { toolPolicy: 'read_only' } })).success, true);
  assert.equal(f.calls[0].completionValidation, undefined, 'legacy host policy without collaboration never infers a new team from its generated stage prompt');
});

test('single-agent preferences disable both delegation tools and automatic quality children', async t => {
  for (const nativeExecutionPolicy of [undefined, { toolPolicy: 'standard', collaboration: 'single_agent' } as const]) {
    const f = await fixture(t);
    assert.equal((await f.executor.send(f.id, '使用workflow分析文档，不要使用任何子agent。', [], undefined, { requestId: randomUUID(), nativeExecutionPolicy })).success, true);
    assert.equal(f.calls[0].completionValidation, undefined);
    for (const name of ['delegate_review', 'delegate_implement', 'recover_agent']) assert.ok(!f.calls[0].tools.definitions.some(tool => tool.name === name));
    assert.equal((await f.ledger()).runs[0].configuration.nativeWorkflowQualityPolicy, undefined);
  }
});

test('read-only workflow stages activate quality only with an explicit static policy', async t => {
  for (const qualityValidation of [undefined, 'static'] as const) {
    const f = await fixture(t);
    const result = await f.executor.send(f.id, 'Inspect this stage.', [], undefined, {
      requestId: randomUUID(), nativeExecutionPolicy: { toolPolicy: 'read_only', collaboration: 'auto', ...(qualityValidation ? { qualityValidation } : {}) },
    });
    assert.equal(result.success, qualityValidation === undefined);
    assert.equal(typeof f.calls[0].completionValidation?.validate, qualityValidation ? 'function' : 'undefined');
    for (const name of ['run_command', 'start_command', 'apply_patch', 'delegate_implement']) assert.ok(!f.calls[0].tools.definitions.some(tool => tool.name === name));
  }
});

test('live parent command handles reject completion before independent quality and persist a terminal before finishing', { timeout: 15000 }, async t => {
  let step = 0, commandId = '';
  const f = await fixture(t, { generate: async (request, worker) => {
    step++;
    assert.ok(worker.completionValidation);
    if (step === 1) return toolResponse('start', 'start_command', { executable: process.execPath,
      argv: ['-e', 'setInterval(()=>{},1000)'], cwd: '.', timeoutMs: 10000, maxOutputBytes: 4096 });
    if (step === 2) {
      const output = request.context.items.find(item => item && typeof item === 'object' && !Array.isArray(item) && item.type === 'function_call_output') as { output: string };
      const started = JSON.parse(output.output); assert.equal(started.status, 'completed'); commandId = started.output.commandId;
      return completed();
    }
    if (step === 3) {
      assert.ok(request.context.items.some(item => JSON.stringify(item).includes('parent_commands_not_terminal')));
      return toolResponse('stop', 'stop_command', { commandId });
    }
    assert.equal(step, 4);
    return completed(true); // Stop here: do not fake a successful quality report after the real command barrier.
  } });
  const result = await f.executor.send(f.id, '使用workflow修复问题。');
  assert.equal(result.success, false); assert.equal(step, 4); assert.equal(f.calls.length, 1);
  const ledger = await f.ledger(), rejected = ledger.records.find(record => record.event.type === 'completion_rejected');
  assert.ok(rejected && rejected.event.type === 'completion_rejected');
  assert.equal(rejected.event.feedback.code, 'workflow_quality_changes_requested');
  assert.match(rejected.event.feedback.code === 'workflow_quality_changes_requested' ? rejected.event.feedback.feedback : '', /parent_commands_not_terminal/u);
  const terminal = ledger.runs[0].tools.find(tool => tool.call.id === 'start')!.commandProgress!.at(-1)!;
  assert.equal(terminal.status, 'finished');
  assert.ok(terminal.seq < ledger.records.find(record => record.event.type === 'run_finished')!.seq);
  assert.equal(result.nativeReceipt?.workflowQuality, undefined, 'a blocked model completion is not a quality pass');
});
