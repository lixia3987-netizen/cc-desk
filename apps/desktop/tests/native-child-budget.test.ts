import test from 'node:test';
import assert from 'node:assert/strict';
import type { RunIdentity } from '@cc-desk/agent-core';
import { createNativeChildBudget } from '../src/main/engines/native/child-budget';

const identity = (id: string): RunIdentity => ({ sessionId: `session-${id}`, conversationId: `conversation-${id}`,
  runId: `run-${id}`, requestId: `request-${id}`, workerGeneration: 1 });
const limits = { maxModelRequests: 2, maxToolCalls: 3, maxActiveMs: 100 };

test('each child receives independent model and tool counters and cannot spend a sibling allowance', async () => {
  const parent = new AbortController(), firstId = identity('first'), secondId = identity('second');
  const first = createNativeChildBudget(firstId, limits, parent.signal, () => 0);
  const second = createNativeChildBudget(secondId, limits, parent.signal, () => 0);
  for (const [kind, maximum] of [['model', 2], ['tool', 3]] as const) {
    for (let index = 0; index < maximum; index++) assert.equal(await first.consume(kind, firstId), true);
    assert.equal(await first.consume(kind, firstId), false);
    for (let index = 0; index < maximum; index++) assert.equal(await second.consume(kind, secondId), true);
    assert.equal(await second.consume(kind, secondId), false);
  }
  assert.deepEqual(first.snapshot(), { modelRequests: 2, toolCalls: 3 });
  assert.deepEqual(second.snapshot(), { modelRequests: 2, toolCalls: 3 });
  await assert.rejects(first.consume('model', secondId), /身份已失效/);
  await assert.rejects(second.consume('tool', firstId), /身份已失效/);
  assert.deepEqual(first.snapshot(), { modelRequests: 2, toolCalls: 3 });
});

test('a child approval pauses only its own clock while a sibling can exhaust its active time', async () => {
  let now = 0;
  const parent = new AbortController(), firstId = identity('waiting'), secondId = identity('working');
  const first = createNativeChildBudget(firstId, limits, parent.signal, () => now);
  const second = createNativeChildBudget(secondId, limits, parent.signal, () => now);
  now = 20;
  const resume = first.pause!();
  now = 1000;
  assert.equal(first.activePause!.paused, true);
  assert.equal(second.activePause!.paused, false);
  assert.equal(first.remainingMs(), 80);
  assert.equal(second.remainingMs(), 0);
  assert.equal(await second.consume('model', secondId), false);
  resume();
  assert.equal(await first.consume('model', firstId), true);
  now = 1079;
  assert.equal(first.remainingMs(), 1);
  now = 1080;
  assert.equal(first.remainingMs(), 0);
  assert.equal(await first.consume('tool', firstId), false);
  assert.deepEqual(second.snapshot(), { modelRequests: 0, toolCalls: 0 });
});

test('overlapping approvals exclude waiting once and resume after the last approval releases', () => {
  let now = 0;
  const child = createNativeChildBudget(identity('overlap'), limits, new AbortController().signal, () => now);
  now = 10;
  const first = child.pause!(), second = child.pause!();
  now = 1010;
  first(); first();
  assert.equal(child.remainingMs(), 90);
  assert.equal(child.activePause!.paused, true);
  now = 2010;
  second(); second();
  now = 2020;
  assert.equal(child.activePause!.paused, false);
  assert.equal(child.remainingMs(), 80);
});

test('a recovery attempt starts with fresh counters and active time after the failed attempt exhausted both', async () => {
  let now = 0;
  const parent = new AbortController(), oldId = identity('old'), nextId = identity('recovery');
  const previous = createNativeChildBudget(oldId, limits, parent.signal, () => now);
  assert.equal(await previous.consume('model', oldId), true);
  assert.equal(await previous.consume('model', oldId), true);
  assert.equal(await previous.consume('model', oldId), false);
  now = 1000;
  assert.equal(previous.remainingMs(), 0);
  const recovery = createNativeChildBudget(nextId, limits, parent.signal, () => now);
  assert.equal(recovery.remainingMs(), 100);
  assert.deepEqual(recovery.snapshot(), { modelRequests: 0, toolCalls: 0 });
  assert.equal(await recovery.consume('model', nextId), true);
  assert.equal(await recovery.consume('tool', nextId), true);
  now = 1040;
  assert.equal(recovery.remainingMs(), 60);
  assert.equal(previous.remainingMs(), 0);
  assert.equal(await previous.consume('tool', oldId), false);
  assert.deepEqual(previous.snapshot(), { modelRequests: 2, toolCalls: 0 });
});

test('parent cancellation stops every child independently even while one child is waiting for approval', async () => {
  const parent = new AbortController(), firstId = identity('cancel-first'), secondId = identity('cancel-second');
  const first = createNativeChildBudget(firstId, limits, parent.signal, () => 0);
  const second = createNativeChildBudget(secondId, limits, parent.signal, () => 0);
  const resume = first.pause!();
  try {
    parent.abort();
    assert.equal(await first.consume('model', firstId), false);
    assert.equal(await first.consume('tool', firstId), false);
    assert.equal(await second.consume('model', secondId), false);
    assert.equal(await second.consume('tool', secondId), false);
    assert.deepEqual(first.snapshot(), { modelRequests: 0, toolCalls: 0 });
    assert.deepEqual(second.snapshot(), { modelRequests: 0, toolCalls: 0 });
  } finally { resume(); }
});
