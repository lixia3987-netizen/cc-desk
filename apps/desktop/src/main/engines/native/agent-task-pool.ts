export type NativeAgentTaskPoolCloseReason = 'cancelled' | 'unsafe';

export class NativeAgentTaskPoolClosedError extends Error {
  constructor(readonly reason: NativeAgentTaskPoolCloseReason) {
    super(reason === 'unsafe' ? '子任务池因未确认的执行或清理而停止。' : '子任务池已取消。');
    this.name = 'NativeAgentTaskPoolClosedError';
  }
}

export interface NativeAgentTaskSlot { release(): void }
export interface NativeAgentTaskPool {
  readonly capacity: number;
  /** 关闭即取消所有已领取者的准备/运行信号；许可仍须由领取者结算后释放。 */
  readonly signal: AbortSignal;
  /** FIFO；容量包含领取后准备、执行及持久化结算的整个区间。 */
  acquire(signal?: AbortSignal): Promise<NativeAgentTaskSlot>;
  close(reason?: NativeAgentTaskPoolCloseReason): void;
  drain(): Promise<void>;
}

interface Waiter {
  resolve(slot: NativeAgentTaskSlot): void;
  reject(error: NativeAgentTaskPoolClosedError): void;
  signal?: AbortSignal;
  abort?: () => void;
}

/** 父运行内共享；它只调度许可，绝不把物理 worker 的取消视为已经释放。 */
export function createNativeAgentTaskPool(options: { capacity: number; signal?: AbortSignal }): NativeAgentTaskPool {
  if (!Number.isInteger(options.capacity) || options.capacity < 1 || options.capacity > 30) throw new Error('无效的子任务并发容量。');
  const lifecycle = new AbortController();
  let active = 0, closed: NativeAgentTaskPoolCloseReason | undefined;
  const queue: Waiter[] = [], drains = new Set<() => void>();
  const detach = (waiter: Waiter) => { if (waiter.abort) waiter.signal!.removeEventListener('abort', waiter.abort); };
  const pump = () => {
    while (!closed && active < options.capacity && queue.length) {
      const waiter = queue.shift()!; detach(waiter);
      if (waiter.signal?.aborted) { waiter.reject(new NativeAgentTaskPoolClosedError('cancelled')); continue; }
      active++;
      let released = false;
      waiter.resolve({ release() {
        if (released) return;
        released = true; active--;
        pump();
      } });
    }
    if (!active && !queue.length) { for (const resolve of drains) resolve(); drains.clear(); }
  };
  const close = (reason: NativeAgentTaskPoolCloseReason = 'cancelled') => {
    if (closed) return;
    closed = reason;
    options.signal?.removeEventListener('abort', abort);
    lifecycle.abort(new NativeAgentTaskPoolClosedError(reason));
    for (const waiter of queue.splice(0)) { detach(waiter); waiter.reject(new NativeAgentTaskPoolClosedError(reason)); }
    pump();
  };
  const abort = () => close('cancelled');
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) close('cancelled');
  return {
    capacity: options.capacity,
    signal: lifecycle.signal,
    acquire(signal) {
      if (closed || signal?.aborted) return Promise.reject(new NativeAgentTaskPoolClosedError(closed ?? 'cancelled'));
      return new Promise<NativeAgentTaskSlot>((resolve, reject) => {
        const waiter: Waiter = { resolve, reject, signal };
        if (signal) {
          waiter.abort = () => {
            const index = queue.indexOf(waiter);
            if (index === -1) return;
            queue.splice(index, 1); detach(waiter);
            reject(new NativeAgentTaskPoolClosedError(closed ?? 'cancelled')); pump();
          };
          signal.addEventListener('abort', waiter.abort, { once: true });
        }
        queue.push(waiter); pump();
      });
    },
    close,
    drain() { return !active && !queue.length ? Promise.resolve() : new Promise<void>(resolve => drains.add(resolve)); },
  };
}
