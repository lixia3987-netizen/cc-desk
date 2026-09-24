import type { IPty } from 'node-pty';
import type { Worker } from 'node:worker_threads';
import type { Socket } from 'node:net';

interface WindowsTerminalResources {
  _isReady: boolean;
  _deferreds: unknown[];
  _agent: { _inSocket: Socket; _outSocket: Socket; _conoutSocketWorker: { _worker: Worker; dispose(): void } };
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
 * Keep the pinned-version compatibility boundary here rather than fabricating
 * terminal output or changing the dependency. Call only while releasing a PTY.
 */
export async function releaseWindowsPty(terminal: IPty, timeoutMs = 3000): Promise<void> {
  const internal = terminal as unknown as WindowsTerminalResources;
  const connection = internal._agent?._conoutSocketWorker;
  const worker = connection?._worker;
  const input = internal._agent?._inSocket, output = internal._agent?._outSocket;
  if (typeof internal._isReady !== 'boolean' || !Array.isArray(internal._deferreds) ||
    typeof connection?.dispose !== 'function' || !worker || typeof worker.threadId !== 'number' ||
    typeof worker.once !== 'function' || typeof worker.removeListener !== 'function' || typeof worker.terminate !== 'function' ||
    ![input, output].every(socket => socket && typeof socket.closed === 'boolean' && typeof socket.destroy === 'function' &&
      typeof socket.once === 'function' && typeof socket.on === 'function' && typeof socket.removeListener === 'function')) {
    throw new Error('无法确认 Windows PTY 资源结构，请检查 node-pty 兼容性。');
  }

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

  // Queued writes/resizes belong to the expired launch and must never be replayed.
  internal._deferreds.length = 0;
  internal._isReady = true;
  let failure: unknown;
  try { terminal.kill(); } catch (error) { failure = error; }
  // The default node-pty path never destroys this write-only pipe itself.
  try { input.destroy(); } catch (error) { failure ??= error; }
  // dispose() is idempotent for the default ConPTY path and drains before exit.
  // Also run it when native close throws; taskkill may already have killed the root.
  try { connection.dispose(); } catch (error) { failure ??= error; }
  // Let the worker drain before closing our output endpoint. Still close it when
  // the worker failed, so one cleanup failure cannot strand independent handles.
  const drained = stopped.finally(() => { output.destroy(); });
  const results = await Promise.allSettled([drained, inputClosed, outputClosed]);
  for (const result of results) if (result.status === 'rejected') failure ??= result.reason;
  if (failure) throw failure;
}
