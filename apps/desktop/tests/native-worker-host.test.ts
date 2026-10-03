import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { canonicalJson, DEFAULT_RUN_BUDGET, type AgentRunRequest, type ApprovalPort, type BeginRunRequest, type ContextMaintenanceResult, type ModelContext, type ModelResponse, type PreparedTool, type RunResult, type RunStore, type ToolCall, type ToolPort, type ToolResult } from '@cc-desk/agent-core';
import { NativeWorkerCleanupError, runNativeWorker, type NativeWorkerChild, type NativeWorkerForkOptions, type NativeWorkerOptions } from '../src/main/engines/native/worker-host';
import { MAX_WORKER_MESSAGE_BYTES, MAX_WORKER_PENDING, WORKER_PROTOCOL } from '../src/main/engines/native/worker-protocol';

const run: Omit<AgentRunRequest, 'signal'> = {
  identity: { sessionId: 'session', conversationId: 'conversation', runId: 'run', requestId: 'submission', workerGeneration: 1 },
  input: 'Update the test file', configuration: { model: 'local' }, policyRevision: 'policy-v1',
};
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value as never)).digest('hex');
const definition = { name: 'apply_patch', description: 'Update one text file', inputSchema: { type: 'object', properties: {} }, risk: 'write' } as const;
const requestCall: ToolCall = { id: 'call-one', name: 'apply_patch', arguments: '{"path":"a.txt","content":"after"}' };

class FakeWorker extends EventEmitter implements NativeWorkerChild {
  pid = 42;
  stdout = new PassThrough();
  stderr = new PassThrough();
  sent: Record<string, unknown>[] = [];
  sequence = 0;
  modelAttempts = 0;
  summaryRequests = 0;
  killed = false;
  autoFinish = true;
  autoCancel = true;
  closed = false;
  scriptError?: unknown;
  pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  constructor(readonly script: (worker: FakeWorker) => Promise<void>) { super(); }
  postMessage(raw: unknown): void {
    const message = raw as Record<string, unknown>;
    this.sent.push(clone(message));
    if (message.type === 'start') void this.script(this).catch(error => { this.scriptError = error; this.exit(1); });
    if (message.type === 'reply') {
      const item = this.pending.get(message.requestId as string);
      assert.ok(item);
      this.pending.delete(message.requestId as string);
      if (message.error) item.reject(new Error(String(message.error))); else item.resolve(message.value);
    }
    if (message.type === 'finish' && this.autoFinish) this.exit(0);
    if (message.type === 'cancel' && this.autoCancel) this.exit(1);
  }
  send(message: Record<string, unknown>): void {
    setImmediate(() => this.emit('message', { version: WORKER_PROTOCOL, identity: run.identity, seq: ++this.sequence, ...message }));
  }
  async rpc<T = unknown>(method: string, args: unknown): Promise<T> {
    const seq = ++this.sequence;
    const requestId = `run:${seq}`;
    const promise = new Promise<T>((resolve, reject) => this.pending.set(requestId, { resolve: value => resolve(value as T), reject }));
    setImmediate(() => this.emit('message', { type: 'request', version: WORKER_PROTOCOL, identity: run.identity, seq, requestId, method, args: clone(args) }));
    const value = await promise;
    const event = (args as { event?: { type: string } }).event;
    if (method === 'store.append' && event?.type === 'model_request_started') this.modelAttempts++;
    if (method === 'context.maintain') this.summaryRequests += (value as { modelRequests: number }).modelRequests;
    return value;
  }
  exit(code: number, closeStreams = true): void {
    if (this.closed) return;
    this.closed = true;
    if (closeStreams) { this.stdout.end(); this.stderr.end(); }
    setImmediate(() => this.emit('exit', code));
  }
  kill(): boolean { this.killed = true; this.exit(1); return true; }
}

function harness(script: (worker: FakeWorker) => Promise<void>, overrides: Partial<NativeWorkerOptions> = {}) {
  const worker = new FakeWorker(script);
  const events: unknown[] = [], journal: unknown[] = [];
  let forkOptions: NativeWorkerForkOptions | undefined;
  let forkPath: string | undefined;
  const store: RunStore = {
    beginRun: async request => ({ kind: 'accepted', context: { protocol: clone(request.protocol), items: clone(request.userItems) } }),
    append: async (_identity, event) => { journal.push(clone(event)); return { seq: journal.length }; },
    ensureCapacity: async () => {}, checkpoint: async () => {},
  };
  const tools: ToolPort = {
    definitions: [clone(definition)],
    prepare: async call => ({ call: clone(call), definition: clone(definition), input: JSON.parse(call.arguments), inputDigest: digest(JSON.parse(call.arguments)), policyRevision: run.policyRevision, requiresApproval: true, preconditions: { hash: 'before' } }),
    validate: async () => {},
    execute: async () => ({ status: 'completed', output: { changed: true }, effects: { path: 'a.txt' } }),
  };
  const approvals: ApprovalPort = { request: async request => ({ binding: request.binding, decision: 'approved', expiresAt: request.expiresAt }) };
  const options: NativeWorkerOptions = {
    request: run, model: { baseURL: 'http://127.0.0.1:1/v1', model: 'local', allowLoopbackHttp: true, apiKey: 'secret-key-sentinel' },
    tools, store, approvals, onEvent: event => { events.push(event); }, signal: new AbortController().signal,
    fork: (file, _args, opts) => { forkOptions = opts; forkPath = file; setImmediate(() => worker.emit('message', { type: 'ready', version: WORKER_PROTOCOL, pid: worker.pid })); return worker; },
    ...overrides,
  };
  const promise = runNativeWorker(options);
  return { worker, promise, events, journal, options, get forkOptions() { return forkOptions; }, get forkPath() { return forkPath; } };
}

async function begin(worker: FakeWorker, protocol = { id: 'openai-responses', version: 1 }): Promise<ModelContext> {
  const initial = { input: run.input, userItems: [{ role: 'user', content: protocol.id === 'anthropic-messages' ? [{ type: 'text', text: run.input }] : run.input }], protocol, configuration: run.configuration, policyRevision: run.policyRevision };
  const request: BeginRunRequest = { ...initial, identity: run.identity, inputDigest: digest(initial) };
  const admission = await worker.rpc<{ kind: 'accepted'; context: ModelContext }>('store.beginRun', request);
  await worker.rpc('store.checkpoint', { identity: run.identity, context: admission.context });
  return admission.context;
}
async function startAttempt(worker: FakeWorker, attempt = worker.modelAttempts + 1): Promise<void> {
  await worker.rpc('store.append', { identity: run.identity, event: { type: 'model_request_started', attempt } });
}
async function prepare(worker: FakeWorker, context: ModelContext): Promise<PreparedTool> {
  await startAttempt(worker);
  const response: ModelResponse = {
    outputItems: [{ type: 'function_call', id: 'fc-one', call_id: requestCall.id, name: requestCall.name, arguments: requestCall.arguments, status: 'completed' }],
    toolCalls: [requestCall], usage: null, finishReason: 'tool_calls',
  };
  await worker.rpc('store.append', { identity: run.identity, event: { type: 'model_response', response } });
  context.items.push(...response.outputItems);
  await worker.rpc('store.checkpoint', { identity: run.identity, context });
  return await worker.rpc('tools.prepare', { call: requestCall, context: executionContext() });
}
function executionContext() { return { identity: run.identity, policyRevision: run.policyRevision, maxOutputBytes: DEFAULT_RUN_BUDGET.maxToolOutputBytes }; }
function approvalRequest(prepared: PreparedTool) {
  return { binding: { ...run.identity, toolCallId: prepared.call.id, inputDigest: prepared.inputDigest, policyRevision: prepared.policyRevision }, tool: prepared.definition, input: prepared.input, preconditions: prepared.preconditions, expiresAt: Date.now() + 30_000 };
}
async function finish(worker: FakeWorker, context: ModelContext, extra: Partial<RunResult> = {}): Promise<void> {
  const result: RunResult = { identity: run.identity, status: 'completed', reason: 'model_completed', modelRequests: worker.modelAttempts + worker.summaryRequests, toolCalls: 0, context, usage: null, committed: true, ...extra };
  await worker.rpc('store.append', { identity: run.identity, event: { type: 'run_finished', result } });
  await worker.rpc('event', { type: 'run_finished', identity: run.identity, result });
  worker.send({ type: 'done', result });
}

