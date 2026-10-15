import type { IPty } from 'node-pty';
import type { Worker } from 'node:worker_threads';
import type { Socket } from 'node:net';

interface WindowsTerminalResources {
  _isReady: boolean;
  _deferreds: unknown[];
  _agent: {
    _pty: number; _useConptyDll: boolean; _exitCode?: number; readonly _created?: string;
    _ptyNative: { ccDeskConptyFix: number; kill(pty: number, useConptyDll: boolean): void };
    _inSocket: Socket; _outSocket: Socket; _conoutSocketWorker: { _worker: Worker; dispose(): void };
  };
}

/** 从 CreateProcessW 原始且仍持有的 HANDLE 捕获进程创建身份。 */
export function windowsPtyCreationIdentity(terminal: IPty): string {
  const created = (terminal as unknown as WindowsTerminalResources)._agent?._created;
  if (typeof created !== 'string' || !/^\d{20}$/.test(created)) throw new Error('无法确认 Windows PTY 原始进程身份。');
  return created;
}

async function nativeClosed(agent: WindowsTerminalResources['_agent'], timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  // 修复后的原生监视器仅在 HPCON、进程 HANDLE
  // 及关闭事件 HANDLE 都关闭后才发布此回调。仅套接字关闭
  // 不足以证明释放，不能据此停止独立的输出排空工作线程。
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
    // 在释放已结束的对端时，管道仍可能报告 EPIPE。
    // 关闭确认才能证明所有权已结束，最终 I/O 结果不能证明。
    const failed = (error: Error) => { ioError = error; };
    const timer = setTimeout(() => finish(new Error('等待 Windows PTY 管道关闭超时。', { cause: ioError })), timeoutMs);
    socket.once('close', closed); socket.on('error', failed);
  });
}

/**
 * node-pty 1.1.0 会把 Windows kill() 延迟到首次输出时执行，即使进程
 * 已经退出。因此，无输出的进程会遗留活跃的 ConPTY 转发工作线程。
 * 修复后的原生监视器在退出回调前关闭 HPCON。持续排空到
 * 该回调，再确认转发工作线程和两个套接字均已关闭。
 */
export async function releaseWindowsPty(terminal: IPty, timeoutMs = 3000): Promise<void> {
  const internal = terminal as unknown as WindowsTerminalResources;
  const agent = internal._agent;
  const connection = internal._agent?._conoutSocketWorker;
  const worker = connection?._worker;
  const input = internal._agent?._inSocket, output = internal._agent?._outSocket;
  if (typeof internal._isReady !== 'boolean' || !Array.isArray(internal._deferreds) ||
    agent?._ptyNative?.ccDeskConptyFix !== 2 || typeof agent._ptyNative.kill !== 'function' ||
    !Number.isSafeInteger(agent._pty) || typeof agent._useConptyDll !== 'boolean' ||
    typeof connection?.dispose !== 'function' || !worker || typeof worker.threadId !== 'number' ||
    typeof worker.once !== 'function' || typeof worker.removeListener !== 'function' || typeof worker.terminate !== 'function' ||
    ![input, output].every(socket => socket && typeof socket.closed === 'boolean' && typeof socket.destroy === 'function' &&
      typeof socket.once === 'function' && typeof socket.on === 'function' && typeof socket.removeListener === 'function')) {
    throw new Error('无法确认 Windows PTY 资源结构，请检查 node-pty 兼容性。');
  }

  // 公开的 kill() 还会启动仅按 PID 查询控制台列表的辅助进程，并在
  // 原生关闭完成前释放工作线程。进程树释放已由
  // Runtime 负责；只请求此原生实例关闭，且仅请求一次。
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
      // 原生关闭已返回；现在可安全停止转发工作线程。
      void worker.terminate().catch(() => {});
      finish(new Error('等待 Windows PTY 转发资源释放超时。'));
    }, timeoutMs);
    worker.once('exit', exited); worker.once('error', failed);
  });
  const inputClosed = socketClosed(input, timeoutMs), outputClosed = socketClosed(output, timeoutMs);

  let failure: unknown;
  // node-pty 默认路径从不主动销毁这个只写管道。
  try { input.destroy(); } catch (error) { failure ??= error; }
  // dispose() 在默认 ConPTY 路径中具有幂等性，并在退出前排空。
  // 上方已确认原生关闭；若关闭失败，必须保留此排空器。
  try { connection.dispose(); } catch (error) { failure ??= error; }
  // 先让工作线程排空，再关闭本方输出端点。即使工作线程
  // 失败也应关闭端点，避免一次清理失败遗留独立句柄。
  const drained = stopped.finally(() => { output.destroy(); });
  const results = await Promise.allSettled([drained, inputClosed, outputClosed]);
  for (const result of results) if (result.status === 'rejected') failure ??= result.reason;
  if (failure) throw failure;
}
