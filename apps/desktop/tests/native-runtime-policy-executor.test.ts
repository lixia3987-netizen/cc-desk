import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { runAgent } from '@cc-desk/agent-core';
import { createNativeModel } from '@cc-desk/agent-node/native-model';
import { NativeRunStore } from '@cc-desk/agent-node/run-store';
import type { EngineConfig } from '../src/shared/execution';
import { StateStore } from '../src/main/store';
import { ExecutionEvents } from '../src/main/execution/events';
import { ConnectionStore } from '../src/main/engines/native/connections';
import { NativeConnectionModelCatalog } from '../src/main/engines/native/connection-models';
import { NativeModelCapabilityService } from '../src/main/engines/native/model-capabilities';
import { createNativeConfig } from '../src/main/engines/native/config';
import { NativeStructuredExecutor, type NativeExecutorOptions } from '../src/main/engines/native/structured-executor';
// @ts-expect-error Local test-only ESM fixture has no declarations.
import { startAnthropicFixture } from '../../../packages/agent-node/tests/fixtures/anthropic-server.mjs';

type Worker = NonNullable<NativeExecutorOptions['worker']>;
type WorkerOptions = Parameters<Worker>[0];
const sessionOptions = (call: WorkerOptions) => call.request.configuration.sessionOptions as EngineConfig['options'];
const summary = '原始任务要求只读检查项目。历史检查已完成，未修改文件。保留原始约束与最近回合，后续仍需验证。';
const initialDefaults: EngineConfig = { schemaVersion: 1, options: {
  maxInputTokens: 64_000, maxOutputTokens: 1024, autoCompact: 'off', modelRetry: 'off',
  maxModelRequests: 3, maxToolCalls: 5, maxActiveMs: 5000,
} };
const inlineWorker: Worker = options => runAgent({ ...options.request, signal: options.signal }, {
  model: createNativeModel(options.model), tools: options.tools, store: options.store, approvals: options.approvals,
  contextMaintenance: options.contextMaintenance,
  host: { now: Date.now, digest: value => createHash('sha256').update(value).digest('hex'), emit: options.onEvent,
    deadline: (duration, parent) => {
      const controller = new AbortController(), abort = () => controller.abort(), timer = setTimeout(abort, duration);
      parent.addEventListener('abort', abort, { once: true }); if (parent.aborted) abort();
      return { signal: controller.signal, dispose: () => { clearTimeout(timer); parent.removeEventListener('abort', abort); } };
    },
  },
});

