import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { CornerDownLeft, ListOrdered, Loader2, Paperclip, Play, X } from 'lucide-react';
import type { ChatMessage, ChatSnapshot, ChatSnapshotVersion } from '../shared/chat';
import { paintActionFeedback } from './action-feedback';
import { chatActionState } from './chat-action-state';
import type { PendingChatSubmission } from './chat-submission-state';
import { queueActionConfirmed, queueFeedbackVersion, startingQueueMessages } from './chat-queue-feedback';
export { startingQueueMessages } from './chat-queue-feedback';
import './chat-queue.css';

export function PendingChatMessages({ submissions }: { submissions: readonly PendingChatSubmission[] }) {
  if (!submissions.length) return null;
  return <section className="chat-submission-feedback" aria-label="消息提交状态"><ol className="chat-queue-list">{submissions.map(submission => <li
    key={submission.requestId} data-submission-request-id={submission.requestId} className="queued-chat-message pending-chat-message">
    <header><span>你</span><span role="status">{submission.status !== 'failed' && <Loader2 size={13} className="spin"/>}
      {submission.status === 'submitting' ? '正在提交…' : submission.status === 'accepted' ? '正在等待会话启动…' : '提交未确认'}</span></header>
    {submission.text && <p className="queued-chat-text">{submission.text}</p>}
    {submission.files.length > 0 && <ul className="queued-chat-attachments" aria-label="提交附件">{submission.files.map(file => <li key={file.path}><Paperclip size={12}/>{file.name}</li>)}</ul>}
    {submission.status === 'failed' && <p className="panel-note" role="alert">{submission.error} 原始消息和附件信息已保留；请核查后重试。</p>}
  </li>)}</ol></section>;
}

