import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatSnapshot, ChatSnapshotVersion, TaskState } from '../src/shared/chat';
import { SharedChatSnapshots, sharedChatSnapshots, type SharedChatSnapshotLimits } from '../src/renderer/shared-chat-snapshot';
import { SessionReadLifecycle } from '../src/renderer/session-read-lifecycle';

const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const version = (revision: number, conversationId = 'context', hostEpoch = 'host-a'): ChatSnapshotVersion => ({ hostEpoch, revision, eventSequence: revision, conversationId });
const snapshot = (id: string, revision: number, conversationId = 'context', hostEpoch = 'host-a'): ChatSnapshot => ({
  sessionId: id, taskState: 'thinking', messages: [], pending: [], version: version(revision, conversationId, hostEpoch),
});
const settle = async () => { for (let index = 0; index < 24; index++) await Promise.resolve(); };

function fixture(limits: SharedChatSnapshotLimits = {}) {
  const lifecycle = new SessionReadLifecycle();
  const reads: { id: string; result: ReturnType<typeof deferred<ChatSnapshot>> }[] = [];
  const events = new Set<(id: string, state?: TaskState, version?: ChatSnapshotVersion) => void>();
  const timers = new Map<number, { at: number; callback: () => void }>();
  let time = 0, nextTimer = 0, subscriptions = 0, unsubscriptions = 0;
  const store = new SharedChatSnapshots({
    read: id => { const result = deferred<ChatSnapshot>(); reads.push({ id, result }); return result.promise; },
    onChat: listener => { subscriptions++; events.add(listener); return () => { unsubscriptions++; events.delete(listener); }; },
    lifecycle,
    schedule: (callback, delay) => { const id = ++nextTimer; timers.set(id, { at: time + delay, callback }); return id; },
    cancel: timer => { timers.delete(timer as number); },
    estimateBytes: () => 10,
  }, limits);
  return {
    store, reads, lifecycle, timers,
    get subscriptions() { return subscriptions; }, get unsubscriptions() { return unsubscriptions; },
    emit(id: string, metadata?: ChatSnapshotVersion) { for (const listener of events) listener(id, 'thinking', metadata); },
    advance(milliseconds: number) {
      time += milliseconds;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= time).sort((left, right) => left[1].at - right[1].at)[0];
        if (!next) break;
        timers.delete(next[0]); next[1].callback();
      }
    },
    close() { store.retain([]); },
  };
}

test('the singleton defers browser access and multiple consumers share the 200ms first read and one notification listener', async () => {
  assert.equal(sharedChatSnapshots.get('not-acquired').snapshot, undefined, 'importing in Node requires no window');
  const f = fixture();
  try {
    const firstView = f.store.get('session'); let changes = 0;
    const unsubscribeA = f.store.subscribe('session', () => { changes++; });
    const unsubscribeB = f.store.subscribe('session', () => { changes++; });
    const releaseA = f.store.acquire('session', 'context'), releaseB = f.store.acquire('session');
    assert.equal(f.subscriptions, 1); assert.equal(f.reads.length, 0);
    f.advance(199); f.emit('session', version(2)); f.advance(0);
    assert.equal(f.reads.length, 0, 'an early notification cannot steal the display paint window');
    assert.equal(f.store.get('session'), firstView);
    f.advance(1); assert.equal(f.reads.length, 1);
    f.reads[0].result.resolve(snapshot('session', 3)); await settle();
    assert.equal(f.store.get('session').snapshot?.version?.revision, 3);
    assert.equal(changes > 0, true);
    const ready = f.store.get('session'); assert.equal(f.store.get('session'), ready);
    releaseA(); assert.equal(f.unsubscriptions, 0);
    releaseB(); assert.equal(f.unsubscriptions, 1);
    assert.equal(f.store.get('session').snapshot, undefined);
    assert.equal(f.store.peek('session')?.version?.revision, 3);
    unsubscribeA(); unsubscribeB();
  } finally { f.close(); }
});

test('manual refresh accelerates first authority after paint and concurrent refresh calls issue one IPC', async () => {
  const f = fixture();
  try {
    const release = f.store.acquire('session', 'context');
    const first = f.store.refresh('session'), second = f.store.refresh('session');
    assert.equal(first, second); assert.equal(f.reads.length, 1); assert.equal(f.timers.size, 0);
    f.advance(300); assert.equal(f.reads.length, 1);
    f.reads[0].result.resolve(snapshot('session', 1)); await first; await settle();
    const next = f.store.refresh('session');
    assert.equal(f.store.refresh('session'), next); assert.equal(f.reads.length, 2);
    f.reads[1].result.resolve(snapshot('session', 2)); await next;
    release();
  } finally { f.close(); }
});

