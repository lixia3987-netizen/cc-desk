import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { AgentRunRequest, RunStore, ToolPort } from '@cc-desk/agent-core';
import { NativeActiveClock, NativeActivePause, type NativeActivePauseSource } from '../src/main/engines/native/active-pause';
import { runNativeWorker, type NativeWorkerChild, type NativeWorkerOptions } from '../src/main/engines/native/worker-host';
import { WORKER_PROTOCOL } from '../src/main/engines/native/worker-protocol';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const request: Omit<AgentRunRequest, 'signal'> = {
  identity: { sessionId: 'parent', conversationId: 'conversation', runId: 'parent-run', requestId: 'submission', workerGeneration: 2 },
  input: 'Inspect the child result', configuration: { model: 'local' }, policyRevision: 'policy-v1', budget: { maxActiveMs: 100 },
};

test('overlapping approvals pause once and resume only after every approval releases', () => {
  const pause = new NativeActivePause(), transitions: boolean[] = [];
  pause.subscribe(() => { throw new Error('An observer must not strand the other workers'); });
  const unsubscribe = pause.subscribe(value => transitions.push(value));
  const first = pause.pause(), second = pause.pause(), third = pause.pause();
  assert.equal(pause.paused, true); assert.deepEqual(transitions, [true]);
  second(); first(); second(); assert.equal(pause.paused, true); assert.deepEqual(transitions, [true]);
  third(); third(); assert.equal(pause.paused, false); assert.deepEqual(transitions, [true, false]);
  unsubscribe(); const next = pause.pause(); next(); assert.deepEqual(transitions, [true, false]);
});

test('worker deadlines exclude a long nested approval without changing wall-time approval expiry', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10_000 });
  const clock = new NativeActiveClock(), parent = new AbortController(), deadline = clock.deadline(100, parent.signal);
  try {
    t.mock.timers.tick(40); clock.setPaused(true); const activeAtApproval = clock.now();
    t.mock.timers.tick(360_000);
    assert.equal(clock.now(), activeAtApproval); assert.equal(deadline.signal.aborted, false);
    assert.equal(Date.now(), 370_040, 'wall time continues while active time is paused');
    const nextApprovalExpiresAt = Date.now() + 300_000;
    assert.equal(nextApprovalExpiresAt - Date.now(), 300_000, 'a fresh approval still gets the full wall-time validity window');
    clock.setPaused(false); t.mock.timers.tick(59); assert.equal(deadline.signal.aborted, false);
    t.mock.timers.tick(1); assert.equal(deadline.signal.aborted, true);
    assert.match(String(deadline.signal.reason), /deadline exceeded/);
    assert.equal(clock.now(), 10_100);
  } finally { deadline.dispose(); }
});

test('one shared pause excludes overlapping approvals from both parent and child operation deadlines', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const shared = new NativeActivePause(), parentClock = new NativeActiveClock(), childClock = new NativeActiveClock();
  const subscriptions = [shared.subscribe(value => parentClock.setPaused(value)), shared.subscribe(value => childClock.setPaused(value))];
  const parent = parentClock.deadline(100, new AbortController().signal);
  t.mock.timers.tick(20); const child = childClock.deadline(100, new AbortController().signal);
  try {
    t.mock.timers.tick(20); const parentApproval = shared.pause(), childApproval = shared.pause();
    t.mock.timers.tick(500); parentApproval(); t.mock.timers.tick(500);
    assert.equal(parent.signal.aborted, false); assert.equal(child.signal.aborted, false);
    assert.equal(parentClock.now(), 40); assert.equal(childClock.now(), 40);
    childApproval(); t.mock.timers.tick(60);
    assert.equal(parent.signal.aborted, true); assert.equal(child.signal.aborted, false);
    t.mock.timers.tick(20); assert.equal(child.signal.aborted, true);
  } finally { parent.dispose(); child.dispose(); for (const unsubscribe of subscriptions) unsubscribe(); }
});

test('parent cancellation remains immediate during pause and disposed deadlines cannot rearm', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const clock = new NativeActiveClock(), parent = new AbortController(), reason = new Error('Parent cancelled');
  const deadline = clock.deadline(100, parent.signal); clock.setPaused(true);
  parent.abort(reason); assert.equal(deadline.signal.aborted, true); assert.equal(deadline.signal.reason, reason); deadline.dispose();
  const disposed = clock.deadline(100, new AbortController().signal); disposed.dispose();
  t.mock.timers.tick(500); clock.setPaused(false); t.mock.timers.tick(500);
  assert.equal(disposed.signal.aborted, false);
  const alreadyCancelled = clock.deadline(100, parent.signal); assert.equal(alreadyCancelled.signal.reason, reason); alreadyCancelled.dispose();
});

