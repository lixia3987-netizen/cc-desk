import { ArrowDownToLine, ChevronRight, Code2, Command, Folder, FolderOpen, GitBranch, MoreHorizontal, Play, Square, X } from 'lucide-react';
import type { AppState, Session } from '../../shared/types';
import type { ExecutionDescriptor } from '../../shared/execution';
import { AttentionCenter } from '../AttentionCenter';

import { sessionColor, sessionLabel } from './presentation';
import type { Perform } from './types';

interface Props {
  state: AppState; active?: Session; project?: AppState['projects'][number]; structured: boolean;
  activeBusy: boolean; busy: boolean;
  descriptor?: ExecutionDescriptor; unavailable?: string; readOnly: boolean;
  onRename: (title: string) => void; onPalette: () => void;
  onAttention: (item: { sessionId: string; requestId: string }) => void;
  openIde: () => void; perform: Perform; setNotice: (value: string) => void;
  start: (session: Session) => Promise<void>;
}

export function WorkspaceHeader({ state, active, descriptor, unavailable, readOnly, project, structured, activeBusy, busy, onRename, onPalette, onAttention, openIde, perform, setNotice, start }: Props) {
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
          <button className="icon-button" title="重命名" onClick={() => { onRename(active.title); }}>
            <MoreHorizontal size={18} />
          </button>
        </h1>
        <span className={`status-tag ${sessionColor(active)}`}>
          <span className={`dot ${sessionColor(active)}`} />{sessionLabel(active)}</span>
      </div>
    </div> : <div className="breadcrumb">
      <FolderOpen size={15} />
      <span>{project?.name ?? '工作空间'}</span>
      <ChevronRight size={13} />
      <strong>概览</strong>
    </div>}
    <div className="workspace-actions">
      <AttentionCenter sessions={state.sessions} projects={state.projects} onOpen={onAttention} />
      <button className="icon-button command-button" aria-label="命令面板" title="命令面板 Ctrl / ⌘ + K" onClick={() => { onPalette(); }}>
        <Command size={16} />
      </button>
      {(active || project) && <button className="secondary compact ide-open" aria-label="在 IDE 中打开" title={state.settings.idePath ? `使用 ${state.settings.idePath} 打开 ${active?.cwd ?? project?.path}` : '配置用于打开项目的 IDE 应用'} disabled={busy} onClick={openIde}>
        <Code2 size={16} />IDE</button>}
      {active && <div className="session-actions">
        <button className="secondary compact" aria-label="打开工作目录" title={active.cwd} onClick={() => void perform(() => window.desktop.openFolder(active.id))}>
          <FolderOpen size={16} />
        </button>
        <button className="secondary compact" title={readOnly ? '执行器不可用，暂不能导出原始记录' : '导出会话记录'} disabled={readOnly || !descriptor?.capabilities.export} onClick={() => void perform(async () => { const file = await window.desktop.exportTranscript(active.id); if (file) setNotice('会话记录已导出'); })}>
          <ArrowDownToLine size={16} />
        </button>{activeBusy ? <>
          <button className="secondary compact" disabled={readOnly || busy || active.status === 'stopping'} onClick={() => void perform(() => window.desktop.interruptSession(active.id))}>{active.status === 'stopping' ? '正在停止' : '中断任务'}</button>
          <button className="secondary compact danger" disabled={readOnly || busy || active.status === 'stopping'} onClick={() => void perform(() => window.desktop.stopSession(active.id))}>
            <Square size={13} />停止</button>
        </> : !structured && active.status === 'running' ? <button className="secondary compact" disabled={busy || readOnly} title="关闭等待输入的终端进程，稍后可以恢复" onClick={() => void perform(() => window.desktop.stopSession(active.id))}>
          <X size={13} />关闭终端</button> : <button className="primary compact" disabled={busy || active.archived || !!unavailable || (active.kind === 'agent' && active.started && active.status !== 'running' && !descriptor?.capabilities.resume)} title={unavailable} onClick={() => { if (structured) { document.querySelector<HTMLTextAreaElement>('.chat-composer textarea')?.focus(); setNotice('输入任务并按 Enter 发送；Ctrl / ⌘ + Enter 换行。'); } else void start(active); }}>
          <Play size={14} />{structured ? (active.started ? '继续输入' : '开始输入') : active.started ? '恢复会话' : '启动会话'}</button>}</div>}
    </div>
  </header>;
}
