import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChatSubmissionState, visibleChatSubmissions } from '../src/renderer/chat-submission-state';
import type { ChatMessage, ChatQueueSnapshot } from '../src/shared/chat';
import type { Attachment } from '../src/shared/types';

const file: Attachment = { path: '/session/a.txt', name: 'a.txt', bytes: 12 };
const queue = (requestId: string, messageId = 'message-1'): ChatQueueSnapshot => ({
  paused: false, items: [{ id: messageId, clientRequestId: requestId, text: 'identical', attachments: [], createdAt: 'now', status: 'sending' }],
});
const message = (submissionId: string, role: ChatMessage['role'] = 'user'): ChatMessage => ({
  id: `canonical-${submissionId}`, submissionId, turnId: 'turn-1', role, text: 'identical', createdAt: 'now',
});

test('begin is a synchronous session gate across subscriptions and captures immutable input', () => {
  const state = new ChatSubmissionState();
  const files = [{ ...file }];
  let changes = 0;
  const unsubscribe = state.subscribe(() => { changes++; });
  const first = state.begin('session', '  original draft  ', files, 'task-1')!;
  assert.equal(changes, 1);
  assert.equal(first.text, 'original draft');
  files[0].path = '/other.txt'; files.push({ ...file });
  assert.deepEqual(first.files, [file]);
  assert.equal(Object.isFrozen(first.files), true);
  assert.equal(Object.isFrozen(first.files[0]), true);
  assert.equal(state.hasInFlight('session'), true);
  unsubscribe();
  // A newly mounted subscriber shares the gate rather than creating a second submission.
  const remounted = state.subscribe(() => { changes++; });
  assert.equal(state.begin('session', 'original draft', [file]), undefined);
  assert.equal(state.getSnapshot('session')[0].requestId, first.requestId);
  assert.equal(changes, 1);
  remounted();
});

test('failed receipt preserves retry identity across unmount and payload changes', () => {
  const state = new ChatSubmissionState();
  const first = state.begin('session', 'identical', [file], 'task-1')!;
  state.failed('session', first.requestId, 'connection interrupted');
  assert.equal(state.hasInFlight('session'), false);
  assert.equal(state.getSnapshot('session')[0].error, 'connection interrupted');
  const retry = state.begin('session', 'identical', [{ ...file }], 'task-1')!;
  assert.equal(retry.requestId, first.requestId);
  assert.equal(retry.error, undefined);
  state.failed('session', retry.requestId, 'still unavailable');
  const different = state.begin('session', 'identical', [{ ...file, path: '/session/b.txt' }], 'task-1')!;
  assert.notEqual(different.requestId, first.requestId);
  assert.deepEqual(state.getSnapshot('session').map(item => item.requestId), [different.requestId]);
  state.failed('session', different.requestId, 'unavailable');
  const originalAgain = state.begin('session', 'identical', [file], 'task-1')!;
  assert.equal(originalAgain.requestId, first.requestId, 'hidden failure retains its deduplication identity');
  state.failed('session', originalAgain.requestId, 'unavailable');
  assert.notEqual(state.begin('session', 'identical', [file], 'task-2')!.requestId, first.requestId);
});

test('queue-before-ACK hides the overlay immediately while preserving the in-flight gate', () => {
  const state = new ChatSubmissionState();
  const pending = state.begin('session', 'identical', [])!;
  const authoritativeQueue = queue(pending.requestId);
  const initial = state.getSnapshot('session');
  assert.deepEqual(visibleChatSubmissions(initial, authoritativeQueue), []);
  state.reconcile('session', authoritativeQueue);
  assert.equal(state.hasInFlight('session'), true);
  assert.equal(state.getSnapshot('session')[0].observed, true);
  assert.deepEqual(visibleChatSubmissions(state.getSnapshot('session')), []);
  state.reconcile('session', { paused: false, items: [] });
  assert.deepEqual(visibleChatSubmissions(state.getSnapshot('session')), [], 'queue disappearance cannot resurface a seen overlay');
  state.accepted('session', pending.requestId, 'message-1');
  assert.equal(state.hasInFlight('session'), false);
  assert.deepEqual(state.getSnapshot('session'), []);
  state.accepted('session', pending.requestId, 'message-1');
  assert.deepEqual(state.getSnapshot('session'), [], 'late ACK cannot resurrect an observed submission');
});

