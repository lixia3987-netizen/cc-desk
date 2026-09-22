import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, File, GitBranch, Loader2, RefreshCw, Search, X } from 'lucide-react';
import type { Session } from '../shared/types';
import type { GitChanges, GitDiff, ProjectFile, ProjectFiles, WorktreeInfo } from '../shared/git';
import type { EnvironmentDiagnostics } from '../shared/diagnostics';
import { Dialog } from './Dialog';
import type { GitReviewDraft, UpdateDraft } from '../shared/panel-drafts';

export function GitPanel({session,onError,onReview,draft,onDraft}:{session:Session;onError:(error:unknown)=>void;onReview:(text:string)=>boolean;draft:GitReviewDraft;onDraft:UpdateDraft<GitReviewDraft>}) {
  const [changes,setChanges]=useState<GitChanges>(),[diff,setDiff]=useState<GitDiff>(),[tree,setTree]=useState<WorktreeInfo>(),[busy,setBusy]=useState(false),[refreshing,setRefreshing]=useState(false),[checkedAt,setCheckedAt]=useState(''),[confirm,setConfirm]=useState<'merge'|'cleanup'>(),[notice,setNotice]=useState('');
  const {selected,staged}=draft;
  const feedback=draft.feedback[selected]??'';
  const setStaged=(staged:boolean)=>onDraft(current=>({...current,staged}));
  const setFeedback=(text:string)=>onDraft(current=>{
    const feedback={...current.feedback};
    if(text)feedback[selected]=text;else delete feedback[selected];
    return {...current,feedback};
  });
  const seq=useRef(0),refreshSeq=useRef(0),mounted=useRef(true);
  const refreshTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  const lastTask=useRef({state:session.taskState,status:session.status});
  const refresh=useCallback(async()=>{
    const request=++refreshSeq.current;setRefreshing(true);
    try {
      const [result,worktree]=await Promise.all([window.desktop.gitChanges(session.id),window.desktop.worktreeInfo(session.id)]);
      if(mounted.current&&request===refreshSeq.current){setChanges(result);setTree(worktree);setCheckedAt(new Date().toLocaleTimeString());}
    }catch(error){if(mounted.current&&request===refreshSeq.current)onError(error);}
    finally{if(mounted.current&&request===refreshSeq.current)setRefreshing(false);}
  },[session.id,onError]);
  const scheduleRefresh=useCallback(()=>{clearTimeout(refreshTimer.current);refreshTimer.current=setTimeout(()=>void refresh(),120);},[refresh]);
  useEffect(()=>{
    mounted.current=true;void refresh();
    // A fast turn can start and finish between two batched workspace snapshots.
    // Use the task state carried by the immediate chat event, not only React props.
    const off=window.desktop.onChat((id,state)=>{if(id===session.id&&['completed','interrupted','error'].includes(state??''))scheduleRefresh();});
    window.addEventListener('focus',scheduleRefresh);
    return()=>{mounted.current=false;seq.current++;refreshSeq.current++;clearTimeout(refreshTimer.current);off();window.removeEventListener('focus',scheduleRefresh);};
  },[refresh,scheduleRefresh,session.id]);
  useEffect(()=>{
    const previous=lastTask.current;lastTask.current={state:session.taskState,status:session.status};
    const finished=previous.state!==session.taskState&&['completed','interrupted','error'].includes(session.taskState??'');
    const stopped=previous.status!==session.status&&['running','stopping'].includes(previous.status)&&!['running','stopping'].includes(session.status);
    if((finished&&session.adapter!=='structured')||stopped)scheduleRefresh();
  },[session.taskState,session.status,session.adapter,scheduleRefresh]);
  const missing=!!selected&&!!changes?.available&&!changes.truncated&&!changes.changes.some(change=>change.path===selected);
  useEffect(()=>{
    setDiff(undefined);const request=++seq.current;
    if(!selected||missing||!changes?.available)return;
    void window.desktop.gitDiff(session.id,selected,staged).then(value=>{if(mounted.current&&request===seq.current)setDiff(value);}).catch(error=>{if(mounted.current&&request===seq.current)onError(error);});
    return()=>{seq.current++;};
  },[selected,staged,session.id,onError,changes,missing]);
  const act=async()=>{setBusy(true);try{const result=confirm==='merge'?await window.desktop.mergeWorktree(session.id):await window.desktop.cleanupWorktree(session.id);setNotice(result.message);setConfirm(undefined);await refresh();}catch(error){onError(error);}finally{setBusy(false);}};
  return <div className="panel-content"><div className="panel-heading"><strong><GitBranch size={14}/> {changes?.branch||'Git 变更'}</strong><button className="icon-button" title="刷新 Git 状态" disabled={refreshing} onClick={()=>void refresh()}><RefreshCw size={14} className={refreshing?'spin':''}/></button></div>
    <p className="panel-note" role="status">{refreshing?'正在刷新 Git 状态…':checkedAt?'更新于 '+checkedAt:''}</p>
    {changes?.error&&<p className="panel-note">{changes.error}</p>}
    {!changes&&<p className="panel-note">正在读取 Git 状态…</p>}
    {changes?.available&&<><div className="changed-files">{changes.changes.map(change=><button key={change.path} title={change.path} className={selected===change.path?'selected':''} onClick={()=>onDraft(current=>({...current,selected:change.path,staged:change.staged&&!change.unstaged}))}><span className={change.conflicted?'danger':''}>{change.conflicted?'!':change.untracked?'U':change.indexStatus+change.worktreeStatus}</span><span>{change.path}</span></button>)}{!changes.changes.length&&<p className="panel-note">工作区干净</p>}</div>{changes.truncated&&<p className="panel-note">文件数量较多，仅展示部分结果。</p>}
    {selected&&<><strong className="review-file">{selected}</strong>{missing&&<p className="panel-note">该文件已不在变更列表中，审阅草稿已保留。</p>}<div className="segmented small"><button className={!staged?'chosen':''} onClick={()=>setStaged(false)}>未暂存</button><button className={staged?'chosen':''} onClick={()=>setStaged(true)}>已暂存</button></div><div className="diff-view" aria-label="代码差异">{missing?<p>当前没有可显示的变更。</p>:diff?.binary?<p>二进制文件，无法显示文本差异。</p>:diff?<pre>{diff.text.split('\n').map((line,index)=><div key={index} className={line.startsWith('+')&&!line.startsWith('+++')?'added':line.startsWith('-')&&!line.startsWith('---')?'removed':line.startsWith('@@')?'hunk':''}>{line||' '}</div>)}</pre>:<p>正在读取差异…</p>}</div>{diff?.truncated&&<p className="panel-note">差异过长，当前显示内容已截断。</p>}<textarea aria-label="代码审阅反馈" maxLength={60000} placeholder="对所选文件的审阅意见…" value={feedback} onChange={e=>setFeedback(e.target.value)}/><button className="secondary compact full" disabled={!feedback.trim()} onClick={()=>{if(onReview('请根据以下代码审阅意见检查并修复 '+selected+'：\n\n'+feedback))setFeedback('');}}>将审阅意见加入草稿</button></>}
    </>}
    {session.worktree&&tree&&!tree.owned&&<div className="worktree-panel"><h4>隔离目录</h4>{tree.reasons.map((reason,i)=><p className="panel-note" key={i}>{reason}</p>)}</div>}
    {tree?.owned&&<div className="worktree-panel"><h4>隔离工作区</h4><p className="panel-note">{tree.branch} → {tree.baseBranch??'原项目分支'}</p><p>{tree.clean?'工作区干净':'存在未提交改动'} · {tree.merged?'已合入基础分支':'尚未合入'}</p>{tree.reasons.map((reason,i)=><p className="panel-note" key={i}>{reason}</p>)}<div className="panel-actions"><button className="secondary compact" disabled={busy||!tree.canMerge} onClick={()=>setConfirm('merge')}>合并到原项目</button><button className="secondary compact danger" disabled={busy||!tree.canCleanup} onClick={()=>setConfirm('cleanup')}>清理隔离目录</button></div>{confirm&&<div className="action-confirm"><p>{confirm==='merge'?'将已提交变更快进合并到原项目。请确认这是你要交付的变更。':'将移除这个已合并且干净的隔离目录，保留 Git 分支。'}</p><button className="secondary compact" disabled={busy} onClick={()=>setConfirm(undefined)}>取消</button><button className="primary compact" disabled={busy} onClick={()=>void act()}>{busy?<Loader2 size={13} className="spin"/>:<Check size={13}/>}确认{confirm==='merge'?'合并':'清理'}</button></div>}</div>}
    {notice&&<p className="panel-note" role="status">{notice}</p>}
  </div>;
}

