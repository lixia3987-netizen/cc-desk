import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Check, CornerDownLeft, File, Loader2, MessageSquare, Paperclip, Search, ShieldCheck, Square, X } from 'lucide-react';
import type { Attachment, Session } from '../shared/types';
import type { ChatApproval, ChatMessage, ChatPage, ChatPageOptions, ChatSnapshot } from '../shared/chat';
import { MessageText } from './MessageText';
import { ChatSearch } from './ChatSearch';
import { ApprovalDrafts, type ApprovalDraft } from './approval-drafts';
import { useChatScroll, type ChatReadingPosition } from './chat-scroll';
import { SubtaskPanel } from './SubtaskPanel';
import { PromptEditor } from './PromptEditor';
import { hasActiveSubtasks, isTaskBusy } from '../shared/session-activity';
import { ContextMeter } from './ContextMeter';
import { ChatQueue } from './ChatQueue';
import { useChatSubmission } from './useChatSubmission';
export { MessageText } from './MessageText';

export const taskLabels: Record<string,string> = { idle:'等待任务', starting:'正在启动', thinking:'正在思考', tool_running:'执行工具', waiting_approval:'等待审批', waiting_input:'等待回答', completed:'本轮完成', interrupted:'已中断', error:'执行失败' };
const usageLabels:Record<string,string>={inputTokens:'输入',outputTokens:'输出',cacheReadTokens:'缓存读取',cacheCreationTokens:'缓存写入',costUSD:'估算费用 $',durationMs:'耗时 ms',turns:'轮次'};

function ApprovalCard({approval,sessionId,onError,drafts}:{approval:ChatApproval;sessionId:string;onError:(error:unknown)=>void;drafts:ApprovalDrafts}) {
  const [value,setValue]=useState<ApprovalDraft>(()=>drafts.get(sessionId,approval.requestId)),[busy,setBusy]=useState(false);
  const {answers,reason}=value;
  const update=(patch:Partial<ApprovalDraft>)=>setValue(previous=>{const next={...previous,...patch};drafts.set(sessionId,approval.requestId,next);return next;});
  const setAnswers=(change:(answers:Record<string,string>)=>Record<string,string>)=>update({answers:change(answers)});
  const setReason=(reason:string)=>update({reason});
  const respond=async(behavior:'allow'|'deny')=>{
    setBusy(true);
    try {await window.desktop.respondChat(sessionId,approval.requestId,{behavior,message:reason||undefined,answers:approval.kind==='question'?answers:undefined});drafts.delete(sessionId,approval.requestId);}
    catch(error){onError(error);} finally {setBusy(false);}
  };
  const questions=approval.questions??[];
  return <section data-request-id={approval.requestId} tabIndex={-1} className="approval-card" aria-label={approval.kind==='question'?'等待回答':'工具审批'}>
    <header><ShieldCheck size={17}/><strong>{approval.kind==='question'?'Claude 需要你的回答':'批准工具：'+approval.toolName}</strong></header>
    {approval.kind==='question'?questions.map((q,index)=><fieldset key={index} disabled={busy}><legend>{q.question}</legend><div className="question-options">{q.options.map((option,i)=>{
      const selected=q.multiSelect?(answers[q.question]??'').split(', ').includes(option.label):answers[q.question]===option.label;
      return <button key={i} type="button" className={selected?'chosen':''} aria-pressed={selected} onClick={()=>setAnswers(value=>{
        const old=(value[q.question]??'').split(', ').filter(Boolean);
        return {...value,[q.question]:q.multiSelect?(selected?old.filter(p=>p!==option.label):[...old,option.label]).join(', '):option.label};
      })}><span>{selected&&<Check size={12}/>}{option.label}</span>{option.description&&<small>{option.description}</small>}</button>;
    })}</div><input aria-label={'回答：'+q.question} placeholder="也可以填写自己的回答" value={answers[q.question]??''} onChange={e=>setAnswers(value=>({...value,[q.question]:e.target.value}))}/></fieldset>):<pre className="tool-input">{JSON.stringify(approval.input,null,2)}</pre>}
    <input aria-label="审批说明" placeholder="可选：拒绝原因或补充说明" value={reason} onChange={e=>setReason(e.target.value)} disabled={busy}/>
    <div className="approval-actions"><button className="secondary compact" disabled={busy} onClick={()=>void respond('deny')}><X size={14}/>拒绝</button><button className="primary compact" disabled={busy||(approval.kind==='question'&&questions.some(q=>!answers[q.question]?.trim()))} onClick={()=>void respond('allow')}>{busy?<Loader2 className="spin" size={14}/>:<Check size={14}/>} {approval.kind==='question'?'提交回答':'允许本次'}</button></div>
  </section>;
}

