import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProcessSupervisor } from '../dist/process-supervisor.js';

async function fixture(t, options = {}) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'native-command-handle-'));
  const supervisor = new ProcessSupervisor({ terminationGraceMs: 10, ...options });
  t.after(async () => {
    await supervisor.dispose();
    await rm(cwd, { recursive: true, force: true });
  });
  return { cwd, supervisor, command: code => ({ executable: process.execPath, argv: ['-e', code], cwd }) };
}

async function eventually(read, predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Command state did not reach the expected value.');
}

test('startup returns a live handle and snapshots expose bounded independent output before closure', async t => {
  const { supervisor, command } = await fixture(t);
  const handle = supervisor.start('live', { ...command('console.log("ready"); console.error("error-stream"); setInterval(() => {}, 1000);'), maxOutputBytes: 128 });
  assert.equal(await handle.started, true);
  const snapshot = await eventually(handle.snapshot, value => value.result.stdout.includes('ready') && value.result.stderr.includes('error-stream'));
  assert.equal(snapshot.started, true);
  assert.equal(snapshot.settled, false);
  assert.equal(snapshot.stopping, false);
  snapshot.result.stdout = 'forged';
  assert.equal(handle.snapshot().result.stdout, 'ready\n');
  const stopped = await handle.stop();
  assert.equal(stopped.cancelled, true);
  assert.equal(stopped.cleanup, 'released');
  assert.equal(handle.snapshot().settled, true);
  assert.equal(supervisor.activeCount, 0);
  assert.deepEqual(await handle.closed, stopped);
});

test('stopping one command preserves siblings and does not revoke the owner', async t => {
  const { supervisor, command } = await fixture(t);
  const first = supervisor.start('shared', command('setInterval(() => {}, 1000);'));
  const second = supervisor.start('shared', command('setInterval(() => {}, 1000);'));
  assert.deepEqual(await Promise.all([first.started, second.started]), [true, true]);
  await first.stop();
  assert.equal(supervisor.has('shared'), true);
  assert.equal(second.snapshot().settled, false);
  assert.equal(second.snapshot().result.cancelled, false);
  assert.equal((await supervisor.run('shared', command('process.exitCode = 7;'))).exitCode, 7);
  await supervisor.stopOwner('shared');
  assert.equal((await second.closed).cancelled, true);
  assert.equal(supervisor.has('shared'), false);
  await assert.rejects(supervisor.start('shared', command('')).closed, /released/);
});

for (const maxOutputBytes of [undefined, 8, 10]) test(`live UTF-8 snapshots remain stable across split writes with output limit ${maxOutputBytes ?? 'default'}`, async t => {
  const { supervisor, command, cwd } = await fixture(t);
  const ready = path.join(cwd, 'continue');
  const handle = supervisor.start('utf8', { ...command(`
    process.stdout.write(Buffer.concat([Buffer.from('prefix:'), Buffer.from([0xe4])]));
    const timer = setInterval(() => {
      if (!require('node:fs').existsSync(${JSON.stringify(ready)})) return;
      clearInterval(timer);
      process.stdout.write(Buffer.from([0xbd, 0xa0]));
      process.stdout.write('🙂suffix');
    }, 10);
  `), ...(maxOutputBytes ? { maxOutputBytes } : {}) });
  assert.equal(await handle.started, true);
  const partial = await eventually(handle.snapshot, value => value.result.outputBytes === 8);
  assert.equal(partial.result.stdout, 'prefix:');
  assert.equal(partial.result.truncated, false);
  await writeFile(ready, 'continue');
  const result = await handle.closed;
  assert.equal(result.stdout, maxOutputBytes === 8 ? 'prefix:' : maxOutputBytes === 10 ? 'prefix:你' : 'prefix:你🙂suffix');
  assert.ok(result.stdout.startsWith(partial.result.stdout));
  assert.equal(result.truncated, maxOutputBytes !== undefined);
  assert.equal(result.cleanup, 'released');
});