async function fixture(t: TestContext, options: { legacy?: boolean; known?: boolean; defaults?: EngineConfig } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ccdesk-native-runtime-policy-'));
  const data = path.join(directory, 'data'), project = path.join(directory, 'project');
  await fs.mkdir(project);
  const server = await startAnthropicFixture({ handler: ({ body }: { body: { tools?: unknown[] } }) => ({
    content: [{ type: 'text', text: body.tools?.length ? 'Verified local read-only history. '.repeat(120) : summary }],
  }) });
  const store = new StateStore(data), connections = new ConnectionStore(data);
  const connection = connections.import({ name: 'runtime policy fixture', protocol: 'anthropic', authHeader: 'authorization',
    baseURL: server.baseURL, model: 'fixture-model', enabled: true, allowLoopbackHttp: true, auth: { mode: 'memory' } },
  { mode: 'memory', secret: 'runtime-policy-fixture-key' });
  const id = randomUUID(), projectId = randomUUID(), conversationId = randomUUID(), now = new Date().toISOString();
  const engineConfig: EngineConfig = options.legacy ? { schemaVersion: 1, options: { connectionId: connection.id, maxInputTokens: 64_000, maxOutputTokens: 8192 } }
    : createNativeConfig({ schemaVersion: 1, options: { connectionId: connection.id, runtimePolicy: 'defaults' } });
  store.change(state => {
    state.projects.push({ id: projectId, name: 'policy fixture', path: project, createdAt: now });
    state.settings.engineDefaults.native = structuredClone(options.defaults ?? initialDefaults);
    state.sessions.push({ id, projectId, title: 'Policy inheritance', kind: 'agent', cwd: project,
      execution: { providerId: 'native', mode: 'structured', conversationId }, engineConfig,
      started: false, status: 'idle', archived: false, createdAt: now, updatedAt: now });
  });
  const catalog = new NativeConnectionModelCatalog(connections), service = new NativeModelCapabilityService(connections, catalog);
  t.mock.method(service, 'resolve', async (resolved: ReturnType<ConnectionStore['resolve']>) => ({
    connectionId: resolved.connectionId, revision: resolved.revision, model: resolved.model, code: 'ok',
    resolvedAt: now, expiresAt: new Date(Date.now() + 300_000).toISOString(), capabilities: options.known === false ? {} : {
      contextWindow: { value: 1_000_000, source: 'provider' }, maxInputTokens: { value: 1_000_000, source: 'provider' },
      maxOutputTokens: { value: 128_000, source: 'provider' },
    },
  }));
  const calls: WorkerOptions[] = [];
  let workerHook: ((options: WorkerOptions) => Promise<void>) | undefined;
  const worker: Worker = async value => { calls.push(value); await workerHook?.(value); return inlineWorker(value); };
  const executor = new NativeStructuredExecutor(store, connections, new ExecutionEvents(), { worker, modelCapabilities: service });
  await executor.initialize();
  return { id, store, server, calls, executor, connection, engineConfig: structuredClone(engineConfig),
    setWorkerHook: (hook?: (options: WorkerOptions) => Promise<void>) => { workerHook = hook; },
    setDefaults: (config: EngineConfig) => store.change(state => { state.settings.engineDefaults.native = structuredClone(config); }),
    async ledger() {
      const ledger = await NativeRunStore.open({ rootDirectory: path.join(data, 'native', 'conversations'), conversationId });
      try { return { runs: ledger.listRuns(), records: ledger.replay(), compaction: ledger.getLastCompaction() }; }
      finally { await ledger.close(); }
    },
    async dispose() {
      await executor.shutdown(); await service.shutdown(); await catalog.shutdown(); await server.close(); store.flush();
      await fs.rm(directory, { recursive: true, force: true });
    },
  };
}

test('settings inheritance snapshots each ordinary run, applies changes on the next run and leaves historical budgets intact', async t => {
  const f = await fixture(t);
  let entered!: () => void, release!: () => void;
  const arrived = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  f.setWorkerHook(async () => { entered(); await gate; });
  try {
    const pending = f.executor.send(f.id, 'Read-only first task', [], undefined, { requestId: 'policy-first-task' });
    const changedDefaults = createNativeConfig({ schemaVersion: 1, options: { connectionId: 'unrelated-global-connection', model: 'unrelated-global-model',
      inputBudgetMode: 'custom', maxInputTokens: 48_000, maxOutputTokens: 512, autoCompact: 'before_send_and_during_run',
      modelRetry: 'safe_transient', maxModelRequests: 7, maxToolCalls: 9, maxActiveMs: 6000 } });
    f.setDefaults(changedDefaults);
    await arrived;
    assert.equal(f.executor.send(f.id, 'Read-only first task', [], undefined, { requestId: 'policy-first-task' }), pending,
      'an in-flight duplicate keeps the original settings snapshot');
    const first = f.calls[0];
    assert.equal(first.request.budget!.maxInputTokens, 1_000_000 - 1024);
    assert.equal(first.request.budget!.maxOutputTokens, 1024); assert.equal(first.request.budget!.maxModelRequests, 3);
    assert.equal(first.request.budget!.maxToolCalls, 5); assert.ok(first.request.budget!.maxActiveMs! <= 5000);
    assert.equal(sessionOptions(first).inputBudgetMode, 'model', 'an old saved default without a mode follows fresh model policy');
    assert.equal(first.model.model, 'fixture-model'); assert.equal(first.request.configuration.connectionId, f.connection.id);
    assert.equal(f.executor.snapshot(f.id).nativeContextMaintenance!.autoCompact!.mode, 'off');
    release(); assert.equal((await pending).success, true);
    const originalBudget = f.executor.snapshot(f.id).context!.budget;
    assert.equal(originalBudget!.maxInputTokens, 1_000_000 - 1024);
    const before = await f.ledger(), originalRun = structuredClone(before.runs[0]);
    f.setWorkerHook();
    assert.equal((await f.executor.send(f.id, 'Read-only second task')).success, true);
    const second = f.calls[1];
    assert.equal(second.request.budget!.maxInputTokens, 48_000); assert.equal(second.request.budget!.maxOutputTokens, 512);
    assert.equal(second.request.budget!.maxModelRequests, 7); assert.equal(second.request.budget!.maxToolCalls, 9);
    assert.equal(second.request.modelRetry, 'safe_transient'); assert.ok(second.contextMaintenance);
    assert.deepEqual((await f.ledger()).runs[0], originalRun, 'changing settings cannot reinterpret or rewrite a historical run');
    assert.deepEqual(f.store.state.sessions.find(session => session.id === f.id)!.engineConfig, f.engineConfig);
    assert.deepEqual(f.server.requests.map((request: { max_tokens: number }) => request.max_tokens), [1024, 512]);
    assert.deepEqual(f.server.errors, []);
  } finally { release(); await f.dispose(); }
});

