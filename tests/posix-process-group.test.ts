import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signalPosixGroup } from '../src/main/posix-process-group';

function failure(code: string) { return Object.assign(new Error(`kill ${code}`), { code }); }
function denied(output: string | Error, error = failure('EPERM')) {
  const calls: unknown[] = [];
  return { error, calls, operations: {
    signal(pid: number, signal: NodeJS.Signals) { calls.push([pid, signal]); throw error; },
    async list() { calls.push('ps'); if (output instanceof Error) throw output; return output; },
  } };
}
test('group signals target only the owned group and skip inspection after success or ESRCH', async () => {
  const signals: unknown[] = [];
  await signalPosixGroup(42, 'SIGTERM', { signal: (...args) => signals.push(args), list: async () => { throw new Error('unexpected inspection'); } });
  assert.deepEqual(signals, [[-42, 'SIGTERM']]);
  const f = denied(new Error('unexpected inspection'), failure('ESRCH'));
  await signalPosixGroup(42, 'SIGKILL', f.operations);
  assert.deepEqual(f.calls, [[-42, 'SIGKILL']]);
});
test('Darwin EPERM accepts only a fresh process table proving the group absent or entirely zombies', async () => {
  for (const output of [' 8 Ss\n 9 R+\n', ' 42 Z\n 42 Z+\n 9 R+\n']) {
    const f = denied(output);
    await signalPosixGroup(42, 'SIGKILL', f.operations);
    assert.deepEqual(f.calls, [[-42, 'SIGKILL'], 'ps']);
  }
});
test('EPERM still blocks shutdown if any group member is live, including a live descendant beside a zombie root', async () => {
  for (const output of ['42 S\n9 R+\n', '42 Z+\n42 Ss\n9 R+\n']) {
    const f = denied(output);
    await assert.rejects(signalPosixGroup(42, 'SIGTERM', f.operations), error => error === f.error);
  }
});
test('missing, malformed or failed process inspection preserves the original permission failure', async () => {
  for (const output of ['', ' \n ', '42\n9 R\n', 'garbage\n9 R\n', new Error('ps failed')]) {
    const f = denied(output);
    await assert.rejects(signalPosixGroup(42, 'SIGKILL', f.operations), error => error === f.error);
  }
});
test('other signal errors are never excused by an empty group and invalid identities cannot signal the caller', async () => {
  const f = denied('9 R\n', failure('EINVAL'));
  await assert.rejects(signalPosixGroup(42, 'SIGTERM', f.operations), error => error === f.error);
  assert.deepEqual(f.calls, [[-42, 'SIGTERM']]);
  for (const pid of [0, 1, -42, NaN]) await assert.rejects(signalPosixGroup(pid, 'SIGTERM', f.operations), /进程组身份/);
  assert.equal(f.calls.length, 1);
});
