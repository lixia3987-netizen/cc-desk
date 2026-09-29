import { Activity, Archive, Copy, GitBranch } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ExecutionCapabilities } from '../../shared/execution';
import type { AppState, Capabilities, Session } from '../../shared/types';
import { SessionConfig } from '../SessionConfig';
import { Dialog } from '../Dialog';
import { time } from './presentation';
import type { OpenNew, Perform, ReportError } from './types';
import { sessionReadLifecycle } from '../session-read-lifecycle';

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

interface Confirmation {
  action: 'archive' | 'delete' | 'force-delete';
  id: string;
  title: string;
  archived: boolean;
  worktreePath?: string;
}

export function SessionContextPanel({
  executionCapabilities, active, project, structured, activeBusy, cap, busy,
  perform, report, setNotice, openNew, selectSession, deleteConfirm,
  setDeleteConfirm, flushDrafts,
}: SessionContextPanelProps) {
  const [confirmation, setConfirmation] = useState<Confirmation>();
  const [forceText, setForceText] = useState(''), [actionError, setActionError] = useState(''), [submitting, setSubmitting] = useState(false);
  const pending = useRef(false), mounted = useRef(true), current = useRef(active), targetRef = useRef(confirmation);
  const cancelButton = useRef<HTMLButtonElement>(null), forceInput = useRef<HTMLInputElement>(null);
  current.current = active; targetRef.current = confirmation;
  const actionBlocked = busy || submitting || activeBusy || (!structured && ['running', 'stopping'].includes(active.status));
  const matchingTarget = !!confirmation && confirmation.id === active.id && confirmation.worktreePath === active.worktree && confirmation.archived === active.archived &&
    (confirmation.action === 'archive' || deleteConfirm === active.id);
  const closeConfirmation = () => {
    if (pending.current || busy) return;
    setConfirmation(undefined); setDeleteConfirm(''); setForceText(''); setActionError('');
  };
  const openConfirmation = (action: 'archive' | 'delete') => {
    if (pending.current || actionBlocked) return;
    setConfirmation({ action, id: active.id, title: active.title, archived: active.archived, worktreePath: active.worktree });
    setDeleteConfirm(action === 'delete' ? active.id : ''); setForceText(''); setActionError('');
  };
  const changeDeleteStage = (action: 'delete' | 'force-delete') => {
    if (!confirmation || !matchingTarget || pending.current || actionBlocked) return;
    setConfirmation({ ...confirmation, action }); setForceText(''); setActionError('');
  };
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (confirmation && !matchingTarget) { setConfirmation(undefined); setForceText(''); setActionError(''); }
  }, [confirmation, matchingTarget]);
  useLayoutEffect(() => {
    if (matchingTarget) (confirmation?.action === 'force-delete' ? forceInput.current : cancelButton.current)?.focus();
  }, [matchingTarget, confirmation?.action, confirmation?.id]);
  const confirmAction = async () => {
    const target = confirmation;
    if (!target || !matchingTarget || actionBlocked || pending.current || (target.action === 'force-delete' && (forceText !== '删除' || !target.worktreePath))) return;
    pending.current = true; setSubmitting(true); setActionError('');
    try {
      await perform(async () => {
        try {
          flushDrafts();
          if (target.action === 'archive') {
            await window.desktop.updateSession({ id: target.id, archived: !target.archived });
          } else {
            const options = target.action === 'force-delete' ? { forceWorktree: true as const, worktreePath: target.worktreePath! }
              : target.worktreePath ? { preserveWorktree: true as const } : undefined;
            await sessionReadLifecycle.remove(target.id,()=>window.desktop.deleteSession(target.id, options));
          }
          if (mounted.current) {
            setConfirmation(value => value === target ? undefined : value);
            if (current.current.id === target.id) { setDeleteConfirm(''); selectSession(''); }
          }
        } catch (error) {
          if (mounted.current && targetRef.current === target) setActionError(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error));
          throw error;
        }
      });
    } finally { pending.current = false; if (mounted.current) setSubmitting(false); }
  };
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
      <button className="secondary full" disabled={!active.started || !executionCapabilities?.fork || activeBusy || active.identityPending} onClick={() => openNew(active)}>
        <GitBranch size={14} />从此会话创建分支
      </button>
    </>}
    <button className="text-button archive-button" disabled={actionBlocked} onClick={() => openConfirmation('archive')}>
      <Archive size={14} />{active.archived ? '取消归档' : '归档会话'}
    </button>
    <button className="text-button danger archive-button" disabled={actionBlocked} onClick={() => openConfirmation('delete')}>删除会话</button>
    {confirmation && matchingTarget && <Dialog
      className="session-confirmation"
      label={confirmation.action === 'force-delete' ? '强制删除隔离目录' : confirmation.action === 'delete' ? '删除会话' : confirmation.archived ? '取消归档' : '归档会话'}
      onClose={closeConfirmation} closeDisabled={busy || submitting}>
      <h2>{confirmation.action === 'force-delete' ? '删除会话并强制删除隔离目录' : confirmation.action === 'delete' ? '删除会话' : confirmation.archived ? '取消归档' : '归档会话'}</h2>
      <p className="panel-note" style={{ overflowWrap: 'anywhere' }}>会话：{confirmation.title}</p>
      {confirmation.action === 'archive' ? <p>{confirmation.archived
        ? '将此会话恢复到未归档列表，保留聊天记录、草稿和工作目录。'
        : '归档后，此会话会移至已归档列表，聊天记录、草稿和工作目录都会保留，可随时取消归档。'}</p>
        : confirmation.action === 'force-delete' ? <>
          <p>将永久删除此会话及下方隔离目录。目录中的未提交修改、未跟踪文件和被忽略的文件都会丢失，无法通过撤销恢复。</p>
          <p className="panel-note" style={{ overflowWrap: 'anywhere' }}>隔离目录：{confirmation.worktreePath}</p>
          <p>Git 分支和其中已经提交的内容会保留，来源项目不会被删除。</p>
          <label>输入“删除”以确认<input ref={forceInput} aria-label="输入“删除”以确认" value={forceText} onChange={event => setForceText(event.target.value)} disabled={busy || submitting} autoComplete="off" /></label>
        </> : <>
          <p>删除工作台中的会话记录，原始 CLI 历史会保留。</p>
          {confirmation.worktreePath && <>
            <p>仅删除会话会保留隔离目录中的全部文件和 Git 分支，包括未提交、未合并及被忽略的文件。也可以在“变更”面板安全清理，或选择下方的强制删除。</p>
            <p className="panel-note" style={{ overflowWrap: 'anywhere' }}>保留目录：{confirmation.worktreePath}</p>
            <div className="panel-actions">
              <button className="secondary compact" disabled={busy || submitting} onClick={() => void perform(async () => {
                try { await window.desktop.openFolder(confirmation.id); }
                catch (error) { if (mounted.current && targetRef.current === confirmation) setActionError(error instanceof Error ? error.message : String(error)); throw error; }
              })}>打开隔离目录</button>
              <button className="secondary compact" disabled={busy || submitting} onClick={() => void perform(async () => {
                try { await window.desktop.copyText(confirmation.worktreePath!); setNotice('隔离目录路径已复制'); }
                catch (error) { if (mounted.current && targetRef.current === confirmation) setActionError(error instanceof Error ? error.message : String(error)); throw error; }
              })}>复制隔离目录路径</button>
            </div>
          </>}
        </>}
      {actionError && <p className="chat-error" role="alert">{actionError}</p>}
      {confirmation.action === 'delete' && confirmation.worktreePath && <div className="session-delete-choices">
        <button className="secondary danger full" disabled={actionBlocked} onClick={() => void confirmAction()}>{submitting ? '正在删除…' : '仅删除会话，保留隔离目录'}</button>
        <button className="secondary danger full" disabled={actionBlocked} onClick={() => changeDeleteStage('force-delete')}>删除会话并强制删除隔离目录</button>
      </div>}
      <div className="modal-actions">
        <button ref={cancelButton} className="secondary" disabled={busy || submitting} onClick={closeConfirmation}>取消</button>
        {confirmation.action === 'force-delete' && <button className="secondary" disabled={actionBlocked} onClick={() => changeDeleteStage('delete')}>返回</button>}
        {(confirmation.action !== 'delete' || !confirmation.worktreePath) && <button className={confirmation.action === 'archive' ? 'primary' : 'secondary danger'}
          disabled={actionBlocked || (confirmation.action === 'force-delete' && forceText !== '删除')} onClick={() => void confirmAction()}>
          {submitting ? confirmation.action === 'archive' ? '正在保存…' : '正在删除…'
            : confirmation.action === 'force-delete' ? '确认强制删除'
              : confirmation.action === 'delete' ? confirmation.worktreePath ? '仅删除会话，保留隔离目录' : '确认删除会话'
                : confirmation.archived ? '确认取消归档' : '确认归档'}
        </button>}
      </div>
    </Dialog>}
  </div>;
}
