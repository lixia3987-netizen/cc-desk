import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { nativeDelegationIntervalsOverlap, nativeDelegationPoolEvidence,
  type NativeDelegationExecution, type NativeDelegationInstant } from '../src/main/engines/native/agent-delegation-audit';

type Child = NativeDelegationExecution['children'][number];
const instant = (monotonicMs: number): NativeDelegationInstant => ({ monotonicMs,
  wallTime: new Date(Date.UTC(2026, 9, 17) + monotonicMs).toISOString() });
const child = (times: { queued?: number; admitted?: number; started?: number; settled?: number; released?: number }): Child => ({
  childId: randomUUID(), identity: { sessionId: randomUUID(), conversationId: randomUUID(), runId: randomUUID(), requestId: randomUUID(), workerGeneration: 1 },
  ...Object.fromEntries(Object.entries(times).map(([key, value]) => [key, instant(value)])),
});
const execution = (children: Child[], capacity: number | undefined = 2): NativeDelegationExecution => ({
  version: 1, batchId: randomUUID(), parentRunId: randomUUID(), toolCallId: randomUUID(), mode: 'review',
  ...(capacity === undefined ? {} : { capacity }), clock: { id: randomUUID(), timeOrigin: Date.UTC(2026, 9, 17) }, children,
});
const queuedFive = (): NativeDelegationExecution => execution([
  child({ queued: 0, admitted: 1, started: 2, settled: 100, released: 101 }), // A holds one slot through every refill.
  child({ queued: 0, admitted: 1, started: 2, settled: 10, released: 11 }),
  child({ queued: 0, admitted: 11, started: 12, settled: 20, released: 21 }),
  child({ queued: 0, admitted: 21, started: 22, settled: 30, released: 31 }),
  child({ queued: 0, admitted: 31, started: 32, settled: 40, released: 41 }),
]);
const issues = (value: NativeDelegationExecution) => nativeDelegationPoolEvidence(value)!.issues;

test('a capacity-two five-task timeline proves three refills while the original slow worker remains active', () => {
  const value = queuedFive();
  assert.deepEqual(nativeDelegationPoolEvidence(value), { capacity: 2, peakActive: 2, queued: 5, started: 5,
    refilledBeforeEarlierSettled: 3, issues: [] });
  assert.equal(nativeDelegationIntervalsOverlap(value), true);
});

test('legacy worker overlap cannot invent a task-pool capacity or replenishment proof', () => {
  const value = queuedFive(); delete value.capacity;
  for (const row of value.children) { delete row.queued; delete row.admitted; delete row.released; }
  assert.equal(nativeDelegationIntervalsOverlap(value), true);
  assert.equal(nativeDelegationPoolEvidence(value), undefined);
});

test('capacity evidence includes preparation and cleanup even when worker intervals themselves do not overlap', () => {
  const value = execution([
    child({ queued: 0, admitted: 1, started: 2, settled: 3, released: 10 }),
    child({ queued: 0, admitted: 4, started: 5, settled: 6, released: 11 }),
    child({ queued: 0, admitted: 7, started: 8, settled: 9, released: 12 }),
  ]);
  assert.equal(nativeDelegationIntervalsOverlap(value), false);
  const result = nativeDelegationPoolEvidence(value)!;
  assert.equal(result.peakActive, 3);
  assert.ok(result.issues.includes('task_pool_capacity_exceeded'));
});

test('release and admission at the same monotonic instant reuse one slot without inventing a capacity breach', () => {
  const value = execution([
    child({ queued: 0, admitted: 1, started: 2, settled: 3, released: 4 }),
    child({ queued: 0, admitted: 4, started: 5, settled: 6, released: 7 }),
  ], 1);
  assert.equal(nativeDelegationPoolEvidence(value)!.peakActive, 1);
  assert.deepEqual(issues(value), []);
});

test('a child admitted before it was queued and an out-of-order FIFO admission are both rejected', () => {
  const beforeQueue = queuedFive(); beforeQueue.children[0].queued = instant(2);
  assert.ok(issues(beforeQueue).includes('task_pool_admission_order_invalid'));
  const outOfOrder = queuedFive();
  [outOfOrder.children[2], outOfOrder.children[3]] = [outOfOrder.children[3], outOfOrder.children[2]];
  assert.ok(issues(outOfOrder).includes('task_pool_admission_order_invalid'));
});

test('invalid worker and release ordering cannot become clean scheduling evidence', () => {
  for (const times of [
    { queued: 0, admitted: 10, started: 9, settled: 11, released: 12 },
    { queued: 0, admitted: 1, started: 3, settled: 2, released: 4 },
    { queued: 0, admitted: 1, started: 2, settled: 4, released: 3 },
    { queued: 0, admitted: 3, released: 2 },
  ]) assert.ok(issues(execution([child(times)])).includes('task_pool_timeline_invalid'));
});

test('a missing release or unmatched worker terminal remains unconfirmed', () => {
  for (const times of [
    { queued: 0, admitted: 1, started: 2, settled: 3 },
    { queued: 0, admitted: 1, started: 2, released: 3 },
    { queued: 0, admitted: 1, settled: 2, released: 3 },
  ]) assert.ok(issues(execution([child(times)])).includes('task_pool_release_unconfirmed'));
});

test('child IDs and worker run identities must each remain unique across queued tasks', () => {
  const repeatedChild = queuedFive(); repeatedChild.children[3].childId = repeatedChild.children[0].childId;
  assert.ok(issues(repeatedChild).includes('task_pool_identity_reused'));
  const repeatedRun = queuedFive(); repeatedRun.children[3].identity.runId = repeatedRun.children[0].identity.runId;
  assert.ok(issues(repeatedRun).includes('task_pool_identity_reused'));
});

test('failed preparation can occupy and release a slot without fabricating a worker start', () => {
  const result = nativeDelegationPoolEvidence(execution([child({ queued: 0, admitted: 1, released: 4 })], 1))!;
  assert.deepEqual(result, { capacity: 1, peakActive: 1, queued: 1, started: 0, refilledBeforeEarlierSettled: 0, issues: [] });
});

test('cancelled queued tasks with no admission neither consume slots nor manufacture worker execution', () => {
  const value = execution([child({ queued: 0 }), child({ queued: 0 }), child({ queued: 0 })], 1);
  assert.deepEqual(nativeDelegationPoolEvidence(value), { capacity: 1, peakActive: 0, queued: 3, started: 0,
    refilledBeforeEarlierSettled: 0, issues: [] });
  assert.equal(nativeDelegationIntervalsOverlap(value), false);
});

test('worker or release records without admission do not pass as cancelled queued tasks', () => {
  for (const times of [{ queued: 0, started: 1, settled: 2 }, { queued: 0, released: 2 }]) {
    assert.ok(issues(execution([child(times)])).includes('task_pool_start_without_admission'));
  }
});

test('missing queue timestamps and non-finite host times leave scheduling evidence unconfirmed', () => {
  const missing = queuedFive(); delete missing.children[0].queued;
  assert.ok(issues(missing).includes('task_pool_timeline_unconfirmed'));
  const nonFinite = queuedFive(); nonFinite.children[0].released!.monotonicMs = Number.NaN;
  assert.ok(issues(nonFinite).includes('task_pool_timeline_unconfirmed'));
});
