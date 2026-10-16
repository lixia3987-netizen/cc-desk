import fs, { type FileHandle } from 'node:fs/promises';
import { constants, type BigIntStats } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ChatMessage, ChatPage, ChatPageOptions, ChatSnapshot } from '../shared/chat';
import { ChatArchive } from './chat-archive';
import { isMessage, ResultEchoRecovery } from './chat-history';

const TAIL_BYTES = 4 * 1024 * 1024;
const PAGE_BYTES = 256 * 1024;
const PAGE_SIZE = 50;
const PREVIEW = 16 * 1024;
const SNAPSHOT_BYTES = 3 * 1024 * 1024;
interface Source { conversationId?: string; requireConversationMatch?: boolean }
interface CachedPage { signature: string; page: ChatPage }
interface DisplaySidecar { schemaVersion?: number; sessionId?: string; conversationId?: string; signature?: string; sourceFile?: 'journal' | 'snapshot'; page?: ChatPage }
const signature = (stat: BigIntStats) => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
const validId = (id: string) => { if (!/^[a-z0-9-]{1,100}$/i.test(id)) throw new Error('无效会话 ID。'); };

async function openRegular(file: string): Promise<FileHandle | undefined> {
  let handle: FileHandle | undefined;
  try {
    const before = await fs.lstat(file, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) throw new Error('显示记录必须是普通文件。');
    handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const actual = await handle.stat({ bigint: true });
    if (!actual.isFile() || before.dev !== actual.dev || before.ino !== actual.ino) throw new Error('显示记录在读取时发生变化，请重试。');
    return handle;
  } catch (error) {
    await handle?.close();
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** 有界展示投影；执行、恢复与审批仍须读取完整的权威账本。 */
export function displayPage(messages: readonly ChatMessage[], before = false, incomplete = false): ChatPage {
  const result: ChatMessage[] = [];
  let bytes = 0, omitted = messages.length > PAGE_SIZE;
  for (const original of messages.slice(-PAGE_SIZE).toReversed()) {
    const message = structuredClone(original);
    if (message.text.length > PREVIEW) { message.text = message.text.slice(-PREVIEW); message.truncated = true; }
    if (message.input) {
      const input = JSON.stringify(message.input);
      if (input.length > PREVIEW) { message.input = { preview: input.slice(0, PREVIEW), truncated: true }; message.truncated = true; }
    }
    let size = Buffer.byteLength(JSON.stringify(message));
    // 兼容旧记录中未受限的附加字段；任何单项也不能突破 IPC 总预算。
    if (size > PAGE_BYTES / 2) {
      const { id, turnId, role, text, createdAt, submissionId, sourceId, toolName, toolUseId, parentToolUseId, isError } = message;
      Object.keys(message).forEach(key => { delete (message as unknown as Record<string, unknown>)[key]; });
      Object.assign(message, { id, turnId, role, text, createdAt, submissionId, sourceId, toolName, toolUseId, parentToolUseId, isError, truncated: true });
      size = Buffer.byteLength(JSON.stringify(message));
    }
    // Leave room for scoped IPC identity and at most 50 host-proven client request IDs.
    if (bytes + size > PAGE_BYTES - 16 * 1024 || size > PAGE_BYTES - 16 * 1024) { omitted = true; break; }
    result.unshift(message); bytes += size;
  }
  return { messages: result, before: (before || omitted) && result.length ? result[0].id : null, after: null, incomplete };
}

/** 仅首屏读取有界尾部；显式旧页才按需使用归档索引。无 writer、恢复或工作区扫描。 */
export class ChatDisplayReader {
  private cache = new Map<string, CachedPage>();
  private archive: ChatArchive;
  private counters = { journalBytesRead: 0, tailReads: 0, cacheHits: 0, sidecarHits: 0 };
  constructor(private directory: string) { this.archive = new ChatArchive(directory); }
  get statistics() { return { ...this.counters }; }
  forget(id: string) { for (const key of this.cache.keys()) if (key.startsWith(id + ':')) this.cache.delete(key); this.archive.forget(id); }
  private remember(key: string, value: CachedPage) {
    this.cache.delete(key); this.cache.set(key, value);
    while (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value!);
  }
  private async json(file: string, maximum: number): Promise<unknown> {
    const handle = await openRegular(file);
    if (!handle) return;
    try {
      const stat = await handle.stat();
      if (stat.size > maximum) return;
      const bytes = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < bytes.length) {
        const read = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!read.bytesRead) return;
        offset += read.bytesRead;
      }
      try { return JSON.parse(bytes.toString('utf8')); } catch { return; }
    } finally { await handle.close(); }
  }
  private async snapshot(id: string): Promise<ChatSnapshot | undefined> {
    const value = await this.json(path.join(this.directory, id + '.json'), SNAPSHOT_BYTES).catch(() => undefined) as ChatSnapshot | undefined;
    if (value?.sessionId === id && Array.isArray(value.messages) && value.messages.every(isMessage)) return value;
  }
  private async fallback(id: string): Promise<ChatPage> {
    const value = await this.snapshot(id);
    if (value) return displayPage(value.messages, !!value.truncated, !!value.sourceIncomplete);
    return { messages: [], before: null, after: null, incomplete: false };
  }
  private async preservedSnapshot(id: string, source: Source): Promise<ChatPage | undefined> {
    const handle = await openRegular(path.join(this.directory, id + '.json'));
    if (!handle) return;
    try {
      const sidecar = await this.json(path.join(this.directory, id + '.display.json'), PAGE_BYTES).catch(() => undefined) as DisplaySidecar | undefined;
      if (sidecar?.schemaVersion !== 1 || sidecar.sourceFile !== 'snapshot' || sidecar.sessionId !== id
        || sidecar.conversationId !== source.conversationId || sidecar.signature !== signature(await handle.stat({ bigint: true }))
        || !sidecar.page || !Array.isArray(sidecar.page.messages) || !sidecar.page.messages.every(isMessage)) return;
      return displayPage(sidecar.page.messages, !!sidecar.page.before, true);
    } finally { await handle.close(); }
  }
  async page(id: string, options: ChatPageOptions = {}, source: Source = {}): Promise<ChatPage> {
    validId(id);
    if (options.before || options.after || options.around) {
      // 显式分页不需要先 hydrate 或同步读取完整的历史快照。
      const fallback = source.requireConversationMatch ? await this.page(id, {}, source) : await this.fallback(id);
      if (source.requireConversationMatch && !fallback.messages.length && fallback.incomplete) return fallback;
      const snapshot = await this.snapshot(id);
      return this.archive.page(id, { sessionId: id, taskState: 'idle', messages: snapshot?.messages ?? fallback.messages, pending: [], sourceIncomplete: fallback.incomplete }, options);
    }
    const handle = await openRegular(path.join(this.directory, id + '.jsonl'));
    if (!handle) return source.requireConversationMatch
      ? await this.preservedSnapshot(id, source) ?? { messages: [], before: null, after: null, incomplete: true }
      : this.fallback(id);
    try {
      const stat = await handle.stat({ bigint: true }), version = signature(stat);
      const key = id + ':' + (source.conversationId ?? '') + ':' + !!source.requireConversationMatch;
      const cached = this.cache.get(key);
      if (cached?.signature === version) { this.counters.cacheHits++; this.remember(key, cached); return structuredClone(cached.page); }
      const sidecar = await this.json(path.join(this.directory, id + '.display.json'), PAGE_BYTES).catch(() => undefined) as DisplaySidecar | undefined;
      if (source.requireConversationMatch && sidecar?.schemaVersion === 1 && sidecar.sessionId === id && sidecar.conversationId !== source.conversationId) {
        return { messages: [], before: null, after: null, incomplete: true };
      }
      let page: ChatPage;
      if (sidecar?.schemaVersion === 1 && sidecar.sourceFile !== 'snapshot' && sidecar.sessionId === id && sidecar.conversationId === source.conversationId && sidecar.signature === version
        && sidecar.page && Array.isArray(sidecar.page.messages) && sidecar.page.messages.length <= PAGE_SIZE && sidecar.page.messages.every(isMessage)
        && (sidecar.page.before === null || typeof sidecar.page.before === 'string') && sidecar.page.after === null && typeof sidecar.page.incomplete === 'boolean') {
        this.counters.sidecarHits++; page = displayPage(sidecar.page.messages, !!sidecar.page.before, sidecar.page.incomplete);
      } else {
        const size = Number(stat.size), start = Math.max(0, size - TAIL_BYTES), data = Buffer.alloc(size - start);
        let offset = 0;
        while (offset < data.length) {
          const read = await handle.read(data, offset, Math.min(64 * 1024, data.length - offset), start + offset);
          if (!read.bytesRead) break;
          offset += read.bytesRead;
        }
        this.counters.journalBytesRead += offset; this.counters.tailReads++;
        let bytes = data.subarray(0, offset), incomplete = offset !== data.length;
        if (start > 0) { const newline = bytes.indexOf(10); bytes = newline < 0 ? Buffer.alloc(0) : bytes.subarray(newline + 1); }
        if (bytes.length && bytes.at(-1) !== 10) { incomplete = true; bytes = bytes.subarray(0, bytes.lastIndexOf(10) + 1); }
        const messages = new Map<string, ChatMessage>(), migration = new ResultEchoRecovery(new Set());
        let bound = false, wrongSource = false;
        for (const line of bytes.toString('utf8').split('\n')) {
          if (!line) continue;
          try {
            const event = JSON.parse(line);
            if (!event || typeof event !== 'object' || Array.isArray(event)) { incomplete = true; continue; }
            if (source.requireConversationMatch) {
              if (event.conversationId !== source.conversationId) wrongSource = true;
              else bound = true;
            }
            if (migration.skip(event)) continue;
            if (event.type === 'message' && isMessage(event.message)) messages.set(event.message.id, event.message);
            else if (event.type === 'text_delta' && typeof event.id === 'string' && typeof event.text === 'string') {
              const message = messages.get(event.id);
              if (message) { const length = message.text.length + event.text.length; message.text = (message.text + event.text).slice(-PREVIEW); message.truncated ||= length > PREVIEW; }
              else incomplete = true;
            }
          } catch { incomplete = true; }
        }
        if (source.requireConversationMatch && (!bound || wrongSource)) return { messages: [], before: null, after: null, incomplete: true };
        page = displayPage([...messages.values()], start > 0, incomplete || start > 0 && !messages.size);
        if (!source.requireConversationMatch && !page.messages.length) { const fallback = await this.fallback(id); if (fallback.messages.length) page = { ...fallback, incomplete: true }; }
      }
      // 不缓存已变化的来源；下一次读取必须观察新的源文件版本。
      if (signature(await handle.stat({ bigint: true })) === version) this.remember(key, { signature: version, page });
      else page = { ...page, incomplete: true };
      return structuredClone(page);
    } finally { await handle.close(); }
  }
}

