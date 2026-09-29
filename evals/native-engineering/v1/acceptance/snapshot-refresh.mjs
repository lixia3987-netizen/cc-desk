import assert from 'node:assert/strict';
import { load } from './common.mjs';
const snapshot = (revision, workerGeneration, hostEpoch = 'host-a', taskState = 'thinking') => ({ sessionId: 'session', messages: [], pending: [], taskState,
  version: { hostEpoch, revision, eventSequence: revision, conversationId: 'conversation', workerGeneration } });
export default async function verify(root) {
  const { ChatSnapshotSync } = await load(root, 'apps/desktop/src/renderer/chat-snapshot-sync.ts');
  const applied = [], queue = [], states = [];
  const sync = new ChatSnapshotSync('session', { read: async () => { assert.ok(queue.length, 'bounded reads'); return queue.shift(); }, apply: value => applied.push(value), state: state => states.push(state) });
  try {
    queue.push(snapshot(10, 3)); await sync.refresh();
    queue.push(snapshot(11, 2, 'host-a', 'completed'), snapshot(12, 3)); await sync.refresh();
    assert.deepEqual(applied.map(item => item.version.workerGeneration), [3, 3], 'A later revision from an older worker must never appear as completed');
    assert.equal(sync.snapshot.taskState, 'thinking');
    queue.push(snapshot(1, 1, 'host-b')); await sync.refresh();
    assert.equal(sync.snapshot.version.hostEpoch, 'host-b', 'a genuine host restart permits counters to reset');
    assert.equal(sync.notify(snapshot(99, 9, 'host-a').version), false, 'retired host notifications cannot revive old state');
    const before = applied.length;
    queue.push({ ...snapshot(2, 1, 'host-b'), sessionId: 'other' }); await sync.refresh();
    assert.equal(applied.length, before); assert.ok(sync.error, 'cross-session snapshots are rejected');
    assert.equal(sync.notify(snapshot(1, 1, 'host-b').version), false, 'duplicate notification does not refresh');
    return { scope: 'renderer state synchronizer: worker regression, legitimate host restart, retired-host/duplicate events, cross-session rejection; no Electron window or real-model assertion' };
  } finally { sync.dispose(); }
}