test('lost ACK after queue proof hides the card but reuses identity until explicit acknowledgment', () => {
  const state = new ChatSubmissionState();
  const pending = state.begin('session', 'identical', [])!;
  state.reconcile('session', queue(pending.requestId));
  state.failed('session', pending.requestId, 'ACK connection lost');
  assert.equal(state.hasInFlight('session'), false);
  assert.deepEqual(state.getSnapshot('session'), []);
  const retry = state.begin('session', 'identical', [])!;
  assert.equal(retry.requestId, pending.requestId, 'an unchanged draft retries the original ID until ACK permits draft clearing');
  assert.equal(state.hasInFlight('session'), true);
  assert.deepEqual(visibleChatSubmissions(state.getSnapshot('session')), [], 'a retry of a proven submission stays hidden');
  state.accepted('session', retry.requestId, 'message-1');
  assert.deepEqual(state.getSnapshot('session'), []);
  const next = state.begin('session', 'identical', [])!;
  assert.notEqual(next.requestId, pending.requestId, 'an explicit identical send after real ACK is a new message');
});

test('durable queue proof can finish acceptance without ACK and release old retry identity', () => {
  const state = new ChatSubmissionState();
  const pending = state.begin('session', 'identical', [])!;
  assert.equal(state.accepted('session', pending.requestId), false, 'a pending request without host identity is not acceptance');
  assert.equal(state.hasInFlight('session'), true);
  state.reconcile('session', queue(pending.requestId));
  state.failed('session', pending.requestId, 'ACK lost');
  assert.equal(state.isObserved('session', pending.requestId), true);
  assert.equal(state.accepted('session', pending.requestId), true);
  assert.deepEqual(state.getSnapshot('session'), []);
  const next = state.begin('session', 'identical', [])!;
  assert.notEqual(next.requestId, pending.requestId, 'cleared draft permits a new intentional identical send');
});

test('receipt-only proof before ACK maps exact identity and permits safe cleanup after ACK loss', () => {
  const state = new ChatSubmissionState();
  const pending = state.begin('session', 'already finished before any queue or message read', [])!;
  const receipts: ChatQueueSnapshot = { items: [], paused: false, receipts: [{ requestId: pending.requestId, messageId: 'receipt-message' }] };
  assert.deepEqual(visibleChatSubmissions(state.getSnapshot('session'), receipts), []);
  state.reconcile('session', receipts, []);
  assert.equal(state.isObserved('session', pending.requestId), true);
  assert.equal(state.getSnapshot('session')[0].messageId, 'receipt-message');
  state.failed('session', pending.requestId, 'ACK lost');
  assert.equal(state.accepted('session', pending.requestId), true);
  assert.deepEqual(state.getSnapshot('session'), []);
  assert.notEqual(state.begin('session', pending.draft, [])!.requestId, pending.requestId);
});

test('receipt-only proof after ACK hides exact accepted message while empty or unrelated queues do not', () => {
  const state = new ChatSubmissionState();
  const pending = state.begin('session', 'accepted draft', [])!;
  state.accepted('session', pending.requestId, 'receipt-message');
  state.reconcile('session', { items: [], paused: false }, []);
  assert.equal(state.getSnapshot('session').length, 1);
  state.reconcile('session', { items: [], paused: false, receipts: [{ requestId: 'other-request', messageId: 'other-message' }] }, []);
  assert.equal(state.getSnapshot('session').length, 1);
  const receipts: ChatQueueSnapshot = { items: [], paused: false, receipts: [{ requestId: 'legacy-request', messageId: 'receipt-message' }] };
  assert.deepEqual(visibleChatSubmissions(state.getSnapshot('session'), receipts), []);
  state.reconcile('session', receipts, []);
  assert.deepEqual(state.getSnapshot('session'), []);
  assert.equal(state.isObserved('session', pending.requestId), true);
});

