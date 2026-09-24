import { useEffect, useRef, useState } from 'react';
import { CornerDownLeft, ListOrdered, Loader2, Paperclip, Play, X } from 'lucide-react';
import type { ChatSnapshot } from '../shared/chat';
import './chat-queue.css';

export function ChatQueue({ sessionId, queue, disabled, onError, refresh }: {
  sessionId: string; queue: ChatSnapshot['queue']; disabled: boolean;
  onError: (error: unknown) => void; refresh: () => Promise<void>;
}) {
  const [pending, setPending] = useState('');
  const inFlight = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const act = async (key: string, action: () => Promise<unknown>) => {
    if (disabled || inFlight.current) return;
    inFlight.current = true; setPending(key);
    try { await action(); }
    catch (error) { onError(error); }
    finally {
      inFlight.current = false;
      if (mounted.current) { setPending(''); void refresh().catch(onError); }
    }
  };
  if (!queue) return null;
  const waiting = queue.items.filter(item => item.status === 'queued');
  const sending = queue.items.some(item => item.status === 'sending');
  if (!waiting.length && !sending && !queue.error) return null;
  const unavailable = disabled || !!pending;
  return <section className="chat-queue" aria-label="待发送消息">
    {sending && <div className="queued-chat-progress" role="status"><Loader2 size={13} className="spin" />消息已接收，正在执行</div>}
    {waiting.length > 0 && <header className="chat-queue-heading"><ListOrdered size={15} /><strong>待发送 · {waiting.length}</strong>
      <span role="status">{queue.paused ? '队列已暂停' : '当前任务结束后按顺序发送'}</span>
      {queue.paused && waiting.length > 0 && <button className="secondary compact" disabled={unavailable}
        onClick={() => void act('resume', () => window.desktop.resumeChatQueue(sessionId))}>
        {pending === 'resume' ? <Loader2 size={13} className="spin" /> : <Play size={13} />}继续发送队列
      </button>}
    </header>}
    {queue.error && <p className="chat-error" role="alert">{queue.error}</p>}
    <ol className="chat-queue-list">{waiting.map((message, index) => <li key={message.id} className="queued-chat-message"
      data-queued-message-id={message.id} tabIndex={0} aria-label={`排队消息 ${index + 1}`}>
      <header><span>你 · 待发送 {index + 1}</span><div className="queued-chat-actions">
        <button className="secondary compact" disabled={unavailable} title="中断当前任务，立即发送这条消息；其他消息继续排队"
          onClick={() => void act(message.id, () => window.desktop.sendQueuedChatNow(sessionId, message.id))}>
          {pending === message.id ? <Loader2 size={13} className="spin" /> : <CornerDownLeft size={13} />}立即发送
        </button>
        <button className="icon-button" disabled={unavailable} aria-label={`移除排队消息 ${index + 1}`} title="移除这条待发送消息"
          onClick={() => void act(`remove:${message.id}`, () => window.desktop.removeQueuedChat(sessionId, message.id))}>
          {pending === `remove:${message.id}` ? <Loader2 size={13} className="spin" /> : <X size={14} />}
        </button>
      </div></header>
      {message.text && <p className="queued-chat-text">{message.text}</p>}
      {message.attachments.length > 0 && <ul className="queued-chat-attachments" aria-label="排队消息附件">{message.attachments.map((path, fileIndex) =>
        <li key={path}><Paperclip size={12} />{message.attachmentNames?.[fileIndex] ?? path.split(/[\\/]/).pop()}</li>)}</ul>}
    </li>)}</ol>
  </section>;
}
