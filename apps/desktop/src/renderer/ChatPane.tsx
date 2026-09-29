import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Check, CornerDownLeft, File, Loader2, MessageSquare, Paperclip, Search, ShieldCheck, Square, X } from 'lucide-react';
import type { ExecutionDescriptor } from '../shared/execution';
import type { Attachment, Session } from '../shared/types';
import type { ChatApproval, ChatMessage, ChatPage, ChatPageOptions, ChatSnapshot, NativeImageAttachment } from '../shared/chat';
import { MessageText } from './MessageText';
import { ChatAttachmentChips, NativeImageAttachments, NativeImageNotice } from './NativeImageAttachments';
import { NativeImagePreview } from './NativeImagePreview';
import { isNativeImagePreviewCurrent, nativeImagePreviewKey, type NativeImagePreviewSelection } from './native-image-preview-state';
import { ChatSearch } from './ChatSearch';
import { ApprovalDrafts, type ApprovalDraft } from './approval-drafts';
import { useChatScroll, type ChatReadingPosition } from './chat-scroll';
import { SubtaskPanel } from './SubtaskPanel';
import { PromptEditor } from './PromptEditor';
import { hasActiveSubtasks, isTaskBusy } from '../shared/session-activity';
import { ContextMeter } from './ContextMeter';
import { NativeRecoveryPanel } from './NativeRecoveryPanel';
import { ChatQueue } from './ChatQueue';
import { useChatSubmission } from './useChatSubmission';
import { useChatFileDrop } from './useChatFileDrop';
import { Dialog } from './Dialog';
import { sessionReadLifecycle } from './session-read-lifecycle';
import { isMissingTranscriptError } from '../shared/session-recovery';
import { ChatSnapshotSync, type ChatSyncState } from './chat-snapshot-sync';
import { NativeTaskPanel } from './NativeTaskPanel';
import { NativeCommandPanel } from './NativeCommandPanel';
import './native-command.css';
import { NativeChangeSetPreview, NativeChangeSetResult, nativeChangeSetCanApprove, nativeChangeSetResultLabel } from './NativeChangeSetPreview';
import './native-task.css';
import './native-change-set.css';
export { MessageText } from './MessageText';

export const taskLabels: Record<string,string> = { idle:'等待任务', starting:'正在启动', thinking:'正在思考', tool_running:'执行工具', waiting_approval:'等待审批', waiting_input:'等待回答', completed:'本轮完成', interrupted:'已中断', error:'执行失败' };
const usageLabels:Record<string,string>={inputTokens:'输入',outputTokens:'输出',cacheReadTokens:'缓存读取',cacheCreationTokens:'缓存写入',costUSD:'估算费用 $',durationMs:'耗时 ms',turns:'轮次'};

