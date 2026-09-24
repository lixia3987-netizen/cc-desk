import type { ExecutionEvent } from '../../shared/execution-events';
import { getSessionIdentity, type SessionIdentity } from '../../shared/execution';
import type { Session } from '../../shared/types';

/** Normalized events are the boundary between executors and application/IPC consumers. */
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
      catch (error) { try { this.onError?.(error); } catch { /* Observers cannot interrupt execution or resource cleanup. */ } }
    }
  }
}

/** Snapshots are copied: /clear must not mutate the previous identity in an event. */
export class ExecutionStatePublisher {
  private previous = new Map<string, { identity: SessionIdentity; signature: string }>();
  constructor(private events: ExecutionEvents) {}
  publish(sessions: Session[]) {
    const ids = new Set(sessions.map(session => session.id));
    for (const id of this.previous.keys()) if (!ids.has(id)) this.previous.delete(id);
    for (const session of sessions) {
      const identity = getSessionIdentity(session);
      const previous = this.previous.get(session.id);
      // Large user drafts are unrelated to executor state and have their own IPC.
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
