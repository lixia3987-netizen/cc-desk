import type { RunIdentity } from '@cc-desk/agent-core';
import type { NativeDelegationBudget } from './agent-delegation';
import { NativeActiveClock, NativeActivePause } from './active-pause';
import { NativeAggregateBudget } from './aggregate-budget';

/** 每次子任务尝试独占计数与时钟；一个子任务的审批不会暂停其他任务。 */
export function createNativeChildBudget(identity: RunIdentity,
  limits: { maxModelRequests: number; maxToolCalls: number; maxActiveMs: number }, signal: AbortSignal,
  now: () => number = () => performance.now()): NativeDelegationBudget {
  const activePause = new NativeActivePause(), clock = new NativeActiveClock(now), startedAt = clock.now();
  activePause.subscribe(paused => clock.setPaused(paused));
  const remainingMs = () => Math.max(0, limits.maxActiveMs - (clock.now() - startedAt));
  const budget = new NativeAggregateBudget(limits, signal, remainingMs);
  budget.register(identity);
  return { consume: (kind, run) => budget.consume(kind, run), remainingMs, snapshot: () => budget.snapshot(),
    activePause, pause: () => activePause.pause() };
}
