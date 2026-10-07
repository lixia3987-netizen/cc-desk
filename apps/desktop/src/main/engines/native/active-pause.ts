export interface NativeActivePauseSource {
  readonly paused: boolean;
  subscribe(listener: (paused: boolean) => void): () => void;
}

/** Overlapping visible approvals pause the shared active clock once. */
export class NativeActivePause implements NativeActivePauseSource {
  private count = 0;
  private listeners = new Set<(paused: boolean) => void>();
  get paused(): boolean { return this.count > 0; }
  subscribe(listener: (paused: boolean) => void): () => void {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }
  private changed(): void {
    for (const listener of this.listeners) {
      try { listener(this.paused); } catch { /* A failed observer must not leave the approval clock stuck. */ }
    }
  }
  pause(): () => void {
    this.count++; if (this.count === 1) this.changed();
    let released = false;
    return () => { if (released) return; released = true; this.count--; if (!this.count) this.changed(); };
  }
}

/** Worker-local elapsed clock; wall time remains available for approval expiry. */
export class NativeActiveClock {
  private pausedAt: number | undefined;
  private pausedMs = 0;
  private listeners = new Set<() => void>();
  constructor(private readonly wallNow: () => number = () => Date.now()) {}
  get paused(): boolean { return this.pausedAt !== undefined; }
  now(): number {
    const wall = this.wallNow();
    return wall - this.pausedMs - (this.pausedAt === undefined ? 0 : Math.max(0, wall - this.pausedAt));
  }
  setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    const wall = this.wallNow();
    if (paused) this.pausedAt = wall;
    else { this.pausedMs += Math.max(0, wall - this.pausedAt!); this.pausedAt = undefined; }
    for (const listener of this.listeners) listener();
  }
  deadline(milliseconds: number, parent: AbortSignal): { signal: AbortSignal; dispose(): void } {
    const controller = new AbortController(), expiresAt = this.now() + milliseconds;
    let timer: ReturnType<typeof setTimeout> | undefined, disposed = false;
    const clear = () => { clearTimeout(timer); timer = undefined; };
    const arm = () => {
      clear();
      if (disposed || controller.signal.aborted || this.paused) return;
      timer = setTimeout(() => {
        timer = undefined;
        if (disposed || controller.signal.aborted || this.paused) return;
        if (this.now() < expiresAt) arm();
        else controller.abort(new Error('Native deadline exceeded.'));
      }, Math.max(1, expiresAt - this.now()));
    };
    const cancel = () => { clear(); controller.abort(parent.reason); };
    this.listeners.add(arm); parent.addEventListener('abort', cancel, { once: true });
    if (parent.aborted) cancel(); else arm();
    return { signal: controller.signal, dispose: () => {
      if (disposed) return; disposed = true; clear(); this.listeners.delete(arm); parent.removeEventListener('abort', cancel);
    } };
  }
}
