import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, Archive, ArrowDownToLine, ArrowUpRight, Check, ChevronRight, Command, Copy, Folder, FolderOpen, GitBranch, History, Layers, Loader2, MoreHorizontal, Play, Plus, RefreshCw, Search, Settings2, ShieldCheck, Sparkles, Square, TerminalSquare, X, Zap } from 'lucide-react';
import type { AppState, Capabilities, Effort, GitInfo, HistoryEntry, NewSession, PermissionMode, Session, Settings } from '../shared/types';
import { TerminalPane, type TerminalHandle } from './TerminalPane';

const statusLabel = {idle:'待启动',running:'运行中',stopping:'停止中',stopped:'已停止',error:'需处理'};
const time = (date:string) => new Date(date).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
type Modal = 'new'|'settings'|'history'|'rename'|null;
const workflows = [
  {name:'完整开发',label:'规划 → 实现 → 验证',text:'请完成以下开发任务：\n\n【在这里填写任务】\n\n先阅读项目规范及相关代码，说明实现计划，再完成代码变更并运行与风险相关的测试。最后复核 diff，报告实际变更、测试结果和剩余限制。不要仅输出方案后停止。'},
  {name:'代码审查',label:'按严重程度列出问题',text:'请审查当前项目最近的变更。先阅读项目规范，重点检查正确性、权限边界、进程生命周期、数据丢失风险和可验证的性能问题。按严重程度列出具体文件、触发条件、影响与修复建议；不要为了凑数量报告推测性问题。此轮先给出审查结果。'},
  {name:'定位并修复',label:'复现 → 修复 → 回归',text:'请定位并修复以下问题：\n\n【在这里填写复现步骤与错误】\n\n先收集证据并复现，再做范围最小的修复。必要时添加能捕获该问题的回归测试，执行验证并报告根因。保留无关改动。'}
];

