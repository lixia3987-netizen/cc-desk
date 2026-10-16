import fs from 'node:fs/promises';
import type { ChatMessage } from '@cc-desk/contracts/chat';
import { object, string } from './chat-protocol.js';

const TAIL_BYTES = 2 * 1024 * 1024;
const MESSAGE_LIMIT = 200;
let previewReads = 0;
let previewBytesRead = 0;
/** 仅计数读取量，便于验证显示导入的冷/热路径；不保留内容。 */
export function transcriptPreviewStats() { return { reads: previewReads, bytesRead: previewBytesRead }; }

/** 读取有界的尾部记录用于显示；完整恢复仍由 CLI 负责。 */
export async function readTranscriptPreview(file: string, sourceIds?: readonly string[]): Promise<{ messages: ChatMessage[]; truncated: boolean }> {
  const handle = await fs.open(file, 'r');
  try {
    const allowedSourceIds = sourceIds && new Set(sourceIds.map(value => value.toLowerCase()));
    const size = (await handle.stat()).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const data = Buffer.alloc(size - start);
    let bytesRead = 0;
    while (bytesRead < data.length) {
      const next = await handle.read(data, bytesRead, Math.min(64 * 1024, data.length - bytesRead), start + bytesRead);
      if (!next.bytesRead) break;
      bytesRead += next.bytesRead;
    }
    previewReads++; previewBytesRead += bytesRead;
    let text = data.subarray(0, bytesRead).toString('utf8');
    if (start > 0) { const newline = text.indexOf('\n'); text = newline >= 0 ? text.slice(newline + 1) : ''; }
    const messages: ChatMessage[] = [];
    let truncated = start > 0 || bytesRead < data.length;
    let recordIndex = 0;
    for (const line of text.split('\n')) {
      recordIndex++;
      let record;
      try { record = object(JSON.parse(line)); } catch { continue; }
      const sourceId = string(record.sessionId) || string(record.session_id);
      if (allowedSourceIds && sourceId && !allowedSourceIds.has(sourceId.toLowerCase())) throw new Error('Claude 对话记录的来源身份不匹配，已保留本地聊天记录。');
      if (record.type !== 'assistant' && record.type !== 'user') continue;
      const message = object(record.message);
      const content = message.content;
      const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content.map(object) : [];
      const messageSourceId = string(record.uuid) || (string(message.id) ? string(message.id) + ':record:' : '') + String(start + recordIndex);
      const id = 'import:' + messageSourceId;
      const parentToolUseId = string(record.parent_tool_use_id) || undefined;
      const createdAt = string(record.timestamp);
      const plain = blocks.filter(block => block.type === 'text').map(block => string(block.text)).join('\n');
      if (plain) messages.push({ id, sourceId: messageSourceId, turnId: 'imported', role: record.type, text: plain.slice(-256 * 1024), truncated: plain.length > 256 * 1024 || undefined, parentToolUseId, createdAt });
      for (const [index, block] of blocks.entries()) {
        if (block.type === 'tool_use') messages.push({ id: id + ':tool:' + index, sourceId: 'tool:' + string(block.id), parentToolUseId, turnId: 'imported', role: 'tool', text: '', toolName: string(block.name), toolUseId: string(block.id), input: JSON.stringify(block.input ?? {}).length > 64 * 1024 ? { preview: JSON.stringify(block.input).slice(0, 64 * 1024), truncated: true } : object(block.input), createdAt });
        if (block.type === 'tool_result') {
          const text = typeof block.content === 'string' ? block.content : Array.isArray(block.content) ? block.content.map(value => string(object(value).text)).join('\n') : '';
          messages.push({ id: id + ':result:' + index, sourceId: 'tool:' + string(block.tool_use_id), parentToolUseId, turnId: 'imported', role: 'tool', text: text.slice(-256 * 1024), truncated: text.length > 256 * 1024 || undefined, toolUseId: string(block.tool_use_id), isError: block.is_error === true, createdAt });
        }
      }
      while (messages.length > MESSAGE_LIMIT) { messages.shift(); truncated = true; }
    }
    return { messages, truncated };
  } finally { await handle.close(); }
}