test('worker host starts with restricted environment and waits for done, finish, exit, and closes diagnostic readers', async () => {
  const h = harness(async worker => { const context = await begin(worker); worker.autoFinish = false; await finish(worker, context); });
  let settled = false;
  void h.promise.then(() => { settled = true; }, () => { settled = true; });
  try {
    while (!h.worker.sent.some(message => message.type === 'finish')) await tick();
    assert.equal(settled, false);
    assert.equal(path.basename(h.forkPath ?? ''), 'worker.cjs');
    assert.equal(path.basename(path.dirname(h.forkPath ?? '')), 'native');
    assert.deepEqual(h.forkOptions?.execArgv, []);
    assert.equal(h.forkOptions?.stdio, 'pipe');
    assert.ok(Object.keys(h.forkOptions!.env).every(name => ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'TZ'].includes(name)));
    assert.ok(!JSON.stringify(h.forkOptions).includes('secret-key-sentinel'));
    h.worker.exit(0, false);
    assert.equal((await h.promise).status, 'completed');
    assert.equal(h.worker.stdout.closed, true);
    assert.equal(h.worker.stderr.closed, true);
  } finally {
    h.worker.exit(1);
    await h.promise.catch(() => {});
  }
});

test('worker startup deducts fork and readiness time before handing the remaining budget to the worker', async t => {
  let now = 100;
  t.mock.method(performance, 'now', () => now);
  const request = { ...run, budget: { maxActiveMs: 100 } };
  const h = harness(async worker => { const context = await begin(worker); await finish(worker, context); }, {
    request,
    fork: async () => { await tick(); now += 20; return h.worker; },
  });
  while (!h.worker.listenerCount('message')) await tick();
  now += 30;
  h.worker.emit('message', { type: 'ready', version: WORKER_PROTOCOL, pid: h.worker.pid });
  assert.equal((await h.promise).status, 'completed');
  const start = h.worker.sent.find(message => message.type === 'start')!;
  assert.equal((start.request as AgentRunRequest).budget?.maxActiveMs, 50);
  assert.equal(request.budget.maxActiveMs, 100, 'caller configuration remains unchanged');
});

for (const phase of ['fork', 'readiness'] as const) test(`worker ${phase} budget exhaustion stops before start and confirms child cleanup`, async t => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const h = harness(async worker => { const context = await begin(worker); await finish(worker, context); }, {
    request: { ...run, budget: { maxActiveMs: 100 } },
    fork: async () => { await tick(); if (phase === 'fork') now = 100; return h.worker; },
  });
  h.worker.autoCancel = false;
  let settled = false;
  void h.promise.then(() => { settled = true; }, () => { settled = true; });
  const rejected = assert.rejects(h.promise, { code: 'active_time_budget' });
  while (!h.worker.listenerCount('message')) await tick();
  if (phase === 'readiness') now = 100;
  h.worker.emit('message', { type: 'ready', version: WORKER_PROTOCOL, pid: h.worker.pid });
  try {
    assert.equal(h.worker.sent.some(message => message.type === 'start'), false);
    assert.equal(h.worker.sent.some(message => message.type === 'cancel'), true);
    await tick();
    assert.equal(settled, false, 'budget rejection retains ownership until exit is confirmed');
  } finally {
    h.worker.exit(1, false);
    await rejected;
  }
  assert.equal(h.worker.stdout.closed, true);
  assert.equal(h.worker.stderr.closed, true);
  assert.equal(h.journal.length, 0);
});

test('Electron exit can remove stream listeners without EOF; retained diagnostic readers still close', async () => {
  const h = harness(async worker => {
    const context = await begin(worker);
    worker.autoFinish = false;
    await finish(worker, context);
  });
  const stdout = h.worker.stdout, stderr = h.worker.stderr;
  while (!h.worker.sent.some(message => message.type === 'finish')) await tick();
  assert.equal(stdout.readableEnded, false);
  assert.equal(stderr.readableEnded, false);
  // Electron removes its PassThrough listeners and getters as part of exit.
  // Neither stream gets an EOF or an observable close event from the writer.
  stdout.removeAllListeners(); stderr.removeAllListeners();
  h.worker.emit('exit', 0);
  assert.equal((await h.promise).status, 'completed');
  assert.equal(stdout.closed, true);
  assert.equal(stderr.closed, true);
});

test('requesting diagnostic destruction without a confirmed close retains the cleanup barrier', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(async worker => {
    const context = await begin(worker);
    worker.autoFinish = false;
    await finish(worker, context);
  });
  const stdout = h.worker.stdout;
  const destroy = stdout.destroy.bind(stdout);
  stdout.destroy = () => { stdout.destroyed = true; return stdout; };
  const rejected = assert.rejects(h.promise, error => error instanceof NativeWorkerCleanupError && error.cleanupUnconfirmed);
  while (!h.worker.sent.some(message => message.type === 'finish')) await tick();
  h.worker.exit(0, false);
  await tick();
  assert.equal(stdout.destroyed, true);
  assert.equal(stdout.closed, false);
  t.mock.timers.tick(10_000);
  t.mock.timers.tick(10_000);
  await rejected;
  stdout.destroyed = false;
  destroy();
});

test('real tool port, committed preparation, exact approval, and journal results stay authoritative', async () => {
  const h = harness(async worker => {
    const context = await begin(worker);
    const prepared = await prepare(worker, context);
    const approval = await worker.rpc('approval', approvalRequest(prepared));
    await worker.rpc('tools.validate', { prepared, context: executionContext() });
    await worker.rpc('store.ensureCapacity', { identity: run.identity, bytes: 1024 });
    await worker.rpc('store.append', { identity: run.identity, event: { type: 'tool_prepared', prepared, approval } });
    const result = await worker.rpc<ToolResult>('tools.execute', { prepared, context: executionContext(), approval });
    const resultItems = [{ type: 'function_call_output', call_id: requestCall.id, output: JSON.stringify(result) }];
    await worker.rpc('store.append', { identity: run.identity, event: { type: 'tool_completed', call: requestCall, result, resultItems } });
    context.items.push(...resultItems);
    await worker.rpc('store.checkpoint', { identity: run.identity, context });
    await worker.rpc('event', { type: 'tool_result', identity: run.identity, call: requestCall, result });
    await finish(worker, context, { toolCalls: 1 });
  });
  const result = await h.promise;
  assert.equal(result.toolCalls, 1);
  assert.equal(h.worker.scriptError, undefined);
  assert.deepEqual(h.journal.map(item => (item as { type: string }).type), ['model_request_started', 'model_response', 'tool_prepared', 'tool_completed', 'run_finished']);
});

