import type { RunIdentity } from '@cc-desk/agent-core';
import { sameRun } from './worker-protocol';

/** One host-owned gate covers the parent, its summaries, and every registered child worker. */
export class NativeAggregateBudget {
  private counts = { modelRequests: 0, toolCalls: 0 };
  private owners = new Map<string, RunIdentity>();
  constructor(private limits: { maxModelRequests: number; maxToolCalls: number },
    private signal: AbortSignal, readonly remainingMs: () => number,
    initial: { modelRequests: number; toolCalls: number } = { modelRequests: 0, toolCalls: 0 }) {
    this.counts = { ...initial };
  }
  register(identity: RunIdentity): () => void {
    const key = identity.runId;
    if (this.owners.has(key)) throw new Error('共享预算执行身份重复。');
    this.owners.set(key, { ...identity });
    return () => { this.owners.delete(key); };
  }
  async consume(kind: 'model' | 'tool', identity: RunIdentity): Promise<boolean> {
    const owner = this.owners.get(identity.runId);
    if (!owner || !sameRun(owner, identity)) throw new Error('共享预算执行身份已失效。');
    if (this.signal.aborted || this.remainingMs() <= 0) return false;
    const field = kind === 'model' ? 'modelRequests' : 'toolCalls';
    const ceiling = kind === 'model' ? this.limits.maxModelRequests : this.limits.maxToolCalls;
    if (this.counts[field] >= ceiling) return false;
    // No await between checking and reserving: concurrent child RPCs cannot overspend.
    this.counts[field]++;
    return true;
  }
  snapshot() { return { ...this.counts }; }
}
