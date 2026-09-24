import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { ChatQueueSnapshot } from '../shared/chat';

const itemSchema = z.object({
  id: z.string().uuid(), text: z.string().max(128 * 1024), attachments: z.array(z.string().max(4096)).max(8),
  createdAt: z.string().max(100), status: z.enum(['queued', 'sending']),
  attachmentNames: z.array(z.string().max(1024)).max(8).optional(),
});
const schema = z.object({
  version: z.literal(1), items: z.array(itemSchema).max(100), paused: z.boolean(), error: z.string().max(8000).optional(),
  receipts: z.array(z.object({ requestId: z.string().max(200), messageId: z.string().uuid(), digest: z.string().length(64) })).max(512),
});
export interface StoredChatQueue extends ChatQueueSnapshot {
  version: 1; receipts: { requestId: string; messageId: string; digest: string }[];
}

/** Commit an accepted prompt before acknowledging it to the renderer. */
export class ChatQueueStorage {
  private directory: string;
  constructor(directory: string) { this.directory = path.join(directory, 'chat-queue'); }
  private file(id: string) {
    if (!/^[a-z0-9-]{1,100}$/i.test(id)) throw new Error('无效会话 ID。');
    return path.join(this.directory, id + '.json');
  }
  load(id: string): StoredChatQueue {
    const file = this.file(id);
    try {
      if (fs.statSync(file).size > 20 * 1024 * 1024) throw new Error('排队消息文件过大。');
      return schema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, items: [], paused: false, receipts: [] };
      throw new Error('排队消息无法读取，原文件已保留。' + (error instanceof Error ? error.message : String(error)));
    }
  }
  save(id: string, value: StoredChatQueue) {
    const data = JSON.stringify(schema.parse(value));
    if (Buffer.byteLength(data) > 16 * 1024 * 1024) throw new Error('排队消息总量已达上限，请先移除部分消息。');
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const file = this.file(id), fd = fs.openSync(file + '.tmp', 'w', 0o600);
    try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(file + '.tmp', file);
  }
  delete(id: string) {
    fs.rmSync(this.file(id), { force: true });
    fs.rmSync(this.file(id) + '.tmp', { force: true });
  }
}
