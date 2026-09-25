import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream/promises';
export interface HistoryEntry { id: string; title: string; cwd: string; modifiedAt: string }

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INDEX_LIMIT = 2048;
export const claudeProjects = () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
interface TranscriptFile { file: string; id: string; modified: number; size: number }
interface IndexedTranscript { signature: string; entry: HistoryEntry | null }
// Cache metadata only: conversation bodies and credentials never enter a persistent index.
const metadata = new Map<string, IndexedTranscript>();
const queries = new Map<string, { signature:string; entries:HistoryEntry[] }>();
const QUERY_ENTRY_LIMIT = 20000;
let parsedFiles = 0;
/** Read-only counters for profiling the metadata cache; no transcript contents. */
export function historyCacheStats() { return { parsedFiles, metadataEntries:metadata.size, queryEntries:[...queries.values()].reduce((sum,item)=>sum+item.entries.length,0) }; }

function normalizedPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function canonicalPath(value: string): Promise<string> {
  try { return normalizedPath(await fs.realpath(value)); } catch { return normalizedPath(value); }
}

async function transcriptFiles(id?: string): Promise<TranscriptFile[]> {
  const root = claudeProjects();
  let folders;
  try { folders = await fs.readdir(root, { withFileTypes: true }); } catch { return []; }
  const files: TranscriptFile[] = [];
  for (const folder of folders) {
    if (!folder.isDirectory()) continue;
    const directory = path.join(root, folder.name);
    let names: string[];
    try { names = id ? [id + '.jsonl'] : await fs.readdir(directory); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith('.jsonl') || !uuid.test(name.slice(0, -6))) continue;
      const file = path.join(directory, name);
      try {
        const info = await fs.lstat(file);
        if (info.isFile()) files.push({ file, id: name.slice(0, -6), modified: info.mtimeMs, size: info.size });
      } catch { /* A transcript may disappear during a scan. */ }
    }
  }
  return files.sort((a, b) => b.modified - a.modified || a.id.localeCompare(b.id));
}

export async function transcriptExists(id: string): Promise<boolean> {
  if (!uuid.test(id)) return false;
  return (await transcriptFiles(id)).length > 0;
}

interface TranscriptRecord { [key: string]: unknown }
async function visitRecords(file: string, visitor: (record: TranscriptRecord) => boolean | void): Promise<{ validRecords: number; malformedLines: number }> {
  const input = createReadStream(file, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let validRecords = 0; let malformedLines = 0;
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let record: unknown;
      try { record = JSON.parse(line); } catch { malformedLines++; continue; }
      if (!record || typeof record !== 'object' || Array.isArray(record)) { malformedLines++; continue; }
      validRecords++;
      if (visitor(record as TranscriptRecord) === false) break;
    }
  } finally { lines.close(); input.destroy(); }
  return { validRecords, malformedLines };
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(block => {
    if (!block || typeof block !== 'object') return '';
    if (typeof block.text === 'string') return block.text;
    if (block.type === 'tool_result') return contentText(block.content);
    if (block.type === 'tool_use' && block.input && typeof block.input === 'object') return JSON.stringify(block.input);
    return '';
  }).join('\n');
}
function recordText(record: TranscriptRecord): string {
  const message = record.message && typeof record.message === 'object' ? record.message as TranscriptRecord : undefined;
  return [record.summary, record.customTitle, contentText(message?.content)].filter(value => typeof value === 'string').join('\n');
}

async function indexFile(file: TranscriptFile, cache:ReadonlyMap<string,IndexedTranscript> = metadata): Promise<HistoryEntry | null> {
  const signature = `${file.modified}:${file.size}`;
  const previous = cache.get(file.file);
  if (previous?.signature === signature) {
    metadata.delete(file.file); metadata.set(file.file, previous);
    while(metadata.size>INDEX_LIMIT)metadata.delete(metadata.keys().next().value!);
    return previous.entry;
  }
  let cwd = ''; let title = ''; let summary = ''; let customTitle = '';
  try {
    parsedFiles++;
    await visitRecords(file.file, record => {
      if (!cwd && typeof record.cwd === 'string') cwd = record.cwd;
      if (typeof record.summary === 'string') summary = record.summary;
      if (typeof record.customTitle === 'string') customTitle = record.customTitle;
      if (!title && record.type === 'user') title = recordText(record);
    });
  } catch { return null; }
  const entry = cwd ? { id: file.id, cwd, title: (customTitle || summary || title || file.id).replace(/[\r\n]+/g, ' ').slice(0, 100), modifiedAt: new Date(file.modified).toISOString() } : null;
  metadata.delete(file.file); metadata.set(file.file, { signature, entry });
  while (metadata.size > INDEX_LIMIT) metadata.delete(metadata.keys().next().value!);
  return entry;
}