test('fast canonical message before ACK is remembered even after it leaves the message window', () => {
  const state = new ChatSubmissionState();
  const pending = state.begin('session', 'identical', [])!;
  state.reconcile('session', undefined, [message('message-1')]);
  state.reconcile('session', undefined, []);
  state.accepted('session', pending.requestId, 'message-1');
  assert.deepEqual(state.getSnapshot('session'), []);
  assert.equal(state.hasInFlight('session'), false);
});

test('accepted overlay stays visible until exact queue or user message identity appears', () => {
  const state = new ChatSubmissionState();
  const first = state.begin('session', 'identical', [])!;
  state.accepted('session', first.requestId, 'message-1');
  assert.equal(state.getSnapshot('session')[0].status, 'accepted');
  const second = state.begin('session', 'identical', [file])!;
  assert.notEqual(second.requestId, first.requestId);
  state.reconcile('session', queue('other-request', 'other-message'), [message('message-1', 'assistant')]);
  assert.equal(state.getSnapshot('session').length, 2, 'same text and assistant metadata cannot match a user submission');
  state.reconcile('session', undefined, [message('message-1')]);
  assert.deepEqual(state.getSnapshot('session').map(item => item.requestId), [second.requestId]);
  state.accepted('session', second.requestId, 'message-2');
  const fallbackQueue = queue('unrelated-request', 'message-2');
  assert.deepEqual(visibleChatSubmissions(state.getSnapshot('session'), fallbackQueue), []);
  state.reconcile('session', fallbackQueue);
  assert.deepEqual(state.getSnapshot('session'), []);
});

test('session keys isolate receipts, gates, and canonical identity evidence', () => {
  const state = new ChatSubmissionState();
  const first = state.begin('session-a', 'identical', [])!;
  const second = state.begin('session-b', 'identical', [])!;
  state.accepted('session-b', first.requestId, 'message-1');
  state.failed('session-a', second.requestId, 'wrong session');
  state.reconcile('session-b', queue(first.requestId), [message('message-1')]);
  state.accepted('session-a', first.requestId, 'message-1');
  assert.equal(state.getSnapshot('session-a')[0].status, 'accepted');
  assert.equal(state.getSnapshot('session-b')[0].status, 'submitting');
  assert.equal(state.hasInFlight('session-a'), false);
  assert.equal(state.hasInFlight('session-b'), true);
});

test('unchanged snapshots keep reference identity and deleted sessions ignore late receipts', () => {
  const state = new ChatSubmissionState();
  const initial = state.getSnapshot('session');
  assert.equal(state.begin('session', ' \n ', []), undefined);
  assert.equal(state.getSnapshot('session'), initial);
  const first = state.begin('session', 'identical', [])!;
  const pending = state.getSnapshot('session');
  let changes = 0;
  const unsubscribe = state.subscribe(() => { changes++; });
  state.reconcile('session', { paused: false, items: [] }, []);
  assert.equal(state.getSnapshot('session'), pending);
  assert.equal(changes, 0);
  assert.equal(visibleChatSubmissions(pending), pending);
  state.clear('session');
  state.accepted('session', first.requestId, 'message-1');
  state.failed('session', first.requestId, 'late failure');
  assert.equal(state.getSnapshot('session'), initial);
  assert.equal(state.hasInFlight('session'), false);
  assert.equal(changes, 1);
  unsubscribe();
});

