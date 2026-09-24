import { useEffect, useRef, useState } from 'react';
import { Loader2, Search, X } from 'lucide-react';
import type { ChatSearchPage } from '../shared/chat';
import { Dialog } from './Dialog';

function Highlight({text,query}:{text:string;query:string}) {
  const index=text.toLowerCase().indexOf(query.trim().toLowerCase());
  return index<0?<>{text}</>:<>{text.slice(0,index)}<mark>{text.slice(index,index+query.trim().length)}</mark>{text.slice(index+query.trim().length)}</>;
}
export function ChatSearch({sessionId,onClose,onSelect}:{sessionId:string;onClose:()=>void;onSelect:(id:string,query:string)=>Promise<void>}){
  const [query,setQuery]=useState(''),[cursors,setCursors]=useState<(string|undefined)[]>([undefined]);
  const [page,setPage]=useState<ChatSearchPage>(),[busy,setBusy]=useState(false),[error,setError]=useState(''),[opening,setOpening]=useState(false);
  const sequence=useRef(0),mounted=useRef(true);
  const before=cursors.at(-1);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{
    const seq=++sequence.current;setPage(undefined);setError('');setBusy(!!query.trim());
    if(!query.trim())return;
    const timer=setTimeout(()=>{void window.desktop.searchChat(sessionId,query,before).then(value=>{if(seq===sequence.current)setPage(value);}).catch(error=>{if(seq===sequence.current)setError(String(error));}).finally(()=>{if(seq===sequence.current)setBusy(false);});},200);
    return()=>{clearTimeout(timer);sequence.current++;};
  },[sessionId,query,before]);
  const select=async(id:string)=>{
    setOpening(true);setError('');
    try{await onSelect(id,query.trim());if(mounted.current)onClose();}
    catch(error){if(mounted.current)setError(String(error));}
    finally{if(mounted.current)setOpening(false);}
  };
  return <Dialog label="会话内查找" className="chat-search-dialog" onClose={onClose}>
    <div className="modal-title"><h2>会话内查找</h2><button className="icon-button" aria-label="关闭查找" onClick={onClose}><X size={18}/></button></div>
    <div className="search"><Search size={16}/><input aria-label="查找消息内容" placeholder="输入文字，查找消息和工具内容…" maxLength={500} disabled={opening} value={query} onChange={event=>{setQuery(event.target.value);setCursors([undefined]);}} onKeyDown={event=>{if(event.key==='Enter'&&!event.nativeEvent.isComposing&&event.nativeEvent.keyCode!==229&&!opening&&page?.hits[0])void select(page.hits[0].id);}}/></div>
    <p className="panel-note">搜索工作台保留的本地记录，按从新到旧排列。点击结果定位原消息。</p>
    {busy&&<p role="status"><Loader2 size={14} className="spin"/>正在查找…</p>}
    {error&&<p className="chat-error" role="alert">{error}</p>}
    {page?.incomplete&&<p className="inline-warning">部分记录未导入、损坏或过长，搜索结果可能不完整。可导出原始记录查看。</p>}
    {page&&!page.hits.length&&<p role="status">{page.nextBefore?'本段记录没有匹配，可继续查找更早记录。':'没有匹配的消息。'}</p>}
    <div className="chat-search-results">{page?.hits.map(hit=><button key={hit.id} disabled={opening} onClick={()=>void select(hit.id)}><span><strong>{hit.role==='user'?'你':hit.role==='assistant'?'Claude':hit.toolName??'会话记录'}</strong><small>{hit.createdAt?new Date(hit.createdAt).toLocaleString('zh-CN'):''}</small></span><p><Highlight text={hit.excerpt} query={query}/></p></button>)}</div>
    {page&&<div className="history-controls"><button className="secondary compact" disabled={busy||opening||cursors.length<2} onClick={()=>setCursors(value=>value.slice(0,-1))}>上一段结果</button><span role="status">本段 {page.hits.length} 条匹配</span><button className="secondary compact" disabled={busy||opening||!page.nextBefore} onClick={()=>setCursors(value=>[...value,page.nextBefore!])}>继续查找</button></div>}
  </Dialog>;
}