test('notifications coalesce for 80ms and metadata barriers reject a stale in-flight response', async () => {
  const f = fixture();
  try {
    f.store.acquire('session', 'context'); const initial = f.store.refresh('session');
    f.reads[0].result.resolve(snapshot('session', 1)); await initial; await settle();
    f.emit('session', version(2)); f.emit('session', version(3)); f.emit('other-session', version(90));
    f.advance(79); assert.equal(f.reads.length, 1);
    f.advance(1); assert.equal(f.reads.length, 2);
    f.emit('session', version(5));
    f.reads[1].result.resolve(snapshot('session', 3)); await settle();
    assert.equal(f.reads.length, 3, 'stale reply is retried by the same shared Sync');
    assert.equal(f.store.get('session').snapshot?.version?.revision, 1);
    f.reads[2].result.resolve(snapshot('session', 6)); await settle();
    assert.equal(f.store.get('session').snapshot?.version?.revision, 6);
    f.emit('session', version(6)); f.emit('session', version(2));
    f.advance(80);
    assert.equal(f.reads.length, 3, 'applying authority cancels its redundant scheduled notification read');
    assert.equal(f.subscriptions, 1);
  } finally { f.close(); }
});

test('fresh confirmation never reuses a read started before its call, including another active fresh confirmation', async () => {
  const f = fixture();
  try {
    f.store.acquire('session', 'context'); const old = f.store.refresh('session');
    let freshSettled = false;
    const fresh = f.store.refreshFresh('session').then(value => { freshSettled = true; return value; });
    assert.equal(f.reads.length, 1);
    f.reads[0].result.resolve(snapshot('session', 1)); await old; await settle();
    assert.equal(f.reads.length, 2); assert.equal(freshSettled, false);
    const laterFresh = f.store.refreshFresh('session');
    const authority = snapshot('session', 2); f.reads[1].result.resolve(authority);
    assert.equal(await fresh, authority); await settle();
    assert.equal(f.reads.length, 3, 'the later acknowledgment needs a read after its own call');
    const latest = snapshot('session', 3); f.reads[2].result.resolve(latest);
    assert.equal(await laterFresh, latest);
  } finally { f.close(); }
});

test('last release hides authority, stops automatic reads, and reacquisition discards old pending replies', async () => {
  const f = fixture();
  try {
    const firstRelease = f.store.acquire('session', 'context'), first = f.store.refresh('session');
    f.reads[0].result.resolve(snapshot('session', 1)); await first; await settle();
    const beforeSwitch = f.store.refresh('session');
    firstRelease();
    assert.equal(f.store.get('session').snapshot, undefined);
    assert.equal(f.store.peek('session')?.version?.revision, 1);
    f.emit('session', version(10)); f.advance(500); assert.equal(f.reads.length, 2);
    const release = f.store.acquire('session');
    assert.equal(f.store.get('session').snapshot, undefined, 'readonly cache cannot enable current controls');
    const afterPaint = f.store.refresh('session');
    assert.equal(f.reads.length, 3, 'reacquisition starts a new reader without waiting for the old IPC');
    f.reads[1].result.resolve(snapshot('session', 99)); await beforeSwitch; await settle();
    assert.equal(f.store.get('session').snapshot, undefined, 'pre-acquire response is invalidated');
    assert.equal(f.reads.length, 3);
    f.reads[2].result.resolve(snapshot('session', 2)); await afterPaint;
    assert.equal(f.store.get('session').snapshot?.version?.revision, 2);
    assert.equal(f.subscriptions, 2); release();
  } finally { f.close(); }
});

test('reacquisition applies a new read while the released consumer IPC remains indefinitely held', async () => {
  const f = fixture();
  try {
    const releaseA = f.store.acquire('session', 'context'), initial = f.store.refresh('session');
    f.reads[0].result.resolve(snapshot('session', 5)); await initial; await settle();
    const hanging = f.store.refreshFresh('session');
    assert.equal(f.reads.length, 2);
    releaseA();
    f.store.acquire('session', 'context');
    const currentRead = f.store.refreshFresh('session');
    assert.equal(f.reads.length, 3, 'fresh acquisition does not await the abandoned read');
    const authority = snapshot('session', 6);
    f.reads[2].result.resolve(authority);
    assert.equal(await currentRead, authority);
    assert.equal(f.store.get('session').snapshot, authority, 'new authority applies before the old IPC is released');
    f.reads[1].result.resolve(snapshot('session', 100));
    assert.equal(await hanging, undefined);
    assert.equal(f.store.get('session').snapshot, authority, 'late abandoned response cannot overwrite the new reader');
  } finally { f.close(); }
});