export interface HistoryQuery { query?: string; offset?: number; limit?: number }
export interface HistoryPage { entries: HistoryEntry[]; total: number; nextOffset: number | null }
/** Project filtering precedes sorting/pagination; unrelated recent projects never hide older sessions. */
export async function queryHistory(cwd: string, options: HistoryQuery = {}): Promise<HistoryPage> {
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 50)));
  if (!Number.isFinite(offset) || !Number.isFinite(limit)) throw new Error('历史分页参数无效。');
  const query = (options.query ?? '').trim().toLocaleLowerCase();
  if (query.length > 1000) throw new Error('搜索内容过长。');
  const expected = await canonicalPath(cwd);
  const files = await transcriptFiles();
  const signatureHash=createHash('sha256');
  for(const file of files)signatureHash.update(JSON.stringify([file.file,file.modified,file.size]));
  const signature=signatureHash.digest('hex');
  const key=JSON.stringify([claudeProjects(),expected,query]);
  const cached=queries.get(key);
  const page=(entries:HistoryEntry[]):HistoryPage=>({entries:entries.slice(offset,offset+limit).map(entry=>({...entry})),total:entries.length,nextOffset:offset+limit<entries.length?offset+limit:null});
  if(cached?.signature===signature) {
    queries.delete(key);queries.set(key,cached);return page(cached.entries);
  }
  // Freeze the previous generation during this scan. New misses cannot evict entries
  // before we get to them when the number of transcripts exceeds the LRU capacity.
  const cachedMetadata=new Map(metadata);
  const projectMatches = new Map<string, boolean>();
  const entries: HistoryEntry[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const entry = await indexFile(file,cachedMetadata);
    if (!entry || seen.has(entry.id)) continue;
    if (!projectMatches.has(entry.cwd)) projectMatches.set(entry.cwd, await canonicalPath(entry.cwd) === expected);
    if (!projectMatches.get(entry.cwd)) continue;
    if (query && !`${entry.title}\n${entry.id}`.toLocaleLowerCase().includes(query)) {
      let matched = false;
      try {
        await visitRecords(file.file, record => {
          if (recordText(record).toLocaleLowerCase().includes(query)) { matched = true; return false; }
        });
      } catch { continue; }
      if (!matched) continue;
    }
    seen.add(entry.id); entries.push(entry);
  }
  queries.delete(key);
  if(entries.length<=QUERY_ENTRY_LIMIT)queries.set(key,{signature,entries});
  while(queries.size>8 || historyCacheStats().queryEntries>QUERY_ENTRY_LIMIT)queries.delete(queries.keys().next().value!);
  return page(entries);
}

export async function readHistory(cwd: string): Promise<HistoryEntry[]> {
  return (await queryHistory(cwd, { limit: 100 })).entries;
}

/** Return a readonly transcript source only after its metadata matches the requested project. */
export async function findClaudeTranscript(cwd: string, id: string): Promise<string | undefined> {
  if (!uuid.test(id)) return undefined;
  const expected = await canonicalPath(cwd);
  for (const file of await transcriptFiles(id)) {
    const entry = await indexFile(file);
    if (entry && await canonicalPath(entry.cwd) === expected) return file.file;
  }
  return undefined;
}

export interface TranscriptExportSummary {
  bytes: number; validRecords: number; malformedLines: number;
  format: 'claude-jsonl'; scope: 'available-transcript';
}
/** Export every available byte, including unknown/corrupt records, without modifying Claude's file. */
export async function exportClaudeTranscript(cwd: string, id: string, destination: string): Promise<TranscriptExportSummary> {
  if (!uuid.test(id)) throw new Error('Claude 会话 ID 无效。');
  const sourceFile = await findClaudeTranscript(cwd, id);
  if (!sourceFile) throw new Error('未找到该项目的 Claude 原始对话记录。');
  if (normalizedPath(sourceFile) === normalizedPath(destination)) throw new Error('不能覆盖 Claude 原始对话记录。');
  try {
    const [origin, target] = await Promise.all([fs.stat(sourceFile), fs.stat(destination)]);
    if (origin.dev === target.dev && origin.ino === target.ino) throw new Error('不能覆盖 Claude 原始对话记录。');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const temporary = destination + '.tmp-' + randomUUID();
  try {
    // Fix the byte boundary for an actively growing conversation. This is an export-time snapshot.
    const bytes = (await fs.stat(sourceFile)).size;
    if (bytes) await pipeline(createReadStream(sourceFile, { start: 0, end: bytes - 1 }), createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
    else await fs.writeFile(temporary, '', { flag: 'wx', mode: 0o600 });
    const counts = await visitRecords(temporary, () => {});
    await fs.rename(temporary, destination);
    return { bytes, ...counts, format: 'claude-jsonl', scope: 'available-transcript' };
  } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
}
