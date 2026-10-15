import test from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalSubmission } from '../src/renderer/approval-submission';

test('approval feedback precedes dispatch and duplicate decisions stay locked after acceptance', async () => {
  const submission = new ApprovalSubmission();
  let painted!: () => void, accepted!: () => void, calls = 0;
  const paint = new Promise<void>(resolve => { painted = resolve; });
  const response = new Promise<void>(resolve => { accepted = resolve; });
  const states: unknown[] = [];
  const send = () => { calls++; return response; };
  const pending = submission.submit('allow', send, state => states.push(state), () => paint);
  assert.deepEqual(states, [{ behavior: 'allow', accepted: false }]);
  assert.equal(calls, 0);
  assert.equal(await submission.submit('deny', send, () => {}, async () => {}), false);
  painted(); await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(await submission.submit('allow', send, () => {}, async () => {}), false);
  accepted(); assert.equal(await pending, true);
  assert.deepEqual(submission.state, { behavior: 'allow', accepted: true });
  assert.equal(await submission.submit('allow', send, () => {}, async () => {}), false);
  assert.equal(calls, 1);
});

test('failed approvals restore controls, retain the error and permit an explicit retry', async () => {
  const submission = new ApprovalSubmission(), failure = new Error('IPC failed');
  const states: unknown[] = [];
  await assert.rejects(submission.submit('deny', () => { throw failure; }, state => states.push(state), async () => {}), error => error === failure);
  assert.equal(submission.state, undefined);
  assert.deepEqual(states, [{ behavior: 'deny', accepted: false }, undefined]);
  assert.equal(await submission.submit('deny', async () => {}, () => {}, async () => {}), true);
  assert.deepEqual(submission.state, { behavior: 'deny', accepted: true });
});

test('asynchronous transport rejection also unlocks only the failed approval', async () => {
  const first = new ApprovalSubmission(), second = new ApprovalSubmission();
  await second.submit('allow', async () => {}, () => {}, async () => {});
  await assert.rejects(first.submit('allow', async () => { throw new Error('offline'); }, () => {}, async () => {}), /offline/);
  assert.equal(first.state, undefined);
  assert.deepEqual(second.state, { behavior: 'allow', accepted: true });
});