test('retain keeps only exact live session/context scopes and late IPC cannot recreate removed state', () => {
  const state = new ChatSubmissionState();
  const oldScope = JSON.stringify(['session-a', 'old-context']);
  const currentScope = JSON.stringify(['session-a', 'new-context']);
  const removedScope = JSON.stringify(['session-b', 'context']);
  const old = state.begin(oldScope, 'old draft', [file])!;
  const current = state.begin(currentScope, 'current draft', [])!;
  const removed = state.begin(removedScope, 'removed draft', [])!;
  const currentSnapshot = state.getSnapshot(currentScope);
  state.retain([currentScope]);
  assert.equal(state.accepted(oldScope, old.requestId, 'late-old-message'), false);
  state.failed(removedScope, removed.requestId, 'late failure');
  state.reconcile(oldScope, queue(old.requestId));
  assert.deepEqual(state.getSnapshot(oldScope), []);
  assert.deepEqual(state.getSnapshot(removedScope), []);
  assert.equal(state.isObserved(oldScope, old.requestId), false);
  assert.equal(state.hasInFlight(oldScope), false);
  assert.equal(state.hasInFlight(removedScope), false);
  assert.equal(state.hasScope(oldScope), false);
  assert.equal(state.hasScope(currentScope), true);
  assert.equal(state.getSnapshot(currentScope), currentSnapshot);
  assert.equal(state.getSnapshot(currentScope)[0].requestId, current.requestId);
});

test('observed reception proof survives settled payload cleanup and stays isolated by scope', () => {
  const state = new ChatSubmissionState();
  const pending = state.begin('session', 'sensitive draft', [file])!;
  state.reconcile('session', queue(pending.requestId));
  assert.equal(state.isObserved('session', pending.requestId), true);
  state.failed('session', pending.requestId, 'ACK lost');
  assert.equal(state.isObserved('session', pending.requestId), true);
  assert.equal(state.accepted('session', pending.requestId, 'message-1'), true);
  assert.deepEqual(state.getSnapshot('session'), []);
  assert.equal(state.isObserved('session', pending.requestId), true);
  assert.equal(state.accepted('session', pending.requestId, 'message-1'), true, 'bounded tombstone still proves acceptance without retaining payload');
  assert.equal(state.isObserved('other-session', pending.requestId), false);
  state.clear('session');
  assert.equal(state.isObserved('session', pending.requestId), false);
});

test('historical hidden retry payloads and observed identity tombstones are bounded', () => {
  const state = new ChatSubmissionState();
  const first = state.begin('session', 'old failed draft', [])!;
  state.failed('session', first.requestId, 'offline');
  let latestId = '';
  for (let index = 0; index < 12; index++) {
    const pending = state.begin('session', `replacement-${index}`, [])!;
    latestId = pending.requestId;
    state.failed('session', pending.requestId, 'offline');
  }
  assert.deepEqual(state.getSnapshot('session').map(item => item.requestId), [latestId], 'current failed draft remains available');
  const latestRetry = state.begin('session', 'replacement-11', [])!;
  assert.equal(latestRetry.requestId, latestId);
  state.failed('session', latestRetry.requestId, 'offline');
  const oldAgain = state.begin('session', 'old failed draft', [])!;
  assert.notEqual(oldAgain.requestId, first.requestId, 'superseded historical payloads are eventually released');
  state.failed('session', oldAgain.requestId, 'offline');
  let earliestProof = '', latestProof = '';
  for (let index = 0; index < 514; index++) {
    const pending = state.begin('session', `confirmed-${index}`, [])!;
    if (!index) earliestProof = pending.requestId;
    latestProof = pending.requestId;
    state.accepted('session', pending.requestId, `confirmed-message-${index}`);
    state.reconcile('session', queue(pending.requestId, `confirmed-message-${index}`));
    assert.equal(state.hasInFlight('session'), false);
  }
  assert.deepEqual(state.getSnapshot('session'), []);
  assert.equal(state.isObserved('session', earliestProof), false);
  assert.equal(state.isObserved('session', latestProof), true);
});

