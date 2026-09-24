import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import type { IPty } from 'node-pty';
import { releaseWindowsPty } from '../src/main/execution/windows-pty-resources';

const require = createRequire(import.meta.url);
// Exercise the installed Windows implementation without loading its native agent.
const { WindowsTerminal } = require('node-pty/lib/windowsTerminal');

test('silent Windows terminal cleanup bypasses the real first-output gate and awaits worker exit', async () => {
  const worker = new Worker('setInterval(() => {}, 1000)', { eval: true });
  let nativeKills = 0, staleWrites = 0, disposalStarted = false;
  const terminal = Object.assign(Object.create(WindowsTerminal.prototype), {
    _isReady: false, _deferreds: [{ run: () => { staleWrites++; } }], _socket: { readable: true },
    _agent: {
      kill: () => { nativeKills++; },
      _conoutSocketWorker: { _worker: worker, dispose: () => { disposalStarted = true; void worker.terminate(); } },
    },
  });
  try {
    terminal.kill();
    assert.equal(nativeKills, 0, 'node-pty queues kill before its first output');
    const release = releaseWindowsPty(terminal);
    assert.equal(nativeKills, 1); assert.equal(disposalStarted, true);
    await release;
    assert.equal(worker.threadId, -1, 'release proves the forwarding thread actually exited');
    assert.equal(staleWrites, 0); assert.equal(terminal._deferreds.length, 0);
  } finally { await worker.terminate(); }
});

test('Windows cleanup reports native failure after still releasing the worker', async () => {
  const worker = new Worker('setInterval(() => {}, 1000)', { eval: true });
  const terminal = Object.assign(Object.create(WindowsTerminal.prototype), {
    _isReady: true, _deferreds: [], _socket: { readable: true },
    _agent: {
      kill: () => { throw new Error('Native close failed'); },
      _conoutSocketWorker: { _worker: worker, dispose: () => { void worker.terminate(); } },
    },
  });
  try {
    await assert.rejects(releaseWindowsPty(terminal), /Native close failed/);
    assert.equal(worker.threadId, -1);
  } finally { await worker.terminate(); }
});

test('Windows cleanup fails explicitly for unknown internals or a worker that does not stop', async () => {
  await assert.rejects(releaseWindowsPty({ kill: () => {} } as IPty), /node-pty 兼容性/);
  const worker = new Worker('setInterval(() => {}, 1000)', { eval: true });
  const terminal = Object.assign(Object.create(WindowsTerminal.prototype), {
    _isReady: false, _deferreds: [], _socket: { readable: true },
    _agent: { kill: () => {}, _conoutSocketWorker: { _worker: worker, dispose: () => {} } },
  });
  try { await assert.rejects(releaseWindowsPty(terminal, 30), /转发资源释放超时/); }
  finally { await worker.terminate(); }
});
