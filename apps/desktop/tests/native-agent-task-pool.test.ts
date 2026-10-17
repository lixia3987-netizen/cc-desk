import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ToolExecutionContext } from '@cc-desk/agent-core';
import { createAgentDelegationTools, type NativeAgentChildInput, type NativeAgentChildResult, type NativeDelegationReceipt } from '../src/main/engines/native/agent-delegation';
import { createNativeAgentTaskPool, NativeAgentTaskPoolClosedError, type NativeAgentTaskPool } from '../src/main/engines/native/agent-task-pool';
import { nativeDelegationExecutionPath } from '../src/main/engines/native/agent-delegation-audit';

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const resultFor = (input: NativeAgentChildInput, overrides: Partial<NativeAgentChildResult> = {}): NativeAgentChildResult => ({ identity: input.identity, taskId: input.taskId,
  status: 'completed', reason: 'model_completed', committed: true, summary: input.title, modelRequests: 1, toolCalls: 0, ...overrides });
const execute = promisify(execFile);
async function git(cwd: string, ...args: string[]) { return (await execute('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true })).stdout; }
async function fixture(t: { after(fn: () => Promise<void>): void }, runChild: (input: NativeAgentChildInput) => Promise<NativeAgentChildResult>,
  options: { capacity?: number; record?: (receipt: NativeDelegationReceipt) => Promise<void>; git?: boolean; taskPool?: NativeAgentTaskPool } = {}) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cc-native-task-pool-'))), cwd = path.join(directory, 'repo');
  await fs.mkdir(cwd); await fs.writeFile(path.join(cwd, 'source.txt'), 'original\n');
  if (options.git) {
    await git(cwd, 'init', '-b', 'main'); await git(cwd, 'config', 'user.name', 'Test'); await git(cwd, 'config', 'user.email', 'test@localhost');
    await git(cwd, 'config', 'core.autocrlf', 'false'); await git(cwd, 'add', '--all'); await git(cwd, 'commit', '-m', 'Initial');
  }
  const abort = new AbortController(), identity = { sessionId: randomUUID(), conversationId: randomUUID(), runId: randomUUID(), requestId: randomUUID(), workerGeneration: 1 };
  const receipts = new Map<string, NativeDelegationReceipt>(), budgets = new Set<string>();
  const storeDirectory = path.join(directory, 'records'), worktreeRoot = path.join(directory, 'worktrees');
  const tool = createAgentDelegationTools({ identity, parentTaskId: randomUUID(), cwd, policy: 'workspace_write', signal: abort.signal,
    forbiddenValues: [], storeDirectory, worktreeRoot, maxSubagents: options.capacity ?? 2, taskPool: options.taskPool, requiresApproval: false, assertOwnership: async () => {},
    createChildBudget(childIdentity) { budgets.add(childIdentity.runId); return { consume: async () => true, remainingMs: () => 120000, snapshot: () => ({ modelRequests: 0, toolCalls: 0 }) }; },
    runChild, record: async receipt => { receipts.set(receipt.childId, structuredClone(receipt)); await options.record?.(receipt); } });
  const context: ToolExecutionContext = { identity, policyRevision: 'policy', signal: abort.signal, maxOutputBytes: 65536 };
  t.after(async () => { abort.abort(); await tool.closeAll(); await fs.rm(directory, { recursive: true, force: true }); });
  const prepare = (titles: string[], implementation = false) => tool.prepare({ id: randomUUID(), name: implementation ? 'delegate_implement' : 'delegate_review', arguments: JSON.stringify({
    tasks: titles.map(title => ({ title, goal: `Independent question ${title}` })), ...(implementation ? { baseline: 'snapshot' } : {}),
  }) }, context);
  return { directory, cwd, storeDirectory, worktreeRoot, abort, tool, identity, context, prepare, receipts, budgets };
}

test('FIFO permits refill immediately and remain occupied until explicit physical settlement', async () => {
  const pool = createNativeAgentTaskPool({ capacity: 2 }), a = await pool.acquire(), b = await pool.acquire(), order: number[] = [];
  const c = pool.acquire().then(slot => { order.push(3); return slot; }), d = pool.acquire().then(slot => { order.push(4); return slot; });
  let drained = false; void pool.drain().then(() => { drained = true; });
  b.release(); const third = await c; assert.deepEqual(order, [3]); assert.equal(drained, false);
  third.release(); const fourth = await d; assert.deepEqual(order, [3, 4]);
  fourth.release(); await tick(); assert.equal(drained, false, 'A still physically owns its permit');
  a.release(); a.release(); await pool.drain(); assert.equal(drained, true);
  pool.close(); await assert.rejects(pool.acquire(), { reason: 'cancelled' });
});

test('cancelling a waiter removes its FIFO entry without releasing running work', async () => {
  const pool = createNativeAgentTaskPool({ capacity: 1 }), slot = await pool.acquire(), abort = new AbortController();
  const cancelled = pool.acquire(abort.signal).catch(error => error), next = pool.acquire();
  abort.abort(); assert.ok(await cancelled instanceof NativeAgentTaskPoolClosedError);
  let drained = false; void pool.drain().then(() => { drained = true; }); await tick(); assert.equal(drained, false);
  slot.release(); const replacement = await next; pool.close('unsafe');
  assert.equal(pool.signal.aborted, true); assert.ok(pool.signal.reason instanceof NativeAgentTaskPoolClosedError); assert.equal(pool.signal.reason.reason, 'unsafe');
  await tick(); assert.equal(drained, false, 'closing signals an admitted child but cannot release its physical permit');
  await assert.rejects(pool.acquire(), { reason: 'unsafe' }); replacement.release(); await pool.drain();
});

test('five queued children refill a cap of two while the first slow sibling is still running', async t => {
  const slow = deferred(), firstStarted = deferred(), quickDone = deferred(), started: string[] = []; let active = 0, peak = 0, slowFinished = false;
  const f = await fixture(t, async input => {
    started.push(input.title); peak = Math.max(peak, ++active);
    if (input.title === 'A') { firstStarted.resolve(); await slow.promise; slowFinished = true; }
    else if (input.title === 'B') await firstStarted.promise;
    active--; if (input.title === 'E') quickDone.resolve(); return resultFor(input);
  });
  f.abort.signal.addEventListener('abort', () => { slow.resolve(); firstStarted.resolve(); }, { once: true });
  const prepared = await f.prepare(['A', 'B', 'C', 'D', 'E']), pending = f.tool.execute(prepared, f.context);
  await quickDone.promise;
  assert.deepEqual(started.slice(0, 2).sort(), ['A', 'B']); assert.deepEqual(started.slice(2), ['C', 'D', 'E']);
  assert.equal(peak, 2); assert.equal(slowFinished, false); assert.equal(active, 1);
  slow.resolve(); assert.equal((await pending).status, 'completed');
  assert.equal(f.budgets.size, 5); assert.equal(f.receipts.size, 5); assert.ok([...f.receipts.values()].every(r => r.status === 'completed'));
  const receipt = [...f.receipts.values()][0], execution = JSON.parse(await fs.readFile(nativeDelegationExecutionPath(f.storeDirectory, f.identity, receipt.batchId), 'utf8'));
  assert.equal(execution.capacity, 2); assert.ok(execution.children.every((child: Record<string, unknown>) => child.queued && child.admitted && child.started && child.settled && child.released));
  for (const child of execution.children) {
    const times = [child.queued, child.admitted, child.started, child.settled, child.released].map(instant => instant.monotonicMs);
    assert.deepEqual(times, [...times].sort((a, b) => a - b));
  }
});

test('a completed worker keeps its permit until its durable final receipt is acknowledged', async t => {
  const saving = deferred(), release = deferred(), last = deferred(); let starts = 0, intentStarted = 0;
  const f = await fixture(t, async input => { starts++; if (input.title === 'B') last.resolve(); return resultFor(input); }, { capacity: 1, record: async receipt => {
    if (receipt.title === 'A' && receipt.status === 'queued') intentStarted = performance.now();
    if (receipt.title === 'A' && receipt.status === 'completed') { saving.resolve(); await release.promise; }
  } });
  f.abort.signal.addEventListener('abort', release.resolve, { once: true });
  const pending = f.tool.execute(await f.prepare(['A', 'B']), f.context); await saving.promise; await tick();
  assert.equal(starts, 1); assert.equal(f.budgets.size, 1); assert.equal([...f.receipts.values()].find(r => r.title === 'B')!.status, 'queued');
  release.resolve(); await last.promise; assert.equal((await pending).status, 'completed'); assert.equal(starts, 2);
  const receipt = [...f.receipts.values()].find(r => r.title === 'A')!, execution = JSON.parse(await fs.readFile(nativeDelegationExecutionPath(f.storeDirectory, f.identity, receipt.batchId), 'utf8'));
  const first = execution.children.find((child: { childId: string }) => child.childId === receipt.childId);
  assert.ok(first.queued.monotonicMs <= first.admitted.monotonicMs);
  assert.ok(first.admitted.monotonicMs <= intentStarted, 'grant time includes durable intent preparation, before a worker starts');
});

test('atomic thirty-task admission rejects overflow without effects and duplicate execution never launches twice', async t => {
  const saving = deferred(), release = deferred(); let first = true, starts = 0;
  const f = await fixture(t, async input => { starts++; return resultFor(input); }, { record: async receipt => {
    if (first && receipt.status === 'queued') { first = false; saving.resolve(); await release.promise; }
  } });
  f.abort.signal.addEventListener('abort', release.resolve, { once: true });
  const firstCall = await f.prepare(Array.from({ length: 20 }, (_, i) => `A${i}`)), secondCall = await f.prepare(Array.from({ length: 10 }, (_, i) => `B${i}`)), overflow = await f.prepare(['Overflow']);
  const one = f.tool.execute(firstCall, f.context); await saving.promise;
  const duplicate = f.tool.execute(firstCall, f.context), two = f.tool.execute(secondCall, f.context);
  const rejected = await f.tool.execute(overflow, f.context);
  assert.equal(rejected.status, 'not_executed'); assert.deepEqual(rejected.output, { error: 'delegation_queue_full' });
  f.abort.abort(); release.resolve(); const results = await Promise.all([one, duplicate, two]);
  assert.ok(results.every(result => result.status === 'cancelled')); assert.deepEqual(results[0], results[1]);
  assert.equal(starts, 0); assert.equal(f.budgets.size, 0); assert.equal(f.receipts.size, 30);
  assert.ok([...f.receipts.values()].every(r => r.status === 'cancelled' && !r.result && !r.workspace));
  assert.ok([...f.receipts.values()].every(r => r.title !== 'Overflow'));
  await assert.rejects(fs.stat(f.worktreeRoot), { code: 'ENOENT' });
});

test('unknown execution halts queued starts before returning a permit', async t => {
  const starts: string[] = [], f = await fixture(t, async input => {
    starts.push(input.title); return resultFor(input, { status: 'recovery_required', reason: 'cleanup_unconfirmed' });
  }, { capacity: 1 });
  const result = await f.tool.execute(await f.prepare(['Unsafe', 'B', 'C', 'D']), f.context);
  assert.equal(result.status, 'completed'); assert.deepEqual(starts, ['Unsafe']); assert.equal(f.budgets.size, 1);
  assert.equal([...f.receipts.values()].find(r => r.title === 'Unsafe')!.status, 'unknown');
  assert.ok([...f.receipts.values()].filter(r => r.title !== 'Unsafe').every(r => r.status === 'failed' && r.error === 'delegation_queue_halted' && !r.result));
  await assert.rejects(f.prepare(['New work']));
});

test('another producer closing the shared pool stops admitted children before worker launch', async t => {
  const pool = createNativeAgentTaskPool({ capacity: 1 }), prepared = deferred(), release = deferred(); let starts = 0;
  const f = await fixture(t, async input => { starts++; return resultFor(input); }, { capacity: 1, taskPool: pool, record: async receipt => {
    if (receipt.title === 'Admitted' && receipt.status === 'prepared') { prepared.resolve(); await release.promise; }
  } });
  f.abort.signal.addEventListener('abort', release.resolve, { once: true });
  const pending = f.tool.execute(await f.prepare(['Admitted', 'Queued']), f.context); await prepared.promise;
  pool.close('unsafe'); assert.equal(pool.signal.aborted, true);
  let drained = false; void pool.drain().then(() => { drained = true; }); await tick(); assert.equal(drained, false);
  release.resolve(); assert.equal((await pending).status, 'completed'); await pool.drain();
  assert.equal(starts, 0); assert.equal(f.budgets.size, 0);
  assert.ok([...f.receipts.values()].every(receipt => receipt.status === 'failed' && receipt.error === 'delegation_queue_halted' && !receipt.result));
});

test('a final receipt acknowledgement failure stops automatic replenishment', async t => {
  const starts: string[] = []; let fail = true;
  const f = await fixture(t, async input => { starts.push(input.title); return resultFor(input); }, { capacity: 1, record: async receipt => {
    if (fail && receipt.status === 'completed') { fail = false; throw new Error('Host persistence acknowledgement unavailable'); }
  } });
  assert.equal((await f.tool.execute(await f.prepare(['A', 'B', 'C']), f.context)).status, 'completed');
  assert.deepEqual(starts, ['A']); assert.equal(f.budgets.size, 1);
  assert.equal([...f.receipts.values()].find(r => r.title === 'A')!.status, 'unknown');
  assert.ok([...f.receipts.values()].filter(r => r.title !== 'A').every(r => r.status === 'failed' && !r.result));
});

test('parent cancellation leaves queued implementation tasks without a worker budget or worktree', async t => {
  const started = deferred();
  const f = await fixture(t, input => new Promise(resolve => {
    input.signal.addEventListener('abort', () => resolve(resultFor(input, { status: 'cancelled', reason: 'parent_cancelled' })), { once: true });
    started.resolve();
  }), { capacity: 1, git: true });
  const pending = f.tool.execute(await f.prepare(['Active', 'Queued B', 'Queued C'], true), f.context);
  await started.promise; f.abort.abort(); assert.equal((await pending).status, 'cancelled');
  assert.equal(f.budgets.size, 1);
  const queued = [...f.receipts.values()].filter(r => r.title !== 'Active');
  assert.equal(queued.length, 2); assert.ok(queued.every(r => r.status === 'cancelled' && !r.workspace && !r.result && !r.artifact));
  assert.equal((await fs.readdir(f.worktreeRoot)).filter(name => name !== '.indices').length, 1);
  const receipt = [...f.receipts.values()][0], execution = JSON.parse(await fs.readFile(nativeDelegationExecutionPath(f.storeDirectory, f.identity, receipt.batchId), 'utf8'));
  for (const receipt of queued) {
    const evidence = execution.children.find((child: { childId: string }) => child.childId === receipt.childId);
    assert.ok(evidence.queued); assert.equal(evidence.admitted, undefined); assert.equal(evidence.started, undefined); assert.equal(evidence.settled, undefined); assert.equal(evidence.released, undefined);
  }
});

test('a queued implementation rechecks the frozen parent baseline before creating a workspace or budget', async t => {
  let starts = 0;
  const f = await fixture(t, async input => {
    starts++; await fs.writeFile(path.join(f.cwd, 'source.txt'), 'parent changed while the sibling was active\n'); return resultFor(input);
  }, { capacity: 1, git: true });
  assert.equal((await f.tool.execute(await f.prepare(['A', 'B'], true), f.context)).status, 'completed');
  assert.equal(starts, 1); assert.equal(f.budgets.size, 1);
  const second = [...f.receipts.values()].find(r => r.title === 'B')!;
  assert.equal(second.status, 'failed'); assert.equal(second.error, 'baseline_changed'); assert.equal(second.workspace, undefined); assert.equal(second.result, undefined);
  assert.equal((await fs.readdir(f.worktreeRoot)).filter(name => name !== '.indices').length, 1);
});