export function ChatQueue({ sessionId, conversationId, queue, version, messages = [], displayMessages = [], disabled, onError, refresh, refreshFresh }: {
  sessionId: string; conversationId?: string; queue: ChatSnapshot['queue']; version?: ChatSnapshotVersion; messages?: readonly ChatMessage[]; disabled: boolean;
  displayMessages?: readonly ChatMessage[];
  onError: (error: unknown) => void; refresh: () => Promise<void>;
  refreshFresh: () => Promise<ChatSnapshot | undefined>;
}) {
  const key = JSON.stringify([sessionId, conversationId ?? '', 'queue']);
  const read = useCallback(() => chatActionState.getSnapshot(key), [key]);
  const pending = useSyncExternalStore(chatActionState.subscribe, read, read);
  const mounted = useRef(true), currentKey = useRef(key);
  currentKey.current = key;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!pending?.accepted || !queue) return;
    if (queueActionConfirmed(pending, queue, messages, version)) chatActionState.clear(key, pending.token);
  }, [key, pending, queue, messages, version]);
  const synchronize = async (token: number) => {
    if (!chatActionState.beginSync(key, token)) return;
    try {
      const fresh = await refreshFresh();
      if (fresh?.sessionId === sessionId) chatActionState.synchronized(key, token, fresh.version);
      else chatActionState.syncFailed(key, token);
    } catch (error) { chatActionState.syncFailed(key, token); if (mounted.current && currentKey.current === key) onError(error); }
  };
  const act = async (kind: string, action: () => Promise<unknown>, target?: string) => {
    if (disabled) return;
    const operation = chatActionState.begin(key, kind, target, queueFeedbackVersion(queue, version));
    if (!operation) return;
    try {
      await paintActionFeedback();
      if (currentKey.current !== key) { chatActionState.clear(key, operation.token); return; }
      await action(); chatActionState.accepted(key, operation.token);
    }
    catch (error) { chatActionState.clear(key, operation.token); if (mounted.current && currentKey.current === key) onError(error); }
    finally {
      if (mounted.current && currentKey.current === key) {
        if (chatActionState.getSnapshot(key)?.accepted) await synchronize(operation.token);
        else void refresh().catch(error => { if (mounted.current && currentKey.current === key) onError(error); });
      }
    }
  };
  if (!queue) return null;
  const waiting = queue.items.filter(item => item.status === 'queued');
  const starting = startingQueueMessages(queue, [...messages, ...displayMessages], JSON.stringify([sessionId, conversationId ?? '', 'queue-display']));
  const displayed = [...starting, ...waiting];
  if (!displayed.length && !queue.error && !pending) return null;
  const unavailable = disabled || !!pending;
  const feedback = pending?.kind === 'resume' ? '正在继续发送队列…' : pending?.kind === 'remove' ? '正在移除消息…' : '正在中断上一轮并准备立即发送…';
  return <section className="chat-queue" aria-label="待发送消息" aria-busy={!!pending}>
    {pending && <p className="chat-operation-feedback" role="status"><Loader2 size={13} className="spin"/>{feedback}</p>}
    {pending?.accepted && !pending.synchronized && <p className="panel-note" role="status">操作已受理，等待同步结果。
      <button className="secondary compact" disabled={pending.synchronizing} onClick={() => void synchronize(pending.token)}>{pending.synchronizing ? '正在核实…' : '核实操作结果'}</button></p>}
    {waiting.length > 0 && <header className="chat-queue-heading"><ListOrdered size={15} /><strong>待发送 · {waiting.length}</strong>
      <span role="status">{queue.paused ? '队列已暂停' : '当前任务结束后按顺序发送'}</span>
      {queue.paused && <button className="secondary compact" disabled={unavailable}
        onClick={() => void act('resume', () => window.desktop.resumeChatQueue(sessionId))}>
        {pending?.kind === 'resume' ? <Loader2 size={13} className="spin"/> : <Play size={13}/>}{pending?.kind === 'resume' ? '正在继续…' : '继续发送队列'}
      </button>}
    </header>}
    {queue.error && <p className="chat-error" role="alert">{queue.error}</p>}
    <ol className="chat-queue-list">{displayed.map((message, index) => <li key={message.id} className="queued-chat-message"
      data-queued-message-id={message.id} tabIndex={0} aria-label={message.status === 'sending' ? '正在启动的消息' : `排队消息 ${index + 1 - starting.length}`}>
      <header><span>{message.status === 'sending' ? '你 · 正在启动…' : `你 · 待发送 ${index + 1 - starting.length}`}</span>{message.status === 'sending'
        ? <span role="status"><Loader2 size={13} className="spin"/>正在准备会话与上下文…</span>
        : <div className="queued-chat-actions">
          <button className="secondary compact" disabled={unavailable} title="中断当前任务，立即发送这条消息；其他消息继续排队"
            onClick={() => void act('now', () => window.desktop.sendQueuedChatNow(sessionId, message.id), message.id)}>
            {pending?.kind === 'now' && pending.target === message.id ? <Loader2 size={13} className="spin"/> : <CornerDownLeft size={13}/>}{pending?.kind === 'now' && pending.target === message.id ? '正在准备…' : '立即发送'}
          </button>
          <button className="icon-button" disabled={unavailable} aria-label={`移除排队消息 ${index + 1 - starting.length}`} title="移除这条待发送消息"
            onClick={() => void act('remove', () => window.desktop.removeQueuedChat(sessionId, message.id), message.id)}>
            {pending?.kind === 'remove' && pending.target === message.id ? <Loader2 size={13} className="spin"/> : <X size={14}/>}
          </button>
        </div>}</header>
      {message.text && <p className="queued-chat-text">{message.text}</p>}
      {message.attachments.length > 0 && <ul className="queued-chat-attachments" aria-label="排队消息附件">{message.attachments.map((path, fileIndex) =>
        <li key={path}><Paperclip size={12}/>{message.attachmentNames?.[fileIndex] ?? path.split(/[\\/]/).pop()}</li>)}</ul>}
    </li>)}</ol>
  </section>;
}