export function App() {
  const [state,setState]=useState<AppState>();
  const [cap,setCap]=useState<Capabilities>({available:false,executable:'',version:'',flags:[],efforts:['default']});
  const [projectId,setProjectId]=useState('all');
  const [activeId,setActiveId]=useState('');
  const [search,setSearch]=useState('');
  const [archived,setArchived]=useState(false);
  const [modal,setModal]=useState<Modal>(null);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [busy,setBusy]=useState(false);
  const [composer,setComposer]=useState('');
  const [git,setGit]=useState<GitInfo>();
  const [history,setHistory]=useState<HistoryEntry[]>([]);
  const [historyBusy,setHistoryBusy]=useState(false);
  const [dataPath,setDataPath]=useState('');
  const [platform,setPlatform]=useState('');
  const [draftSettings,setDraftSettings]=useState<Settings>();
  const [rename,setRename]=useState('');
  const [draft,setDraft]=useState<NewSession>({projectId:'',title:'',kind:'claude',model:'',effort:'default',permissionMode:'default',isolated:false});
  const handles=useRef(new Map<string,TerminalHandle>());
  const [mounted,setMounted]=useState<string[]>([]);
  const active=state?.sessions.find(s => s.id===activeId);
  const project=state?.projects.find(p => p.id===(active?.projectId ?? projectId));
  const report=useCallback((error:unknown) => setError(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/,'') : String(error)),[]);
  const refresh=useCallback(async () => {const snapshot=await window.desktop.snapshot();setState(snapshot.state);setCap(snapshot.capabilities);setDataPath(snapshot.dataPath);setPlatform(snapshot.platform);},[]);
  const perform=useCallback(async (action:()=>Promise<unknown>) => {setError('');setBusy(true);try {await action();}catch(error){report(error);}finally{setBusy(false);}},[report]);
  useEffect(() => {
    if(!window.desktop){setError('请使用 npm run dev 或已安装的桌面应用打开此界面。');return;}
    void refresh().catch(report);
    return window.desktop.onState(value => {setState(value);void window.desktop.snapshot().then(s => setCap(s.capabilities)).catch(report);});
  },[refresh,report]);
  useEffect(() => {if(activeId)setMounted(ids => ids.includes(activeId)?ids:[...ids,activeId]);},[activeId]);
  useEffect(() => {
    if(!activeId){setGit(undefined);return;}
    let cancelled=false;setGit(undefined);
    void window.desktop.gitInfo(activeId).then(value => {if(!cancelled)setGit(value);}).catch(report);
    return () => {cancelled=true;};
  },[activeId,report]);
  useEffect(() => {if(!notice)return;const timer=setTimeout(()=>setNotice(''),3500);return ()=>clearTimeout(timer);},[notice]);

  const openNew=(kind:'claude'|'shell'='claude',fork?:Session) => {
    const selected=fork?.projectId ?? (projectId==='all'?state?.projects[0]?.id:projectId) ?? '';
    setDraft({projectId:selected,title:fork?`${fork.title} · 分支`:'',kind,model:fork?.model??'',effort:fork?.effort??'default',permissionMode:fork?.permissionMode??'default',isolated:false,resumeFrom:fork?.claudeId,fork:!!fork});
    setModal('new');
  };
  const chooseProject=() => perform(async () => {const p=await window.desktop.chooseProject();if(p)setProjectId(p.id);});
  const start=(session:Session) => perform(async () => {await window.desktop.startSession(session.id);});
  const openHistory=() => perform(async () => {
    const id=projectId==='all'?(active?.projectId??state?.projects[0]?.id):projectId;
    if(!id)throw new Error('请先添加一个项目。');
    setDraft(d => ({...d,projectId:id,resumeFrom:undefined}));setHistory([]);setModal('history');setHistoryBusy(true);
    try {setHistory(await window.desktop.history(id));}finally{setHistoryBusy(false);}
  });
  const importHistory=(id:string,title:string) => perform(async () => {
    const session=await window.desktop.createSession({projectId:draft.projectId,title,kind:'claude',model:'',effort:'default',permissionMode:'default',isolated:false,resumeFrom:id});
    setArchived(false);setActiveId(session.id);setModal(null);
  });
  if(!state)return <main className="boot"><Command size={36}/><h2>Claude Workbench</h2><p>{error||'正在打开你的工作台…'}</p></main>;
  const sessions=state.sessions.filter(s => s.archived===archived && (projectId==='all'||s.projectId===projectId) && `${s.title} ${s.cwd}`.toLowerCase().includes(search.toLowerCase()));
  const liveCount=state.sessions.filter(s => s.status==='running'||s.status==='stopping').length;

  return <div className="app">
    <aside className="sidebar">
      <div className="brand"><div className="brand-icon"><Command size={21}/></div><div>Claude Workbench<small>你的本地开发工作台</small></div><span className="version">01</span></div>
      <button className="primary new-button" onClick={()=>openNew()} disabled={!state.projects.length}><Plus size={16}/>新建会话<span>⌘</span></button>
      <div className="search"><Search size={15}/><input aria-label="搜索会话" placeholder="搜索会话…" value={search} onChange={e=>setSearch(e.target.value)}/></div>
      <div className="section-label">工作空间<button className="icon-button" title="添加项目" onClick={()=>void chooseProject()}><Plus size={15}/></button></div>
      <button className={`project-row ${projectId==='all'?'selected':''}`} onClick={()=>setProjectId('all')}><Layers size={16}/><span>全部项目</span><small>{state.projects.length}</small></button>
      {state.projects.map(p=><button key={p.id} title={p.path} className={`project-row ${projectId===p.id?'selected':''}`} onClick={()=>setProjectId(p.id)}><Folder size={16}/><span>{p.name}</span><small>{state.sessions.filter(s=>s.projectId===p.id&&!s.archived).length}</small></button>)}
      {!state.projects.length&&<button className="add-project" onClick={()=>void chooseProject()}><Plus size={15}/>添加本地项目文件夹</button>}
      <div className="section-label sessions-label"><span>{archived?'归档会话':'最近会话'} <small>{sessions.length}</small></span><button className={`icon-button ${archived?'mint':''}`} title={archived?'查看活跃会话':'查看归档'} onClick={()=>setArchived(!archived)}><Archive size={15}/></button></div>
      <div className="session-list">
        {sessions.map(s=><button key={s.id} className={`session-row ${activeId===s.id?'active':''}`} onClick={()=>setActiveId(s.id)}>
          <div className="session-row-icon">{s.kind==='shell'?<TerminalSquare size={16}/>:<span className={`dot ${s.status}`}/>}</div>
          <div><strong>{s.title}</strong><small>{statusLabel[s.status]}<span>·</span>{time(s.updatedAt)}</small></div>{s.worktree&&<GitBranch size={13}/>}
        </button>)}
        {!sessions.length&&<div className="list-empty">{search?'没有匹配的会话':archived?'暂无归档会话':'从一个新会话开始。'}</div>}
      </div>
      <div className="sidebar-bottom"><button onClick={()=>void openHistory()}><History size={16}/>导入 CLI 历史<ChevronRight size={14}/></button><button onClick={()=>{setDraftSettings({...state.settings});setModal('settings');}}><Settings2 size={16}/>设置与连接<ChevronRight size={14}/></button><div className="local-status"><span className={`dot ${cap.available?'running':'stopped'}`}/>{cap.available?'Claude Code 已连接':'等待连接 Claude Code'}<span>本地</span></div></div>
    </aside>
    <main className="workspace">
      <header className="topbar"><div className="breadcrumb"><FolderOpen size={15}/>{project?.name??'工作空间'}<ChevronRight size={13}/><strong>{active?.title??'概览'}</strong></div><div className="top-meta"><span className="dot running"/>{liveCount} / {state.settings.maxSessions} 运行中<span className="divider"/><ShieldCheck size={14}/>本地 CLI</div></header>
      {error&&<div className="error-banner" role="alert"><span>{error}</span><button className="icon-button" aria-label="关闭错误" onClick={()=>setError('')}><X size={16}/></button></div>}
      {notice&&<div className="notice"><Check size={14}/>{notice}</div>}
      {!active?<div className="welcome">
        <div className="eyebrow"><span/>LOCAL FIRST · BUILT FOR FOCUS</div><h1>让每个想法，<br/><em>都有一个工作空间。</em></h1>
        <p>在独立会话中运行 Claude Code。保留你的终端、工具和上下文，<br/>把注意力放在正在构建的东西上。</p>
        <div className="welcome-actions"><button className="primary" onClick={()=>state.projects.length?openNew():void chooseProject()}><Plus size={17}/>{state.projects.length?'开始新会话':'添加第一个项目'}<ArrowUpRight size={16}/></button><button className="secondary" onClick={()=>void openHistory()}><History size={16}/>恢复已有会话</button></div>
        <div className="feature-grid"><article><Layers size={23}/><h3>各有上下文</h3><p>项目分组与多会话切换，<br/>随时继续之前的工作。</p><span>01 / SESSIONS</span></article><article><TerminalSquare size={23}/><h3>熟悉的 Claude Code</h3><p>真实交互式终端，保留审批、<br/>MCP、命令与登录方式。</p><span>02 / NATIVE CLI</span></article><article><GitBranch size={23}/><h3>放心探索分支</h3><p>可选 Git worktree，<br/>让并行任务拥有独立目录。</p><span>03 / ISOLATION</span></article></div>
        <div className="welcome-foot"><ShieldCheck size={15}/>凭据和模型连接由本机 Claude Code 管理。<span>WORKBENCH / v0.1.0</span></div>
      </div>:<>
        <div className="session-header"><div><div className="eyebrow">{active.kind==='shell'?'SHELL SESSION':'CLAUDE CODE SESSION'}</div><h1>{active.title}<button className="icon-button" title="重命名" onClick={()=>{setRename(active.title);setModal('rename');}}><MoreHorizontal size={20}/></button></h1><div className="session-tags"><span className={`status-tag ${active.status}`}><span className={`dot ${active.status}`}/>{statusLabel[active.status]}</span><span>{active.kind==='shell'?'Shell':active.model||'CLI 默认模型'}</span>{active.kind==='claude'&&<span><Zap size={12}/>{active.effort==='default'?'默认强度':active.effort}</span>}{active.worktree&&<span><GitBranch size={12}/>隔离目录</span>}</div></div>
          <div className="session-actions"><button className="secondary compact" title="导出终端日志" onClick={()=>void perform(async()=>{const file=await window.desktop.exportTranscript(active.id);if(file)setNotice('终端日志已导出');})}><ArrowDownToLine size={16}/></button>{active.status==='running'?<><button className="secondary compact" onClick={()=>void perform(()=>window.desktop.interruptSession(active.id))}>中断任务</button><button className="secondary compact danger" onClick={()=>void perform(()=>window.desktop.stopSession(active.id))}><Square size={13}/>停止</button></>:<button className="primary compact" disabled={busy||active.archived||active.status==='stopping'} onClick={()=>void start(active)}><Play size={14}/>{active.started?'恢复会话':'启动会话'}</button>}</div>
        </div>
        {active.error&&<div className="inline-warning">{active.error}</div>}
        <div className="session-content"><section className="terminal-section"><div className="terminal-toolbar"><span><TerminalSquare size={14}/>交互终端</span><span title={active.cwd}>{active.cwd}</span><button className="icon-button" title="打开工作目录" onClick={()=>void perform(()=>window.desktop.openFolder(active.id))}><FolderOpen size={14}/></button></div>
          <div className="terminals">{mounted.map(id=>{const session=state.sessions.find(s=>s.id===id);return session?<div className="terminal-slot" key={id} style={{display:id===activeId?'block':'none'}}><TerminalPane session={session} settings={state.settings} active={id===activeId} onError={report} ref={handle=>{if(handle)handles.current.set(id,handle);else handles.current.delete(id);}}/></div>:null;})}
            {!active.started&&<div className="terminal-empty"><TerminalSquare size={30}/><h3>会话准备就绪</h3><p>启动后，在这里与 {active.kind==='shell'?'Shell':'Claude Code'} 直接交互。</p>{active.kind==='claude'&&<small>登录、信任目录与工具审批均在终端内完成</small>}</div>}
          </div>
          {active.kind==='claude'&&<div className="composer"><textarea aria-label="提示词编辑器" placeholder="在这里准备提示词，或直接在终端输入…" value={composer} onChange={e=>setComposer(e.target.value)}/><div><span>粘贴后，请在终端确认并按 Enter 发送。</span><button className="secondary compact" disabled={active.status!=='running'||!composer.trim()} onClick={()=>{if(composer.length>60000){setError('单次提示词请控制在 60,000 个字符以内。');return;}handles.current.get(active.id)?.paste(composer);handles.current.get(active.id)?.focus();setComposer('');}}><Copy size={13}/>粘贴到终端</button></div></div>}
        </section><aside className="inspector"><div className="section-label">会话上下文<Activity size={14}/></div><div className="detail-block"><label>项目</label><strong>{project?.name}</strong><label>权限模式</label><strong>{active.kind==='shell'?'系统 Shell':active.permissionMode==='plan'?'Plan · 只做规划':active.permissionMode==='acceptEdits'?'自动接受编辑':'默认 · 按需审批'}</strong><label>创建时间</label><strong>{time(active.createdAt)}</strong>{active.kind==='claude'&&<><label>Claude 会话 ID</label><button className="id-copy" title="复制会话 ID" onClick={()=>void perform(async()=>{await navigator.clipboard.writeText(active.claudeId);setNotice('会话 ID 已复制');})}>{active.claudeId.slice(0,18)}…<Copy size={12}/></button></>}</div>
          <div className="section-label">Git 状态<button className="icon-button" title="刷新 Git 状态" onClick={()=>void perform(async()=>setGit(await window.desktop.gitInfo(active.id)))}><RefreshCw size={13}/></button></div><div className="git-info">{git?.error?<p>当前目录没有可用的 Git 状态。</p>:git?<><span><GitBranch size={13}/>{git.branch}</span><pre>{git.status||'工作区干净'}</pre>{git.diff&&<details><summary>变更统计</summary><pre>{git.diff}</pre></details>}</>:<p>正在读取…</p>}</div>
          {active.kind==='claude'&&<><div className="section-label">工作流提示词<Sparkles size={14}/></div><div className="workflow-list">{workflows.map(w=><button key={w.name} onClick={()=>setComposer(w.text)}><div><strong>{w.name}</strong><small>{w.label}</small></div><ArrowUpRight size={14}/></button>)}</div><p className="workflow-note">模板会放入编辑器，由你确认后发送。</p><button className="secondary full" disabled={!active.started||!cap.flags.includes('--fork-session')} onClick={()=>openNew('claude',active)}><GitBranch size={14}/>从此会话创建分支</button></>}
          <button className="text-button archive-button" disabled={['running','stopping'].includes(active.status)} onClick={()=>void perform(async()=>{await window.desktop.updateSession({id:active.id,archived:!active.archived});setActiveId('');})}><Archive size={14}/>{active.archived?'取消归档':'归档会话'}</button>
        </aside></div>
      </>}
      <footer className="statusbar"><span><span className={`dot ${cap.available?'running':'stopped'}`}/>{cap.available?cap.version:'Claude Code 未连接'}</span><span>{platform==='win32'?'Windows':platform==='darwin'?'macOS':'Linux'}<span>UTF-8</span><span>v0.1.0</span></span></footer>
    </main>
    {modal&&<div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget&&!busy)setModal(null);}}><section className={`modal ${modal==='settings'?'wide':''}`} role="dialog" aria-modal="true" aria-label={modal==='new'?'新建会话':modal==='settings'?'设置与连接':modal==='rename'?'重命名会话':'导入 CLI 历史'}><button className="icon-button close-modal" disabled={busy} aria-label="关闭弹窗" onClick={()=>setModal(null)}><X size={20}/></button>
      {modal==='new'&&<><div className="eyebrow">NEW SESSION</div><h2>{draft.fork?'创建会话分支':'开始新的工作'}</h2><p>为这次任务选择项目和运行方式。</p><form onSubmit={event=>{event.preventDefault();void perform(async()=>{const session=await window.desktop.createSession({...draft,title:draft.title.trim()||(draft.kind==='shell'?'项目终端':'新的开发会话')});setActiveId(session.id);setArchived(false);setModal(null);});}}>
        <label>项目<select aria-label="项目" value={draft.projectId} onChange={e=>setDraft({...draft,projectId:e.target.value})}>{state.projects.map(p=><option key={p.id} value={p.id}>{p.name} — {p.path}</option>)}</select></label>
        <label>会话名称<input autoFocus maxLength={120} aria-label="会话名称" placeholder="例如：重构记忆检索模块" value={draft.title} onChange={e=>setDraft({...draft,title:e.target.value})}/></label>
        <div className="segmented"><button type="button" className={draft.kind==='claude'?'chosen':''} onClick={()=>setDraft({...draft,kind:'claude'})}><Sparkles size={16}/>Claude Code</button><button type="button" disabled={!!draft.fork} className={draft.kind==='shell'?'chosen':''} onClick={()=>setDraft({...draft,kind:'shell'})}><TerminalSquare size={16}/>Shell 终端</button></div>
        {draft.kind==='claude'&&<><div className="form-grid"><label>模型<input aria-label="模型" value={draft.model} placeholder="默认 / opus / sonnet" onChange={e=>setDraft({...draft,model:e.target.value})}/></label><label>推理强度<select aria-label="推理强度" value={draft.effort} onChange={e=>setDraft({...draft,effort:e.target.value as Effort})}>{cap.efforts.map(e=><option key={e} value={e}>{e==='default'?'跟随 CLI 设置':e}</option>)}</select></label></div><label>权限模式<select value={draft.permissionMode} onChange={e=>setDraft({...draft,permissionMode:e.target.value as PermissionMode})}><option value="default">默认 · 按需审批</option><option value="plan">Plan · 只做规划</option><option value="acceptEdits">自动接受文件编辑</option></select></label>{draft.effort==='ultracode'&&<p className="hint">ultracode 由 CLI 定义，不会被替换成 max。模型是否支持仍由 CLI 校验。</p>}</>}
        <label className="checkbox"><input type="checkbox" checked={draft.isolated} onChange={e=>setDraft({...draft,isolated:e.target.checked})}/><span>创建独立 Git worktree<small>从当前 HEAD 创建新分支；不带入未提交改动。</small></span></label>
        {!cap.available&&draft.kind==='claude'&&<p className="hint">可以先创建会话；启动前请在设置中连接 Claude Code。</p>}
        <button className="primary full" disabled={busy||!draft.projectId}>{busy?<Loader2 size={16} className="spin"/>:<Plus size={16}/>}创建会话</button>
      </form></>}
      {modal==='settings'&&draftSettings&&<><div className="eyebrow">PREFERENCES</div><h2>设置与连接</h2><p>连接你已安装的 Claude Code，使用它现有的账户与配置。</p><form onSubmit={event=>{event.preventDefault();void perform(async()=>{await window.desktop.saveSettings(draftSettings);await refresh();setNotice('设置已保存并重新检测');});}}>
        <label>Claude Code 可执行文件<input aria-label="Claude Code 路径" value={draftSettings.claudePath} placeholder="留空自动检测 · C:\Users\你\.local\bin\claude.exe" onChange={e=>setDraftSettings({...draftSettings,claudePath:e.target.value})}/></label>
        <label>Shell 可执行文件<input value={draftSettings.shellPath} placeholder="留空自动使用 PowerShell / Bash / Zsh" onChange={e=>setDraftSettings({...draftSettings,shellPath:e.target.value})}/></label>
        <div className="form-grid"><label>最大并发会话<input type="number" min={1} max={12} value={draftSettings.maxSessions} onChange={e=>setDraftSettings({...draftSettings,maxSessions:Number(e.target.value)})}/></label><label>终端字号<input type="number" min={11} max={24} value={draftSettings.fontSize} onChange={e=>setDraftSettings({...draftSettings,fontSize:Number(e.target.value)})}/></label></div>
        <div className={`connection-box ${cap.available?'connected':''}`}><div><span className={`dot ${cap.available?'running':'error'}`}/><strong>{cap.available?cap.version:'尚未连接'}</strong></div><p>{cap.available?cap.executable:cap.error||'保存设置后自动检测 CLI。'}</p>{cap.available&&<small>可用强度：{cap.efforts.filter(x=>x!=='default').join(' / ')||'跟随 CLI'}</small>}</div>
        <p className="hint">在终端完成 Claude 登录。API Key、MCP 与 provider 继续使用 Claude Code 自身的配置；客户端不保存凭据。设置变更用于后续启动的进程。</p>
        <label>工作台数据目录<code className="data-path">{dataPath}</code></label>
        <div className="modal-actions"><button type="button" className="secondary" disabled={busy} onClick={()=>void perform(async()=>setCap(await window.desktop.detect()))}><RefreshCw size={14}/>重新检测</button><button className="primary" disabled={busy}>{busy?<Loader2 className="spin" size={15}/>:<Check size={15}/>}保存设置</button></div>
      </form></>}
      {modal==='history'&&<><div className="eyebrow">CONTINUE YOUR WORK</div><h2>导入 CLI 历史</h2><p>{state.projects.find(p=>p.id===draft.projectId)?.name} · 最近的本地会话</p><div className="history-list">{historyBusy?<p>正在读取 Claude 历史…</p>:history.length?history.map(h=><button key={h.id} disabled={busy} onClick={()=>void importHistory(h.id,h.title)}><div><strong>{h.title}</strong><small>{time(h.modifiedAt)} · {h.id.slice(0,8)}</small></div><ArrowUpRight size={16}/></button>):<p>没有找到可导入的记录。也可以使用会话 UUID。</p>}</div><form onSubmit={event=>{event.preventDefault();void importHistory(draft.resumeFrom||'',`导入会话 · ${(draft.resumeFrom||'').slice(0,8)}`);}}><label>通过 UUID 导入<input aria-label="历史会话 UUID" placeholder="00000000-0000-0000-0000-000000000000" value={draft.resumeFrom||''} onChange={e=>setDraft({...draft,resumeFrom:e.target.value})}/></label><button className="primary full" disabled={busy||!draft.resumeFrom}><History size={15}/>导入会话</button></form><p className="hint">只读扫描 CLI 记录。导入不会修改原始历史；首次恢复时会由 Claude Code 校验。</p></>}
      {modal==='rename'&&active&&<><h2>重命名会话</h2><form onSubmit={event=>{event.preventDefault();void perform(async()=>{await window.desktop.updateSession({id:active.id,title:rename});setModal(null);});}}><label>名称<input aria-label="新的会话名称" autoFocus maxLength={120} value={rename} onChange={e=>setRename(e.target.value)}/></label><button className="primary full" disabled={busy||!rename.trim()}>保存</button></form></>}
      {error&&<div className="modal-error" role="alert">{error}</div>}
    </section></div>}
  </div>;
}
