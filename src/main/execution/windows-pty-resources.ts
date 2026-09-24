import type { IPty } from 'node-pty';
import type { Worker } from 'node:worker_threads';

interface WindowsTerminalResources {
  _isReady: boolean;
  _deferreds: unknown[];
  _agent: { _conoutSocketWorker: { _worker: Worker; dispose(): void } };
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
  if (typeof internal._isReady !== 'boolean' || !Array.isArray(internal._deferreds) ||
    typeof connection?.dispose !== 'function' || !worker || typeof worker.threadId !== 'number' ||
    typeof worker.once !== 'function' || typeof worker.removeListener !== 'function' || typeof worker.terminate !== 'function') {
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

  // Queued writes/resizes belong to the expired launch and must never be replayed.
  internal._deferreds.length = 0;
  internal._isReady = true;
  let failure: unknown;
  try { terminal.kill(); } catch (error) { failure = error; }
  // dispose() is idempotent for the default ConPTY path and drains before exit.
  // Also run it when native close throws; taskkill may already have killed the root.
  try { connection.dispose(); } catch (error) { failure ??= error; }
  await stopped;
  if (failure) throw failure;
}