test('worker cannot change prepared input or execute before durable preparation', async () => {
  for (const mutation of ['changed-input', 'missing-journal']) {
    let executions = 0;
    const h = harness(async worker => {
      const context = await begin(worker);
      const prepared = await prepare(worker, context);
      const approval = await worker.rpc('approval', approvalRequest(prepared));
      await worker.rpc('tools.validate', { prepared, context: executionContext() });
      if (mutation === 'changed-input') prepared.input.content = 'unauthorized';
      await worker.rpc('tools.execute', { prepared, context: executionContext(), approval });
    });
    h.options.tools.execute = async () => { executions++; return { status: 'completed', output: {} }; };
    await assert.rejects(h.promise, { code: 'protocol' });
    assert.equal(executions, 0);
  }
});

test('approval binding is checked in main and arbitrary errors are suppressed', async () => {
  let rejected = false;
  const h = harness(async worker => {
    const context = await begin(worker);
    const prepared = await prepare(worker, context);
    await assert.rejects(worker.rpc('approval', approvalRequest(prepared)), error => error instanceof Error && !error.message.includes('secret'));
    rejected = true;
    worker.exit(1);
  }, { approvals: { request: async request => ({ binding: { ...request.binding, workerGeneration: 999 }, decision: 'approved', expiresAt: request.expiresAt }) } });
  await assert.rejects(h.promise, error => error instanceof Error && !error.message.includes('secret'));
  assert.equal(rejected, true);
});

test('a thrown write cannot be relabeled as cancelled to erase an unknown side effect', async () => {
  const h = harness(async worker => {
    const context = await begin(worker);
    const prepared = await prepare(worker, context);
    const approval = await worker.rpc('approval', approvalRequest(prepared));
    await worker.rpc('tools.validate', { prepared, context: executionContext() });
    await worker.rpc('store.append', { identity: run.identity, event: { type: 'tool_prepared', prepared, approval } });
    await assert.rejects(worker.rpc('tools.execute', { prepared, context: executionContext(), approval }));
    const result = { status: 'cancelled', output: { executed: false } };
    await worker.rpc('store.append', { identity: run.identity, event: { type: 'tool_completed', call: requestCall, result, resultItems: [{ type: 'function_call_output', call_id: requestCall.id, output: JSON.stringify(result) }] } });
  });
  h.options.tools.execute = async () => { throw new Error('side effect happened before the secret failure'); };
  await assert.rejects(h.promise, { code: 'protocol' });
  assert.deepEqual(h.journal.map(item => (item as { type: string }).type), ['model_request_started', 'model_response', 'tool_prepared']);
});

test('RPC cancellation aborts approval but storage RPCs finish committing', async () => {
  let observedAbort = false;
  const h = harness(async worker => {
    const context = await begin(worker);
    const prepared = await prepare(worker, context);
    const pending = worker.rpc('approval', approvalRequest(prepared));
    await tick(); await tick();
    const requestId = `run:${worker.sequence}`;
    worker.send({ type: 'rpc_cancel', requestId });
    await assert.rejects(pending, /Native host operation failed/);
    worker.exit(1);
  }, { approvals: { request: async (_request, signal) => await new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { observedAbort = true; reject(new Error('secret cancelled')); }, { once: true });
  }) } });
  await assert.rejects(h.promise, { code: 'crash' });
  assert.equal(observedAbort, true);
});

test('worker crash waits for an aborted tool promise to release physical resources', async () => {
  let started!: () => void;
  const executing = new Promise<void>(resolve => { started = resolve; });
  let release!: (value: ToolResult) => void;
  let aborted = false;
  const h = harness(async worker => {
    const context = await begin(worker);
    const prepared = await prepare(worker, context);
    const approval = await worker.rpc('approval', approvalRequest(prepared));
    await worker.rpc('tools.validate', { prepared, context: executionContext() });
    await worker.rpc('store.append', { identity: run.identity, event: { type: 'tool_prepared', prepared, approval } });
    await worker.rpc('tools.execute', { prepared, context: executionContext(), approval });
  });
  h.options.tools.execute = async (_prepared, context) => {
    context.signal.addEventListener('abort', () => { aborted = true; });
    started();
    return await new Promise<ToolResult>(resolve => { release = resolve; });
  };
  let settled = false;
  void h.promise.catch(() => { settled = true; });
  await executing;
  h.worker.exit(1);
  await tick(); await tick();
  assert.equal(aborted, true);
  assert.equal(settled, false);
  release({ status: 'cancelled', output: { released: true } });
  await assert.rejects(h.promise, { code: 'crash' });
});

test('worker crash waits for an already-started store commit', async () => {
  let entered!: () => void, release!: () => void;
  const committing = new Promise<void>(resolve => { entered = resolve; });
  const h = harness(async worker => { await begin(worker); });
  h.options.store.checkpoint = async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); };
  let settled = false;
  void h.promise.catch(() => { settled = true; });
  await committing;
  h.worker.exit(1);
  await tick();
  assert.equal(settled, false);
  release();
  await assert.rejects(h.promise, { code: 'crash' });
});

test('unknown methods, wrong identity, stale sequence, oversized messages, and pending floods fail closed', async () => {
  for (const fault of ['method', 'identity', 'sequence', 'bytes', 'pending']) {
    const h = harness(async worker => {
      await begin(worker);
      if (fault === 'method') await worker.rpc('execute_arbitrary', {});
      if (fault === 'identity') worker.send({ type: 'fatal', identity: { ...run.identity, sessionId: 'other' }, message: 'secret' });
      if (fault === 'sequence') worker.emit('message', { type: 'fatal', version: WORKER_PROTOCOL, identity: run.identity, seq: worker.sequence, message: 'secret' });
      if (fault === 'bytes') worker.send({ type: 'fatal', message: 'x'.repeat(MAX_WORKER_MESSAGE_BYTES + 1) });
      if (fault === 'pending') {
        for (let i = 0; i <= MAX_WORKER_PENDING; i++) void worker.rpc('event', { type: 'text_delta', identity: run.identity, text: 'x'.repeat(64) }).catch(() => {});
      }
    }, fault === 'pending' ? { onEvent: async () => { await tick(); await tick(); } } : {});
    await assert.rejects(h.promise, { code: 'protocol' });
  }
});

test('event callbacks must drain before successful release and diagnostic strings never escape', async () => {
  let release!: () => void, entered!: () => void;
  const projecting = new Promise<void>(resolve => { entered = resolve; });
  const h = harness(async worker => { const context = await begin(worker); await finish(worker, context); }, {
    onEvent: async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); },
  });
  await projecting;
  assert.ok(!h.worker.sent.some(message => message.type === 'finish'));
  release();
  assert.equal((await h.promise).status, 'completed');
  const crashed = harness(async worker => { worker.emit('error', 'FatalError', 'secret-key-sentinel', '{"apiKey":"secret-key-sentinel"}'); });
  await assert.rejects(crashed.promise, error => error instanceof Error && !JSON.stringify(error).includes('secret-key-sentinel') && !error.message.includes('secret-key-sentinel'));
});

