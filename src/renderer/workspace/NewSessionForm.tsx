import { CornerDownLeft, FolderOpen, Loader2, Paperclip, RefreshCw, Sparkles, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { AppState, Attachment, Capabilities, Effort, NewSession } from '../../shared/types';
import type { WorktreeBranch } from '../../shared/git';
import { PermissionModeField } from '../PermissionModeField';
import { PromptEditor } from '../PromptEditor';
import { useChatFileDrop } from '../useChatFileDrop';
import './new-session.css';

interface Props {
  state: AppState; cap: Capabilities; draft: NewSession; setDraft: Dispatch<SetStateAction<NewSession>>;
  busy: boolean; text: string; onText: (value: string) => void; onSend: () => void; onChooseDirectory: () => void;
  created?: boolean; attachments: Attachment[]; attachmentBusy: boolean;
  onAttach: () => void; onDropFiles: (files: File[]) => void; onRemoveAttachment: (path: string) => void;
}

export function NewSessionForm({ state, cap, draft, setDraft, busy, text, onText, onSend, onChooseDirectory, created = false, attachments, attachmentBusy, onAttach, onDropFiles, onRemoveAttachment }: Props) {
  const root = useRef<HTMLDivElement>(null);
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
  useEffect(() => { root.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus(); }, []);
  useEffect(() => {
    setBranches(undefined); setBranchError(''); setBranchesLoading(false);
    if (!created && draft.isolated && draft.projectId) void loadBranches();
    return () => { ++branchRequest.current; };
  }, [created, draft.isolated, draft.projectId, loadBranches]);
  const availableBranches = branches?.projectId === draft.projectId ? branches.values : [];
  const missingBranch = !!draft.worktreeBaseRef && !availableBranches.some(branch => branch.ref === draft.worktreeBaseRef);
  const project = state.projects.find(item => item.id === draft.projectId);
  const configurationBlocked = busy || created;
  const attachmentsBlocked = busy || attachmentBusy;
  const sendBlocked = busy || attachmentBusy || (!text.trim() && !attachments.length) || !project || (!created && draft.isolated && (branchesLoading || missingBranch));
  const send = () => { if (!sendBlocked) onSend(); };
  const { dragging, handlers: dropHandlers } = useChatFileDrop(attachmentsBlocked, onDropFiles);

  return <div ref={root} className="new-session-page" role="region" aria-label="新建会话" {...dropHandlers}>
    {dragging && <div className={'chat-file-drop-overlay' + (attachmentsBlocked ? ' blocked' : '')} role="status">
      <Paperclip size={28} /><strong>{attachmentsBlocked ? attachmentBusy ? '正在添加附件，请稍候' : '当前无法添加附件' : '松开以添加附件'}</strong>
      <span>文件将在发送消息时一同提交。</span>
    </div>}
    <div className="new-session-content">
      <header className="new-session-heading">
        <Sparkles size={26} aria-hidden="true" />
        <h1>{draft.fork ? '继续拓展这个任务' : '今天想完成什么？'}</h1>
        <p>选择工作空间，写下你的任务。</p>
      </header>
      <div className="new-session-configuration">
        <div className="new-session-workspace">
          <label>工作空间<select aria-label="工作空间" title={project?.path} disabled={configurationBlocked} value={draft.projectId} onChange={event => setDraft({ ...draft, projectId: event.target.value, worktreeBaseRef: undefined })}>
            <option value="">请选择工作空间</option>
            {state.projects.map(item => <option key={item.id} value={item.id}>{item.name} — {item.path}</option>)}
          </select></label>
          <button type="button" className="secondary compact" disabled={configurationBlocked} onClick={onChooseDirectory}><FolderOpen size={15} />选择目录</button>
        </div>
        {project && <p className="new-session-project-path" title={project.path}>{project.path}</p>}
        <div className="new-session-options-grid">
          <label>模型<input aria-label="模型" disabled={configurationBlocked} value={draft.model} placeholder="默认 / opus / sonnet" onChange={event => setDraft({ ...draft, model: event.target.value })} /></label>
          <label>推理强度<select aria-label="推理强度" disabled={configurationBlocked} value={draft.effort} onChange={event => setDraft({ ...draft, effort: event.target.value as Effort })}>
            {cap.efforts.map(effort => <option key={effort} value={effort}>{effort === 'default' ? '跟随 CLI 设置' : effort}</option>)}
          </select></label>
          <PermissionModeField label="权限模式" value={draft.permissionMode ?? 'default'} disabled={configurationBlocked} onChange={permissionMode => setDraft({ ...draft, permissionMode })} />
        </div>
        {draft.effort === 'ultracode' && <p className="new-session-note">ultracode 由 CLI 定义，模型是否支持仍由 CLI 校验。</p>}
        <div className="new-session-extra-options">
          <label>会话名称 <span className="new-session-optional">可选</span><input maxLength={120} aria-label="会话名称" disabled={configurationBlocked} placeholder="留空，由 agent 总结首条消息命名" value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })} /></label>
          <label className="new-session-worktree-toggle"><input type="checkbox" disabled={configurationBlocked} checked={draft.isolated} onChange={event => setDraft({ ...draft, isolated: event.target.checked })} /><span>创建独立 Git worktree<small>在独立目录中工作</small></span></label>
        </div>
        {draft.isolated && <div className="new-session-worktree-options">
          <div className="new-session-workspace">
            <label>起始分支<select aria-label="起始分支" aria-describedby="new-worktree-branch-help" value={draft.worktreeBaseRef ?? ''} disabled={configurationBlocked || branchesLoading || !project} onChange={event => setDraft({ ...draft, worktreeBaseRef: event.target.value || undefined })}>
              <option value="">当前工作目录 HEAD</option>
              {missingBranch && <option value={draft.worktreeBaseRef} disabled>{created ? draft.worktreeBaseRef : '所选分支不可用，请重新选择'}</option>}
              <optgroup label="本地分支">{availableBranches.filter(branch => !branch.remote).map(branch => <option key={branch.ref} value={branch.ref}>{branch.name}</option>)}</optgroup>
              <optgroup label="远程分支">{availableBranches.filter(branch => branch.remote).map(branch => <option key={branch.ref} value={branch.ref}>{branch.name}</option>)}</optgroup>
            </select></label>
            <button type="button" className="secondary compact" disabled={configurationBlocked || branchesLoading || !project} onClick={() => void loadBranches(true)}>{branchesLoading ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}刷新远程分支</button>
          </div>
          <p className="new-session-note" id="new-worktree-branch-help">可从本地或远程分支创建；远程分支会在创建时拉取最新提交。不带入未提交改动，合入目标仍是创建时所在分支。</p>
          {branchError && <p className="new-session-note" role="alert">分支读取失败：{branchError}。可刷新重试，或从当前 HEAD 创建。</p>}
          <label>Worktree 名称<input aria-label="Worktree 名称" aria-describedby="new-worktree-name-help new-worktree-location-hint" disabled={configurationBlocked} maxLength={80} value={draft.worktreeName ?? ''} placeholder="留空使用随机 ID" onChange={event => setDraft({ ...draft, worktreeName: event.target.value })} /></label>
          <p className="new-session-note" id="new-worktree-name-help">可选；留空使用随机 ID。自定义名称不要包含 /、\ 或 ..，目录名会自动追加短标识。</p>
          <p className="new-session-note" id="new-worktree-location-hint">{state.settings.worktreeLocation === 'custom' ? <>统一目录：<code>{state.settings.worktreeRoot}</code>，按「项目名-短标识 / 随机 ID 或自定义名称-短标识」创建。</> : <>项目目录内：<code>{'.claude/worktrees/<随机 ID 或自定义名称-短标识>'}</code>（相对于 Git 根目录）。</>}可在设置中调整。</p>
        </div>}
      </div>
      {!cap.available && <p className="new-session-note">尚未连接 Claude Code。消息可以提交到队列；执行前请在设置中连接，失败后可重试。</p>}
      <div className="composer chat-composer new-session-composer">
        {attachments.length > 0 && <div className="attachment-chips">{attachments.map(file => <span key={file.path} title={file.path}><Paperclip size={12} /><span className="new-session-attachment-name">{file.name}</span><button type="button" className="icon-button" aria-label={'移除附件 ' + file.name} disabled={attachmentsBlocked} onClick={() => onRemoveAttachment(file.path)}><X size={12} /></button></span>)}</div>}
        {attachmentBusy && <p className="attachment-import-status" role="status"><Loader2 size={12} className="spin" />正在添加待发送附件…可以继续编辑消息。</p>}
        <PromptEditor placeholder="描述你的任务…" value={text} disabled={busy} onChange={onText} onSend={send} />
        <div className="chat-composer-actions">
          <button type="button" className="icon-button" title="添加附件，也可将文件拖入此处" aria-label="添加附件" disabled={attachmentsBlocked} onClick={onAttach}><Paperclip size={16} /></button>
          <span>Enter 发送 · Ctrl / ⌘ + Enter 换行{attachments.length > 0 && ` · ${attachments.length} 个附件`}</span>
          <button type="button" className="primary compact" disabled={sendBlocked} onClick={send}>{busy || attachmentBusy ? <Loader2 size={14} className="spin" /> : <CornerDownLeft size={14} />}{attachmentBusy ? '添加附件中…' : busy ? '提交中…' : '发送任务'}</button>
        </div>
      </div>
    </div>
  </div>;
}