const authLabels:Record<string,string>={authenticated:'登录状态有效',unauthenticated:'尚未登录',unknown:'登录状态未确认',unsupported:'此 CLI 不支持登录检测',unavailable:'CLI 不可用'};
export function DiagnosticsPanel({sessionId,onError}:{sessionId?:string;onError:(error:unknown)=>void}) {
  const [value,setValue]=useState<EnvironmentDiagnostics>(),[busy,setBusy]=useState(false);const seq=useRef(0);
  const refresh=useCallback(async()=>{const request=++seq.current;setBusy(true);try{const result=await window.desktop.diagnostics(sessionId);if(request===seq.current)setValue(result);}catch(error){onError(error);}finally{if(request===seq.current)setBusy(false);}},[sessionId,onError]);
  useEffect(()=>{void refresh();return()=>{seq.current++;};},[refresh]);
  return <div className="panel-content"><div className="panel-heading"><strong>环境诊断</strong><button className="icon-button" title="重新诊断" disabled={busy} onClick={()=>void refresh()}><RefreshCw size={14} className={busy?'spin':''}/></button></div>{!value?<p className="panel-note">正在检查 CLI 与配置…</p>:<><div className="diagnostic-item"><strong>诊断工作目录</strong><code>{value.cwd}</code></div><div className="diagnostic-item"><strong>{value.cli.installed?'已检测到 Claude Code':'未检测到 Claude Code'}</strong><span>{value.cli.version}</span><code>{value.cli.binary}</code></div><div className="diagnostic-item"><strong>{authLabels[value.auth.state]}</strong><p>{value.auth.message}</p><small>登录状态不代表当前模型服务可达。</small></div><div className="diagnostic-item"><strong>Provider 与环境变量</strong><code>{value.provider.origin||'跟随 Claude Code 配置'}</code><p>网络与模型请求尚未验证</p>{value.provider.env.map(item=><small key={item.name}>{item.name} · {item.present?'已设置':'未设置'} · {item.source}</small>)}</div><h4>配置来源</h4>{value.configs.map(item=><div className="diagnostic-item" key={item.path}><strong>{item.scope} · {item.status==='found'?'已发现':item.status==='invalid'?'格式异常':'不存在'}</strong><code>{item.path}</code>{item.message&&<p>{item.message}</p>}</div>)}<h4>MCP 服务 · {value.mcp.length}</h4>{!value.mcp.length&&<p className="panel-note">未发现可展示的 MCP 配置。</p>}{value.mcp.map((item,i)=><div className="diagnostic-item" key={item.scope+item.name+i}><strong>{item.name} <span>已配置</span></strong><small>{item.scope} · {item.transport}</small><code>{item.origin||item.commandName}</code>{item.envNames.length>0&&<small>环境变量：{item.envNames.join('、')}</small>}</div>)}<p className="panel-note">诊断只读取配置，不会启动 MCP 服务。运行状态可在结构化会话的初始化记录中查看。</p><h4>Skills · {value.skills.length}</h4>{value.skills.map((item,i)=><div className="diagnostic-item" key={item.path+i}><strong>{item.name}</strong><small>{item.scope}</small><code>{item.path}</code></div>)}{value.warnings.map((warning,i)=><p className="panel-note warning" key={i}>{warning}</p>)}<p className="panel-note">检查时间：{new Date(value.checkedAt).toLocaleString('zh-CN')}</p></>}</div>;
}