class WaitingWorker extends EventEmitter implements NativeWorkerChild {
  pid = 42;
  stdout = new PassThrough();
  stderr = new PassThrough();
  sent: Record<string, unknown>[] = [];
  closed = false;
  postMessage(message: unknown): void {
    const value = JSON.parse(JSON.stringify(message)) as Record<string, unknown>; this.sent.push(value);
    if (value.type === 'cancel') this.exit();
  }
  exit(): void {
    if (this.closed) return; this.closed = true;
    this.stdout.end(); this.stderr.end(); setImmediate(() => this.emit('exit', 1));
  }
  kill(): boolean { this.exit(); return true; }
  ready(): void { this.emit('message', { type: 'ready', version: WORKER_PROTOCOL, pid: this.pid }); }
}
function source(pause: NativeActivePause) {
  let subscriptions = 0;
  const value: NativeActivePauseSource = { get paused() { return pause.paused; }, subscribe(listener) {
    subscriptions++; const unsubscribe = pause.subscribe(listener); let released = false;
    return () => { if (released) return; released = true; subscriptions--; unsubscribe(); };
  } };
  return { value, get subscriptions() { return subscriptions; } };
}
function options(worker: WaitingWorker, pause: NativeActivePauseSource, abort: AbortController): NativeWorkerOptions {
  const store: RunStore = { beginRun: async input => ({ kind: 'accepted', context: { protocol: input.protocol, items: input.userItems } }),
    append: async () => ({ seq: 1 }), ensureCapacity: async () => {}, checkpoint: async () => {} };
  const tools: ToolPort = { definitions: [], prepare: async () => { throw new Error('No tool should run'); }, validate: async () => {}, execute: async () => { throw new Error('No tool should run'); } };
  return { request, model: { baseURL: 'http://127.0.0.1:1/v1', model: 'local', allowLoopbackHttp: true, apiKey: 'protected-key' },
    store, tools, approvals: { request: async () => { throw new Error('No approval should run'); } }, onEvent: () => {}, signal: abort.signal,
    activePause: pause, fork: () => worker };
}

test('a worker created during another approval keeps its startup budget and receives the initial pause before work', async t => {
  let now = 0; t.mock.method(performance, 'now', () => now);
  const pause = new NativeActivePause(), release = pause.pause(), tracked = source(pause), worker = new WaitingWorker(), abort = new AbortController();
  const running = runNativeWorker(options(worker, tracked.value, abort));
  const cancelled = assert.rejects(running, { code: 'crash' }); // The fake exits without journaling a terminal result.
  try {
    await tick(); now = 500; worker.ready();
    const start = worker.sent.find(value => value.type === 'start')!;
    assert.equal((start.request as AgentRunRequest).budget?.maxActiveMs, 100); assert.equal(start.activePaused, true);
    const initial = worker.sent.filter(value => value.type === 'active_pause');
    assert.deepEqual(initial, [{ type: 'active_pause', version: WORKER_PROTOCOL, identity: request.identity, paused: true }]);
    release(); assert.equal(worker.sent.at(-1)?.paused, false);
    const again = pause.pause(); abort.abort(); await cancelled; again();
    assert.equal(worker.sent.some(value => value.type === 'cancel'), true, 'cancellation is delivered while the active clock is paused');
    assert.equal(tracked.subscriptions, 0);
    const count = worker.sent.length, later = pause.pause(); later(); assert.equal(worker.sent.length, count);
    assert.equal(request.budget?.maxActiveMs, 100, 'caller budget is not mutated');
  } finally { release(); abort.abort(); worker.exit(); await running.catch(() => {}); }
});

test('startup charges active intervals around an approval and publishes later transitions only to the live worker', async t => {
  let now = 0; t.mock.method(performance, 'now', () => now);
  const pause = new NativeActivePause(), tracked = source(pause), worker = new WaitingWorker(), abort = new AbortController();
  let finishFork!: (worker: WaitingWorker) => void;
  const running = runNativeWorker({ ...options(worker, tracked.value, abort), fork: () => new Promise<WaitingWorker>(resolve => { finishFork = resolve; }) });
  const cancelled = assert.rejects(running, { code: 'crash' }); // The fake exits without journaling a terminal result.
  try {
    now = 10; const release = pause.pause(); now = 510; finishFork(worker); await tick(); release();
    now = 530; worker.ready();
    const start = worker.sent.find(value => value.type === 'start')!;
    assert.equal((start.request as AgentRunRequest).budget?.maxActiveMs, 70); assert.equal(start.activePaused, undefined);
    assert.equal(worker.sent.some(value => value.type === 'active_pause'), false, 'startup-only transitions need not replay after readiness');
    const first = pause.pause(), second = pause.pause(); first(); second();
    assert.deepEqual(worker.sent.filter(value => value.type === 'active_pause').map(value => value.paused), [true, false]);
    abort.abort(); await cancelled; assert.equal(tracked.subscriptions, 0);
  } finally { abort.abort(); worker.exit(); await running.catch(() => {}); }
});

test('a failed worker fork releases the active-pause subscription', async () => {
  const pause = new NativeActivePause(), tracked = source(pause), worker = new WaitingWorker();
  await assert.rejects(runNativeWorker({ ...options(worker, tracked.value, new AbortController()), fork: async () => { throw new Error('Cannot fork'); } }), { code: 'spawn' });
  assert.equal(tracked.subscriptions, 0); const release = pause.pause(); release(); assert.equal(worker.sent.length, 0);
});