/** 只由已完成投影发布的写侧调用；显示读取绝不创建或修复此派生缓存。 */
export async function writeDisplaySidecar(directory: string, id: string, conversationId: string, page: ChatPage): Promise<void> {
  validId(id);
  let sourceFile: 'journal' | 'snapshot' = 'journal';
  let source = await openRegular(path.join(directory, id + '.jsonl'));
  if (!source) { source = await openRegular(path.join(directory, id + '.json')); sourceFile = 'snapshot'; }
  if (!source) return;
  const temporary = path.join(directory, `${id}.display-${randomUUID()}.tmp`);
  try {
    const stat = await source.stat({ bigint: true });
    const data = JSON.stringify({ schemaVersion: 1, sessionId: id, conversationId, sourceFile, signature: signature(stat), page: displayPage(page.messages, !!page.before, page.incomplete) });
    if (Buffer.byteLength(data) > PAGE_BYTES) return;
    await fs.writeFile(temporary, data, { flag: 'wx', mode: 0o600 });
    if (signature(await source.stat({ bigint: true })) !== signature(stat)) return;
    await fs.rename(temporary, path.join(directory, id + '.display.json'));
  } finally { await source.close(); await fs.rm(temporary, { force: true }); }
}

const readers = new Map<string, ChatDisplayReader>();
export function readDisplayPage(directory: string, id: string, options: ChatPageOptions = {}): Promise<ChatPage> {
  let reader = readers.get(directory);
  if (!reader) reader = new ChatDisplayReader(directory);
  readers.delete(directory); readers.set(directory, reader);
  while (readers.size > 8) readers.delete(readers.keys().next().value!);
  return reader.page(id, options);
}
