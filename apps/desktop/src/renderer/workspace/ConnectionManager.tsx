import { Loader2, Plug, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ExecutionDescriptor } from '../../shared/execution';
import { configurationSupported } from '../EngineConfiguration';
import type { Project, Session } from '../../shared/types';
import { Dialog } from '../Dialog';
import { sessionColor, sessionLabel } from './presentation';
import './connections.css';

export function ConnectionManager({ sessions, projects, executors, limit, disabled, onSelect, onError }: {
  sessions: Session[]; projects: Project[]; executors: ExecutionDescriptor[]; limit: number; disabled: boolean;
  onSelect: (session: Session) => void; onError: (error: unknown) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState('');
  const inFlight = useRef(new Set<string>()), mounted = useRef(true);
  const currentSessions = useRef(sessions); currentSessions.current = sessions;
  // Include resident idle connections and stopping processes across every project/filter.
  const connected = sessions.filter(session => session.status === 'running' || session.status === 'stopping');
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let changed = false;
    for (const id of inFlight.current) {
      if (!sessions.some(session => session.id === id && (session.status === 'running' || session.status === 'stopping'))) {
        inFlight.current.delete(id); changed = true;
      }
    }
    if (changed) setPending(new Set(inFlight.current));
  }, [sessions]);
  const closeConnection = async (session: Session) => {
    const current = currentSessions.current.find(item => item.id === session.id);
    const descriptor = executors.find(item => item.providerId === current?.execution.providerId && item.mode === current?.execution.mode);
    if (disabled || inFlight.current.has(session.id) || current?.status !== 'running' || !configurationSupported(descriptor, current.engineConfig)) return;
    inFlight.current.add(session.id); setPending(new Set(inFlight.current)); setError('');
    try {
      await window.desktop.stopSession(session.id);
      // Keep the row disabled until the authoritative state confirms the process stopped.
    } catch (cause) {
      inFlight.current.delete(session.id);
      if (mounted.current) {
        setPending(new Set(inFlight.current));
        const message = cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(cause);
        setError(`无法关闭「${session.title}」：${message}`);
        onError(cause);
      }
    }
  };
  return <>
    <button className="connection-trigger" aria-label={`查看已连接会话，${connected.length} 个连接`} aria-haspopup="dialog" aria-expanded={open}
      title="查看所有已连接会话，并关闭指定连接" onClick={() => setOpen(true)}>
      <Plug size={12} />{connected.length} / {limit} 已连接
    </button>
    {open && <Dialog className="connections-dialog" label="已连接会话" onClose={() => setOpen(false)}>
      <div className="modal-title"><h2>已连接会话 <small>{connected.length} / {limit}</small></h2>
        <button className="icon-button" aria-label="关闭连接列表" onClick={() => setOpen(false)}><X size={18} /></button>
      </div>
      <p className="panel-note">包含所有项目中正在执行或保留连接的会话；Native 在任务运行期间占用连接名额。关闭连接会停止该会话的任务与工作流，保留聊天记录和草稿。</p>
      {error && <p className="chat-error" role="alert">{error}</p>}
      {!connected.length && <p className="list-empty" role="status">当前没有已连接的会话。</p>}
      <ul className="connection-list">{connected.map(session => {
        const project = projects.find(item => item.id === session.projectId);
        const descriptor = executors.find(item => item.providerId === session.execution.providerId && item.mode === session.execution.mode);
        const readOnly = !configurationSupported(descriptor, session.engineConfig);
        const closing = pending.has(session.id) || session.status === 'stopping';
        return <li key={session.id} data-connection-session-id={session.id}>
          <button className="connection-session" title={`${session.title}\n${session.cwd}`} onClick={() => { setOpen(false); onSelect(session); }}>
            <span className={`dot ${sessionColor(session)}`} />
            <span className="connection-details"><strong>{session.title}</strong>
              <small>{project?.name ?? '原项目已移除'} · {descriptor?.displayName ?? session.execution.providerId} · {session.execution.mode === 'structured' ? '结构化对话' : '终端'}</small>
              <small className="connection-path" title={session.cwd}>{session.cwd}</small>
              <small className="connection-state">{closing ? '正在关闭连接…' : sessionLabel(session)}</small>
            </span>
          </button>
          <button className="secondary compact connection-close" disabled={disabled || closing || readOnly} aria-label={`关闭会话「${session.title}」的连接`}
            title={readOnly ? "执行器或配置不可用，保留记录" : "停止此会话并关闭连接，保留记录"} onClick={() => void closeConnection(session)}>
            {closing ? <Loader2 size={14} className="spin" /> : <X size={14} />}{closing ? '关闭中' : '关闭连接'}
          </button>
        </li>;
      })}</ul>
    </Dialog>}
  </>;
}
