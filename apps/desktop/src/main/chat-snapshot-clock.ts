import { randomUUID } from 'node:crypto';
import type { ChatSnapshot, ChatSnapshotVersion } from '../shared/chat';

/** 由单一宿主权威统一管理队列和会话通知，包括 Claude 和离线历史。 */
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
    // 读取操作也分配顺序号：状态恢复与依据失效处理可能
    // 在未收到实时进程通知时发现更新的持久化数据。
    const version: ChatSnapshotVersion = { hostEpoch: this.hostEpoch, ...this.next(snapshot.sessionId, false),
      ...(conversationId ? { conversationId } : {}),
      ...(snapshot.nativeRun ? { conversationId: snapshot.nativeRun.conversationId, runId: snapshot.nativeRun.runId, workerGeneration: snapshot.nativeRun.workerGeneration } : {}) };
    return { ...snapshot, version };
  }
}
