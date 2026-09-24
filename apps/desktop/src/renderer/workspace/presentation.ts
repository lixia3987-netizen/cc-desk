import { hasActiveSubtasks, isSessionBusy, isTaskBusy } from '../../shared/session-activity';
import type { Session } from '../../shared/types';
import { taskLabels } from '../ChatPane';

const statusLabels = { idle: '待启动', running: '运行中', stopping: '停止中', stopped: '已停止', error: '需处理' };

export function sessionLabel(session: Session): string {
  if (session.status === 'stopping') return '停止中';
  if (session.status === 'running' && hasActiveSubtasks(session) && !isTaskBusy(session.taskState)) return '子任务执行中';
  const taskLabel = taskLabels[session.taskState ?? 'idle'];
  if (session.execution.mode === 'structured') return taskLabel ?? statusLabels[session.status];
  if (session.kind === 'agent' && session.status === 'running') {
    return session.terminalSync === 'synced' ? taskLabel ?? '进程已连接' : '进程已连接 · 状态待同步';
  }
  return statusLabels[session.status];
}

export function sessionColor(session: Session): string {
  if (session.status === 'stopping') return 'stopping';
  if (isSessionBusy(session)) return 'running';
  if (session.taskState === 'error') return 'error';
  return session.status === 'running' ? 'idle' : session.status;
}

export const time = (date: string) => new Date(date).toLocaleString('zh-CN', {
  month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
});
