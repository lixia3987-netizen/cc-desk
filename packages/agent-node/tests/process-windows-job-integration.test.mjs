import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { setImmediate as tick } from 'node:timers/promises';
import { ProcessSupervisor } from '../dist/process-supervisor.js';

function fixture({ failedSpawn = false } = {}) {
  const originalSpawn = childProcess.spawn;
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const messages = [];
  const helpers = [];
  const makeChild = pid => {
    const child = new EventEmitter();
    child.pid = pid; child.connected = true; child.kills = 0;
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { child.kills++; return true; };
    child.send = (message, callback) => { messages.push(message); callback?.(null); };
    child.finish = () => {
      child.connected = false;
      child.emit('exit', 1, null);
      child.stdout.end(); child.stderr.end(); child.stdin.end();
      child.emit('close', 1, null);
    };
    return child;
  };
  const guardian = makeChild(failedSpawn ? undefined : 321);
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
  childProcess.spawn = (_executable, argv) => {
    if (!helpers.length) {
      helpers.push(guardian);
      queueMicrotask(() => failedSpawn ? guardian.emit('error', Object.assign(new Error('spawn failed'), { code: 'ENOENT' })) : guardian.emit('spawn'));
      return guardian;
    }
    const helper = makeChild(322);
    helper.nonce = argv.at(-1).match(/::Run\(321,'([a-f0-9]{64})'/)?.[1];
    assert.ok(helper.nonce);
    helpers.push(helper);
    return helper;
  };
  syncBuiltinESMExports();
  return {
    guardian, helpers, messages,
    restore() {
      childProcess.spawn = originalSpawn; syncBuiltinESMExports();
      Object.defineProperty(process, 'platform', originalPlatform);
      for (const helper of helpers) {
        helper.stdin.destroy(); helper.stdout.destroy(); helper.stderr.destroy();
      }
    },
  };
}

test('a guardian spawn error with no PID still waits for Node close without requiring an exit event', async () => {
  const f = fixture({ failedSpawn: true });
  const supervisor = new ProcessSupervisor({ environment: { SystemRoot: 'C:\\Windows' }, cleanupTimeoutMs: 200, terminationGraceMs: 1 });
  try {
    const running = supervisor.run('spawn-error', { executable: process.execPath, argv: [], cwd: process.cwd() });
    let settled = false;
    void running.then(() => { settled = true; });
    await tick();
    assert.equal(settled, false);
    assert.equal(supervisor.has('spawn-error'), true);
    assert.equal(f.helpers.length, 1, 'no containment helper is started for a failed guardian spawn');
    assert.equal(f.guardian.kills, 0);
    f.guardian.stdout.end(); f.guardian.stderr.end();
    f.guardian.emit('close', -2, null);
    const result = await running;
    assert.equal(result.cleanup, 'released', result.error);
    assert.match(result.error, /Unable to start/);
    assert.equal(supervisor.activeCount, 0);
  } finally {
    for (const helper of f.helpers) helper.finish();
    await supervisor.dispose();
    f.restore();
  }
});

test('cancelling Windows Job preparation never launches and waits for both physical close barriers', async () => {
  const f = fixture();
  const supervisor = new ProcessSupervisor({ environment: { SystemRoot: 'C:\\Windows' }, cleanupTimeoutMs: 200, terminationGraceMs: 1 });
  const controller = new AbortController();
  try {
    const running = supervisor.run('preparing', { executable: process.execPath, argv: [], cwd: process.cwd() }, controller.signal);
    let settled = false;
    void running.then(() => { settled = true; });
    await tick();
    const helper = f.helpers[1];
    helper.stdout.write(JSON.stringify({ type: 'held', nonce: helper.nonce }) + '\n');
    await tick();
    assert.equal(f.messages[0].type, 'challenge');
    controller.abort();
    await tick();
    assert.ok(helper.kills > 0);
    assert.ok(f.guardian.kills > 0);
    // A response buffered before cancellation must not authorize a late launch.
    f.guardian.emit('message', { type: 'challenge-response', nonce: helper.nonce });
    helper.stdout.write('{"type":"ready"}\n');
    await tick();
    assert.equal(f.messages.some(message => message.type === 'launch'), false);
    assert.equal(settled, false);
    f.guardian.finish();
    await tick();
    assert.equal(settled, false, 'guardian close cannot replace helper close');
    helper.finish();
    const result = await running;
    assert.equal(result.cancelled, true);
    assert.equal(result.cleanup, 'released', result.error);
    assert.equal(supervisor.activeCount, 0);
  } finally {
    for (const helper of f.helpers) helper.finish();
    await supervisor.dispose();
    f.restore();
  }
});

test('failed Windows preparation retains occupancy until the outstanding helper actually closes', async () => {
  const f = fixture();
  const supervisor = new ProcessSupervisor({ environment: { SystemRoot: 'C:\\Windows' }, cleanupTimeoutMs: 40, terminationGraceMs: 1 });
  const controller = new AbortController();
  try {
    const running = supervisor.run('preparing', { executable: process.execPath, argv: [], cwd: process.cwd() }, controller.signal);
    await tick();
    controller.abort();
    f.guardian.finish();
    const result = await running;
    assert.equal(result.cleanup, 'cleanup_failed');
    assert.equal(result.cleanupDiagnostic.phase, 'windows_helper_release');
    assert.equal(supervisor.has('preparing'), true);
    assert.equal(f.messages.some(message => message.type === 'launch'), false);
    f.helpers[1].finish();
    await supervisor.stopOwner('preparing');
    assert.equal(supervisor.activeCount, 0);
  } finally {
    for (const helper of f.helpers) helper.finish();
    await supervisor.dispose();
    f.restore();
  }
});

for (const loss of ['invalid output', 'failed result', 'helper exit']) {
  test(`Windows Job readiness followed by ${loss} before the await resumes never authorizes launch`, async () => {
    const f = fixture();
    const supervisor = new ProcessSupervisor({ environment: { SystemRoot: 'C:\\Windows' }, cleanupTimeoutMs: 200, terminationGraceMs: 1 });
    try {
      const running = supervisor.run('lost-ready', { executable: process.execPath, argv: [], cwd: process.cwd() });
      await tick();
      const helper = f.helpers[1];
      helper.stdout.write(JSON.stringify({ type: 'held', nonce: helper.nonce }) + '\n');
      await tick();
      f.guardian.emit('message', { type: 'challenge-response', nonce: helper.nonce });
      await tick();
      assert.equal(f.messages.some(message => message.type === 'launch'), false);
      if (loss === 'invalid output') {
        // One data callback resolves ready, then invalidates the same Job before
        // the supervisor's await continuation can send the launch message.
        helper.stdout.write('{"type":"ready"}\ninvalid-json\n');
      } else if (loss === 'failed result') {
        helper.stdout.write('{"type":"ready"}\n' + JSON.stringify({
          type: 'result', released: false, stage: 'query', code: 'query_failed', nativeCode: 5, activeProcesses: 1,
        }) + '\n');
      } else {
        helper.stdout.write('{"type":"ready"}\n');
        helper.emit('exit', 1, null);
      }
      await tick();
      assert.equal(f.messages.some(message => message.type === 'launch'), false);
      assert.ok(f.guardian.kills > 0, 'the still-empty guardian is stopped through its owned handle');
      f.guardian.finish(); helper.finish();
      const result = await running;
      assert.equal(result.cleanup, 'cleanup_failed', 'lost Job evidence cannot authorize release');
      assert.equal(result.timedOut, false, 'the command execution timer never started');
      assert.equal(supervisor.has('lost-ready'), true);
    } finally {
      for (const helper of f.helpers) helper.finish();
      // The mocked OS handles are closed, but the deliberately failed Job must
      // keep its logical owner occupied instead of inventing release evidence.
      await supervisor.dispose().catch(() => {});
      f.restore();
    }
  });
}