test('large live output keeps a shared bounded prefix and drains after truncation', async t => {
  const { supervisor, command } = await fixture(t);
  const handle = supervisor.start('bounded', {
    ...command('process.stdout.write("a".repeat(256 * 1024)); process.stderr.write("b".repeat(256 * 1024)); setInterval(() => {}, 1000);'),
    maxOutputBytes: 1_024,
  });
  assert.equal(await handle.started, true);
  const value = await eventually(handle.snapshot, value => value.result.outputBytes === 512 * 1_024);
  assert.equal(Buffer.byteLength(value.result.stdout) + Buffer.byteLength(value.result.stderr), 1_024);
  assert.equal(value.result.truncated, true);
  assert.equal(value.settled, false);
  const result = await handle.stop();
  assert.equal(result.outputBytes, 512 * 1_024);
  assert.equal(result.cleanup, 'released');
});

test('startup failure, invalid budget, and pre-abort never masquerade as successful startup', async t => {
  const { supervisor, command, cwd } = await fixture(t);
  const missing = supervisor.start('missing', { executable: path.join(cwd, 'missing'), argv: [], cwd });
  assert.equal(await missing.started, false);
  assert.match((await missing.closed).error, /not found/);
  assert.equal(missing.snapshot().settled, true);
  const invalid = supervisor.start('invalid', { ...command(''), timeoutMs: 120_001 });
  assert.equal(await invalid.started, false);
  await assert.rejects(invalid.closed, /timeoutMs/);
  assert.equal(invalid.snapshot().settled, true);
  const controller = new AbortController();
  controller.abort();
  const cancelled = supervisor.start('aborted', command('throw new Error("must not run");'), controller.signal);
  assert.equal(await cancelled.started, false);
  const result = await cancelled.closed;
  assert.equal(result.cancelled, true);
  assert.equal(result.stderr, '');
  assert.equal(result.cleanup, 'released');
  assert.equal(supervisor.activeCount, 0);
});

test('a finite timeout closes an asynchronous handle and natural completion is not rewritten by stop', async t => {
  const { supervisor, command } = await fixture(t);
  const limited = supervisor.start('limited', { ...command('setInterval(() => {}, 1000);'), timeoutMs: 500 });
  const timedOut = await limited.closed;
  assert.equal(timedOut.timedOut, true);
  assert.equal(timedOut.cleanup, 'released');
  const natural = supervisor.start('natural', command('console.log("done"); process.exitCode = 9;'));
  assert.equal(await natural.started, true);
  const result = await natural.closed;
  assert.equal(result.exitCode, 9);
  assert.equal(result.cancelled, false);
  assert.deepEqual(await natural.stop(), result);
  result.stdout = 'mutated caller copy';
  assert.equal(natural.snapshot().result.stdout, 'done\n');
});

test('failed cleanup retains ownership and stop retries without changing the first closure receipt', { skip: process.platform === 'win32' }, async t => {
  const { supervisor, command } = await fixture(t, { cleanupTimeoutMs: 150 });
  const handle = supervisor.start('retry', command('setInterval(() => {}, 1000);'));
  assert.equal(await handle.started, true);
  const originalKill = process.kill;
  let first;
  process.kill = function (pid, signal) {
    if (pid < 0) throw Object.assign(new Error('Injected group permission failure'), { code: 'EPERM' });
    return originalKill.call(process, pid, signal);
  };
  try {
    first = await handle.stop();
    assert.equal(first.cleanup, 'cleanup_failed');
    assert.equal((await handle.closed).cleanup, 'cleanup_failed');
    assert.equal(supervisor.has('retry'), true);
    const view = handle.snapshot();
    view.result.cleanupDiagnostic.code = 'forged';
    assert.notEqual(handle.snapshot().result.cleanupDiagnostic.code, 'forged');
  } finally {
    process.kill = originalKill;
    await handle.stop();
  }
  assert.equal(supervisor.has('retry'), false);
  assert.equal(handle.snapshot().result.cleanup, 'released');
  assert.equal(first.cleanup, 'cleanup_failed');
  assert.equal((await handle.closed).cleanup, 'cleanup_failed');
});
