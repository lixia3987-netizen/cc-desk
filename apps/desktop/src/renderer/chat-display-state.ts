import type { ChatDisplayPage, ChatMessage } from '../shared/chat';

export const chatDisplayScope = (sessionId: string, conversationId?: string) => JSON.stringify([sessionId, conversationId ?? '']);
const maxMessages = 1000, maxPageBytes = 8 * 1024 * 1024;
const messageSizes = new WeakMap<ChatMessage, number>();
function messageSize(message: ChatMessage): number {
  let bytes = messageSizes.get(message);
  if (bytes !== undefined) return bytes;
  const pending: unknown[] = [message]; bytes = 0;
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === 'string') bytes += value.length * 2 + 16;
    else if (value && typeof value === 'object') { bytes += 64; for (const [key, field] of Object.entries(value)) { bytes += key.length * 2 + 8; pending.push(field); } }
    else bytes += 8;
  }
  messageSizes.set(message, bytes); return bytes;
}

/** Reconcile only at the read boundary, so composing does not compare every historical payload. */
export function sameChatMessage(left: ChatMessage, right: ChatMessage): boolean {
  if (left === right) return true;
  const keys = Object.keys(left) as (keyof ChatMessage)[];
  return keys.length === Object.keys(right).length && keys.every(key => {
    const before = left[key], after = right[key];
    return before === after || !!before && !!after && typeof before === 'object' && typeof after === 'object' && JSON.stringify(before) === JSON.stringify(after);
  });
}

function keepDisplayIdentity(previous: ChatMessage | undefined, incoming: ChatMessage): ChatMessage {
  // Only the display projection carries this receipt bridge. A normal authority
  // update may omit it, but cannot change the exact canonical submission identity.
  return previous?.role === 'user' && incoming.role === 'user' && previous.clientRequestId && incoming.clientRequestId === undefined
    && !!incoming.submissionId && incoming.submissionId === previous.submissionId
    ? { ...incoming, clientRequestId: previous.clientRequestId } : incoming;
}

export function mergeDisplayPage(current: ChatDisplayPage | undefined, incoming: ChatDisplayPage, direction: 'replace' | 'before' | 'after' = 'replace', preserveStart = false): ChatDisplayPage {
  const previous = new Map(current?.messages.map(message => [message.id, message]));
  const fresh = incoming.messages.map(value => {
    const old = previous.get(value.id), message = keepDisplayIdentity(old, value);
    return old && sameChatMessage(old, message) ? old : message;
  });
  const values = direction === 'before' ? [...fresh, ...(current?.messages ?? [])]
    : direction === 'after' ? [...(current?.messages ?? []), ...fresh] : fresh;
  const byId = new Map(values.map(message => [message.id, message]));
  // The newer page is authoritative for overlaps, without moving their document order.
  for (const message of fresh) byId.set(message.id, message);
  const messages = [...byId.values()]; let bytes = messages.reduce((sum, message) => sum + messageSize(message), 0);
  const page: ChatDisplayPage = { ...incoming, messages,
    before: direction === 'after' && current ? current.before : incoming.before,
    after: direction === 'before' && current ? current.after : incoming.after,
    incomplete: direction === 'replace' ? incoming.incomplete : incoming.incomplete || current?.incomplete || false };
  while (messages.length > 1 && (messages.length > maxMessages || bytes > maxPageBytes)) {
    const trimEnd = direction === 'before' || preserveStart;
    const removed = trimEnd ? messages.pop()! : messages.shift()!;
    bytes -= messageSize(removed);
    if (trimEnd) page.after = messages.at(-1)!.id;
    else page.before = messages[0].id;
  }
  if (current && page.before === current.before && page.after === current.after && page.incomplete === current.incomplete
    && messages.length === current.messages.length && messages.every((message, index) => message === current.messages[index])) return current;
  return page;
}

