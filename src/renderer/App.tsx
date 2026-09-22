import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { version as appVersion } from '../../package.json';
import { Activity, Archive, ArrowDownToLine, ArrowUpRight, Check, ChevronRight, Command, Copy, Folder, FolderOpen, GitBranch, History, Layers, Loader2, MoreHorizontal, Play, Plus, RefreshCw, Search, Settings2, ShieldCheck, Sparkles, Square, TerminalSquare, X } from 'lucide-react';
import type { AppState, Attachment, Capabilities, Effort, HistoryEntry, NewSession, PermissionMode, Session, Settings } from '../shared/types';
import { TerminalPane, type TerminalHandle } from './TerminalPane';
import { ChatPane, busyTask, taskLabels } from './ChatPane';
import { AttentionCenter } from './AttentionCenter';
import { DiagnosticsPanel, FilePicker, GitPanel } from './ProjectPanels';
import { WorkflowPanel } from './WorkflowPanel';
import { SessionConfig } from './SessionConfig';
import { Dialog } from './Dialog';
import { SessionSelection } from './selection';
import { ApprovalDrafts } from './approval-drafts';
import { ThemePicker } from './ThemePicker';
import { applyTheme } from './themes';
import { normalizeThemeId } from '../shared/theme';
import { cacheSavedTheme, readCachedTheme } from './theme-preferences';
import { emptyGitReviewDraft, emptyWorkflowDraft, type PanelDrafts } from '../shared/panel-drafts';
import type { ChatReadingPosition } from './chat-scroll';

const statusLabel = {idle:'待启动',running:'运行中',stopping:'停止中',stopped:'已停止',error:'需处理'};
const sessionLabel=(session:Session)=>session.adapter==='structured'?(taskLabels[session.taskState??'idle']??statusLabel[session.status]):session.kind==='claude'&&session.status==='running'?(session.terminalSync==='synced'?taskLabels[session.taskState??'idle']??'进程运行中':'进程运行中'):statusLabel[session.status];
const time = (date:string) => new Date(date).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
type Modal = 'new'|'settings'|'history'|'rename'|'palette'|null;


