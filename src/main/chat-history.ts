import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ChatMessage, ChatSnapshot, TaskState } from '../shared/chat';

const SNAPSHOT_BYTES = 2 * 1024 * 1024;
const SNAPSHOT_MESSAGES = 400;
const MESSAGE_TEXT = 256 * 1024;
const JOURNAL_RECORD_BYTES = 32 * 1024 * 1024;
const INACTIVE_CACHE = 8;
const PROJECTION_VERSION = 1;
const TASK_STATES = new Set<TaskState>(['idle', 'starting', 'thinking', 'tool_running', 'waiting_approval', 'waiting_input', 'completed', 'interrupted', 'error']);
const LIVE_STATES = new Set<TaskState>(['starting', 'thinking', 'tool_running', 'waiting_approval', 'waiting_input']);
interface MessageRecord { message: ChatMessage; bytes: number; index: number }
interface CachedHistory {
  snapshot: ChatSnapshot; messages: Map<string, MessageRecord>; array: ChatMessage[];
  bytes: number; start: number; managedChange: boolean;
  journalCursor: number; journalEnd: number; checkJournal: boolean;
}
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
export const isMessage = (value: unknown): value is ChatMessage => {
  const message = object(value);
  return !!message && typeof message.id === 'string' && typeof message.turnId === 'string' && typeof message.text === 'string' && typeof message.createdAt === 'string' && ['user', 'assistant', 'tool', 'system'].includes(String(message.role));
};
interface TextFingerprint { length: number; digest: string }
const fingerprint = (text: string): TextFingerprint => ({ length: text.length, digest: createHash('sha256').update(text, 'utf16le').digest('hex') });
const syntheticId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);

/** Recognizes only IDs produced by our root assistant block adapters. */
function rootBlock(message: ChatMessage): { group: string; index: number } | undefined {
  if (message.role !== 'assistant' || message.parentToolUseId || !message.turnId || message.truncated) return;
  const separator = message.id.lastIndexOf(':');
  const suffix = message.id.slice(separator + 1);
  if (separator < 0 || !/^\d+$/.test(suffix)) return;
  const index = Number(suffix); if (!Number.isSafeInteger(index)) return;
  const group = message.id.slice(0, separator);
  const oldPrefix = message.turnId + ':main:';
  if (group.startsWith(oldPrefix) && group.length > oldPrefix.length) return { group, index };
  try {
    const tuple: unknown = JSON.parse(group);
    if (Array.isArray(tuple) && tuple.length === 3 && tuple[0] === message.turnId && tuple[1] === null && typeof tuple[2] === 'string' && tuple[2]) return { group, index };
  } catch { /* An unrelated ID provides no migration evidence. */ }
}

