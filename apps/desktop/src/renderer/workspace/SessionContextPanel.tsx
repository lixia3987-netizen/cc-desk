import { Activity, Archive, Copy, GitBranch } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ExecutionCapabilities, ExecutionDescriptor } from '../../shared/execution';
import type { AppState, Session } from '../../shared/types';
import { SessionConfig } from '../SessionConfig';
import { Dialog } from '../Dialog';
import { time } from './presentation';
import type { OpenNew, Perform, ReportError } from './types';

export interface SessionContextPanelProps {
  executionCapabilities?: ExecutionCapabilities;
  descriptor?: ExecutionDescriptor; unavailable?: string; readOnly: boolean;
  active: Session;
  project?: AppState['projects'][number];
  structured: boolean;
  activeBusy: boolean;
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
  executionCapabilities, descriptor, unavailable, readOnly, active, project, structured, activeBusy, busy,
  perform, report, setNotice, openNew, selectSession, deleteConfirm,
  setDeleteConfirm, flushDrafts,
}: SessionContextPanelProps) {
  const [forceTarget, setForceTarget] = useState<{ id: string; worktreePath: string }>();
  const [forceText, setForceText] = useState(''), [forceError, setForceError] = useState(''), [forceDeleting, setForceDeleting] = useState(false);
  const forcePending = useRef(false), activeId = useRef(active.id);
  activeId.current = active.id;
  const deletionBlocked = readOnly || busy || activeBusy || (!structured && ['running', 'stopping'].includes(active.status));
  const matchingTarget = forceTarget?.id === active.id && forceTarget?.worktreePath === active.worktree && deleteConfirm === active.id;
  useEffect(() => {
    setForceTarget(undefined); setForceText(''); setForceError('');
  }, [active.id, active.worktree, deleteConfirm]);
  const forceDelete = async () => {
    const target = forceTarget;
    if (!target || !matchingTarget || deletionBlocked || forcePending.current || forceText !== '删除') return;
    forcePending.current = true; setForceDeleting(true); setForceError('');
    try {
      await perform(async () => {
        try {
          flushDrafts();
          await window.desktop.deleteSession(target.id, { forceWorktree: true, worktreePath: target.worktreePath });
          setForceTarget(undefined); setDeleteConfirm('');
          if (activeId.current === target.id) selectSession('');
        } catch (error) { setForceError(error instanceof Error ? error.message : String(error)); throw error; }
      });
    } finally { forcePending.current = false; setForceDeleting(false); }
  };
  return <div className="panel-content">
    <div className="section-label">会话上下文<Activity size={14} /></div>
    <div className="detail-block">
      <label>项目</label>
      <strong>{project?.name ?? '原项目已移除'}</strong>
      <label>工作目录</label>
      <strong>{active.cwd}</strong>
      <label>运行方式</label>
      <strong>{descriptor?.displayName ?? active.execution.providerId} · {structured ? '结构化对话' : '终端'}</strong>
      <label>创建时间</label>
      <strong>{time(active.createdAt)}</strong>
      {active.kind === 'agent' && <>
        <label>会话 ID{active.identityPending ? ' · 等待同步' : ''}</label>
        <button className="id-copy" title="复制会话 ID" onClick={() => void perform(async () => {
          await navigator.clipboard.writeText(active.execution.conversationId ?? '');
          setNotice('会话 ID 已复制');
        })}>
          {(active.execution.conversationId ?? '').slice(0, 18)}…<Copy size={12} />
        </button>
      </>}
    </div>
    {active.kind === 'agent' && <>
      <SessionConfig key={active.id} session={active} descriptor={descriptor} onError={report} />
      {executionCapabilities?.fork && <button className="secondary full" disabled={readOnly || !!descriptor?.maintenance || !active.started || activeBusy || active.identityPending} onClick={() => openNew('agent', active)}>
        <GitBranch size={14} />从此会话创建分支
      </button>}
    </>}
    <button className="text-button archive-button" disabled={readOnly || busy || (structured ? activeBusy : ['running', 'stopping'].includes(active.status))} onClick={() => void perform(async () => {
      await window.desktop.updateSession({ id: active.id, archived: !active.archived });
      selectSession('');
    })}>
      <Archive size={14} />{active.archived ? '取消归档' : '归档会话'}
    </button>
    <button className="text-button danger archive-button" disabled={deletionBlocked} title={readOnly ? unavailable : undefined} onClick={() => setDeleteConfirm(active.id)}>删除会话</button>
    {readOnly && <p className="panel-note">执行器不可用时保留会话及工作目录；归档、删除与原始记录导出暂不可用。</p>}
    {deleteConfirm === active.id && <div className="action-confirm">
      <p>{active.execution.providerId === 'claude' ? '删除工作台中的会话记录，原始 CLI 历史会保留。' : '删除此引擎在工作台中的会话记录。'}</p>
      {active.worktree && <>
        <p>仅删除会话会保留隔离目录中的全部文件和 Git 分支，包括未提交、未合并及被忽略的文件。也可以在“变更”面板安全清理，或选择下方的强制删除。</p>
        <p className="panel-note">保留目录：{active.worktree}</p>
        <button className="secondary compact" disabled={busy} onClick={() => void perform(() => window.desktop.openFolder(active.id))}>打开隔离目录</button>
        <button className="secondary compact" disabled={busy} onClick={() => void perform(async () => { await window.desktop.copyText(active.worktree!); setNotice('隔离目录路径已复制'); })}>复制隔离目录路径</button>
      </>}
      <button className="secondary compact" disabled={busy || forceDeleting} onClick={() => setDeleteConfirm('')}>取消</button>
      <button className="secondary compact danger" disabled={deletionBlocked} onClick={() => void perform(async () => {
        flushDrafts();
        await window.desktop.deleteSession(active.id, active.worktree ? { preserveWorktree: true } : undefined);
        selectSession('');
      })}>{active.worktree ? '仅删除会话，保留隔离目录' : '确认删除会话'}</button>
      {active.worktree && <button className="secondary compact danger" disabled={deletionBlocked} onClick={() => {
        setForceTarget({ id: active.id, worktreePath: active.worktree! }); setForceText(''); setForceError('');
      }}>删除会话并强制删除隔离目录</button>}
    </div>}
    {forceTarget && matchingTarget && <Dialog label="强制删除隔离目录" onClose={() => { setForceTarget(undefined); setForceText(''); }} closeDisabled={busy || forceDeleting}>
      <h2>删除会话并强制删除隔离目录</h2>
      <p>将永久删除此会话及下方隔离目录。目录中的未提交修改、未跟踪文件和被忽略的文件都会丢失，无法通过撤销恢复。</p>
      <p className="panel-note" style={{ overflowWrap: 'anywhere' }}>隔离目录：{forceTarget.worktreePath}</p>
      <p>Git 分支和其中已经提交的内容会保留，来源项目不会被删除。</p>
      <label>输入“删除”以确认<input aria-label="输入“删除”以确认" value={forceText} onChange={event => setForceText(event.target.value)} disabled={busy || forceDeleting} autoComplete="off" /></label>
      {forceError && <p className="chat-error" role="alert">{forceError}</p>}
      <div className="modal-actions"><button className="secondary" disabled={busy || forceDeleting} onClick={() => { setForceTarget(undefined); setForceText(''); }}>取消</button>
        <button className="secondary danger" disabled={deletionBlocked || forceDeleting || forceText !== '删除'} onClick={() => void forceDelete()}>{forceDeleting ? '正在删除…' : '确认强制删除'}</button></div>
    </Dialog>}
  </div>;
}
