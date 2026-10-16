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

export function mergeDisplayPage(current: ChatDisplayPage | undefined, incoming: ChatDisplayPage, direction: 'replace' | 'before' | 'after' = 'replace'): ChatDisplayPage {
  const previous = new Map(current?.messages.map(message => [message.id, message]));
  const fresh = incoming.messages.map(message => {
    const old = previous.get(message.id); return old && sameChatMessage(old, message) ? old : message;
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
    incomplete: incoming.incomplete || current?.incomplete || false };
  while (messages.length > 1 && (messages.length > maxMessages || bytes > maxPageBytes)) {
    const removed = direction === 'before' ? messages.pop()! : messages.shift()!;
    bytes -= messageSize(removed);
    if (direction === 'before') page.after = messages.at(-1)!.id;
    else page.before = messages[0].id;
  }
  if (current && page.before === current.before && page.after === current.after && page.incomplete === current.incomplete
    && messages.length === current.messages.length && messages.every((message, index) => message === current.messages[index])) return current;
  return page;
}

/** Authority updates the displayed tail; a detached historical page never grows across an unknown gap. */
export function mergeDisplaySnapshot(page: ChatDisplayPage, messages: readonly ChatMessage[], protectHistory = false): ChatDisplayPage {
  if (!messages.length) return page; // An initial empty projection cannot erase a saved display page.
  const authorityIds = new Set(messages.map(message => message.id));
  const retained = page.messages.filter(message => {
    const streamPrefix = `${message.turnId}:stream:`;
    const temporary = message.role === 'assistant' && message.id.startsWith(streamPrefix) && /^\d+$/.test(message.id.slice(streamPrefix.length));
    return !temporary || authorityIds.has(message.id);
  });
  const currentIds = new Set(retained.map(message => message.id));
  let lastOverlap = -1;
  messages.forEach((message, index) => { if (currentIds.has(message.id)) lastOverlap = index; });
  if (page.after === null && lastOverlap < 0 && (!protectHistory || !retained.length)) {
    // The live tail advanced beyond the bounded host window while this view was inactive.
    // Read the missing history through its cursor rather than joining unrelated windows.
    const tail = messages.slice(-50);
    return mergeDisplayPage(page, { ...page, messages: tail, before: tail[0].id, after: null });
  }
  const changed = new Map(messages.map(message => [message.id, message]));
  const updated = retained.map(message => {
    const next = changed.get(message.id); return next && !sameChatMessage(message, next) ? next : message;
  });
  const newer = lastOverlap < 0 || lastOverlap < messages.length - 1;
  if (page.after === null && !protectHistory && lastOverlap >= 0) updated.push(...messages.slice(lastOverlap + 1));
  return mergeDisplayPage(page, { ...page, messages: updated,
    after: protectHistory && newer && updated.length ? page.after ?? updated.at(-1)!.id : page.after });
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
