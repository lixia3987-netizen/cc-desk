import { isNativeImageAttachments, type NativeImageAttachment } from '@cc-desk/contracts/chat';
import type { NativeImagePreview, NativeImagePreviewRequest } from '../shared/native-images';
import type { Attachment } from '../shared/types';

export interface NativeImagePreviewSelection {
  request: NativeImagePreviewRequest;
  expected: Pick<NativeImageAttachment, 'name' | 'bytes'> & Partial<Pick<NativeImageAttachment, 'mimeType' | 'sha256'>>;
}
export type NativeImagePreviewState = { status: 'idle' } | {
  status: 'loading'; selection: NativeImagePreviewSelection; version: number;
} | {
  status: 'ready'; selection: NativeImagePreviewSelection; version: number; preview: NativeImagePreview;
} | {
  status: 'error'; selection: NativeImagePreviewSelection; version: number; message: string;
};

export const nativeImagePreviewKey = ({ request, expected }: NativeImagePreviewSelection) => JSON.stringify([
  request.sessionId, request.conversationId, request.source, expected.name, expected.bytes, expected.mimeType, expected.sha256,
]);

/** A removed or queued draft can no longer keep its private bytes on screen. */
export function isNativeImagePreviewCurrent(selection: NativeImagePreviewSelection, sessionId: string, conversationId: string | undefined, attachments: readonly Attachment[]) {
  if (selection.request.sessionId !== sessionId || selection.request.conversationId !== conversationId) return false;
  const source = selection.request.source;
  return source.kind === 'history' || attachments.some(file => file.path === source.path && file.name === selection.expected.name && file.bytes === selection.expected.bytes);
}

const invalid = () => new Error('图片预览数据无效，请重试或重新选择图片。');
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Only bounded image bytes from the local preview IPC can become an image source. */
export async function validateNativeImagePreview(value: unknown, selection: NativeImagePreviewSelection): Promise<NativeImagePreview> {
  if (selection.request.source.kind === 'history' && selection.expected.sha256 !== undefined && selection.expected.sha256 !== selection.request.source.sha256) throw invalid();
  return validateNativeImagePreviewReceipt(value, { ...selection.expected, ...(selection.request.source.kind === 'history' ? { sha256: selection.request.source.sha256 } : {}) });
}

export async function validateNativeImagePreviewReceipt(value: unknown, expected: NativeImagePreviewSelection['expected']): Promise<NativeImagePreview> {
  if (!object(value) || Object.keys(value).some(key => !['image', 'dataUrl'].includes(key))
    || !isNativeImageAttachments([value.image]) || typeof value.dataUrl !== 'string') throw invalid();
  const image = value.image as unknown as NativeImageAttachment;
  if (image.name !== expected.name || image.bytes !== expected.bytes
    || expected.mimeType !== undefined && image.mimeType !== expected.mimeType
    || expected.sha256 !== undefined && image.sha256 !== expected.sha256) throw invalid();
  const prefix = `data:${image.mimeType};base64,`;
  if (!value.dataUrl.startsWith(prefix) || value.dataUrl.length > prefix.length + 4 * Math.ceil(1024 * 1024 / 3)) throw invalid();
  const encoded = value.dataUrl.slice(prefix.length);
  if (!encoded || encoded.length !== 4 * Math.ceil(image.bytes / 3) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw invalid();
  let decoded: string;
  try { decoded = atob(encoded); } catch { throw invalid(); }
  if (decoded.length !== image.bytes || btoa(decoded) !== encoded) throw invalid();
  const bytes = Uint8Array.from(decoded, character => character.charCodeAt(0));
  const signature = image.mimeType === 'image/png' ? [137, 80, 78, 71, 13, 10, 26, 10] : [255, 216, 255];
  if (!signature.every((byte, index) => bytes[index] === byte)) throw invalid();
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  if (Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('') !== image.sha256) throw invalid();
  return { image: { ...image }, dataUrl: value.dataUrl };
}

/** One explicit viewer. Every close, source change or retry invalidates late promises. */
export class NativeImagePreviewController {
  private generation = 0;
  private value: NativeImagePreviewState = { status: 'idle' };
  constructor(private load: (request: NativeImagePreviewRequest) => Promise<unknown>, private changed: (state: NativeImagePreviewState) => void) {}
  get state(): NativeImagePreviewState { return this.value; }
  private publish(state: NativeImagePreviewState) { this.value = state; this.changed(state); }
  async open(selection: NativeImagePreviewSelection): Promise<void> {
    const version = ++this.generation, owned = structuredClone(selection);
    this.publish({ status: 'loading', selection: owned, version });
    try {
      const result = await this.load(structuredClone(owned.request));
      if (version !== this.generation) return;
      const preview = await validateNativeImagePreview(result, owned);
      if (version === this.generation) this.publish({ status: 'ready', selection: owned, version, preview });
    } catch {
      if (version === this.generation) this.publish({ status: 'error', selection: owned, version, message: owned.request.source.kind === 'draft'
        ? '无法读取这张图片，请重试；图片已发送或移除时需重新选择。' : '无法读取发送时的图片，请重试或核查本机会话记录。' });
    }
  }
  retry(): Promise<void> {
    return this.value.status === 'error' ? this.open(this.value.selection) : Promise.resolve();
  }
  decodeFailed(version: number) {
    if (this.value.status !== 'ready' || this.value.version !== version) return;
    const { selection } = this.value;
    this.publish({ status: 'error', selection, version, message: '图片无法显示，请重试或重新选择图片。' });
  }
  close(notify = true) {
    ++this.generation;
    this.value = { status: 'idle' };
    if (notify) this.changed(this.value);
  }
}

/** React StrictMode replays effects before microtasks; only the live setup starts IPC. */
export function scheduleNativeImagePreview(controller: NativeImagePreviewController, selection: NativeImagePreviewSelection): () => void {
  let cancelled = false;
  const owned = structuredClone(selection);
  queueMicrotask(() => { if (!cancelled) void controller.open(owned); });
  return () => { cancelled = true; controller.close(false); };
}
