import { Check, Command, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { version as appVersion } from '../../package.json';
import { cliUpdateBusy, type CLIUpdateState } from '../shared/cli-update';
import type { ExecutionDescriptor } from '../shared/execution';
import { isSessionBusy } from '../shared/session-activity';
import type { AppState, Attachment, Capabilities, Session } from '../shared/types';
import { ChatPane } from './ChatPane';
import { configurationSupported, newSessionEngineDefaults, executionUnavailable } from './EngineConfiguration';
import type { EngineSettingsGroup, SettingsScope } from './settings-organization';
import type { SessionDraft } from './workspace/types';
import { CLIUpdateNotice } from './CLIUpdateNotice';
import { Dialog } from './Dialog';
import { FilePicker } from './ProjectPanels';
import { SessionSelection } from './selection';
import { SettingsPanel } from './SettingsPanel';
import { CommandPalette } from './workspace/CommandPalette';
import { ConnectionManager } from './workspace/ConnectionManager';
import { HistoryImport } from './workspace/HistoryImport';
import { NewSessionForm } from './workspace/NewSessionForm';
import { ContinuationSessionForm } from './workspace/ContinuationSessionForm';
import { NewSessionImagePreview } from './workspace/NewSessionImagePreview';
import { isNewSessionImagePreviewCurrent, newSessionImagePreviewKey, type NewSessionImagePreviewSelection } from './workspace/new-session-image-preview-state';
import { NewSessionSubmission, type NewSessionAttachment } from './workspace/new-session-submission';
import { SessionInspector } from './workspace/SessionInspector';
import { SessionSidebar } from './workspace/SessionSidebar';
import { SessionViewport } from './workspace/SessionViewport';
import { useHistorySearch } from './workspace/useHistorySearch';
import { useSessionDrafts } from './workspace/useSessionDrafts';
import { useSessionMemory } from './workspace/useSessionMemory';
import { useWorkspacePreferences } from './workspace/useWorkspacePreferences';
import { WorkspaceHeader } from './workspace/WorkspaceHeader';
import { WorkspaceWelcome } from './workspace/WorkspaceWelcome';
import { useNativeConnectionReadiness } from './useNativeConnectionReadiness';
import { importNativePastedImages, nativePasteTargetAvailable, withAttachmentImport } from './native-image-paste';
import { sessionReadLifecycle } from './session-read-lifecycle';

type Modal = 'continuation' | 'settings' | 'history' | 'palette' | null;
interface BlankSession {
  key: string; token: string; input: SessionDraft; text: string; files: NewSessionAttachment[];
  submission: NewSessionSubmission; sending: boolean; importing: boolean; error: string;
}


export function App() {
  const [state, setState] = useState<AppState>();
  const [executors, setExecutors] = useState<ExecutionDescriptor[]>([]);
  const latestExecutors = useRef(executors); latestExecutors.current = executors;
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
  const [settingsTarget, setSettingsTarget] = useState<{ scope: SettingsScope; group?: EngineSettingsGroup; subpage?: string }>({ scope: 'defaults' });
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
  const blankSessions = useRef(new Map<string, BlankSession>());
  const [blankKey, setBlankKey] = useState<string>();
  const latestBlankKey = useRef(blankKey); latestBlankKey.current = blankKey;
  const [, redrawBlank] = useState(0);
  const changedBlank = () => redrawBlank(value => value + 1);
  const blank = blankKey ? blankSessions.current.get(blankKey) : undefined;
  useEffect(() => {
    if (!state) return;
    let changed = false;
    for (const pending of blankSessions.current.values()) {
      if (pending.input.fork || pending.submission.session || pending.sending || pending.importing) continue;
      const engine = executors.find(item => item.providerId === pending.input.providerId && item.mode === pending.input.mode);
      const defaults = newSessionEngineDefaults(engine, state.settings);
      if (!engine || defaults.schemaVersion !== pending.input.engineConfig.schemaVersion) continue;
      const options = { ...pending.input.engineConfig.options, ...defaults.options };
      if (engine.providerId === 'native') {
        // Connection/model choices are owned by the draft, while its policy follows settings.
        options.connectionId = pending.input.engineConfig.options.connectionId ?? '';
        options.model = pending.input.engineConfig.options.model ?? '';
      }
      const engineConfig = { ...pending.input.engineConfig, options };
      if (JSON.stringify(engineConfig) !== JSON.stringify(pending.input.engineConfig)) {
        pending.input = { ...pending.input, engineConfig }; changed = true;
      }
    }
    if (changed) redrawBlank(value => value + 1);
  }, [state?.settings, executors, blank?.importing]);
  const [blankImagePreview, setBlankImagePreview] = useState<NewSessionImagePreviewSelection>();
  const currentBlankImagePreview = blankImagePreview && blank && !blank.sending && !blank.importing
    && isNewSessionImagePreviewCurrent(blankImagePreview, blank.token, blank.input.providerId, blank.files) ? blankImagePreview : undefined;
  useEffect(() => { if (blankImagePreview && !currentBlankImagePreview) setBlankImagePreview(undefined); }, [blankImagePreview, currentBlankImagePreview]);
  const [paletteQuery, setPaletteQuery] = useState('');
  const [dataPath, setDataPath] = useState('');
  const [platform, setPlatform] = useState('');
  const [draft, setDraft] = useState<SessionDraft>({ projectId: '', title: '', kind: 'agent', providerId: 'claude', engineConfig: { schemaVersion: 1, options: {} }, isolated: false, mode: 'structured' });
  const report = useCallback((error: unknown) => setError(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error)), []);
  const { drafts, saveDraftFor, clearSentDraft, flushDrafts, persistDrafts, appendDraft } = useSessionDrafts(latestState, report);
  const { approvalDrafts, panelDrafts, readingPositions, retainSessions, updatePanel } = useSessionMemory(latestState, report);
  const active = blank ? undefined : state?.sessions.find(s => s.id === activeId);
  const composer = active ? (drafts[active.id] ?? active.draft ?? '') : '';
  const structured = active?.execution.mode === 'structured';
  const descriptor = executors.find(executor => executor.providerId === active?.execution.providerId && executor.mode === active?.execution.mode);
  const executionCapabilities = descriptor?.capabilities;
  const connectionUnavailable = useNativeConnectionReadiness(state?.sessions);
  const unavailable = active ? executionUnavailable(descriptor, active) ?? (active.execution.providerId === 'native' && active.error?.includes('此会话只读') ? active.error : undefined) ?? connectionUnavailable(active) : undefined;
  const readOnly = !!active && !configurationSupported(descriptor, active.engineConfig);
  const historySources = executors.filter(item => item.history);
  const activeBusy = !!active && isSessionBusy(active);
  const project = state?.projects.find(p => p.id === (active?.projectId ?? blank?.input.projectId ?? projectId));
  const applyState = useCallback((value: AppState) => {
    latestState.current = value; setState(value); retainSessions(value.sessions.map(session => session.id));
    sessionReadLifecycle.retain(value.sessions.map(session => session.id));
    const id = selection.current.receive(value.selectedSessionId);
    setProjectId(current => current === 'all' || value.projects.some(project => project.id === current) ? current : 'all');
    if (id !== undefined) {
      const selected = value.sessions.find(session => session.id === id);
      latestActiveId.current = selected?.id ?? ''; setActiveId(selected?.id ?? '');
      if (selected) { latestBlankKey.current = undefined; setBlankKey(undefined); }
      if (selected) { setProjectId('all'); setArchived(selected.archived); setSearch(''); expandGroup(selected.projectId); }
    }
  }, [expandGroup, retainSessions]);
  const refresh = useCallback(async () => {
    const revision = stateEvents.current, updateRevision = cliUpdateEvents.current, executorRevision = executorEvents.current;
    const snapshot = await window.desktop.snapshot();
    if (revision === stateEvents.current) applyState(snapshot.state);
    if (updateRevision === cliUpdateEvents.current) setCLIUpdate(snapshot.cliUpdate);
    setCap(snapshot.capabilities); if (executorRevision === executorEvents.current) { latestExecutors.current = snapshot.executors; setExecutors(snapshot.executors); }
    setDataPath(snapshot.dataPath); setPlatform(snapshot.platform);
  }, [applyState]);
  const perform = useCallback(async (action: () => Promise<unknown>) => {
    setError(''); latestBusy.current = true; setBusy(true);
    try { await action(); } catch (error) { report(error); } finally { latestBusy.current = false; setBusy(false); }
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
      if (id === latestActiveId.current || !approvalDrafts.current.has(id) || !latestState.current?.sessions.some(session => session.id === id)) return;
      const seq = (approvalRequests.get(id) ?? 0) + 1;
      approvalRequests.set(id, seq);
      const current = () => !disposed && approvalRequests.get(id) === seq && id !== latestActiveId.current && latestState.current?.sessions.some(session => session.id === id);
      void sessionReadLifecycle.read(id, () => window.desktop.chatSnapshot(id)).then(value => {
        if (value && current()) approvalDrafts.current.reconcile(id, value.pending);
      }).catch(error => { if (current()) report(error); });
    });
    const offError = window.desktop.onError(message => report(new Error(message)));
    const offNavigate = window.desktop.onNavigate(id => {
      const selected = latestState.current?.sessions.find(session => session.id === id);
      if (!selected) return;
      selection.current.navigate(id); latestActiveId.current = id; setActiveId(id); latestBlankKey.current = undefined; setBlankKey(undefined);
      setProjectId('all'); setArchived(selected.archived); setSearch(''); expandGroup(selected.projectId);
    });
    const offCapabilities = window.desktop.onCapabilities(value => { setCap(value); void refresh().catch(report); });
    const offExecutors = window.desktop.onExecutors(value => { executorEvents.current++; latestExecutors.current = value; setExecutors(value); });
    const offCLIUpdate = window.desktop.onCLIUpdate(value => { cliUpdateEvents.current++; setCLIUpdate(value); });
    return () => { disposed = true; offState(); offCapabilities(); offExecutors(); offCLIUpdate(); offChat(); offError(); offNavigate(); };
  }, [refresh, report, applyState, expandGroup]);
  const selectSession = (id: string) => {
    const unfinished = [...blankSessions.current.values()].find(item => item.submission.session?.id === id && !item.submission.accepted);
    latestBlankKey.current = unfinished?.key; setBlankKey(unfinished?.key);
    if (unfinished) { setError(unfinished.error); id = ''; }
    flushDrafts(); selection.current.request(id); latestActiveId.current = id; setActiveId(id);
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
  const openNew = (_kind: 'agent' | 'shell' = 'agent', fork?: Session, targetProjectId?: string, continuation?: Session) => {
    if (continuation) {
      // A continuation creates an editable draft. It must never enter first-send
      // staging, whose saveDraft would replace the host-generated handoff text.
      const engine = executors.find(item => item.providerId === 'claude' && item.mode === 'structured');
      setDraft({ projectId: continuation.projectId, title: '', kind: 'agent', providerId: 'claude',
        mode: 'structured', engineConfig: newSessionEngineDefaults(engine, state?.settings), isolated: false,
        continuation: { sourceSessionId: continuation.id, snapshotHash: '', messageIds: [] } });
      setError(''); setModal('continuation'); return;
    }
    const key = fork ? `fork:${fork.id}` : 'new';
    let pending = blankSessions.current.get(key);
    if (!pending || pending.submission.accepted) {
      const candidates = fork ? [fork.projectId] : [targetProjectId, projectId, active?.projectId, state?.projects[0]?.id];
      const selected = candidates.find(id => state?.projects.some(project => project.id === id)) ?? '';
      const providerId = fork?.execution.providerId ?? 'claude';
      const selectedEngine = executors.find(item => item.providerId === providerId && item.mode === 'structured');
      const input: SessionDraft = {
        projectId: selected, title: fork ? `${fork.title} · 分支` : '', kind: 'agent',
        providerId, engineConfig: fork ? structuredClone(fork.engineConfig) : newSessionEngineDefaults(selectedEngine, state?.settings),
        isolated: false, worktreeName: '', mode: 'structured', conversationId: fork?.execution.conversationId, fork: !!fork,
      };
      pending = { key, token: crypto.randomUUID(), input, text: '', files: [], sending: false, importing: false, error: '', submission: new NewSessionSubmission({
        createSession: value => window.desktop.createSession(value),
        saveDraft: (id, text) => window.desktop.saveDraft(id, text),
        stageDraftAttachments: (id, files) => window.desktop.stageDraftAttachments(id, files),
        addPastedNativeImages: (id, images) => window.desktop.addPastedNativeImages(id, images),
        removeAttachment: (id, path) => window.desktop.removeAttachment(id, path),
        submitChat: (id, text, paths, requestId) => window.desktop.submitChat(id, text, paths, requestId),
        created: session => {
          const owner = blankSessions.current.get(key);
          if (owner && owner.submission.session?.id === session.id) saveDraftFor(session.id, owner.text);
          changedBlank();
        },
      }) };
      blankSessions.current.set(key, pending);
    } else if (targetProjectId && !pending.submission.session && !pending.sending) {
      pending.input = { ...pending.input, projectId: targetProjectId, worktreeBaseRef: undefined };
    }
    selectSession(''); latestBlankKey.current = key; setBlankKey(key);
    setError(pending.error); setModal(null);
  };
  const chooseBlankDirectory = async (owner: BlankSession) => {
    if (latestBusy.current || owner.sending || owner.submission.session) return;
    await perform(async () => {
      const project = await window.desktop.chooseProject();
      if (!project) return;
      owner.input = { ...owner.input, projectId: project.id, worktreeBaseRef: undefined };
      await refresh(); changedBlank();
    });
  };
  const addBlankAttachments = async (owner: BlankSession, choose: () => Promise<NewSessionAttachment[]>) => {
    if (latestBusy.current || owner.sending || owner.importing) return;
    owner.importing = true; owner.error = ''; changedBlank();
    try {
      const files = await choose();
      const next = [...new Map([...owner.files, ...files].map(file => [file.path, file])).values()];
      if (next.length > 8 || next.reduce((bytes, file) => bytes + file.bytes, 0) > 16 * 1024 * 1024) throw new Error('最多选择 8 个附件，合计不能超过 16 MiB。');
      for (const file of files) await owner.submission.invalidateAttachment(file.path);
      if (owner.input.providerId === 'native' && (next.length > 4 || next.reduce((bytes, file) => bytes + file.bytes, 0) > 1024 * 1024)) throw new Error('Native 待发送图片最多 4 张，合计不能超过 1 MiB。');
      owner.files = next;
    } catch (error) {
      owner.error = error instanceof Error ? error.message : String(error);
      if (latestBlankKey.current === owner.key && blankSessions.current.get(owner.key) === owner) report(error);
    } finally { owner.importing = false; changedBlank(); }
  };
  const removeBlankAttachment = async (owner: BlankSession, path: string) => {
    if (owner.sending || owner.importing) return;
    owner.importing = true; changedBlank();
    try {
      await owner.submission.invalidateAttachment(path);
      owner.files = owner.files.filter(file => file.path !== path);
    } catch (error) {
      owner.error = error instanceof Error ? error.message : String(error);
      if (latestBlankKey.current === owner.key && blankSessions.current.get(owner.key) === owner) report(error);
    } finally { owner.importing = false; changedBlank(); }
  };
  const sendBlank = async (owner: BlankSession) => {
    if (latestBusy.current || owner.sending || owner.importing) return;
    const text = owner.text, files = [...owner.files];
    if (!text.trim() && !files.length) return;
    owner.sending = true; owner.error = ''; setError(''); changedBlank();
    try {
      const session = await owner.submission.submit(owner.input, text, files);
      clearSentDraft(session.id, text);
      // Acceptance is final even if a later snapshot read fails. Make the
      // acknowledged session available before its debounced state broadcast.
      const current = latestState.current;
      if (current && !current.sessions.some(item => item.id === session.id)) {
        const next = { ...current, sessions: [session, ...current.sessions] };
        latestState.current = next; setState(next);
        retainSessions(next.sessions.map(item => item.id));
        sessionReadLifecycle.retain(next.sessions.map(item => item.id));
      }
      if (latestBlankKey.current === owner.key && blankSessions.current.get(owner.key) === owner) {
        latestBlankKey.current = undefined; setBlankKey(undefined);
        setProjectId('all'); setSearch(''); setArchived(false); selectSession(session.id);
      }
      if (blankSessions.current.get(owner.key) === owner) blankSessions.current.delete(owner.key);
    } catch (error) {
      owner.error = error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error);
      if (latestBlankKey.current === owner.key && blankSessions.current.get(owner.key) === owner) report(error);
    } finally { owner.sending = false; changedBlank(); }
  };
  const openSettings = () => { if (state) { setSettingsTarget({ scope: 'defaults' }); preferences.begin(); setModal('settings'); } };
  const openSessionSettings = () => { if (state && active) {
    setSettingsTarget({ scope: 'session', group: active.execution.providerId === 'native' ? 'context' : 'permissions' });
    preferences.begin(active.execution.providerId === 'native' ? 'models' : 'sessions'); setModal('settings');
  } };
  const openDefaultContextSettings = () => { if (state) { setSettingsTarget({ scope: 'defaults', group: 'context' }); preferences.begin('models'); setModal('settings'); } };
  const openPalette = () => { setPaletteQuery(''); setModal('palette'); };
  const start = (session: Session) => perform(async () => { await window.desktop.startSession(session.id); });
  const openIde = () => {
    const target = active?.id ?? project?.id;
    if (!target || !state) return;
    if (!state.settings.idePath?.trim()) {
      setError(''); setSettingsTarget({ scope: 'defaults', subpage: 'ide' }); preferences.begin('workspace', true); setModal('settings'); return;
    }
    void perform(async () => { await window.desktop.openIde(target); setNotice('已发送到指定 IDE'); });
  };
  const openHistory = () => perform(async () => {
    let id = projectId === 'all' ? (blank?.input.projectId || active?.projectId || state?.projects[0]?.id) : projectId;
    if (!id) { const project = await window.desktop.chooseProject(); if (!project) return; id = project.id; await refresh(); }
    const source = historySources.find(item => item.providerId === active?.execution.providerId && item.mode === 'structured') ?? historySources.find(item => item.providerId === 'claude' && item.mode === 'structured') ?? historySources[0];
    if (!source) throw new Error('没有已安装的外部历史来源。');
    setDraft({ projectId: id, title: '', kind: 'agent', providerId: source.providerId, mode: source.mode, engineConfig: newSessionEngineDefaults(source, state?.settings), isolated: false }); resetHistory(); setModal('history');
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
    const engine = latestExecutors.current.find(item => item.providerId === session?.execution.providerId && item.mode === session?.execution.mode);
    if (latestBusy.current || pendingAttachmentImports.current.has(id) || !session || session.archived || session.execution.mode !== 'structured' || !engine?.capabilities.attachments || executionUnavailable(engine, session)) return;
    // Reserve before the picker/preload or clipboard byte read, so Enter and
    // repeated paste cannot race even before React renders the indicator.
    await withAttachmentImport(pendingAttachmentImports.current, id, setAttachmentImports, async () => {
      attachmentRevisions.current.set(id, (attachmentRevisions.current.get(id) ?? 0) + 1);
      setError(''); let failed = false;
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
    });
  };
  const appendReview = (text: string) => active ? appendDraft(active.id, text) : false;
  const activePanels = active ? (panelDrafts.current.get(active.id) ?? active.panelDrafts ?? {}) : {};
  const taskCount = state.sessions.filter(isSessionBusy).length;

  return <div className="app">
    <SessionSidebar state={state} cap={cap} historyAvailable={!!historySources.length} activeId={activeId} projectId={projectId} archived={archived} search={search} collapsedGroups={collapsedGroups}
      openNew={openNew} selectSession={selectSession} executors={executors} busy={busy || [...blankSessions.current.values()].some(item => item.sending)} perform={perform} report={report} flushDrafts={flushDrafts} setNotice={setNotice}
      onSessionHidden={id => {
        for (const owner of blankSessions.current.values()) if (owner.submission.session?.id === id) {
          blankSessions.current.delete(owner.key);
          if (latestBlankKey.current === owner.key) { latestBlankKey.current = undefined; setBlankKey(undefined); }
        }
        if (!latestBlankKey.current && latestActiveId.current === id) selectSession('');
      }} onSearch={value => { setSearch(value); if (value.trim()) setCollapsedGroups(new Set()); }}
      onProject={id => { setProjectId(id); expandGroup(id); }} toggleGroup={toggleGroup} setArchived={setArchived} openHistory={openHistory} onSettings={openSettings} />
    <main className="workspace">
      <WorkspaceHeader state={state} creating={!!blank} active={active} descriptor={descriptor} unavailable={unavailable} readOnly={readOnly} project={project} structured={structured} activeBusy={activeBusy} busy={busy}
        onPalette={openPalette} openIde={openIde} perform={perform} setNotice={setNotice} start={start}
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
      {blank ? <NewSessionForm key={blank.token} state={state} executors={executors} draft={blank.input}
        setDraft={value => { if (!blank.sending && !blank.importing && !blank.submission.session) {
          const next = typeof value === 'function' ? value(blank.input) : value;
          if (next.providerId !== blank.input.providerId && blank.files.length) { report(new Error('请先移除待发送附件再切换引擎。')); return; }
          blank.input = next; changedBlank();
        } }}
        busy={busy || blank.sending} created={!!blank.submission.session} text={blank.text}
        onText={text => { blank.text = text; if (blank.submission.session) saveDraftFor(blank.submission.session.id, text); changedBlank(); }}
        onSend={() => void sendBlank(blank)} onChooseDirectory={() => void chooseBlankDirectory(blank)} onOpenSettings={blank.input.providerId === 'native' ? openDefaultContextSettings : openSettings}
        attachments={blank.files} attachmentBusy={blank.importing}
        onAttach={() => void addBlankAttachments(blank, () => window.desktop.chooseDraftAttachments())}
        onDropFiles={files => void addBlankAttachments(blank, () => window.desktop.addDroppedDraftAttachments(files))}
        onPreviewAttachment={file => {
          const selected = blank.files.find(item => item.path === file.path);
          if (selected && !blank.importing && !blank.sending && blank.input.providerId === 'native') setBlankImagePreview({ owner: blank.token, file: structuredClone(selected) });
        }}
        onPasteImages={(files, canContinue) => {
          const owner = blank;
          void addBlankAttachments(owner, () => importNativePastedImages(files, owner.files, () =>
            canContinue() && !latestBusy.current && blankSessions.current.get(owner.key) === owner
              && latestBlankKey.current === owner.key && owner.input.providerId === 'native' && !owner.sending,
          async images => images.map((image, index) => {
            const selectionId = crypto.randomUUID();
            return { kind: 'native-paste' as const, selectionId, path: `paste:${selectionId}`,
              name: `粘贴图片 ${owner.files.length + index + 1}.${image.mimeType === 'image/png' ? 'png' : 'jpg'}`, bytes: files[index].size, image };
          })) as Promise<NewSessionAttachment[]>);
        }}
        onRemoveAttachment={path => void removeBlankAttachment(blank, path)} />
        : !active ? <WorkspaceWelcome historyAvailable={!!historySources.length} openNew={openNew} openHistory={openHistory} /> : <>
        {active.execution.providerId === 'claude' && !structured && active.status === 'running' && active.terminalSync !== 'synced' && <div className="sync-note">{active.terminalSync === 'unsupported' ? '当前 CLI 不支持状态同步，任务状态请查看终端。' : '等待 CLI 状态同步，当前仅确认进程正在运行。'}</div>}
        {active.error && <div className="inline-warning">{active.error}</div>}
        {!structured && unavailable && <div className="inline-warning engine-unavailable" role="status">{unavailable}</div>}
        <div className="session-content">
          <SessionViewport state={state} active={active} executors={executors} descriptor={descriptor} disabled={!!unavailable} readOnly={readOnly} structured={structured} themeId={themeId} composer={composer} onDraft={setComposer} onSent={expected => clearSentDraft(active.id, expected)} report={report} onClearError={() => setError('')}>
            {structured && <ChatPane key={active.id} session={active} descriptor={descriptor} readOnly={readOnly} draft={composer} disabled={!!unavailable} unavailable={unavailable}
              onDraft={value => saveDraftFor(active.id, value)} onSent={expected => clearSentDraft(active.id, expected)}
              onError={report} attachments={attachments[active.id] ?? []} onAttach={() => void addAttachments(active.id, () => window.desktop.pickAttachments(active.id))} onProjectFiles={() => setFilePicker(active.id)}
              onDropFiles={files => void addAttachments(active.id, () => window.desktop.addDroppedAttachments(active.id, files))}
              onPasteImages={(files, canContinue) => {
                const origin = { id: active.id, execution: { ...active.execution } };
                const existing = attachments[origin.id] ?? [];
                void addAttachments(origin.id, () => importNativePastedImages(files, existing, () => {
                  const current = latestState.current?.sessions.find(session => session.id === origin.id);
                  const engine = latestExecutors.current.find(item => item.providerId === current?.execution.providerId && item.mode === current?.execution.mode);
                  return canContinue() && nativePasteTargetAvailable(origin, current, engine, latestBusy.current);
                }, images => window.desktop.addPastedNativeImages(origin.id, images)));
              }}
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
          <SessionInspector executors={executors} sessions={state.sessions} connectionUnavailable={connectionUnavailable} descriptor={descriptor} unavailable={unavailable} readOnly={readOnly} executionCapabilities={executionCapabilities} active={active} project={project} structured={structured} activeBusy={activeBusy} busy={busy}
            perform={perform} report={report} setNotice={setNotice} openNew={openNew} selectSession={selectSession}
            flushDrafts={flushDrafts} appendReview={appendReview} activePanels={activePanels} updatePanel={updatePanel} settings={state.settings} onOpenSessionSettings={openSessionSettings} />
        </div>
      </>}
      <footer className="statusbar">
        <span>
          <span className={`dot ${cap.available ? 'running' : 'stopped'}`} />{cap.available ? cap.version : '未检测到 Claude Code'}</span>
        <span>
          <span className="running-count" title="执行中包含任务、Shell 和尚未同步状态的终端">
            <span className={`dot ${taskCount ? 'running' : 'idle'}`} />{taskCount} 执行中</span>
          <ConnectionManager executors={executors} sessions={state.sessions} projects={state.projects} limit={state.settings.maxSessions} disabled={busy}
            onError={report} onSelect={session => { setProjectId('all'); setArchived(session.archived); setSearch(''); selectSession(session.id); }} />
          {platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'macOS' : 'Linux'}<span>UTF-8</span>
          <span>v{appVersion}</span>
        </span>
      </footer>
    </main>
    {currentBlankImagePreview && <NewSessionImagePreview key={newSessionImagePreviewKey(currentBlankImagePreview)} selection={currentBlankImagePreview} onClose={() => setBlankImagePreview(undefined)} />}
    {filePicker && <FilePicker key={filePicker} sessionId={filePicker} selected={[]} onClose={() => setFilePicker('')} onError={report} onPick={paths => { const id = filePicker; const value = drafts[id] ?? state.sessions.find(s => s.id === id)?.draft ?? ''; saveDraftFor(id, value + (value ? '\n\n' : '') + '请参考以下项目文件：\n' + paths.map(p => '@' + JSON.stringify(p)).join('\n')); setFilePicker(''); }} />}
    {modal && <Dialog className={modal === 'settings' ? 'preferences' : ''} onClose={() => setModal(null)} closeDisabled={busy} label={modal === 'continuation' ? '跨引擎续接' : modal === 'settings' ? '设置与连接' : modal === 'palette' ? '命令面板' : '导入引擎历史'}>
      <button className="icon-button close-modal" disabled={busy} aria-label="关闭弹窗" onClick={() => setModal(null)}>
        <X size={20} />
      </button>
      {modal === 'palette' && <CommandPalette state={state} historyAvailable={!!historySources.length} paletteQuery={paletteQuery} setPaletteQuery={setPaletteQuery} openNew={openNew} openHistory={openHistory} onSettings={openSettings}
        onSelect={session => { setProjectId('all'); setArchived(session.archived); setSearch(''); selectSession(session.id); setModal(null); }} />}
      {modal === 'continuation' && <ContinuationSessionForm state={state} executors={executors} draft={draft} setDraft={setDraft} busy={busy} perform={perform} onCreated={id => { selectSession(id); setArchived(false); setModal(null); }} />}
      {modal === 'settings' && draftSettings && <SettingsPanel executors={executors} cliBusy={cliActionBusy || cliUpdateBusy(cliUpdate)} value={draftSettings} saved={state.settings} {...preferences.editor}
        activeSession={active} onSessionError={report} initialScope={settingsTarget.scope} initialGroup={settingsTarget.group} initialSubpage={settingsTarget.subpage}
        cliUpdate={<CLIUpdateNotice state={cliUpdate} onCheck={checkCLIUpdate} onUpdate={updateCLI} disabled={busy || cliActionBusy || draftSettings.claudePath !== state.settings.claudePath} />}
        busy={busy} error={error} capabilities={cap} platform={platform} dataPath={dataPath} onClose={() => setModal(null)} />}
      {modal === 'history' && <HistoryImport state={state} executors={executors} draft={draft} setDraft={setDraft} busy={busy} historyQuery={historyQuery} setHistoryQuery={setHistoryQuery}
        history={history} historyBusy={historyBusy} historyNext={historyNext} importHistory={importHistory} moreHistory={moreHistory} />}
      {error && modal !== 'settings' && <div className="modal-error" role="alert">{error}</div>}
    </Dialog>}
  </div>;
}