/** Authority updates the displayed tail; a detached historical page never grows across an unknown gap. */
export function mergeDisplaySnapshot(page: ChatDisplayPage, messages: readonly ChatMessage[], protectHistory = false, sourceIncomplete = false): ChatDisplayPage {
  if (sourceIncomplete && !page.incomplete) page = { ...page, incomplete: true };
  if (!messages.length) return page; // An initial empty projection cannot erase a saved display page.
  if (!page.messages.length) {
    const tail = messages.slice(-50);
    return mergeDisplayPage(page, { ...page, messages: tail, before: tail[0].id, after: null });
  }
  const authorityIds = new Set(messages.map(message => message.id));
  const authorityOrder = new Map(messages.map((message, index) => [message.id, index]));
  const streamNumber = (message: ChatMessage) => {
    const streamPrefix = `${message.turnId}:stream:`;
    return message.role === 'assistant' && message.id.startsWith(streamPrefix) && /^\d+$/.test(message.id.slice(streamPrefix.length))
      ? Number(message.id.slice(streamPrefix.length)) : undefined;
  };
  let predecessor: ChatMessage | undefined;
  const retained = page.messages.filter(message => {
    const number = streamNumber(message);
    if (number === undefined) { predecessor = message; return true; }
    if (authorityIds.has(message.id)) return true;
    const anchor = predecessor ? authorityOrder.get(predecessor.id) : undefined;
    if (anchor === undefined) return !messages.some(next => next.turnId === message.turnId && (streamNumber(next) ?? -1) > number);
    // 旧快照缺少新流式消息不代表输出已结束，必须在稳定前序之后看到替代记录。
    return !messages.slice(anchor + 1).some(next => next.turnId !== message.turnId
      || next.role === 'system'
      || next.role === 'assistant' && (streamNumber(next) === undefined || streamNumber(next)! > number));
  });
  const currentIds = new Set(retained.map(message => message.id));
  const tailIndex = messages.findIndex(message => message.id === retained.at(-1)?.id);
  const overlapStart = messages.findIndex(message => currentIds.has(message.id));
  const retainedStart = overlapStart < 0 ? -1 : retained.findIndex(message => message.id === messages[overlapStart].id);
  // 有界快照可能早于刚读完的显示页。只有连续覆盖当前尾部才能扩展窗口，
  // 任意交集或无交集都不能证明快照包含更新的消息。
  const connectsTail = tailIndex >= 0 && retainedStart >= 0
    && retained.length - retainedStart === tailIndex - overlapStart + 1
    && retained.slice(retainedStart).every((message, index) => message.id === messages[overlapStart + index].id);
  const changed = new Map(messages.map(message => [message.id, message]));
  const updated = retained.map(message => {
    const value = changed.get(message.id), next = value && keepDisplayIdentity(message, value);
    return next && !sameChatMessage(message, next) ? next : message;
  });
  if (connectsTail) updated.push(...messages.slice(tailIndex + 1));
  // Reading above the bottom changes which edge may be discarded at the cap.
  // It must not hide normal live replies, including a canonical stream replacement.
  return mergeDisplayPage(page, { ...page, messages: updated,
    after: connectsTail ? null : page.after }, 'replace', protectHistory);
}

/** Read-only message pages, explicitly separate from running state, approvals and operation receipts. */
export class ChatDisplayCache {
  private readonly entries = new Map<string, { page: ChatDisplayPage; bytes: number }>();
  private retained?: Set<string>;
  constructor(private maxEntries = 8, private maxBytes = 16 * 1024 * 1024) {}
  get(sessionId: string, conversationId?: string): ChatDisplayPage | undefined {
    const key = chatDisplayScope(sessionId, conversationId), entry = this.entries.get(key);
    if (entry) { this.entries.delete(key); this.entries.set(key, entry); }
    return entry?.page;
  }
  set(page: ChatDisplayPage): void {
    const key = chatDisplayScope(page.sessionId, page.conversationId);
    if (this.retained && !this.retained.has(key)) return;
    const bytes = 256 + page.messages.reduce((sum, message) => sum + messageSize(message), 0); this.entries.delete(key);
    if (bytes > this.maxBytes) return;
    this.entries.set(key, { page, bytes });
    let total = [...this.entries.values()].reduce((sum, entry) => sum + entry.bytes, 0);
    while (this.entries.size > this.maxEntries || total > this.maxBytes) {
      const oldest = this.entries.keys().next().value!; total -= this.entries.get(oldest)!.bytes; this.entries.delete(oldest);
    }
  }
  retain(sessions: readonly { id: string; conversationId?: string }[]): void {
    this.retained = new Set(sessions.map(session => chatDisplayScope(session.id, session.conversationId)));
    for (const key of this.entries.keys()) if (!this.retained.has(key)) this.entries.delete(key);
  }
}
export const chatDisplayCache = new ChatDisplayCache();
