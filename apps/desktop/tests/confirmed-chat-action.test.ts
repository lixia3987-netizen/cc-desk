import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChatSnapshot } from '../src/shared/chat';
import { ChatActionState, chatActionHasFreshSnapshot } from '../src/renderer/chat-action-state';
import { runConfirmedChatAction } from '../src/renderer/confirmed-chat-action';

const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const snapshot = (revision = 4): ChatSnapshot => ({ sessionId: 'origin', taskState: 'completed', messages: [], pending: [], version: { hostEpoch: 'epoch', revision, eventSequence: revision } });
function fixture() {
  const state = new ChatActionState(), key = 'origin-action';
  const paint = deferred<void>(), execute = deferred<unknown>(), fresh = deferred<ChatSnapshot | undefined>();
  const errors: unknown[] = [], calls: string[] = [];
  let current = true;
  const run = () => runConfirmedChatAction({ state, key, kind: 'compact', isCurrent: () => current,
    paint: () => { calls.push('paint'); return paint.promise; },
    execute: () => { calls.push('execute'); return execute.promise; },
    refreshFresh: () => { calls.push('fresh'); return fresh.promise; },
    onError: error => { errors.push(error); },
  });
  return { state, key, paint, execute, fresh, errors, calls, run, setCurrent: (value: boolean) => { current = value; } };
}

test('confirmed actions gate synchronously, paint before IPC, and retain acceptance through a pending fresh read', async () => {
  const f = fixture(), pending = f.run();
  assert.deepEqual(f.calls, ['paint']);
  assert.equal(f.state.getSnapshot(f.key)?.accepted, false);
  assert.equal(await f.run(), false);
  assert.deepEqual(f.calls, ['paint'], 'repeated invocation does not repaint or dispatch');
  f.paint.resolve(); await Promise.resolve();
  assert.deepEqual(f.calls, ['paint', 'execute']);
  f.execute.resolve(undefined); await Promise.resolve();
  assert.deepEqual(f.calls, ['paint', 'execute', 'fresh']);
  const accepted = f.state.getSnapshot(f.key)!;
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.synchronizing, true);
  assert.equal(accepted.synchronized, undefined);
  assert.equal(await f.run(), false, 'a pending verification still blocks the original action');
  f.fresh.resolve(snapshot(8));
  assert.equal(await pending, true);
  const synchronized = f.state.getSnapshot(f.key)!;
  assert.equal(synchronized.token, accepted.token);
  assert.equal(synchronized.synchronizing, false);
  assert.equal(chatActionHasFreshSnapshot(synchronized, snapshot(7).version), false);
  assert.equal(chatActionHasFreshSnapshot(synchronized, snapshot(8).version), true);
  assert.equal(await f.run(), false, 'success leaves clearing to the rendered version check');
  assert.deepEqual(f.errors, []);
});

test('a failed post-ACK read preserves the accepted gate and permits a separate verification retry', async () => {
  const f = fixture(), pending = f.run();
  f.paint.resolve(); await Promise.resolve(); f.execute.resolve(undefined); await Promise.resolve();
  const error = new Error('read failed'); f.fresh.reject(error);
  assert.equal(await pending, true);
  const action = f.state.getSnapshot(f.key)!;
  assert.equal(action.accepted, true);
  assert.equal(action.synchronizing, false);
  assert.equal(action.synchronized, undefined);
  assert.deepEqual(f.errors, [error]);
  assert.equal(await f.run(), false, 'verification failure cannot replay the accepted command');
  assert.equal(f.state.beginSync(f.key, action.token), true, 'read-only verification remains accessible');
  f.state.synchronized(f.key, action.token, snapshot(9).version);
  assert.equal(chatActionHasFreshSnapshot(f.state.getSnapshot(f.key)!, snapshot(9).version), true);
  f.state.clear(f.key, action.token);
  assert.ok(f.state.begin(f.key, 'compact'));
});

test('an absent applied snapshot leaves acceptance unconfirmed instead of releasing the gate', async () => {
  const f = fixture(), pending = f.run();
  f.paint.resolve(); await Promise.resolve(); f.execute.resolve(undefined); await Promise.resolve();
  f.fresh.resolve(undefined);
  assert.equal(await pending, true);
  const action = f.state.getSnapshot(f.key)!;
  assert.equal(action.accepted, true);
  assert.equal(action.synchronizing, false);
  assert.equal(chatActionHasFreshSnapshot(action, snapshot(99).version), false);
  assert.equal(await f.run(), false);
  assert.equal(f.errors.length, 1);
});

test('switching scope during paint cancels dispatch and clears only the original token', async () => {
  const f = fixture(), pending = f.run();
  f.setCurrent(false); f.paint.resolve();
  assert.equal(await pending, false);
  assert.deepEqual(f.calls, ['paint']);
  assert.equal(f.state.getSnapshot(f.key), undefined);
  assert.deepEqual(f.errors, []);
  const replaced = fixture(), stale = replaced.run(), old = replaced.state.getSnapshot(replaced.key)!;
  replaced.state.clear(replaced.key, old.token);
  const newer = replaced.state.begin(replaced.key, 'review');
  replaced.paint.resolve();
  assert.equal(await stale, false);
  assert.equal(replaced.state.getSnapshot(replaced.key), newer);
  assert.deepEqual(replaced.calls, ['paint']);
});

test('late acceptance after unmount keeps its origin gate for remount verification and suppresses stale errors', async () => {
  const f = fixture(), pending = f.run();
  f.paint.resolve(); await Promise.resolve();
  f.setCurrent(false); f.execute.resolve(undefined); await Promise.resolve();
  assert.deepEqual(f.calls, ['paint', 'execute', 'fresh'], 'fresh read is bound to the origin, not the newly selected pane');
  f.fresh.resolve(undefined);
  assert.equal(await pending, true);
  const action = f.state.getSnapshot(f.key)!;
  assert.equal(action.accepted, true);
  assert.equal(action.synchronized, undefined);
  assert.deepEqual(f.errors, []);
  assert.equal(f.state.beginSync(f.key, action.token), true, 'remount can verify the retained operation');
});

test('pre-ACK and synchronization errors report only while their scope is current', async () => {
  for (const phase of ['paint', 'execute', 'fresh'] as const) {
    for (const current of [true, false]) {
      const f = fixture(), pending = f.run(), error = new Error(phase);
      if (phase !== 'paint') { f.paint.resolve(); await Promise.resolve(); }
      if (phase === 'fresh') { f.execute.resolve(undefined); await Promise.resolve(); }
      f.setCurrent(current); f[phase].reject(error);
      assert.equal(await pending, phase === 'fresh');
      assert.deepEqual(f.errors, current ? [error] : []);
      assert.equal(f.state.getSnapshot(f.key)?.accepted, phase === 'fresh' ? true : undefined);
    }
  }
});
