import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { createConnection, createServer, Socket } from 'node:net';
import { once } from 'node:events';
import type { IPty } from 'node-pty';
import { releaseWindowsPty } from '../src/main/execution/windows-pty-resources';
import { spawnTerminal } from '../src/main/execution/spawn-terminal';

const require = createRequire(import.meta.url);
// Exercise the installed Windows implementation without loading its native agent.
const { WindowsTerminal } = require('node-pty/lib/windowsTerminal');

async function connectedSockets() {
  const peers: Socket[] = [];
  const server = createServer(socket => { peers.push(socket); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const input = createConnection(address.port, '127.0.0.1'); await once(input, 'connect');
  const output = createConnection(address.port, '127.0.0.1'); await once(output, 'connect');
  return { input, output, close: async () => {
    for (const socket of [input, output, ...peers]) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } };
}

test('silent Windows terminal cleanup bypasses the real first-output gate and awaits worker exit', async () => {
  const worker = new Worker('setInterval(() => {}, 1000)', { eval: true });
  const sockets = await connectedSockets();
  let nativeKills = 0, staleWrites = 0, disposalStarted = false;
  const terminal = Object.assign(Object.create(WindowsTerminal.prototype), {
    _isReady: false, _deferreds: [{ run: () => { staleWrites++; } }], _socket: sockets.output,
    _agent: {
      kill: () => { nativeKills++; },
      _inSocket: sockets.input, _outSocket: sockets.output,
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
    assert.equal(sockets.input.closed, true); assert.equal(sockets.output.closed, true);
    assert.equal(staleWrites, 0); assert.equal(terminal._deferreds.length, 0);
  } finally { await worker.terminate(); await sockets.close(); }
});

test('Windows cleanup reports native failure after still releasing the worker', async () => {
  const worker = new Worker('setInterval(() => {}, 1000)', { eval: true });
  const terminal = Object.assign(Object.create(WindowsTerminal.prototype), {
    _isReady: true, _deferreds: [], _socket: { readable: true },
    _agent: {
      kill: () => { throw new Error('Native close failed'); },
      _inSocket: new Socket(), _outSocket: new Socket(),
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
    _agent: { kill: () => {}, _inSocket: new Socket(), _outSocket: new Socket(),
      _conoutSocketWorker: { _worker: worker, dispose: () => {} } },
  });
  try { await assert.rejects(releaseWindowsPty(terminal, 30), /转发资源释放超时/); }
  finally { await worker.terminate(); }
});

test('Windows rejects an empty provider environment before native allocation without inheriting variables', () => {
  let allocations = 0, observedEnvironment: unknown;
  const spawn: Parameters<typeof spawnTerminal>[3] = (_file, _args, options) => {
    allocations++; observedEnvironment = options?.env; return {} as IPty;
  };
  const launch = { file: 'fixture.exe', args: [], env: {} };
  assert.throws(() => spawnTerminal(launch, '.', 'win32', spawn), /启动环境不能为空/);
  assert.equal(allocations, 0, 'invalid options cannot allocate a pipe or worker');
  const explicit = { FIXTURE_ONLY: '1' };
  spawnTerminal({ ...launch, env: explicit }, '.', 'win32', spawn);
  assert.equal(allocations, 1); assert.equal(observedEnvironment, explicit);
  spawnTerminal(launch, '.', 'linux', spawn);
  assert.equal(allocations, 2); assert.equal(observedEnvironment, launch.env);
});