function sameMessage(left:ChatMessage,right:ChatMessage) {
  return left.id===right.id&&left.text===right.text&&left.role===right.role&&left.toolName===right.toolName&&left.isError===right.isError&&left.parentToolUseId===right.parentToolUseId&&left.truncated===right.truncated&&JSON.stringify(left.input)===JSON.stringify(right.input);
}
const ChatMessageRow=memo(function ChatMessageRow({message}:{message:ChatMessage}) {
  const content=<><MessageText text={message.text}/>{message.truncated&&<p className="panel-note message-truncated">此消息过长，仅显示部分内容。可导出会话查看完整记录。</p>}</>;
  return message.role==='tool'?<details data-message-id={message.id} className={'tool-card '+(message.isError?'has-error':'')}><summary><span className={'dot '+(message.isError?'error':'idle')}/><strong>{message.toolName??'工具结果'}</strong>{message.parentToolUseId&&<small>子任务</small>}<span>{message.isError?'失败':'查看详情'}</span></summary>{message.input&&<pre className="tool-input">{JSON.stringify(message.input,null,2)}</pre>}{content}</details>:<article data-message-id={message.id} className={'chat-message '+message.role}><header>{message.role==='user'?'你':message.role==='assistant'?'Claude':'会话记录'}{message.parentToolUseId&&<small>子任务</small>}</header>{content}</article>;
},(previous,next)=>sameMessage(previous.message,next.message));

