import type { ChatSnapshotVersion } from '../shared/chat';

export interface PendingChatAction {
  token: number;
  kind: string;
  target?: string;
  accepted: boolean;
  baseline?: string;
  synchronized?: boolean;
  synchronizing?: boolean;
  synchronizedVersion?: ChatSnapshotVersion;
}

/** 操作跨快照刷新及面板挂载保留；IPC 确认与权威状态确认分别处理。 */
export class ChatActionState {
  private actions = new Map<string, PendingChatAction>();
  private listeners = new Set<() => void>();
  private sequence = 0;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = (key: string): PendingChatAction | undefined => this.actions.get(key);
  private changed() { for (const listener of this.listeners) listener(); }
  begin(key: string, kind: string, target?: string, baseline?: string): PendingChatAction | undefined {
    if (this.actions.has(key)) return;
    const value: PendingChatAction = { token: ++this.sequence, kind, accepted: false, ...(target === undefined ? {} : { target }), ...(baseline === undefined ? {} : { baseline }) };
    this.actions.set(key, value); this.changed(); return value;
  }
  accepted(key: string, token: number) {
    const current = this.actions.get(key);
    if (!current || current.token !== token || current.accepted) return;
    this.actions.set(key, { ...current, accepted: true }); this.changed();
  }
  beginSync(key: string, token: number): boolean {
    const current = this.actions.get(key);
    if (!current?.accepted || current.token !== token || current.synchronizing) return false;
    this.actions.set(key, { ...current, synchronizing: true }); this.changed(); return true;
  }
  synchronized(key: string, token: number, version?: ChatSnapshotVersion) {
    const current = this.actions.get(key);
    if (!current || current.token !== token) return;
    this.actions.set(key, { ...current, synchronizing: false, synchronized: true, synchronizedVersion: version }); this.changed();
  }
  syncFailed(key: string, token: number) {
    const current = this.actions.get(key);
    if (!current || current.token !== token) return;
    this.actions.set(key, { ...current, synchronizing: false }); this.changed();
  }
  clear(key: string, token: number) {
    if (this.actions.get(key)?.token !== token) return;
    this.actions.delete(key); this.changed();
  }
}

export const chatActionState = new ChatActionState();

export function chatActionHasFreshSnapshot(action: PendingChatAction, version?: ChatSnapshotVersion): boolean {
  if (!action.accepted || !action.synchronized) return false;
  const floor = action.synchronizedVersion;
  return !floor || !!version && floor.hostEpoch === version.hostEpoch && version.revision >= floor.revision && version.eventSequence >= floor.eventSequence;
}
