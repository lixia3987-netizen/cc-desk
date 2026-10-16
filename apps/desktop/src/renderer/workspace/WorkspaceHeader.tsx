import { useEffect, useRef, useState } from 'react';
import { PendingAction, terminalInterruptSettled, type PendingActionState } from '../pending-action';
import { ChevronRight, Code2, Command, Folder, FolderOpen, GitBranch, Loader2, Play, X } from 'lucide-react';
import type { ExecutionDescriptor } from '../../shared/execution';
import type { AppState, Session } from '../../shared/types';
import { AttentionCenter } from '../AttentionCenter';

import { sessionColor, sessionLabel } from './presentation';
import type { Perform } from './types';

interface Props {
  state: AppState; active?: Session; project?: AppState['projects'][number]; structured: boolean;
  activeBusy: boolean; busy: boolean; creating?: boolean;
  descriptor?: ExecutionDescriptor; unavailable?: string; readOnly: boolean;
  onPalette: () => void;
  onAttention: (item: { sessionId: string; requestId: string }) => void;
  openIde: () => Promise<void> | void; perform: Perform; setNotice: (value: string) => void;
  start: (session: Session) => Promise<void>;
}

export function WorkspaceHeader({ state, active, descriptor, unavailable, readOnly, project, structured, activeBusy, busy, creating, onPalette, onAttention, openIde, perform, start, setNotice }: Props) {
  const operation = useRef(new PendingAction()), mounted = useRef(true);
  const [pending, setPending] = useState<PendingActionState>();
  const requestedInterrupts = useRef(new Map<string, { title: string; error?: string }>());
  const [interrupts, setInterrupts] = useState(new Map(requestedInterrupts.current));
  const publishInterrupts = () => { if (mounted.current) setInterrupts(new Map(requestedInterrupts.current)); };
  const settleInterrupt = (id: string, session: Session | undefined) => {
    if (terminalInterruptSettled(session)) { requestedInterrupts.current.delete(id); publishInterrupts(); return true; }
    return false;
  };
  useEffect(() => {
    let changed = false;
    for (const id of requestedInterrupts.current.keys()) if (terminalInterruptSettled(state.sessions.find(session => session.id === id))) {
      requestedInterrupts.current.delete(id); changed = true;
    }
    if (changed) publishInterrupts();
  }, [state.sessions]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const targetKey = active ? `session:${active.id}` : project ? `project:${project.id}` : '';
  const currentPending = pending?.key === targetKey ? pending : undefined;
  const locked = busy || !!pending;
  const waitingInterrupt = active ? interrupts.get(active.id) : undefined;
  const act = (label: string, action: () => Promise<unknown> | void) => {
    if (busy || operation.current.state) return;
    void operation.current.run({ key: targetKey, label }, action, value => { if (mounted.current) setPending(value); })
      .catch(error => setNotice(error instanceof Error ? error.message : String(error)));
  };
  const verifyInterrupt = async (session: Session) => {
    try {
      const snapshot = await window.desktop.snapshot();
      if (!settleInterrupt(session.id, snapshot.state.sessions.find(value => value.id === session.id)) && requestedInterrupts.current.has(session.id)) {
        requestedInterrupts.current.set(session.id, { title: session.title, error: '中断请求已提交，尚未确认任务结束；可以继续核实或关闭终端。' }); publishInterrupts();
      }
    } catch {
      if (requestedInterrupts.current.has(session.id)) { requestedInterrupts.current.set(session.id, { title: session.title, error: '暂时无法同步中断状态，请稍后重新核实。' }); publishInterrupts(); }
    }
  };
  const interrupt = (session: Session) => {
    if (busy || operation.current.state || requestedInterrupts.current.has(session.id)) return;
    requestedInterrupts.current.set(session.id, { title: session.title }); publishInterrupts();
    act('正在中断任务…', async () => {
      let accepted = false;
      await perform(async () => { await window.desktop.interruptSession(session.id); accepted = true; });
      if (accepted) await verifyInterrupt(session);
      else { requestedInterrupts.current.delete(session.id); publishInterrupts(); }
    });
  };
  return <header className={'topbar ' + (active ? 'session-header' : '')}>
    {active ? <div className="session-heading">
      <div className="breadcrumb">
        <Folder size={13} />
        <span title={project?.path ?? active.cwd}>{project?.name ?? '原项目已移除'}</span>
        <ChevronRight size={11} />
        <span>{descriptor?.displayName ?? active.execution.providerId} · {structured ? '结构化对话' : '终端'}</span>{active.worktree && <GitBranch size={13} aria-label="隔离目录" />}</div>
      <div className="session-title-line">
        <h1>
          <span title={active.title}>{active.title}</span>
        </h1>
        <span className={`status-tag ${sessionColor(active)}`}>
          <span className={`dot ${sessionColor(active)}`} />{sessionLabel(active)}</span>
      </div>
    </div> : <div className="breadcrumb">
      <FolderOpen size={15} />
      <span>{project?.name ?? '工作空间'}</span>
      <ChevronRight size={13} />
      <strong>{creating ? '新建会话' : '概览'}</strong>
    </div>}
    <div className="workspace-actions">
      <AttentionCenter sessions={state.sessions} projects={state.projects} onOpen={onAttention} />
      <button className="icon-button command-button" aria-label="命令面板" title="命令面板 Ctrl / ⌘ + K" onClick={() => { onPalette(); }}>
        <Command size={16} />
      </button>
      {(active || project) && <button className="secondary compact ide-open" aria-label="在 IDE 中打开" title={state.settings.idePath ? `使用 ${state.settings.idePath} 打开 ${active?.cwd ?? project?.path}` : '配置用于打开项目的 IDE 应用'} disabled={locked} onClick={() => act('正在打开 IDE…', openIde)}>
        {currentPending?.label === '正在打开 IDE…' ? <Loader2 size={16} className="spin" /> : <Code2 size={16} />}{currentPending?.label === '正在打开 IDE…' ? '正在打开 IDE…' : 'IDE'}</button>}
      {active && !structured && <div className="session-actions">
        {activeBusy &&
          <button className="secondary compact" disabled={readOnly || locked || !!waitingInterrupt || active.status === 'stopping'} onClick={() => interrupt(active)}>{currentPending?.label === '正在中断任务…' && <Loader2 size={13} className="spin" />}{currentPending?.label === '正在中断任务…' ? '正在中断任务…' : waitingInterrupt ? '已请求中断' : active.status === 'stopping' ? '正在停止' : '中断任务'}</button>
        }
        {activeBusy || active.status === 'running' ? <details className="terminal-actions-menu"><summary aria-label="终端操作" title="终端进程操作">终端操作</summary>
          <button className="secondary compact danger" disabled={locked || readOnly || active.status === 'stopping'} title="结束此终端及其子进程，稍后可以恢复" onClick={() => act('正在关闭终端…', () => perform(() => window.desktop.stopSession(active.id)))}>
            {currentPending?.label === '正在关闭终端…' ? <Loader2 size={13} className="spin" /> : <X size={13} />}{currentPending?.label === '正在关闭终端…' ? '正在关闭终端…' : '关闭终端'}</button></details> : <button className="primary compact" disabled={locked || readOnly || active.archived || !!unavailable || (active.kind === 'agent' && active.started && !descriptor?.capabilities.resume)} title={unavailable} onClick={() => act(active.started ? '正在恢复会话…' : '正在启动会话…', () => start(active))}>
          {currentPending && currentPending.label !== '正在打开 IDE…' ? <Loader2 size={14} className="spin" /> : <Play size={14} />}{currentPending && currentPending.label !== '正在打开 IDE…' ? currentPending.label : active.started ? '恢复会话' : '启动会话'}</button>}</div>}
      {waitingInterrupt && !currentPending && active && <span className="panel-note" role="status" aria-live="polite">{waitingInterrupt.error ?? '已请求中断，等待任务状态确认…'}<button className="text-button" disabled={locked} onClick={() => act('正在核实中断状态…', () => verifyInterrupt(active))}>核实中断状态</button></span>}
      {currentPending && <span className="panel-note" role="status" aria-live="polite">{currentPending.label}</span>}
    </div>
  </header>;
}
