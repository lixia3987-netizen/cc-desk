import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { createConnection, createServer, Socket } from 'node:net';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { IPty } from 'node-pty';
import { releaseWindowsPty } from '../src/main/execution/windows-pty-resources';
import { spawnTerminal, assertPatchedWindowsPty } from '../src/main/execution/spawn-terminal';

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
  let confirmNativeClose!: () => void;
  const terminal = Object.assign(Object.create(WindowsTerminal.prototype), {
    _isReady: false, _deferreds: [{ run: () => { staleWrites++; } }], _socket: sockets.output,
    _agent: {
      kill: () => { nativeKills++; },
      _pty: 1, _useConptyDll: false, _exitCode: undefined as number | undefined,
      _ptyNative: { ccDeskConptyFix: 1, kill: () => { nativeKills++; } },
      _inSocket: sockets.input, _outSocket: sockets.output,
      _conoutSocketWorker: { _worker: worker, dispose: () => { disposalStarted = true; void worker.terminate(); } },
    },
  });
  confirmNativeClose = () => { terminal._agent._exitCode = 0; };
  try {
    terminal.kill();
    assert.equal(nativeKills, 0, 'node-pty queues kill before its first output');
    const release = releaseWindowsPty(terminal);
    assert.equal(nativeKills, 1); assert.equal(disposalStarted, false);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.notEqual(worker.threadId, -1, 'native close still needs the independent output consumer');
    assert.equal(disposalStarted, false, 'a requested close is not a completed close');
    confirmNativeClose();
    await release;
    assert.equal(worker.threadId, -1, 'release proves the forwarding thread actually exited');
    assert.equal(sockets.input.closed, true); assert.equal(sockets.output.closed, true);
    assert.equal(staleWrites, 0); assert.equal(terminal._deferreds.length, 0);
  } finally { await worker.terminate(); await sockets.close(); }
});

test('Windows cleanup retains the draining worker when native close cannot be confirmed', async () => {
  const worker = new Worker('setInterval(() => {}, 1000)', { eval: true });
  const terminal = Object.assign(Object.create(WindowsTerminal.prototype), {
    _isReady: true, _deferreds: [], _socket: { readable: true },
    _agent: {
      kill: () => { throw new Error('Native close failed'); },
      _pty: 1, _useConptyDll: false,
      _ptyNative: { ccDeskConptyFix: 1, kill: () => { throw new Error('Native close failed'); } },
      _inSocket: new Socket(), _outSocket: new Socket(),
      _conoutSocketWorker: { _worker: worker, dispose: () => { void worker.terminate(); } },
    },
  });
  try {
    await assert.rejects(releaseWindowsPty(terminal), /Native close failed/);
    assert.notEqual(worker.threadId, -1, 'uncertain native cleanup cannot stop its required drain worker');
  } finally { terminal._agent._inSocket.destroy(); terminal._agent._outSocket.destroy(); await worker.terminate(); }
});

test('Windows cleanup fails explicitly for unknown internals or a worker that does not stop', async () => {
  await assert.rejects(releaseWindowsPty({ kill: () => {} } as IPty), /node-pty 兼容性/);
  const worker = new Worker('setInterval(() => {}, 1000)', { eval: true });
  const terminal = Object.assign(Object.create(WindowsTerminal.prototype), {
    _isReady: false, _deferreds: [], _socket: { readable: true },
    _agent: { kill: () => {}, _pty: 1, _useConptyDll: false, _exitCode: 0,
      _ptyNative: { ccDeskConptyFix: 1, kill: () => {} }, _inSocket: new Socket(), _outSocket: new Socket(),
      _conoutSocketWorker: { _worker: worker, dispose: () => {} } },
  });
  try { await assert.rejects(releaseWindowsPty(terminal, 30), /转发资源释放超时/); }
  finally { await worker.terminate(); }
});

