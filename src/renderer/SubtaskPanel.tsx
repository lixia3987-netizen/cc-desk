import { useEffect, useId, useMemo, useState } from 'react';
import { Bot, CheckCircle2, ChevronDown, ChevronRight, CircleDashed, CircleHelp, CirclePause, CircleStop, Clock3, Layers, Loader2, MessageCircleQuestion, ShieldCheck, TerminalSquare, XCircle } from 'lucide-react';
import type { Session } from '../shared/types';
import { isSubtaskActive, subtaskCounts, type Subtask, type SubtaskStatus } from '../shared/subtasks';

const labels: Record<SubtaskStatus, string> = {
  pending: '待执行', running: '运行中', paused: '已暂停', waiting_approval: '等待审批', waiting_input: '等待回答',
  completed: '已完成', failed: '失败', stopped: '已停止', interrupted: '已中断', unknown: '状态未知',
};
const icons = {
  pending: CircleDashed, running: Loader2, paused: CirclePause, waiting_approval: ShieldCheck,
  waiting_input: MessageCircleQuestion, completed: CheckCircle2, failed: XCircle, stopped: CircleStop,
  interrupted: CircleStop, unknown: CircleHelp,
};

function elapsed(task: Subtask, now: number) {
  const start = Date.parse(task.startedAt), end = task.endedAt ? Date.parse(task.endedAt) : isSubtaskActive(task.status) ? now : Date.parse(task.updatedAt);
  const value = task.durationMs ?? end - start;
  if (!Number.isFinite(value) || value < 0) return '';
  const seconds = Math.floor(value / 1000);
  return seconds < 60 ? `${seconds} 秒` : seconds < 3600 ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : `${Math.floor(seconds / 3600)} 小时 ${Math.floor(seconds / 60) % 60} 分`;
}

function SubtaskRow({ task, now, earlier }: { task: Subtask; now: number; earlier: boolean }) {
  const Icon = icons[task.status], KindIcon = task.kind === 'agent' ? Bot : task.kind === 'shell' ? TerminalSquare : Layers;
  const metrics = [
    task.toolUses !== undefined ? `${task.toolUses.toLocaleString()} 次工具调用` : '',
    task.totalTokens !== undefined ? `CLI 报告 ${task.totalTokens.toLocaleString()} tokens` : '',
  ].filter(Boolean);
  const active = isSubtaskActive(task.status), duration = elapsed(task, now);
  const progress = active ? task.progress || (task.lastTool ? `工具：${task.lastTool}` : '') : task.summary || (task.lastTool ? `最近工具：${task.lastTool}` : '');
  return <details className={'subtask-row ' + task.status} data-subtask-id={task.id} data-subtask-status={task.status}>
    <summary>
      <Icon size={14} className={'subtask-status-icon ' + (task.status === 'running' ? 'spin' : '')} aria-hidden="true"/>
      <span className="subtask-row-heading"><strong>{task.description || '未命名子任务'}</strong>{progress && <small title={progress}>{progress}</small>}</span>
      <span className="subtask-row-state">{labels[task.status]}</span><ChevronRight size={13} className="subtask-row-chevron" aria-hidden="true"/>
    </summary>
    <div className="subtask-detail">
      <div className="subtask-detail-meta"><span><KindIcon size={12} aria-hidden="true"/>{task.kind === 'agent' ? '子代理' : task.kind === 'shell' ? '后台命令' : '子任务'}</span>{task.background && <span>后台执行</span>}{earlier && <span>较早轮次</span>}{duration && <span><Clock3 size={12} aria-hidden="true"/>{duration}</span>}</div>
      <p className="subtask-description">{task.description || '未提供任务说明。'}</p>
      {task.progress && <p className="subtask-progress">{!active && '最后进度：'}{task.progress}</p>}
      {task.lastTool && <p className="subtask-last-tool">最近工具：{task.lastTool}</p>}
      {metrics.length > 0 && <p className="subtask-metrics">{metrics.join(' · ')}</p>}
      {task.summary && <div className="subtask-result"><strong>{task.status === 'failed' ? '失败信息' : '任务摘要'}</strong><p>{task.summary}</p></div>}
      {task.status === 'unknown' && <p className="subtask-note">没有收到明确的完成事件，无法确认执行结果。</p>}
      {task.status === 'interrupted' && <p className="subtask-note">执行已中断；此状态不表示任务已完成。</p>}
    </div>
  </details>;
}

