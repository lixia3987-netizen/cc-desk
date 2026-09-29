import path from 'node:path';
import { z } from 'zod';
import type { BeginRunRequest, UserImage } from '@cc-desk/agent-core';
import { NativeRunStore } from '@cc-desk/agent-node/run-store';
import { requireCompleteContext } from '@cc-desk/agent-node/context-maintenance';
import { isNativeImageAttachments } from '@cc-desk/contracts/chat';
import type { Session } from '../shared/types';
import type { NativeImagePreview, NativeImagePreviewRequest } from '../shared/native-images';
import { readNativeDraftImage, verifyNativeImageAttachments } from './native-image-attachments';

export const NATIVE_IMAGE_PREVIEW_INVALID = '图片预览请求无效，请重新选择图片。';
export const NATIVE_IMAGE_PREVIEW_UNAVAILABLE = '图片记录当前无法安全读取，或会话、附件已改变；请刷新后重试。';
export const NATIVE_IMAGE_PREVIEW_BUSY = '图片预览正在读取，请稍后重试。';
const invalid = () => new Error(NATIVE_IMAGE_PREVIEW_INVALID);
const unavailable = () => new Error(NATIVE_IMAGE_PREVIEW_UNAVAILABLE);
const requestSchema = z.object({
  sessionId: z.uuid(), conversationId: z.uuid(),
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('draft'), path: z.string().min(1).max(4096).refine(value => path.isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value)) }).strict(),
    z.object({ kind: z.literal('history'), runId: z.uuid(), index: z.number().int().min(0).max(3), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
  ]),
}).strict();

export interface NativeImagePreviewPorts {
  directory: string;
  session(id: string): Pick<Session, 'id' | 'kind' | 'execution'>;
  /** Returns a host-owned fence for maintenance, cancellation and lifecycle changes. */
  captureAdmission(id: string): () => void;
  queueReferences(id: string, file: string): boolean;
  readDraft?: typeof readNativeDraftImage;
  readSubmission?: typeof NativeRunStore.readSubmission;
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

function historicalImage(request: NativeImagePreviewRequest, submission: BeginRunRequest | undefined): NativeImagePreview {
  if (request.source.kind !== 'history' || !submission || submission.identity.sessionId !== request.sessionId ||
      submission.identity.conversationId !== request.conversationId || submission.identity.runId !== request.source.runId) throw unavailable();
  requireCompleteContext({ protocol: submission.protocol, items: submission.userItems });
  const chat = submission.protocol.id === 'openai-chat-completions';
  if (submission.protocol.version !== 1 || !chat && submission.protocol.id !== 'openai-responses') throw unavailable();
  const images: UserImage[] = [];
  for (const item of submission.userItems) {
    // Only user-origin image parts are eligible, never assistant/tool output.
    if (!object(item) || item.role !== 'user') throw unavailable();
    if (!Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (!object(part) || part.type !== (chat ? 'image_url' : 'input_image')) continue;
      const url = chat && object(part.image_url) ? part.image_url.url : part.image_url;
      if (typeof url !== 'string') throw unavailable();
      const mimeType = url.startsWith('data:image/png;base64,') ? 'image/png' : url.startsWith('data:image/jpeg;base64,') ? 'image/jpeg' : undefined;
      if (!mimeType) throw unavailable();
      images.push({ mimeType, dataUrl: url });
    }
  }
  const metadata: unknown = submission.configuration.imageAttachments;
  if (!isNativeImageAttachments(metadata)) throw unavailable();
  verifyNativeImageAttachments(images, metadata);
  // Verification above validates the metadata shape as well as all image bytes,
  // rather than trusting just the requested position in a partially bad record.
  const image = metadata[request.source.index];
  const selected = images[request.source.index];
  if (!image || !selected || image.sha256 !== request.source.sha256) throw unavailable();
  return { image: { ...image }, dataUrl: selected.dataUrl };
}

/** Explicit bounded local reads; this host holds no cached bytes or writer handles. */
export class NativeImagePreviewHost {
  private pending = new Set<string>();
  constructor(private ports: NativeImagePreviewPorts) {}
  async preview(value: unknown): Promise<NativeImagePreview> {
    const parsed = requestSchema.safeParse(value);
    if (!parsed.success) throw invalid();
    const request = parsed.data;
    if (this.pending.size >= 2 || this.pending.has(request.sessionId)) throw new Error(NATIVE_IMAGE_PREVIEW_BUSY);
    this.pending.add(request.sessionId);
    try {
      const assertSession = () => {
        const session = this.ports.session(request.sessionId);
        if (session.id !== request.sessionId || session.kind !== 'agent' || session.execution.providerId !== 'native' ||
            session.execution.mode !== 'structured' || session.execution.conversationId !== request.conversationId) throw unavailable();
        if (request.source.kind === 'draft' && this.ports.queueReferences(request.sessionId, request.source.path)) throw unavailable();
      };
      assertSession();
      const checkAdmission = this.ports.captureAdmission(request.sessionId);
      checkAdmission(); assertSession();
      let preview: NativeImagePreview;
      if (request.source.kind === 'draft') {
        preview = await (this.ports.readDraft ?? readNativeDraftImage)(this.ports.directory, request.sessionId, request.source.path);
        checkAdmission(); assertSession();
        verifyNativeImageAttachments([{ mimeType: preview.image.mimeType, dataUrl: preview.dataUrl }], [preview.image]);
      } else {
        const submission = await (this.ports.readSubmission ?? NativeRunStore.readSubmission)({
          rootDirectory: path.join(this.ports.directory, 'native', 'conversations'), conversationId: request.conversationId,
        }, request.source.runId);
        checkAdmission(); assertSession();
        preview = historicalImage(request, submission);
      }
      checkAdmission(); assertSession();
      return { image: { ...preview.image }, dataUrl: preview.dataUrl };
    } catch { throw unavailable(); }
    finally { this.pending.delete(request.sessionId); }
  }
}