test('an initially hung read never blocks reacquisition and its observed epoch guards survive without cached content', async () => {
  const f = fixture();
  try {
    const unsubscribe = f.store.subscribe('session', () => {});
    const release = f.store.acquire('session', 'context'), old = f.store.refreshFresh('session');
    f.emit('session', version(1, 'context', 'host-a'));
    f.emit('session', version(2, 'context', 'host-b'));
    release(); unsubscribe();
    assert.equal(f.store.peek('session'), undefined);
    f.store.acquire('session', 'context');
    f.emit('session', version(999, 'context', 'host-a'));
    const fresh = f.store.refreshFresh('session');
    assert.equal(f.reads.length, 2, 'new read starts while the initial IPC remains held');
    const authority = snapshot('session', 3, 'context', 'host-b');
    f.reads[1].result.resolve(authority);
    assert.equal(await fresh, authority, 'retired epoch notification cannot override the inherited host-b barrier');
    assert.equal(f.store.get('session').snapshot, authority);
    f.reads[0].result.resolve(snapshot('session', 1000, 'context', 'host-a'));
    assert.equal(await old, undefined);
    assert.equal(f.store.get('session').snapshot, authority);
  } finally { f.close(); }
});

test('cached readers preserve version and host epoch authority barriers on reacquisition', async () => {
  const f = fixture();
  try {
    const release = f.store.acquire('session', 'context'), initial = f.store.refresh('session');
    f.reads[0].result.resolve(snapshot('session', 5)); await initial; await settle(); release();
    f.store.acquire('session', 'context'); const confirmation = f.store.refreshFresh('session');
    f.reads[1].result.resolve(snapshot('session', 2)); await settle();
    assert.equal(f.reads.length, 3);
    f.reads[2].result.resolve(snapshot('session', 3));
    await assert.rejects(confirmation, /状态仍在变化/);
    assert.equal(f.store.get('session').snapshot, undefined);
    assert.equal(f.store.peek('session')?.version?.revision, 5);
    const restarted = f.store.refreshFresh('session');
    f.emit('session', version(1, 'context', 'host-b'));
    f.reads[3].result.resolve(snapshot('session', 6)); await settle();
    const authority = snapshot('session', 2, 'context', 'host-b');
    f.reads[4].result.resolve(authority); assert.equal(await restarted, authority);
    f.emit('session', version(100));
    assert.equal(f.timers.size <= 1, true, 'retired epoch cannot schedule its own read');
  } finally { f.close(); }
});

test('lifecycle deletion invalidates reads without false errors and failed deletion resumes one fresh shared read', async () => {
  const f = fixture();
  try {
    f.store.acquire('session', 'context'); const initial = f.store.refresh('session');
    const deletion = deferred<void>();
    const removing = f.lifecycle.remove('session', () => deletion.promise);
    f.reads[0].result.resolve(snapshot('session', 1)); await initial;
    assert.equal(f.store.get('session').snapshot, undefined);
    assert.equal(f.store.get('session').state.error, undefined);
    assert.equal(await f.store.refreshFresh('session'), undefined);
    assert.equal(f.reads.length, 1, 'blocked lifecycle does not call the host');
    deletion.reject(new Error('delete failed'));
    await assert.rejects(removing, /delete failed/); await settle();
    assert.equal(f.reads.length, 2);
    f.reads[1].result.resolve(snapshot('session', 2)); await settle();
    assert.equal(f.store.get('session').snapshot?.version?.revision, 2);
  } finally { f.close(); }
});

