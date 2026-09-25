import { Copy, CornerDownLeft, TerminalSquare } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { isSessionBusy } from '../../shared/session-activity';
import type { ThemeId } from '../../shared/theme';
import type { ExecutionDescriptor } from '../../shared/execution';
import { configurationSupported, executionUnavailable } from '../EngineConfiguration';
import type { AppState, Session } from '../../shared/types';
import { PromptEditor } from '../PromptEditor';
import { SubtaskPanel } from '../SubtaskPanel';
import { TerminalPane, type TerminalHandle } from '../TerminalPane';
import type { ReportError } from './types';

interface Props {
  executors: ExecutionDescriptor[]; descriptor?: ExecutionDescriptor; disabled: boolean; readOnly: boolean; state: AppState; active: Session; structured: boolean; themeId: ThemeId;
  composer: string; onDraft: (value: string) => void; onSent: (expected: string) => void;
  report: ReportError; onClearError: () => void; children: ReactNode;
}

export function SessionViewport({ state, active, executors, descriptor, disabled, readOnly, structured, themeId, composer, onDraft, onSent, report, onClearError, children }: Props) {
  const activeId = active.id;
  const activeBusy = isSessionBusy(active);
  const latestState = useRef(state); latestState.current = state;
  const handles = useRef(new Map<string, TerminalHandle>());
  const nativePending = useRef(new Set<string>());
  const [nativeSending, setNativeSending] = useState('');
  const [mounted, setMounted] = useState<string[]>([]);
  useEffect(() => {
    const sessions = state?.sessions ?? [];
    setMounted(ids => {
      const terminals = sessions.filter(s => s.execution.mode === 'terminal' && configurationSupported(executors.find(item => item.providerId === s.execution.providerId && item.mode === s.execution.mode), s.engineConfig));
      const live = terminals.filter(s => ['running', 'stopping'].includes(s.status)).map(s => s.id);
      const recent = [activeId, ...ids.filter(id => id !== activeId)].filter(id => terminals.some(s => s.id === id) && !live.includes(id)).slice(0, 3);
      const next = [...new Set([...live, ...recent])]; return next.join('|') === ids.join('|') ? ids : next;
    });
  }, [activeId, state?.sessions, executors]);
  const sendNative = async () => {
    if (disabled || !active || !composer.trim() || active.archived || nativePending.current.has(active.id)) return;
    const current = latestState.current.sessions.find(session => session.id === active.id);
    if (!current || current.status !== 'running') { report(new Error('请先启动或恢复当前终端。')); return; }
    if (current.terminalSync !== 'synced') { report(new Error('当前终端尚未同步任务状态，请使用“粘贴到终端”并在终端确认发送。')); return; }
    if (isSessionBusy(current)) return;
    if (composer.length > 60000) { report(new Error('单次提示词请控制在 60,000 个字符以内。')); return; }
    const handle = handles.current.get(active.id);
    if (!handle) { report(new Error('终端尚未就绪，请稍后再试。')); return; }
    nativePending.current.add(active.id); setNativeSending(active.id); onClearError();
    try { await handle.submit(composer); onSent(composer); }
    catch (error) { report(error); }
    finally { nativePending.current.delete(active.id); setNativeSending(value => value === active.id ? '' : value); }
  };
  return <section className="terminal-section">
    {children}
    <div className="terminals" style={{ display: structured ? 'none' : undefined }}>{mounted.map(id => {
      const session = state.sessions.find(s => s.id === id); return session ? <div className="terminal-slot" key={id} style={{ display: id === activeId ? 'block' : 'none' }}>
        <TerminalPane disabled={!!executionUnavailable(executors.find(item=>item.providerId===session.execution.providerId&&item.mode===session.execution.mode),session)} session={session} themeId={themeId} settings={state.settings} active={id === activeId} onError={report} ref={handle => { if (handle) handles.current.set(id, handle); else handles.current.delete(id); }} />
      </div> : null;
    })}
      {(!active.started || readOnly) && <div className="terminal-empty">
        <TerminalSquare size={30} />
        <h3>{readOnly ? '执行器不可用' : '会话准备就绪'}</h3>
        <p>{readOnly ? '原会话身份、配置和工作目录已保留。' : `启动后，在这里与 ${descriptor?.displayName ?? active.execution.providerId} 直接交互。`}</p>{active.execution.providerId === 'claude' && !readOnly && <small>登录、信任目录与工具审批均在终端内完成</small>}</div>}
    </div>
    {active.kind === 'agent' && !structured && <>
      <SubtaskPanel key={active.id} session={active} />
      <div className="composer">
        <PromptEditor key={active.id} placeholder={active.terminalSync === 'synced' ? '描述任务… Enter 发送，Ctrl / ⌘ + Enter 换行' : '准备提示词… Ctrl / ⌘ + Enter 换行，或直接在终端输入'} value={composer} disabled={active.archived} onChange={onDraft} onSend={() => void sendNative()} />
        <div>
          <span title="Ctrl / ⌘ + Enter 或 Shift + Enter 换行">{active.terminalSync === 'synced' ? 'Enter 发送 · Ctrl / ⌘ + Enter 换行' : '状态未同步：粘贴后请在终端确认并按 Enter 发送。'}</span>{active.terminalSync === 'synced' ? <button className="primary compact" disabled={disabled || active.status !== 'running' || activeBusy || nativeSending === active.id || active.archived || !composer.trim()} onClick={() => void sendNative()}>
            <CornerDownLeft size={13} />发送任务</button> : <button className="secondary compact" disabled={disabled || active.status !== 'running' || active.archived || !composer.trim()} onClick={() => { if (composer.length > 60000) { report(new Error('单次提示词请控制在 60,000 个字符以内。')); return; } const handle = handles.current.get(active.id); if (!handle) { report(new Error('终端尚未就绪，请稍后再试。')); return; } handle.paste(composer); handle.focus(); onDraft(''); }}>
            <Copy size={13} />粘贴到终端</button>}</div>
      </div>
    </>}
  </section>;
}
