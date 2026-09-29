import { dialog, type BrowserWindow } from 'electron';
import { z } from 'zod';
import type { Session } from '../../shared/types';
import type { ChatSnapshot, ChatTurnResult } from '../../shared/chat';
import { idSchema } from '../../shared/schema';
import { NATIVE_IMAGE_MAX_BYTES, NATIVE_IMAGE_MAX_COUNT } from '../../shared/native-images';
import type { StructuredExecutions, TerminalExecutions } from '../execution/routers';
import type { Attachments } from '../attachments';
import type { WorkflowEngine } from '../workflows';
import type { ChatQueue } from '../chat-queue';
import { invokedCommand } from '../../shared/session-commands';
import { attachmentFilters, attachmentPathsSchema, draftAttachmentSelectionSchema, draftAttachmentSelectionsSchema, DraftAttachments } from '../draft-attachments';
import type { Register } from './registration';

interface ChatPorts {
  chat: Pick<StructuredExecutions, 'has' | 'hydrate' | 'snapshot' | 'prepareCommands' | 'page' | 'search' | 'attention' | 'respond' | 'recoverContext'>;
  runtime: Pick<TerminalExecutions, 'has'>;
  workflows: Pick<WorkflowEngine, 'isSessionBusy'>;
  queue: ChatQueue;
  attachments: Pick<Attachments, 'validate' | 'add' | 'addNative' | 'addNativePastedImages' | 'list' | 'removeFile'>;
  structured(id: string): Session;
  assertUnlocked(session: Session): void;
  captureAdmission(id: string): () => void;
  requireCommands(id: string): void;
  reserve(id: string): Promise<void>;
  releaseAdmission(id: string): void | Promise<void>;
  manage<T>(id: string, action: () => T | Promise<T>): Promise<T>;
  runChat(id: string, text: string, attachments: string[], requestId?: string, nativeTaskId?: string): Promise<ChatTurnResult>;
  versionSnapshot(snapshot: ChatSnapshot): ChatSnapshot;
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
  requestId: shortId.optional(),
  nativeTaskId: shortId.optional(),
});
const droppedFilesSchema = z.object({
  id: idSchema,
  paths: attachmentPathsSchema,
}).strict();
const pastedImageEncodedLimit = 4 * Math.ceil(NATIVE_IMAGE_MAX_BYTES / 3);
const pastedImagesSchema = z.object({
  id: idSchema,
  images: z.array(z.object({
    mimeType: z.enum(['image/png', 'image/jpeg']),
    dataUrl: z.string().min(1).max(pastedImageEncodedLimit + 23),
  }).strict()).min(1).max(NATIVE_IMAGE_MAX_COUNT),
}).strict().refine(({ images }) =>
  // Bound IPC input before storage decodes and validates the actual combined bytes.
  // Each file adds a MIME prefix and may have its own base64 padding.
  images.reduce((total, image) => total + image.dataUrl.length, 0) <= pastedImageEncodedLimit + images.length * 27,
  '粘贴图片合计不能超过 1 MiB。');
const responseSchema = z.object({
  id: idSchema, requestId: shortId,
  decision: z.object({
    behavior: z.enum(['allow', 'deny']), message: z.string().max(10000).optional(),
    answers: z.record(z.string().max(2000), z.string().max(10000)).optional(),
  }),
});

