import fs from 'node:fs/promises';
import { constants, type BigIntStats } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Attachment, DraftAttachment } from '../shared/types';
import { NATIVE_IMAGE_MAX_BYTES, type NativeImagePreview } from '../shared/native-images';
import { validateNativeImageBytes } from './native-image-attachments';
import { EXTENSIONS, MAX_ATTACHMENT_COUNT, MAX_FILE, MAX_TOTAL, type Attachments } from './attachments';

const attachmentPathSchema = z.string().min(1).max(4096).refine(
  value => path.isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value),
  '附件必须来自有效的本机绝对路径。',
);
export const attachmentPathsSchema = z.array(attachmentPathSchema)
  .min(1, '请选择或拖入本机文件。').max(MAX_ATTACHMENT_COUNT, '一次最多添加 8 个附件。');
// Names and sizes are only display hints. Staging uses the main-process record.
export const draftAttachmentSelectionSchema = z.object({ selectionId: z.string().uuid(), path: attachmentPathSchema }).strict();
export const draftAttachmentSelectionsSchema = z.array(draftAttachmentSelectionSchema.strip())
  .min(1, '请选择或拖入本机文件。').max(MAX_ATTACHMENT_COUNT, '一次最多添加 8 个附件。');
export const MAX_DRAFT_ATTACHMENT_SELECTIONS = 256;

export const attachmentFilters = [{ name: '文本、图片与 PDF', extensions: [...EXTENSIONS].map(extension => extension.slice(1)) }];
interface Source {
  attachment: Attachment;
  realPath: string;
  stat: BigIntStats;
}

function sameFile(before: BigIntStats, after: BigIntStats): boolean {
  return after.isFile() && before.dev === after.dev && before.ino === after.ino && before.mode === after.mode
    && before.size === after.size && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs;
}

/** Pre-session selection is memory-only metadata; copies belong to a real session. */
export class DraftAttachments {
  private selections = new Map<string, Source>();
  private previews = new Set<string>();
  constructor(private attachments: Pick<Attachments, 'add' | 'addNative' | 'removeFile'>) {}

  private async inspectSources(selected: string[]): Promise<Source[]> {
    attachmentPathsSchema.parse(selected);
    let total = 0;
    const sources: Source[] = [];
    for (const file of selected) {
      let realPath: string, stat: BigIntStats;
      try { realPath = await fs.realpath(file); stat = await fs.stat(realPath, { bigint: true }); }
      catch { throw new Error(`附件“${path.basename(file)}”已被删除或无法读取，请重新选择。`); }
      if (!stat.isFile()) throw new Error('附件必须是文件，暂不支持添加文件夹。');
      if (!EXTENSIONS.has(path.extname(realPath).toLowerCase())) throw new Error('附件类型不受支持，请选择文本、图片或 PDF。');
      if (stat.size > BigInt(MAX_FILE)) throw new Error('单个附件不能超过 8 MiB。');
      total += Number(stat.size);
      if (total > MAX_TOTAL) throw new Error('附件合计不能超过 16 MiB。');
      sources.push({ attachment: { path: file, name: path.basename(file), bytes: Number(stat.size) }, realPath, stat });
    }
    return sources;
  }

  async inspect(selected: string[]): Promise<DraftAttachment[]> {
    const sources = await this.inspectSources(selected);
    const result = sources.map(source => {
      const selectionId = randomUUID();
      this.selections.set(selectionId, source);
      return { ...source.attachment, selectionId };
    });
    // Abandoned forms must not retain an unbounded list of local paths.
    while (this.selections.size > MAX_DRAFT_ATTACHMENT_SELECTIONS) this.selections.delete(this.selections.keys().next().value!);
    return result;
  }

  private async verify(expected: Source[]): Promise<void> {
    const current = await this.inspectSources(expected.map(source => source.attachment.path));
    for (let index = 0; index < expected.length; index++) {
      const before = expected[index], after = current[index];
      if (before.realPath !== after.realPath || before.attachment.bytes !== after.attachment.bytes
        || !sameFile(before.stat, after.stat)) {
        throw new Error(`附件“${before.attachment.name}”在选择后已变更，请重新选择。`);
      }
    }
  }