export function FilePicker({sessionId,selected,onPick,onClose,onError}:{sessionId:string;selected:string[];onPick:(paths:string[])=>void;onClose:()=>void;onError:(error:unknown)=>void}) {
  const [query,setQuery]=useState(''),[files,setFiles]=useState<ProjectFiles>(),[choices,setChoices]=useState(selected),[preview,setPreview]=useState<ProjectFile>();const seq=useRef(0),previewSeq=useRef(0);
  useEffect(()=>{const request=++seq.current;const timer=setTimeout(()=>{void window.desktop.listProjectFiles(sessionId,query).then(value=>{if(request===seq.current)setFiles(value);}).catch(onError);},150);return()=>{clearTimeout(timer);seq.current++;};},[sessionId,query,onError]);
  useEffect(()=>()=>{previewSeq.current++;},[]);
  const show=async(path:string)=>{const request=++previewSeq.current;try{const file=await window.desktop.readProjectFile(sessionId,path);if(request===previewSeq.current)setPreview(file);}catch(error){onError(error);}};
  return <Dialog className="file-picker" label="引用项目文件" onClose={onClose}><button className="icon-button close-modal" aria-label="关闭文件选择" onClick={onClose}><X size={19}/></button><div className="eyebrow">PROJECT CONTEXT</div><h2>引用项目文件</h2><p>选择需要 Claude 阅读的文件。目录外文件不会加入。</p><div className="search"><Search size={15}/><input autoFocus aria-label="搜索项目文件" placeholder="按路径查找…" value={query} onChange={e=>setQuery(e.target.value)}/></div><div className="file-picker-body"><div className="file-picker-list">{files?.files.map(path=><div key={path}><input type="checkbox" aria-label={'选择 '+path} checked={choices.includes(path)} onChange={e=>setChoices(value=>e.target.checked?[...value,path]:value.filter(p=>p!==path))}/><button title={path} onClick={()=>void show(path)}><File size={13}/><span>{path}</span></button></div>)}{files&&!files.files.length&&<p className="panel-note">没有匹配的文件。</p>}{files?.truncated&&<p className="panel-note">结果已截断，请缩小搜索范围。</p>}</div><div className="file-preview">{preview?<><strong>{preview.path}</strong>{preview.binary?<p>二进制文件：无法预览文本。</p>:<pre>{preview.content}</pre>}{preview.truncated&&<small>预览内容已截断。</small>}</>:<p>点击文件名预览内容</p>}</div></div><div className="modal-actions"><span>{choices.length} 个文件</span><button className="secondary" onClick={onClose}>取消</button><button className="primary" onClick={()=>onPick(choices)}>添加到上下文</button></div></Dialog>;
}
