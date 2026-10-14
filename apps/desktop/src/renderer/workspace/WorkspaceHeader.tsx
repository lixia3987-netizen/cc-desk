import { ChevronRight, Code2, Command, Folder, FolderOpen, GitBranch, Play, X } from 'lucide-react';
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
  openIde: () => void; perform: Perform; setNotice: (value: string) => void;
  start: (session: Session) => Promise<void>;
}

export function WorkspaceHeader({ state, active, descriptor, unavailable, readOnly, project, structured, activeBusy, busy, creating, onPalette, onAttention, openIde, perform, start }: Props) {
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
      {(active || project) && <button className="secondary compact ide-open" aria-label="在 IDE 中打开" title={state.settings.idePath ? `使用 ${state.settings.idePath} 打开 ${active?.cwd ?? project?.path}` : '配置用于打开项目的 IDE 应用'} disabled={busy} onClick={openIde}>
        <Code2 size={16} />IDE</button>}
      {active && !structured && <div className="session-actions">
        {activeBusy &&
          <button className="secondary compact" disabled={readOnly || busy || active.status === 'stopping'} onClick={() => void perform(() => window.desktop.interruptSession(active.id))}>{active.status === 'stopping' ? '正在停止' : '中断任务'}</button>
        }
        {activeBusy || active.status === 'running' ? <details className="terminal-actions-menu"><summary aria-label="终端操作" title="终端进程操作">终端操作</summary>
          <button className="secondary compact danger" disabled={busy || readOnly || active.status === 'stopping'} title="结束此终端及其子进程，稍后可以恢复" onClick={() => void perform(() => window.desktop.stopSession(active.id))}>
            <X size={13} />关闭终端</button></details> : <button className="primary compact" disabled={busy || readOnly || active.archived || !!unavailable || (active.kind === 'agent' && active.started && !descriptor?.capabilities.resume)} title={unavailable} onClick={() => void start(active)}>
          <Play size={14} />{active.started ? '恢复会话' : '启动会话'}</button>}</div>}
    </div>
  </header>;
}