test('Windows terminal startup rejects an unpatched native module', () => {
  assert.throws(() => assertPatchedWindowsPty({}), /终端组件未正确安装/);
  assert.throws(() => assertPatchedWindowsPty({ ccDeskConptyFix: '1' }), /终端组件未正确安装/);
  assert.doesNotThrow(() => assertPatchedWindowsPty({ ccDeskConptyFix: 1 }));
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

test('Windows native PTY closes concurrent consoles and failed spawns before the owner exits',
  { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccdesk-pty-native-'));
    const fixture = path.join(root, 'owner.mjs');
    const spawnModule = new URL('../src/main/execution/spawn-terminal.ts', import.meta.url).href;
    const resourcesModule = new URL('../src/main/execution/windows-pty-resources.ts', import.meta.url).href;
    const script = `
      import fs from 'node:fs'; import path from 'node:path'; import assert from 'node:assert/strict';
      import { createRequire } from 'node:module';
      const require = createRequire(${JSON.stringify(import.meta.url)});
      const { loadNativeModule } = require('node-pty/lib/utils');
      const native = loadNativeModule('conpty').module;
      const { spawnTerminal } = await import(${JSON.stringify(spawnModule)}).then(m => m.default ?? m);
      const { releaseWindowsPty } = await import(${JSON.stringify(resourcesModule)}).then(m => m.default ?? m);
      const root = ${JSON.stringify(root)};
      assert.equal(native.ccDeskConptyFix, 1);
      const empty = () => assert.deepEqual(native.ccDeskConptyStats(), { livePseudoconsoles: 0, indexedPseudoconsoles: 0 });
      const until = async check => {
        const deadline = Date.now() + 10000;
        while (!check()) { assert.ok(Date.now() < deadline, 'fixture ready timed out'); await new Promise(r => setTimeout(r, 10)); }
      };
      empty();
      // Multiple exit watchers overlap with each other and with resize/kill. This
      // exercised node-pty 1.1.0's unsynchronized global baton vector.
      for (let round = 0; round < 3; round++) {
        const gate = path.join(root, 'exit-' + round);
        const terminals = [];
        const failures = [];
        try {
          for (let index = 0; index < 4; index++) {
            const ready = path.join(root, 'ready-' + round + '-' + index);
            const program = 'const fs=require("node:fs");fs.writeFileSync(' + JSON.stringify(ready) + ',"ready");' +
              'setInterval(()=>{if(fs.existsSync(' + JSON.stringify(gate) + ')){process.stdout.write("x".repeat(65536),()=>process.exit(0));}},10);';
            const terminal = spawnTerminal({ file: process.execPath, args: ['-e', program], env: process.env }, root);
            terminal.onData(() => {});
            const exit = new Promise(resolve => terminal.onExit(event => resolve(event.exitCode)));
            terminals.push({ terminal, exit, ready });
          }
          await until(() => terminals.every(item => fs.existsSync(item.ready)));
          for (const { terminal } of terminals) terminal.resize(120, 40);
          // Native kill is a per-instance close request; repeating it cannot
          // close a recycled Windows HANDLE or dispose an active drain worker.
          const last = terminals[3].terminal;
          native.kill(last._agent._pty, false); native.kill(last._agent._pty, false);
          fs.writeFileSync(gate, 'exit');
          const codes = await Promise.all(terminals.map(item => item.exit));
          assert.deepEqual(codes.slice(0, 3), [0, 0, 0], 'pipe EOF must wait for the native exit code');
          empty(); // onExit proves actual native close, before JS forwarding disposal.
          await Promise.all(terminals.map(item => releaseWindowsPty(item.terminal)));
          for (const { terminal } of terminals) native.kill(terminal._agent._pty, false);
          empty();
        } catch (error) { failures.push(error); }
        finally {
          const cleanup = await Promise.allSettled(terminals.map(item => releaseWindowsPty(item.terminal)));
          for (const result of cleanup) if (result.status === 'rejected') failures.push(result.reason);
        }
        if (failures.length) throw new AggregateError(failures, 'PTY round failed: ' + round);
      }
      // This reaches CreateProcessW after HPCON, pipes and forwarding worker
      // exist, unlike a missing executable rejected before allocation.
      for (let index = 0; index < 3; index++) {
        assert.throws(() => spawnTerminal({ file: process.execPath, args: ['-e', ''], env: process.env }, path.join(root, 'missing-cwd')));
        empty();
      }
      console.log('native PTY owner released');
    `;
    try {
      fs.writeFileSync(fixture, script);
      const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', fixture], {
        cwd: fileURLToPath(new URL('../', import.meta.url)), timeout: 50000, windowsHide: true, maxBuffer: 256 * 1024,
      }).catch(error => {
        assert.fail(`Native PTY owner failed (${error.code ?? error.signal ?? 'unknown'}).\n${error.stdout ?? ''}\n${error.stderr ?? ''}`);
      });
      assert.match(result.stdout, /native PTY owner released/);
    } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  });
