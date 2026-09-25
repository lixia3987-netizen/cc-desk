import { Loader2, Plus, Sparkles, TerminalSquare } from 'lucide-react';
import type { AppState } from '../../shared/types';
import type { ExecutionDescriptor } from '../../shared/execution';
import { EngineConfigFields, configurationSupported, engineDefaults } from '../EngineConfiguration';

import type { Dispatch, SetStateAction } from 'react';
import type { Perform, SessionDraft } from './types';

interface Props {
  state: AppState; executors: ExecutionDescriptor[]; draft: SessionDraft; setDraft: Dispatch<SetStateAction<SessionDraft>>;
  busy: boolean; perform: Perform; onCreated: (id: string) => void;
}

export function NewSessionForm({ state, executors, draft, setDraft, busy, perform, onCreated }: Props) {
  const descriptor = executors.find(item => item.providerId === draft.providerId && item.mode === draft.mode);
  const providers = [...new Map(executors.map(item => [item.providerId, item])).values()];
  const modes = executors.filter(item => item.providerId === draft.providerId);
  const supported = configurationSupported(descriptor, draft.engineConfig);
  const blocked = busy || !descriptor || !supported || descriptor.maintenance || (!!draft.fork && !descriptor.capabilities.fork);
  const chooseProvider = (providerId: string) => {
    const next = executors.find(item => item.providerId === providerId && item.mode === 'structured') ?? executors.find(item => item.providerId === providerId);
    if (!next || draft.fork) return;
    setDraft({ ...draft, kind: providerId === 'shell' ? 'shell' : 'agent', providerId, mode: next.mode,
      engineConfig: engineDefaults(next, state.settings), conversationId: undefined, fork: false });
  };
  return <>
    <div className="eyebrow">NEW SESSION</div>
    <h2>{draft.fork ? '创建会话分支' : '开始新的工作'}</h2>
    <p>为这次任务选择项目和运行方式。</p>
    <form onSubmit={event => { event.preventDefault(); if (blocked) return; void perform(async () => { const session = await window.desktop.createSession({ ...draft, worktreeName: draft.isolated ? draft.worktreeName : undefined, title: draft.title.trim() }); onCreated(session.id); }); }}>
      <label>项目<select aria-label="项目" value={draft.projectId} onChange={e => setDraft({ ...draft, projectId: e.target.value })}>{state.projects.map(p =>
        <option key={p.id} value={p.id}>{p.name} — {p.path}</option>)}</select>
      </label>
      <label>会话名称<input autoFocus maxLength={120} aria-label="会话名称" placeholder={draft.kind === 'agent' && !draft.fork ? '留空，发送首条消息后自动命名' : '例如：重构记忆检索模块'} value={draft.title} onChange={e => setDraft({ ...draft, title: e.target.value })} />
      </label>
      {draft.kind === 'agent' && !draft.fork && <p className="hint">留空会根据首条消息自动命名；手动填写或重命名后会保留你的名称。</p>}
      <div className="segmented">
        {providers.map(item => <button key={item.providerId} type="button" disabled={busy || !!draft.fork} className={draft.providerId === item.providerId ? 'chosen' : ''} onClick={() => chooseProvider(item.providerId)}>
          {item.providerId === 'shell' ? <TerminalSquare size={16} /> : <Sparkles size={16} />}{item.displayName ?? item.providerId}</button>)}
      </div>
      {draft.kind === 'agent' && <>
        <label>交互方式<select aria-label="交互方式" disabled={busy || !!draft.fork} value={draft.mode ?? 'structured'} onChange={e => setDraft({ ...draft, mode: e.target.value as 'structured' | 'terminal' })}>
          {modes.map(item => <option key={item.mode} value={item.mode}>{item.mode === 'structured' ? '结构化对话 · 消息、工具与审批' : '原生终端 · 完整 CLI 交互'}</option>)}
        </select>
        </label>
        <EngineConfigFields value={draft.engineConfig} fields={descriptor?.configuration?.fields ?? []} disabled={!!blocked} onChange={engineConfig => setDraft({ ...draft, engineConfig })} />
        {draft.providerId === 'claude' && draft.engineConfig.options.effort === 'ultracode' && <p className="hint">ultracode 由 CLI 定义，不会被替换成 max。模型是否支持仍由 CLI 校验。</p>}</>}
      <label className="checkbox">
        <input type="checkbox" disabled={busy} checked={draft.isolated} onChange={e => setDraft({ ...draft, isolated: e.target.checked })} />
        <span>创建独立 Git worktree<small>从当前 HEAD 创建新分支；不带入未提交改动。</small>
        </span>
      </label>
      {draft.isolated && <div className="worktree-session-options">
        <label>Worktree 名称<input aria-label="Worktree 名称" aria-describedby="worktree-name-help worktree-location-hint" disabled={busy} maxLength={80} value={draft.worktreeName ?? ''} placeholder="留空使用会话名称" onChange={event => setDraft({ ...draft, worktreeName: event.target.value })} />
        </label>
        <p className="hint" id="worktree-name-help">可选；名称不要包含 /、\ 或 ..。目录名会自动追加短标识，避免重名。</p>
        <p className="hint worktree-location-hint" id="worktree-location-hint">{state.settings.worktreeLocation === 'custom' ? <>统一目录：<code>{state.settings.worktreeRoot}</code>
          <br />按「项目名-短标识 / Worktree 名称-短标识」创建子目录。</> : <>项目目录内：<code>{'.claude/worktrees/<Worktree 名称>-<短标识>'}</code>（相对于 Git 根目录）。</>}可在「设置与连接」中调整。</p>
      </div>}
      {!descriptor && <p className="hint">所选执行引擎尚未安装，请选择已安装的引擎。</p>}
      {descriptor && !supported && <p className="hint">此引擎不支持当前配置版本，原配置已保留。</p>}
      {descriptor?.maintenance ? <p className="hint">{descriptor.displayName ?? descriptor.providerId} 正在维护，完成后可以创建会话。</p> : descriptor && !descriptor.capabilities.available && <p className="hint">可以先创建会话；启动前请在设置中连接 {descriptor.displayName ?? descriptor.providerId}。{descriptor.capabilities.error}</p>}
      <button className="primary full" disabled={!!blocked || !draft.projectId}>{busy ? <Loader2 size={16} className="spin" /> : <Plus size={16} />}创建会话</button>
    </form>
  </>;
}