export function ChatPane({session,draft,onDraft,onSent,onError,onAttach,onProjectFiles,attachments,onRemoveAttachment,onAttachmentsSent,approvalDrafts,readingPositions,attentionTarget,onAttentionHandled,disabled=false}:{
  session:Session;draft:string;onDraft:(value:string)=>void;onSent:(expectedDraft:string)=>void;onError:(error:unknown)=>void;onAttach:()=>void;onProjectFiles:()=>void;attachments:Attachment[];onRemoveAttachment:(path:string)=>void;onAttachmentsSent:(files:Attachment[])=>void;approvalDrafts:ApprovalDrafts;readingPositions:Map<string,ChatReadingPosition>;attentionTarget?:{requestId:string;nonce:number};onAttentionHandled:()=>void;disabled?:boolean;
}) {
  const [snapshot,setSnapshot]=useState<ChatSnapshot>();
  const request=useRef(0), mounted=useRef(true),pageRequest=useRef(0),restored=useRef(false);
  const commandsLoading=useRef<Promise<void> | undefined>(undefined);
  // Capture before the live snapshot renders: its first layout cannot resolve an archived anchor.
  const initialReading=useRef(readingPositions.get(session.id));
  const [archive,setArchive]=useState<ChatPage>(),[paging,setPaging]=useState(false),[showSearch,setShowSearch]=useState(false),[highlight,setHighlight]=useState('');
  const [historyNotice,setHistoryNotice]=useState(''),[exhaustedBefore,setExhaustedBefore]=useState('');
  const visible=useMemo(()=>snapshot&&archive?{...snapshot,messages:archive.messages,pending:[]}:snapshot,[snapshot,archive]);
  const {scroll,content,follow,onScroll,jumpToLatest:scrollLatest,jumpToItem}=useChatScroll(session.id,visible,readingPositions);
  const jumpToLatest=()=>{pageRequest.current++;setPaging(false);setArchive(undefined);setHighlight('');setHistoryNotice('');scrollLatest();};
  const openPage=useCallback(async(options:ChatPageOptions,saved?:ChatReadingPosition)=>{
    const seq=++pageRequest.current;setPaging(true);
    try{
      const page=await window.desktop.chatPage(session.id,options);
      if(!mounted.current||seq!==pageRequest.current)return;
      if(!page.messages.length){
        if(options.before)setExhaustedBefore(options.before);
        setHistoryNotice(options.after?'已到本地保留记录的末尾。':page.incomplete?'没有更早的本地记录；部分原始内容需导出查看。':'已到本地保留记录的开头。');
        return;
      }
      setHistoryNotice('');
      setArchive(page);setHighlight(options.around??'');
      if(page.messages.length)jumpToItem(options.around??page.messages[0].id,'message',saved?.offset??8);
    }catch(error){if(mounted.current&&seq===pageRequest.current)throw error;}
    finally{if(mounted.current&&seq===pageRequest.current)setPaging(false);}
  },[session.id,jumpToItem]);
  useEffect(()=>{
    if(!snapshot||restored.current)return;restored.current=true;
    const saved=initialReading.current;
    if(saved&&!saved.follow&&saved.messageId&&!snapshot.messages.some(message=>message.id===saved.messageId))void openPage({around:saved.messageId},saved).catch(onError);
  },[snapshot,openPage,onError]);
  useEffect(()=>{
    const key=(event:KeyboardEvent)=>{if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='f'&&!event.isComposing&&!document.querySelector('[role=dialog]')){event.preventDefault();setShowSearch(true);}};
    window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);
  },[]);
  const load=useCallback(async()=>{const seq=++request.current;const value=await window.desktop.chatSnapshot(session.id);if(mounted.current&&seq===request.current){approvalDrafts.reconcile(session.id,value.pending);setSnapshot(value);}},[session.id,approvalDrafts]);
  const prepareCommands=useCallback(()=>{
    if(commandsLoading.current)return commandsLoading.current;
    const pending=window.desktop.prepareChatCommands(session.id).then(async()=>{if(mounted.current)await load();});
    commandsLoading.current=pending;
    const clear=()=>{if(commandsLoading.current===pending)commandsLoading.current=undefined;};
    void pending.then(clear,clear);
    return pending;
  },[session.id,load]);
  useEffect(()=>{
    mounted.current=true;let timer:ReturnType<typeof setTimeout>|undefined;
    void load().catch(onError);
    const off=window.desktop.onChat(id=>{if(id===session.id&&!timer)timer=setTimeout(()=>{timer=undefined;if(mounted.current)void load().catch(onError);},80);});
    return ()=>{mounted.current=false;request.current++;pageRequest.current++;clearTimeout(timer);off();};
  },[load,onError,session.id]);
  const handled=useRef(onAttentionHandled);handled.current=onAttentionHandled;
  const [focusRequest,setFocusRequest]=useState('');
  useEffect(()=>{
    if(!attentionTarget)return;let cancelled=false;
    // Obtain a fresh snapshot before deciding whether a navigation target expired.
    const seq=++request.current;pageRequest.current++;setPaging(false);setArchive(undefined);setHighlight('');setShowSearch(false);
    void window.desktop.chatSnapshot(session.id).then(value=>{
      if(cancelled||!mounted.current)return;
      if(seq===request.current)setSnapshot(value);
      if(value.pending.some(item=>item.requestId===attentionTarget.requestId)){
        jumpToItem(attentionTarget.requestId,'request');setFocusRequest(attentionTarget.requestId);
      }else onError(new Error('这项请求已处理或已失效。'));
      handled.current();
    }).catch(error=>{if(!cancelled){onError(error);handled.current();}});
    return()=>{cancelled=true;};
  },[attentionTarget?.nonce,session.id,jumpToItem,onError]);
  useLayoutEffect(()=>{
    if(!focusRequest||archive)return;
    const card=Array.from(content.current?.querySelectorAll<HTMLElement>('[data-request-id]')??[]).find(item=>item.dataset.requestId===focusRequest);
    if(card){card.focus({preventScroll:true});setFocusRequest('');}
  },[focusRequest,archive,snapshot,content]);
  useLayoutEffect(()=>{
    for(const row of content.current?.querySelectorAll<HTMLElement>('[data-message-id]')??[]){
      const selected=row.dataset.messageId===highlight;row.classList.toggle('search-target',selected);
      if(selected&&row instanceof HTMLDetailsElement)row.open=true;
    }
  },[highlight,visible,content]);
  const task=snapshot?.taskState??session.taskState??'idle', running=isTaskBusy(task)||hasActiveSubtasks(session)||session.status==='stopping';
  const taskLabel=hasActiveSubtasks(session)&&!isTaskBusy(task)?'子任务执行中':taskLabels[task]??task;
  const composerDisabled=disabled||session.archived;
  const queued=running||!!snapshot?.queue?.items.length;
  const {submitting,submit:send}=useChatSubmission({sessionId:session.id,draft,attachments,disabled:composerDisabled,
    onAccepted:jumpToLatest,onSent,onAttachmentsSent,onError,refresh:load});
  return <div className="chat-pane">
    <div className="chat-reading-toolbar"><button className="text-button" title="会话内查找 Ctrl / ⌘ + F" onClick={()=>setShowSearch(true)}><Search size={14}/>查找消息</button>{archive&&<span>正在阅读历史记录</span>}{archive&&<button className="text-button" onClick={jumpToLatest}>返回最新对话</button>}</div>
      {(snapshot?.truncated||archive)&&<div className="history-controls chat-page-controls"><button className="secondary compact" disabled={paging||!!archive&&!archive.before||!visible?.messages.length||exhaustedBefore===visible?.messages[0]?.id} onClick={()=>void openPage({before:archive?.before??visible?.messages[0]?.id}).catch(onError)}>{paging?'读取中…':'查看更早消息'}</button>{archive&&<><span>本页 {archive.messages.length} 条</span><button className="secondary compact" disabled={paging||!archive.after} onClick={()=>void openPage({after:archive.after!}).catch(onError)}>查看较新消息</button></>}</div>}
    {historyNotice&&<p className="panel-note history-reading-note" role="status">{historyNotice}</p>}
    {showSearch&&<ChatSearch sessionId={session.id} onClose={()=>{pageRequest.current++;setPaging(false);setShowSearch(false);}} onSelect={(id,query)=>openPage({around:id,query})}/>}
    <div className="chat-scroll" ref={scroll} aria-label="对话记录" onScroll={onScroll}><div className="chat-scroll-content" ref={content}>
      {!visible?.messages.length&&!snapshot?.queue?.items.length&&<div className="chat-empty"><MessageSquare size={32}/><h3>从一个明确的任务开始</h3><p>描述目标、引用项目文件，在这里查看 Claude 的执行过程。</p><small>需要确认的工具请求会显示审批卡片。</small></div>}
      {archive?.incomplete&&<p className="panel-note">部分原始记录未导入、损坏或过长，可导出原始记录进一步查看。</p>}
      {archive&&!archive.before&&<p className="panel-note">已到本地保留记录的开头。</p>}
      {visible?.messages.map(message=><ChatMessageRow key={message.id} message={message}/>)}
      {visible?.pending.map(approval=><ApprovalCard key={approval.requestId} approval={approval} sessionId={session.id} onError={onError} drafts={approvalDrafts}/>)}
      {!archive&&snapshot?.error&&<p className="chat-error" role="alert">{snapshot.error}</p>}
      {!archive&&running&&<div className="thinking-indicator"><Loader2 size={13} className="spin"/>{session.status==='stopping'?'正在停止':taskLabel}</div>}
      {!archive&&<ChatQueue sessionId={session.id} queue={snapshot?.queue} disabled={composerDisabled} onError={onError} refresh={load}/>}
    </div></div>
    {(!follow||archive)&&<button className="jump-latest secondary compact" onClick={jumpToLatest}>跳到最新消息</button>}
    {snapshot?.mcpServers&&snapshot.mcpServers.length>0&&<details className="chat-services"><summary>MCP 初始化状态 · {snapshot.mcpServers.length} 个服务</summary>{snapshot.mcpServers.map((server,index)=><span key={server.name+index}>{server.name} · {server.status==='connected'?'已连接':server.status==='failed'?'连接失败':server.status==='pending'?'连接中':server.status}</span>)}</details>}
    <SubtaskPanel session={session}/>
    <div className="chat-meta"><span className={'dot '+(task==='error'?'error':running?'running':'idle')}/>{session.status==='stopping'?'正在停止':taskLabel}{snapshot?.model&&<span className="chat-model" title="CLI 报告的当前模型">{snapshot.model}</span>}{snapshot?.usage&&<span className="usage" title="CLI 实际返回的用量与费用估算，不代表订阅剩余额度">{Object.entries(snapshot.usage).filter(([,value])=>typeof value==='number').map(([key,value])=>(usageLabels[key]??key)+': '+Number(value).toLocaleString(undefined,{maximumFractionDigits:key==='costUSD'?6:0})).join(' · ')}</span>}</div>
    <ContextMeter context={snapshot?.context}/>
    <div className="composer chat-composer">{attachments.length>0&&<div className="attachment-chips">{attachments.map(file=><span key={file.path} title={file.path}><Paperclip size={12}/>{file.name}<button className="icon-button" aria-label={'移除附件 '+file.name} disabled={composerDisabled||submitting} onClick={()=>onRemoveAttachment(file.path)}><X size={12}/></button></span>)}</div>}
      <PromptEditor placeholder={queued?'继续输入，发送后加入队列…':'描述任务，或输入 / 选择命令与 Skills…'} value={draft} disabled={composerDisabled} onChange={onDraft} onSend={()=>void send()}
        commands={snapshot?.commands} loadCommands={prepareCommands}/>
      <div className="chat-composer-actions"><button className="icon-button" title="添加图片、PDF 或文件附件" aria-label="添加附件" disabled={composerDisabled} onClick={onAttach}><Paperclip size={16}/></button><button className="icon-button" title="引用项目文件" aria-label="引用项目文件" disabled={composerDisabled} onClick={onProjectFiles}><File size={16}/></button><span title="Enter 发送；执行中发送将加入队列；Ctrl / ⌘ + Enter 或 Shift + Enter 换行；草稿自动保存">Enter {queued?'加入队列':'发送'} · Ctrl / ⌘ + Enter 换行{attachments.length>0&&' · '+attachments.length+' 个附件 · '+(attachments.reduce((sum,file)=>sum+file.bytes,0)/1024).toFixed(1)+' KB'}</span>{running&&<button className="secondary compact" disabled={composerDisabled||session.status==='stopping'} onClick={()=>void window.desktop.interruptSession(session.id).catch(onError)}><Square size={12}/>{session.status==='stopping'?'正在停止':'中断'}</button>}<button className="primary compact" disabled={submitting||(!draft.trim()&&!attachments.length)||composerDisabled} onClick={()=>void send()}>{submitting?<Loader2 size={14} className="spin"/>:<CornerDownLeft size={14}/>} {submitting?'提交中…':queued?'加入队列':'发送任务'}</button></div>
    </div>
  </div>;
}
