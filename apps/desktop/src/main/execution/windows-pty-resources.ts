import type { IPty } from 'node-pty';
import type { Worker } from 'node:worker_threads';
import type { Socket } from 'node:net';

interface WindowsTerminalResources {
  _isReady: boolean;
  _deferreds: unknown[];
  _agent: {
    _pty: number; _useConptyDll: boolean; _exitCode?: number;
    _ptyNative: { ccDeskConptyFix: number; kill(pty: number, useConptyDll: boolean): void };
    _inSocket: Socket; _outSocket: Socket; _conoutSocketWorker: { _worker: Worker; dispose(): void };
  };
}

async function nativeClosed(agent: WindowsTerminalResources['_agent'], timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  // The fixed native watcher publishes this callback only after HPCON, its
  // process HANDLE and close-event HANDLE are closed. Socket close alone is not
  // that evidence and must not stop the independent output-draining worker.
  while (agent._exitCode === undefined) {
    if (Date.now() >= deadline) throw new Error('等待 Windows PTY 原生资源释放超时。');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function socketClosed(socket: Socket, timeoutMs: number): Promise<void> {
  if (socket.closed) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let ioError: Error | undefined;
    const finish = (error?: Error) => {
      clearTimeout(timer); socket.removeListener('close', closed); socket.removeListener('error', failed);
      if (error) reject(error); else resolve();
    };
    const closed = () => finish();
    // A pipe can report EPIPE while its already-terminated peer is being released.
    // Confirming close, rather than the final I/O result, proves ownership ended.
    const failed = (error: Error) => { ioError = error; };
    const timer = setTimeout(() => finish(new Error('等待 Windows PTY 管道关闭超时。', { cause: ioError })), timeoutMs);
    socket.once('close', closed); socket.on('error', failed);
  });
}

/**
 * node-pty 1.1.0 defers Windows kill() until the first output, even after process
 * exit. A silent process therefore leaves its ConPTY forwarding worker alive.
 * The fixed native watcher closes HPCON before its exit callback. Keep draining
 * until that callback, then prove the forwarding worker and both sockets closed.
 */
export async function releaseWindowsPty(terminal: IPty, timeoutMs = 3000): Promise<void> {
  const internal = terminal as unknown as WindowsTerminalResources;
  const agent = internal._agent;
  const connection = internal._agent?._conoutSocketWorker;
  const worker = connection?._worker;
  const input = internal._agent?._inSocket, output = internal._agent?._outSocket;
  if (typeof internal._isReady !== 'boolean' || !Array.isArray(internal._deferreds) ||
    agent?._ptyNative?.ccDeskConptyFix !== 1 || typeof agent._ptyNative.kill !== 'function' ||
    !Number.isSafeInteger(agent._pty) || typeof agent._useConptyDll !== 'boolean' ||
    typeof connection?.dispose !== 'function' || !worker || typeof worker.threadId !== 'number' ||
    typeof worker.once !== 'function' || typeof worker.removeListener !== 'function' || typeof worker.terminate !== 'function' ||
    ![input, output].every(socket => socket && typeof socket.closed === 'boolean' && typeof socket.destroy === 'function' &&
      typeof socket.once === 'function' && typeof socket.on === 'function' && typeof socket.removeListener === 'function')) {
    throw new Error('无法确认 Windows PTY 资源结构，请检查 node-pty 兼容性。');
  }

  // Public kill() also starts a bare-PID console-list helper and disposes the
  // worker before native close is complete. Process-tree release is already
  // owned by Runtime; request only this native instance's close, exactly once.
  internal._deferreds.length = 0;
  internal._isReady = true;
  agent._ptyNative.kill(agent._pty, agent._useConptyDll);
  await nativeClosed(agent, timeoutMs);

  const stopped = worker.threadId === -1 ? Promise.resolve() : new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      worker.removeListener('exit', exited); worker.removeListener('error', failed);
      if (error) reject(error); else resolve();
    };
    const exited = () => finish();
    const failed = (error: Error) => finish(error);
    const timer = setTimeout(() => {
      // Native close has returned; the forwarding worker is now safe to stop.
      void worker.terminate().catch(() => {});
      finish(new Error('等待 Windows PTY 转发资源释放超时。'));
    }, timeoutMs);
    worker.once('exit', exited); worker.once('error', failed);
  });
  const inputClosed = socketClosed(input, timeoutMs), outputClosed = socketClosed(output, timeoutMs);

  let failure: unknown;
  // The default node-pty path never destroys this write-only pipe itself.
  try { input.destroy(); } catch (error) { failure ??= error; }
  // dispose() is idempotent for the default ConPTY path and drains before exit.
  // Native close is confirmed above; failure there must retain this drainer.
  try { connection.dispose(); } catch (error) { failure ??= error; }
  // Let the worker drain before closing our output endpoint. Still close it when
  // the worker failed, so one cleanup failure cannot strand independent handles.
  const drained = stopped.finally(() => { output.destroy(); });
  const results = await Promise.allSettled([drained, inputClosed, outputClosed]);
  for (const result of results) if (result.status === 'rejected') failure ??= result.reason;
  if (failure) throw failure;
}
