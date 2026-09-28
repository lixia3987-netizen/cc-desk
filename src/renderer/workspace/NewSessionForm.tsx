import { Loader2, Plus, RefreshCw, Sparkles, TerminalSquare } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppState, Capabilities, Effort, NewSession } from '../../shared/types';
import type { WorktreeBranch } from '../../shared/git';
import { PermissionModeField } from '../PermissionModeField';

import type { Dispatch, SetStateAction } from 'react';
import type { Perform } from './types';

interface Props {
  state: AppState; cap: Capabilities; draft: NewSession; setDraft: Dispatch<SetStateAction<NewSession>>;
  busy: boolean; perform: Perform; onCreated: (id: string) => void;
}

export function NewSessionForm({ state, cap, draft, setDraft, busy, perform, onCreated }: Props) {
  const [branches, setBranches] = useState<{ projectId: string; values: WorktreeBranch[] }>();
  const [branchError, setBranchError] = useState('');
  const [branchesLoading, setBranchesLoading] = useState(false);
  const branchRequest = useRef(0);
  const loadBranches = useCallback(async (refresh = false) => {
    const request = ++branchRequest.current;
    setBranchesLoading(true); setBranchError('');
    try {
      const values = await window.desktop.listWorktreeBranches(draft.projectId, refresh);
      if (request === branchRequest.current) setBranches({ projectId: draft.projectId, values });
    } catch (error) {
      if (request === branchRequest.current) setBranchError(error instanceof Error ? error.message : String(error));
    } finally {
      if (request === branchRequest.current) setBranchesLoading(false);
    }
  }, [draft.projectId]);
  useEffect(() => {
    setBranches(undefined); setBranchError(''); setBranchesLoading(false);
    if (draft.isolated && draft.projectId) void loadBranches();
    return () => { ++branchRequest.current; };
  }, [draft.isolated, draft.projectId, loadBranches]);
  const availableBranches = branches?.projectId === draft.projectId ? branches.values : [];
  const missingBranch = !!draft.worktreeBaseRef && !availableBranches.some(branch => branch.ref === draft.worktreeBaseRef);
  const creationBlocked = busy || !draft.projectId || (draft.isolated && (branchesLoading || missingBranch));
  return <>
    <div className="eyebrow">NEW SESSION</div>
    <h2>{draft.fork ? '创建会话分支' : '开始新的工作'}</h2>
    <p>为这次任务选择项目和运行方式。</p>
    <form onSubmit={event => { event.preventDefault(); if (creationBlocked) return; void perform(async () => { const session = await window.desktop.createSession({ ...draft, worktreeName: draft.isolated ? draft.worktreeName : undefined, worktreeBaseRef: draft.isolated ? draft.worktreeBaseRef : undefined, title: draft.title.trim() }); onCreated(session.id); }); }}>
      <label>项目<select aria-label="项目" disabled={busy} value={draft.projectId} onChange={e => setDraft({ ...draft, projectId: e.target.value, worktreeBaseRef: undefined })}>{state.projects.map(p =>
        <option key={p.id} value={p.id}>{p.name} — {p.path}</option>)}</select>
      </label>
      <label>会话名称<input autoFocus maxLength={120} aria-label="会话名称" placeholder={draft.kind === 'agent' && !draft.fork ? '留空，发送首条消息后自动命名' : '例如：重构记忆检索模块'} value={draft.title} onChange={e => setDraft({ ...draft, title: e.target.value })} />
      </label>
      {draft.kind === 'agent' && !draft.fork && <p className="hint">留空后由 agent 根据首条消息快速总结名称；手动填写或重命名后会保留你的名称。</p>}
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
        <span>创建独立 Git worktree<small>可选择本地或远程分支作为起点；不带入未提交改动。</small>
        </span>
      </label>
      {draft.isolated && <div className="worktree-session-options">
        <label>起始分支<select aria-label="起始分支" aria-describedby="worktree-branch-help" value={draft.worktreeBaseRef ?? ''} disabled={busy || branchesLoading} onChange={event => setDraft({ ...draft, worktreeBaseRef: event.target.value || undefined })}>
          <option value="">当前工作目录 HEAD</option>
          {missingBranch && <option value={draft.worktreeBaseRef} disabled>所选分支不可用，请重新选择</option>}
          <optgroup label="本地分支">{availableBranches.filter(branch => !branch.remote).map(branch => <option key={branch.ref} value={branch.ref}>{branch.name}</option>)}</optgroup>
          <optgroup label="远程分支">{availableBranches.filter(branch => branch.remote).map(branch => <option key={branch.ref} value={branch.ref}>{branch.name}</option>)}</optgroup>
        </select></label>
        <button type="button" className="secondary compact" disabled={busy || branchesLoading} onClick={() => void loadBranches(true)}>{branchesLoading ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}刷新远程分支</button>
        <p className="hint" id="worktree-branch-help">远程列表来自本地缓存，可刷新获取新分支；创建时会拉取所选远程分支的最新提交。主项目不会切换分支，合入目标仍是创建时所在分支。</p>
        {branchError && <p className="hint" role="alert">分支读取失败：{branchError}。可重试刷新，或从当前 HEAD 创建。</p>}
        <label>Worktree 名称<input aria-label="Worktree 名称" aria-describedby="worktree-name-help worktree-location-hint" disabled={busy} maxLength={80} value={draft.worktreeName ?? ''} placeholder="留空使用随机 ID" onChange={event => setDraft({ ...draft, worktreeName: event.target.value })} />
        </label>
        <p className="hint" id="worktree-name-help">可选；留空使用随机 ID。自定义名称不要包含 /、\ 或 ..，目录名会自动追加短标识。</p>
        <p className="hint worktree-location-hint" id="worktree-location-hint">{state.settings.worktreeLocation === 'custom' ? <>统一目录：<code>{state.settings.worktreeRoot}</code>
          <br />按「项目名-短标识 / 随机 ID 或自定义名称-短标识」创建子目录。</> : <>项目目录内：<code>{'.claude/worktrees/<随机 ID 或自定义名称-短标识>'}</code>（相对于 Git 根目录）。</>}可在「设置与连接」中调整。</p>
      </div>}
      {!cap.available && draft.kind === 'agent' && <p className="hint">可以先创建会话；启动前请在设置中连接 Claude Code。</p>}
      <button className="primary full" disabled={creationBlocked}>{busy ? <Loader2 size={16} className="spin" /> : <Plus size={16} />}创建会话</button>
    </form>
  </>;
}
