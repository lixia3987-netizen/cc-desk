import { randomUUID } from 'node:crypto';
import type { ChatSnapshot, ChatSnapshotVersion } from '../shared/chat';

/** One host authority for queue and conversation notifications, including Claude/offline history. */
export class ChatSnapshotClock {
  private versions = new Map<string, { revision: number; eventSequence: number }>();
  constructor(readonly hostEpoch: string = randomUUID()) {}
  private next(id: string, event: boolean) {
    const prior = this.versions.get(id) ?? { revision: 0, eventSequence: 0 };
    const next = { revision: prior.revision + 1, eventSequence: prior.eventSequence + Number(event) };
    this.versions.set(id, next);
    return next;
  }
  changed(id: string, conversationId?: string): ChatSnapshotVersion {
    return { hostEpoch: this.hostEpoch, ...this.next(id, true), ...(conversationId ? { conversationId } : {}) };
  }
  snapshot(snapshot: ChatSnapshot, conversationId?: string): ChatSnapshot {
    // Reads also get an ordering number: hydration and evidence invalidation can
    // discover newer durable data without receiving a live process notification.
    const version: ChatSnapshotVersion = { hostEpoch: this.hostEpoch, ...this.next(snapshot.sessionId, false),
      ...(conversationId ? { conversationId } : {}),
      ...(snapshot.nativeRun ? { conversationId: snapshot.nativeRun.conversationId, runId: snapshot.nativeRun.runId, workerGeneration: snapshot.nativeRun.workerGeneration } : {}) };
    return { ...snapshot, version };
  }
}
