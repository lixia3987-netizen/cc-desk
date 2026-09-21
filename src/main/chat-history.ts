import fs from 'node:fs';
import path from 'node:path';
import type { ChatSnapshot } from '../shared/chat';

const SNAPSHOT_BYTES = 2 * 1024 * 1024;
const SNAPSHOT_MESSAGES = 400;
const INACTIVE_CACHE = 8;

/** A small recoverable UI projection plus a complete append-only event journal. */
export class ChatHistory {
  private cache = new Map<string, ChatSnapshot>();
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
  get(id: string): ChatSnapshot {
    const cached = this.cache.get(id);
    if (cached) { this.cache.delete(id); this.cache.set(id, cached); return cached; }
    const file = this.file(id, '.json');
    let snapshot: ChatSnapshot = { sessionId: id, taskState: 'idle', messages: [], pending: [] };
    if (fs.existsSync(file)) {
      if (fs.statSync(file).size > 16 * 1024 * 1024) throw new Error('聊天快照超过读取上限，原文件已保留。');
      const value = JSON.parse(fs.readFileSync(file, 'utf8')) as ChatSnapshot;
      if (value.sessionId !== id || !Array.isArray(value.messages)) throw new Error('聊天快照格式损坏，原文件已保留。');
      snapshot = value;
      // A permission request is owned by the old process, never by a restored UI.
      snapshot.pending = [];
      if (['starting', 'thinking', 'tool_running', 'waiting_approval', 'waiting_input'].includes(snapshot.taskState)) {
        snapshot.taskState = 'interrupted';
      }
    }
    this.cache.set(id, snapshot);
    this.trim(id);
    this.evict();
    return snapshot;
  }
  append(id: string, event: Record<string, unknown>) {
    fs.appendFileSync(this.file(id, '.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n', { mode: 0o600 });
  }
  changed(id: string) {
    this.trim(id);
    this.dirty.add(id);
    if (!this.timer) this.timer = setTimeout(() => {
      try { this.flush(); }
      catch (error) { for (const key of this.dirty) this.onError(key, error instanceof Error ? error : new Error(String(error))); }
    }, 200);
  }
  private trim(id: string) {
    const snapshot = this.cache.get(id);
    if (!snapshot) return;
    let bytes = snapshot.messages.reduce((total, message) => total + JSON.stringify(message).length * 2, 0);
    while ((bytes > SNAPSHOT_BYTES || snapshot.messages.length > SNAPSHOT_MESSAGES) && snapshot.messages.length > 1) {
      bytes -= JSON.stringify(snapshot.messages.shift()).length * 2;
      snapshot.truncated = true;
    }
  }
  private save(id: string) {
    const snapshot = this.cache.get(id);
    if (!snapshot) return;
    const file = this.file(id, '.json');
    // Pending approvals are transient. They cannot survive a process restart.
    const data = JSON.stringify({ ...snapshot, pending: [] });
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
