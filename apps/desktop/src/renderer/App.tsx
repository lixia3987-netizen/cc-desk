import { Check, Command, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { version as appVersion } from '../../package.json';
import { cliUpdateBusy, type CLIUpdateState } from '../shared/cli-update';
import type { ExecutionDescriptor } from '../shared/execution';
import { isSessionBusy } from '../shared/session-activity';
import type { AppState, Attachment, Capabilities, Session } from '../shared/types';
import { ChatPane } from './ChatPane';
import { configurationSupported, engineDefaults, executionUnavailable } from './EngineConfiguration';
import type { SessionDraft } from './workspace/types';
import { CLIUpdateNotice } from './CLIUpdateNotice';
import { Dialog } from './Dialog';
import { FilePicker } from './ProjectPanels';
import { SessionSelection } from './selection';
import { SettingsPanel } from './SettingsPanel';
import { CommandPalette } from './workspace/CommandPalette';
import { HistoryImport } from './workspace/HistoryImport';
import { NewSessionForm } from './workspace/NewSessionForm';
import { RenameSession } from './workspace/RenameSession';
import { SessionInspector } from './workspace/SessionInspector';
import { SessionSidebar } from './workspace/SessionSidebar';
import { SessionViewport } from './workspace/SessionViewport';
import { useHistorySearch } from './workspace/useHistorySearch';
import { useSessionDrafts } from './workspace/useSessionDrafts';
import { useSessionMemory } from './workspace/useSessionMemory';
import { useWorkspacePreferences } from './workspace/useWorkspacePreferences';
import { WorkspaceHeader } from './workspace/WorkspaceHeader';
import { WorkspaceWelcome } from './workspace/WorkspaceWelcome';

type Modal = 'new' | 'settings' | 'history' | 'rename' | 'palette' | null;


export function App() {
  const [state, setState] = useState<AppState>();
  const [executors, setExecutors] = useState<ExecutionDescriptor[]>([]);
  const [cap, setCap] = useState<Capabilities>({ available: false, executable: '', version: '', flags: [], efforts: ['default'] });
  const [cliUpdate, setCLIUpdate] = useState<CLIUpdateState>({ phase: 'idle', message: '等待检查 Claude Code 更新。', showBanner: false });
  const cliUpdateEvents = useRef(0), executorEvents = useRef(0);
  const [cliActionBusy, setCLIActionBusy] = useState(false);
  const cliActionPending = useRef(false);
  const [projectId, setProjectId] = useState('all');
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());
  const expandGroup = useCallback((id: string) => setCollapsedGroups(current => {
    if (!current.has(id)) return current;
    const next = new Set(current); next.delete(id); return next;
  }), []);
  const toggleGroup = (id: string) => setCollapsedGroups(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const [activeId, setActiveId] = useState('');
  const [attentionTarget, setAttentionTarget] = useState<{ sessionId: string; requestId: string; nonce: number }>();
  const attentionNonce = useRef(0);
  const [search, setSearch] = useState('');
  const [archived, setArchived] = useState(false);
  const [modal, setModal] = useState<Modal>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [operationBusy, setBusy] = useState(false);
  const busy = operationBusy;
  const latestBusy = useRef(busy); latestBusy.current = busy;
  const latestState = useRef(state); latestState.current = state;
  const selection = useRef(new SessionSelection());
  const stateEvents = useRef(0);
  const latestActiveId = useRef(activeId); latestActiveId.current = activeId;
  const [filePicker, setFilePicker] = useState('');
  const [attachments, setAttachments] = useState<Record<string, Attachment[]>>({});
  const attachmentRevisions = useRef(new Map<string, number>());
  const pendingAttachmentImports = useRef(new Set<string>());
  const [attachmentImports, setAttachmentImports] = useState<Set<string>>(() => new Set());
  const changeAttachments = useCallback((id: string, change: (files: Attachment[]) => Attachment[]) => {
    attachmentRevisions.current.set(id, (attachmentRevisions.current.get(id) ?? 0) + 1);
    setAttachments(old => ({ ...old, [id]: change(old[id] ?? []) }));
  }, []);
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [paletteQuery, setPaletteQuery] = useState('');
  const [dataPath, setDataPath] = useState('');
  const [platform, setPlatform] = useState('');
  const [rename, setRename] = useState('');
  const [draft, setDraft] = useState<SessionDraft>({ projectId: '', title: '', kind: 'agent', providerId: 'claude', engineConfig: { schemaVersion: 1, options: {} }, isolated: false, mode: 'structured' });
  const report = useCallback((error: unknown) => setError(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error)), []);
  const { drafts, saveDraftFor, clearSentDraft, flushDrafts, persistDrafts, appendDraft } = useSessionDrafts(latestState, report);
  const { approvalDrafts, panelDrafts, readingPositions, retainSessions, updatePanel } = useSessionMemory(latestState, report);
  const active = state?.sessions.find(s => s.id === activeId);
  const composer = active ? (drafts[active.id] ?? active.draft ?? '') : '';
  const structured = active?.execution.mode === 'structured';
  const descriptor = executors.find(executor => executor.providerId === active?.execution.providerId && executor.mode === active?.execution.mode);
  const executionCapabilities = descriptor?.capabilities;
  const unavailable = active ? executionUnavailable(descriptor, active) : undefined;
  const readOnly = !!active && !configurationSupported(descriptor, active.engineConfig);
  const historySources = executors.filter(item => item.history);
  const activeBusy = !!active && isSessionBusy(active);
  const project = state?.projects.find(p => p.id === (active?.projectId ?? projectId));
  const applyState = useCallback((value: AppState) => {
    latestState.current = value; setState(value); retainSessions(value.sessions.map(session => session.id));
    const id = selection.current.receive(value.selectedSessionId);
    setProjectId(current => current === 'all' || value.projects.some(project => project.id === current) ? current : 'all');
    if (id !== undefined) {
      const selected = value.sessions.find(session => session.id === id);
      setActiveId(selected?.id ?? ''); setDeleteConfirm('');
      if (selected) { setProjectId('all'); setArchived(selected.archived); setSearch(''); expandGroup(selected.projectId); }
    }
  }, [expandGroup, retainSessions]);
  const refresh = useCallback(async () => {
    const revision = stateEvents.current, updateRevision = cliUpdateEvents.current, executorRevision = executorEvents.current;
    const snapshot = await window.desktop.snapshot();
    if (revision === stateEvents.current) applyState(snapshot.state);
    if (updateRevision === cliUpdateEvents.current) setCLIUpdate(snapshot.cliUpdate);
    setCap(snapshot.capabilities); if (executorRevision === executorEvents.current) setExecutors(snapshot.executors);
    setDataPath(snapshot.dataPath); setPlatform(snapshot.platform);
  }, [applyState]);
  const perform = useCallback(async (action: () => Promise<unknown>) => {
    setError(''); setBusy(true);
    try { await action(); } catch (error) { report(error); } finally { setBusy(false); }
  }, [report]);
  const preferences = useWorkspacePreferences({ settings: state?.settings, open: modal === 'settings', refresh, perform, report, notify: setNotice });
  const { themeId, value: draftSettings } = preferences;
  const { historyQuery, setHistoryQuery, historyNext, history, historyBusy, resetHistory, moreHistory } = useHistorySearch(draft.projectId, draft.providerId ?? '', modal === 'history' && historySources.some(item => item.providerId === draft.providerId), perform, report);
  useEffect(() => {
    if (!window.desktop) { setError('请使用 npm run dev 或已安装的桌面应用打开此界面。'); return; }
    void refresh().catch(report);
    const offState = window.desktop.onState(value => { stateEvents.current++; applyState(value); });
    const approvalRequests = new Map<string, number>(); let disposed = false;
    const offChat = window.desktop.onChat(id => {
      if (id === latestActiveId.current || !approvalDrafts.current.has(id)) return;
      const seq = (approvalRequests.get(id) ?? 0) + 1;
      approvalRequests.set(id, seq);
      void window.desktop.chatSnapshot(id).then(value => {
        if (!disposed && approvalRequests.get(id) === seq && id !== latestActiveId.current)
          approvalDrafts.current.reconcile(id, value.pending);
      }).catch(report);
    });
    const offError = window.desktop.onError(message => report(new Error(message)));
    const offNavigate = window.desktop.onNavigate(id => {
      const selected = latestState.current?.sessions.find(session => session.id === id);
      if (!selected) return;
      selection.current.navigate(id); setActiveId(id); setDeleteConfirm('');
      setProjectId('all'); setArchived(selected.archived); setSearch(''); expandGroup(selected.projectId);
    });
    const offCapabilities = window.desktop.onCapabilities(value => { setCap(value); void refresh().catch(report); });
    const offExecutors = window.desktop.onExecutors(value => { executorEvents.current++; setExecutors(value); });
    const offCLIUpdate = window.desktop.onCLIUpdate(value => { cliUpdateEvents.current++; setCLIUpdate(value); });
    return () => { disposed = true; offState(); offCapabilities(); offExecutors(); offCLIUpdate(); offChat(); offError(); offNavigate(); };
  }, [refresh, report, applyState, expandGroup]);
  const selectSession = (id: string) => {
    flushDrafts(); selection.current.request(id); setActiveId(id); setDeleteConfirm('');
    const session = latestState.current?.sessions.find(session => session.id === id);
    if (session) expandGroup(session.projectId);
    void window.desktop.setSelection(id).catch(report);
  };
  const setComposer = (value: string) => { if (active) saveDraftFor(active.id, value); };
  const updateCLI = () => {
    if (cliActionPending.current) return;
    cliActionPending.current = true; setCLIActionBusy(true); setError('');
    // Maintenance is scoped by each descriptor; other engines remain interactive.
    void persistDrafts().then(() => window.desktop.updateCLI()).catch(report).finally(() => { cliActionPending.current = false; setCLIActionBusy(false); });
  };
  const checkCLIUpdate = () => { void window.desktop.checkCLIUpdate().catch(report); };
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k' && !document.querySelector('[role=dialog]')) { event.preventDefault(); setPaletteQuery(''); setModal('palette'); }
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, []);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 3500); return () => clearTimeout(timer); }, [notice]);

  useEffect(() => {
    if (!activeId || !structured || !executionCapabilities?.attachments || readOnly) return; let cancelled = false;
    const revision = attachmentRevisions.current.get(activeId) ?? 0;
    void window.desktop.listAttachments(activeId).then(files => {
      // A delayed refresh must not restore an accepted chip or replace files
      // added while switching back to this session.
      if (!cancelled && revision === (attachmentRevisions.current.get(activeId) ?? 0)) setAttachments(old => ({ ...old, [activeId]: files }));
    }).catch(error => { if (!cancelled) report(error); });
    return () => { cancelled = true; };
  }, [activeId, structured, executionCapabilities?.attachments, readOnly, report]);
  const openNew = (kind: 'agent' | 'shell' = 'agent', fork?: Session, targetProjectId?: string) => {
    const candidates = fork ? [fork.projectId] : [targetProjectId, projectId, active?.projectId, state?.projects[0]?.id];
    const selected = candidates.find(id => state?.projects.some(project => project.id === id)) ?? '';
    const providerId = kind === 'shell' ? 'shell' : fork?.execution.providerId ?? 'claude';
    const mode = kind === 'shell' ? 'terminal' : fork?.execution.mode ?? 'structured';
    const selectedEngine = executors.find(item => item.providerId === providerId && item.mode === mode);
    setDraft({
      projectId: selected, title: fork ? `${fork.title} · 分支` : '', kind,
      providerId, engineConfig: fork ? structuredClone(fork.engineConfig) : engineDefaults(selectedEngine, state?.settings),
      isolated: false, worktreeName: '', mode,
      conversationId: fork?.execution.conversationId, fork: !!fork
    });
    setModal('new');
  };
  const openSettings = () => { if (state) { preferences.begin(); setModal('settings'); } };
  const openPalette = () => { setPaletteQuery(''); setModal('palette'); };
  const chooseProject = () => perform(async () => { const p = await window.desktop.chooseProject(); if (p) setProjectId(p.id); });
  const start = (session: Session) => perform(async () => { await window.desktop.startSession(session.id); });
  const openIde = () => {
    const target = active?.id ?? project?.id;
    if (!target || !state) return;
    if (!state.settings.idePath?.trim()) {
      setError(''); preferences.begin('workspace', true); setModal('settings'); return;
    }
    void perform(async () => { await window.desktop.openIde(target); setNotice('已发送到指定 IDE'); });
  };
  const openHistory = () => perform(async () => {
    const id = projectId === 'all' ? (active?.projectId ?? state?.projects[0]?.id) : projectId;
    if (!id) throw new Error('请先添加一个项目。');
    const source = historySources.find(item => item.providerId === active?.execution.providerId && item.mode === 'structured') ?? historySources.find(item => item.providerId === 'claude' && item.mode === 'structured') ?? historySources[0];
    if (!source) throw new Error('没有已安装的外部历史来源。');
    setDraft({ projectId: id, title: '', kind: 'agent', providerId: source.providerId, mode: source.mode, engineConfig: engineDefaults(source, state?.settings), isolated: false }); resetHistory(); setModal('history');
  });
  const importHistory = (id: string, title: string, providerId = draft.providerId) => perform(async () => {
    if (providerId !== draft.providerId) throw new Error('历史来源已改变，请重新选择记录。');
    const session = await window.desktop.createSession({ projectId: draft.projectId, title, kind: 'agent', providerId, engineConfig: draft.engineConfig, isolated: false, mode: draft.mode, conversationId: id });
    setArchived(false); selectSession(session.id); setModal(null);
  });
  if (!state) return <main className="boot">
    <Command size={36} />
    <h2>Claude Workbench</h2>
    <p>{error || '正在打开你的工作台…'}</p>
  </main>;
  const addAttachments = async (id: string, choose: () => Promise<Attachment[]>) => {
    const session = latestState.current?.sessions.find(session => session.id === id);
    const engine = executors.find(item => item.providerId === session?.execution.providerId && item.mode === session?.execution.mode);
    if (latestBusy.current || pendingAttachmentImports.current.has(id) || !session || session.archived || session.execution.mode !== 'structured' || !engine?.capabilities.attachments || executionUnavailable(engine, session)) return;
    // Reserve before invoking the picker/preload so Enter cannot race a copy,
    // even before React renders the pending indicator.
    pendingAttachmentImports.current.add(id); setAttachmentImports(new Set(pendingAttachmentImports.current));
    attachmentRevisions.current.set(id, (attachmentRevisions.current.get(id) ?? 0) + 1);
    setError(''); let failed = false;
    try {
      try {
        const files = await choose();
        if (files.length && latestState.current?.sessions.some(session => session.id === id)) {
          changeAttachments(id, current => [...new Map([...current, ...files].map(file => [file.path, file])).values()]);
        }
      } catch (error) { failed = true; report(error); }
      if (latestState.current?.sessions.some(session => session.id === id)) {
        const revision = attachmentRevisions.current.get(id) ?? 0;
        // Include older drafts even if their initial load was overtaken by this
        // import. Apply to the originating session after a selection change.
        try {
          const files = await window.desktop.listAttachments(id);
          if (revision === (attachmentRevisions.current.get(id) ?? 0) && latestState.current?.sessions.some(session => session.id === id)) changeAttachments(id, () => files);
        } catch (error) { if (!failed) report(error); }
      }
    } finally {
      pendingAttachmentImports.current.delete(id); setAttachmentImports(new Set(pendingAttachmentImports.current));
    }
  };
  const appendReview = (text: string) => active ? appendDraft(active.id, text) : false;
  const activePanels = active ? (panelDrafts.current.get(active.id) ?? active.panelDrafts ?? {}) : {};
  const liveCount = state.sessions.filter(s => s.status === 'running' || s.status === 'stopping').length;
  const taskCount = state.sessions.filter(isSessionBusy).length;

  return <div className="app">
    <SessionSidebar state={state} cap={cap} executors={executors} historyAvailable={!!historySources.length} activeId={activeId} projectId={projectId} archived={archived} search={search} collapsedGroups={collapsedGroups}
      openNew={openNew} chooseProject={chooseProject} selectSession={selectSession} onSearch={value => { setSearch(value); if (value.trim()) setCollapsedGroups(new Set()); }}
      onProject={id => { setProjectId(id); expandGroup(id); }} toggleGroup={toggleGroup} setArchived={setArchived} openHistory={openHistory} onSettings={openSettings} />
    <main className="workspace">
      <WorkspaceHeader state={state} active={active} descriptor={descriptor} unavailable={unavailable} readOnly={readOnly} project={project} structured={structured} activeBusy={activeBusy} busy={busy}
        onRename={title => { setRename(title); setModal('rename'); }} onPalette={openPalette} openIde={openIde} perform={perform} setNotice={setNotice} start={start}
        onAttention={item => { const target = state.sessions.find(session => session.id === item.sessionId); if (!target) return; setProjectId('all'); setArchived(target.archived); setSearch(''); selectSession(item.sessionId); setAttentionTarget({ ...item, nonce: ++attentionNonce.current }); }} />
      {error && <div className="error-banner" role="alert">
        <span>{error}</span>
        <button className="icon-button" aria-label="关闭错误" onClick={() => setError('')}>
          <X size={16} />
        </button>
      </div>}
      {cliUpdate.showBanner && modal !== 'settings' && <CLIUpdateNotice state={cliUpdate} onCheck={checkCLIUpdate} onUpdate={updateCLI} onDismiss={() => void window.desktop.dismissCLIUpdate().catch(report)} disabled={busy || cliActionBusy} />}
      {notice && <div className="notice">
        <Check size={14} />{notice}</div>}
      {!active ? <WorkspaceWelcome hasProjects={!!state.projects.length} historyAvailable={!!historySources.length} openNew={openNew} chooseProject={chooseProject} openHistory={openHistory} /> : <>
        {active.execution.providerId === 'claude' && !structured && active.status === 'running' && active.terminalSync !== 'synced' && <div className="sync-note">{active.terminalSync === 'unsupported' ? '当前 CLI 不支持状态同步，任务状态请查看终端。' : '等待 CLI 状态同步，当前仅确认进程正在运行。'}</div>}
        {active.error && <div className="inline-warning">{active.error}</div>}
        {unavailable && <div className="inline-warning engine-unavailable" role="status">{unavailable}</div>}
        <div className="session-content">
          <SessionViewport state={state} active={active} executors={executors} descriptor={descriptor} disabled={!!unavailable} readOnly={readOnly} structured={structured} themeId={themeId} composer={composer} onDraft={setComposer} onSent={expected => clearSentDraft(active.id, expected)} report={report} onClearError={() => setError('')}>
            {structured && <ChatPane key={active.id} session={active} descriptor={descriptor} readOnly={readOnly} draft={composer} disabled={!!unavailable}
              onDraft={value => saveDraftFor(active.id, value)} onSent={expected => clearSentDraft(active.id, expected)}
              onError={report} attachments={attachments[active.id] ?? []} onAttach={() => void addAttachments(active.id, () => window.desktop.pickAttachments(active.id))} onProjectFiles={() => setFilePicker(active.id)}
              onDropFiles={files => void addAttachments(active.id, () => window.desktop.addDroppedAttachments(active.id, files))}
              attachmentBusy={attachmentImports.has(active.id)} attachmentDisabled={busy} isAttachmentImporting={() => pendingAttachmentImports.current.has(active.id)}
              approvalDrafts={approvalDrafts.current} readingPositions={readingPositions.current}
              attentionTarget={attentionTarget?.sessionId === active.id ? attentionTarget : undefined} onAttentionHandled={() => setAttentionTarget(undefined)}
              onRemoveAttachment={path => void perform(async () => { await window.desktop.removeAttachment(active.id, path); changeAttachments(active.id, files => files.filter(file => file.path !== path)); })}
              onAttachmentsSent={files => {
                if (!files.length) return;
                // Every picker import has a fresh staged path, even when the
                // same source file is selected again while acceptance is pending.
                const submittedPaths = new Set(files.map(file => file.path));
                changeAttachments(active.id, current => current.filter(file => !submittedPaths.has(file.path)));
              }} />}
          </SessionViewport>
          <SessionInspector executors={executors} sessions={state.sessions} descriptor={descriptor} unavailable={unavailable} readOnly={readOnly} executionCapabilities={executionCapabilities} active={active} project={project} structured={structured} activeBusy={activeBusy} busy={busy}
            perform={perform} report={report} setNotice={setNotice} openNew={openNew} selectSession={selectSession} deleteConfirm={deleteConfirm}
            setDeleteConfirm={setDeleteConfirm} flushDrafts={flushDrafts} appendReview={appendReview} activePanels={activePanels} updatePanel={updatePanel} />
        </div>
      </>}
      <footer className="statusbar">
        <span>
          <span className={`dot ${cap.available ? 'running' : 'stopped'}`} />{cap.available ? cap.version : '未检测到 Claude Code'}</span>
        <span>
          <span className="running-count" title="执行中包含任务、Shell 和尚未同步状态的终端；连接数包含等待下一轮的 CLI 进程">
            <span className={`dot ${taskCount ? 'running' : 'idle'}`} />{taskCount} 执行中 · {liveCount} / {state.settings.maxSessions} 已连接</span>{platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'macOS' : 'Linux'}<span>UTF-8</span>
          <span>v{appVersion}</span>
        </span>
      </footer>
    </main>
    {filePicker && <FilePicker key={filePicker} sessionId={filePicker} selected={[]} onClose={() => setFilePicker('')} onError={report} onPick={paths => { const id = filePicker; const value = drafts[id] ?? state.sessions.find(s => s.id === id)?.draft ?? ''; saveDraftFor(id, value + (value ? '\n\n' : '') + '请参考以下项目文件：\n' + paths.map(p => '@' + JSON.stringify(p)).join('\n')); setFilePicker(''); }} />}
    {modal && <Dialog className={modal === 'settings' ? 'preferences' : ''} onClose={() => setModal(null)} closeDisabled={busy} label={modal === 'new' ? '新建会话' : modal === 'settings' ? '设置与连接' : modal === 'rename' ? '重命名会话' : modal === 'palette' ? '命令面板' : '导入引擎历史'}>
      <button className="icon-button close-modal" disabled={busy} aria-label="关闭弹窗" onClick={() => setModal(null)}>
        <X size={20} />
      </button>
      {modal === 'palette' && <CommandPalette state={state} historyAvailable={!!historySources.length} paletteQuery={paletteQuery} setPaletteQuery={setPaletteQuery} openNew={openNew} openHistory={openHistory} onSettings={openSettings}
        onSelect={session => { setProjectId('all'); setArchived(session.archived); setSearch(''); selectSession(session.id); setModal(null); }} />}
      {modal === 'new' && <NewSessionForm state={state} executors={executors} draft={draft} setDraft={setDraft} busy={busy} perform={perform} onCreated={id => { selectSession(id); setArchived(false); setModal(null); }} />}
      {modal === 'settings' && draftSettings && <SettingsPanel executors={executors} cliBusy={cliActionBusy || cliUpdateBusy(cliUpdate)} value={draftSettings} saved={state.settings} {...preferences.editor}
        cliUpdate={<CLIUpdateNotice state={cliUpdate} onCheck={checkCLIUpdate} onUpdate={updateCLI} disabled={busy || cliActionBusy || draftSettings.claudePath !== state.settings.claudePath} />}
        busy={busy} error={error} capabilities={cap} platform={platform} dataPath={dataPath} onClose={() => setModal(null)} />}
      {modal === 'history' && <HistoryImport state={state} executors={executors} draft={draft} setDraft={setDraft} busy={busy} historyQuery={historyQuery} setHistoryQuery={setHistoryQuery}
        history={history} historyBusy={historyBusy} historyNext={historyNext} importHistory={importHistory} moreHistory={moreHistory} />}
      {modal === 'rename' && active && <RenameSession active={active} rename={rename} setRename={setRename} structured={structured} activeBusy={activeBusy} busy={busy} perform={perform} onClose={() => setModal(null)} />}
      {error && modal !== 'settings' && <div className="modal-error" role="alert">{error}</div>}
    </Dialog>}
  </div>;
}