/** Repairs only result echoes with explicit journal provenance, never repeated text. */
export class ResultEchoRecovery {
  private latest?: { id: string; turnId: string; blocks: Map<number, TextFingerprint>; exhausted: boolean };
  private previousComplete = false;
  private pending?: TextFingerprint & { turnId: string };
  readonly removed = new Set<string>();
  constructor(private snapshotIds: Set<string>) {}
  invalidate() { this.latest = undefined; this.pending = undefined; this.previousComplete = false; }
  private matches(summary: string): boolean {
    if (!this.latest || this.latest.exhausted) return false;
    const blocks = [...this.latest.blocks].sort(([a], [b]) => a - b).map(([, block]) => block).filter(block => block.length);
    if (!blocks.length) return false;
    const last = blocks[blocks.length - 1];
    if (last.length === summary.length && last.digest === fingerprint(summary).digest) return true;
    return ['', '\n', '\n\n'].some(separator => {
      if (blocks.reduce((length, block) => length + block.length, separator.length * (blocks.length - 1)) !== summary.length) return false;
      let offset = 0;
      return blocks.every((block, index) => {
        if (index) { if (summary.slice(offset, offset + separator.length) !== separator) return false; offset += separator.length; }
        const part = summary.slice(offset, offset + block.length); offset += block.length;
        return block.digest === fingerprint(part).digest;
      });
    });
  }
  skip(value: unknown): boolean {
    const candidate = this.pending; this.pending = undefined;
    const event = object(value);
    if (!event) { this.invalidate(); return false; }
    if (event.type === 'message' && isMessage(event.message)) {
      const message = event.message;
      if (candidate && message.role === 'assistant' && !message.parentToolUseId && !message.sourceId && !message.isError && !message.truncated && syntheticId(message.id) && message.turnId === candidate.turnId && message.text.length === candidate.length && fingerprint(message.text).digest === candidate.digest) {
        // Only retain removal IDs that could be in the old bounded snapshot.
        if (this.snapshotIds.has(message.id)) this.removed.add(message.id);
        this.invalidate(); return true;
      }
      const block = rootBlock(message);
      this.previousComplete = !!block;
      if (block) {
        if (this.latest?.id !== block.group) this.latest = { id: block.group, turnId: message.turnId, blocks: new Map(), exhausted: false };
        if (this.latest!.blocks.size >= SNAPSHOT_MESSAGES && !this.latest!.blocks.has(block.index)) { this.latest!.blocks.clear(); this.latest!.exhausted = true; }
        if (!this.latest!.exhausted) this.latest!.blocks.set(block.index, fingerprint(message.text));
      } else if (!message.parentToolUseId && (message.role === 'assistant' || message.role === 'user')) this.latest = undefined;
    } else if (event.type === 'result') {
      // Error summaries have separate meaning, even when their text is equal.
      if (event.success === true && this.previousComplete && this.latest && typeof event.summary === 'string' && event.summary && this.matches(event.summary)) this.pending = { ...fingerprint(event.summary), turnId: this.latest.turnId };
      this.latest = undefined; this.previousComplete = false;
    } else this.previousComplete = false;
    return false;
  }
}

