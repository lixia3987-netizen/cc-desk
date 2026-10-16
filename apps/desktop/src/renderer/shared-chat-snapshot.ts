import type { ChatSnapshot, ChatSnapshotVersion, TaskState } from '../shared/chat';
import { ChatSnapshotSync, type ChatSnapshotSyncPorts, type ChatSyncState } from './chat-snapshot-sync';
import { sessionReadLifecycle, type SessionReadLifecycle } from './session-read-lifecycle';

export interface SharedChatSnapshotView {
  /** 仅包含本次 acquire 后读取并应用的权威状态；缓存另由 peek 提供。 */
  snapshot?: ChatSnapshot;
  state: ChatSyncState;
  canAutoRefresh: boolean;
}
export interface SharedChatSnapshotScope { id: string; conversationId?: string }
export interface SharedChatSnapshotPorts {
  read(id: string): Promise<ChatSnapshot>;
  onChat(listener: (id: string, state?: TaskState, version?: ChatSnapshotVersion) => void): () => void;
  lifecycle: Pick<SessionReadLifecycle, 'read' | 'subscribe'>;
  schedule(callback: () => void, milliseconds: number): unknown;
  cancel(timer: unknown): void;
  estimateBytes(snapshot: ChatSnapshot): number;
}
export interface SharedChatSnapshotLimits { maxCachedSessions?: number; maxCachedBytes?: number }
interface Entry {
  id: string; conversationId?: string; active: number; generation: number;
  acquired: boolean;
  listeners: Set<() => void>; view: SharedChatSnapshotView; sync: ChatSnapshotSync;
  cached?: ChatSnapshot; cachedBytes: number; used: number;
  operation?: Promise<void>; timer?: unknown; initialTimer?: unknown; needsFresh: boolean; offLifecycle?: () => void;
}
const emptyState: ChatSyncState = Object.freeze({ loading: false, failures: 0 });
const empty: SharedChatSnapshotView = Object.freeze({ state: emptyState, canAutoRefresh: true });

/** 保守估计保留对象的大小，避免序列化/编码完整快照；仅在转为闲置缓存时计算。 */
function estimateBytes(snapshot: ChatSnapshot): number {
  const pending: unknown[] = [snapshot], seen = new Set<object>();
  let bytes = 0;
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === 'string') bytes += value.length * 2 + 16;
    else if (value && typeof value === 'object' && !seen.has(value)) {
      seen.add(value); bytes += 64;
      for (const [key, field] of Object.entries(value)) { bytes += key.length * 2 + 8; pending.push(field); }
    } else bytes += 8;
  }
  return bytes;
}

/** 多个面板共享一个会话读取器；完整快照和版本屏障仍由 ChatSnapshotSync 管理。 */
export class SharedChatSnapshots {
  private readonly entries = new Map<string, Entry>();
  private readonly ports: SharedChatSnapshotPorts;
  private readonly maxCachedSessions: number;
  private readonly maxCachedBytes: number;
  private retained?: Map<string, string | undefined>;
  private offChat?: () => void;
  private clock = 0;

  constructor(ports: Partial<SharedChatSnapshotPorts> = {}, limits: SharedChatSnapshotLimits = {}) {
    this.ports = {
      read: id => window.desktop.chatSnapshot(id),
      onChat: listener => window.desktop.onChat(listener),
      lifecycle: sessionReadLifecycle,
      schedule: (callback, milliseconds) => setTimeout(callback, milliseconds),
      cancel: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
      estimateBytes,
      ...ports,
    };
    this.maxCachedSessions = Math.max(0, limits.maxCachedSessions ?? 8);
    this.maxCachedBytes = Math.max(0, limits.maxCachedBytes ?? 16 * 1024 * 1024);
  }

  get(id: string): SharedChatSnapshotView { return this.entries.get(id)?.view ?? empty; }

  /** 仅供旧内容展示，不应由此启用审批、恢复或其他依赖实时状态的操作。 */
  peek(id: string): ChatSnapshot | undefined {
    const entry = this.entries.get(id);
    if (entry) entry.used = ++this.clock;
    return entry?.cached;
  }

  subscribe(id: string, listener: () => void): () => void {
    if (!this.allowed(id)) return () => {};
    const entry = this.entry(id);
    entry.listeners.add(listener);
    return () => {
      entry.listeners.delete(listener);
      if (!entry.active && !entry.acquired && !entry.listeners.size) this.remove(entry);
    };
  }

