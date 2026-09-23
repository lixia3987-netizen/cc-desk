import { dialog, type BrowserWindow } from 'electron';
import { z } from 'zod';
import type { Session } from '../../shared/types';
import type { ChatTurnResult } from '../../shared/chat';
import { idSchema } from '../../shared/schema';
import type { StructuredExecutions, TerminalExecutions } from '../execution/routers';
import type { Attachments } from '../attachments';
import type { WorkflowEngine } from '../workflows';
import type { Register } from './registration';

interface ChatPorts {
  chat: Pick<StructuredExecutions, 'has' | 'hydrate' | 'snapshot' | 'prepareCommands' | 'page' | 'search' | 'attention' | 'respond'>;
  runtime: Pick<TerminalExecutions, 'has'>;
  workflows: Pick<WorkflowEngine, 'isSessionBusy'>;
  attachments: Pick<Attachments, 'validate' | 'add' | 'list' | 'removeFile'>;
  structured(id: string): Session;
  assertUnlocked(session: Session): void;
  requireCommands(id: string): void;
  reserve(id: string): Promise<void>;
  releaseAdmission(id: string): void;
  runChat(id: string, text: string, attachments: string[]): Promise<ChatTurnResult>;
  getWindow(): BrowserWindow | null;
}

const shortId = z.string().min(1).max(200);
const messageId = z.string().min(1).max(4096);
const pageSchema = z.object({
  id: idSchema, before: messageId.optional(), after: messageId.optional(), around: messageId.optional(),
  query: z.string().max(500).optional(),
}).refine(value => [value.before, value.after, value.around].filter(Boolean).length <= 1);
const searchSchema = z.object({
  id: idSchema, query: z.string().trim().min(1).max(500), before: messageId.optional(),
});
const sendSchema = z.object({
  id: idSchema, text: z.string().max(128 * 1024), attachments: z.array(z.string().max(4096)).max(8).optional(),
});
const responseSchema = z.object({
  id: idSchema, requestId: shortId,
  decision: z.object({
    behavior: z.enum(['allow', 'deny']), message: z.string().max(10000).optional(),
    answers: z.record(z.string().max(2000), z.string().max(10000)).optional(),
  }),
});

export function registerChatHandlers(handle: Register, ports: ChatPorts): void {
  handle('chat:snapshot', idSchema, async id => {
    ports.structured(id);
    await ports.chat.hydrate(id);
    return ports.chat.snapshot(id);
  });
  handle('chat:commands', idSchema, async id => {
    const session = ports.structured(id);
    if (session.archived) throw new Error('请先取消会话归档。');
    ports.assertUnlocked(session);
    ports.requireCommands(id);
    if (ports.chat.has(id)) return ports.chat.snapshot(id);
    if (ports.runtime.has(id) || ports.workflows.isSessionBusy(id)) throw new Error('请先结束当前会话任务。');
    await ports.reserve(id);
    try { return await ports.chat.prepareCommands(id); }
    finally { ports.releaseAdmission(id); }
  });
  handle('chat:page', pageSchema, ({ id, ...options }) => {
    ports.structured(id);
    return ports.chat.page(id, options);
  });
  handle('chat:search', searchSchema, ({ id, query, before }) => {
    ports.structured(id);
    return ports.chat.search(id, query, before);
  });
  handle('chat:attention', z.undefined(), () => ports.chat.attention());
  handle('chat:send', sendSchema, async ({ id, text, attachments }) => {
    ports.structured(id);
    if (!text.trim() && !attachments?.length) throw new Error('请输入消息或选择附件。');
    if (ports.workflows.isSessionBusy(id)) throw new Error('工作流正在执行，请先取消后再手动发送。');
    const approved = await ports.attachments.validate(id, attachments);
    if (ports.workflows.isSessionBusy(id)) throw new Error('工作流已开始，请先取消后再发送。');
    return ports.runChat(id, text, approved);
  });
  handle('chat:respond', responseSchema, ({ id, requestId, decision }) => {
    ports.structured(id);
    return ports.chat.respond(id, requestId, decision);
  });
  handle('files:pick', idSchema, async id => {
    ports.structured(id);
    const result = await dialog.showOpenDialog(ports.getWindow()!, {
      title: '添加上下文附件', properties: ['openFile', 'multiSelections'],
      filters: [{ name: '文本、图片与 PDF', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'txt', 'md', 'json', 'csv', 'ts', 'tsx', 'js', 'py', 'yaml', 'yml', 'html', 'css', 'xml', 'log'] }],
    });
    return result.canceled ? [] : ports.attachments.add(id, result.filePaths);
  });
  handle('files:attachments', idSchema, id => {
    ports.structured(id);
    return ports.attachments.list(id);
  });
  handle('files:remove-attachment', z.object({ id: idSchema, path: z.string().min(1).max(4096) }), ({ id, path }) => {
    ports.structured(id);
    return ports.attachments.removeFile(id, path);
  });
}
