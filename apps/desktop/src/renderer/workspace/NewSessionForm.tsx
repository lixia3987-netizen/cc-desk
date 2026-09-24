import { Loader2, Plus, Sparkles, TerminalSquare } from 'lucide-react';
import type { AppState, Capabilities, Effort, NewSession } from '../../shared/types';
import { PermissionModeField } from '../PermissionModeField';

import type { Dispatch, SetStateAction } from 'react';
import type { Perform } from './types';

interface Props {
  state: AppState; cap: Capabilities; draft: NewSession; setDraft: Dispatch<SetStateAction<NewSession>>;
  busy: boolean; perform: Perform; onCreated: (id: string) => void;
}

export function NewSessionForm({ state, cap, draft, setDraft, busy, perform, onCreated }: Props) {
  return <>
    <div className="eyebrow">NEW SESSION</div>
    <h2>{draft.fork ? '创建会话分支' : '开始新的工作'}</h2>
    <p>为这次任务选择项目和运行方式。</p>
    <form onSubmit={event => { event.preventDefault(); void perform(async () => { const session = await window.desktop.createSession({ ...draft, worktreeName: draft.isolated ? draft.worktreeName : undefined, title: draft.title.trim() }); onCreated(session.id); }); }}>
      <label>项目<select aria-label="项目" value={draft.projectId} onChange={e => setDraft({ ...draft, projectId: e.target.value })}>{state.projects.map(p =>
        <option key={p.id} value={p.id}>{p.name} — {p.path}</option>)}</select>
      </label>
      <label>会话名称<input autoFocus maxLength={120} aria-label="会话名称" placeholder={draft.kind === 'agent' && !draft.fork ? '留空，发送首条消息后自动命名' : '例如：重构记忆检索模块'} value={draft.title} onChange={e => setDraft({ ...draft, title: e.target.value })} />
      </label>
      {draft.kind === 'agent' && !draft.fork && <p className="hint">留空会根据首条消息自动命名；手动填写或重命名后会保留你的名称。</p>}
      <div className="segmented">
        <button type="button" className={draft.kind === 'agent' ? 'chosen' : ''} onClick={() => setDraft({ ...draft, kind: 'agent', providerId: 'claude', mode: 'structured' })}>
          <Sparkles size={16} />Claude Code</button>
        <button type="button" disabled={!!draft.fork} className={draft.kind === 'shell' ? 'chosen' : ''} onClick={() => setDraft({ ...draft, kind: 'shell', providerId: 'shell', mode: 'terminal' })}>
          <TerminalSquare size={16} />Shell 终端</button>
      </div>
      {draft.kind === 'agent' && <>
        <label>交互方式<select aria-label="交互方式" value={draft.mode ?? 'structured'} onChange={e => setDraft({ ...draft, mode: e.target.value as 'structured' | 'terminal' })}>
          <option value="structured">结构化对话 · 消息、工具与审批</option>
          <option value="terminal">原生终端 · 完整 CLI 交互</option>
        </select>
        </label>
        <div className="form-grid">
          <label>模型<input aria-label="模型" value={draft.model} placeholder="默认 / opus / sonnet" onChange={e => setDraft({ ...draft, model: e.target.value })} />
          </label>
          <label>推理强度<select aria-label="推理强度" value={draft.effort} onChange={e => setDraft({ ...draft, effort: e.target.value as Effort })}>{cap.efforts.map(e =>
            <option key={e} value={e}>{e === 'default' ? '跟随 CLI 设置' : e}</option>)}</select>
          </label>
        </div>
        <PermissionModeField label="权限模式" value={draft.permissionMode ?? 'default'} disabled={busy} onChange={permissionMode => setDraft({ ...draft, permissionMode })} />{draft.effort === 'ultracode' && <p className="hint">ultracode 由 CLI 定义，不会被替换成 max。模型是否支持仍由 CLI 校验。</p>}</>}
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
      {!cap.available && draft.kind === 'agent' && <p className="hint">可以先创建会话；启动前请在设置中连接 Claude Code。</p>}
      <button className="primary full" disabled={busy || !draft.projectId}>{busy ? <Loader2 size={16} className="spin" /> : <Plus size={16} />}创建会话</button>
    </form>
  </>;
}
