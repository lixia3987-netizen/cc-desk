import { CornerDownLeft, FolderOpen, Loader2, Paperclip, RefreshCw, Sparkles } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { AppState, Attachment } from '../../shared/types';
import type { ExecutionDescriptor } from '../../shared/execution';
import type { SessionDraft } from './types';
import type { WorktreeBranch } from '../../shared/git';
import { configurationSupported, EngineConfigFields, newSessionEngineDefaults } from '../EngineConfiguration';
import { engineFieldsForGroup } from '../settings-organization';
import { ChatAttachmentChips } from '../NativeImageAttachments';
import { PromptEditor } from '../PromptEditor';
import { useChatFileDrop } from '../useChatFileDrop';
import './new-session.css';

interface Props {
  state: AppState; executors: ExecutionDescriptor[]; draft: SessionDraft; setDraft: Dispatch<SetStateAction<SessionDraft>>;
  busy: boolean; text: string; onText: (value: string) => void; onSend: () => void; onChooseDirectory: () => void;
  onOpenSettings: () => void;
  created?: boolean; attachments: Attachment[]; attachmentBusy: boolean;
  onPreviewAttachment?: (file: Attachment) => void;
  onPasteImages?: (files: File[], canContinue: () => boolean) => void;
  onAttach: () => void; onDropFiles: (files: File[]) => void; onRemoveAttachment: (path: string) => void;
}

export function NewSessionForm({ state, executors, draft, setDraft, busy, text, onText, onSend, onChooseDirectory, onOpenSettings, created = false, attachments, attachmentBusy, onAttach, onDropFiles, onRemoveAttachment, onPasteImages, onPreviewAttachment }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const descriptor = executors.find(item => item.providerId === draft.providerId && item.mode === 'structured');
  const providers = executors.filter(item => item.mode === 'structured' && item.capabilities.structured);
  const supported = configurationSupported(descriptor, draft.engineConfig);
  const engineBlocked = !descriptor || !supported || !!descriptor.maintenance || (!!draft.fork && !descriptor.capabilities.fork);
  const isNative = draft.providerId === 'native';
  // Pending imports reserve the owner in App. The originating paste remains valid
  // while that import is busy, but changing its project/configuration invalidates it.
  const pasteIdentity = JSON.stringify([draft.projectId, draft.providerId, draft.mode, draft.engineConfig]);
  const pasteScope = useRef({ identity: pasteIdentity, generation: 0, enabled: false });
  if (pasteScope.current.identity !== pasteIdentity) pasteScope.current = { identity: pasteIdentity, generation: pasteScope.current.generation + 1, enabled: false };
  pasteScope.current.enabled = isNative && !!descriptor?.capabilities.attachments && !busy && !engineBlocked;
  const chooseProvider = (providerId: string) => {
    const next = providers.find(item => item.providerId === providerId);
    if (!next || busy || created || attachmentBusy || draft.fork || attachments.length) return;
    setDraft({ ...draft, kind: 'agent', providerId, mode: 'structured', engineConfig: newSessionEngineDefaults(next, state.settings), conversationId: undefined, fork: false });
  };
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
  const configurationBlocked = busy || created || attachmentBusy;
  const attachmentsBlocked = busy || attachmentBusy || engineBlocked || !descriptor?.capabilities.attachments;
  const sendBlocked = busy || attachmentBusy || engineBlocked || (attachments.length > 0 && !descriptor?.capabilities.attachments) || (!text.trim() && !attachments.length) || !project || (!created && draft.isolated && (branchesLoading || missingBranch));
  const send = () => { if (!sendBlocked) onSend(); };
  const pasteImages = onPasteImages && isNative && !attachmentsBlocked ? (files: File[]) => {
    if (!pasteScope.current.enabled || attachmentBusy) return;
    const generation = pasteScope.current.generation;
    onPasteImages(files, () => mounted.current && pasteScope.current.enabled && pasteScope.current.generation === generation);
  } : undefined;
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
        <div className="segmented" role="group" aria-label="执行引擎">
          {providers.map(item => <button key={item.providerId} type="button" disabled={configurationBlocked || !!draft.fork || attachments.length > 0} className={draft.providerId === item.providerId ? 'chosen' : ''} onClick={() => chooseProvider(item.providerId)}><Sparkles size={16} />{item.displayName ?? item.providerId}</button>)}
        </div>
        {attachments.length > 0 && <p className="new-session-note">移除待发送附件后可以切换执行引擎。</p>}
        {isNative && <div className="new-session-options-grid"><EngineConfigFields value={draft.engineConfig} fields={engineFieldsForGroup(descriptor, 'model', draft.engineConfig)} disabled={configurationBlocked || engineBlocked} onChange={engineConfig => setDraft({ ...draft, engineConfig })} /></div>}
        <div className="new-session-workspace"><p className="new-session-note">{isNative ? '上下文、自动压缩与运行限制在设置中管理。' : '运行权限与默认配置在设置中管理。'}</p><button type="button" className="secondary compact" disabled={busy || attachmentBusy} onClick={onOpenSettings}>新会话设置</button></div>
        <details className="new-session-more-options" open={draft.isolated || !!draft.title || !!draft.worktreeName}><summary>更多选项</summary>
        <div className="new-session-extra-options">
          <label>会话名称 <span className="new-session-optional">可选</span><input maxLength={120} aria-label="会话名称" disabled={configurationBlocked} placeholder={isNative ? '留空使用默认名称，可稍后重命名' : '留空，由 agent 总结首条消息命名'} value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })} /></label>
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
        </details>
      </div>
      {!descriptor && <p className="new-session-note">所选执行引擎尚未安装，请选择已安装的引擎。</p>}
      {descriptor && !supported && <p className="new-session-note">此引擎不支持当前配置版本，原配置已保留。</p>}
      {descriptor?.maintenance ? <p className="new-session-note">{descriptor.displayName ?? descriptor.providerId} 正在维护，请等待完成后再发送。</p> : descriptor && !descriptor.capabilities.available && <p className="new-session-note">尚未连接 {descriptor.displayName ?? descriptor.providerId}。消息可以提交到队列；执行前请在设置中连接，失败后可重试。</p>}
      <div className="composer chat-composer new-session-composer">
        <ChatAttachmentChips attachments={attachments} isNative={isNative} disabled={attachmentsBlocked} onRemove={onRemoveAttachment} onPreview={isNative ? onPreviewAttachment : undefined} previewTitle="本地预览当前选择版本（尚未保存）" />
        {attachmentBusy && <p className="attachment-import-status" role="status"><Loader2 size={12} className="spin" />正在添加待发送附件…可以继续编辑消息。</p>}
        <PromptEditor placeholder="描述你的任务…" value={text} disabled={busy} onChange={onText} onSend={send} onPasteFiles={pasteImages} />
        <div className="chat-composer-actions">
          <button type="button" className="icon-button" title={isNative ? "添加 PNG / JPEG，也可拖入或在输入框中粘贴图片" : "添加附件，也可将文件拖入此处"} aria-label="添加附件" disabled={attachmentsBlocked} onClick={onAttach}><Paperclip size={16} /></button>
          <span>Enter 发送 · Ctrl / ⌘ + Enter 换行{attachments.length > 0 && ` · ${attachments.length} 个附件`}</span>
          <button type="button" className="primary compact" disabled={sendBlocked} onClick={send}>{busy || attachmentBusy ? <Loader2 size={14} className="spin" /> : <CornerDownLeft size={14} />}{attachmentBusy ? '添加附件中…' : busy ? '提交中…' : '发送任务'}</button>
        </div>
      </div>
    </div>
  </div>;
}
