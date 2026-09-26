import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ChatQueue } from '../src/main/chat-queue';
import type { ChatQueueStorage } from '../src/main/chat-queue-storage';
import type { ChatTurnResult, QueuedChatMessage } from '../src/shared/chat';

type Options = ConstructorParameters<typeof ChatQueue>[1];
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(condition: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, 'timed out waiting for queue state');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
const success: ChatTurnResult = { success: true, summary: 'finished' };
const interrupted: ChatTurnResult = { success: false, summary: '', interrupted: true };
type QueueRun = { sessionId: string; item: QueuedChatMessage; result: ReturnType<typeof deferred<ChatTurnResult>> };

function fixture(overrides: Partial<Options> = {}, directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-chat-queue-'))) {
  const runs: QueueRun[] = [];
  const runObservers = new Map<string, (run: QueueRun) => void>();
  const active = new Set<string>();
  const interruptions: string[] = [];
  const changed: string[] = [];
  const queue = new ChatQueue(directory, {
    assertAvailable: () => {}, blocked: () => false,
    acceptAttachments: async (_id, _files, commit) => commit(),
    run: async (sessionId, item) => {
      assert.equal(active.has(sessionId), false, 'two turns must never run concurrently in one session');
      active.add(sessionId);
      const result = deferred<ChatTurnResult>();
      const run = { sessionId, item: structuredClone(item), result };
      runs.push(run);
      runObservers.get(item.text)?.(run); runObservers.delete(item.text);
      try { return await result.promise; } finally { active.delete(sessionId); }
    },
    interrupt: async id => { interruptions.push(id); },
    changed: id => { changed.push(id); },
    ...overrides,
  });
  return {
    directory, queue, runs, active, interruptions, changed,
    waitForRun(text: string): Promise<QueueRun> {
      const run = runs.find(item => item.item.text === text);
      return run ? Promise.resolve(run) : new Promise(resolve => runObservers.set(text, resolve));
    },
    async close() {
      queue.pauseAll();
      for (const run of runs) run.result.resolve(interrupted);
      await until(() => runs.every(run => !queue.hasActive(run.sessionId)));
      await tick();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('queue accepts messages before turn completion and executes accepted messages once in FIFO order', async () => {
  const f = fixture(), sessionId = randomUUID();
  try {
    const first = await f.queue.submit(sessionId, 'first');
    const second = await f.queue.submit(sessionId, 'second', ['/tmp/second.txt']);
    const third = await f.queue.submit(sessionId, 'third');
    await tick();
    assert.equal(f.runs.length, 1);
    assert.equal(f.runs[0].item.id, first.messageId);
    assert.deepEqual(f.queue.snapshot(sessionId).items.map(item => [item.text, item.status]), [
      ['first', 'sending'], ['second', 'queued'], ['third', 'queued'],
    ]);
    f.runs[0].result.resolve(success);
    await until(() => f.runs.length === 2);
    assert.equal(f.runs[1].item.id, second.messageId);
    assert.deepEqual(f.runs[1].item.attachments, ['/tmp/second.txt']);
    f.runs[1].result.resolve(success);
    await until(() => f.runs.length === 3);
    assert.equal(f.runs[2].item.id, third.messageId);
    f.runs[2].result.resolve(success);
    await until(() => !f.queue.hasPending(sessionId));
    assert.equal(f.queue.hasPending(sessionId), false);
    assert.deepEqual(f.queue.snapshot(sessionId).items, []);
  } finally { await f.close(); }
});

test('queues isolate sessions while permitting independent sessions to run concurrently', async () => {
  const f = fixture(), first = randomUUID(), second = randomUUID();
  try {
    await f.queue.submit(first, 'first active');
    await f.queue.submit(first, 'first waiting');
    await f.queue.submit(second, 'second active');
    await tick();
    assert.deepEqual(f.runs.map(run => run.item.text), ['first active', 'second active']);
    f.runs[1].result.resolve(success);
    await until(() => !f.queue.hasPending(second));
    assert.equal(f.queue.hasPending(second), false);
    assert.equal(f.queue.snapshot(first).items.length, 2);
    assert.equal(f.runs.length, 2);
  } finally { await f.close(); }
});

test('send now promotes the selected message and waits for both interrupt acknowledgment and the active turn to settle', async () => {
  const interruptAck = deferred<void>();
  const f = fixture({ interrupt: async id => { f.interruptions.push(id); await interruptAck.promise; } });
  const sessionId = randomUUID();
  try {
    await f.queue.submit(sessionId, 'active');
    await f.queue.submit(sessionId, 'waiting first');
    const priority = await f.queue.submit(sessionId, 'urgent');
    await f.queue.submit(sessionId, 'waiting last');
    await tick();
    const promotion = f.queue.sendNow(sessionId, priority.messageId);
    await tick();
    assert.deepEqual(f.interruptions, [sessionId]);
    assert.equal(f.runs.length, 1);
    interruptAck.resolve();
    await tick();
    // An interrupt control acknowledgment alone does not release runtime.busy.
    assert.equal(f.runs.length, 1);
    f.runs[0].result.resolve(interrupted);
    await promotion;
    await until(() => f.runs.length === 2);
    assert.deepEqual(f.runs.map(run => run.item.text), ['active', 'urgent']);
    f.runs[1].result.resolve(success);
    await until(() => f.runs.length === 3);
    assert.equal(f.runs[2].item.text, 'waiting first');
    f.runs[2].result.resolve(success);
    await until(() => f.runs.length === 4);
    assert.equal(f.runs[3].item.text, 'waiting last');
  } finally { interruptAck.resolve(); await f.close(); }
});

test('explicit pause wins over a late successful result and requires a requested resume', async () => {
  const f = fixture(), sessionId = randomUUID();
  try {
    await f.queue.submit(sessionId, 'active');
    await f.queue.submit(sessionId, 'waiting');
    await tick();
    f.queue.pause(sessionId);
    f.runs[0].result.resolve(success);
    await until(() => !f.queue.hasActive(sessionId));
    f.queue.wake(sessionId);
    await tick();
    assert.equal(f.runs.length, 1);
    assert.equal(f.queue.snapshot(sessionId).paused, true);
    assert.deepEqual(f.queue.snapshot(sessionId).items.map(item => item.text), ['waiting']);
    await f.queue.resume(sessionId);
    await until(() => f.runs.length === 2);
    assert.equal(f.runs[1].item.text, 'waiting');
  } finally { await f.close(); }
});

test('maintenance pauses all queues, rejects new submissions, and does not automatically dispatch when maintenance ends', async () => {
  let maintenance = false;
  const f = fixture({
    assertAvailable: () => { if (maintenance) throw new Error('maintenance'); },
    blocked: () => maintenance,
  });
  const first = randomUUID(), second = randomUUID();
  try {
    await f.queue.submit(first, 'active one');
    await f.queue.submit(first, 'waiting one');
    await f.queue.submit(second, 'active two');
    await f.queue.submit(second, 'waiting two');
    await tick();
    maintenance = true;
    f.queue.pauseAll();
    await assert.rejects(f.queue.submit(first, 'during update'), /maintenance/);
    for (const run of f.runs) run.result.resolve(interrupted);
    await tick();
    maintenance = false;
    f.queue.wake(first); f.queue.wake(second);
    await tick();
    assert.equal(f.runs.length, 2);
    assert.equal(f.queue.snapshot(first).paused, true);
    assert.equal(f.queue.snapshot(second).paused, true);
    assert.ok(f.queue.snapshot(first).items.some(item => item.text === 'waiting one'));
    assert.ok(f.queue.snapshot(second).items.some(item => item.text === 'waiting two'));
  } finally { await f.close(); }
});

test('session maintenance preserves another queue FIFO and requires manual continuation only for its targets', async () => {
  const f = fixture(), target = randomUUID(), other = randomUUID();
  try {
    await f.queue.submit(target, 'target active');
    await f.queue.submit(target, 'target waiting');
    await f.queue.submit(other, 'other active');
    await f.queue.submit(other, 'other waiting');
    const [targetRun, otherRun] = await Promise.all([f.waitForRun('target active'), f.waitForRun('other active')]);
    f.queue.pauseSessions([target], 'target maintenance');
    targetRun.result.resolve(success); otherRun.result.resolve(success);
    const next = await f.waitForRun('other waiting');
    assert.deepEqual(f.runs.map(run => run.item.text), ['target active', 'other active', 'other waiting']);
    assert.equal(f.queue.snapshot(target).paused, true);
    assert.equal(f.queue.snapshot(target).error, 'target maintenance');
    assert.deepEqual(f.queue.snapshot(target).items.map(item => item.text), ['target waiting']);
    assert.equal(f.queue.snapshot(other).paused, false);
    assert.equal(f.queue.snapshot(other).error, undefined);
    await f.queue.resume(target);
    assert.equal((await f.waitForRun('target waiting')).sessionId, target);
    next.result.resolve(success);
  } finally { await f.close(); }
});

test('session maintenance invalidates only its target send-now generation while another promotion completes', async () => {
  const target = randomUUID(), other = randomUUID();
  const targetInterrupt = deferred<void>(), otherInterrupt = deferred<void>(), releaseInterrupts = deferred<void>();
  const f = fixture({ interrupt: async id => {
    (id === target ? targetInterrupt : otherInterrupt).resolve();
    await releaseInterrupts.promise;
  } });
  try {
    await f.queue.submit(target, 'target active');
    const targetUrgent = await f.queue.submit(target, 'target urgent');
    await f.queue.submit(other, 'other active');
    const otherUrgent = await f.queue.submit(other, 'other urgent');
    const [targetRun, otherRun] = await Promise.all([f.waitForRun('target active'), f.waitForRun('other active')]);
    const promotions = [f.queue.sendNow(target, targetUrgent.messageId), f.queue.sendNow(other, otherUrgent.messageId)];
    await Promise.all([targetInterrupt.promise, otherInterrupt.promise]);
    f.queue.pauseSessions([target], 'target maintenance');
    targetRun.result.resolve(interrupted); otherRun.result.resolve(interrupted); releaseInterrupts.resolve();
    await Promise.all(promotions);
    await f.waitForRun('other urgent');
    assert.deepEqual(f.runs.map(run => run.item.text), ['target active', 'other active', 'other urgent']);
    assert.equal(f.queue.snapshot(target).paused, true);
    assert.equal(f.queue.snapshot(target).error, 'target maintenance');
    assert.equal(f.queue.snapshot(other).paused, false);
  } finally { releaseInterrupts.resolve(); await f.close(); }
});

test('session maintenance pauses every selected queue despite save failures without touching unselected state', async () => {
  const f = fixture({ blocked: () => true }), first = randomUUID(), second = randomUUID(), other = randomUUID();
  const storage = (f.queue as unknown as { storage: ChatQueueStorage }).storage;
  const save = storage.save.bind(storage), attempts: string[] = [];
  try {
    await f.queue.submit(first, 'first'); await f.queue.submit(second, 'second'); await f.queue.submit(other, 'other');
    const untouched = f.queue.snapshot(other);
    storage.save = (id, state) => { attempts.push(id); if (id === first || id === second) throw new Error(`save ${id}`); save(id, state); };
    assert.throws(() => f.queue.pauseSessions([first, first, second], 'maintenance'), (error: unknown) => {
      assert.ok(error instanceof AggregateError); assert.equal(error.errors.length, 2); return true;
    });
    assert.deepEqual(attempts, [first, second]);
    for (const id of [first, second]) {
      assert.equal(f.queue.snapshot(id).paused, true); assert.equal(f.queue.snapshot(id).error, 'maintenance');
    }
    assert.deepEqual(f.queue.snapshot(other), untouched);
  } finally { storage.save = save; await f.close(); }
});

test('admission generations reject queued submissions and resumes after maintenance has already ended', async t => {
  for (const operation of ['submit', 'resume', 'send now'] as const) await t.test(operation, async () => {
    let maintenance = false, admissionEpoch = 0, blockDispatch = true;
    const entered = deferred<void>(), releaseMutation = deferred<void>();
    const f = fixture({
      blocked: () => blockDispatch,
      assertAvailable: () => { if (maintenance) throw new Error('maintenance active'); },
      captureAdmission: () => {
        const epoch = admissionEpoch;
        return () => { if (epoch !== admissionEpoch) throw new Error('maintenance cancelled old operation'); };
      },
    });
    const id = randomUUID();
    try {
      const accepted = await f.queue.submit(id, 'preserved queued message');
      f.queue.pause(id);
      const mutation = f.queue.removeAttachment(id, '/unused-attachment', async () => { entered.resolve(); await releaseMutation.promise; });
      await entered.promise;
      const oldOperation = operation === 'submit' ? f.queue.submit(id, 'old submission') : operation === 'resume' ? f.queue.resume(id) : f.queue.sendNow(id, accepted.messageId);
      const rejected = assert.rejects(oldOperation, /maintenance cancelled old operation/);
      maintenance = true; admissionEpoch++;
      f.queue.pauseSessions([id], 'maintenance pause');
      maintenance = false; blockDispatch = false;
      releaseMutation.resolve(); await mutation; await rejected;
      f.queue.wake(id); await tick();
      assert.equal(f.runs.length, 0);
      assert.equal(f.queue.snapshot(id).paused, true);
      assert.equal(f.queue.snapshot(id).error, 'maintenance pause');
      assert.deepEqual(f.queue.snapshot(id).items.map(item => item.text), ['preserved queued message']);
      assert.deepEqual(f.interruptions, []);
      await f.queue.resume(id);
      await f.waitForRun('preserved queued message');
    } finally { releaseMutation.resolve(); await f.close(); }
  });
});

test('admission generations reject an attachment commit after a complete maintenance cycle', async () => {
  let admissionEpoch = 0;
  const entered = deferred<void>(), releaseAttachments = deferred<void>();
  const f = fixture({
    captureAdmission: () => { const epoch = admissionEpoch; return () => { if (epoch !== admissionEpoch) throw new Error('maintenance cancelled attachments'); }; },
    acceptAttachments: async (_id, _files, commit) => { entered.resolve(); await releaseAttachments.promise; commit(); },
  });
  const id = randomUUID();
  try {
    const oldSubmission = f.queue.submit(id, 'old attachment submission', ['/attachment/evidence.txt']);
    const rejected = assert.rejects(oldSubmission, /maintenance cancelled attachments/);
    await entered.promise;
    admissionEpoch++; f.queue.pauseSessions([id], 'maintenance pause');
    releaseAttachments.resolve(); await rejected;
    f.queue.wake(id); await tick();
    assert.equal(f.runs.length, 0);
    assert.equal(f.queue.snapshot(id).paused, true);
    assert.deepEqual(f.queue.snapshot(id).items, []);
  } finally { releaseAttachments.resolve(); await f.close(); }
});

test('failed turns retain accepted messages and pause before any following message can execute', async () => {
  const f = fixture(), sessionId = randomUUID();
  try {
    await f.queue.submit(sessionId, 'failed prompt');
    await f.queue.submit(sessionId, 'next prompt');
    await tick();
    f.runs[0].result.resolve({ success: false, summary: 'partial work', error: 'connection closed' });
    await until(() => !f.queue.hasActive(sessionId));
    const snapshot = f.queue.snapshot(sessionId);
    assert.equal(snapshot.paused, true);
    assert.match(snapshot.error ?? '', /connection closed/);
    assert.deepEqual(snapshot.items.map(item => [item.text, item.status]), [
      ['failed prompt', 'queued'], ['next prompt', 'queued'],
    ]);
    f.queue.wake(sessionId);
    await tick();
    assert.equal(f.runs.length, 1);
  } finally { await f.close(); }
});

test('restart preserves pending and uncertain in-flight messages in a paused queue without replaying them', async () => {
  const original = fixture(), sessionId = randomUUID(), deliveredRequestId = randomUUID();
  const restoredDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-chat-queue-restore-'));
  let restored: ReturnType<typeof fixture> | undefined;
  try {
    const delivered = await original.queue.submit(sessionId, 'already delivered', [], deliveredRequestId);
    await tick();
    original.runs[0].result.resolve(success);
    await until(() => !original.queue.hasActive(sessionId));
    await original.queue.submit(sessionId, 'possibly sent');
    await original.queue.submit(sessionId, 'not sent');
    await until(() => original.runs.length === 2);
    fs.cpSync(original.directory, restoredDirectory, { recursive: true });
    restored = fixture({}, restoredDirectory);
    const snapshot = restored.queue.snapshot(sessionId);
    await tick();
    restored.queue.wake(sessionId);
    await tick();
    assert.equal(restored.runs.length, 0);
    assert.equal(snapshot.paused, true);
    assert.ok(snapshot.error, 'recovery must explain why replay needs user action');
    assert.deepEqual(snapshot.items.map(item => [item.text, item.status]), [
      ['possibly sent', 'queued'], ['not sent', 'queued'],
    ]);
    const retry = await restored.queue.submit(sessionId, 'already delivered', [], deliveredRequestId);
    assert.equal(retry.messageId, delivered.messageId, 'receipts must survive restart after the original message left the queue');
    await tick();
    assert.equal(restored.runs.length, 0);
  } finally {
    await original.close();
    if (restored) await restored.close(); else fs.rmSync(restoredDirectory, { recursive: true, force: true });
  }
});

test('submission receipts deduplicate IPC retries even after completion, while deliberate identical messages remain distinct', async () => {
  const f = fixture(), sessionId = randomUUID(), requestId = randomUUID();
  try {
    const [first, duplicate] = await Promise.all([
      f.queue.submit(sessionId, 'same text', [], requestId),
      f.queue.submit(sessionId, 'same text', [], requestId),
    ]);
    assert.equal(first.messageId, duplicate.messageId);
    await tick();
    assert.equal(f.runs.length, 1);
    f.runs[0].result.resolve(success);
    await until(() => !f.queue.hasActive(sessionId));
    assert.equal((await f.queue.submit(sessionId, 'same text', [], requestId)).messageId, first.messageId);
    await tick();
    assert.equal(f.runs.length, 1);
    const distinct = await f.queue.submit(sessionId, 'same text', [], randomUUID());
    await until(() => f.runs.length === 2);
    assert.notEqual(distinct.messageId, first.messageId);
    assert.equal(f.runs.length, 2);
  } finally { await f.close(); }
});

test('removing a queued message leaves the active turn and remaining FIFO order intact', async () => {
  const f = fixture(), sessionId = randomUUID();
  try {
    await f.queue.submit(sessionId, 'active');
    const removed = await f.queue.submit(sessionId, 'remove me');
    await f.queue.submit(sessionId, 'keep me');
    await tick();
    await f.queue.remove(sessionId, removed.messageId);
    assert.deepEqual(f.queue.snapshot(sessionId).items.map(item => item.text), ['active', 'keep me']);
    assert.deepEqual(f.interruptions, []);
    f.runs[0].result.resolve(success);
    await until(() => f.runs.length === 2);
    assert.deepEqual(f.runs.map(run => run.item.text), ['active', 'keep me']);
  } finally { await f.close(); }
});

test('completion persistence failure retains ownership and retries only the ACK after explicit review', async () => {
  const f = fixture(), sessionId = randomUUID();
  const storage = (f.queue as unknown as { storage: ChatQueueStorage }).storage;
  const save = storage.save.bind(storage);
  try {
    const first = await f.queue.submit(sessionId, 'work completed but not committed');
    await f.queue.submit(sessionId, 'must wait');
    await until(() => f.runs.length === 1);
    storage.save = (id, state) => {
      if (!state.items.some(item => item.id === first.messageId)) throw new Error('disk full on completion');
      save(id, state);
    };
    f.runs[0].result.resolve(success);
    await until(() => !!f.queue.snapshot(sessionId).error);
    assert.equal(f.queue.hasActive(sessionId), true, 'missing durable ACK must retain outer ownership');
    const snapshot = f.queue.snapshot(sessionId);
    assert.equal(snapshot.paused, true);
    assert.match(snapshot.error ?? '', /disk full on completion/);
    assert.deepEqual(snapshot.items.map(item => [item.text, item.status]), [
      ['work completed but not committed', 'queued'], ['must wait', 'queued'],
    ]);
    const durable = JSON.parse(fs.readFileSync(path.join(f.directory, 'chat-queue', sessionId + '.json'), 'utf8'));
    assert.equal(durable.items[0].status, 'sending', 'last durable state must preserve uncertain execution evidence');
    f.queue.wake(sessionId);
    await tick();
    assert.equal(f.runs.length, 1);
    storage.save = save;
    await f.queue.resume(sessionId);
    await until(() => f.runs.length === 2);
    assert.equal(f.runs[1].item.text, 'must wait', 'resume repairs the completed item without executing it again');
    f.runs[1].result.resolve(success);
    await until(() => !f.queue.hasActive(sessionId));
  } finally { storage.save = save; await f.close(); }
});

test('failed priority persistence never marks the running message as replaced or discards it after interruption', async () => {
  const f = fixture(), sessionId = randomUUID();
  const storage = (f.queue as unknown as { storage: ChatQueueStorage }).storage;
  const save = storage.save.bind(storage);
  try {
    const original = await f.queue.submit(sessionId, 'original work');
    const urgent = await f.queue.submit(sessionId, 'urgent work');
    await until(() => f.runs.length === 1);
    storage.save = (id, state) => {
      if (state.items[0]?.id === urgent.messageId) throw new Error('disk full on promotion');
      save(id, state);
    };
    await assert.rejects(f.queue.sendNow(sessionId, urgent.messageId), /disk full on promotion/);
    storage.save = save;
    assert.deepEqual(f.interruptions, [], 'interruption must follow a durable priority decision');
    f.runs[0].result.resolve(interrupted);
    await until(() => !f.queue.hasActive(sessionId));
    assert.deepEqual(f.queue.snapshot(sessionId).items.map(item => item.id), [original.messageId, urgent.messageId]);
    assert.equal(f.queue.snapshot(sessionId).paused, true);
    assert.equal(f.runs.length, 1);
  } finally { storage.save = save; await f.close(); }
});

test('a stop while attachment acceptance is pending keeps the subsequently accepted message paused', async () => {
  const entered = deferred<void>(), releaseAttachments = deferred<void>();
  const f = fixture({ acceptAttachments: async (_id, _files, commit) => {
    entered.resolve();
    await releaseAttachments.promise;
    commit(['evidence.txt']);
  } });
  const sessionId = randomUUID();
  try {
    const submission = f.queue.submit(sessionId, 'inspect file', ['/attachment/evidence.txt']);
    await entered.promise;
    f.queue.pause(sessionId);
    releaseAttachments.resolve();
    await submission;
    f.queue.wake(sessionId);
    await tick();
    assert.equal(f.runs.length, 0);
    assert.equal(f.queue.snapshot(sessionId).paused, true);
    assert.deepEqual(f.queue.snapshot(sessionId).items.map(item => [item.text, item.status]), [['inspect file', 'queued']]);
  } finally { releaseAttachments.resolve(); await f.close(); }
});

test('a user stop after send now takes precedence when the interruption eventually settles', async () => {
  const ack = deferred<void>();
  const f = fixture({ interrupt: async id => { f.interruptions.push(id); await ack.promise; } });
  const sessionId = randomUUID();
  try {
    await f.queue.submit(sessionId, 'active');
    const priority = await f.queue.submit(sessionId, 'urgent');
    await f.queue.submit(sessionId, 'later');
    await until(() => f.runs.length === 1);
    const promotion = f.queue.sendNow(sessionId, priority.messageId);
    await until(() => f.interruptions.length === 1);
    f.queue.pause(sessionId);
    f.runs[0].result.resolve(interrupted);
    ack.resolve();
    await promotion;
    await until(() => !f.queue.hasActive(sessionId));
    f.queue.wake(sessionId);
    await tick();
    assert.equal(f.runs.length, 1);
    assert.equal(f.queue.snapshot(sessionId).paused, true);
    assert.deepEqual(f.queue.snapshot(sessionId).items.map(item => item.text), ['urgent', 'later']);
  } finally { ack.resolve(); await f.close(); }
});

test('a replaced interrupted turn is never replayed when its durable ACK needs a retry', async () => {
  const f = fixture(), sessionId = randomUUID();
  const storage = (f.queue as unknown as { storage: ChatQueueStorage }).storage, save = storage.save.bind(storage);
  try {
    const original = await f.queue.submit(sessionId, 'interrupted original');
    const urgent = await f.queue.submit(sessionId, 'urgent replacement');
    await until(() => f.runs.length === 1);
    storage.save = (id, state) => {
      if (!state.items.some(item => item.id === original.messageId)) throw new Error('replacement ACK disk failure');
      save(id, state);
    };
    const promotion = f.queue.sendNow(sessionId, urgent.messageId);
    const failed = assert.rejects(promotion, /回执尚未保存/);
    await until(() => f.interruptions.length === 1);
    f.runs[0].result.resolve(interrupted);
    await failed;
    assert.equal(f.queue.hasActive(sessionId), true);
    assert.equal(f.queue.snapshot(sessionId).paused, true);
    storage.save = save;
    await f.queue.resume(sessionId);
    await until(() => f.runs.length === 2);
    assert.equal(f.runs[1].item.id, urgent.messageId);
    f.runs[1].result.resolve(success);
    await until(() => !f.queue.hasActive(sessionId));
    assert.deepEqual(f.queue.snapshot(sessionId).items, []);
    assert.deepEqual(f.runs.map(run => run.item.text), ['interrupted original', 'urgent replacement']);
  } finally { storage.save = save; await f.close(); }
});

for (const operation of ['resume', 'sendNow', 'submit'] as const) test(`a stop wins an older ${operation} waiting behind another queue mutation`, async () => {
  let blocked = true;
  const entered = deferred<void>(), release = deferred<void>();
  const f = fixture({ blocked: () => blocked }), sessionId = randomUUID();
  try {
    const message = operation === 'submit' ? undefined : await f.queue.submit(sessionId, 'kept queued');
    f.queue.pause(sessionId);
    const removing = f.queue.removeAttachment(sessionId, '/unused', async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    const pending = operation === 'resume' ? f.queue.resume(sessionId) : operation === 'sendNow'
      ? f.queue.sendNow(sessionId, message!.messageId) : f.queue.submit(sessionId, 'accepted after stop');
    const settled = operation === 'submit' ? pending : assert.rejects(pending, /后续停止/);
    f.queue.pause(sessionId, 'user stop');
    blocked = false; release.resolve(); await removing; await settled;
    f.queue.wake(sessionId); await tick(); await tick();
    assert.equal(f.queue.snapshot(sessionId).paused, true);
    assert.equal(f.queue.snapshot(sessionId).items.length, 1);
    assert.equal(f.runs.length, 0);
    assert.equal(f.interruptions.length, 0);
  } finally { release.resolve(); await f.close(); }
});