test('credential-buffered stream tails finish projecting before the full model response is persisted', async () => {
  const order: string[] = [];
  let projecting!: () => void, release!: () => void;
  const tailStarted = new Promise<void>(resolve => { projecting = resolve; });
  const h = harness(async worker => {
    const context = await begin(worker);
    await startAttempt(worker);
    await worker.rpc('event', { type: 'text_delta', identity: run.identity, text: 'short tail' });
    const response: ModelResponse = { outputItems: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'short tail' }] }], toolCalls: [], finishReason: 'completed', usage: null };
    await worker.rpc('store.append', { identity: run.identity, event: { type: 'model_response', response } });
    context.items.push(...response.outputItems);
    await worker.rpc('store.checkpoint', { identity: run.identity, context });
    await finish(worker, context);
  }, { onEvent: async event => {
    if (event.type !== 'text_delta') return;
    order.push(`delta:${event.text}`);
    projecting();
    await new Promise<void>(resolve => { release = resolve; });
    order.push('delta projected');
  } });
  const append = h.options.store.append;
  h.options.store.append = async (identity, event) => {
    if (event.type === 'model_response') order.push('model persisted');
    return await append(identity, event);
  };
  await tailStarted;
  assert.deepEqual(order, ['delta:short tail']);
  release();
  assert.equal((await h.promise).status, 'completed');
  assert.deepEqual(order, ['delta:short tail', 'delta projected', 'model persisted']);
});

test('worker output is drained, bounded, and never included in errors', async () => {
  const h = harness(async worker => { worker.stderr.write('secret-key-sentinel'); worker.stdout.write(Buffer.alloc(1024 * 1024 + 1)); });
  await assert.rejects(h.promise, error => (error as { code?: string }).code === 'stdio_limit' && !String(error).includes('secret'));
});

test('worker host rejects interleaved credential deltas from a compromised worker before projection', async () => {
  const key = 'secret-key-sentinel';
  const h = harness(async worker => {
    await begin(worker);
    await startAttempt(worker);
    await worker.rpc('event', { type: 'text_delta', identity: run.identity, text: key.slice(0, 7) });
    await worker.rpc('event', { type: 'tool_arguments_delta', identity: run.identity, callId: 'other', delta: 'padding'.repeat(20) });
    await worker.rpc('event', { type: 'text_delta', identity: run.identity, text: key.slice(7) });
  });
  await assert.rejects(h.promise, { code: 'protocol' });
  assert.ok(!h.events.filter(event => (event as { type: string }).type === 'text_delta').map(event => (event as { text: string }).text).join('').includes(key));
});

test('an environment credential is stripped even if its reference names an allowed operational variable', async () => {
  const previous = process.env.LANG;
  let h: ReturnType<typeof harness>;
  try {
    process.env.LANG = 'prefix-secret-key-sentinel-suffix';
    h = harness(async worker => { const context = await begin(worker); await finish(worker, context); });
  } finally {
    if (previous === undefined) delete process.env.LANG; else process.env.LANG = previous;
  }
  assert.equal((await h.promise).status, 'completed');
  assert.equal(h.forkOptions?.env.LANG, undefined);
});

test('MCP credentials stay in main and are stripped from allowed environment variables', async () => {
  const secret = 'mcp-main-process-sentinel', previous = process.env.LANG;
  let h: ReturnType<typeof harness>;
  try {
    process.env.LANG = `prefix-${secret}-suffix`;
    h = harness(async worker => { const context = await begin(worker); await finish(worker, context); }, { forbiddenValues: [secret] });
  } finally { if (previous === undefined) delete process.env.LANG; else process.env.LANG = previous; }
  assert.equal((await h.promise).status, 'completed');
  assert.equal(h.forkOptions?.env.LANG, undefined);
  const start = h.worker.sent.find(message => message.type === 'start')!;
  assert.equal('forbiddenValues' in start, false);
  assert.equal('forbiddenValues' in (start.model as Record<string, unknown>), false);
  assert.equal(JSON.stringify(start).includes(secret), false);
});

test('protected MCP credentials in initial input or instructions fail before a worker starts', async () => {
  const secret = 'mcp-main-process-sentinel';
  for (const overrides of [
    { request: { ...run, input: secret } },
    { model: { baseURL: 'http://127.0.0.1:1/v1', model: 'local', allowLoopbackHttp: true, instructions: secret } },
  ]) {
    const h = harness(async () => assert.fail('A worker must not receive protected inputs.'), { ...overrides, forbiddenValues: [secret] });
    await assert.rejects(h.promise, { code: 'credential' });
    assert.equal(h.forkOptions, undefined);
  }
});

test('independent shorter MCP secret fragments cannot pass model-key stream buffering', async () => {
  const secret = 'mcp-secret';
  const h = harness(async worker => {
    await begin(worker);
    await startAttempt(worker);
    await worker.rpc('event', { type: 'text_delta', identity: run.identity, text: secret.slice(0, 4) });
    await worker.rpc('event', { type: 'tool_arguments_delta', identity: run.identity, callId: 'other', delta: 'padding'.repeat(20) });
    await worker.rpc('event', { type: 'text_delta', identity: run.identity, text: secret.slice(4) });
  }, { forbiddenValues: [secret] });
  await assert.rejects(h.promise, { code: 'protocol' });
  assert.equal(h.events.filter(event => (event as { type: string }).type === 'text_delta').map(event => (event as { text: string }).text).join(''), '');
  assert.equal(JSON.stringify(h.worker.sent).includes(secret), false);
});

test('MCP credential echoes cannot become durable responses or worker tool replies', async () => {
  const secret = 'mcp-main-process-sentinel';
  const response = harness(async worker => {
    await begin(worker);
    await startAttempt(worker);
    await worker.rpc('store.append', { identity: run.identity, event: { type: 'model_response', response: {
      outputItems: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: secret }] }], toolCalls: [], usage: null, finishReason: 'completed',
    } } });
  }, { forbiddenValues: [secret] });
  await assert.rejects(response.promise, { code: 'protocol' });
  assert.deepEqual(response.journal, [{ type: 'model_request_started', attempt: 1 }]);
  const tool = harness(async worker => {
    const context = await begin(worker), prepared = await prepare(worker, context);
    const approval = await worker.rpc('approval', approvalRequest(prepared));
    await worker.rpc('tools.validate', { prepared, context: executionContext() });
    await worker.rpc('store.append', { identity: run.identity, event: { type: 'tool_prepared', prepared, approval } });
    await worker.rpc('tools.execute', { prepared, context: executionContext(), approval });
  }, { forbiddenValues: [secret] });
  tool.options.tools.execute = async () => ({ status: 'completed', output: secret });
  await assert.rejects(tool.promise, { code: 'protocol' });
  assert.equal(JSON.stringify(tool.worker.sent).includes(secret), false);
  assert.equal(JSON.stringify(tool.journal).includes(secret), false);
});

test('missing exit proof triggers kill fallback and a cleanup barrier', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(async worker => { worker.autoCancel = false; worker.emit('error', 'FatalError', 'secret', 'secret'); });
  h.worker.kill = () => { h.worker.killed = true; return false; };
  const rejected = assert.rejects(h.promise, error => error instanceof NativeWorkerCleanupError && error.cleanupUnconfirmed);
  await tick(); await tick();
  t.mock.timers.tick(10_000);
  assert.equal(h.worker.killed, true);
  t.mock.timers.tick(10_000);
  await rejected;
  h.worker.stdout.end(); h.worker.stderr.end();
});


