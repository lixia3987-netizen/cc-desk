import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { IMPORTED_FONT_ID, MAX_FONT_BYTES, MAX_IMPORTED_FONTS, type ImportedFont } from '../shared/fonts';

const entrySchema = z.object({ id: z.string().regex(IMPORTED_FONT_ID), name: z.string().min(1).max(100), format: z.enum(['ttf', 'otf', 'woff', 'woff2']), bytes: z.number().int().positive().max(MAX_FONT_BYTES) });
const catalogSchema = z.array(entrySchema).max(MAX_IMPORTED_FONTS).refine(fonts => new Set(fonts.map(font => font.id)).size === fonts.length);
const digest = (data: Buffer) => 'imported:' + createHash('sha256').update(data).digest('hex');

/** Bound the container before the renderer's FontFace/OTS validates glyph data. */
export function validateFont(data: Buffer, extension: string): ImportedFont['format'] {
  if (data.length < 12 || data.length > MAX_FONT_BYTES) throw new Error('字体文件为空、已损坏或超过 20 MiB。');
  const signature = data.toString('ascii', 0, 4);
  const format = data.readUInt32BE(0) === 0x00010000 ? 'ttf' : signature === 'OTTO' ? 'otf' : signature === 'wOFF' ? 'woff' : signature === 'wOF2' ? 'woff2' : undefined;
  if (!format || extension.toLowerCase() !== '.' + format) throw new Error('请选择有效的 TTF、OTF、WOFF 或 WOFF2 字体；文件扩展名须与格式一致。');
  if (format === 'ttf' || format === 'otf') {
    const count = data.readUInt16BE(4);
    if (!count || count > 256 || 12 + count * 16 > data.length) throw new Error('字体表目录已损坏。');
    for (let i = 0; i < count; i++) {
      const start = data.readUInt32BE(12 + i * 16 + 8), length = data.readUInt32BE(12 + i * 16 + 12);
      if (start > data.length || length > data.length - start) throw new Error('字体数据不完整。');
    }
  } else {
    const header = format === 'woff' ? 44 : 48;
    if (data.length < header || data.readUInt32BE(8) !== data.length || !data.readUInt16BE(12) || data.readUInt16BE(12) > 256 || data.readUInt16BE(14) !== 0 || data.readUInt32BE(16) > 80 * 1024 * 1024) throw new Error('压缩字体头无效或解压后过大。');
    if (format === 'woff') {
      const count = data.readUInt16BE(12);
      if (44 + count * 20 > data.length) throw new Error('字体表目录已损坏。');
      for (let i = 0; i < count; i++) {
        const start = data.readUInt32BE(44 + i * 20 + 4), length = data.readUInt32BE(44 + i * 20 + 8);
        if (start > data.length || length > data.length - start) throw new Error('字体数据不完整。');
      }
    } else if (data.readUInt32BE(20) > data.length - header) throw new Error('压缩字体数据不完整。');
  }
  return format;
}

/** The renderer receives IDs and bytes, never an arbitrary filesystem reader. */
export class FontLibrary {
  readonly directory: string;
  constructor(dataDirectory: string) { this.directory = path.join(dataDirectory, 'fonts'); }
  private ensureDirectory() {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('字体库目录必须是本机普通目录。');
  }
  private boundedRead(file: string, maxBytes: number, noLinks = true): Buffer {
    if (noLinks && fs.lstatSync(file).isSymbolicLink()) throw new Error('字体库文件不能是符号链接。');
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (noLinks ? fs.constants.O_NOFOLLOW ?? 0 : 0));
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes) throw new Error('文件无效或超过大小限制（字体最多 20 MiB）。');
      const bytes = Buffer.alloc(stat.size + 1);
      let count = 0, read = 0;
      do { read = fs.readSync(fd, bytes, count, bytes.length - count, null); count += read; } while (read && count < bytes.length);
      if (count !== stat.size) throw new Error('读取时字体文件发生变化，请重试。');
      return bytes.subarray(0, count);
    } finally { fs.closeSync(fd); }
  }
  list(): ImportedFont[] {
    this.ensureDirectory();
    const file = path.join(this.directory, 'catalog.json');
    if (!fs.existsSync(file)) return [];
    try { return catalogSchema.parse(JSON.parse(this.boundedRead(file, 64 * 1024).toString('utf8'))) as ImportedFont[]; }
    catch { throw new Error('字体库索引无法读取，原文件已保留。请检查应用数据目录中的 fonts/catalog.json。'); }
  }
  private file(font: ImportedFont) { return path.join(this.directory, font.id.slice(9) + '.' + font.format); }
  private save(fonts: ImportedFont[]) {
    const temporary = path.join(this.directory, 'catalog-' + randomUUID() + '.tmp');
    try {
      const fd = fs.openSync(temporary, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(fonts, null, 2)); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      fs.renameSync(temporary, path.join(this.directory, 'catalog.json'));
    }
    finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
  importFile(source: string): ImportedFont {
    if (!path.isAbsolute(source)) throw new Error('请选择本机字体文件。');
    const bytes = this.boundedRead(source, MAX_FONT_BYTES, false);
    const format = validateFont(bytes, path.extname(source));
    const fonts = this.list(), id = digest(bytes) as ImportedFont['id'];
    const existing = fonts.find(font => font.id === id);
    if (existing) { this.read(id); return existing; }
    if (fonts.length >= MAX_IMPORTED_FONTS) throw new Error('最多保存 24 个导入字体，请先移除不用的字体。');
    const name = path.basename(source, path.extname(source)).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 100) || '导入字体';
    const font: ImportedFont = { id, name, format, bytes: bytes.length }, file = this.file(font);
    let created = false;
    if (fs.existsSync(file)) {
      if (digest(this.boundedRead(file, MAX_FONT_BYTES)) !== id) throw new Error('已有字体副本损坏，请检查字体库。');
    } else { fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 }); created = true; }
    try { this.save([...fonts, font]); }
    catch (error) { if (created) fs.unlinkSync(file); throw error; }
    return font;
  }
  read(id: string): Uint8Array {
    if (!IMPORTED_FONT_ID.test(id)) throw new Error('无效的字体标识。');
    const font = this.list().find(font => font.id === id);
    if (!font) throw new Error('导入字体不存在，请重新导入或选择系统默认。');
    const bytes = this.boundedRead(this.file(font), MAX_FONT_BYTES);
    if (digest(bytes) !== id || bytes.length !== font.bytes) throw new Error('字体副本已损坏，请移除后重新导入。');
    validateFont(bytes, '.' + font.format);
    return new Uint8Array(bytes);
  }
  remove(id: string) {
    const fonts = this.list(), font = fonts.find(font => font.id === id);
    if (!font) return;
    this.save(fonts.filter(font => font.id !== id));
    // Only delete our named copy; never touch the user's original file.
    const file = this.file(font);
    if (fs.lstatSync(file, { throwIfNoEntry: false })) fs.unlinkSync(file);
  }
}
