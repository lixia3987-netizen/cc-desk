import { hasActiveSubtasks, isTaskBusy } from '../shared/session-activity';
import type { Session } from '../shared/types';
import { paintActionFeedback } from './action-feedback';

export interface PendingActionState { key: string; label: string }

/** 锁在通知界面前同步生效；提交和必要同步完成前不允许第二次操作。 */
export class PendingAction {
  state: PendingActionState | undefined;
  async run(state: PendingActionState, action: () => Promise<unknown> | void,
    changed: (state: PendingActionState | undefined) => void, beforeAction: () => Promise<void> = paintActionFeedback): Promise<boolean> {
    if (this.state) return false;
    const current = { ...state }; this.state = current; changed(current);
    try { await beforeAction(); await action(); return true; }
    finally { if (this.state === current) { this.state = undefined; changed(undefined); } }
  }
}

/** Ctrl-C 只提交中断请求；保留连接的 CLI 必须明确报告任务终态才能再次中断。 */
export function terminalInterruptSettled(session: Pick<Session, 'status' | 'taskState' | 'subtasks'> | undefined): boolean {
  return !session || ['idle', 'stopped', 'error'].includes(session.status) ||
    session.status === 'running' && session.taskState !== undefined && !isTaskBusy(session.taskState) && !hasActiveSubtasks(session);
}