const chatProtocol = { id: 'openai-chat-completions', version: 1 };
const chatModel = { protocol: 'chat-completions' as const, baseURL: 'http://127.0.0.1:1/v1', model: 'local', allowLoopbackHttp: true, apiKey: 'secret-key-sentinel' };
const chatCallMessage = () => ({ role: 'assistant', content: null, tool_calls: [{ id: requestCall.id, type: 'function', function: { name: requestCall.name, arguments: requestCall.arguments } }] });
test('chat worker host binds native messages, approvals, tool results and final context', async () => {
  const h = harness(async worker => {
    const context = await begin(worker, chatProtocol);
    await startAttempt(worker);
    const response: ModelResponse = { outputItems: [chatCallMessage()], toolCalls: [requestCall], usage: null, finishReason: 'tool_calls' };
    await worker.rpc('store.append', { identity: run.identity, event: { type: 'model_response', response } });
    context.items.push(...response.outputItems);
    const prepared = await worker.rpc<PreparedTool>('tools.prepare', { call: requestCall, context: executionContext() });
    const approval = await worker.rpc('approval', approvalRequest(prepared));
    await worker.rpc('tools.validate', { prepared, context: executionContext() });
    await worker.rpc('store.append', { identity: run.identity, event: { type: 'tool_prepared', prepared, approval } });
    const result = await worker.rpc<ToolResult>('tools.execute', { prepared, context: executionContext(), approval });
    const resultItems = [{ role: 'tool', tool_call_id: requestCall.id, content: JSON.stringify(result) }];
    await worker.rpc('store.append', { identity: run.identity, event: { type: 'tool_completed', call: requestCall, result, resultItems } });
    context.items.push(...resultItems);
    await worker.rpc('store.checkpoint', { identity: run.identity, context });
    await finish(worker, context, { toolCalls: 1 });
  }, { model: chatModel });
  const result = await h.promise;
  assert.equal(result.context.protocol.id, chatProtocol.id); assert.equal(result.toolCalls, 1); assert.equal(h.worker.scriptError, undefined);
  assert.deepEqual(result.context.items.at(-1), (h.journal.at(-2) as { resultItems: unknown[] }).resultItems[0]);
});

test('chat worker cannot claim the Responses protocol selected by neither connection nor host', async () => {
  const h = harness(async worker => { await begin(worker); }, { model: chatModel });
  await assert.rejects(h.promise, { code: 'protocol' }); assert.equal(h.journal.length, 0);
});

for (const forgery of ['mismatched_calls', 'hidden_reasoning', 'continuation', 'responses_result']) test(`chat worker rejects ${forgery} before accepting effects`, async () => {
  const h = harness(async worker => {
    await begin(worker, chatProtocol);
    await startAttempt(worker);
    const response: ModelResponse = { outputItems: [chatCallMessage()], toolCalls: [requestCall], usage: null, finishReason: 'tool_calls' };
    if (forgery === 'mismatched_calls') response.toolCalls = [{ ...requestCall, name: 'different' }];
    if (forgery === 'hidden_reasoning') (response.outputItems[0] as Record<string, unknown>).reasoning_content = 'opaque';
    if (forgery === 'continuation') response.continuation = { unknown: true };
    await worker.rpc('store.append', { identity: run.identity, event: { type: 'model_response', response } });
    if (forgery === 'responses_result') {
      const result = { status: 'denied', output: 'not authorized' };
      await worker.rpc('store.append', { identity: run.identity, event: { type: 'tool_completed', call: requestCall, result,
        resultItems: [{ type: 'function_call_output', call_id: requestCall.id, output: JSON.stringify(result) }] } });
    }
  }, { model: chatModel });
  await assert.rejects(h.promise, { code: 'protocol' });
  assert.equal(h.journal.length, forgery === 'responses_result' ? 2 : 1);
});

const anthropicProtocol = { id: 'anthropic-messages', version: 1 };
const anthropicModel = { protocol: 'anthropic' as const, authHeader: 'authorization' as const, baseURL: 'http://127.0.0.1:1', model: 'local', allowLoopbackHttp: true, apiKey: 'secret-key-sentinel' };
const anthropicCallMessage = () => ({ role: 'assistant', content: [{ type: 'tool_use', id: requestCall.id, name: requestCall.name, input: JSON.parse(requestCall.arguments) }] });
test('Anthropic worker host binds complete tool blocks, approval and native tool results', async () => {
  const h = harness(async worker => {
    const context = await begin(worker, anthropicProtocol);
    await startAttempt(worker);
    const response: ModelResponse = { outputItems: [anthropicCallMessage()], toolCalls: [requestCall], usage: null, finishReason: 'tool_calls' };
    await worker.rpc('store.append', { identity: run.identity, event: { type: 'model_response', response } });
    context.items.push(...response.outputItems);
    const prepared = await worker.rpc<PreparedTool>('tools.prepare', { call: requestCall, context: executionContext() });
    const approval = await worker.rpc('approval', approvalRequest(prepared));
    await worker.rpc('tools.validate', { prepared, context: executionContext() });
    await worker.rpc('store.append', { identity: run.identity, event: { type: 'tool_prepared', prepared, approval } });
    const result = await worker.rpc<ToolResult>('tools.execute', { prepared, context: executionContext(), approval });
    const resultItems = [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: requestCall.id, content: JSON.stringify(result), is_error: false }] }];
    await worker.rpc('store.append', { identity: run.identity, event: { type: 'tool_completed', call: requestCall, result, resultItems } });
    context.items.push(...resultItems);
    await worker.rpc('store.checkpoint', { identity: run.identity, context });
    await finish(worker, context, { toolCalls: 1 });
  }, { model: anthropicModel });
  const result = await h.promise;
  assert.equal(result.context.protocol.id, anthropicProtocol.id); assert.equal(result.toolCalls, 1);
  assert.equal(h.worker.scriptError, undefined);
});

for (const forgery of ['mismatched_calls', 'hidden_reasoning', 'continuation'] as const) test(`Anthropic worker rejects ${forgery} before accepting effects`, async () => {
  const h = harness(async worker => {
    await begin(worker, anthropicProtocol); await startAttempt(worker);
    const response: ModelResponse = { outputItems: [anthropicCallMessage()], toolCalls: [requestCall], usage: null, finishReason: 'tool_calls' };
    if (forgery === 'mismatched_calls') response.toolCalls = [{ ...requestCall, name: 'different' }];
    if (forgery === 'hidden_reasoning') (response.outputItems[0] as { content: unknown[] }).content.unshift({ type: 'thinking', thinking: 'opaque', signature: 'unknown' });
    if (forgery === 'continuation') response.continuation = { unknown: true };
    await worker.rpc('store.append', { identity: run.identity, event: { type: 'model_response', response } });
  }, { model: anthropicModel });
  await assert.rejects(h.promise, { code: 'protocol' });
  assert.equal(h.journal.length, 1);
});

test('Anthropic worker cannot journal credentials split across visible text blocks without stream deltas', async () => {
  const h = harness(async worker => {
    await begin(worker, anthropicProtocol); await startAttempt(worker);
    const response: ModelResponse = { outputItems: [{ role: 'assistant', content: [
      { type: 'text', text: 'secret-key-' }, { type: 'text', text: 'sentinel' },
    ] }], toolCalls: [], usage: null, finishReason: 'completed' };
    await worker.rpc('store.append', { identity: run.identity, event: { type: 'model_response', response } });
  }, { model: anthropicModel });
  await assert.rejects(h.promise, { code: 'protocol' });
  assert.equal(h.journal.length, 1); assert.equal(h.events.length, 0);
});

