import { Archive, ArrowDownToLine, Copy, FolderOpen, GitBranch, Pencil, Square, Trash2, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ExecutionDescriptor } from '../../shared/execution';
import { sessionActionAvailability } from './session-action-availability';
import type { Project, Session } from '../../shared/types';
import { Dialog } from '../Dialog';
import { sessionReadLifecycle } from '../session-read-lifecycle';
import { RenameSession } from './RenameSession';
import { SessionActionMenu, type SessionActionMenuAnchor, type SessionActionMenuItem } from './SessionActionMenu';
import type { OpenNew, Perform, ReportError } from './types';
import '../session-actions.css';

export interface SessionActionHandlers {
  executors: ExecutionDescriptor[];
  busy: boolean;
  perform: Perform;
  report: ReportError;
  flushDrafts: () => void;
  setNotice: (value: string) => void;
  onSessionHidden: (id: string) => void;
}

export interface SessionMenuTarget extends SessionActionMenuAnchor {
  archived: boolean;
  worktreePath?: string;
}

interface Props extends SessionActionHandlers {
  sessions: Session[];
  projects: Project[];
  menu?: SessionMenuTarget;
  onCloseMenu: () => void;
  openNew: OpenNew;
}

interface Confirmation {
  action: 'archive' | 'delete' | 'force-delete';
  id: string;
  title: string;
  archived: boolean;
  worktreePath?: string;
}

const errorMessage = (error: unknown) => error instanceof Error
  ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error);

