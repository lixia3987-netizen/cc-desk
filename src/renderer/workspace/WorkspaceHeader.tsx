import { ChevronRight, Code2, Command, Folder, FolderOpen, GitBranch, Play, Square, X } from 'lucide-react';
import type { AppState, Session } from '../../shared/types';
import { AttentionCenter } from '../AttentionCenter';

import { sessionColor, sessionLabel } from './presentation';
import type { Perform } from './types';

interface Props {
  state: AppState; active?: Session; project?: AppState['projects'][number]; structured: boolean;
  activeBusy: boolean; busy: boolean; creating?: boolean;
  onPalette: () => void;
  onAttention: (item: { sessionId: string; requestId: string }) => void;
  openIde: () => void; perform: Perform; setNotice: (value: string) => void;
  start: (session: Session) => Promise<void>;
}

export function WorkspaceHeader({ state, active, project, structured, activeBusy, busy, creating, onPalette, onAttention, openIde, perform, setNotice, start }: Props) {
  return <header className={'topbar ' + (active ? 'session-header' : '')}>
    {active ? <div className="session-heading">
      <div className="breadcrumb">
        <Folder size={13} />
        <span title={project?.path ?? active.cwd}>{project?.name ?? '原项目已移除'}</span>
        <ChevronRight size={11} />
        <span>{structured ? '结构化对话' : active.kind === 'shell' ? 'Shell' : 'Claude Code 终端'}</span>{active.worktree && <GitBranch size={13} aria-label="隔离目录" />}</div>
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
      {active && <div className="session-actions">
        {activeBusy ? <>
          <button className="secondary compact" disabled={busy || active.status === 'stopping'} onClick={() => void perform(() => window.desktop.interruptSession(active.id))}>{active.status === 'stopping' ? '正在停止' : '中断任务'}</button>
          <button className="secondary compact danger" disabled={busy || active.status === 'stopping'} onClick={() => void perform(() => window.desktop.stopSession(active.id))}>
            <Square size={13} />停止</button>
        </> : !structured && active.status === 'running' ? <button className="secondary compact" disabled={busy} title="关闭等待输入的终端进程，稍后可以恢复" onClick={() => void perform(() => window.desktop.stopSession(active.id))}>
          <X size={13} />关闭终端</button> : <button className="primary compact" disabled={busy || active.archived} onClick={() => { if (structured) { document.querySelector<HTMLTextAreaElement>('.chat-composer textarea')?.focus(); setNotice('输入任务并按 Enter 发送；Ctrl / ⌘ + Enter 换行。'); } else void start(active); }}>
          <Play size={14} />{structured ? (active.started ? '继续输入' : '开始输入') : active.started ? '恢复会话' : '启动会话'}</button>}</div>}
    </div>
  </header>;
}
