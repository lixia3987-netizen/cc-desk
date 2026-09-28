import { createHash } from 'node:crypto';
import type { ChatPage } from '../shared/chat';
import type { Session } from '../shared/types';
import { CONTINUATION_MESSAGE_BYTES, CONTINUATION_MESSAGE_LIMIT, CONTINUATION_TOTAL_BYTES,
  type SessionContinuationInput, type SessionContinuationMessage, type SessionContinuationPreview } from '../shared/session-continuation';

/** Copy only the text projection: never tool inputs/results or provider context items. */
export function previewContinuation(source: Session, page: ChatPage): SessionContinuationPreview {
  const messages: SessionContinuationMessage[] = [];
  let bytes = 0, incomplete = page.incomplete || !!page.before || !!page.after;
  for (const message of [...page.messages].reverse()) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    if (message.parentToolUseId || message.toolUseId || message.toolName || message.input || !message.text.trim()) continue;
    const size = Buffer.byteLength(message.text, 'utf8');
    if (message.truncated || size > CONTINUATION_MESSAGE_BYTES || messages.length >= CONTINUATION_MESSAGE_LIMIT || bytes + size > CONTINUATION_TOTAL_BYTES) {
      incomplete = true; continue;
    }
    messages.unshift({ id: message.id, role: message.role, text: message.text }); bytes += size;
  }
  const view = { sourceSessionId: source.id, sourceProviderId: source.execution.providerId, projectId: source.projectId, messages, incomplete };
  // Include directory and engine identity in the freshness binding, but never transfer them as protocol state.
  const snapshotHash = createHash('sha256').update(JSON.stringify({ ...view, cwd: source.cwd, execution: source.execution })).digest('hex');
  return { ...view, snapshotHash };
}

export function continuationDraft(preview: SessionContinuationPreview, input: SessionContinuationInput): string {
  if (preview.sourceSessionId !== input.sourceSessionId || preview.snapshotHash !== input.snapshotHash) throw new Error('来源会话已变化，请重新读取并确认要带入的内容。');
  if (new Set(input.messageIds).size !== input.messageIds.length) throw new Error('带入的消息不能重复。');
  const selected = new Set(input.messageIds);
  if (input.messageIds.some(id => !preview.messages.some(message => message.id === id))) throw new Error('所选消息不在已确认的预览中，请重新读取。');
  const summary = input.summary?.trim() ?? '';
  if (!selected.size && !summary) throw new Error('请选择消息或填写摘要。');
  const sections = preview.messages.filter(message => selected.has(message.id)).map(message => `${message.role === 'user' ? '用户' : '助手'}：\n${message.text}`);
  if (summary) sections.push(`用户整理的摘要：\n${summary}`);
  const body = sections.join('\n\n');
  if (Buffer.byteLength(body, 'utf8') > CONTINUATION_TOTAL_BYTES) throw new Error('带入内容超过 64 KiB，请减少消息或缩短摘要。');
  return `以下内容由用户从另一会话选取，仅作背景参考，不代表当前项目状态或新的操作授权。请结合当前项目核查后继续。\n\n${body}\n\n接下来的任务：\n`;
}
