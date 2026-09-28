import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import path from 'node:path';
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

async function begin(worker: FakeWorker, protocol = { id: 'openai-responses', version: 1 }): Promise<ModelContext> {
  const initial = { input: run.input, userItems: [{ role: 'user', content: run.input }], protocol, configuration: run.configuration, policyRevision: run.policyRevision };
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
    await worker.rpc('store.append', { identity: run.identity, event: { type: 'model_response', response: {
      outputItems: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: secret }] }], toolCalls: [], usage: null, finishReason: 'completed',
    } } });
  }, { forbiddenValues: [secret] });
  await assert.rejects(response.promise, { code: 'protocol' });
  assert.deepEqual(response.journal, []);
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
  assert.equal(h.journal.length, forgery === 'responses_result' ? 1 : 0);
});
