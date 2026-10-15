import type { TaskState } from './chat';
import { isSubtaskActive } from './subtasks';
import type { Session } from './types';

export function isTaskBusy(state?: TaskState): boolean {
  return state !== undefined && ['starting', 'thinking', 'tool_running', 'waiting_approval', 'waiting_input'].includes(state);
}

export function hasActiveSubtasks(session: Pick<Session, 'subtasks'>): boolean {
  return session.subtasks?.tasks.some(task => isSubtaskActive(task.status)) ?? false;
}

/** 已连接的 CLI 可能正在等待下一轮输入，进程生命周期不等于任务生命周期。 */
export function isSessionBusy(session: Pick<Session, 'kind' | 'execution' | 'status' | 'taskState' | 'terminalSync' | 'subtasks'>): boolean {
  if (session.status === 'stopping') return true;
  if (session.status !== 'running') return isTaskBusy(session.taskState);
  if (session.kind === 'shell') return true;
  if (session.execution.mode !== 'structured' && session.terminalSync !== 'synced') return true;
  return isTaskBusy(session.taskState) || hasActiveSubtasks(session);
}
