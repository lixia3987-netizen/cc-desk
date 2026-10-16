import type { ChatMessage, ChatSnapshot, ChatSnapshotVersion } from '../shared/chat';
import { chatActionHasFreshSnapshot, type PendingChatAction } from './chat-action-state';

export const queueFeedbackVersion = (queue: ChatSnapshot['queue'], version?: ChatSnapshotVersion) => JSON.stringify(version ?? queue);

// 仅保留有界身份，避免正式用户消息滚出快照窗口后再次出现“正在启动”卡。
const presented = new Map<string, Set<string>>();
export function startingQueueMessages(queue: ChatSnapshot['queue'], messages: readonly ChatMessage[] = [], scope?: string) {
  const known = scope ? presented.get(scope) ?? new Set<string>() : new Set<string>();
  for (const message of messages) if (message.role === 'user' && message.submissionId) {
    known.add(message.submissionId);
    while (known.size > 512) known.delete(known.values().next().value!);
  }
  if (scope) {
    presented.delete(scope); presented.set(scope, known);
    while (presented.size > 128) presented.delete(presented.keys().next().value!);
  }
  return queue?.items.filter(item => item.status === 'sending' && !known.has(item.id)) ?? [];
}

export function queueActionConfirmed(action: PendingChatAction, queue: ChatSnapshot['queue'], messages: readonly ChatMessage[], version?: ChatSnapshotVersion): boolean {
  if (!chatActionHasFreshSnapshot(action, version) || !queue) return false;
  const target = queue.items.find(item => item.id === action.target);
  if (action.kind === 'remove') return !target;
  // 任务可在两次快照间完成或再次失败，不要求一定观察到中间的 unpaused/sending。
  if (queue.paused && queue.error) return true;
  if (action.kind === 'resume') return !queue.paused || !queue.items.length;
  return !target || target.status === 'sending' || messages.some(message => message.role === 'user' && message.submissionId === action.target);
}