const maintenanceBudget = { ...DEFAULT_RUN_BUDGET, maxInputTokens: 1024 };
const maintenanceOptions = { request: { ...run, budget: maintenanceBudget }, model: {
  baseURL: 'http://127.0.0.1:1/v1', model: 'local', allowLoopbackHttp: true, apiKey: 'secret-key-sentinel', instructions: 'rules '.repeat(2000),
} };
async function maintenanceBoundary(worker: FakeWorker): Promise<ModelContext> {
  const context = await begin(worker);
  await prepare(worker, context);
  const denied: ToolResult = { status: 'denied', output: { executed: false } };
  const resultItems = [{ type: 'function_call_output', call_id: requestCall.id, output: JSON.stringify(denied) }];
  await worker.rpc('store.append', { identity: run.identity, event: { type: 'tool_completed', call: requestCall, result: denied, resultItems } });
  context.items.push(...resultItems);
  await worker.rpc('store.checkpoint', { identity: run.identity, context });
  return context;
}
const maintenanceRequest = (worker: FakeWorker, context: ModelContext) => {
  const start = worker.sent.find(message => message.type === 'start')!;
  const budget = { ...DEFAULT_RUN_BUDGET, ...(start.request as AgentRunRequest).budget };
  return { identity: run.identity, context, budget, modelRequests: 1, toolCalls: 1, remainingActiveMs: budget.maxActiveMs - 10 };
};

test('context maintenance sends only capability flag and accepts a trusted no-op at a complete tool boundary', async () => {
  let maintained = 0;
  const h = harness(async worker => {
    const context = await maintenanceBoundary(worker);
    assert.deepEqual(await worker.rpc('context.maintain', maintenanceRequest(worker, context)), { kind: 'unchanged', modelRequests: 0, usage: null });
    await finish(worker, context, { toolCalls: 1 });
  }, { ...maintenanceOptions, contextMaintenance: { async maintain(request) {
    maintained++; assert.ok(request.signal instanceof AbortSignal); assert.equal(request.modelRequests, 1);
    return { kind: 'unchanged', modelRequests: 0, usage: null };
  } } });
  assert.equal((await h.promise).status, 'completed'); assert.equal(maintained, 1);
  const start = h.worker.sent.find(message => message.type === 'start')!;
  assert.equal(start.contextMaintenance, true); assert.equal(h.worker.scriptError, undefined);
});

test('context maintenance switches host mirror only after authoritative replacement and validates later checkpoints', async () => {
  const replacement: ModelContext = { protocol: { id: 'openai-responses', version: 1 }, items: [{ role: 'user', content: run.input }, { role: 'assistant', content: 'historical summary' }] };
  const h = harness(async worker => {
    const previous = await maintenanceBoundary(worker);
    const result = await worker.rpc<ContextMaintenanceResult>('context.maintain', maintenanceRequest(worker, previous));
    assert.equal(result.kind, 'compacted');
    await worker.rpc('store.checkpoint', { identity: run.identity, context: replacement });
    await finish(worker, replacement, { modelRequests: 2, toolCalls: 1 });
  }, { ...maintenanceOptions, contextMaintenance: { async maintain() { return { kind: 'compacted', modelRequests: 1, usage: { inputTokens: 10, outputTokens: 2 }, context: replacement }; } } });
  assert.deepEqual((await h.promise).context, replacement); assert.equal(h.worker.scriptError, undefined);
});

for (const forgery of ['pending_call', 'different_context', 'different_budget', 'different_count', 'different_tools', 'repeat_boundary'] as const) test(`context maintenance rejects ${forgery} before a model-only request`, async () => {
  let maintained = 0;
  const h = harness(async worker => {
    let context: ModelContext;
    if (forgery === 'pending_call') { context = await begin(worker); await prepare(worker, context); }
    else context = await maintenanceBoundary(worker);
    const request = maintenanceRequest(worker, context);
    if (forgery === 'different_context') request.context = { ...context, items: [] };
    if (forgery === 'different_budget') request.budget = { ...maintenanceBudget, maxModelRequests: 99 };
    if (forgery === 'different_count') request.modelRequests = 0;
    if (forgery === 'different_tools') request.toolCalls = 0;
    if (forgery === 'repeat_boundary') await worker.rpc('context.maintain', request);
    await worker.rpc('context.maintain', request);
  }, { ...maintenanceOptions, contextMaintenance: { async maintain() { maintained++; return { kind: 'unchanged', modelRequests: 0, usage: null }; } } });
  await assert.rejects(h.promise, { code: 'protocol' }); assert.equal(maintained, forgery === 'repeat_boundary' ? 1 : 0);
});

test('context maintenance rejects concurrent store mutations while its host operation is unresolved', async () => {
  let release!: () => void, entered!: () => void, attacked!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const entering = new Promise<void>(resolve => { entered = resolve; });
  const attacking = new Promise<void>(resolve => { attacked = resolve; });
  const h = harness(async worker => {
    const context = await maintenanceBoundary(worker);
    void worker.rpc('context.maintain', maintenanceRequest(worker, context));
    await entering;
    const attempt = worker.rpc('store.checkpoint', { identity: run.identity, context });
    attacked(); await attempt;
  }, { ...maintenanceOptions, contextMaintenance: { async maintain() { entered(); await pending; return { kind: 'unchanged', modelRequests: 0, usage: null }; } } });
  await attacking; await tick();
  release(); await assert.rejects(h.promise, { code: 'protocol' });
});

test('unknown compaction acknowledgement allows only an uncommitted recovery result with exact old context', async () => {
  const h = harness(async worker => {
    const context = await maintenanceBoundary(worker);
    await assert.rejects(worker.rpc('context.maintain', maintenanceRequest(worker, context)), /host operation failed/);
    worker.send({ type: 'done', result: { identity: run.identity, status: 'recovery_required', reason: 'store_context_maintenance_failed',
      modelRequests: 2, toolCalls: 1, usage: null, context, committed: false } });
  }, { ...maintenanceOptions, contextMaintenance: { async maintain() { throw new Error('simulated acknowledgement loss'); } } });
  const result = await h.promise;
  assert.equal(result.status, 'recovery_required'); assert.equal(result.committed, false);
  assert.equal(h.journal.some(item => (item as { type: string }).type === 'run_finished'), false);
});

test('worker cannot append from the old context after unknown compaction acknowledgement', async () => {
  const h = harness(async worker => {
    const context = await maintenanceBoundary(worker);
    await assert.rejects(worker.rpc('context.maintain', maintenanceRequest(worker, context)), /host operation failed/);
    await worker.rpc('store.append', { identity: run.identity, event: { type: 'model_response', response: {
      outputItems: [{ role: 'assistant', content: 'forged continuation' }], toolCalls: [], finishReason: 'completed', usage: null,
    } } });
  }, { ...maintenanceOptions, contextMaintenance: { async maintain() { throw new Error('lost acknowledgement'); } } });
  await assert.rejects(h.promise, { code: 'protocol' });
  assert.equal(h.journal.filter(item => (item as { type: string }).type === 'model_response').length, 1);
});

test('failed maintenance cannot be followed by a manufactured successful terminal', async () => {
  const h = harness(async worker => {
    const context = await maintenanceBoundary(worker);
    await worker.rpc('context.maintain', maintenanceRequest(worker, context));
    await finish(worker, context, { modelRequests: 2, toolCalls: 1 });
  }, { ...maintenanceOptions, contextMaintenance: { async maintain() { return { kind: 'failed', modelRequests: 1, usage: null, reason: 'context_maintenance_failed' }; } } });
  await assert.rejects(h.promise, { code: 'protocol' });
});

test('cancellation reaches a live maintenance RPC and still waits for its host result before cleanup', async () => {
  const controller = new AbortController();
  let entered!: () => void, sawAbort = false;
  const entering = new Promise<void>(resolve => { entered = resolve; });
  const h = harness(async worker => {
    worker.autoCancel = false;
    const context = await maintenanceBoundary(worker);
    const maintained = await worker.rpc<ContextMaintenanceResult>('context.maintain', maintenanceRequest(worker, context));
    assert.equal(maintained.kind, 'failed');
    await finish(worker, context, { status: 'cancelled', reason: 'cancelled', modelRequests: 2, toolCalls: 1 });
  }, { ...maintenanceOptions, signal: controller.signal, contextMaintenance: { async maintain(request) {
    entered();
    await new Promise<void>(resolve => request.signal.addEventListener('abort', () => { sawAbort = true; resolve(); }, { once: true }));
    return { kind: 'failed', modelRequests: 1, usage: null, reason: 'context_maintenance_failed' };
  } } });
  await entering; controller.abort();
  assert.equal((await h.promise).status, 'cancelled'); assert.equal(sawAbort, true); assert.equal(h.worker.scriptError, undefined);
});

