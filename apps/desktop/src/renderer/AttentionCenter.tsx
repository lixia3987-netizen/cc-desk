import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw, ShieldCheck, X } from 'lucide-react';
import type { ChatAttention } from '../shared/chat';
import type { Project, Session } from '../shared/types';
import { Dialog } from './Dialog';

export function AttentionCenter({sessions,projects,onOpen}:{sessions:Session[];projects:Project[];onOpen:(item:ChatAttention)=>void}){
  const [items,setItems]=useState<ChatAttention[]>([]),[open,setOpen]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[opening,setOpening]=useState(false);
  const sequence=useRef(0),mounted=useRef(true);
  const refresh=useCallback(async()=>{
    const seq=++sequence.current;
    try{const value=await window.desktop.chatAttention();if(mounted.current&&seq===sequence.current){setItems(value);setError('');}}
    catch(error){if(mounted.current&&seq===sequence.current)setError(String(error));}
  },[]);
  useEffect(()=>{
    mounted.current=true;void refresh();let timer:ReturnType<typeof setTimeout>|undefined;
    const off=window.desktop.onChat(()=>{if(!timer)timer=setTimeout(()=>{timer=undefined;void refresh();},120);});
    const focus=()=>void refresh();window.addEventListener('focus',focus);
    return()=>{mounted.current=false;sequence.current++;clearTimeout(timer);off();window.removeEventListener('focus',focus);};
  },[refresh]);
  const choose=async(item:ChatAttention)=>{
    setOpening(true);setNotice('');
    try{
      const current=await window.desktop.chatAttention();
      if(!mounted.current)return;
      sequence.current++;setItems(current);setError('');
      if(!current.some(value=>value.sessionId===item.sessionId&&value.requestId===item.requestId)){setNotice('这项请求已处理或已失效。');return;}
      setOpen(false);onOpen(item);
    }catch(error){if(mounted.current)setError(String(error));}
    finally{if(mounted.current)setOpening(false);}
  };
  const current=items.filter(item=>sessions.some(session=>session.id===item.sessionId));
  return <>
    <button className={'text-button attention-button '+(current.length?'has-pending':'')} title={error?'待处理请求暂时无法更新，点击重试':'查看所有会话的工具审批与提问'} onClick={()=>{setOpen(true);setNotice('');void refresh();}}><ShieldCheck size={14}/>待处理 <span aria-live="polite">{error?'!':current.length}</span></button>
    {open&&<Dialog label="待处理请求" onClose={()=>setOpen(false)}>
      <div className="modal-title"><h2>待处理请求</h2><button className="icon-button" aria-label="关闭待处理请求" onClick={()=>setOpen(false)}><X size={18}/></button></div>
      <p className="panel-note">所有项目中仍有效的工具审批与提问。进入会话后查看详情并处理。</p>
      {error&&<p className="chat-error" role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
      {!current.length&&!error&&<p className="list-empty">暂无待处理请求。</p>}
      <div className="attention-list">{current.map(item=>{const session=sessions.find(session=>session.id===item.sessionId)!;return <button key={JSON.stringify([item.sessionId,item.requestId])} disabled={opening} onClick={()=>void choose(item)}><span><strong>{session.title}</strong><small>{projects.find(project=>project.id===session.projectId)?.name??'原项目已移除'}</small></span><span>{item.kind==='question'?'需要回答':'工具审批 · '+item.toolName}</span></button>;})}</div>
      <button className="secondary compact" onClick={()=>void refresh()}><RefreshCw size={14}/>刷新请求</button>
    </Dialog>}
  </>;
}
