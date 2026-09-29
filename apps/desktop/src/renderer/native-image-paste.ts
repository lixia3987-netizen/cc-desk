import { NATIVE_IMAGE_MAX_BYTES, NATIVE_IMAGE_MAX_COUNT, type NativePastedImage } from '../shared/native-images';
import type { Attachment, Session } from '../shared/types';
import type { ExecutionDescriptor } from '../shared/execution';
import { executionUnavailable } from './EngineConfiguration';

/** Snapshot only files supplied by this paste event; text remains browser-owned. */
export function capturePastedFiles(transfer: Pick<DataTransfer, 'files'>, onFiles?: (files: File[]) => void): void {
  if (!onFiles) return;
  const files = Array.from(transfer.files);
  if (files.length) onFiles(files);
}

/** Shared with picker/drop imports: reserve synchronously, before reading bytes. */
export async function withAttachmentImport(pending: Set<string>, id: string, changed: (value: Set<string>) => void, action: () => Promise<void>): Promise<void> {
  if (pending.has(id)) return;
  pending.add(id); changed(new Set(pending));
  try { await action(); }
  finally { pending.delete(id); changed(new Set(pending)); }
}

export function nativePasteTargetAvailable(origin: Pick<Session, 'id' | 'execution'>, current: Session | undefined, engine: ExecutionDescriptor | undefined, busy: boolean): boolean {
  return !busy && origin.execution.providerId === 'native' && origin.execution.mode === 'structured'
    && !!current && current.id === origin.id && !current.archived
    && current.execution.providerId === 'native' && current.execution.mode === 'structured'
    && current.execution.conversationId === origin.execution.conversationId
    && engine?.providerId === 'native' && engine.mode === 'structured' && !!engine.capabilities.attachments
    && !executionUnavailable(engine, current);
}

export async function readNativePastedImages(files: readonly File[], existing: readonly Pick<Attachment, 'bytes'>[]): Promise<NativePastedImage[]> {
  if (!files.length) throw new Error('剪贴板中没有可添加的图片。');
  if (existing.length + files.length > NATIVE_IMAGE_MAX_COUNT) throw new Error('Native 待发送图片最多 4 张，请先移除部分图片。');
  let total = existing.reduce((sum, file) => sum + file.bytes, 0);
  // Validate the whole selection before calling any File.arrayBuffer().
  for (const file of files) {
    if (file.type !== 'image/png' && file.type !== 'image/jpeg') throw new Error('Native 粘贴图片仅支持 PNG / JPEG。');
    if (!Number.isSafeInteger(file.size) || file.size <= 0) throw new Error('剪贴板图片为空或无法读取，请重新复制图片。');
    total += file.size;
    if (total > NATIVE_IMAGE_MAX_BYTES) throw new Error('Native 待发送图片合计不能超过 1 MiB，请先缩小图片或移除部分图片。');
  }
  const images: NativePastedImage[] = [];
  for (const file of files) {
    let data: ArrayBuffer;
    try { data = await file.arrayBuffer(); }
    catch { throw new Error('读取剪贴板图片失败，请重新复制图片后再试。'); }
    if (data.byteLength !== file.size) throw new Error('剪贴板图片内容已变化，请重新复制图片。');
    const bytes = new Uint8Array(data);
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    const mimeType = file.type as NativePastedImage['mimeType'];
    images.push({ mimeType, dataUrl: `data:${mimeType};base64,${btoa(binary)}` });
  }
  return images;
}

export async function importNativePastedImages(files: readonly File[], existing: readonly Pick<Attachment, 'bytes'>[], available: () => boolean, stage: (images: NativePastedImage[]) => Promise<Attachment[]>): Promise<Attachment[]> {
  const check = () => { if (!available()) throw new Error('原会话已切换或当前无法添加图片，请返回可编辑的 Native 会话重新粘贴。'); };
  check();
  const images = await readNativePastedImages(files, existing);
  check();
  return stage(images);
}
