import { NATIVE_IMAGE_MAX_BYTES } from '../../shared/native-images';
import type { DraftAttachment } from '../../shared/types';
import { validateNativeImagePreviewReceipt } from '../native-image-preview-state';
import type { NativeImagePreviewVisualState } from '../NativeImagePreview';
import { isPastedDraftAttachment, type NativePastedDraftAttachment, type NewSessionAttachment } from './new-session-submission';

export interface NewSessionImagePreviewSelection { owner: string; file: NewSessionAttachment }
export type NewSessionImagePreviewState = { status: 'idle' } | (NativeImagePreviewVisualState & { selection: NewSessionImagePreviewSelection });
export const newSessionImagePreviewKey = (selection: NewSessionImagePreviewSelection) => JSON.stringify([
  selection.owner, selection.file.selectionId, selection.file.path, selection.file.name, selection.file.bytes,
]);
export function isNewSessionImagePreviewCurrent(selection: NewSessionImagePreviewSelection, owner: string, providerId: string | undefined, files: readonly NewSessionAttachment[]): boolean {
  return providerId === 'native' && selection.owner === owner && files.some(file => file.selectionId === selection.file.selectionId
    && file.path === selection.file.path && file.name === selection.file.name && file.bytes === selection.file.bytes
    && (!isPastedDraftAttachment(selection.file) ? !isPastedDraftAttachment(file)
      : isPastedDraftAttachment(file) && file.image.mimeType === selection.file.image.mimeType && file.image.dataUrl === selection.file.image.dataUrl));
}

/** Memory-only paste data is not a saved receipt. Check its bounds before decoding pixels. */
export function validateUnsavedPastedImage(file: NativePastedDraftAttachment): string {
  const fail = () => { throw new Error('图片预览数据无效，请重新粘贴图片。'); };
  const { mimeType, dataUrl } = file.image;
  if (!Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > NATIVE_IMAGE_MAX_BYTES || !['image/png', 'image/jpeg'].includes(mimeType)) return fail();
  const prefix = `data:${mimeType};base64,`;
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith(prefix) || dataUrl.length !== prefix.length + 4 * Math.ceil(file.bytes / 3)) return fail();
  const encoded = dataUrl.slice(prefix.length);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return fail();
  const decoded = atob(encoded);
  if (decoded.length !== file.bytes || btoa(decoded) !== encoded) return fail();
  const bytes = Uint8Array.from(decoded, character => character.charCodeAt(0)), view = new DataView(bytes.buffer);
  const dimensions = (width: number, height: number) => { if (width < 1 || height < 1 || width > 4096 || height > 4096) fail(); };
  if (mimeType === 'image/png') {
    if (bytes.length < 33 || ![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)
      || view.getUint32(8) !== 13 || String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR') return fail();
    dimensions(view.getUint32(16), view.getUint32(20));
  } else {
    if (bytes.length < 20 || bytes[0] !== 255 || bytes[1] !== 216) return fail();
    let offset = 2, frame = false;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 255) return fail();
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (offset + 2 > bytes.length) return fail();
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) return fail();
      if ([192, 193, 194].includes(marker)) {
        if (frame || length < 11 || bytes[offset + 2] !== 8) return fail();
        dimensions(view.getUint16(offset + 5), view.getUint16(offset + 3)); frame = true;
      } else if (marker >= 192 && marker <= 207 && ![196, 200, 204].includes(marker)) return fail();
      if (marker === 218) { if (!frame) return fail(); break; }
      offset += length;
    }
    if (!frame) return fail();
  }
  return dataUrl;
}

/** One explicit, unsaved selection; closing or superseding it discards late bytes. */
export class NewSessionImagePreviewController {
  private generation = 0;
  private value: NewSessionImagePreviewState = { status: 'idle' };
  constructor(private load: (selection: Pick<DraftAttachment, 'selectionId' | 'path'>) => Promise<unknown>, private changed: (state: NewSessionImagePreviewState) => void) {}
  get state() { return this.value; }
  private publish(value: NewSessionImagePreviewState) { this.value = value; this.changed(value); }
  async open(selection: NewSessionImagePreviewSelection) {
    const owned = structuredClone(selection), version = ++this.generation;
    this.publish({ status: 'loading', selection: owned, version });
    try {
      const file = owned.file;
      let dataUrl: string;
      if (isPastedDraftAttachment(file)) dataUrl = validateUnsavedPastedImage(file);
      else {
        const value = await this.load({ selectionId: file.selectionId, path: file.path });
        if (version !== this.generation) return;
        dataUrl = (await validateNativeImagePreviewReceipt(value, { name: file.name, bytes: file.bytes })).dataUrl;
      }
      if (version === this.generation) this.publish({ status: 'ready', selection: owned, version, dataUrl });
    } catch {
      if (version === this.generation) this.publish({ status: 'error', selection: owned, version, message: '无法预览当前选择的图片，请重试或重新选择；文件可能已变化。' });
    }
  }
  retry() { return this.value.status === 'error' ? this.open(this.value.selection) : Promise.resolve(); }
  decodeFailed(version: number) {
    if (this.value.status !== 'ready' || this.value.version !== version) return;
    this.publish({ status: 'error', selection: this.value.selection, version, message: '图片无法显示，请重新选择或粘贴图片。' });
  }
  close(notify = true) { this.generation++; this.value = { status: 'idle' }; if (notify) this.changed(this.value); }
}

export function scheduleNewSessionImagePreview(controller: NewSessionImagePreviewController, selection: NewSessionImagePreviewSelection) {
  let cancelled = false;
  const owned = structuredClone(selection);
  queueMicrotask(() => { if (!cancelled) void controller.open(owned); });
  return () => { cancelled = true; controller.close(false); };
}