test('legacy sessions without policy markers keep their original 64K ceiling and saved options', async t => {
  const f = await fixture(t, { legacy: true, defaults: createNativeConfig({ schemaVersion: 1, options: {
    inputBudgetMode: 'model', maxInputTokens: 128_000, maxOutputTokens: 1024, autoCompact: 'before_send',
  } }) });
  try {
    assert.equal((await f.executor.send(f.id, 'Keep the legacy policy')).success, true);
    assert.equal(f.calls[0].request.budget!.maxInputTokens, 64_000); assert.equal(f.calls[0].request.budget!.maxOutputTokens, 8192);
    assert.equal(sessionOptions(f.calls[0]).runtimePolicy, 'custom');
    assert.equal(f.executor.snapshot(f.id).nativeContextMaintenance!.autoCompact!.mode, 'off');
    assert.deepEqual(f.store.state.sessions.find(session => session.id === f.id)!.engineConfig, f.engineConfig);
    assert.deepEqual(f.server.errors, []);
  } finally { await f.dispose(); }
});

test('following model capacity with unknown metadata retains the configured bounded fallback', async t => {
  const f = await fixture(t, { known: false, defaults: { schemaVersion: 1, options: { ...initialDefaults.options, maxInputTokens: 96_000 } } });
  try {
    assert.equal((await f.executor.send(f.id, 'Unknown capacity task')).success, true);
    assert.equal(f.calls[0].request.budget!.maxInputTokens, 96_000);
    assert.equal(sessionOptions(f.calls[0]).inputBudgetMode, 'model');
    assert.equal(f.executor.snapshot(f.id).context!.contextWindow, undefined);
    assert.deepEqual(f.server.errors, []);
  } finally { await f.dispose(); }
});

test('manual compression uses settings captured at operation start and preserves ordinary run history', async t => {
  const f = await fixture(t);
  try {
    assert.equal((await f.executor.send(f.id, 'First explicit read-only task')).success, true);
    assert.equal((await f.executor.send(f.id, 'Second explicit read-only task')).success, true);
    const before = await f.ledger();
    f.setDefaults({ schemaVersion: 1, options: { ...initialDefaults.options, inputBudgetMode: 'model', maxOutputTokens: 256 } });
    const compact = f.executor.compactContext(f.id, f.executor.snapshot(f.id).nativeContextMaintenance!.headHash);
    f.setDefaults({ schemaVersion: 1, options: { ...initialDefaults.options, inputBudgetMode: 'custom', maxInputTokens: 1024, maxOutputTokens: 128 } });
    await compact;
    const summaryCall = f.calls.find(call => call.request.configuration.purpose === 'context_summary')!;
    assert.ok(summaryCall); assert.equal(summaryCall.request.budget!.maxInputTokens, 1_000_000 - 256);
    assert.equal(summaryCall.request.budget!.maxOutputTokens, 256);
    const after = await f.ledger(); assert.ok(after.compaction);
    assert.deepEqual(after.runs, before.runs, 'summary policy never changes ordinary run configuration');
    assert.deepEqual(f.server.errors, []);
  } finally { await f.dispose(); }
});
