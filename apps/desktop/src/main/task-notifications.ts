import type { SessionIdentity } from '../shared/execution';
import type { TaskState } from '../shared/chat';

/** 恢复历史只建立通知基线；完成通知还须等待宿主释放本轮执行。 */
export class TaskNotifications {
  private states = new Map<string, { conversationId?: string; state: TaskState }>();

  observe(identity: SessionIdentity, state: TaskState, busy: boolean): boolean {
    // 旧回执重放和工作进程结束都可能先于宿主清理。不能消费真正结束时的通知。
    if (state === 'completed' && busy) return false;
    const previous = this.states.get(identity.sessionId);
    const old = previous?.conversationId === identity.conversationId ? previous?.state : undefined;
    this.states.set(identity.sessionId, { conversationId: identity.conversationId, state });
    return old !== state && ['waiting_approval', 'waiting_input', 'completed', 'error'].includes(state)
      && (state !== 'completed' || old !== undefined);
  }
}
