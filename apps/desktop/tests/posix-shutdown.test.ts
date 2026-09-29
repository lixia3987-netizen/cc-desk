import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { StateStore } from '../src/main/store';
import { Runtime } from '../src/main/runtime';
import { ClaudeConnection } from '../src/main/engines/claude/connection';

async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for fixture process');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test('CLI maintenance waits for real PTY cleanup and accepts Darwin EPERM for the now-empty owned group', { skip: process.platform === 'win32', timeout: 10000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccdesk-posix-stop-'));
  const store = new StateStore(path.join(root, 'data'));
  const id = randomUUID(), now = new Date().toISOString(), pidFile = path.join(root, 'pid');
  store.change(state => state.sessions.push({ id, projectId: randomUUID(), title: 'fixture', kind: 'shell',
    execution: { providerId: 'shell', mode: 'terminal' }, cwd: root, engineConfig: { schemaVersion: 1, options: {} },
    started: false, status: 'idle', archived: false, createdAt: now, updatedAt: now }));
  const errors: Error[] = [];
  const runtime = new Runtime(store, () => {}, () => {}, {
    async prepare() { return { file: process.execPath, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`], env: {} }; },
  }, { onError: error => errors.push(error) });
  let signal: ReturnType<typeof t.mock.method> | undefined;
  try {
    await runtime.start(id); await until(() => fs.existsSync(pidFile));
    const pid = Number(fs.readFileSync(pidFile, 'utf8')), kill = process.kill.bind(process);
    let groupErrors = 0;
    signal = t.mock.method(process, 'kill', (target: number, name?: NodeJS.Signals | number) => {
      if (target === -pid && name === 'SIGKILL') { groupErrors++; throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' }); }
      return kill(target, name);
    });
    runtime.setMaintenance(true);
    const stopped = runtime.disconnectAll();
    assert.equal(runtime.activeCount, 1, 'workspace ownership remains until cleanup finishes');
    await stopped;
    assert.equal(groupErrors, 1);
    assert.equal(runtime.activeCount, 0);
    assert.equal(runtime.pendingCleanupCount, 0);
    assert.equal(store.state.sessions[0].status, 'stopped');
    assert.deepEqual(errors, []);
  } finally {
    signal?.mock.restore();
    await runtime.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('structured shutdown also awaits verification of Darwin EPERM after its real child exits', { skip: process.platform === 'win32', timeout: 10000 }, async t => {
  let closed = false;
  const connection = new ClaudeConnection({ file: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] }, os.tmpdir(), {}, {
    frame() {}, error() {}, close() { closed = true; },
  });
  const pid = connection.child.pid!, kill = process.kill.bind(process);
  let groupErrors = 0;
  const signal = t.mock.method(process, 'kill', (target: number, name?: NodeJS.Signals | number) => {
    if (target === -pid && name === 'SIGKILL') { groupErrors++; throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' }); }
    return kill(target, name);
  });
  // The production timer is unref'ed; this fixture explicitly awaits it even once
  // the child's last stdio handle has closed.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    connection.terminate();
    assert.ok(connection.termination);
    assert.equal(await connection.termination, true);
    await until(() => closed);
    assert.equal(groupErrors, 1);
  } finally {
    clearInterval(keepAlive); signal.mock.restore();
    try { kill(pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  }
});

for (const outcome of ['exited', 'live', 'inspection_failed'] as const) {
  test(`PTY signal errors require fresh release proof: ${outcome}`, { skip: process.platform === 'win32', timeout: 10000 }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccdesk-posix-proof-'));
    const store = new StateStore(path.join(root, 'data'));
    const id = randomUUID(), now = new Date().toISOString(), ready = path.join(root, 'ready');
    store.change(state => state.sessions.push({ id, projectId: randomUUID(), title: 'proof fixture', kind: 'shell',
      execution: { providerId: 'shell', mode: 'terminal' }, cwd: root, engineConfig: { schemaVersion: 1, options: {} },
      started: false, status: 'idle', archived: false, createdAt: now, updatedAt: now }));
    const runtime = new Runtime(store, () => {}, () => {}, {
      async prepare() { return { file: process.execPath, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000);`], env: {} }; },
    });
    const kill = process.kill.bind(process);
    let pid: number | undefined;
    let signal: ReturnType<typeof t.mock.method> | undefined;
    let inspection: ReturnType<typeof t.mock.method> | undefined;
    try {
      await runtime.start(id); await until(() => fs.existsSync(ready));
      pid = Number(fs.readFileSync(ready, 'utf8'));
      const ownedPid = pid;
      const denied = Object.assign(new Error('fixture signal denied'), { code: 'EPERM' });
      signal = t.mock.method(process, 'kill', (target: number, name?: NodeJS.Signals | number) => {
        if ((target === ownedPid || target === -ownedPid) && (name === 'SIGTERM' || name === 'SIGKILL')) {
          if (outcome !== 'live') { try { kill(target, name); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } }
          throw denied;
        }
        return kill(target, name);
      });
      if (outcome === 'inspection_failed') {
        inspection = t.mock.method(runtime as unknown as { posixTreeHasLiveMembers(): Promise<boolean> }, 'posixTreeHasLiveMembers', async () => {
          throw Object.assign(new Error('fixture inspection denied'), { code: 'EACCES' });
        });
      }
      runtime.stop(id);
      if (outcome === 'exited') {
        await runtime.whenReleased(id);
        assert.equal(runtime.activeCount, 0);
        assert.equal(runtime.pendingCleanupCount, 0);
        assert.equal(runtime.lastError, undefined);
      } else {
        await assert.rejects(runtime.whenReleased(id), /清理失败|资源已释放/);
        assert.ok(runtime.lastError instanceof AggregateError);
        assert.ok(runtime.lastError.errors.includes(denied), 'retain the original signal error with the failed inspection');
        assert.equal(runtime.lastError.errors[1].cleanupPhase, 'posix.release_inspection');
        if (outcome === 'inspection_failed') assert.equal(runtime.lastError.errors[1].code, 'EACCES');
        await assert.rejects(runtime.whenReleased(id), /清理失败|资源已释放/, 'failed proof must continue blocking workspace release');
      }
    } finally {
      signal?.mock.restore(); inspection?.mock.restore();
      if (pid) { try { kill(pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } }
      if (runtime.lastError) await assert.rejects(runtime.shutdown()); else await runtime.shutdown();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test('POSIX release inspection rejects malformed snapshots and treats unknown states as live', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccdesk-posix-snapshot-'));
  const runtime = new Runtime(new StateStore(root), () => {}, () => {}, { async prepare() { throw new Error('Unused launcher'); } });
  const inspect = (runtime as unknown as { posixSnapshotHasLiveMembers(output: string, ids: ReadonlySet<number>, group: number): boolean }).posixSnapshotHasLiveMembers.bind(runtime);
  try {
    for (const invalid of ['', 'not a snapshot', '42 42', '42 42 S extra', '-42 42 S', '9007199254740992 42 S', '42 42 Z\ncorrupt']) {
      assert.throws(() => inspect(invalid, new Set([42]), 42), /无法解析/);
    }
    assert.equal(inspect('42 42 ?\n99 99 S', new Set([42]), 42), true);
    assert.equal(inspect('42 42 Z\n43 42 X\n99 99 S', new Set([42]), 42), false);
    assert.equal(inspect('43 42 S\n99 99 S', new Set([42]), 42), true);
    assert.equal(inspect('42 99 S\n99 99 S', new Set([42]), 42), true);
  } finally { await runtime.shutdown(); fs.rmSync(root, { recursive: true, force: true }); }
});
