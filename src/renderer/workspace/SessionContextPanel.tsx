import { Activity, Archive, Copy, GitBranch } from 'lucide-react';
import type { ExecutionCapabilities } from '../../shared/execution';
import type { AppState, Capabilities, Session } from '../../shared/types';
import { SessionConfig } from '../SessionConfig';
import { time } from './presentation';
import type { OpenNew, Perform, ReportError } from './types';

export interface SessionContextPanelProps {
  executionCapabilities?: ExecutionCapabilities;
  active: Session;
  project?: AppState['projects'][number];
  structured: boolean;
  activeBusy: boolean;
  cap: Capabilities;
  busy: boolean;
  perform: Perform;
  report: ReportError;
  setNotice: (value: string) => void;
  openNew: OpenNew;
  selectSession: (id: string) => void;
  deleteConfirm: string;
  setDeleteConfirm: (id: string) => void;
  flushDrafts: () => void;
}

export function SessionContextPanel({
  executionCapabilities, active, project, structured, activeBusy, cap, busy,
  perform, report, setNotice, openNew, selectSession, deleteConfirm,
  setDeleteConfirm, flushDrafts,
}: SessionContextPanelProps) {
  return <div className="panel-content">
    <div className="section-label">会话上下文<Activity size={14} /></div>
    <div className="detail-block">
      <label>项目</label>
      <strong>{project?.name ?? '原项目已移除'}</strong>
      <label>工作目录</label>
      <strong>{active.cwd}</strong>
      <label>运行方式</label>
      <strong>{structured ? '结构化对话' : active.kind === 'shell' ? '系统 Shell' : 'Claude Code 终端'}</strong>
      <label>创建时间</label>
      <strong>{time(active.createdAt)}</strong>
      {active.kind === 'agent' && <>
        <label>Claude 会话 ID{active.identityPending ? ' · 等待同步' : ''}</label>
        <button className="id-copy" title="复制会话 ID" onClick={() => void perform(async () => {
          await navigator.clipboard.writeText(active.execution.conversationId ?? '');
          setNotice('会话 ID 已复制');
        })}>
          {(active.execution.conversationId ?? '').slice(0, 18)}…<Copy size={12} />
        </button>
      </>}
    </div>
    {active.kind === 'agent' && <>
      <SessionConfig key={active.id} session={active} capabilities={cap} onError={report} />
      <button className="secondary full" disabled={!active.started || !executionCapabilities?.fork || activeBusy || active.identityPending} onClick={() => openNew('agent', active)}>
        <GitBranch size={14} />从此会话创建分支
      </button>
    </>}
    <button className="text-button archive-button" disabled={busy || (structured ? activeBusy : ['running', 'stopping'].includes(active.status))} onClick={() => void perform(async () => {
      await window.desktop.updateSession({ id: active.id, archived: !active.archived });
      selectSession('');
    })}>
      <Archive size={14} />{active.archived ? '取消归档' : '归档会话'}
    </button>
    <button className="text-button danger archive-button" disabled={busy || (structured ? activeBusy : ['running', 'stopping'].includes(active.status))} onClick={() => setDeleteConfirm(active.id)}>删除会话</button>
    {deleteConfirm === active.id && <div className="action-confirm">
      <p>删除工作台中的会话记录，原始 CLI 历史会保留。</p>
      {active.worktree && <>
        <p>仅删除会话会保留隔离目录中的全部文件和 Git 分支，包括未提交、未合并及被忽略的文件。之后请手动管理此目录；如需一并移除目录，请先到“变更”面板安全清理。</p>
        <p className="panel-note">保留目录：{active.worktree}</p>
        <button className="secondary compact" disabled={busy} onClick={() => void perform(() => window.desktop.openFolder(active.id))}>打开隔离目录</button>
        <button className="secondary compact" disabled={busy} onClick={() => void perform(async () => { await window.desktop.copyText(active.worktree!); setNotice('隔离目录路径已复制'); })}>复制隔离目录路径</button>
      </>}
      <button className="secondary compact" onClick={() => setDeleteConfirm('')}>取消</button>
      <button className="secondary compact danger" disabled={busy} onClick={() => void perform(async () => {
        flushDrafts();
        await window.desktop.deleteSession(active.id, active.worktree ? { preserveWorktree: true } : undefined);
        selectSession('');
      })}>{active.worktree ? '仅删除会话，保留隔离目录' : '确认删除会话'}</button>
    </div>}
  </div>;
}