test('unconfirmed summary worker cleanup preserves the host resource barrier', async () => {
  const h = harness(async worker => {
    const context = await maintenanceBoundary(worker);
    await worker.rpc('context.maintain', maintenanceRequest(worker, context));
  }, { ...maintenanceOptions, contextMaintenance: { async maintain() { throw new NativeWorkerCleanupError(); } } });
  await assert.rejects(h.promise, error => error instanceof NativeWorkerCleanupError && error.cleanupUnconfirmed);
});

const transientFailure = { category: 'rate_limit', httpStatus: 429, retryable: true } as const;
const retryOptions = { request: { ...run, modelRetry: 'safe_transient' as const } };
async function failAttempt(worker: FakeWorker, options: { partial?: boolean; retryDelayMs?: number; failure?: unknown } = {}) {
  await worker.rpc('store.append', { identity: run.identity, event: { type: 'model_request_failed', attempt: worker.modelAttempts,
    failure: options.failure ?? transientFailure, partial: options.partial ?? false,
    ...(options.retryDelayMs === undefined ? {} : { retryDelayMs: options.retryDelayMs }) } });
}
async function textResponse(worker: FakeWorker, context: ModelContext) {
  const response: ModelResponse = { outputItems: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'complete' }] }],
    toolCalls: [], finishReason: 'completed', usage: null };
  await worker.rpc('store.append', { identity: run.identity, event: { type: 'model_response', response } });
  context.items.push(...response.outputItems);
}
for (const operation of ['response', 'stream', 'failure', 'malformed_failure']) test(`worker requires a durable active attempt before ${operation}`, async () => {
  const h = harness(async worker => {
    const context = await begin(worker);
    if (operation === 'response') await textResponse(worker, context);
    else if (operation === 'stream') await worker.rpc('event', { type: 'text_delta', identity: run.identity, text: 'forged' });
    else await worker.rpc('store.append', { identity: run.identity, event: { type: 'model_request_failed',
      ...(operation === 'malformed_failure' ? {} : { attempt: 1 }), failure: transientFailure, partial: false } });
  });
  await assert.rejects(h.promise, { code: 'protocol' }); assert.equal(h.journal.length, 0);
});
for (const attempt of [0, 2, '1']) test(`worker rejects invalid initial model attempt ${attempt}`, async () => {
  const h = harness(async worker => { await begin(worker); await worker.rpc('store.append', { identity: run.identity, event: { type: 'model_request_started', attempt } }); });
  await assert.rejects(h.promise, { code: 'protocol' }); assert.equal(h.journal.length, 0);
});
test('worker cannot overlap attempts or manufacture a successful terminal from a failed request', async () => {
  for (const operation of ['overlap', 'success', 'next']) {
    const h = harness(async worker => {
      const context = await begin(worker); await startAttempt(worker);
      if (operation !== 'overlap') await failAttempt(worker);
      if (operation === 'success') await finish(worker, context);
      else await startAttempt(worker);
    }, retryOptions);
    await assert.rejects(h.promise, { code: 'protocol' });
    assert.equal(h.journal.some(item => (item as { type: string }).type === 'run_finished'), false);
  }
});
for (const [name, failure, partial, retryDelayMs] of [
  ['wrong backoff', transientFailure, false, 100],
  ['non-transient HTTP', { category: 'service_error', httpStatus: 500, retryable: true }, false, 500],
  ['wrong category', { category: 'authentication', httpStatus: 429, retryable: true }, false, 500],
  ['unknown error', { category: 'unknown', retryable: false }, false, 500],
  ['partial stream', transientFailure, true, 500],
  ['arbitrary message', { ...transientFailure, message: 'untrusted' }, false, 500],
] as const) test(`worker rejects retry with ${name}`, async () => {
  const h = harness(async worker => { await begin(worker); await startAttempt(worker); await failAttempt(worker, { failure, partial, retryDelayMs }); }, retryOptions);
  await assert.rejects(h.promise, { code: 'protocol' }); assert.deepEqual(h.journal, [{ type: 'model_request_started', attempt: 1 }]);
});
test('retry stays disabled by default and cannot consume a nonexistent model slot', async () => {
  for (const overrides of [{}, { request: { ...run, modelRetry: 'safe_transient' as const, budget: { maxModelRequests: 1 } } }]) {
    const h = harness(async worker => { await begin(worker); await startAttempt(worker); await failAttempt(worker, { retryDelayMs: 500 }); }, overrides);
    await assert.rejects(h.promise, { code: 'protocol' });
  }
});
test('host enforces durable backoff and allows only two additional attempts per run', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const h = harness(async worker => {
    const context = await begin(worker); await startAttempt(worker);
    await failAttempt(worker, { retryDelayMs: 500 }); now += 500;
    await startAttempt(worker); await failAttempt(worker, { retryDelayMs: 1500 }); now += 1500;
    await startAttempt(worker); await textResponse(worker, context); await finish(worker, context);
  }, retryOptions);
  const result = await h.promise; assert.equal(result.modelRequests, 3);
  assert.deepEqual(h.journal.map(item => (item as { type: string }).type), ['model_request_started', 'model_request_failed', 'model_request_started', 'model_request_failed', 'model_request_started', 'model_response', 'run_finished']);
  for (const forgery of ['early', 'third']) {
    const denied = harness(async worker => {
      await begin(worker); await startAttempt(worker); await failAttempt(worker, { retryDelayMs: 500 });
      if (forgery === 'early') { await startAttempt(worker); return; }
      now += 500; await startAttempt(worker); await failAttempt(worker, { retryDelayMs: 1500 });
      now += 1500; await startAttempt(worker); await failAttempt(worker, { retryDelayMs: 1500 });
    }, retryOptions);
    await assert.rejects(denied.promise, { code: 'protocol' });
  }
});
test('observed partial output cannot be relabeled as empty and held tails never leak after failure', async () => {
  const forged = harness(async worker => {
    await begin(worker); await startAttempt(worker); await worker.rpc('event', { type: 'text_delta', identity: run.identity, text: 'tail' });
    await failAttempt(worker, { retryDelayMs: 500 });
  }, retryOptions);
  await assert.rejects(forged.promise, { code: 'protocol' });
  const h = harness(async worker => {
    const context = await begin(worker); await startAttempt(worker); await worker.rpc('event', { type: 'text_delta', identity: run.identity, text: 'tail' });
    await failAttempt(worker, { partial: true }); await finish(worker, context, { status: 'failed', reason: 'model_partial_response' });
  }, retryOptions);
  assert.equal((await h.promise).status, 'failed'); assert.equal(h.events.some(event => (event as { type: string }).type === 'text_delta'), false);
});
test('failed requests count toward maintenance and terminal request accounting', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now); let maintained = 0;
  const h = harness(async worker => {
    const context = await begin(worker); await startAttempt(worker); await failAttempt(worker, { retryDelayMs: 500 }); now += 500;
    await prepare(worker, context);
    const result: ToolResult = { status: 'denied', output: { executed: false } };
    const resultItems = [{ type: 'function_call_output', call_id: requestCall.id, output: JSON.stringify(result) }];
    await worker.rpc('store.append', { identity: run.identity, event: { type: 'tool_completed', call: requestCall, result, resultItems } });
    context.items.push(...resultItems); await worker.rpc('context.maintain', { ...maintenanceRequest(worker, context), modelRequests: 2 });
    await finish(worker, context, { toolCalls: 1 });
  }, { ...maintenanceOptions, request: { ...maintenanceOptions.request, modelRetry: 'safe_transient' }, contextMaintenance: {
    async maintain(request) { maintained++; assert.equal(request.modelRequests, 2); return { kind: 'unchanged', modelRequests: 0, usage: null }; },
  } });
  assert.equal((await h.promise).modelRequests, 2); assert.equal(maintained, 1);
  const forged = harness(async worker => {
    const context = await begin(worker); await startAttempt(worker); await failAttempt(worker);
    await finish(worker, context, { status: 'failed', reason: 'model_rate_limit', modelRequests: 0 });
  });
  await assert.rejects(forged.promise, { code: 'protocol' });
});
test('model journal acknowledgement loss allows recovery only and never another request', async () => {
  for (const proceed of [false, true]) {
    const h = harness(async worker => {
      const context = await begin(worker); await assert.rejects(startAttempt(worker), /host operation failed/);
      if (proceed) { await startAttempt(worker); return; }
      worker.send({ type: 'done', result: { identity: run.identity, status: 'recovery_required', reason: 'store_model_request_started_failed', modelRequests: 1, toolCalls: 0, usage: null, context, committed: false } });
    });
    h.options.store.append = async () => { throw new Error('acknowledgement lost'); };
    if (proceed) await assert.rejects(h.promise, { code: 'protocol' }); else assert.equal((await h.promise).committed, false);
  }
});
test('retry setting stays bound to the host configuration before worker startup', async () => {
  const h = harness(async () => assert.fail('Invalid binding must not spawn.'), { request: { ...run, modelRetry: 'safe_transient', configuration: { sessionOptions: { modelRetry: 'off' } } } });
  await assert.rejects(h.promise, { code: 'configuration' }); assert.equal(h.forkOptions, undefined);
});

