import { useEffect, useRef, useState } from 'react';
import type { SessionContinuationInput, SessionContinuationPreview } from '../../shared/session-continuation';

export function SessionContinuationChoices({ preview, value, disabled, onChange }: {
  preview: SessionContinuationPreview; value: SessionContinuationInput; disabled: boolean; onChange(value: SessionContinuationInput): void;
}) {
  return <div aria-label="选择带入的可见消息">
    {preview.incomplete && <p className="hint">这里只列出最近可完整读取的文字消息。较早、过长或不完整的消息未列入，可自行填写摘要。</p>}
    {!preview.messages.length && <p className="hint">没有可带入的完整文字消息，可填写摘要。</p>}
    {preview.messages.map((message, index) => <label className="checkbox" key={message.id}>
      <input type="checkbox" aria-label={`带入第 ${index + 1} 条${message.role === 'user' ? '用户' : '助手'}消息`} disabled={disabled} checked={value.messageIds.includes(message.id)} onChange={event => onChange({ ...value,
        messageIds: event.target.checked ? [...value.messageIds, message.id] : value.messageIds.filter(id => id !== message.id),
      })} />
      <span>{message.role === 'user' ? '用户' : '助手'}<pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 180, overflow: 'auto' }}>{message.text}</pre></span>
    </label>)}
  </div>;
}

export function SessionContinuation({ value, disabled, onChange }: {
  value: SessionContinuationInput; disabled: boolean; onChange(value: SessionContinuationInput): void;
}) {
  const [preview, setPreview] = useState<SessionContinuationPreview>();
  const [reading, setReading] = useState(false), [error, setError] = useState('');
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const read = async () => {
    if (reading || disabled) return;
    setReading(true); setError('');
    try {
      const result = await window.desktop.previewSessionContinuation(value.sourceSessionId);
      if (!mounted.current) return;
      setPreview(result); onChange({ ...value, snapshotHash: result.snapshotHash, messageIds: [] });
    } catch (cause) {
      if (!mounted.current) return;
      setPreview(undefined); onChange({ ...value, snapshotHash: '', messageIds: [] });
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { if (mounted.current) setReading(false); }
  };
  return <section aria-label="带入会话内容">
    <p>创建独立的新会话。选择的文字和手写摘要将放入待发送草稿，请核对并补充任务后自行发送。原会话保持不变。</p>
    <p className="hint">不带入工具记录、附件、内部推理、模型续接状态或连接凭据。源工作目录中的现有修改会保留；新建 worktree 只包含已提交内容。</p>
    <button type="button" className="secondary compact" disabled={disabled || reading} onClick={() => void read()}>{reading ? '读取中…' : '读取可见消息'}</button>
    {error && <p role="alert" className="chat-error">{error}</p>}
    {preview && <SessionContinuationChoices preview={preview} value={value} disabled={disabled || reading} onChange={onChange} />}
    <label>手写摘要（可选）<textarea aria-label="手写摘要" disabled={disabled || reading} maxLength={32 * 1024} rows={4} value={value.summary ?? ''} onChange={event => onChange({ ...value, summary: event.target.value })} /></label>
    <p className="hint">最多选择 40 条，每条不超过 8 KiB，带入正文共计不超过 64 KiB。不会调用模型生成摘要或自动发送。</p>
  </section>;
}