  /** Explicit selected-file view, with no session, staging, manifest or model operation. */
  async previewNative(selection: Pick<DraftAttachment, 'selectionId' | 'path'>): Promise<NativeImagePreview> {
    const selected = draftAttachmentSelectionSchema.parse(selection);
    const source = this.selections.get(selected.selectionId);
    const unavailable = () => new Error('Native 图片预览不可用，所选文件已失效或发生变更，请重新选择。');
    const assertSelection = () => {
      if (!source || this.selections.get(selected.selectionId) !== source || source.attachment.path !== selected.path) throw unavailable();
    };
    assertSelection();
    if (!source) throw unavailable();
    const extension = path.extname(source.realPath).toLowerCase(), nameExtension = path.extname(source.attachment.name).toLowerCase();
    if (!['.png', '.jpg', '.jpeg'].includes(extension) || !['.png', '.jpg', '.jpeg'].includes(nameExtension)
      || (extension === '.png') !== (nameExtension === '.png') || source.attachment.bytes < 1 || source.attachment.bytes > NATIVE_IMAGE_MAX_BYTES) throw unavailable();
    if (this.previews.has(selected.selectionId) || this.previews.size >= 2) throw new Error('图片预览正在读取，请稍后重试。');
    this.previews.add(selected.selectionId);
    try {
      await this.verify([source]);
      assertSelection();
      const before = await fs.lstat(source.realPath, { bigint: true });
      if (!sameFile(source.stat, before)) throw unavailable();
      const handle = await fs.open(source.realPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      let bytes: Buffer;
      try {
        if (!sameFile(source.stat, await handle.stat({ bigint: true }))) throw unavailable();
        // One extra byte detects a growing source without allocating from a new size.
        const buffer = Buffer.alloc(source.attachment.bytes + 1);
        let length = 0;
        while (length < buffer.length) {
          const read = await handle.read(buffer, length, buffer.length - length, length);
          if (!read.bytesRead) break;
          length += read.bytesRead;
        }
        if (length !== source.attachment.bytes || !sameFile(source.stat, await handle.stat({ bigint: true }))
          || !sameFile(source.stat, await fs.lstat(source.realPath, { bigint: true }))) throw unavailable();
        bytes = buffer.subarray(0, length);
      } finally { await handle.close(); }
      await this.verify([source]);
      assertSelection();
      const mimeType = extension === '.png' ? 'image/png' : 'image/jpeg';
      validateNativeImageBytes(bytes, mimeType);
      return { image: { name: source.attachment.name, mimeType, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
        dataUrl: `data:${mimeType};base64,${bytes.toString('base64')}` };
    } catch { throw unavailable(); }
    finally { this.previews.delete(selected.selectionId); }
  }

  async stage(id: string, selected: Pick<DraftAttachment, 'selectionId' | 'path'>[], assertAllowed: () => void, native = false): Promise<Attachment[]> {
    const expected = draftAttachmentSelectionsSchema.parse(selected).map(file => {
      const source = this.selections.get(file.selectionId);
      if (!source) throw new Error(`附件“${path.basename(file.path)}”尚未选择或选择已失效，请重新选择。`);
      if (source.attachment.path !== file.path) throw new Error('附件路径与所选文件不一致，请重新选择。');
      return source;
    });
    await this.verify(expected);
    assertAllowed();
    let copies: Attachment[];
    try { copies = await (native ? this.attachments.addNative(id, expected.map(source => source.attachment.path)) : this.attachments.add(id, expected.map(source => source.attachment.path))); }
    catch (error) {
      // Translate source races into actionable selection errors. Attachments.add
      // already rolls back partial copies before rejecting.
      await this.verify(expected);
      throw error;
    }
    try {
      await this.verify(expected);
      assertAllowed();
      return copies;
    } catch (error) {
      await Promise.all(copies.map(file => this.attachments.removeFile(id, file.path)));
      throw error;
    }
  }
}
