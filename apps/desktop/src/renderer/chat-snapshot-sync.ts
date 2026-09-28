import type { ChatSnapshot, ChatSnapshotVersion } from '../shared/chat';

export interface ChatSyncState { loading: boolean; failures: number; error?: string }

/** Full snapshots are authoritative; notifications only invalidate them. */
export class ChatSnapshotSync {
  private current?: ChatSnapshot;
  private expected?: ChatSnapshotVersion;
  private expectedFromEvent = false;
  private retiredEpochs = new Set<string>();
  private inFlight?: Promise<void>;
  private requested = false;
  private disposed = false;
  private deferred?: ReturnType<typeof setTimeout>;
  private failures = 0;
  private lastError?: string;
  constructor(private sessionId: string, private ports: {
    read(): Promise<ChatSnapshot>;
    apply(snapshot: ChatSnapshot): void;
    state(state: ChatSyncState): void;
  }) {}
  get snapshot(): ChatSnapshot | undefined { return this.current; }
  get error(): string | undefined { return this.lastError; }
  get canAutoRefresh(): boolean { return !this.disposed && this.failures < 2; }
  /** Duplicate/late events do not fetch; gaps require a full snapshot as usual. */
  notify(version?: ChatSnapshotVersion): boolean {
    if (this.disposed) return false;
    if (version) {
      if (this.retiredEpochs.has(version.hostEpoch)) return false;
      const prior = this.expected ?? this.current?.version;
      if (prior?.hostEpoch === version.hostEpoch && version.revision <= prior.revision) return false;
      if (prior && prior.hostEpoch !== version.hostEpoch) this.retiredEpochs.add(prior.hostEpoch);
      this.expected = version;
      this.expectedFromEvent = true;
    }
    if (this.inFlight) this.requested = true;
    return true;
  }
  private accept(snapshot: ChatSnapshot): boolean {
    if (snapshot.sessionId !== this.sessionId) throw new Error('读取到其他会话的状态，已拒绝更新。');
    const version = snapshot.version, old = this.current?.version, expected = this.expected;
    if (version) {
      if (this.retiredEpochs.has(version.hostEpoch)) return false;
      if (expected?.hostEpoch === version.hostEpoch && (version.revision < expected.revision || version.eventSequence < expected.eventSequence)) return false;
      if (expected && expected.hostEpoch !== version.hostEpoch && this.expectedFromEvent) return false;
      if (old?.hostEpoch === version.hostEpoch && (version.revision < old.revision || version.eventSequence < old.eventSequence)) return false;
      if (old?.hostEpoch === version.hostEpoch && old.conversationId === version.conversationId
        && old.workerGeneration !== undefined && version.workerGeneration !== undefined && version.workerGeneration < old.workerGeneration) return false;
      if (old && old.hostEpoch !== version.hostEpoch) this.retiredEpochs.add(old.hostEpoch);
      this.expected = version;
      this.expectedFromEvent = false;
    } else if (old || expected) return false; // Once versioned, never regress to unversioned state.
    this.current = snapshot;
    this.ports.apply(snapshot);
    return true;
  }
  refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.inFlight) { this.requested = true; return this.inFlight; }
    clearTimeout(this.deferred); this.deferred = undefined;
    const operation = this.readCurrent();
    this.inFlight = operation;
    void operation.finally(() => {
      if (this.inFlight !== operation) return;
      this.inFlight = undefined;
      // Yield between batches so a streaming producer cannot monopolize IPC.
      if (this.requested && !this.disposed && this.failures < 2) this.deferred = setTimeout(() => { void this.refresh(); }, 80);
    });
    return operation;
  }
  private async readCurrent(): Promise<void> {
    this.ports.state({ loading: true, failures: this.failures, ...(this.lastError ? { error: this.lastError } : {}) });
    for (let attempt = 0; attempt < 2 && !this.disposed; attempt++) {
      this.requested = false;
      try {
        const value = await this.ports.read();
        if (this.disposed) return;
        if (!this.accept(value)) {
          this.requested = true;
          if (attempt === 1) throw new Error('会话状态仍在变化，请重试同步。');
          continue;
        }
        this.failures = 0;
        this.lastError = undefined;
        this.ports.state({ loading: false, failures: 0 });
      } catch (error) {
        if (this.disposed) return;
        this.failures++;
        this.lastError = error instanceof Error ? error.message : String(error);
        this.requested = false;
        this.ports.state({ loading: false, failures: this.failures, error: this.lastError });
        return;
      }
      if (!this.requested) return;
    }
  }
  dispose(): void { this.disposed = true; this.requested = false; clearTimeout(this.deferred); }
}
