import { useCallback, useEffect, useRef, useState } from 'react';
import { LoaderCircle, RefreshCw, ShieldCheck, X } from 'lucide-react';
import type { ChatAttention } from '../shared/chat';
import type { Project, Session } from '../shared/types';
import { Dialog } from './Dialog';
import { paintActionFeedback } from './action-feedback';

export function AttentionCenter({sessions,projects,onOpen}:{sessions:Session[];projects:Project[];onOpen:(item:ChatAttention)=>void}){
  const [items,setItems]=useState<ChatAttention[]>([]),[open,setOpen]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[opening,setOpening]=useState<string>(),[refreshing,setRefreshing]=useState(false),[loaded,setLoaded]=useState(false);
  const sequence=useRef(0),mounted=useRef(true),refreshBusy=useRef(false),chooseToken=useRef<object|undefined>(undefined),refreshQueued=useRef(false),sessionsRef=useRef(sessions),onOpenRef=useRef(onOpen);
  sessionsRef.current=sessions;onOpenRef.current=onOpen;
  const refresh=useCallback(async(queueIfBusy=false):Promise<void>=>{
    // State updates are batched; refs also block a second click in this frame.
    if(refreshBusy.current||chooseToken.current){if(queueIfBusy)refreshQueued.current=true;return;}
    refreshBusy.current=true;refreshQueued.current=false;setRefreshing(true);
    const seq=++sequence.current;
    try{
      await paintActionFeedback();
      if(!mounted.current||seq!==sequence.current)return;
      const value=await window.desktop.chatAttention();
      if(mounted.current&&seq===sequence.current){setItems(value);setError('');setLoaded(true);}
    }
    catch(error){if(mounted.current&&seq===sequence.current)setError(String(error));}
    finally{
      refreshBusy.current=false;
      if(mounted.current){setRefreshing(false);if(refreshQueued.current)void refresh();}
    }
  },[]);
  useEffect(()=>{
    mounted.current=true;void refresh(true);let timer:ReturnType<typeof setTimeout>|undefined;
    const off=window.desktop.onChat(()=>{if(!timer)timer=setTimeout(()=>{timer=undefined;void refresh(true);},120);});
    const focus=()=>void refresh(true);window.addEventListener('focus',focus);
    return()=>{mounted.current=false;sequence.current++;chooseToken.current=undefined;clearTimeout(timer);off();window.removeEventListener('focus',focus);};
  },[refresh]);
  const close=()=>{chooseToken.current=undefined;setOpening(undefined);setOpen(false);};
  const choose=async(item:ChatAttention)=>{
    if(refreshBusy.current||chooseToken.current)return;
    const token={};chooseToken.current=token;
    const seq=++sequence.current;
    setOpening(JSON.stringify([item.sessionId,item.requestId]));setNotice('');
    try{
      await paintActionFeedback();
      if(!mounted.current||chooseToken.current!==token)return;
      const current=await window.desktop.chatAttention();
      if(!mounted.current||chooseToken.current!==token||seq!==sequence.current)return;
      setItems(current);setError('');setLoaded(true);
      const target=current.find(value=>value.sessionId===item.sessionId&&value.requestId===item.requestId);
      if(!target||!sessionsRef.current.some(session=>session.id===item.sessionId)){setNotice('这项请求已处理或已失效。');return;}
      close();onOpenRef.current(target);
    }catch(error){if(mounted.current&&chooseToken.current===token)setError(String(error));}
    finally{
      if(chooseToken.current===token){chooseToken.current=undefined;if(mounted.current)setOpening(undefined);}
      if(mounted.current&&!chooseToken.current&&refreshQueued.current)void refresh();
    }
  };
  const current=items.filter(item=>sessions.some(session=>session.id===item.sessionId));
  return <>
    <button className={'text-button attention-button '+(current.length?'has-pending':'')} title={error?'待处理请求暂时无法更新，点击重试':'查看所有会话的工具审批与提问'} onClick={()=>{setOpen(true);setNotice('');void refresh();}}><ShieldCheck size={14}/>待处理 <span aria-live="polite">{error?'!':loaded?current.length:'…'}</span></button>
    {open&&<Dialog label="待处理请求" onClose={close}>
      <div className="modal-title"><h2>待处理请求</h2><button className="icon-button" aria-label="关闭待处理请求" onClick={close}><X size={18}/></button></div>
      <p className="panel-note">所有项目中仍有效的工具审批与提问。进入会话后查看详情并处理。</p>
      {error&&<p className="chat-error" role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
      {(refreshing||!loaded&&!error)&&<p className="panel-note" role="status">{loaded?'正在刷新待处理请求…':'正在加载待处理请求…'}</p>}
      {loaded&&!refreshing&&!current.length&&!error&&<p className="list-empty">暂无待处理请求。</p>}
      <div className="attention-list" aria-busy={refreshing||!!opening}>{current.map(item=>{const session=sessions.find(session=>session.id===item.sessionId)!;const key=JSON.stringify([item.sessionId,item.requestId]);return <button key={key} disabled={refreshing||!!opening} onClick={()=>void choose(item)}><span><strong>{session.title}</strong><small>{projects.find(project=>project.id===session.projectId)?.name??'原项目已移除'}</small></span><span>{opening===key?<><LoaderCircle size={14} className="spin"/>正在打开…</>:item.kind==='question'?'需要回答':'工具审批 · '+item.toolName}</span></button>;})}</div>
      <button className="secondary compact" disabled={refreshing||!!opening} onClick={()=>void refresh()}><RefreshCw size={14} className={refreshing?'spin':undefined}/>{refreshing?'正在刷新…':'刷新请求'}</button>
    </Dialog>}
  </>;
}
