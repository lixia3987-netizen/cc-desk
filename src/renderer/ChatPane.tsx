import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Check, CornerDownLeft, File, Loader2, MessageSquare, Paperclip, ShieldCheck, Square, X } from 'lucide-react';
import type { Attachment, Session } from '../shared/types';
import type { ChatApproval, ChatMessage, ChatSnapshot } from '../shared/chat';
import { MessageText } from './MessageText';
import { ApprovalDrafts, type ApprovalDraft } from './approval-drafts';
export { MessageText } from './MessageText';

export const taskLabels: Record<string,string> = { idle:'等待任务', starting:'正在启动', thinking:'正在思考', tool_running:'执行工具', waiting_approval:'等待审批', waiting_input:'等待回答', completed:'本轮完成', interrupted:'已中断', error:'执行失败' };
export const busyTask = (state?:string) => ['starting','thinking','tool_running','waiting_approval','waiting_input'].includes(state ?? '');
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
  return <section className="approval-card" aria-label={approval.kind==='question'?'等待回答':'工具审批'}>
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
  const content=<><MessageText text={message.text}/>{message.truncated&&<p className="panel-note message-truncated">此消息过长，已省略开头部分。可导出会话查看完整记录。</p>}</>;
  return message.role==='tool'?<details className={'tool-card '+(message.isError?'has-error':'')}><summary><span className={'dot '+(message.isError?'error':'idle')}/><strong>{message.toolName??'工具结果'}</strong>{message.parentToolUseId&&<small>子任务</small>}<span>{message.isError?'失败':'查看详情'}</span></summary>{message.input&&<pre className="tool-input">{JSON.stringify(message.input,null,2)}</pre>}{content}</details>:<article className={'chat-message '+message.role}><header>{message.role==='user'?'你':message.role==='assistant'?'Claude':'会话记录'}{message.parentToolUseId&&<small>子任务</small>}</header>{content}</article>;
},(previous,next)=>sameMessage(previous.message,next.message));

