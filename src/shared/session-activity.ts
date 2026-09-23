import type { TaskState } from './chat';
import { isSubtaskActive } from './subtasks';
import type { Session } from './types';

export function isTaskBusy(state?: TaskState): boolean {
  return state !== undefined && ['starting', 'thinking', 'tool_running', 'waiting_approval', 'waiting_input'].includes(state);
}

export function hasActiveSubtasks(session: Pick<Session, 'subtasks'>): boolean {
  return session.subtasks?.tasks.some(task => isSubtaskActive(task.status)) ?? false;
}

/** A connected CLI may be waiting for the next turn; process lifetime is not task lifetime. */
export function isSessionBusy(session: Pick<Session, 'kind' | 'adapter' | 'status' | 'taskState' | 'terminalSync' | 'subtasks'>): boolean {
  if (session.status === 'stopping') return true;
  if (session.status !== 'running') return isTaskBusy(session.taskState);
  if (session.kind === 'shell') return true;
  if (session.adapter !== 'structured' && session.terminalSync !== 'synced') return true;
  return isTaskBusy(session.taskState) || hasActiveSubtasks(session);
}
