import type { ExecutionEvent } from '../../shared/execution-events';
import { getSessionIdentity, type SessionIdentity } from '../../shared/execution';
import type { Session } from '../../shared/types';

/** 规范化事件构成执行器与应用及 IPC 消费方之间的边界。 */
export class ExecutionEvents {
  private listeners = new Set<(event: ExecutionEvent) => void>();
  constructor(private onError?: (error: unknown) => void) {}
  subscribe(listener: (event: ExecutionEvent) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  emit(event: ExecutionEvent) {
    for (const listener of this.listeners) {
      try { listener(event); }
      catch (error) { try { this.onError?.(error); } catch { /* 观察者不能中断执行或资源清理。 */ } }
    }
  }
}

/** 快照使用副本：/clear 不能修改事件中的上一身份。 */
export class ExecutionStatePublisher {
  private previous = new Map<string, { identity: SessionIdentity; signature: string }>();
  constructor(private events: ExecutionEvents) {}
  publish(sessions: Session[]) {
    const ids = new Set(sessions.map(session => session.id));
    for (const id of this.previous.keys()) if (!ids.has(id)) this.previous.delete(id);
    for (const session of sessions) {
      const identity = getSessionIdentity(session);
      const previous = this.previous.get(session.id);
      // 大型用户草稿与执行器状态无关，并使用独立 IPC。
      const { draft: _draft, panelDrafts: _panelDrafts, ...metadata } = session;
      const signature = JSON.stringify(metadata);
      this.previous.set(session.id, { identity: { ...identity }, signature });
      if (previous && JSON.stringify(previous.identity) !== JSON.stringify(identity)) {
        this.events.emit({ type: 'identity.changed', identity, previous: { ...previous.identity } });
      }
      if (previous?.signature !== signature) {
        this.events.emit({ type: 'session.changed', identity, status: session.status, taskState: session.taskState });
      }
    }
  }
}