function ApprovalCard({approval,sessionId,onError,drafts,engineName,allowMessage,isNative}:{approval:ChatApproval;sessionId:string;onError:(error:unknown)=>void;drafts:ApprovalDrafts;engineName:string;allowMessage:boolean;isNative:boolean}) {
  const [value,setValue]=useState<ApprovalDraft>(()=>drafts.get(sessionId,approval.requestId)),[busy,setBusy]=useState(false);
  const changeSet=isNative&&approval.toolName==='apply_change_set';
  const question=approval.kind==='question'&&!changeSet;
  const changeSetPreview=approval.kind==='permission'?approval.nativeChangeSet:undefined;
  const invalidChangeSet=changeSet&&!nativeChangeSetCanApprove(changeSetPreview);
  const {answers,reason}=value;
  const update=(patch:Partial<ApprovalDraft>)=>setValue(previous=>{const next={...previous,...patch};drafts.set(sessionId,approval.requestId,next);return next;});
  const setAnswers=(change:(answers:Record<string,string>)=>Record<string,string>)=>update({answers:change(answers)});
  const setReason=(reason:string)=>update({reason});
  const respond=async(behavior:'allow'|'deny')=>{
    if(busy||behavior==='allow'&&invalidChangeSet)return;
    setBusy(true);
    try {await window.desktop.respondChat(sessionId,approval.requestId,{behavior,message:allowMessage?reason||undefined:undefined,answers:question?answers:undefined});drafts.delete(sessionId,approval.requestId);}
    catch(error){onError(error);} finally {setBusy(false);}
  };
  const questions=approval.questions??[];
  return <section data-request-id={approval.requestId} tabIndex={-1} className="approval-card" aria-label={question?'等待回答':'工具审批'}>
    <header><ShieldCheck size={17}/><strong>{question?engineName+' 需要你的回答':'批准工具：'+approval.toolName}</strong></header>
    {question?questions.map((q,index)=><fieldset key={index} disabled={busy}><legend>{q.question}</legend><div className="question-options">{q.options.map((option,i)=>{
      const selected=q.multiSelect?(answers[q.question]??'').split(', ').includes(option.label):answers[q.question]===option.label;
      return <button key={i} type="button" className={selected?'chosen':''} aria-pressed={selected} onClick={()=>setAnswers(value=>{
        const old=(value[q.question]??'').split(', ').filter(Boolean);
        return {...value,[q.question]:q.multiSelect?(selected?old.filter(p=>p!==option.label):[...old,option.label]).join(', '):option.label};
      })}><span>{selected&&<Check size={12}/>}{option.label}</span>{option.description&&<small>{option.description}</small>}</button>;
    })}</div><input aria-label={'回答：'+q.question} placeholder="也可以填写自己的回答" value={answers[q.question]??''} onChange={e=>setAnswers(value=>({...value,[q.question]:e.target.value}))}/></fieldset>):changeSet?<NativeChangeSetPreview preview={changeSetPreview}/>:<pre className="tool-input">{JSON.stringify(approval.input,null,2)}</pre>}
    {allowMessage&&<input aria-label="审批说明" placeholder="可选：拒绝原因或补充说明" value={reason} onChange={e=>setReason(e.target.value)} disabled={busy}/>}
    <div className="approval-actions"><button className="secondary compact" disabled={busy} onClick={()=>void respond('deny')}><X size={14}/>拒绝</button><button className="primary compact" disabled={busy||invalidChangeSet||(question&&questions.some(q=>!answers[q.question]?.trim()))} onClick={()=>void respond('allow')}>{busy?<Loader2 className="spin" size={14}/>:<Check size={14}/>} {question?'提交回答':'允许本次'}</button></div>
  </section>;
}

function sameMessage(left:ChatMessage,right:ChatMessage) {
  return left.id===right.id&&left.text===right.text&&left.role===right.role&&left.toolName===right.toolName&&left.isError===right.isError&&left.parentToolUseId===right.parentToolUseId&&left.truncated===right.truncated&&JSON.stringify(left.input)===JSON.stringify(right.input)&&left.nativeChangeSetState===right.nativeChangeSetState&&JSON.stringify(left.nativeChangeSetResult)===JSON.stringify(right.nativeChangeSetResult)&&JSON.stringify(left.nativeImageAttachments)===JSON.stringify(right.nativeImageAttachments);
}
const ChatMessageRow=memo(function ChatMessageRow({message,engineName,isNative,onImagePreview}:{message:ChatMessage;engineName:string;isNative:boolean;onImagePreview?:(runId:string,index:number,image:NativeImageAttachment)=>void}) {
  const changeSet=isNative&&message.role==='tool'&&message.toolName==='apply_change_set';
  const content=<><MessageText text={message.text}/>{isNative&&message.role==='user'&&message.nativeImageAttachments&&<NativeImageAttachments images={message.nativeImageAttachments} onPreview={onImagePreview?(index,image)=>onImagePreview(message.turnId,index,image):undefined}/>} {message.truncated&&<p className="panel-note message-truncated">此消息过长，仅显示部分内容。可导出会话查看完整记录。</p>}</>;
  const changeSetContent=<><NativeChangeSetResult result={message.nativeChangeSetResult} state={message.nativeChangeSetState}/>{message.nativeChangeSetState==='not_executed'&&<><pre className="tool-input" aria-label="工具未执行原因">{message.text}</pre>{message.truncated&&<p className="panel-note message-truncated">未执行原因过长，展示内容已截断。可导出会话查看完整记录。</p>}</>}</>;
  return message.role==='tool'?<details data-message-id={message.id} className={'tool-card '+(message.isError?'has-error':'')}><summary><span className={'dot '+(message.isError?'error':'idle')}/><strong>{message.toolName??'工具结果'}</strong>{message.parentToolUseId&&<small>子任务</small>}<span>{changeSet?nativeChangeSetResultLabel(message.nativeChangeSetResult,message.nativeChangeSetState):message.isError?'失败':'查看详情'}</span></summary>{changeSet?changeSetContent:<>{message.input&&<pre className="tool-input">{JSON.stringify(message.input,null,2)}</pre>}{content}</>}</details>:<article data-message-id={message.id} className={'chat-message '+message.role}><header>{message.role==='user'?'你':message.role==='assistant'?engineName:'会话记录'}{message.parentToolUseId&&<small>子任务</small>}</header>{content}</article>;
},(previous,next)=>previous.engineName===next.engineName&&previous.isNative===next.isNative&&previous.onImagePreview===next.onImagePreview&&sameMessage(previous.message,next.message));

