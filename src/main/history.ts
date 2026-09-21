import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { HistoryEntry } from '../shared/types';
const uuidFile = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;
export const claudeProjects = () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');

export async function transcriptExists(id: string): Promise<boolean> {
  try {
    const folders = await fs.readdir(claudeProjects(), { withFileTypes: true });
    for (const folder of folders) {
      if (!folder.isDirectory()) continue;
      try { await fs.access(path.join(claudeProjects(), folder.name, `${id}.jsonl`)); return true; } catch { /* Next folder. */ }
    }
  } catch { /* No Claude transcripts yet. */ }
  return false;
}

function samePath(a: string, b: string): boolean {
  const normalize = (s: string) => process.platform === 'win32' ? path.resolve(s).toLowerCase() : path.resolve(s);
  return normalize(a) === normalize(b);
}

export async function readHistory(cwd: string): Promise<HistoryEntry[]> {
  let folders;
  try { folders = await fs.readdir(claudeProjects(), { withFileTypes: true }); } catch { return []; }
  const files: { file: string; id: string; modified: number }[] = [];
  for (const folder of folders.filter(f => f.isDirectory()).slice(0, 300)) {
    const directory = path.join(claudeProjects(), folder.name);
    for (const name of (await fs.readdir(directory)).filter(n => uuidFile.test(n)).slice(-1000)) {
      const file = path.join(directory, name);
      const info = await fs.lstat(file);
      if (info.isFile()) files.push({ file, id: name.slice(0,-6), modified: info.mtimeMs });
    }
  }
  const result: HistoryEntry[] = [];
  for (const entry of files.sort((a,b) => b.modified - a.modified).slice(0, 500)) {
    const handle = await fs.open(entry.file, 'r');
    let text: string;
    try {
      const buffer = Buffer.alloc(128 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      text = buffer.subarray(0,bytesRead).toString('utf8');
    } finally { await handle.close(); }
    let project = ''; let title = ''; let summary = '';
    for (const line of text.split('\n')) {
      try {
        const record = JSON.parse(line);
        if (typeof record.cwd === 'string') project = record.cwd;
        if (typeof record.summary === 'string') summary = record.summary;
        if (!title && record.type === 'user') {
          const content = record.message?.content;
          if (typeof content === 'string') title = content;
          else if (Array.isArray(content)) title = content.find(x => x.type === 'text')?.text ?? '';
        }
      } catch { /* Partial final line or an unfamiliar Claude record. */ }
    }
    if (project && samePath(project, cwd)) result.push({ id: entry.id, cwd: project, title: (summary || title || entry.id).replace(/[\r\n]+/g,' ').slice(0,100), modifiedAt: new Date(entry.modified).toISOString() });
    if (result.length >= 100) break;
  }
  return result;
}