/** A bounded UI projection plus a complete append-only event journal. */
export class ChatHistory {
  private cache = new Map<string, CachedHistory>();
  private dirty = new Set<string>();
  private timer?: NodeJS.Timeout;
  readonly directory: string;
  constructor(directory: string, private isActive: (id: string) => boolean, private onError: (id: string, error: Error) => void = () => {}) {
    this.directory = path.join(directory, 'chat');
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  }
  private file(id: string, suffix: string) {
    if (!/^[a-z0-9-]{1,100}$/i.test(id)) throw new Error('无效会话 ID。');
    return path.join(this.directory, id + suffix);
  }
  private entry(snapshot: ChatSnapshot): CachedHistory {
    return { snapshot, messages: new Map(), array: snapshot.messages, bytes: 0, start: 0, managedChange: false, journalCursor: 0, journalEnd: 0, checkJournal: false };
  }
  get(id: string): ChatSnapshot {
    const cached = this.cache.get(id);
    if (cached) { this.cache.delete(id); this.cache.set(id, cached); return cached.snapshot; }
    const file = this.file(id, '.json');
    let snapshot: ChatSnapshot = { sessionId: id, taskState: 'idle', messages: [], pending: [] };
    let cursor: unknown;
    let projectionVersion: unknown;
    let hadSnapshot = false;
    if (fs.existsSync(file)) {
      if (fs.statSync(file).size > 16 * 1024 * 1024) throw new Error('聊天快照超过读取上限，原文件已保留。');
      const value = JSON.parse(fs.readFileSync(file, 'utf8')) as ChatSnapshot & { journalCursor?: unknown; projectionVersion?: unknown };
      if (value.sessionId !== id || !Array.isArray(value.messages) || !value.messages.every(isMessage)) throw new Error('聊天快照格式损坏，原文件已保留。');
      cursor = value.journalCursor;
      projectionVersion = value.projectionVersion;
      delete value.journalCursor;
      delete value.projectionVersion;
      snapshot = value; hadSnapshot = true;
    }
    const entry = this.entry(snapshot);
    this.reconcile(entry);
    const journal = this.file(id, '.jsonl');
    if (fs.existsSync(journal)) {
      const fd = fs.openSync(journal, 'r');
      try {
        const size = fs.fstatSync(fd).size;
        const boundary = Buffer.alloc(1);
        const validCursor = typeof cursor === 'number' && Number.isSafeInteger(cursor) && cursor >= 0 && cursor <= size && (cursor === 0 || fs.readSync(fd, boundary, 0, 1, cursor - 1) === 1 && boundary[0] === 10);
        if (hadSnapshot && (!validCursor || projectionVersion !== PROJECTION_VERSION)) {
          // Old snapshots have no event boundary. Rebuild journal text separately:
          // applying its deltas directly to saved text would duplicate that text.
          const recovered = this.entry({ ...snapshot, messages: [], pending: [] });
          const removed = this.replay(recovered, fd, 0, size, new Set(entry.messages.keys()));
          // Removing echoes can make older journal messages fit again. Keep the
          // authoritative replay order instead of updating shared IDs in their
          // old snapshot positions and appending those older messages afterward.
          const recoveredIds = new Set(recovered.snapshot.messages.map(message => message.id));
          snapshot.messages = snapshot.messages.filter(message => !removed.has(message.id) && !recoveredIds.has(message.id));
          this.reconcile(entry);
          for (const message of recovered.snapshot.messages) this.put(entry, message);
          Object.assign(snapshot, recovered.snapshot, { messages: entry.array, truncated: snapshot.truncated || recovered.snapshot.truncated });
          entry.journalCursor = recovered.journalCursor;
          entry.journalEnd = recovered.journalEnd;
        } else this.replay(entry, fd, validCursor ? cursor as number : 0, size);
        if (entry.journalCursor !== cursor || entry.journalEnd !== entry.journalCursor) this.dirty.add(id);
      } finally { fs.closeSync(fd); }
    } else if (cursor !== undefined) this.dirty.add(id);
    if (hadSnapshot && projectionVersion !== PROJECTION_VERSION) this.dirty.add(id);
    // Approval requests belong to the old process, never to a restored UI.
    if (snapshot.pending?.length || LIVE_STATES.has(snapshot.taskState)) this.dirty.add(id);
    snapshot.pending = [];
    delete snapshot.commands;
    if (snapshot.context?.status === 'compacting') {
      snapshot.context = { ...snapshot.context, status: 'unknown', inputTokens: undefined, measuredAt: undefined };
      this.dirty.add(id);
    }
    if (LIVE_STATES.has(snapshot.taskState)) snapshot.taskState = 'interrupted';
    if (!TASK_STATES.has(snapshot.taskState)) snapshot.taskState = 'idle';
    entry.managedChange = false;
    this.cache.set(id, entry);
    this.evict();
    return snapshot;
  }
  getMessage(id: string, messageId: string): ChatMessage | undefined {
    this.get(id);
    const entry = this.cache.get(id)!;
    this.reconcileIfNeeded(entry);
    return entry.messages.get(messageId)?.message;
  }
  /** Stores a replacement without serializing unrelated messages on each delta. */
  upsertMessage(id: string, message: ChatMessage): ChatMessage {
    this.get(id);
    const entry = this.cache.get(id)!;
    this.reconcileIfNeeded(entry);
    return this.put(entry, message);
  }
  append(id: string, event: Record<string, unknown>) {
    this.get(id);
    const entry = this.cache.get(id)!;
    const file = this.file(id, '.jsonl');
    if (entry.checkJournal) {
      entry.journalEnd = fs.existsSync(file) ? fs.statSync(file).size : 0;
      entry.checkJournal = false;
    }
    // Keep an incomplete tail as evidence, but put the next event on a new line.
    const data = (entry.journalEnd > entry.journalCursor ? '\n' : '') + JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n';
    try { fs.appendFileSync(file, data, { mode: 0o600 }); }
    catch (error) { entry.checkJournal = true; throw error; }
    entry.journalCursor = entry.journalEnd += Buffer.byteLength(data);
  }
  changed(id: string) {
    const entry = this.cache.get(id);
    if (entry) {
      this.reconcileIfNeeded(entry, !entry.managedChange);
      entry.managedChange = false;
    }
    this.dirty.add(id);
    if (!this.timer) this.timer = setTimeout(() => {
      try { this.flush(); }
      catch (error) { for (const key of this.dirty) this.onError(key, error instanceof Error ? error : new Error(String(error))); }
    }, 200);
  }
  private reconcileIfNeeded(entry: CachedHistory, checkReferences = false) {
    const messages = entry.snapshot.messages;
    if (entry.array !== messages || entry.messages.size !== messages.length || checkReferences && messages.some((message, index) => entry.messages.get(message.id)?.message !== message || entry.messages.get(message.id)?.index !== index + entry.start)) this.reconcile(entry);
  }
  private reconcile(entry: CachedHistory) {
    const messages = entry.snapshot.messages;
    entry.array = entry.snapshot.messages = [];
    entry.messages.clear(); entry.bytes = 0; entry.start = 0;
    for (const message of messages) this.put(entry, message);
  }
  private put(entry: CachedHistory, original: ChatMessage): ChatMessage {
    // Bound individual messages as well as the aggregate projection. The journal
    // retains the full event, including any text/input omitted from this preview.
    const message = { ...original };
    if (message.text.length > MESSAGE_TEXT) { message.text = message.text.slice(-MESSAGE_TEXT); message.truncated = true; }
    if (message.input) {
      const input = JSON.stringify(message.input);
      if (input.length > MESSAGE_TEXT) { message.input = { preview: input.slice(0, MESSAGE_TEXT), truncated: true }; message.truncated = true; }
    }
    let bytes = Buffer.byteLength(JSON.stringify(message));
    while (bytes > SNAPSHOT_BYTES && (message.text.length > 1 || message.input)) {
      if (message.text.length > 1) message.text = message.text.slice(-Math.floor(message.text.length / 2));
      else delete message.input;
      message.truncated = true;
      bytes = Buffer.byteLength(JSON.stringify(message));
    }
    const previous = entry.messages.get(message.id);
    if (previous) {
      entry.array[previous.index - entry.start] = message;
      entry.bytes -= previous.bytes;
    } else entry.array.push(message);
    entry.messages.set(message.id, { message, bytes, index: previous?.index ?? entry.start + entry.array.length - 1 });
    entry.bytes += bytes; entry.managedChange = true;
    if (message.truncated) entry.snapshot.truncated = true;
    while ((entry.bytes > SNAPSHOT_BYTES || entry.array.length > SNAPSHOT_MESSAGES) && entry.array.length > 1) {
      const removed = entry.array.shift()!;
      entry.bytes -= entry.messages.get(removed.id)!.bytes;
      entry.messages.delete(removed.id); entry.start++;
      entry.snapshot.truncated = true;
    }
    return message;
  }
  private replay(entry: CachedHistory, fd: number, offset: number, size: number, snapshotIds = new Set<string>()) {
    const buffer = Buffer.alloc(64 * 1024);
    const migration = new ResultEchoRecovery(snapshotIds);
    let parts: Buffer[] = []; let bytes = 0; let tooLarge = false;
    let position = offset;
    entry.journalCursor = offset; entry.journalEnd = size;
    while (position < size) {
      const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, size - position), position);
      if (!count) break;
      let start = 0;
      while (start < count) {
        const newline = buffer.indexOf(10, start);
        const end = newline >= 0 && newline < count ? newline : count;
        bytes += end - start;
        if (bytes > JOURNAL_RECORD_BYTES) { tooLarge = true; parts = []; }
        if (!tooLarge && end > start) parts.push(Buffer.from(buffer.subarray(start, end)));
        if (end === count) break;
        if (tooLarge) { entry.snapshot.truncated = true; migration.invalidate(); }
        else if (bytes) {
          try {
            const event: unknown = JSON.parse(Buffer.concat(parts, bytes).toString('utf8'));
            if (!migration.skip(event)) this.applyEvent(entry, event);
          }
          catch { entry.snapshot.truncated = true; migration.invalidate(); }
        }
        entry.journalCursor = position + end + 1;
        parts = []; bytes = 0; tooLarge = false; start = end + 1;
      }
      position += count;
    }
    if (entry.journalCursor < size) entry.snapshot.truncated = true;
    return migration.removed;
  }
  private applyEvent(entry: CachedHistory, value: unknown) {
    const event = object(value);
    if (!event) { entry.snapshot.truncated = true; return; }
    const snapshot = entry.snapshot;
    if (event.type === 'message' && isMessage(event.message)) this.put(entry, event.message);
    else if (event.type === 'text_delta' && typeof event.id === 'string' && typeof event.text === 'string') {
      const previous = entry.messages.get(event.id)?.message;
      if (previous) this.put(entry, { ...previous, text: previous.text + event.text });
    } else if (event.type === 'state' && TASK_STATES.has(event.taskState as TaskState)) {
      snapshot.taskState = event.taskState as TaskState;
      snapshot.error = typeof event.error === 'string' ? event.error : undefined;
    } else if (event.type === 'metadata') {
      snapshot.model = typeof event.model === 'string' ? event.model : undefined;
      snapshot.permissionMode = typeof event.permissionMode === 'string' ? event.permissionMode : undefined;
      if (Array.isArray(event.mcpServers)) snapshot.mcpServers = event.mcpServers.filter(item => {
        const server = object(item); return server && typeof server.name === 'string' && typeof server.status === 'string';
      }) as ChatSnapshot['mcpServers'];
    } else if (event.type === 'context') {
      const context = object(event.context);
      if (context && ['unknown','ready','compacting','compacted'].includes(String(context.status))) snapshot.context = context as unknown as ChatSnapshot['context'];
    } else if (event.type === 'result') {
      if (object(event.usage)) snapshot.usage = event.usage as ChatSnapshot['usage'];
      // A result may precede background task completion. Only a state event can
      // confirm that the owning turn finished.
      snapshot.error = typeof event.error === 'string' ? event.error : undefined;
    }
  }
  private save(id: string) {
    const entry = this.cache.get(id);
    if (!entry) return;
    const file = this.file(id, '.json');
    // Cursor and projection must commit together; pending approvals are transient.
    const data = JSON.stringify({ ...entry.snapshot, pending: [], journalCursor: entry.journalCursor, projectionVersion: PROJECTION_VERSION });
    const fd = fs.openSync(file + '.tmp', 'w', 0o600);
    try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(file + '.tmp', file);
    this.dirty.delete(id);
  }
  private evict() {
    const inactive = [...this.cache.keys()].filter(id => !this.isActive(id));
    for (const id of inactive.slice(0, Math.max(0, inactive.length - INACTIVE_CACHE))) {
      if (this.dirty.has(id)) this.save(id);
      this.cache.delete(id);
    }
  }
  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const id of this.dirty) this.save(id);
    this.evict();
  }
  exportPath(id: string) {
    this.flush();
    const file = this.file(id, '.jsonl');
    if (!fs.existsSync(file)) fs.writeFileSync(file, '', { mode: 0o600 });
    return file;
  }
  delete(id: string) {
    if (this.isActive(id)) throw new Error('请先停止会话。');
    this.cache.delete(id); this.dirty.delete(id);
    for (const suffix of ['.json', '.json.tmp', '.jsonl']) fs.rmSync(this.file(id, suffix), { force: true });
  }
}