export function ChatPane({session,draft,onDraft,onSent,onError,onAttach,onDropFiles,onPasteImages,onProjectFiles,attachments,attachmentBusy,attachmentDisabled,isAttachmentImporting,onRemoveAttachment,onAttachmentsSent,approvalDrafts,readingPositions,attentionTarget,onAttentionHandled,descriptor,readOnly=false,disabled=false,unavailable}:{
  descriptor?:ExecutionDescriptor;readOnly?:boolean;session:Session;draft:string;onDraft:(value:string)=>void;onSent:(expectedDraft:string)=>void;onError:(error:unknown)=>void;onAttach:()=>void;onProjectFiles:()=>void;attachments:Attachment[];onRemoveAttachment:(path:string)=>void;onAttachmentsSent:(files:Attachment[])=>void;approvalDrafts:ApprovalDrafts;readingPositions:Map<string,ChatReadingPosition>;attentionTarget?:{requestId:string;nonce:number};onAttentionHandled:()=>void;disabled?:boolean;unavailable?:string;
  onDropFiles:(files:File[])=>void;attachmentBusy:boolean;attachmentDisabled:boolean;isAttachmentImporting:()=>boolean;
  onPasteImages?:(files:File[],canContinue:()=>boolean)=>void;
}) {
  const engineName=session.execution.providerId==='claude'?'Claude':descriptor?.displayName??session.execution.providerId;
  const [snapshot,setSnapshot]=useState<ChatSnapshot>();
  const [imagePreview,setImagePreview]=useState<NativeImagePreviewSelection>();
  const previewHistoryImage=useCallback((runId:string,index:number,image:NativeImageAttachment)=>{
    if(session.execution.providerId!=='native'||!session.execution.conversationId)return;
    setImagePreview({request:{sessionId:session.id,conversationId:session.execution.conversationId,source:{kind:'history',runId,index,sha256:image.sha256}},expected:{...image}});
  },[session.id,session.execution.providerId,session.execution.conversationId]);
  const [syncState,setSyncState]=useState<ChatSyncState>({loading:true,failures:0});
  const snapshotSync=useRef<ChatSnapshotSync | undefined>(undefined);
  const [continuationTaskId,setContinuationTaskId]=useState<string>();
  const [reviewingTask,setReviewingTask]=useState(false);
  const [confirmRecovery,setConfirmRecovery]=useState(false),[recovering,setRecovering]=useState(false);
  const [confirmingNativeRecovery,setConfirmingNativeRecovery]=useState(false);
  const [compactingNativeContext,setCompactingNativeContext]=useState(false),[nativeNotice,setNativeNotice]=useState('');
  const nativeOperation=useRef(false);
  const mounted=useRef(true),pageRequest=useRef(0),restored=useRef(false);
  useLayoutEffect(()=>{
    mounted.current=true;
    return()=>{mounted.current=false;pageRequest.current++;snapshotSync.current?.dispose();};
  },[session.id]);
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
      const page=await sessionReadLifecycle.read(session.id,()=>window.desktop.chatPage(session.id,options));
      if(!page||!mounted.current||seq!==pageRequest.current)return;
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
  const load=useCallback(async()=>{await snapshotSync.current?.refresh();},[]);
  const prepareCommands=useCallback(()=>{
    if(disabled||readOnly||!descriptor?.capabilities.commands)return Promise.resolve();
    if(commandsLoading.current)return commandsLoading.current;
    const pending=window.desktop.prepareChatCommands(session.id).then(async()=>{if(mounted.current)await load();});
    commandsLoading.current=pending;
    const clear=()=>{if(commandsLoading.current===pending)commandsLoading.current=undefined;};
    void pending.then(clear,clear);
    return pending;
  },[session.id,load,disabled,readOnly,descriptor?.capabilities.commands]);
  useEffect(()=>{
    let timer:ReturnType<typeof setTimeout>|undefined;
    const sync=new ChatSnapshotSync(session.id,{
      read:()=>sessionReadLifecycle.read(session.id,()=>window.desktop.chatSnapshot(session.id)),
      apply:value=>{approvalDrafts.reconcile(session.id,value.pending);setSnapshot(value);},
      state:setSyncState,
    });
    snapshotSync.current=sync;
    const resume=sessionReadLifecycle.subscribe(session.id,()=>{if(mounted.current)void sync.refresh();});
    // Subscribe before the first read. Every event only requests host state;
    // neither a late task label nor stream text can finish an engineering task.
    const off=window.desktop.onChat((id,_state,version)=>{
      if(id===session.id&&sync.notify(version)&&sync.canAutoRefresh&&!timer)timer=setTimeout(()=>{timer=undefined;if(sync.canAutoRefresh)void sync.refresh();},80);
    });
    const recover=()=>{if(document.visibilityState!=='hidden')void sync.refresh();};
    window.addEventListener('focus',recover);window.addEventListener('online',recover);document.addEventListener('visibilitychange',recover);
    void sync.refresh();
    return ()=>{mounted.current=false;pageRequest.current++;clearTimeout(timer);sync.dispose();if(snapshotSync.current===sync)snapshotSync.current=undefined;off();resume();window.removeEventListener('focus',recover);window.removeEventListener('online',recover);document.removeEventListener('visibilitychange',recover);};
  },[approvalDrafts,session.id]);
  const handled=useRef(onAttentionHandled);handled.current=onAttentionHandled;
  const [focusRequest,setFocusRequest]=useState('');
  useEffect(()=>{
    if(!attentionTarget)return;
    if(readOnly||descriptor?.maintenance){handled.current();return;}
    let cancelled=false;
    // Obtain a fresh snapshot before deciding whether a navigation target expired.
    pageRequest.current++;setPaging(false);setArchive(undefined);setHighlight('');setShowSearch(false);
    void sessionReadLifecycle.read(session.id,async()=>{await load();return snapshotSync.current?.snapshot;}).then(value=>{
      if(!value||cancelled||!mounted.current)return;
      if(snapshotSync.current?.error)throw new Error('状态读取失败，请重新同步后查看待处理请求。');
      if(value?.pending.some(item=>item.requestId===attentionTarget.requestId)){
        jumpToItem(attentionTarget.requestId,'request');setFocusRequest(attentionTarget.requestId);
      }else onError(new Error('这项请求已处理或已失效。'));
      handled.current();
    }).catch(error=>{if(!cancelled&&mounted.current){onError(error);handled.current();}});
    return()=>{cancelled=true;};
  },[attentionTarget?.nonce,session.id,jumpToItem,onError,readOnly,descriptor?.maintenance,load]);
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
  const nativeRecovery=session.execution.providerId==='native'?snapshot?.nativeRecovery:undefined;
  const nativeMaintenance=session.execution.providerId==='native'?snapshot?.nativeContextMaintenance:undefined;
  const compacting=compactingNativeContext||!!nativeMaintenance?.compacting;
  const sessionStatus=snapshot?.sessionStatus??session.status;
  const nativeOwned=session.execution.providerId==='native'&&sessionStatus==='running';
  const task=snapshot?.taskState??session.taskState??'idle', running=isTaskBusy(task)||hasActiveSubtasks(session)||nativeOwned||sessionStatus==='stopping'||compacting;
  const taskLabel=syncState.error?'状态未知':compacting?(nativeMaintenance?.compactionTrigger==='in_turn'?'正在回合内压缩上下文':nativeMaintenance?.compactionTrigger==='automatic'?'正在自动压缩上下文':'正在压缩上下文'):hasActiveSubtasks(session)&&!isTaskBusy(task)?'子任务执行中':nativeOwned&&!isTaskBusy(task)?'正在结束本轮执行':task==='completed'&&session.execution.providerId==='native'?'本轮执行已结束':taskLabels[task]??task;
  const composerDisabled=disabled||session.archived||!!nativeRecovery||compacting||confirmingNativeRecovery||!!syncState.error;
  useEffect(()=>{
    // A final notification can be lost without a later sequence gap. Only an
    // active/uncertain pane checks occasionally; two failures pause auto retries.
    if((!running&&!syncState.error)||syncState.failures>=2)return;
    const timer=setInterval(()=>{if(document.visibilityState!=='hidden')void load();},5000);
    return()=>clearInterval(timer);
  },[running,syncState.error,syncState.failures,load]);
  const recoverNative=async(resume:boolean)=>{
    if(nativeOperation.current||running||readOnly||session.archived||!nativeRecovery||descriptor?.maintenance)return;
    nativeOperation.current=true;setConfirmingNativeRecovery(true);setNativeNotice('');
    try {
      if(resume)await window.desktop.resumeNativeRecovery(session.id,nativeRecovery.headHash);
      else await window.desktop.confirmNativeRecovery(session.id);
      if(mounted.current){await load();if(resume&&mounted.current)setNativeNotice('记录已恢复；请发送新指令继续。已完成工具不会重放，排队消息保持暂停。');}
    }
    catch(error){onError(error);if(mounted.current)await load().catch(onError);}
    finally{nativeOperation.current=false;if(mounted.current)setConfirmingNativeRecovery(false);}
  };
  const compactNative=async()=>{
    if(nativeOperation.current||running||composerDisabled||readOnly||!nativeMaintenance?.canCompact||descriptor?.maintenance||snapshot?.queue?.items.length)return;
    nativeOperation.current=true;setCompactingNativeContext(true);setNativeNotice('');
    try { await window.desktop.compactNativeContext(session.id,nativeMaintenance.headHash);if(mounted.current)await load(); }
    catch(error){onError(error);if(mounted.current)await load().catch(onError);}
    finally{nativeOperation.current=false;if(mounted.current)setCompactingNativeContext(false);}
  };
  const recoveryAvailable=!!descriptor?.capabilities.recoverContext&&!readOnly&&session.started&&[snapshot?.error,session.error].some(isMissingTranscriptError);
  const recoverContext=async()=>{
    if(recovering)return;
    setRecovering(true);
    try { await window.desktop.recoverChatContext(session.id);if(mounted.current){setConfirmRecovery(false);await load();jumpToLatest();} }
    catch(error){onError(error);}finally{if(mounted.current)setRecovering(false);}
  };
  const queued=running||!!snapshot?.queue?.items.length;
  const visibleAttachments=descriptor?.capabilities.attachments?attachments:[];
  const currentImagePreview=imagePreview&&session.execution.providerId==='native'&&isNativeImagePreviewCurrent(imagePreview,session.id,session.execution.conversationId,visibleAttachments)?imagePreview:undefined;
  useEffect(()=>{if(imagePreview&&!currentImagePreview)setImagePreview(undefined);},[imagePreview,currentImagePreview]);
  const {submitting,submit:send}=useChatSubmission({sessionId:session.id,draft,attachments:visibleAttachments,nativeTaskId:session.execution.providerId==='native'?continuationTaskId:undefined,disabled:composerDisabled||attachmentBusy,isBlocked:isAttachmentImporting,
    onAccepted:()=>{setNativeNotice('');setContinuationTaskId(undefined);jumpToLatest();},onSent,onAttachmentsSent,onError,refresh:load});
  const attachmentsBlocked=!descriptor?.capabilities.attachments||composerDisabled||attachmentDisabled||attachmentBusy||submitting;
  const pasteAvailable=useRef(false);
  // The import's own pending state must not cancel it. Leaving this pane,
  // recovery and compaction do cancel a paste still reading clipboard bytes.
  pasteAvailable.current=session.execution.providerId==='native'&&!readOnly&&!composerDisabled&&!attachmentDisabled&&!!descriptor?.capabilities.attachments&&!descriptor.maintenance;
  const {dragging,handlers:dropHandlers}=useChatFileDrop(attachmentsBlocked,onDropFiles);
  return <div className={'chat-pane'+(dragging?' file-drag-active':'')} {...dropHandlers}>
    {currentImagePreview&&<NativeImagePreview key={nativeImagePreviewKey(currentImagePreview)} selection={currentImagePreview} onClose={()=>setImagePreview(undefined)}/>}
    {dragging&&<div className={'chat-file-drop-overlay'+(attachmentsBlocked?' blocked':'')} role="status"><Paperclip size={28}/><strong>{attachmentsBlocked?attachmentBusy?'正在添加附件，请稍候':'当前无法添加附件':'松开以添加附件'}</strong><span>文件仅加入待发送附件，点击发送后才交给当前引擎。</span></div>}
    <div className="chat-reading-toolbar"><button className="text-button" title="会话内查找 Ctrl / ⌘ + F" onClick={()=>setShowSearch(true)}><Search size={14}/>查找消息</button>{archive&&<span>正在阅读历史记录</span>}{archive&&<button className="text-button" onClick={jumpToLatest}>返回最新对话</button>}</div>
    {syncState.error&&<div className="chat-error" role="alert"><strong>状态未知，显示的是上次读取的记录。</strong><p>{syncState.error}</p><button className="secondary compact" disabled={syncState.loading} onClick={()=>void load()}>{syncState.loading?'正在重试…':'重新同步状态'}</button></div>}
      {(snapshot?.truncated||archive)&&<div className="history-controls chat-page-controls"><button className="secondary compact" disabled={paging||!!archive&&!archive.before||!visible?.messages.length||exhaustedBefore===visible?.messages[0]?.id} onClick={()=>void openPage({before:archive?.before??visible?.messages[0]?.id}).catch(onError)}>{paging?'读取中…':'查看更早消息'}</button>{archive&&<><span>本页 {archive.messages.length} 条</span><button className="secondary compact" disabled={paging||!archive.after} onClick={()=>void openPage({after:archive.after!}).catch(onError)}>查看较新消息</button></>}</div>}
    {historyNotice&&<p className="panel-note history-reading-note" role="status">{historyNotice}</p>}
    {showSearch&&<ChatSearch sessionId={session.id} onClose={()=>{pageRequest.current++;setPaging(false);setShowSearch(false);}} onSelect={(id,query)=>openPage({around:id,query})}/>}
    <div className="chat-scroll" ref={scroll} aria-label="对话记录" onScroll={onScroll}><div className="chat-scroll-content" ref={content}>
      {!visible?.messages.length&&!snapshot?.queue?.items.length&&<div className="chat-empty"><MessageSquare size={32}/><h3>{readOnly ? '已保存的会话记录' : '从一个明确的任务开始'}</h3><p>{readOnly ? '没有可显示的本地消息；会话身份和原始配置已保留。' : `描述目标、引用项目文件，在这里查看 ${engineName} 的执行过程。`}</p>{!readOnly && <small>需要确认的工具请求会显示审批卡片。</small>}</div>}
      {archive?.incomplete&&<p className="panel-note">部分原始记录未导入、损坏或过长，可导出原始记录进一步查看。</p>}
      {archive&&!archive.before&&<p className="panel-note">已到本地保留记录的开头。</p>}
      {visible?.messages.map(message=><ChatMessageRow key={message.id} message={message} engineName={engineName} isNative={session.execution.providerId==='native'} onImagePreview={session.execution.providerId==='native'&&session.execution.conversationId?previewHistoryImage:undefined}/>)}
      {!syncState.error&&!readOnly&&!descriptor?.maintenance&&descriptor?.capabilities.approvals&&visible?.pending.map(approval=><ApprovalCard key={approval.requestId} approval={approval} sessionId={session.id} onError={onError} drafts={approvalDrafts} engineName={engineName} allowMessage={session.execution.providerId!=='native'} isNative={session.execution.providerId==='native'}/>)}
      {!archive&&snapshot?.error&&<p className="chat-error" role="alert">{snapshot.error}</p>}
      {!archive&&nativeRecovery&&<NativeRecoveryPanel recovery={nativeRecovery} disabled={running||readOnly||session.archived||!!descriptor?.maintenance} pending={confirmingNativeRecovery} onResume={()=>void recoverNative(true)} onConfirm={()=>void recoverNative(false)}/>}
      {!archive&&nativeNotice&&<p className="panel-note" role="status">{nativeNotice}</p>}
      {!archive&&recoveryAvailable&&<div className="chat-recovery"><p className="panel-note">如已确认无需恢复原来的引擎上下文，可以保留本地聊天和工作目录，重新开始空白上下文。</p><button className="secondary compact" disabled={composerDisabled||running||recovering} onClick={()=>setConfirmRecovery(true)}>重建空白上下文</button></div>}
      {!archive&&running&&!syncState.error&&<div className="thinking-indicator"><Loader2 size={13} className="spin"/>{sessionStatus==='stopping'?'正在停止':taskLabel}</div>}
      {!archive&&<ChatQueue sessionId={session.id} queue={snapshot?.queue} disabled={composerDisabled} onError={onError} refresh={load}/>}
    </div></div>
    {(!follow||archive)&&<button className="jump-latest secondary compact" onClick={jumpToLatest}>跳到最新消息</button>}
    {snapshot?.mcpServers&&snapshot.mcpServers.length>0&&<details className="chat-services"><summary>MCP 初始化状态 · {snapshot.mcpServers.length} 个服务</summary>{snapshot.mcpServers.map((server,index)=><span key={server.name+index}>{server.name} · {server.status==='connected'?'已连接':server.status==='failed'?'连接失败':server.status==='pending'?'连接中':server.status}</span>)}</details>}
    <SubtaskPanel session={session}/>
    {session.execution.providerId==='native'&&<NativeCommandPanel commands={snapshot?.nativeCommands} currentRunId={snapshot?.nativeRun?.runId} loadError={syncState.error}/>}
    {session.execution.providerId==='native'&&<NativeTaskPanel task={snapshot?.nativeTask??null} loading={syncState.loading} loadError={syncState.error??snapshot?.nativeTaskError}
      historical={!!snapshot?.nativeRun&&snapshot.nativeRun.runId!==snapshot.nativeTask?.identity.runId}
      disabled={readOnly||composerDisabled||running||submitting||!!descriptor?.maintenance} busy={reviewingTask}
      onRefresh={()=>void load()} onContinue={setContinuationTaskId}
      onReview={async input=>{setReviewingTask(true);try{await window.desktop.nativeTaskReview(session.id,input);await load();}finally{if(mounted.current)setReviewingTask(false);}}}/>}
    {continuationTaskId&&<div className="panel-note" role="status">下一条消息将继续任务 {continuationTaskId}。<button className="text-button" disabled={submitting} onClick={()=>setContinuationTaskId(undefined)}>取消关联</button></div>}
    <div className="chat-meta"><span className={'dot '+(syncState.error||task==='error'?'error':running?'running':'idle')}/>{!syncState.error&&sessionStatus==='stopping'?'正在停止':taskLabel}{snapshot?.model&&<span className="chat-model" title="引擎报告的当前模型">{snapshot.model}</span>}{snapshot?.usage&&<span className="usage" title={session.execution.providerId==='native'?'服务已报告的本回合用量，包含回合内摘要，失败请求可能未报告；仅全部请求都有完整用量时按本回合价格估算费用，发送前及手动压缩另计，未含缓存折扣和附加费用':'引擎实际返回的用量与费用估算'}>{session.execution.providerId==='native'&&Object.values(snapshot.usage).some(value=>typeof value==='number')&&'本回合累计 · '}{Object.entries(snapshot.usage).filter(([,value])=>typeof value==='number').map(([key,value])=>(usageLabels[key]??key)+': '+Number(value).toLocaleString(undefined,{maximumFractionDigits:key==='costUSD'?6:0})).join(' · ')}</span>}</div>
    {descriptor?.capabilities.contextUsage&&<ContextMeter context={snapshot?.context} native={session.execution.providerId==='native'}
      currentRunId={snapshot?.nativeRun?.runId}
      maintenance={nativeMaintenance?{...nativeMaintenance,compacting}:undefined}
      previewBlockedReason={syncState.error?'unavailable':nativeRecovery?'recovery_required':running||submitting||reviewingTask||confirmingNativeRecovery||!!descriptor.maintenance?'busy':undefined}
      compactDisabled={running||composerDisabled||readOnly||!!descriptor.maintenance||!!snapshot?.queue?.items.length}
      onCompact={session.execution.providerId==='native'&&descriptor.capabilities.compactContext?()=>void compactNative():undefined}
      onCancelCompact={readOnly||session.archived||sessionStatus==='stopping'?undefined:()=>void window.desktop.interruptSession(session.id).catch(onError)}/>}
    {confirmRecovery&&<Dialog label="重建空白上下文" onClose={()=>setConfirmRecovery(false)} closeDisabled={recovering}>
      <h2>重建空白上下文</h2>
      <p>此操作不能恢复原来的引擎上下文。将创建新的引擎会话标识，之前的聊天不会自动发送给引擎。</p>
      <p>本地聊天记录、草稿、附件和独立 worktree 都会保留。排队消息将保持暂停，需检查后手动继续。</p>
      <p className="panel-note">如果需要找回原上下文，请取消并检查此引擎的配置目录或重新导入历史记录。</p>
      <div className="modal-actions"><button className="secondary" disabled={recovering} onClick={()=>setConfirmRecovery(false)}>取消</button><button className="primary" disabled={recovering||composerDisabled||running||!recoveryAvailable} onClick={()=>void recoverContext()}>{recovering?'重建中…':'确认重建'}</button></div>
    </Dialog>}
    <div className="composer chat-composer">
      {unavailable&&<p className="inline-warning engine-unavailable" role="status">{unavailable}</p>}
      <ChatAttachmentChips attachments={visibleAttachments} isNative={session.execution.providerId==='native'} disabled={attachmentsBlocked} onRemove={onRemoveAttachment} onPreview={session.execution.providerId==='native'&&session.execution.conversationId?file=>setImagePreview({request:{sessionId:session.id,conversationId:session.execution.conversationId!,source:{kind:'draft',path:file.path}},expected:{name:file.name,bytes:file.bytes}}):undefined}/>
      {session.execution.providerId==='native'&&descriptor?.capabilities.attachments&&<NativeImageNotice/>}
      {attachmentBusy&&<p className="attachment-import-status" role="status"><Loader2 size={12} className="spin"/>正在添加待发送附件…可以继续编辑消息。</p>}
      <PromptEditor placeholder={readOnly?'可保存草稿；此引擎目前无法执行':disabled?'可继续编辑草稿，待引擎就绪后发送':queued?'继续输入，发送后加入队列…':descriptor?.capabilities.commands?'描述任务，或输入 / 选择命令与 Skills…':'描述任务…'} value={draft} disabled={session.archived} onChange={onDraft} onSend={()=>void send()}
        onPasteFiles={pasteAvailable.current&&!attachmentsBlocked&&onPasteImages?files=>onPasteImages(files,()=>mounted.current&&!nativeOperation.current&&pasteAvailable.current):undefined}
        commands={descriptor?.capabilities.commands?snapshot?.commands:undefined} commandOwner={engineName} loadCommands={!composerDisabled&&descriptor?.capabilities.commands?prepareCommands:undefined}/>
      <div className="chat-composer-actions">{descriptor?.capabilities.attachments&&<button className="icon-button" title="添加附件，也可将文件拖入聊天区；发送前仅保留为待发送附件" aria-label="添加附件" disabled={attachmentsBlocked} onClick={onAttach}><Paperclip size={16}/></button>}<button className="icon-button" title="引用项目文件" aria-label="引用项目文件" disabled={composerDisabled} onClick={onProjectFiles}><File size={16}/></button><span title={'Enter 发送；执行中发送将加入队列；Ctrl / ⌘ + Enter 或 Shift + Enter 换行；'+(descriptor?.capabilities.attachments?'文件可拖入聊天区成为待发送附件；':'')+'草稿自动保存'}>Enter {queued?'加入队列':'发送'} · Ctrl / ⌘ + Enter 换行{visibleAttachments.length>0&&' · '+visibleAttachments.length+' 个附件 · '+(visibleAttachments.reduce((sum,file)=>sum+file.bytes,0)/1024).toFixed(1)+' KB'}</span>{running&&<button className="secondary compact" disabled={readOnly||session.archived||sessionStatus==='stopping'} onClick={()=>void window.desktop.interruptSession(session.id).catch(onError)}><Square size={12}/>{sessionStatus==='stopping'?'正在停止':'中断'}</button>}<button className="primary compact" disabled={submitting||attachmentBusy||(!draft.trim()&&!visibleAttachments.length)||composerDisabled} onClick={()=>void send()}>{submitting||attachmentBusy?<Loader2 size={14} className="spin"/>:<CornerDownLeft size={14}/>} {attachmentBusy?'添加附件中…':submitting?'提交中…':queued?'加入队列':'发送任务'}</button></div>
    </div>
  </div>;
}