export function App() {
  const [state,setState]=useState<AppState>();
  const [cap,setCap]=useState<Capabilities>({available:false,executable:'',version:'',flags:[],efforts:['default']});
  const [projectId,setProjectId]=useState('all');
  const [collapsedGroups,setCollapsedGroups]=useState<Set<string>>(()=>new Set());
  const expandGroup=useCallback((id:string)=>setCollapsedGroups(current=>{if(!current.has(id))return current;const next=new Set(current);next.delete(id);return next;}),[]);
  const toggleGroup=(id:string)=>setCollapsedGroups(current=>{const next=new Set(current);if(next.has(id))next.delete(id);else next.add(id);return next;});
  const [activeId,setActiveId]=useState('');
  const [attentionTarget,setAttentionTarget]=useState<{sessionId:string;requestId:string;nonce:number}>();
  const attentionNonce=useRef(0);
  const [search,setSearch]=useState('');
  const [archived,setArchived]=useState(false);
  const [modal,setModal]=useState<Modal>(null);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [busy,setBusy]=useState(false);
  const [drafts,setDrafts]=useState<Record<string,string>>({});
  const currentDrafts=useRef<Record<string,string>>({});
  const latestState=useRef(state);latestState.current=state;
  const pendingDrafts=useRef(new Map<string,string>());
  const draftTimers=useRef(new Map<string,ReturnType<typeof setTimeout>>());
  const selection=useRef(new SessionSelection());
  const stateEvents=useRef(0);
  const approvalDrafts=useRef(new ApprovalDrafts());
  const panelDrafts=useRef(new Map<string,PanelDrafts>());
  const [,setPanelRevision]=useState(0);
  const readingPositions=useRef(new Map<string,ChatReadingPosition>());
  const latestActiveId=useRef(activeId);latestActiveId.current=activeId;
  const [inspectorTab,setInspectorTab]=useState<'context'|'git'|'workflows'|'diagnostics'>('context');
  const [filePicker,setFilePicker]=useState('');
  const [attachments,setAttachments]=useState<Record<string,Attachment[]>>({});
  const [deleteConfirm,setDeleteConfirm]=useState('');
  const [paletteQuery,setPaletteQuery]=useState('');
  const [historyQuery,setHistoryQuery]=useState('');
  const [historyNext,setHistoryNext]=useState<number|null>(null);
  const historySeq=useRef(0);
  const [history,setHistory]=useState<HistoryEntry[]>([]);
  const [historyBusy,setHistoryBusy]=useState(false);
  const [dataPath,setDataPath]=useState('');
  const [platform,setPlatform]=useState('');
  const [draftSettings,setDraftSettings]=useState<Settings>();
  const [startupTheme]=useState(readCachedTheme);
  const savedTheme=state?normalizeThemeId(state.settings.theme):startupTheme;
  const themeId=modal==='settings'&&draftSettings?normalizeThemeId(draftSettings.theme):savedTheme;
  useLayoutEffect(()=>{applyTheme(themeId);},[themeId]);
  useEffect(()=>{if(state)cacheSavedTheme(normalizeThemeId(state.settings.theme));},[state?.settings.theme,!!state]);
  const [rename,setRename]=useState('');
  const [draft,setDraft]=useState<NewSession>({projectId:'',title:'',kind:'claude',model:'',effort:'default',permissionMode:'default',isolated:false,adapter:'structured'});
  const handles=useRef(new Map<string,TerminalHandle>());
  const [mounted,setMounted]=useState<string[]>([]);
  const active=state?.sessions.find(s => s.id===activeId);
  const composer=active?(drafts[active.id]??active.draft??''):'';
  const structured=active?.kind==='claude'&&active.adapter==='structured';
  const project=state?.projects.find(p => p.id===(active?.projectId ?? projectId));
  const report=useCallback((error:unknown) => setError(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/,'') : String(error)),[]);
  const applyState=useCallback((value:AppState)=>{
    latestState.current=value;setState(value);approvalDrafts.current.retainSessions(value.sessions.map(session=>session.id));
    const ids=new Set(value.sessions.map(session=>session.id));
    for(const id of panelDrafts.current.keys())if(!ids.has(id))panelDrafts.current.delete(id);
    for(const id of readingPositions.current.keys())if(!ids.has(id))readingPositions.current.delete(id);
    const id=selection.current.receive(value.selectedSessionId);
    setProjectId(current=>current==='all'||value.projects.some(project=>project.id===current)?current:'all');
    if(id!==undefined){const selected=value.sessions.find(session=>session.id===id);setActiveId(selected?.id??'');setDeleteConfirm('');if(selected){setProjectId('all');setArchived(selected.archived);setSearch('');expandGroup(selected.projectId);}}
  },[expandGroup]);
  const refresh=useCallback(async () => {const revision=stateEvents.current;const snapshot=await window.desktop.snapshot();if(revision===stateEvents.current)applyState(snapshot.state);setCap(snapshot.capabilities);setDataPath(snapshot.dataPath);setPlatform(snapshot.platform);},[applyState]);
  const perform=useCallback(async (action:()=>Promise<unknown>) => {setError('');setBusy(true);try {await action();}catch(error){report(error);}finally{setBusy(false);}},[report]);
  useEffect(() => {
    if(!window.desktop){setError('请使用 npm run dev 或已安装的桌面应用打开此界面。');return;}
    void refresh().catch(report);
    const offState=window.desktop.onState(value => {stateEvents.current++;applyState(value);});
    const approvalRequests=new Map<string,number>();let disposed=false;
    const offChat=window.desktop.onChat(id=>{if(id!==latestActiveId.current&&approvalDrafts.current.has(id)){const seq=(approvalRequests.get(id)??0)+1;approvalRequests.set(id,seq);void window.desktop.chatSnapshot(id).then(value=>{if(!disposed&&approvalRequests.get(id)===seq&&id!==latestActiveId.current)approvalDrafts.current.reconcile(id,value.pending);}).catch(report);}});
    const offError=window.desktop.onError(message=>report(new Error(message)));
    const offNavigate=window.desktop.onNavigate(id=>{const selected=latestState.current?.sessions.find(session=>session.id===id);if(!selected)return;selection.current.navigate(id);setActiveId(id);setDeleteConfirm('');setProjectId('all');setArchived(selected.archived);setSearch('');expandGroup(selected.projectId);});
    const offCapabilities=window.desktop.onCapabilities(value => setCap(value));
    return ()=>{disposed=true;offState();offCapabilities();offChat();offError();offNavigate();};
  },[refresh,report,applyState,expandGroup]);
  useEffect(() => {
    const sessions=state?.sessions??[];
    setMounted(ids=>{
      const terminals=sessions.filter(s=>s.kind==='shell'||s.adapter!=='structured');
      const live=terminals.filter(s=>['running','stopping'].includes(s.status)).map(s=>s.id);
      const recent=[activeId,...ids.filter(id=>id!==activeId)].filter(id=>terminals.some(s=>s.id===id)&&!live.includes(id)).slice(0,3);
      const next=[...new Set([...live,...recent])];return next.join('|')===ids.join('|')?ids:next;
    });
  },[activeId,state?.sessions]);
  const saveDraftFor=useCallback((id:string,value:string)=>{
    currentDrafts.current[id]=value;
    setDrafts(old=>({...old,[id]:value}));pendingDrafts.current.set(id,value);
    clearTimeout(draftTimers.current.get(id));
    draftTimers.current.set(id,setTimeout(()=>{
      const text=pendingDrafts.current.get(id);pendingDrafts.current.delete(id);draftTimers.current.delete(id);
      if(text!==undefined)void window.desktop.saveDraft(id,text).catch(report);
    },300));
  },[report]);
  const clearSentDraft=useCallback((id:string,expected:string)=>{
    const current=currentDrafts.current[id]??latestState.current?.sessions.find(s=>s.id===id)?.draft??'';
    if(current===expected)saveDraftFor(id,'');
  },[saveDraftFor]);
  const flushDrafts=useCallback(()=>{
    for(const [id,text] of pendingDrafts.current){clearTimeout(draftTimers.current.get(id));void window.desktop.saveDraft(id,text).catch(report);}
    pendingDrafts.current.clear();draftTimers.current.clear();
  },[report]);
  const selectSession=(id:string)=>{flushDrafts();selection.current.request(id);setActiveId(id);setDeleteConfirm('');const session=latestState.current?.sessions.find(session=>session.id===id);if(session)expandGroup(session.projectId);void window.desktop.setSelection(id).catch(report);};
  const setComposer=(value:string)=>{if(active)saveDraftFor(active.id,value);};
  const updatePanel=<K extends keyof PanelDrafts>(id:string,key:K,update:(current:NonNullable<PanelDrafts[K]>)=>NonNullable<PanelDrafts[K]>)=>{
    const session=latestState.current?.sessions.find(session=>session.id===id);
    if(!session)return;
    const current=panelDrafts.current.get(id)??session.panelDrafts??{};
    const initial=current[key]??(key==='workflow'?emptyWorkflowDraft():emptyGitReviewDraft());
    const value=update(initial as NonNullable<PanelDrafts[K]>);
    if(value===initial)return;
    panelDrafts.current.set(id,{...current,[key]:value});setPanelRevision(revision=>revision+1);
    // Send edits immediately; the main store batches disk writes and flushes on exit.
    void window.desktop.savePanelDrafts(id,{[key]:value}).catch(report);
  };
  useEffect(()=>{window.addEventListener('beforeunload',flushDrafts);return()=>{window.removeEventListener('beforeunload',flushDrafts);flushDrafts();};},[flushDrafts]);
  useEffect(()=>{
    if(modal!=='history'||!draft.projectId)return;
    const request=++historySeq.current;setHistoryBusy(true);setHistory([]);
    const timer=setTimeout(()=>{void window.desktop.queryHistory(draft.projectId,{query:historyQuery,limit:50}).then(page=>{if(request===historySeq.current){setHistory(page.entries);setHistoryNext(page.nextOffset);}}).catch(report).finally(()=>{if(request===historySeq.current)setHistoryBusy(false);});},200);
    return()=>{clearTimeout(timer);historySeq.current++;};
  },[modal,draft.projectId,historyQuery,report]);
  useEffect(()=>{
    const key=(event:KeyboardEvent)=>{
      if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k'&&!document.querySelector('[role=dialog]')){event.preventDefault();setPaletteQuery('');setModal('palette');}
    };
    window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);
  },[]);
  useEffect(() => {if(!notice)return;const timer=setTimeout(()=>setNotice(''),3500);return ()=>clearTimeout(timer);},[notice]);

  useEffect(()=>{
    if(!activeId||!structured)return;let cancelled=false;
    void window.desktop.listAttachments(activeId).then(files=>{if(!cancelled)setAttachments(old=>({...old,[activeId]:files}));}).catch(error=>{if(!cancelled)report(error);});
    return()=>{cancelled=true;};
  },[activeId,structured,report]);
  const openNew=(kind:'claude'|'shell'='claude',fork?:Session,targetProjectId?:string) => {
    const candidates=fork?[fork.projectId]:[targetProjectId,projectId,active?.projectId,state?.projects[0]?.id];
    const selected=candidates
      .find(id=>state?.projects.some(project=>project.id===id))??'';
    setDraft({projectId:selected,title:fork?`${fork.title} · 分支`:'',kind,model:fork?.model??'',effort:fork?.effort??'default',permissionMode:fork?.permissionMode??'default',isolated:false,adapter:kind==='shell'?'terminal':fork?.adapter??'structured',resumeFrom:fork?.claudeId,fork:!!fork});
    setModal('new');
  };
  const chooseProject=() => perform(async () => {const p=await window.desktop.chooseProject();if(p)setProjectId(p.id);});
  const start=(session:Session) => perform(async () => {await window.desktop.startSession(session.id);});
  const savePreferences=(detect:boolean)=>perform(async()=>{
    if(!draftSettings)return;
    const cliChanged=draftSettings.claudePath!==latestState.current?.settings.claudePath;
    await window.desktop.saveSettings(draftSettings);
    if(detect&&!cliChanged)await window.desktop.detect();
    await refresh();setNotice(detect?'设置已保存并完成检测':'设置已保存');
  });
  const openHistory=() => perform(async () => {
    const id=projectId==='all'?(active?.projectId??state?.projects[0]?.id):projectId;
    if(!id)throw new Error('请先添加一个项目。');
    setDraft(d=>({...d,projectId:id,resumeFrom:undefined}));setHistory([]);setHistoryQuery('');setModal('history');
  });
  const moreHistory=()=>perform(async()=>{
    if(historyNext===null)return;
    const request=historySeq.current;
    const page=await window.desktop.queryHistory(draft.projectId,{query:historyQuery,offset:historyNext,limit:50});
    if(request===historySeq.current){setHistory(items=>[...items,...page.entries]);setHistoryNext(page.nextOffset);}
  });
  const importHistory=(id:string,title:string) => perform(async () => {
    const session=await window.desktop.createSession({projectId:draft.projectId,title,kind:'claude',model:'',effort:'default',permissionMode:'default',isolated:false,adapter:'structured',resumeFrom:id});
    setArchived(false);selectSession(session.id);setModal(null);
  });
  if(!state)return <main className="boot"><Command size={36}/><h2>Claude Workbench</h2><p>{error||'正在打开你的工作台…'}</p></main>;
  const addAttachments=(id:string)=>perform(async()=>{
    const files=await window.desktop.pickAttachments(id);
    setAttachments(old=>({...old,[id]:[...new Map([...(old[id]??[]),...files].map(file=>[file.path,file])).values()]}));
  });
  const appendReview=(text:string)=>{
    if(!active)return false;
    const current=currentDrafts.current[active.id]??active.draft??'';
    const next=(current?current+'\n\n':'')+text;
    if(next.length>128*1024){report(new Error('草稿过长，请先整理现有内容后再添加。原草稿已保留。'));return false;}
    saveDraftFor(active.id,next);return true;
  };
  const activePanels=active?(panelDrafts.current.get(active.id)??active.panelDrafts??{}):{};
  const projectsById=new Map(state.projects.map(project=>[project.id,project]));
  const query=search.trim().toLowerCase();
  const sessions=state.sessions.filter(s => s.archived===archived && (projectId==='all'||s.projectId===projectId) && `${s.title} ${s.cwd} ${projectsById.get(s.projectId)?.name??''}`.toLowerCase().includes(query)).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
  const groupedSessions=new Map<string,Session[]>();
  for(const session of sessions){const group=groupedSessions.get(session.projectId)??[];group.push(session);groupedSessions.set(session.projectId,group);}
  const groupIds=[...projectsById.keys(),...Array.from(groupedSessions.keys()).filter(id=>!projectsById.has(id))];
  const sessionGroups=groupIds.filter(id=>(projectId==='all'||projectId===id)&&(!(query||archived)||groupedSessions.has(id))).map(id=>({id,project:projectsById.get(id),sessions:groupedSessions.get(id)??[]}));
  const liveCount=state.sessions.filter(s => s.status==='running'||s.status==='stopping').length;

  return <div className="app">
    <aside className="sidebar">
      <div className="brand"><div className="brand-icon"><Command size={21}/></div><div>Claude Workbench<small>你的本地开发工作台</small></div><span className="version">02</span></div>
      <button className="primary new-button" onClick={()=>openNew()} disabled={!state.projects.length}><Plus size={16}/>新建会话<span>＋</span></button>
      <div className="search"><Search size={15}/><input aria-label="搜索会话" placeholder="搜索项目或会话…" value={search} onChange={e=>{setSearch(e.target.value);if(e.target.value.trim())setCollapsedGroups(new Set());}}/></div>
      <div className="section-label">工作空间<button className="icon-button" title="添加项目" onClick={()=>void chooseProject()}><Plus size={15}/></button></div>
      {!!state.projects.length&&<select className="workspace-filter" aria-label="工作空间筛选" value={projectId} onChange={e=>{setProjectId(e.target.value);expandGroup(e.target.value);}}><option value="all">全部项目</option>{state.projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select>}
      {!state.projects.length&&<button className="add-project" onClick={()=>void chooseProject()}><Plus size={15}/>添加本地项目文件夹</button>}
      <div className="section-label sessions-label"><span>{archived?'归档会话':'最近会话'} <small>{sessions.length}</small></span><button className={`icon-button ${archived?'mint':''}`} title={archived?'查看活跃会话':'查看归档'} onClick={()=>setArchived(!archived)}><Archive size={15}/></button></div>
      <div className="session-list">
        {sessionGroups.map(group=>{const name=group.project?.name??'原项目已移除',expanded=!collapsedGroups.has(group.id);return <section key={group.id} className="session-group" data-project-id={group.id} aria-label={name+'的会话'}>
          <div className="project-group-header"><button className="project-group-toggle" title={group.project?.path??group.sessions[0]?.cwd} aria-expanded={expanded} aria-controls={'sessions-'+group.id} onClick={()=>toggleGroup(group.id)}><ChevronRight size={13} className="group-chevron"/><Folder size={14}/><span>{name}</span><small>{group.sessions.length}</small></button>{group.project&&<button className="icon-button group-create" aria-label={'在「'+name+'」中创建会话'} title="在此项目创建会话" onClick={()=>openNew('claude',undefined,group.id)}><Plus size={14}/></button>}</div>
          <div id={'sessions-'+group.id} className="project-sessions" hidden={!expanded}>
            {group.sessions.map(s=><button key={s.id} title={s.title} aria-current={activeId===s.id?'page':undefined} className={`session-row ${activeId===s.id?'active':''}`} onClick={()=>selectSession(s.id)}>
              <div className="session-row-icon">{s.kind==='shell'?<TerminalSquare size={15}/>:<span className={`dot ${s.status}`}/>}</div>
              <div><strong>{s.title}</strong><small>{sessionLabel(s)}<span>·</span>{time(s.updatedAt)}</small></div>{s.worktree&&<GitBranch size={13}/>}
            </button>)}
            {!group.sessions.length&&<div className="group-empty">暂无会话</div>}
          </div>
        </section>;})}
        {!sessionGroups.length&&<div className="list-empty">{query?'没有匹配的会话':archived?'暂无归档会话':'从一个新会话开始。'}</div>}
      </div>
      <div className="sidebar-bottom"><button onClick={()=>void openHistory()}><History size={16}/>导入 CLI 历史<ChevronRight size={14}/></button><button onClick={()=>{setDraftSettings({...state.settings});setModal('settings');}}><Settings2 size={16}/>设置与连接<ChevronRight size={14}/></button><div className="local-status"><span className={`dot ${cap.available?'running':'stopped'}`}/>{cap.available?'Claude Code 已安装':'未检测到 Claude Code'}<span>本地</span></div></div>
    </aside>
    <main className="workspace">
      <header className={'topbar '+(active?'session-header':'')}>
        {active?<div className="session-heading">
          <div className="breadcrumb"><Folder size={13}/><span title={project?.path??active.cwd}>{project?.name??'原项目已移除'}</span><ChevronRight size={11}/><span>{structured?'结构化对话':active.kind==='shell'?'Shell':'Claude Code 终端'}</span>{active.worktree&&<GitBranch size={13} aria-label="隔离目录"/>}</div>
          <div className="session-title-line"><h1><span title={active.title}>{active.title}</span><button className="icon-button" title="重命名" onClick={()=>{setRename(active.title);setModal('rename');}}><MoreHorizontal size={18}/></button></h1><span className={`status-tag ${active.status}`}><span className={`dot ${active.status}`}/>{sessionLabel(active)}</span></div>
        </div>:<div className="breadcrumb"><FolderOpen size={15}/><span>{project?.name??'工作空间'}</span><ChevronRight size={13}/><strong>概览</strong></div>}
        <div className="workspace-actions"><AttentionCenter sessions={state.sessions} projects={state.projects} onOpen={item=>{const target=state.sessions.find(session=>session.id===item.sessionId);if(!target)return;setProjectId('all');setArchived(target.archived);setSearch('');selectSession(item.sessionId);setAttentionTarget({...item,nonce:++attentionNonce.current});}}/><button className="icon-button command-button" aria-label="命令面板" title="命令面板 Ctrl / ⌘ + K" onClick={()=>{setPaletteQuery('');setModal('palette');}}><Command size={16}/></button>
          {active&&<div className="session-actions"><button className="secondary compact" aria-label="打开工作目录" title={active.cwd} onClick={()=>void perform(()=>window.desktop.openFolder(active.id))}><FolderOpen size={16}/></button><button className="secondary compact" title="导出会话记录" onClick={()=>void perform(async()=>{const file=await window.desktop.exportTranscript(active.id);if(file)setNotice('会话记录已导出');})}><ArrowDownToLine size={16}/></button>{active.status==='running'?<><button className="secondary compact" onClick={()=>void perform(()=>window.desktop.interruptSession(active.id))}>中断任务</button><button className="secondary compact danger" onClick={()=>void perform(()=>window.desktop.stopSession(active.id))}><Square size={13}/>停止</button></>:<button className="primary compact" disabled={busy||active.archived||active.status==='stopping'} onClick={()=>{if(structured){document.querySelector<HTMLTextAreaElement>('.chat-composer textarea')?.focus();setNotice('输入任务并发送后，将启动 Claude 会话。');}else void start(active);}}><Play size={14}/>{structured?'开始输入':active.started?'恢复会话':'启动会话'}</button>}</div>}
        </div>
      </header>
      {error&&<div className="error-banner" role="alert"><span>{error}</span><button className="icon-button" aria-label="关闭错误" onClick={()=>setError('')}><X size={16}/></button></div>}
      {notice&&<div className="notice"><Check size={14}/>{notice}</div>}
      {!active?<div className="welcome">
        <div className="eyebrow"><span/>LOCAL FIRST · BUILT FOR FOCUS</div><h1>让每个想法，<br/><em>都有一个工作空间。</em></h1>
        <p>在独立会话中运行 Claude Code。保留你的终端、工具和上下文，<br/>把注意力放在正在构建的东西上。</p>
        <div className="welcome-actions"><button className="primary" onClick={()=>state.projects.length?openNew():void chooseProject()}><Plus size={17}/>{state.projects.length?'开始新会话':'添加第一个项目'}<ArrowUpRight size={16}/></button><button className="secondary" onClick={()=>void openHistory()}><History size={16}/>恢复已有会话</button></div>
        <div className="feature-grid"><article><Layers size={23}/><h3>各有上下文</h3><p>项目分组与多会话切换，<br/>随时继续之前的工作。</p><span>01 / SESSIONS</span></article><article><TerminalSquare size={23}/><h3>熟悉的 Claude Code</h3><p>真实交互式终端，保留审批、<br/>MCP、命令与登录方式。</p><span>02 / NATIVE CLI</span></article><article><GitBranch size={23}/><h3>放心探索分支</h3><p>可选 Git worktree，<br/>让并行任务拥有独立目录。</p><span>03 / ISOLATION</span></article></div>
        <div className="welcome-foot"><ShieldCheck size={15}/>凭据和模型连接由本机 Claude Code 管理。<span>WORKBENCH / v{appVersion}</span></div>
      </div>:<>
        {active.kind==='claude'&&!structured&&active.status==='running'&&active.terminalSync!=='synced'&&<div className="sync-note">{active.terminalSync==='unsupported'?'当前 CLI 不支持状态同步，任务状态请查看终端。':'等待 CLI 状态同步，当前仅确认进程正在运行。'}</div>}
        {active.error&&<div className="inline-warning">{active.error}</div>}
        <div className="session-content"><section className="terminal-section">
          {structured&&<ChatPane key={active.id} session={active} draft={composer} onDraft={value=>saveDraftFor(active.id,value)} onSent={expected=>clearSentDraft(active.id,expected)} onError={report} attachments={attachments[active.id]??[]} onAttach={()=>void addAttachments(active.id)} onProjectFiles={()=>setFilePicker(active.id)} approvalDrafts={approvalDrafts.current} readingPositions={readingPositions.current} attentionTarget={attentionTarget?.sessionId===active.id?attentionTarget:undefined} onAttentionHandled={()=>setAttentionTarget(undefined)} onRemoveAttachment={path=>void perform(async()=>{await window.desktop.removeAttachment(active.id,path);setAttachments(old=>({...old,[active.id]:(old[active.id]??[]).filter(file=>file.path!==path)}));})} onAttachmentsSent={paths=>setAttachments(old=>({...old,[active.id]:(old[active.id]??[]).filter(file=>!paths.includes(file.path))}))}/>}
          <div className="terminals" style={{display:structured?'none':undefined}}>{mounted.map(id=>{const session=state.sessions.find(s=>s.id===id);return session?<div className="terminal-slot" key={id} style={{display:id===activeId?'block':'none'}}><TerminalPane session={session} themeId={themeId} settings={state.settings} active={id===activeId} onError={report} ref={handle=>{if(handle)handles.current.set(id,handle);else handles.current.delete(id);}}/></div>:null;})}
            {!active.started&&<div className="terminal-empty"><TerminalSquare size={30}/><h3>会话准备就绪</h3><p>启动后，在这里与 {active.kind==='shell'?'Shell':'Claude Code'} 直接交互。</p>{active.kind==='claude'&&<small>登录、信任目录与工具审批均在终端内完成</small>}</div>}
          </div>
          {active.kind==='claude'&&!structured&&<div className="composer"><textarea aria-label="提示词编辑器" placeholder="在这里准备提示词，或直接在终端输入…" value={composer} onChange={e=>setComposer(e.target.value)}/><div><span>粘贴后，请在终端确认并按 Enter 发送。</span><button className="secondary compact" disabled={active.status!=='running'||!composer.trim()} onClick={()=>{if(composer.length>60000){setError('单次提示词请控制在 60,000 个字符以内。');return;}const handle=handles.current.get(active.id);if(!handle){setError('终端尚未就绪，请稍后再试。');return;}handle.paste(composer);handle.focus();setComposer('');}}><Copy size={13}/>粘贴到终端</button></div></div>}
        </section><aside className={'inspector '+(inspectorTab==='git'?'git-expanded':'')}>
          <div className="inspector-tabs" role="tablist" aria-label="会话面板">{(['context','git','workflows','diagnostics'] as const).map(tab=><button key={tab} role="tab" aria-selected={inspectorTab===tab} className={inspectorTab===tab?'active':''} onClick={()=>setInspectorTab(tab)}>{{context:'上下文',git:'变更',workflows:'工作流',diagnostics:'诊断'}[tab]}</button>)}</div>
          {inspectorTab==='context'&&<div className="panel-content"><div className="section-label">会话上下文<Activity size={14}/></div><div className="detail-block"><label>项目</label><strong>{project?.name??'原项目已移除'}</strong><label>工作目录</label><strong>{active.cwd}</strong><label>运行方式</label><strong>{structured?'结构化对话':active.kind==='shell'?'系统 Shell':'Claude Code 终端'}</strong><label>创建时间</label><strong>{time(active.createdAt)}</strong>{active.kind==='claude'&&<><label>Claude 会话 ID{active.identityPending?' · 等待同步':''}</label><button className="id-copy" title="复制会话 ID" onClick={()=>void perform(async()=>{await navigator.clipboard.writeText(active.claudeId);setNotice('会话 ID 已复制');})}>{active.claudeId.slice(0,18)}…<Copy size={12}/></button></>}</div>
          {active.kind==='claude'&&<><SessionConfig key={active.id} session={active} capabilities={cap} onError={report}/><button className="secondary full" disabled={!active.started||!cap.flags.includes('--fork-session')||busyTask(active.taskState)||active.identityPending} onClick={()=>openNew('claude',active)}><GitBranch size={14}/>从此会话创建分支</button></>}
          <button className="text-button archive-button" disabled={['running','stopping'].includes(active.status)} onClick={()=>void perform(async()=>{await window.desktop.updateSession({id:active.id,archived:!active.archived});selectSession('');})}><Archive size={14}/>{active.archived?'取消归档':'归档会话'}</button>
          <button className="text-button danger archive-button" disabled={['running','stopping'].includes(active.status)} onClick={()=>setDeleteConfirm(active.id)}>删除会话</button>
          {deleteConfirm===active.id&&<div className="action-confirm"><p>删除工作台中的会话记录。原始 CLI 历史会保留；隔离目录需要先清理。</p><button className="secondary compact" onClick={()=>setDeleteConfirm('')}>取消</button><button className="secondary compact danger" disabled={busy} onClick={()=>void perform(async()=>{flushDrafts();await window.desktop.deleteSession(active.id);selectSession('');})}>确认删除会话</button></div>}</div>}
          {inspectorTab==='git'&&<GitPanel key={active.id} session={active} onError={report} onReview={appendReview} draft={activePanels.git??emptyGitReviewDraft()} onDraft={update=>updatePanel(active.id,'git',update)}/>}
          {inspectorTab==='diagnostics'&&<DiagnosticsPanel key={active.id+active.cwd} sessionId={active.id} onError={report}/>}
          {inspectorTab==='workflows'&&<WorkflowPanel key={active.id} session={active} onError={report} onTemplate={appendReview} draft={activePanels.workflow??emptyWorkflowDraft()} onDraft={update=>updatePanel(active.id,'workflow',update)}/>}
        </aside></div>
      </>}
      <footer className="statusbar"><span><span className={`dot ${cap.available?'running':'stopped'}`}/>{cap.available?cap.version:'未检测到 Claude Code'}</span><span><span className="running-count"><span className={`dot ${liveCount?'running':'idle'}`}/>{liveCount} / {state.settings.maxSessions} 运行中</span>{platform==='win32'?'Windows':platform==='darwin'?'macOS':'Linux'}<span>UTF-8</span><span>v{appVersion}</span></span></footer>
    </main>
    {filePicker&&<FilePicker key={filePicker} sessionId={filePicker} selected={[]} onClose={()=>setFilePicker('')} onError={report} onPick={paths=>{const id=filePicker;const value=drafts[id]??state.sessions.find(s=>s.id===id)?.draft??'';saveDraftFor(id,value+(value?'\n\n':'')+'请参考以下项目文件：\n'+paths.map(p=>'@'+JSON.stringify(p)).join('\n'));setFilePicker('');}}/>}
    {modal&&<Dialog className={modal==='settings'?'preferences':''} onClose={()=>setModal(null)} closeDisabled={busy} label={modal==='new'?'新建会话':modal==='settings'?'设置与连接':modal==='rename'?'重命名会话':modal==='palette'?'命令面板':'导入 CLI 历史'}><button className="icon-button close-modal" disabled={busy} aria-label="关闭弹窗" onClick={()=>setModal(null)}><X size={20}/></button>
      {modal==='palette'&&<><div className="eyebrow">COMMAND PALETTE</div><h2>快速切换</h2><input aria-label="查找命令与会话" autoFocus placeholder="查找会话或操作…" value={paletteQuery} onChange={e=>setPaletteQuery(e.target.value)}/><div className="palette-results">{['新建会话','导入 CLI 历史','设置与连接'].filter(name=>name.includes(paletteQuery)).map(name=><button key={name} onClick={()=>{if(name==='新建会话')openNew();else if(name==='导入 CLI 历史')void openHistory();else{setDraftSettings({...state.settings});setModal('settings');}}}>{name}<ChevronRight size={14}/></button>)}{state.sessions.filter(s=>(s.title+' '+s.cwd).toLowerCase().includes(paletteQuery.toLowerCase())).map(s=><button key={s.id} onClick={()=>{setProjectId('all');setArchived(s.archived);setSearch('');selectSession(s.id);setModal(null);}}><span>{s.title}<small>{s.cwd}</small></span><ChevronRight size={14}/></button>)}</div></>}
      {modal==='new'&&<><div className="eyebrow">NEW SESSION</div><h2>{draft.fork?'创建会话分支':'开始新的工作'}</h2><p>为这次任务选择项目和运行方式。</p><form onSubmit={event=>{event.preventDefault();void perform(async()=>{const session=await window.desktop.createSession({...draft,title:draft.title.trim()||(draft.kind==='shell'?'项目终端':'新的开发会话')});selectSession(session.id);setArchived(false);setModal(null);});}}>
        <label>项目<select aria-label="项目" value={draft.projectId} onChange={e=>setDraft({...draft,projectId:e.target.value})}>{state.projects.map(p=><option key={p.id} value={p.id}>{p.name} — {p.path}</option>)}</select></label>
        <label>会话名称<input autoFocus maxLength={120} aria-label="会话名称" placeholder="例如：重构记忆检索模块" value={draft.title} onChange={e=>setDraft({...draft,title:e.target.value})}/></label>
        <div className="segmented"><button type="button" className={draft.kind==='claude'?'chosen':''} onClick={()=>setDraft({...draft,kind:'claude',adapter:'structured'})}><Sparkles size={16}/>Claude Code</button><button type="button" disabled={!!draft.fork} className={draft.kind==='shell'?'chosen':''} onClick={()=>setDraft({...draft,kind:'shell',adapter:'terminal'})}><TerminalSquare size={16}/>Shell 终端</button></div>
        {draft.kind==='claude'&&<><label>交互方式<select aria-label="交互方式" value={draft.adapter??'structured'} onChange={e=>setDraft({...draft,adapter:e.target.value as 'structured'|'terminal'})}><option value="structured">结构化对话 · 消息、工具与审批</option><option value="terminal">原生终端 · 完整 CLI 交互</option></select></label><div className="form-grid"><label>模型<input aria-label="模型" value={draft.model} placeholder="默认 / opus / sonnet" onChange={e=>setDraft({...draft,model:e.target.value})}/></label><label>推理强度<select aria-label="推理强度" value={draft.effort} onChange={e=>setDraft({...draft,effort:e.target.value as Effort})}>{cap.efforts.map(e=><option key={e} value={e}>{e==='default'?'跟随 CLI 设置':e}</option>)}</select></label></div><label>权限模式<select value={draft.permissionMode} onChange={e=>setDraft({...draft,permissionMode:e.target.value as PermissionMode})}><option value="default">默认 · 按需审批</option><option value="plan">Plan · 只做规划</option><option value="acceptEdits">自动接受文件编辑</option></select></label>{draft.effort==='ultracode'&&<p className="hint">ultracode 由 CLI 定义，不会被替换成 max。模型是否支持仍由 CLI 校验。</p>}</>}
        <label className="checkbox"><input type="checkbox" checked={draft.isolated} onChange={e=>setDraft({...draft,isolated:e.target.checked})}/><span>创建独立 Git worktree<small>从当前 HEAD 创建新分支；不带入未提交改动。</small></span></label>
        {!cap.available&&draft.kind==='claude'&&<p className="hint">可以先创建会话；启动前请在设置中连接 Claude Code。</p>}
        <button className="primary full" disabled={busy||!draft.projectId}>{busy?<Loader2 size={16} className="spin"/>:<Plus size={16}/>}创建会话</button>
      </form></>}
      {modal==='settings'&&draftSettings&&<><div className="eyebrow">PREFERENCES</div><h2>设置与连接</h2><p>选择工作台外观，管理本机 Claude Code 连接。</p><form onSubmit={event=>{event.preventDefault();void savePreferences(false);}}>
        <ThemePicker value={normalizeThemeId(draftSettings.theme)} disabled={busy} onChange={theme=>setDraftSettings({...draftSettings,theme})}/>
        <label>Claude Code 可执行文件<input aria-label="Claude Code 路径" disabled={busy} value={draftSettings.claudePath} placeholder="留空自动检测 · C:\Users\你\.local\bin\claude.exe" onChange={e=>setDraftSettings({...draftSettings,claudePath:e.target.value})}/></label>
        <label>Shell 可执行文件<input value={draftSettings.shellPath} placeholder="留空自动使用 PowerShell / Bash / Zsh" onChange={e=>setDraftSettings({...draftSettings,shellPath:e.target.value})}/></label>
        <div className="form-grid"><label>最大并发会话<input type="number" min={1} max={12} value={draftSettings.maxSessions} onChange={e=>setDraftSettings({...draftSettings,maxSessions:Number(e.target.value)})}/></label><label>终端字号<input type="number" min={11} max={24} value={draftSettings.fontSize} onChange={e=>setDraftSettings({...draftSettings,fontSize:Number(e.target.value)})}/></label></div>
        <p className="hint">{draftSettings.claudePath!==state.settings.claudePath?'路径尚未保存；点击“保存并检测”以检查当前输入。':'检测路径：'+(state.settings.claudePath||'自动查找')}</p>
        <div className={`connection-box ${cap.available?'connected':''}`}><div><span className={`dot ${cap.available?'running':'error'}`}/><strong>{busy?'正在保存并检查设置…':cap.available?cap.version:'未检测到 CLI'}</strong></div><p>{busy?'请稍候…':cap.available?cap.executable:cap.error||'保存设置后自动检测 CLI。'}</p>{cap.available&&<small>可用强度：{cap.efforts.filter(x=>x!=='default').join(' / ')||'跟随 CLI'}</small>}</div>
        <p className="hint">在终端完成 Claude 登录。API Key、MCP 与 provider 继续使用 Claude Code 自身的配置；客户端不保存凭据。设置变更用于后续启动的进程。</p>
        <label className="checkbox"><input type="checkbox" checked={draftSettings.notifications??false} onChange={e=>setDraftSettings({...draftSettings,notifications:e.target.checked})}/><span>任务完成与等待审批时显示通知</span></label><label className="checkbox"><input type="checkbox" checked={draftSettings.closeToTray??false} onChange={e=>setDraftSettings({...draftSettings,closeToTray:e.target.checked})}/><span>关闭窗口后保留到系统托盘<small>任务继续运行，可从托盘重新打开。</small></span></label>
        <label>工作台数据目录<code className="data-path">{dataPath}</code></label>
        <div className="modal-actions"><button type="button" className="secondary" disabled={busy} onClick={()=>void savePreferences(true)}><RefreshCw size={14}/>保存并检测</button><button className="primary" disabled={busy}>{busy?<Loader2 className="spin" size={15}/>:<Check size={15}/>}保存设置</button></div>
      </form></>}
      {modal==='history'&&<><div className="eyebrow">CONTINUE YOUR WORK</div><h2>导入 CLI 历史</h2><p>{state.projects.find(p=>p.id===draft.projectId)?.name} · 最近的本地会话</p><input aria-label="搜索历史全文" placeholder="搜索标题和对话内容…" value={historyQuery} onChange={e=>setHistoryQuery(e.target.value)}/><div className="history-list">{historyBusy?<p>正在读取 Claude 历史…</p>:history.length?history.map(h=><button key={h.id} disabled={busy} onClick={()=>void importHistory(h.id,h.title)}><div><strong>{h.title}</strong><small>{time(h.modifiedAt)} · {h.id.slice(0,8)}</small></div><ArrowUpRight size={16}/></button>):<p>没有找到可导入的记录。也可以使用会话 UUID。</p>}</div>{historyNext!==null&&!historyBusy&&<button className="secondary compact full" disabled={busy} onClick={()=>void moreHistory()}>加载更多历史</button>}<form onSubmit={event=>{event.preventDefault();void importHistory(draft.resumeFrom||'',`导入会话 · ${(draft.resumeFrom||'').slice(0,8)}`);}}><label>通过 UUID 导入<input aria-label="历史会话 UUID" placeholder="00000000-0000-0000-0000-000000000000" value={draft.resumeFrom||''} onChange={e=>setDraft({...draft,resumeFrom:e.target.value})}/></label><button className="primary full" disabled={busy||!draft.resumeFrom}><History size={15}/>导入会话</button></form><p className="hint">只读扫描 CLI 记录。导入不会修改原始历史；首次恢复时会由 Claude Code 校验。</p></>}
      {modal==='rename'&&active&&<><h2>重命名会话</h2><form onSubmit={event=>{event.preventDefault();void perform(async()=>{await window.desktop.updateSession({id:active.id,title:rename});setModal(null);});}}><label>名称<input aria-label="新的会话名称" autoFocus maxLength={120} value={rename} onChange={e=>setRename(e.target.value)}/></label><button className="primary full" disabled={busy||!rename.trim()}>保存</button></form></>}
      {error&&<div className="modal-error" role="alert">{error}</div>}
    </Dialog>}
  </div>;
}
