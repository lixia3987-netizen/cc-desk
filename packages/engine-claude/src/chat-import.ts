import fs from 'node:fs/promises';
import type { ChatMessage } from '@cc-desk/contracts/chat';
import { object, string } from './chat-protocol.js';

const TAIL_BYTES = 2 * 1024 * 1024;
const MESSAGE_LIMIT = 200;

/** Read a bounded tail for display. The CLI remains responsible for full resume. */
export async function readTranscriptPreview(file: string): Promise<{ messages: ChatMessage[]; truncated: boolean }> {
  const handle = await fs.open(file, 'r');
  try {
    const size = (await handle.stat()).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const data = Buffer.alloc(size - start);
    const { bytesRead } = await handle.read(data, 0, data.length, start);
    let text = data.subarray(0, bytesRead).toString('utf8');
    if (start > 0) { const newline = text.indexOf('\n'); text = newline >= 0 ? text.slice(newline + 1) : ''; }
    const messages: ChatMessage[] = [];
    let truncated = start > 0;
    let recordIndex = 0;
    for (const line of text.split('\n')) {
      recordIndex++;
      let record;
      try { record = object(JSON.parse(line)); } catch { continue; }
      if (record.type !== 'assistant' && record.type !== 'user') continue;
      const message = object(record.message);
      const content = message.content;
      const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content.map(object) : [];
      const sourceId = string(record.uuid) || (string(message.id) ? string(message.id) + ':record:' : '') + String(start + recordIndex);
      const id = 'import:' + sourceId;
      const parentToolUseId = string(record.parent_tool_use_id) || undefined;
      const createdAt = string(record.timestamp);
      const plain = blocks.filter(block => block.type === 'text').map(block => string(block.text)).join('\n');
      if (plain) messages.push({ id, sourceId, turnId: 'imported', role: record.type, text: plain.slice(-256 * 1024), truncated: plain.length > 256 * 1024 || undefined, parentToolUseId, createdAt });
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