for (const outcome of ['model_request_failed', 'model_response'] as const) test(`model journal rejects concurrent stream while ${outcome} commit is pending`, async () => {
  let entered!: () => void, release!: () => void;
  const committing = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const h = harness(async worker => {
    const context = await begin(worker); await startAttempt(worker);
    if (outcome === 'model_request_failed') await failAttempt(worker, { retryDelayMs: 500 });
    else await textResponse(worker, context);
  }, retryOptions);
  const append = h.options.store.append;
  h.options.store.append = async (identity, event) => {
    if (event.type === outcome) { entered(); await blocked; }
    return append(identity, event);
  };
  const rejected = assert.rejects(h.promise, { code: 'protocol' });
  await committing;
  void h.worker.rpc('event', { type: 'text_delta', identity: run.identity, text: 'late untrusted stream' }).catch(() => {});
  await tick(); await tick();
  assert.equal(h.worker.closed, true);
  assert.equal(h.events.some(event => (event as { type: string }).type === 'text_delta'), false);
  release(); await rejected;
  assert.equal(h.journal.filter(item => (item as { type: string }).type === 'model_request_started').length, 1);
});

test('model response boundary rejects a concurrent stream while its prior tail projects', async () => {
  let entered!: () => void, release!: () => void;
  const projecting = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const projected: string[] = [];
  const h = harness(async worker => {
    const context = await begin(worker); await startAttempt(worker);
    await worker.rpc('event', { type: 'text_delta', identity: run.identity, text: 'tail' });
    await textResponse(worker, context);
  }, { onEvent: async event => {
    if (event.type !== 'text_delta') return;
    projected.push(event.text); entered(); await blocked;
  } });
  const rejected = assert.rejects(h.promise, { code: 'protocol' });
  await projecting;
  void h.worker.rpc('event', { type: 'text_delta', identity: run.identity, text: 'forged' }).catch(() => {});
  await tick(); await tick();
  assert.equal(h.worker.closed, true); assert.deepEqual(projected, ['tail']);
  release(); await rejected;
  assert.deepEqual(projected, ['tail']);
});

const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');
const imageInput = { mimeType: 'image/png' as const, dataUrl: `data:image/png;base64,${imageBytes.toString('base64')}` };
const imageMetadata = { name: 'picture.png', mimeType: 'image/png', bytes: imageBytes.length, sha256: createHash('sha256').update(imageBytes).digest('hex') };
for (const forgery of ['missing', 'hash', 'bytes', 'content']) test(`image host rejects ${forgery} metadata before starting a worker`, async () => {
  const request = clone({ ...run, images: [imageInput], configuration: { ...run.configuration, imageAttachments: [imageMetadata] } });
  if (forgery === 'missing') request.configuration.imageAttachments = [];
  if (forgery === 'hash') request.configuration.imageAttachments[0].sha256 = 'a'.repeat(64);
  if (forgery === 'bytes') request.configuration.imageAttachments[0].bytes++;
  if (forgery === 'content') request.images[0].dataUrl = 'data:image/png;base64,AA==';
  const h = harness(async () => assert.fail('invalid image must not start'), { request });
  await assert.rejects(h.promise, { code: 'configuration' }); assert.equal(h.forkOptions, undefined); assert.equal(h.journal.length, 0);
});

for (const protocol of ['responses', 'chat-completions'] as const) for (const forgery of ['drop', 'replace'] as const) test(`${protocol}: worker cannot ${forgery} selected image in beginRun`, async () => {
  const request = clone({ ...run, images: [imageInput], configuration: { ...run.configuration, imageAttachments: [imageMetadata] } });
  const h = harness(async worker => {
    const image = protocol === 'responses' ? { type: 'input_image', image_url: imageInput.dataUrl, detail: 'auto' }
      : { type: 'image_url', image_url: { url: imageInput.dataUrl, detail: 'auto' } };
    const content: unknown[] = [protocol === 'responses' ? { type: 'input_text', text: run.input } : { type: 'text', text: run.input }];
    if (forgery === 'replace') content.push(protocol === 'responses' ? { ...image, image_url: 'data:image/png;base64,AA==' }
      : { ...image, image_url: { url: 'data:image/png;base64,AA==', detail: 'auto' } });
    const initial = { input: request.input, userItems: [{ role: 'user', content }], protocol: { id: protocol === 'responses' ? 'openai-responses' : 'openai-chat-completions', version: 1 }, configuration: request.configuration, policyRevision: request.policyRevision };
    await worker.rpc('store.beginRun', { ...initial, identity: request.identity, inputDigest: digest(initial) });
  }, { request, model: { protocol, baseURL: 'http://127.0.0.1:1/v1', model: 'local', allowLoopbackHttp: true, apiKey: 'secret-key-sentinel' } });
  await assert.rejects(h.promise, { code: 'protocol' }); assert.equal(h.journal.length, 0);
});

test('worker cannot introduce unselected image input through a model response', async () => {
  const h = harness(async worker => {
    await begin(worker); await startAttempt(worker);
    await worker.rpc('store.append', { identity: run.identity, event: { type: 'model_response', response: {
      outputItems: [{ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: imageInput.dataUrl, detail: 'auto' }] }],
      toolCalls: [], finishReason: 'completed', usage: null,
    } } });
  });
  await assert.rejects(h.promise, { code: 'protocol' }); assert.equal(h.journal.length, 1); assert.equal(h.events.length, 0);
});
