import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { RunStoreError } from './store-files.js';

interface PathSnapshot { file: string; stat: BigIntStats | undefined }
interface OpenSnapshot extends PathSnapshot { handle?: FileHandle }
const changed = (): never => { throw new RunStoreError('snapshot_changed', 'Conversation changed during the read; retry after current writes finish'); };
const unsafe = (): never => { throw new RunStoreError('unsafe_path', 'Store snapshots require private regular files and real directories'); };
const same = (a: BigIntStats, b: BigIntStats): boolean => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode &&
  a.nlink === b.nlink && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

async function statPath(file: string): Promise<BigIntStats | undefined> {
  try { return await lstat(file, { bigint: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

async function verifyPath(snapshot: PathSnapshot): Promise<void> {
  const current = await statPath(snapshot.file);
  const equal = snapshot.stat?.isDirectory() && current?.isDirectory()
    // 共享祖先目录（例如 /tmp）中的同级写入不会改变我们的查找。
    ? snapshot.stat.dev === current.dev && snapshot.stat.ino === current.ino && snapshot.stat.mode === current.mode
    : snapshot.stat !== undefined && current !== undefined && same(snapshot.stat, current);
  if (snapshot.stat === undefined ? current !== undefined : !equal) changed();
}

/** 检查每层祖先目录，包括 rootDirectory 的祖先；绝不通过链接解析。 */
async function captureDirectories(directory: string): Promise<PathSnapshot[]> {
  const ancestors = [directory];
  while (path.dirname(ancestors[0]!) !== ancestors[0]) ancestors.unshift(path.dirname(ancestors[0]!));
  const result: PathSnapshot[] = [];
  for (const file of ancestors) {
    const stat = await statPath(file);
    result.push({ file, stat });
    if (!stat) break;
    if (!stat.isDirectory() || stat.isSymbolicLink()) unsafe();
  }
  return result;
}

async function captureFile(file: string, maximum: number): Promise<OpenSnapshot> {
  const stat = await statPath(file);
  const snapshot: OpenSnapshot = { file, stat };
  if (!stat) return snapshot;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) unsafe();
  if (stat.size > BigInt(maximum)) throw new RunStoreError('limit_exceeded', 'Persisted store file exceeds its configured limit');
  // NONBLOCK 防止被替换的 FIFO 在 fstat 有机会拒绝它之前阻塞打开操作。
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const actual = await handle.stat({ bigint: true });
    if (!actual.isFile() || actual.nlink !== 1n) unsafe();
    if (!same(stat, actual)) changed();
    return { ...snapshot, handle };
  } catch (error) { await handle.close(); throw error; }
}

async function readSnapshot(snapshot: OpenSnapshot): Promise<string | undefined> {
  if (!snapshot.handle || !snapshot.stat) return undefined;
  // 严格读取已捕获的长度。运行中的追加绝不能使其变成
  // 不限制大小的 readFile() 内存分配，或无限读取持续增长的文件。
  const size = Number(snapshot.stat.size);
  const buffer = Buffer.alloc(size);
  for (let offset = 0; offset < size;) {
    const { bytesRead } = await snapshot.handle.read(buffer, offset, Math.min(64 * 1024, size - offset), offset);
    if (!bytesRead) changed();
    offset += bytesRead;
  }
  const probe = Buffer.alloc(1);
  if ((await snapshot.handle.read(probe, 0, 1, size)).bytesRead !== 0) changed();
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch { throw new RunStoreError('corrupt_store', 'Persisted store snapshot is not valid UTF-8'); }
}

/** 不加锁、不 mkdir、不 chmod、不清理也不恢复。回调仅重放已捕获的数据。 */
export async function readStoreSnapshot<T>(directory: string, limits: { maxJournalBytes: number; maxCheckpointBytes: number },
  inspect: (journal: string | undefined, checkpoint: string | undefined) => T): Promise<T> {
  const files: OpenSnapshot[] = [];
  try {
    const directories = await captureDirectories(directory);
    if (!directories.at(-1)?.stat) {
      const result = inspect(undefined, undefined);
      for (const ancestor of directories) await verifyPath(ancestor);
      return result;
    }
    files.push(await captureFile(path.join(directory, 'journal.jsonl'), limits.maxJournalBytes));
    files.push(await captureFile(path.join(directory, 'checkpoint.json'), limits.maxCheckpointBytes));
    const journal = await readSnapshot(files[0]!);
    const checkpoint = await readSnapshot(files[1]!);
    const result = inspect(journal, checkpoint);
    for (const snapshot of files) {
      if (snapshot.handle && snapshot.stat && !same(snapshot.stat, await snapshot.handle.stat({ bigint: true }))) changed();
      await verifyPath(snapshot);
    }
    for (const ancestor of directories) await verifyPath(ancestor);
    return result;
  } catch (error) {
    if (error instanceof RunStoreError) throw error;
    if (['ELOOP', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) unsafe();
    throw new RunStoreError('store_read_failed', 'Unable to read the persisted conversation snapshot');
  } finally {
    for (const snapshot of files) await snapshot.handle?.close().catch(() => undefined);
  }
}