export function ChatPane({session,draft,onDraft,onSent,onError,onAttach,onProjectFiles,attachments,onRemoveAttachment,onAttachmentsSent,approvalDrafts}:{
  session:Session;draft:string;onDraft:(value:string)=>void;onSent:(expectedDraft:string)=>void;onError:(error:unknown)=>void;onAttach:()=>void;onProjectFiles:()=>void;attachments:Attachment[];onRemoveAttachment:(path:string)=>void;onAttachmentsSent:(paths:string[])=>void;approvalDrafts:ApprovalDrafts;
}) {
  const [snapshot,setSnapshot]=useState<ChatSnapshot>(), [sending,setSending]=useState(false), [follow,setFollow]=useState(true);
  const scroll=useRef<HTMLDivElement>(null), request=useRef(0), mounted=useRef(true);
  const load=useCallback(async()=>{const seq=++request.current;const value=await window.desktop.chatSnapshot(session.id);if(mounted.current&&seq===request.current){approvalDrafts.reconcile(session.id,value.pending);setSnapshot(value);}},[session.id,approvalDrafts]);
  useEffect(()=>{
    mounted.current=true;let timer:ReturnType<typeof setTimeout>|undefined;
    void load().catch(onError);
    const off=window.desktop.onChat(id=>{if(id===session.id&&!timer)timer=setTimeout(()=>{timer=undefined;if(mounted.current)void load().catch(onError);},80);});
    return ()=>{mounted.current=false;request.current++;clearTimeout(timer);off();};
  },[load,onError,session.id]);
  useEffect(()=>{if(follow&&scroll.current)scroll.current.scrollTop=scroll.current.scrollHeight;},[snapshot,follow]);
const task=snapshot?.taskState??session.taskState??'idle', running=sending||busyTask(task);
  const send=async()=>{
    if((!draft.trim()&&!attachments.length)||running||session.archived)return;
    if(draft.length>60000){onError(new Error('单次提示词请控制在 60,000 个字符以内。'));return;}
    setSending(true);setFollow(true);
    try{
      const result=await window.desktop.sendChat(session.id,draft.trim(),attachments.map(file=>file.path));
      if(result.success)onSent(draft);
      if(result.success)onAttachmentsSent(attachments.map(file=>file.path));
      if(result.error)onError(new Error(result.error));
    }catch(error){onError(error);}
    finally{if(mounted.current){setSending(false);void load().catch(onError);}}
  };
  return <div className="chat-pane">
    <div className="chat-scroll" ref={scroll} aria-label="对话记录" onScroll={e=>{const el=e.currentTarget;setFollow(el.scrollHeight-el.scrollTop-el.clientHeight<70);}}>
      {!snapshot?.messages.length&&<div className="chat-empty"><MessageSquare size={32}/><h3>从一个明确的任务开始</h3><p>描述目标、引用项目文件，在这里查看 Claude 的执行过程。</p><small>需要确认的工具请求会显示审批卡片。</small></div>}
      {snapshot?.truncated&&<p className="panel-note">较早消息已折叠，可导出会话查看保留的完整记录。</p>}
      {snapshot?.messages.map(message=><ChatMessageRow key={message.id} message={message}/>)}
      {snapshot?.pending.map(approval=><ApprovalCard key={approval.requestId} approval={approval} sessionId={session.id} onError={onError} drafts={approvalDrafts}/>)}
      {snapshot?.error&&<p className="chat-error" role="alert">{snapshot.error}</p>}
      {running&&<div className="thinking-indicator"><Loader2 size={13} className="spin"/>{taskLabels[task]??task}</div>}
    </div>
    {!follow&&<button className="jump-latest secondary compact" onClick={()=>setFollow(true)}>跳到最新消息</button>}
    {snapshot?.mcpServers&&snapshot.mcpServers.length>0&&<details className="chat-services"><summary>MCP 初始化状态 · {snapshot.mcpServers.length} 个服务</summary>{snapshot.mcpServers.map((server,index)=><span key={server.name+index}>{server.name} · {server.status==='connected'?'已连接':server.status==='failed'?'连接失败':server.status==='pending'?'连接中':server.status}</span>)}</details>}
    <div className="chat-meta"><span className={'dot '+(task==='error'?'error':running?'running':'idle')}/>{taskLabels[task]??task}{snapshot?.model&&<span className="chat-model" title="CLI 报告的当前模型">{snapshot.model}</span>}{snapshot?.usage&&<span className="usage" title="CLI 实际返回的用量与费用估算，不代表订阅剩余额度">{Object.entries(snapshot.usage).filter(([,value])=>typeof value==='number').map(([key,value])=>(usageLabels[key]??key)+': '+Number(value).toLocaleString(undefined,{maximumFractionDigits:key==='costUSD'?6:0})).join(' · ')}</span>}</div>
    <div className="composer chat-composer">{attachments.length>0&&<div className="attachment-chips">{attachments.map(file=><span key={file.path} title={file.path}><Paperclip size={12}/>{file.name}<button className="icon-button" aria-label={'移除附件 '+file.name} disabled={running} onClick={()=>onRemoveAttachment(file.path)}><X size={12}/></button></span>)}</div>}
      <textarea aria-label="提示词编辑器" placeholder="描述任务… Ctrl / ⌘ + Enter 发送" value={draft} disabled={session.archived} onChange={e=>onDraft(e.target.value)} onKeyDown={e=>{if((e.metaKey||e.ctrlKey)&&e.key==='Enter'&&!e.nativeEvent.isComposing&&e.nativeEvent.keyCode!==229){e.preventDefault();void send();}}}/>
      <div><button className="icon-button" title="添加图片、PDF 或文件附件" aria-label="添加附件" disabled={running} onClick={onAttach}><Paperclip size={16}/></button><button className="icon-button" title="引用项目文件" aria-label="引用项目文件" onClick={onProjectFiles}><File size={16}/></button><span>草稿自动保存 · {attachments.length} 个附件{attachments.length>0&&' · '+(attachments.reduce((sum,file)=>sum+file.bytes,0)/1024).toFixed(1)+' KB'}</span>{running?<button className="secondary compact" onClick={()=>void window.desktop.interruptSession(session.id).catch(onError)}><Square size={12}/>中断</button>:<button className="primary compact" disabled={(!draft.trim()&&!attachments.length)||session.archived} onClick={()=>void send()}><CornerDownLeft size={14}/>发送任务</button>}</div>
    </div>
  </div>;
}
