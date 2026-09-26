import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import { canonicalJson, DEFAULT_RUN_BUDGET, type AgentRunRequest, type ApprovalPort, type BeginRunRequest, type ModelContext, type ModelResponse, type PreparedTool, type RunResult, type RunStore, type ToolCall, type ToolPort, type ToolResult } from '@cc-desk/agent-core';
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
  rpc<T = unknown>(method: string, args: unknown): Promise<T> {
    const seq = ++this.sequence;
    const requestId = `run:${seq}`;
    const promise = new Promise<T>((resolve, reject) => this.pending.set(requestId, { resolve: value => resolve(value as T), reject }));
    setImmediate(() => this.emit('message', { type: 'request', version: WORKER_PROTOCOL, identity: run.identity, seq, requestId, method, args: clone(args) }));
    return promise;
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

async function begin(worker: FakeWorker): Promise<ModelContext> {
  const initial = { input: run.input, userItems: [{ role: 'user', content: run.input }], protocol: { id: 'openai-responses', version: 1 }, configuration: run.configuration, policyRevision: run.policyRevision };
  const request: BeginRunRequest = { ...initial, identity: run.identity, inputDigest: digest(initial) };
  const admission = await worker.rpc<{ kind: 'accepted'; context: ModelContext }>('store.beginRun', request);
  await worker.rpc('store.checkpoint', { identity: run.identity, context: admission.context });
  return admission.context;
}
async function prepare(worker: FakeWorker, context: ModelContext): Promise<PreparedTool> {
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
  const result: RunResult = { identity: run.identity, status: 'completed', reason: 'model_completed', modelRequests: 1, toolCalls: 0, context, usage: null, committed: true, ...extra };
  await worker.rpc('store.append', { identity: run.identity, event: { type: 'run_finished', result } });
  await worker.rpc('event', { type: 'run_finished', identity: run.identity, result });
  worker.send({ type: 'done', result });
}

test('worker host starts with restricted environment and waits for done, finish, exit, and stream closure', async () => {
  const h = harness(async worker => { const context = await begin(worker); worker.autoFinish = false; await finish(worker, context); });
  let settled = false;
  void h.promise.then(() => { settled = true; });
  while (!h.worker.sent.some(message => message.type === 'finish')) await tick();
  assert.equal(settled, false);
  assert.ok(h.forkPath?.endsWith('/native/worker.cjs'));
  assert.deepEqual(h.forkOptions?.execArgv, []);
  assert.equal(h.forkOptions?.stdio, 'pipe');
  assert.ok(Object.keys(h.forkOptions!.env).every(name => ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'TZ'].includes(name)));
  assert.ok(!JSON.stringify(h.forkOptions).includes('secret-key-sentinel'));
  h.worker.exit(0, false);
  await tick();
  assert.equal(settled, false);
  h.worker.stdout.end(); h.worker.stderr.end();
  assert.equal((await h.promise).status, 'completed');
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
  assert.deepEqual(h.journal.map(item => (item as { type: string }).type), ['model_response', 'tool_prepared', 'tool_completed', 'run_finished']);
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
  assert.deepEqual(h.journal.map(item => (item as { type: string }).type), ['model_response', 'tool_prepared']);
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