test('adoptAccepted bridges first-message ACK without replay and retains the full card through empty snapshots', () => {
  const state = new ChatSubmissionState(), files = [{ ...file }];
  state.retain(['session']);
  const input = { requestId: 'first-request', messageId: 'first-message', draft: '  first message  ', files };
  assert.equal(state.adoptAccepted('session', input), true);
  const adopted = state.getSnapshot('session');
  assert.equal(adopted.length, 1);
  assert.equal(adopted[0].status, 'accepted');
  assert.equal(adopted[0].text, 'first message');
  assert.equal(adopted[0].messageId, input.messageId);
  assert.equal(state.hasInFlight('session'), false, 'adoption neither submits nor acquires an IPC gate');
  files[0].path = '/changed-after-ACK.txt';
  assert.deepEqual(adopted[0].files, [file]);
  assert.equal(Object.isFrozen(adopted[0].files[0]), true);
  state.reconcile('session', { items: [], paused: false }, []);
  assert.equal(state.getSnapshot('session'), adopted, 'an empty initial projection cannot acknowledge display');
  assert.equal(state.adoptAccepted('session', { ...input, files: [file] }), true);
  assert.equal(state.getSnapshot('session'), adopted, 'repeated handoff is idempotent');
  state.reconcile('session', { items: [], paused: false, receipts: [{ requestId: 'wrong-request', messageId: 'wrong-message' }] }, [message('wrong-message')]);
  assert.equal(state.getSnapshot('session'), adopted);
  state.reconcile('session', undefined, [message('first-message')]);
  assert.deepEqual(state.getSnapshot('session'), []);
  assert.equal(state.adoptAccepted('session', { ...input, files: [file] }), true);
  assert.deepEqual(state.getSnapshot('session'), [], 'a late repeated handoff cannot restore an observed card');
});

for (const proof of ['queue', 'receipt', 'canonical'] as const) {
  test(`adoptAccepted respects ${proof} proof that arrives before or after handoff`, () => {
    const input = { requestId: 'first-request', messageId: 'first-message', draft: 'first draft', files: [] };
    for (const timing of ['before', 'after']) {
      const state = new ChatSubmissionState(); state.retain(['session']);
      const reconcile = () => state.reconcile('session', proof === 'queue' ? queue(input.requestId, input.messageId)
        : proof === 'receipt' ? { items: [], paused: false, receipts: [{ requestId: input.requestId, messageId: input.messageId }] }
          : undefined, proof === 'canonical' ? [message(input.messageId)] : []);
      if (timing === 'before') reconcile();
      assert.equal(state.adoptAccepted('session', input), true);
      if (timing === 'after') reconcile();
      assert.deepEqual(state.getSnapshot('session'), []);
      assert.equal(state.isObserved('session', input.requestId), true);
      assert.equal(state.hasInFlight('session'), false);
    }
  });
}

test('adoptAccepted rejects removed contexts and does not duplicate an existing request', () => {
  const state = new ChatSubmissionState(); state.retain(['current']);
  const pending = state.begin('current', 'existing draft', [])!;
  const input = { requestId: pending.requestId, messageId: 'first-message', draft: pending.draft, files: [] };
  assert.equal(state.adoptAccepted('current', input), true);
  assert.equal(state.getSnapshot('current').length, 1);
  assert.equal(state.hasInFlight('current'), false);
  assert.equal(state.adoptAccepted('current', { ...input, messageId: 'different-host-message' }), false);
  state.retain(['new-context']);
  assert.equal(state.adoptAccepted('current', input), false);
  assert.deepEqual(state.getSnapshot('current'), []);
  state.reconcile('current', queue(input.requestId, input.messageId));
  assert.equal(state.hasScope('current'), false, 'late evidence cannot recreate a retired context');
  assert.equal(state.adoptAccepted('new-context', input), true);
  state.clear('new-context');
  assert.equal(state.adoptAccepted('new-context', input), false, 'explicit deletion also rejects late first-message handoff');
});
