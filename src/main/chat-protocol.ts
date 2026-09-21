import fs from 'node:fs/promises';
import path from 'node:path';
import type { Capabilities, Session } from '../shared/types';
import { claudeArguments } from './commands';

export type WireObject = Record<string, unknown>;
export const object = (value: unknown): WireObject => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as WireObject : {};
export const string = (value: unknown): string => typeof value === 'string' ? value : '';

/** CLI stdout is newline-delimited JSON, not one JSON object per read(). */
export class JsonLineDecoder {
  private pending = '';
  constructor(private consume: (value: WireObject) => void, private limit = 8 * 1024 * 1024) {}
  push(chunk: string) {
    this.pending += chunk;
    let end: number;
    while ((end = this.pending.indexOf('\n')) >= 0) {
      if (end > this.limit) throw new Error('Claude 输出的一条事件过大，已停止会话以保护内存。');
      const line = this.pending.slice(0, end).trim(); this.pending = this.pending.slice(end + 1);
      if (line) this.parse(line);
    }
    if (this.pending.length > this.limit) throw new Error('Claude 输出超出协议缓冲上限。');
  }
  private parse(line: string) {
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw new Error('Claude 返回了非 JSON 协议输出，请检查 CLI 版本或改用终端模式。'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Claude 返回了无效的协议事件。');
    this.consume(value as WireObject);
  }
  finish() { if (this.pending.trim()) this.parse(this.pending.trim()); this.pending = ''; }
}

export function chatArguments(session: Session, capabilities: Capabilities, hasTranscript: boolean) {
  const required = ['--print', '--input-format', '--output-format', '--verbose', '--permission-prompt-tool'];
  const missing = required.filter(flag => !capabilities.flags.includes(flag));
  if (!capabilities.available || missing.length) throw new Error('当前 CLI 不支持结构化双向会话：' + (missing.join(', ') || capabilities.error || 'CLI 不可用') + '。请更新 CLI 或使用终端模式。');
  const args = [...claudeArguments(session, capabilities, hasTranscript), '--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-prompt-tool', 'stdio'];
  if (capabilities.flags.includes('--include-partial-messages')) args.push('--include-partial-messages');
  if (capabilities.flags.includes('--forward-subagent-text')) args.push('--forward-subagent-text');
  return args;
}

/** Paths have already been selected/validated by the main-process IPC boundary. */
export async function userContent(text: string, attachments: string[] = []): Promise<WireObject[]> {
  if (attachments.length > 8) throw new Error('一次最多添加 8 个附件。');
  const content: WireObject[] = [{ type: 'text', text }];
  let total = 0;
  for (const file of attachments) {
    const stat = await fs.stat(file);
    if (!stat.isFile()) throw new Error('附件不是文件。');
    total += stat.size;
    if (stat.size > 8 * 1024 * 1024 || total > 16 * 1024 * 1024) throw new Error('附件大小超限：单个 8 MiB，总计 16 MiB。');
    const extension = path.extname(file).toLowerCase();
    const media: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf' };
    if (media[extension]) {
      content.push({ type: 'text', text: '附件：' + path.basename(file) });
      content.push({ type: extension === '.pdf' ? 'document' : 'image', source: { type: 'base64', media_type: media[extension], data: (await fs.readFile(file)).toString('base64') } });
    } else {
      // Do not eagerly read binaries or entire repositories into model context.
      content.push({ type: 'text', text: '用户选择的本地附件路径：' + JSON.stringify(file) + '。需要内容时请使用 Read 工具读取。' });
    }
  }
  return content;
}
