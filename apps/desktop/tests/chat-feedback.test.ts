import test from 'node:test';
import assert from 'node:assert/strict';
import { chatActionHasFreshSnapshot, ChatActionState } from '../src/renderer/chat-action-state';
import { queueActionConfirmed, queueFeedbackVersion, startingQueueMessages } from '../src/renderer/chat-queue-feedback';
import { ChatSubmissionState } from '../src/renderer/chat-submission-state';
import { runChatSubmission } from '../src/renderer/chat-submission-runner';
import type { ChatMessage, ChatQueueSnapshot, ChatSnapshotVersion } from '../src/shared/chat';

const deferred = <T>() => { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const item = { id: 'queue-message', text: 'same prompt', attachments: [], createdAt: '', status: 'sending' as const };
const version = (revision: number): ChatSnapshotVersion => ({ hostEpoch: 'epoch', revision, eventSequence: revision, conversationId: 'conversation' });

test('sending queue entries stay visible until an exact authoritative user submission replaces them', () => {
  const queue = { items: [item], paused: false };
  const sameText: ChatMessage = { id: 'old-user', turnId: 'old-run', role: 'user', text: item.text, createdAt: '', submissionId: 'different-message' };
  assert.deepEqual(startingQueueMessages(queue, [sameText]), [item]);
  assert.deepEqual(startingQueueMessages(queue, [{ ...sameText, role: 'assistant', submissionId: item.id }]), [item]);
  assert.deepEqual(startingQueueMessages(queue, [{ ...sameText, submissionId: item.id }]), []);
  assert.deepEqual(startingQueueMessages(queue, [{ ...sameText, submissionId: item.id }], 'observed-context'), []);
  assert.deepEqual(startingQueueMessages(queue, [], 'observed-context'), [], 'an already presented user message leaving the bounded snapshot must not resurrect a startup card');
  assert.deepEqual(startingQueueMessages(queue, [], 'other-context'), [item]);
});

test('queue feedback requires an explicit post-ACK fresh snapshot and settles fast failures without observing intermediate states', () => {
  const failed: ChatQueueSnapshot = { items: [{ ...item, status: 'queued' }], paused: true, error: 'task failed' };
  for (const kind of ['resume', 'now']) {
    const state = new ChatActionState();
    const action = state.begin('session', kind, item.id, queueFeedbackVersion(failed, version(1)))!;
    assert.equal(state.begin('session', kind, item.id), undefined, 'synchronous gate rejects repeated clicks');
    state.accepted('session', action.token);
    assert.equal(queueActionConfirmed(state.getSnapshot('session')!, structuredClone(failed), [], version(2)), false, 'an unrelated newer read started before ACK is not a fresh observation barrier');
    assert.equal(state.beginSync('session', action.token), true);
    assert.equal(state.beginSync('session', action.token), false, 'result verification is also synchronously deduplicated');
    state.syncFailed('session', action.token);
    assert.equal(queueActionConfirmed(state.getSnapshot('session')!, failed, [], version(3)), false, 'failed state reads cannot release a request already accepted by the host');
    state.beginSync('session', action.token); state.synchronized('session', action.token, version(4));
    const synchronized = state.getSnapshot('session')!;
    assert.equal(queueActionConfirmed(synchronized, failed, [], version(3)), false, 'React rendering the preceding snapshot cannot release the fresh barrier');
    assert.equal(queueActionConfirmed(synchronized, failed, [], version(4)), true, 'post-ACK fresh failed/paused authority releases controls for inspection and explicit retry');
    assert.equal(queueActionConfirmed(action, failed, [], version(3)), false, 'a snapshot cannot unlock an IPC still in flight');
  }
  const state = new ChatActionState(), removing = state.begin('session', 'remove', item.id)!;
  state.accepted('session', removing.token); state.synchronized('session', removing.token, version(5));
  assert.equal(queueActionConfirmed(state.getSnapshot('session')!, failed, [], version(5)), false, 'a removal is not confirmed by paused/error while its target remains');
  assert.equal(queueActionConfirmed(state.getSnapshot('session')!, { ...failed, items: [] }, [], version(6)), true);
});

test('action tokens remain locked across subscriptions and stale callbacks cannot clear the next operation', () => {
  const state = new ChatActionState();
  const first = state.begin('session', 'stop')!;
  const unsubscribe = state.subscribe(() => {}); unsubscribe();
  assert.equal(state.begin('session', 'stop'), undefined);
  state.accepted('session', first.token);
  assert.equal(state.getSnapshot('session')!.accepted, true, 'acceptance alone does not reset the operation');
  assert.equal(chatActionHasFreshSnapshot(state.getSnapshot('session')!, version(8)), false, 'stop and recovery also require a fresh post-ACK observation');
  state.synchronized('session', first.token, version(9));
  assert.equal(chatActionHasFreshSnapshot(state.getSnapshot('session')!, version(8)), false);
  assert.equal(chatActionHasFreshSnapshot(state.getSnapshot('session')!, version(9)), true);
  state.clear('session', first.token);
  const second = state.begin('session', 'stop')!;
  state.clear('session', first.token);
  assert.equal(state.getSnapshot('session'), second);
  assert.ok(state.begin('other-session', 'stop'));
});

test('send-now feedback settles when a later explicit stop leaves its target queued without an error', () => {
  const state = new ChatActionState();
  const waiting: ChatQueueSnapshot = { items: [{ ...item, status: 'queued' }], paused: false };
  const action = state.begin('session', 'now', item.id, queueFeedbackVersion(waiting, version(1)))!;
  state.accepted('session', action.token);
  const stopped: ChatQueueSnapshot = { ...waiting, paused: true };
  assert.equal(queueActionConfirmed(state.getSnapshot('session')!, stopped, [], version(2)), false, 'IPC acceptance still needs a fresh observation');
  state.synchronized('session', action.token, version(3));
  assert.equal(queueActionConfirmed(state.getSnapshot('session')!, stopped, [], version(2)), false);
  assert.equal(queueActionConfirmed(state.getSnapshot('session')!, stopped, [], version(3)), true, 'explicit stop supersedes send-now and releases controls for removing or manually resuming the retained target');
  assert.equal(stopped.items[0].status, 'queued');
  assert.equal(stopped.error, undefined);
});

function submissionFixture() {
  const state = new ChatSubmissionState(), scope = 'session-context';
  let current = true, draft = 'original prompt', sent = 0, accepted = 0, errors = 0, refreshes = 0;
  const attachments = [{ path: '/private/capture.png', name: 'capture.png', bytes: 20 }];
  const submission = state.begin(scope, draft, attachments)!;
  const paint = deferred<void>(), send = deferred<{ messageId: string }>();
  const operation = () => runChatSubmission({ state, scope, submission, paint: () => paint.promise,
    send: () => { sent++; return send.promise; }, isCurrent: () => current,
    onSent: expected => { if (draft === expected) draft = ''; },
    onAttachmentsSent: files => { assert.deepEqual(files, attachments); }, onAccepted: () => { accepted++; },
    onError: () => { errors++; }, refresh: async () => { refreshes++; },
  });
  return { state, scope, submission, paint, send, operation, setCurrent: (value: boolean) => { current = value; },
    edit: (value: string) => { draft = value; }, read: () => ({ draft, sent, accepted, errors, refreshes }) };
}

test('submission paints before IPC, clears only acknowledged original content and preserves the next draft', async () => {
  const f = submissionFixture(), pending = f.operation();
  assert.equal(f.read().sent, 0);
  assert.equal(f.state.getSnapshot(f.scope)[0].status, 'submitting');
  f.paint.resolve(); await Promise.resolve();
  assert.equal(f.read().sent, 1);
  assert.equal(f.read().draft, 'original prompt');
  f.edit('next draft'); f.send.resolve({ messageId: item.id }); await pending;
  assert.equal(f.read().draft, 'next draft'); assert.equal(f.read().accepted, 1);
  assert.equal(f.state.getSnapshot(f.scope)[0].messageId, item.id, 'accepted feedback survives until authority takes over');
});

test('lost ACK with durable queue proof cleans original content and permits an intentional same-text new message', async () => {
  const f = submissionFixture(), pending = f.operation(); f.paint.resolve(); await Promise.resolve();
  f.state.reconcile(f.scope, { items: [{ ...item, clientRequestId: f.submission.requestId }], paused: false });
  f.send.reject(new Error('acknowledgement lost')); await pending;
  assert.equal(f.read().draft, ''); assert.equal(f.read().accepted, 1); assert.equal(f.read().errors, 0);
  assert.notEqual(f.state.begin(f.scope, f.submission.draft, f.submission.files)!.requestId, f.submission.requestId);
});

test('switching away permits origin draft cleanup but suppresses errors, navigation and refresh in the selected pane', async () => {
  const f = submissionFixture(), pending = f.operation(); f.paint.resolve(); await Promise.resolve(); f.setCurrent(false);
  f.send.resolve({ messageId: item.id }); await pending;
  assert.equal(f.read().draft, ''); assert.equal(f.read().accepted, 0); assert.equal(f.read().refreshes, 0);
  const failed = submissionFixture(), failure = failed.operation(); failed.paint.resolve(); await Promise.resolve(); failed.setCurrent(false);
  failed.send.reject(new Error('late rejection')); await failure;
  assert.equal(failed.read().errors, 0); assert.equal(failed.read().draft, 'original prompt');
  assert.equal(failed.state.begin(failed.scope, failed.submission.draft, failed.submission.files)!.requestId, failed.submission.requestId);
});

test('deleted or recreated scope cannot dispatch after paint or clear a new-context draft on a late acknowledgement', async () => {
  const beforeSend = submissionFixture(), blocked = beforeSend.operation();
  beforeSend.state.retain([]); beforeSend.setCurrent(false); beforeSend.paint.resolve(); await blocked;
  assert.equal(beforeSend.read().sent, 0);
  const afterSend = submissionFixture(), pending = afterSend.operation(); afterSend.paint.resolve(); await Promise.resolve();
  afterSend.state.retain([]); afterSend.setCurrent(false); afterSend.send.resolve({ messageId: item.id }); await pending;
  assert.equal(afterSend.read().draft, 'original prompt'); assert.equal(afterSend.read().accepted, 0);
});