test('retain resets changed contexts and rejects deleted-session late replies and failures', async () => {
  const f = fixture();
  try {
    f.store.retain([{ id: 'session', conversationId: 'old' }]);
    let changes = 0; f.store.subscribe('session', () => { changes++; });
    f.store.acquire('session', 'old'); const old = f.store.refresh('session');
    f.store.retain([{ id: 'session', conversationId: 'new' }]);
    assert.equal(f.store.get('session').snapshot, undefined); assert.equal(f.store.peek('session'), undefined);
    assert.equal(f.reads.length, 2);
    f.reads[0].result.resolve(snapshot('session', 99, 'old')); await old;
    assert.equal(f.store.get('session').snapshot, undefined);
    f.reads[1].result.resolve(snapshot('session', 1, 'new')); await settle();
    assert.equal(f.store.get('session').snapshot?.version?.conversationId, 'new');
    const releaseUnknown = f.store.acquire('session');
    assert.equal(f.store.get('session').snapshot?.version?.conversationId, 'new', 'unknown context must not discard known authority');
    const late = f.store.refreshFresh('session');
    f.store.retain([]);
    assert.equal(f.store.get('session').snapshot, undefined);
    assert.equal(f.store.peek('session'), undefined);
    f.reads[2].result.reject(new Error('deleted session late failure'));
    assert.equal(await late, undefined);
    assert.equal(f.store.get('session').state.error, undefined);
    assert.equal(f.unsubscriptions, 1); assert.equal(changes > 0, true);
    releaseUnknown();
    f.store.acquire('session', 'old'); f.advance(1000);
    assert.equal(f.reads.length, 3, 'retired session cannot be silently recreated');
  } finally { f.close(); }
});

test('retain treats known-to-undefined and undefined-to-known contexts as exact scope changes', async () => {
  const f = fixture();
  try {
    f.store.retain([{ id: 'session', conversationId: 'old' }]);
    f.store.acquire('session', 'old'); const initial = f.store.refresh('session');
    f.reads[0].result.resolve(snapshot('session', 1, 'old')); await initial; await settle();
    const lateOld = f.store.refreshFresh('session');
    f.store.retain([{ id: 'session' }]);
    assert.equal(f.store.get('session').snapshot, undefined);
    assert.equal(f.store.peek('session'), undefined, 'removing known context retires its readonly cache too');
    assert.equal(f.reads.length, 3, 'an active exact scope change starts a new authoritative read');
    f.reads[1].result.resolve(snapshot('session', 99, 'old'));
    assert.equal(await lateOld, undefined);
    assert.equal(f.store.get('session').snapshot, undefined);
    const noContext = { ...snapshot('session', 1), version: { ...version(1), conversationId: undefined } };
    f.reads[2].result.resolve(noContext); await settle();
    assert.equal(f.store.get('session').snapshot, noContext);
    const lateUnknown = f.store.refreshFresh('session');
    f.store.retain([{ id: 'session', conversationId: 'new' }]);
    assert.equal(f.reads.length, 5);
    assert.equal(f.store.get('session').snapshot, undefined);
    assert.equal(f.store.peek('session'), undefined);
    f.reads[3].result.resolve({ ...noContext, taskState: 'completed' });
    assert.equal(await lateUnknown, undefined);
    assert.equal(f.store.get('session').snapshot, undefined, 'the prior undefined scope cannot revive controls');
    const authority = snapshot('session', 1, 'new'); f.reads[4].result.resolve(authority); await settle();
    assert.equal(f.store.get('session').snapshot, authority);
    const releaseUnknownConsumer = f.store.acquire('session');
    assert.equal(f.store.get('session').snapshot, authority, 'acquire(undefined) keeps its separate unknown-caller semantics');
    releaseUnknownConsumer();
  } finally { f.close(); }
});

test('cache LRU bounds idle sessions and bytes while current authority remains available', async () => {
  const f = fixture({ maxCachedSessions: 2, maxCachedBytes: 20 });
  try {
    for (const id of ['a', 'b', 'c']) {
      const release = f.store.acquire(id, 'context'), pending = f.store.refresh(id);
      f.reads.at(-1)!.result.resolve(snapshot(id, 1)); await pending; await settle(); release();
    }
    assert.equal(f.store.peek('a'), undefined);
    assert.equal(f.store.peek('b')?.sessionId, 'b');
    const release = f.store.acquire('d', 'context'), pending = f.store.refresh('d');
    f.reads.at(-1)!.result.resolve(snapshot('d', 1)); await pending; await settle();
    assert.equal(f.store.get('d').snapshot?.sessionId, 'd');
    release();
    assert.equal(f.store.peek('c'), undefined, 'peek promotes the other readonly cache entry');
    assert.equal(f.store.peek('b')?.sessionId, 'b'); assert.equal(f.store.peek('d')?.sessionId, 'd');
  } finally { f.close(); }
  const tight = fixture({ maxCachedSessions: 8, maxCachedBytes: 9 });
  try {
    const release = tight.store.acquire('large'), pending = tight.store.refresh('large');
    tight.reads[0].result.resolve(snapshot('large', 1)); await pending; await settle();
    assert.equal(tight.store.get('large').snapshot?.sessionId, 'large', 'active authority is not evicted');
    release(); assert.equal(tight.store.peek('large'), undefined);
  } finally { tight.close(); }
});

