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
    execution: { providerId: 'shell', mode: 'terminal' }, cwd: root, model: '', effort: 'default', permissionMode: 'default',
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