export function registerChatHandlers(handle: Register, ports: ChatPorts): void {
  const draftAttachments = new DraftAttachments(ports.attachments);
  const assertCanStageAttachments = (id: string) => {
    const session = ports.structured(id);
    if (session.archived) throw new Error('请先取消会话归档，再添加附件。');
    ports.assertUnlocked(session);
    return session;
  };
  handle('chat:snapshot', idSchema, async id => {
    ports.structured(id);
    await ports.chat.hydrate(id);
    const snapshot = ports.chat.snapshot(id);
    return ports.versionSnapshot({ ...snapshot, queue: snapshot.queue ?? ports.queue.snapshot(id) });
  });
  handle('chat:commands', idSchema, async id => {
    const checkAdmission = ports.captureAdmission(id);
    const session = ports.structured(id);
    if (session.archived) throw new Error('请先取消会话归档。');
    ports.assertUnlocked(session);
    ports.requireCommands(id);
    if (ports.chat.has(id)) return ports.versionSnapshot({ ...ports.chat.snapshot(id), queue: ports.queue.snapshot(id) });
    if (ports.runtime.has(id) || ports.workflows.isSessionBusy(id)) throw new Error('请先结束当前会话任务。');
    await ports.reserve(id);
    try {
      checkAdmission();
      const snapshot = await ports.chat.prepareCommands(id);
      checkAdmission();
      return ports.versionSnapshot({ ...snapshot, queue: ports.queue.snapshot(id) });
    }
    finally { await ports.releaseAdmission(id); }
  });
  handle('chat:recover-context', idSchema, id => ports.manage(id, async () => {
    const session = ports.structured(id);
    if (session.archived) throw new Error('请先取消会话归档。');
    if (ports.runtime.has(id) || ports.workflows.isSessionBusy(id) || ports.queue.hasActive(id)) throw new Error('请先停止正在执行的任务。');
    await ports.chat.recoverContext(id);
  }));
  handle('chat:page', pageSchema, ({ id, ...options }) => {
    ports.structured(id);
    return ports.chat.page(id, options);
  });
  handle('chat:search', searchSchema, ({ id, query, before }) => {
    ports.structured(id);
    return ports.chat.search(id, query, before);
  });
  handle('chat:attention', z.undefined(), () => ports.chat.attention());
  handle('chat:send', sendSchema, async ({ id, text, attachments, requestId, nativeTaskId }) => {
    const session = ports.structured(id);
    if (nativeTaskId && session.execution.providerId !== 'native') throw new Error('只有自研 Agent 会话可以继续已有任务。');
    const checkAdmission = ports.captureAdmission(id);
    if (!text.trim() && !attachments?.length) throw new Error('请输入消息或选择附件。');
    if (ports.workflows.isSessionBusy(id)) throw new Error('工作流正在执行，请先取消后再手动发送。');
    const approved = await ports.attachments.validate(id, attachments);
    checkAdmission();
    if (ports.workflows.isSessionBusy(id)) throw new Error('工作流已开始，请先取消后再发送。');
    return ports.runChat(id, text, approved, requestId, nativeTaskId);
  });
  handle('chat:submit', sendSchema.extend({ requestId: shortId.optional() }), ({ id, text, attachments, requestId, nativeTaskId }) => {
    const session = ports.structured(id);
    if (nativeTaskId && session.execution.providerId !== 'native') throw new Error('只有自研 Agent 会话可以继续已有任务。');
    if (invokedCommand(text) && attachments?.length) throw new Error('执行斜杠命令时请先移除附件，再单独发送命令。');
    return ports.queue.submit(id, text, attachments, requestId, { nativeTaskId });
  });
  const queueMessage = z.object({ id: idSchema, messageId: z.string().uuid() });
  handle('chat:queue-now', queueMessage, ({ id, messageId }) => { ports.structured(id); return ports.queue.sendNow(id, messageId); });
  handle('chat:queue-remove', queueMessage, ({ id, messageId }) => { ports.structured(id); return ports.queue.remove(id, messageId); });
  handle('chat:queue-resume', idSchema, id => { ports.structured(id); return ports.queue.resume(id); });
  handle('chat:respond', responseSchema, ({ id, requestId, decision }) => {
    ports.structured(id);
    return ports.chat.respond(id, requestId, decision);
  });
  handle('files:pick', idSchema, async id => {
    const checkAdmission = ports.captureAdmission(id);
    const session = assertCanStageAttachments(id);
    const native = session.execution.providerId === 'native';
    const result = await dialog.showOpenDialog(ports.getWindow()!, {
      title: native ? '添加图片（最多 4 张，合计 1 MiB）' : '添加上下文附件', properties: ['openFile', 'multiSelections'],
      filters: native ? [{ name: 'PNG / JPEG 图片', extensions: ['png', 'jpg', 'jpeg'] }] : attachmentFilters,
    });
    if (result.canceled) return [];
    checkAdmission();
    // A native picker may outlive deletion, archiving or maintenance of its source session.
    const current = assertCanStageAttachments(id);
    return current.execution.providerId === 'native' ? ports.attachments.addNative(id, result.filePaths) : ports.attachments.add(id, result.filePaths);
  });
  handle('files:choose-draft', z.undefined(), async () => {
    const result = await dialog.showOpenDialog(ports.getWindow()!, {
      title: '添加上下文附件', properties: ['openFile', 'multiSelections'], filters: attachmentFilters,
    });
    if (result.canceled || !result.filePaths.length) return [];
    return draftAttachments.inspect(result.filePaths);
  });
  handle('files:add-dropped-draft', attachmentPathsSchema, paths => draftAttachments.inspect(paths));
  handle('files:preview-draft-native-image', draftAttachmentSelectionSchema, selection => draftAttachments.previewNative(selection));
  handle('files:stage-draft', z.object({ id: idSchema, files: draftAttachmentSelectionsSchema }).strict(), ({ id, files }) => {
    const checkAdmission = ports.captureAdmission(id);
    const session = assertCanStageAttachments(id);
    return draftAttachments.stage(id, files, () => {
      checkAdmission();
      assertCanStageAttachments(id);
    }, session.execution.providerId === 'native');
  });
  handle('files:add-dropped', droppedFilesSchema, ({ id, paths }) => {
    const session = assertCanStageAttachments(id);
    // Only stage private copies. Model execution and content interpretation stay
    // in the existing explicit send/queue flow, even while another turn is running.
    return session.execution.providerId === 'native' ? ports.attachments.addNative(id, paths) : ports.attachments.add(id, paths);
  });
  handle('files:add-pasted-native-images', pastedImagesSchema, ({ id, images }) => {
    const checkAdmission = ports.captureAdmission(id);
    const assertCanPaste = () => {
      checkAdmission();
      const session = assertCanStageAttachments(id);
      if (session.execution.providerId !== 'native' || session.execution.mode !== 'structured') {
        throw new Error('只有自研 Agent 会话支持粘贴图片。');
      }
    };
    assertCanPaste();
    // Storage repeats the admission check inside its serial operation so an import
    // queued before deletion, archiving or maintenance cannot recreate a draft.
    return ports.attachments.addNativePastedImages(id, images, assertCanPaste);
  });
  handle('files:attachments', idSchema, async id => {
    ports.structured(id);
    return (await ports.attachments.list(id)).filter(file => !ports.queue.references(id, file.path));
  });
  handle('files:remove-attachment', z.object({ id: idSchema, path: z.string().min(1).max(4096) }), ({ id, path }) => {
    ports.structured(id);
    return ports.queue.removeAttachment(id, path, () => ports.attachments.removeFile(id, path));
  });
}
