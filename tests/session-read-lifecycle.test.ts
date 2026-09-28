import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionReadLifecycle } from '../src/renderer/session-read-lifecycle';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('deletion invalidates pending snapshots and blocks refresh before the removal broadcast', async () => {
  const reads = new SessionReadLifecycle(); reads.retain(['session']);
  const oldSuccess = deferred<string>(), oldFailure = deferred<string>(), deletion = deferred<void>();
  const success = reads.read('session', () => oldSuccess.promise);
  const failure = reads.read('session', () => oldFailure.promise);
  const removing = reads.remove('session', () => deletion.promise);
  const unexpected = async () => { assert.fail('A deleting session must not issue a new snapshot request'); };
  assert.equal(await reads.read('session', unexpected), undefined);
  oldFailure.reject(new Error('会话不存在。'));
  assert.equal(await failure, undefined);
  deletion.resolve(); await removing;
  oldSuccess.resolve('obsolete snapshot');
  assert.equal(await success, undefined);
  assert.equal(await reads.read('session', unexpected), undefined);
  reads.retain([]);
  assert.equal(await reads.read('session', unexpected), undefined);
});

test('failed deletion resumes reads while a late failure from its previous generation stays obsolete', async () => {
  const reads = new SessionReadLifecycle(); reads.retain(['session']);
  const old = deferred<string>(), deletion = deferred<void>();
  const pending = reads.read('session', () => old.promise);
  let refreshed: Promise<string | undefined> | undefined;
  const unsubscribe = reads.subscribe('session', () => { refreshed = reads.read('session', async () => 'recovered snapshot'); });
  const removing = reads.remove('session', () => deletion.promise);
  deletion.reject(new Error('Deletion was refused'));
  await assert.rejects(removing, /Deletion was refused/);
  assert.equal(await refreshed, 'recovered snapshot');
  old.reject(new Error('old IPC failed after rollback'));
  assert.equal(await pending, undefined);
  await assert.rejects(reads.read('session', async () => { throw new Error('Current snapshot failed'); }), /Current snapshot failed/);
  assert.equal(await reads.read('session', async () => 'next snapshot'), 'next snapshot');
  unsubscribe();
});

test('workspace removal invalidates an outstanding read before its view has unmounted', async () => {
  const reads = new SessionReadLifecycle(); reads.retain(['session', 'other']);
  const old = deferred<string>();
  const unsubscribe = reads.subscribe('session', () => assert.fail('A removed session must not resume'));
  const pending = reads.read('session', () => old.promise);
  reads.retain(['other']);
  old.reject(new Error('Session disappeared during hydration'));
  assert.equal(await pending, undefined);
  assert.equal(await reads.read('session', async () => assert.fail('Removed sessions cannot be read')), undefined);
  assert.equal(await reads.read('other', async () => 'unaffected'), 'unaffected');
  unsubscribe();
});

test('a removal broadcast and unmount during deletion do not revive reads or notify disposed views', async () => {
  const reads = new SessionReadLifecycle(); reads.retain(['session']);
  const deletion = deferred<void>();
  const unsubscribe = reads.subscribe('session', () => assert.fail('Disposed views must not refresh'));
  const removing = reads.remove('session', () => deletion.promise);
  reads.retain([]); unsubscribe();
  deletion.reject(new Error('Late deletion response failed'));
  await assert.rejects(removing, /Late deletion response failed/);
  assert.equal(await reads.read('session', async () => assert.fail('A missing session must stay unavailable')), undefined);
  reads.retain(['replacement']);
  assert.equal(await reads.read('replacement', async () => 'new session'), 'new session');
});