test('fresh failures throw instead of returning cached authority and explicit recovery resumes automatic notifications', async () => {
  const f = fixture();
  try {
    f.store.acquire('session', 'context'); const initial = f.store.refresh('session');
    f.reads[0].result.resolve(snapshot('session', 1)); await initial; await settle();
    for (let index = 1; index <= 2; index++) {
      const failure = f.store.refreshFresh('session');
      f.reads[index].result.reject(new Error('authority unavailable'));
      await assert.rejects(failure, /authority unavailable/);
    }
    assert.equal(f.store.get('session').canAutoRefresh, false);
    assert.equal(f.store.get('session').snapshot?.version?.revision, 1);
    f.emit('session', version(8)); f.advance(500); assert.equal(f.reads.length, 3);
    const recovered = f.store.refreshFresh('session');
    f.reads[3].result.resolve(snapshot('session', 9)); await recovered; await settle();
    assert.equal(f.store.get('session').state.error, undefined);
    assert.equal(f.store.get('session').canAutoRefresh, true);
    f.emit('session', version(10)); f.advance(80); assert.equal(f.reads.length, 5);
    f.reads[4].result.resolve(snapshot('session', 11)); await settle();
  } finally { f.close(); }
});

test('failed active snapshots retry at 5s, 15s and 30s without notifications and recover their authority', async () => {
  const f = fixture();
  try {
    f.store.acquire('session', 'context');
    const initial = f.store.refresh('session');
    f.reads[0].result.resolve(snapshot('session', 1)); await initial; await settle();
    const failed = f.store.refresh('session');
    f.reads[1].result.reject(new Error('temporarily unavailable')); await failed; await settle();
    assert.equal(f.store.get('session').snapshot?.version?.revision, 1);
    f.emit('session', version(3)); f.advance(4_999); assert.equal(f.reads.length, 2);
    f.advance(1); assert.equal(f.reads.length, 3);
    f.reads[2].result.reject(new Error('still unavailable')); await settle();
    assert.equal(f.store.get('session').canAutoRefresh, false, 'fast notification retries remain paused');
    f.emit('session', version(4)); f.advance(14_999); assert.equal(f.reads.length, 3);
    f.advance(1); assert.equal(f.reads.length, 4, 'a passive retry survives the two-failure threshold');
    f.reads[3].result.reject(new Error('unavailable again')); await settle();
    f.advance(29_999); assert.equal(f.reads.length, 4);
    f.advance(1); assert.equal(f.reads.length, 5);
    f.reads[4].result.resolve(snapshot('session', 6)); await settle();
    assert.equal(f.store.get('session').state.failures, 0);
    assert.equal(f.store.get('session').state.error, undefined);
    assert.equal(f.store.get('session').canAutoRefresh, true);
    assert.equal(f.store.get('session').snapshot?.version?.revision, 6);
    f.advance(60_000); assert.equal(f.reads.length, 5, 'successful authority cancels the retry chain');
    f.emit('session', version(7)); f.advance(80); assert.equal(f.reads.length, 6);
    f.reads[5].result.resolve(snapshot('session', 8)); await settle();
  } finally { f.close(); }
});

test('pending passive retries are cancelled when their last consumer leaves or their context is removed', async () => {
  const f = fixture();
  try {
    const release = f.store.acquire('session', 'context');
    const failure = f.store.refresh('session');
    f.reads[0].result.reject(new Error('unavailable')); await failure; await settle();
    assert.equal(f.timers.size, 1);
    release(); assert.equal(f.timers.size, 0);
    f.advance(60_000); assert.equal(f.reads.length, 1);
    f.store.acquire('session', 'context'); f.advance(200);
    f.reads[1].result.reject(new Error('still unavailable')); await settle();
    assert.equal(f.timers.size, 1);
    f.store.retain([]); assert.equal(f.timers.size, 0);
    f.advance(60_000); assert.equal(f.reads.length, 2);
    assert.equal(f.store.get('session').snapshot, undefined);
  } finally { f.close(); }
});
