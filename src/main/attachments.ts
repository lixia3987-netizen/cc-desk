import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Attachment } from '../shared/types';

const MAX_FILE = 8 * 1024 * 1024;
const MAX_TOTAL = 16 * 1024 * 1024;
const EXTENSIONS = new Set(['.png','.jpg','.jpeg','.gif','.webp','.pdf','.txt','.md','.json','.csv','.ts','.tsx','.js','.py','.yaml','.yml','.html','.css','.xml','.log']);

/** Only native-picker selections can enter this per-session allowlist. */
export class Attachments {
  private allowed = new Map<string, Set<string>>();
  constructor(private directory: string) {}
  async add(id: string, selected: string[]): Promise<Attachment[]> {
    if (selected.length > 8) throw new Error('一次最多选择 8 个附件。');
    const result: Attachment[] = [];
    const folder = path.join(this.directory,'attachments',id);
    await fs.mkdir(folder,{recursive:true,mode:0o700});
    let total = 0;
    try {
      for (const file of selected) {
        const source = await fs.realpath(file);
        const stat = await fs.stat(source);
        const ext = path.extname(source).toLowerCase();
        if (!stat.isFile() || stat.size > MAX_FILE || !EXTENSIONS.has(ext)) throw new Error('附件须为支持的文本、图片或 PDF，单个不超过 8 MiB。');
        total += stat.size;
        if (total > MAX_TOTAL) throw new Error('附件合计不能超过 16 MiB。');
        const target = path.join(folder, randomUUID()+ext);
        await fs.copyFile(source,target); await fs.chmod(target,0o600);
        result.push({path:target,name:path.basename(file),bytes:stat.size});
      }
      const allowed = this.allowed.get(id) ?? new Set<string>();
      for (const item of result) allowed.add(item.path);
      this.allowed.set(id,allowed);
      return result;
    } catch (error) { await Promise.all(result.map(item=>fs.rm(item.path,{force:true}))); throw error; }
  }
  async validate(id: string, files: string[] = []): Promise<string[]> {
    if (files.length > 8) throw new Error('最多发送 8 个附件。');
    let size = 0;
    for (const file of files) {
      if (!this.allowed.get(id)?.has(file)) throw new Error('附件不属于当前会话，请重新选择。');
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE) throw new Error('附件已变更，请重新选择。');
      size += stat.size;
    }
    if (size > MAX_TOTAL) throw new Error('附件合计不能超过 16 MiB。');
    return files;
  }
  async remove(id: string) { this.allowed.delete(id); await fs.rm(path.join(this.directory,'attachments',id),{recursive:true,force:true}); }
}