  acquire(id: string, conversationId?: string): () => void {
    if (!this.allowed(id)) return () => {};
    const entry = this.entry(id);
    if (conversationId !== undefined && entry.conversationId !== undefined && entry.conversationId !== conversationId) this.reset(entry, conversationId);
    else if (conversationId !== undefined) entry.conversationId = conversationId;
    const first = entry.active++ === 0;
    entry.acquired = true;
    if (first) {
      entry.generation++; entry.cachedBytes = 0; entry.used = ++this.clock; entry.needsFresh = true;
      entry.offLifecycle = this.ports.lifecycle.subscribe(id, () => { if (entry.active) void this.refreshFresh(id).catch(() => {}); });
      this.listen();
      // 先让只读首屏完成绘制；消费者也可以在绘制后显式 refresh 提前同步。
      entry.initialTimer = this.ports.schedule(() => {
        entry.initialTimer = undefined;
        if (entry.active && this.entries.get(id) === entry) void this.refreshFresh(id).catch(() => {});
      }, 200);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.entries.get(id) !== entry || !entry.active) return;
      if (--entry.active) return;
      entry.generation++;
      this.clearTimer(entry); this.clearInitialTimer(entry); entry.offLifecycle?.(); entry.offLifecycle = undefined;
      // 旧 IPC 可能挂起；下一次激活不能排在它后面，但仍须继承版本/代次屏障。
      const previous = entry.sync;
      previous.dispose(); this.createSync(entry, previous); entry.operation = undefined;
      entry.cachedBytes = entry.cached ? this.ports.estimateBytes(entry.cached) : 0;
      this.publish(entry, empty);
      this.stopListening(); this.evict();
    };
  }

  refresh(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry?.active) return Promise.resolve();
    this.clearInitialTimer(entry);
    if (entry.needsFresh) {
      void this.refreshFresh(id).catch(() => {});
      return entry.operation!;
    }
    // 不重复调用 Sync.refresh，避免无变化的多个消费者额外申请一次重读。
    if (entry.operation) return entry.operation;
    return this.track(entry, entry.sync.refresh());
  }

  refreshFresh(id: string): Promise<ChatSnapshot | undefined> {
    const entry = this.entries.get(id);
    if (!entry?.active) return Promise.resolve(undefined);
    this.clearInitialTimer(entry); entry.needsFresh = false;
    const generation = entry.generation, sync = entry.sync;
    const current = () => this.entries.get(id) === entry && !!entry.active && entry.generation === generation && entry.sync === sync;
    const confirmation = sync.refreshFresh().then(value => current() ? value : undefined, error => {
      if (current()) throw error;
      return undefined;
    });
    // 每次 fresh 都保留自己的后调用屏障；普通 refresh 可以合并进其当前批次。
    this.track(entry, confirmation.then(() => {}, () => {}));
    return confirmation;
  }

  retain(scopes: readonly SharedChatSnapshotScope[]): void {
    this.retained = new Map(scopes.map(scope => [scope.id, scope.conversationId]));
    for (const entry of this.entries.values()) {
      if (!this.retained.has(entry.id)) { this.remove(entry); continue; }
      const conversationId = this.retained.get(entry.id);
      // retain 来自工作区的完整事实，缺少上下文同样是一次明确的代次变化。
      // acquire(undefined) 仍只表示调用者尚不知道上下文，不采用此规则。
      if (conversationId !== entry.conversationId) this.reset(entry, conversationId);
    }
    this.stopListening(); this.evict();
  }

  private allowed(id: string): boolean { return !this.retained || this.retained.has(id); }

  private entry(id: string): Entry {
    let entry = this.entries.get(id);
    if (!entry) {
      entry = { id, conversationId: this.retained?.get(id), active: 0, acquired: false, generation: 0, listeners: new Set(), view: empty,
        cachedBytes: 0, used: ++this.clock, needsFresh: true, sync: undefined as unknown as ChatSnapshotSync };
      this.entries.set(id, entry); this.createSync(entry);
    }
    return entry;
  }

  private createSync(entry: Entry, previous?: ChatSnapshotSync): void {
    const ports: ChatSnapshotSyncPorts = {
      read: async () => {
        if (!entry.active || this.entries.get(entry.id) !== entry || entry.sync !== sync) return undefined;
        const generation = entry.generation;
        let value: ChatSnapshot | undefined;
        try { value = await this.ports.lifecycle.read(entry.id, () => this.ports.read(entry.id)); }
        catch (error) {
          if (!entry.active || entry.generation !== generation || this.entries.get(entry.id) !== entry || entry.sync !== sync) return undefined;
          throw error;
        }
        if (!entry.active || entry.generation !== generation || this.entries.get(entry.id) !== entry || entry.sync !== sync) return undefined;
        if (value?.version?.conversationId && entry.conversationId !== undefined && value.version.conversationId !== entry.conversationId) {
          throw new Error('会话上下文已变化，请重新同步当前上下文。');
        }
        return value;
      },
      apply: snapshot => {
        if (!entry.active || this.entries.get(entry.id) !== entry || entry.sync !== sync) return;
        this.clearTimer(entry);
        entry.cached = snapshot; entry.used = ++this.clock;
        this.publish(entry, { ...entry.view, snapshot });
      },
      state: state => {
        if (!entry.active || this.entries.get(entry.id) !== entry || entry.sync !== sync) return;
        this.publish(entry, { ...entry.view, state, canAutoRefresh: sync.canAutoRefresh });
      },
    };
    const sync = previous ? previous.fork(ports) : new ChatSnapshotSync(entry.id, ports);
    entry.sync = sync;
  }

  private reset(entry: Entry, conversationId?: string): void {
    entry.generation++; entry.sync.dispose(); this.clearTimer(entry); this.clearInitialTimer(entry); entry.operation = undefined;
    entry.cached = undefined; entry.cachedBytes = 0; entry.conversationId = conversationId;
    this.createSync(entry); this.publish(entry, empty);
    if (entry.active) void this.refreshFresh(entry.id).catch(() => {});
  }

  private track(entry: Entry, operation: Promise<void>): Promise<void> {
    entry.operation = operation;
    const complete = () => { if (entry.operation === operation) entry.operation = undefined; };
    void operation.then(complete, complete);
    return operation;
  }

  private listen(): void {
    if (this.offChat) return;
    this.offChat = this.ports.onChat((id, _state, version) => {
      const entry = this.entries.get(id);
      if (!entry?.active || !entry.sync.notify(version) || !entry.sync.canAutoRefresh || entry.timer !== undefined || entry.initialTimer !== undefined) return;
      entry.timer = this.ports.schedule(() => {
        entry.timer = undefined;
        if (entry.active && this.entries.get(id) === entry && entry.sync.canAutoRefresh) void this.refresh(id);
      }, 80);
    });
  }

  private clearTimer(entry: Entry): void {
    if (entry.timer !== undefined) this.ports.cancel(entry.timer);
    entry.timer = undefined;
  }

  private clearInitialTimer(entry: Entry): void {
    if (entry.initialTimer !== undefined) this.ports.cancel(entry.initialTimer);
    entry.initialTimer = undefined;
  }

  private stopListening(): void {
    if (this.offChat && ![...this.entries.values()].some(entry => entry.active)) { this.offChat(); this.offChat = undefined; }
  }

  private publish(entry: Entry, view: SharedChatSnapshotView): void {
    const before = entry.view;
    if (before.snapshot === view.snapshot && before.canAutoRefresh === view.canAutoRefresh
      && before.state.loading === view.state.loading && before.state.failures === view.state.failures && before.state.error === view.state.error) return;
    entry.view = view;
    for (const listener of entry.listeners) listener();
  }

  private remove(entry: Entry): void {
    if (this.entries.get(entry.id) !== entry) return;
    entry.generation++; entry.active = 0; entry.sync.dispose(); this.clearTimer(entry); this.clearInitialTimer(entry);
    entry.offLifecycle?.(); entry.offLifecycle = undefined;
    this.entries.delete(entry.id); entry.cached = undefined;
    this.publish(entry, empty);
  }

  private evict(): void {
    for (const entry of this.entries.values()) if (!entry.active && !entry.acquired && !entry.listeners.size) this.remove(entry);
    // 尚未取得首个快照也可能已观察到代次屏障，元数据同样纳入有界闲置 LRU。
    const cached = [...this.entries.values()].filter(entry => !entry.active && entry.acquired).sort((left, right) => left.used - right.used);
    let bytes = cached.reduce((total, entry) => total + entry.cachedBytes, 0);
    while (cached.length > this.maxCachedSessions || bytes > this.maxCachedBytes) {
      const entry = cached.shift()!; bytes -= entry.cachedBytes; this.remove(entry);
    }
  }
}

export const sharedChatSnapshots = new SharedChatSnapshots();