/** Each operation captures the row's identity, independently of the open workspace. */
export function SessionActions({ sessions, projects, menu, onCloseMenu, openNew, executors, busy, perform, report, flushDrafts, setNotice, onSessionHidden }: Props) {
  const [confirmation, setConfirmation] = useState<Confirmation>();
  const [renameTarget, setRenameTarget] = useState<Session>();
  const [forceText, setForceText] = useState(''), [actionError, setActionError] = useState(''), [submitting, setSubmitting] = useState(false);
  const pending = useRef(false), mounted = useRef(true), targetRef = useRef(confirmation), renameRef = useRef(renameTarget);
  const cancelButton = useRef<HTMLButtonElement>(null), forceInput = useRef<HTMLInputElement>(null);
  targetRef.current = confirmation; renameRef.current = renameTarget;
  const targetSession = sessions.find(session => session.id === confirmation?.id);
  const menuSession = sessions.find(session => session.id === menu?.sessionId);
  const matchingMenuTarget = !!menu && !!menuSession && menu.archived === menuSession.archived && menu.worktreePath === menuSession.worktree;
  const matchingTarget = !!confirmation && !!targetSession && confirmation.worktreePath === targetSession.worktree && confirmation.archived === targetSession.archived;
  const availability = (session: Session) => sessionActionAvailability(session, executors.find(item => item.providerId === session.execution.providerId && item.mode === session.execution.mode));
  const actionBlocked = busy || submitting || !targetSession || !availability(targetSession).manage;
  const run = (action: () => Promise<unknown>) => { void perform(action).catch(report); };
  const closeConfirmation = () => {
    if (pending.current || busy) return;
    setConfirmation(undefined); setForceText(''); setActionError('');
  };
  const closeRename = () => {
    if (pending.current || busy) return;
    setRenameTarget(undefined); setActionError('');
  };
  const openConfirmation = (session: Session, action: 'archive' | 'delete') => {
    if (pending.current || busy || !availability(session).manage) return;
    setConfirmation({ action, id: session.id, title: session.title, archived: session.archived, worktreePath: session.worktree });
    setForceText(''); setActionError('');
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
    if (renameTarget && !sessions.some(session => session.id === renameTarget.id)) { setRenameTarget(undefined); setActionError(''); }
    if (menu && !matchingMenuTarget) onCloseMenu();
  }, [confirmation, matchingTarget, renameTarget, sessions, menu, matchingMenuTarget, onCloseMenu]);
  useLayoutEffect(() => {
    if (matchingTarget) (confirmation?.action === 'force-delete' ? forceInput.current : cancelButton.current)?.focus();
  }, [matchingTarget, confirmation?.action, confirmation?.id]);
  const saveRename = async (title: string) => {
    const target = renameTarget;
    if (!target || !sessions.some(session => session.id === target.id) || busy || pending.current || !title.trim()) return;
    pending.current = true; setSubmitting(true); setActionError('');
    try {
      await perform(async () => {
        try {
          await window.desktop.updateSession({ id: target.id, title });
          if (mounted.current) setRenameTarget(value => value === target ? undefined : value);
        } catch (error) {
          if (mounted.current && renameRef.current === target) setActionError(errorMessage(error));
          throw error;
        }
      });
    } catch (error) { report(error); }
    finally { pending.current = false; if (mounted.current) setSubmitting(false); }
  };
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
            await sessionReadLifecycle.remove(target.id, () => window.desktop.deleteSession(target.id, options));
          }
          if (mounted.current) {
            setConfirmation(value => value === target ? undefined : value);
            onSessionHidden(target.id);
          }
        } catch (error) {
          if (mounted.current && targetRef.current === target) setActionError(errorMessage(error));
          throw error;
        }
      });
    } catch (error) { report(error); }
    finally { pending.current = false; if (mounted.current) setSubmitting(false); }
  };
  const items: SessionActionMenuItem[] = [];
  if (menuSession) {
    const target = menuSession;
    const allowed = availability(target);
    const taskBusy = allowed.taskBusy;
    const blocked = busy || submitting;
    const descriptor = executors.find(item => item.providerId === target.execution.providerId && item.mode === target.execution.mode);
    const providerName = descriptor?.displayName ?? target.execution.providerId;
    items.push({ id: 'rename', label: '重命名会话', icon: <Pencil size={15} />, disabled: blocked,
      onSelect: () => { setRenameTarget(target); setActionError(''); } });
    if (target.kind === 'agent') items.push({ id: 'fork', label: '从此会话创建分支', icon: <GitBranch size={15} />,
      disabled: blocked || !allowed.fork, onSelect: () => openNew('agent', target) });
    if (target.kind === 'agent' && target.execution.mode === 'structured') items.push({ id: 'continue', label: '带入内容到新会话', icon: <Copy size={15} />,
      disabled: blocked || !allowed.continue || !projects.some(project => project.id === target.projectId), onSelect: () => openNew('agent', undefined, target.projectId, target) });
    items.push(
      { id: 'copy-id', label: '复制会话 ID', icon: <Copy size={15} />, disabled: blocked, separatorBefore: true,
        onSelect: () => run(async () => { await window.desktop.copyText(target.id); setNotice('会话 ID 已复制'); }) },
      ...(target.execution.conversationId ? [{ id: 'copy-provider-id', label: `复制 ${providerName} 会话 ID`, icon: <Copy size={15} />, disabled: blocked,
        onSelect: () => run(async () => { await window.desktop.copyText(target.execution.conversationId!); setNotice(`${providerName} 会话 ID 已复制`); }) }] : []),
      { id: 'copy-path', label: '复制工作目录路径', icon: <Copy size={15} />, disabled: blocked,
        onSelect: () => run(async () => { await window.desktop.copyText(target.cwd); setNotice('工作目录路径已复制'); }) },
      { id: 'open-folder', label: '打开工作目录', icon: <FolderOpen size={15} />, disabled: blocked,
        onSelect: () => run(() => window.desktop.openFolder(target.id)) },
      { id: 'export', label: '导出会话记录', icon: <ArrowDownToLine size={15} />, disabled: blocked || !allowed.export,
        onSelect: () => run(async () => { const file = await window.desktop.exportTranscript(target.id); if (file) setNotice('会话记录已导出'); }) },
    );
    if (taskBusy) items.push({ id: 'interrupt', label: '中断任务', icon: <Square size={15} />, separatorBefore: true,
      disabled: blocked || !allowed.stop || target.status === 'stopping', onSelect: () => run(() => window.desktop.interruptSession(target.id)) });
    if (taskBusy || target.status === 'running') items.push({ id: 'stop',
      label: taskBusy ? '停止会话进程' : target.execution.mode === 'structured' ? '关闭空闲会话进程' : '关闭终端',
      icon: <X size={15} />, separatorBefore: !taskBusy, disabled: blocked || !allowed.stop || target.status === 'stopping',
      onSelect: () => run(() => window.desktop.stopSession(target.id)) });
    items.push(
      { id: 'archive', label: target.archived ? '取消归档' : '归档会话', icon: <Archive size={15} />, separatorBefore: true,
        disabled: blocked || !allowed.manage, onSelect: () => openConfirmation(target, 'archive') },
      { id: 'delete', label: '删除会话', icon: <Trash2 size={15} />, danger: true,
        disabled: blocked || !allowed.manage, onSelect: () => openConfirmation(target, 'delete') },
    );
  }
  return <>
    {menu && menuSession && matchingMenuTarget && <SessionActionMenu key={menu.sessionId} anchor={menu} title={menuSession.title} items={items} onClose={onCloseMenu} />}
    {renameTarget && sessions.some(session => session.id === renameTarget.id) && <Dialog label="重命名会话" onClose={closeRename} closeDisabled={busy || submitting}>
      <RenameSession key={renameTarget.id} target={renameTarget} busy={busy || submitting} error={actionError} onSave={saveRename} onClose={closeRename} />
    </Dialog>}
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
          <p>{targetSession?.execution.providerId === 'claude' ? '删除工作台中的会话记录，原始 CLI 历史会保留。' : '删除此引擎在工作台中的会话记录。'}</p>
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
  </>;
}
