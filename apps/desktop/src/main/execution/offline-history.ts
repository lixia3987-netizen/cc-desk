import fs from 'node:fs';
import path from 'node:path';
import type { ChatPageOptions, ChatSnapshot } from '../../shared/chat';
import { ChatHistory } from '../chat-history';
import { ChatArchive } from '../chat-archive';

/** Passive access to host-owned display records; never loads an execution adapter. */
export class OfflineHistory {
  private history: ChatHistory;
  private archive: ChatArchive;
  constructor(directory: string) {
    this.history = new ChatHistory(directory, () => false, undefined, true);
    this.archive = new ChatArchive(this.history.directory);
  }
  snapshot(id: string, reason: string): ChatSnapshot {
    if (!/^[a-z0-9-]{1,100}$/i.test(id)) throw new Error('无效会话 ID。');
    const exists = ['.json', '.jsonl'].some(suffix => fs.existsSync(path.join(this.history.directory, id + suffix)));
    const saved = exists ? structuredClone(this.history.get(id)) : { sessionId: id, taskState: 'idle' as const, messages: [], pending: [] };
    return { ...saved, pending: [], commands: undefined, queue: { items: [], paused: true },
      error: `${reason}${exists ? ' 当前显示已保存的只读记录。' : ' 没有可读取的本地聊天记录。'}` };
  }
  page(id: string, reason: string, options?: ChatPageOptions) { return this.archive.page(id, this.snapshot(id, reason), options); }
  search(id: string, reason: string, query: string, before?: string) { return this.archive.search(id, this.snapshot(id, reason), query, before); }
}