/** A session-local activity view shared by structured chat and the native CLI terminal. */
export function SubtaskPanel({ session }: { session: Session }) {
  const [expanded, setExpanded] = useState(false), [all, setAll] = useState(false), [now, setNow] = useState(Date.now);
  const listId = useId(), activity = session.subtasks;
  const tasks = activity?.tasks ?? [];
  const current = useMemo(() => tasks.filter(task => task.turnId === activity?.turnId || isSubtaskActive(task.status)), [tasks, activity?.turnId]);
  const visible = all ? tasks : current;
  const counts = subtaskCounts(visible), hasHistory = current.length < tasks.length;
  const active = tasks.some(task => isSubtaskActive(task.status));
  const busy = ['starting', 'thinking', 'tool_running', 'waiting_approval', 'waiting_input'].includes(session.taskState ?? '');
  const unsupported = session.adapter !== 'structured' && session.terminalSync === 'unsupported';
  useEffect(() => {
    if (!expanded || !active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [expanded, active]);
  const ordered = useMemo(() => [...visible].sort((left, right) => Number(isSubtaskActive(right.status)) - Number(isSubtaskActive(left.status))), [visible]);

  if (!tasks.length) {
    if (!busy && !(unsupported && session.status === 'running')) return null;
    return <div className="subtask-empty" role="status"><Layers size={13} aria-hidden="true"/>{unsupported ? '当前 CLI 未提供子任务状态，请查看终端。' : '尚未收到子任务事件'}</div>;
  }
  return <section className="subtask-panel" aria-label="子任务状态">
    <button type="button" className="subtask-toggle" aria-label={expanded ? '收起子任务' : '展开子任务'} aria-expanded={expanded} aria-controls={listId} onClick={() => setExpanded(value => !value)}>
      <Layers size={14} aria-hidden="true"/>
      <span className="subtask-scope">{all ? '全部子任务' : '当前轮子任务'}</span>
      <span className="subtask-counts" role="status" aria-live="polite" aria-atomic="true" title={activity?.truncated ? '历史可能不完整，统计仅包含已保留的子任务。' : undefined}>
        {counts.total ? <><span>{activity?.truncated ? '已记录' : '共'} <strong>{counts.total}</strong></span><span className={counts.active ? 'subtask-active-count' : ''}>进行中 <strong>{counts.active}</strong></span><span className={counts.completed ? 'subtask-completed-count' : ''}>已完成 <strong>{counts.completed}</strong></span>
        {!!counts.failed && <span className="subtask-failed-count">失败 <strong>{counts.failed}</strong></span>}{!!counts.stopped && <span>已停止 <strong>{counts.stopped}</strong></span>}{!!counts.unknown && <span>未知 <strong>{counts.unknown}</strong></span>}</> : <span>尚未收到子任务事件</span>}
      </span><ChevronDown size={14} className="subtask-toggle-chevron" aria-hidden="true"/>
    </button>
    <div className="subtask-body" id={listId} hidden={!expanded}>{expanded && <>
      <div className="subtask-toolbar"><span>{all ? '本会话保留的子任务' : current.some(task => task.turnId !== activity?.turnId) ? '当前轮及仍在执行的早先任务' : '当前轮收到的子任务'}</span>{hasHistory && <div aria-label="子任务范围"><button type="button" aria-pressed={!all} onClick={() => setAll(false)}>当前轮</button><button type="button" aria-pressed={all} onClick={() => setAll(true)}>全部记录</button></div>}</div>
      <div className="subtask-list">{ordered.length ? ordered.map(task => <SubtaskRow key={task.id} task={task} now={now} earlier={task.turnId !== activity?.turnId}/>) : <p className="subtask-note">当前轮尚未收到子任务事件，可切换到全部记录查看之前的任务。</p>}</div>
      {activity?.truncated && <p className="subtask-note subtask-truncated">历史可能不完整，统计仅包含已保留的子任务。</p>}
    </>}</div>
  </section>;
}
