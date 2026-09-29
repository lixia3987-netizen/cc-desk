import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Attachment, DraftAttachment } from '../shared/types';
import { EXTENSIONS, MAX_ATTACHMENT_COUNT, MAX_FILE, MAX_TOTAL, type Attachments } from './attachments';

const attachmentPathSchema = z.string().min(1).max(4096).refine(
  value => path.isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value),
  '附件必须来自有效的本机绝对路径。',
);
export const attachmentPathsSchema = z.array(attachmentPathSchema)
  .min(1, '请选择或拖入本机文件。').max(MAX_ATTACHMENT_COUNT, '一次最多添加 8 个附件。');
// Names and sizes are only display hints. Staging uses the main-process record.
export const draftAttachmentSelectionsSchema = z.array(z.object({ selectionId: z.string().uuid(), path: attachmentPathSchema }))
  .min(1, '请选择或拖入本机文件。').max(MAX_ATTACHMENT_COUNT, '一次最多添加 8 个附件。');
export const MAX_DRAFT_ATTACHMENT_SELECTIONS = 256;

export const attachmentFilters = [{ name: '文本、图片与 PDF', extensions: [...EXTENSIONS].map(extension => extension.slice(1)) }];
interface Source {
  attachment: Attachment;
  realPath: string;
  modified: number;
  changed: number;
  inode: number;
  device: number;
}

/** Pre-session selection is memory-only metadata; copies belong to a real session. */
export class DraftAttachments {
  private selections = new Map<string, Source>();
  constructor(private attachments: Pick<Attachments, 'add' | 'removeFile'>) {}

  private async inspectSources(selected: string[]): Promise<Source[]> {
    attachmentPathsSchema.parse(selected);
    let total = 0;
    const sources: Source[] = [];
    for (const file of selected) {
      let realPath: string, stat: Awaited<ReturnType<typeof fs.stat>>;
      try { realPath = await fs.realpath(file); stat = await fs.stat(realPath); }
      catch { throw new Error(`附件“${path.basename(file)}”已被删除或无法读取，请重新选择。`); }
      if (!stat.isFile()) throw new Error('附件必须是文件，暂不支持添加文件夹。');
      if (!EXTENSIONS.has(path.extname(realPath).toLowerCase())) throw new Error('附件类型不受支持，请选择文本、图片或 PDF。');
      if (stat.size > MAX_FILE) throw new Error('单个附件不能超过 8 MiB。');
      total += stat.size;
      if (total > MAX_TOTAL) throw new Error('附件合计不能超过 16 MiB。');
      sources.push({ attachment: { path: file, name: path.basename(file), bytes: stat.size }, realPath,
        modified: stat.mtimeMs, changed: stat.ctimeMs, inode: stat.ino, device: stat.dev });
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
        || before.modified !== after.modified || before.changed !== after.changed
        || before.inode !== after.inode || before.device !== after.device) {
        throw new Error(`附件“${before.attachment.name}”在选择后已变更，请重新选择。`);
      }
    }
  }

  async stage(id: string, selected: Pick<DraftAttachment, 'selectionId' | 'path'>[], assertAllowed: () => void): Promise<Attachment[]> {
    const expected = draftAttachmentSelectionsSchema.parse(selected).map(file => {
      const source = this.selections.get(file.selectionId);
      if (!source) throw new Error(`附件“${path.basename(file.path)}”尚未选择或选择已失效，请重新选择。`);
      if (source.attachment.path !== file.path) throw new Error('附件路径与所选文件不一致，请重新选择。');
      return source;
    });
    await this.verify(expected);
    assertAllowed();
    let copies: Attachment[];
    try { copies = await this.attachments.add(id, expected.map(source => source.attachment.path)); }
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
