import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export class RunStoreError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'RunStoreError'; }
}

export function assertUuid(value: string, label: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw new RunStoreError('invalid_identity', `${label} must be an internal canonical UUID`);
  }
}

async function createDurableDirectory(directory: string): Promise<void> {
  const parent = path.dirname(directory);
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' && parent !== directory) { await createDurableDirectory(parent); await createDurableDirectory(directory); return; }
    if (code !== 'EEXIST') throw error;
  }
  // Directory fsync alone commits its contents, not its entry in the parent.
  // Commit every newly created level before any side effect can be authorized.
  if (parent !== directory) await syncDirectory(parent);
}

export async function safeDirectory(root: string, conversationId: string): Promise<string> {
  assertUuid(conversationId, 'conversationId');
  root = path.resolve(root);
  await createDurableDirectory(root);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new RunStoreError('unsafe_path', 'Store root must be a real directory');
  const directory = path.join(await realpath(root), conversationId);
  await createDurableDirectory(directory);
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new RunStoreError('unsafe_path', 'Conversation path must be a real directory');
  return directory;
}

export async function syncDirectory(directory: string): Promise<void> {
  // Windows has no portable directory fsync in Node. File handles are always synced;
  // directory sync is performed on POSIX and unsupported Windows errors are explicit.
  let handle;
  try {
    handle = await open(directory, constants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EINVAL', 'EISDIR', 'ENOTSUP'].includes(code ?? '')) throw error;
  } finally { await handle?.close(); }
}

export async function readRegularFile(file: string, maximum: number): Promise<string | undefined> {
  let stat;
  try { stat = await lstat(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new RunStoreError('unsafe_path', 'Store files must be private regular files');
  if (stat.size > maximum) throw new RunStoreError('limit_exceeded', 'Persisted store file exceeds its configured limit');
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const actual = await handle.stat();
    if (!actual.isFile() || actual.dev !== stat.dev || actual.ino !== stat.ino || actual.size > maximum) throw new RunStoreError('unsafe_path', 'Store file identity changed');
    const buffer = await handle.readFile();
    if (buffer.byteLength > maximum) throw new RunStoreError('limit_exceeded', 'Persisted store file exceeds its configured limit');
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } finally { await handle.close(); }
}

/** Conservative cross-process writer lock: a live/reused/unverifiable PID is never stolen. */
export async function acquireWriter(directory: string): Promise<() => Promise<void>> {
  const file = path.join(directory, '.writer-lock');
  const nonce = randomUUID();
  const contents = JSON.stringify({ schemaVersion: 1, pid: process.pid, nonce });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      try { await handle.writeFile(contents, 'utf8'); await handle.sync(); } finally { await handle.close(); }
      await syncDirectory(directory);
      let removed = false;
      return async () => {
        if (!removed) {
          const raw = await readRegularFile(file, 4096);
          if (raw !== contents) throw new RunStoreError('writer_lost', 'Conversation writer ownership changed');
          await unlink(file);
          removed = true;
        }
        await syncDirectory(directory);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // Only one contender may reclaim a stale lock. A crashed reclamation
      // marker deliberately fails closed instead of racing a replacement writer.
      const recoveryFile = path.join(directory, '.writer-recovery-lock');
      let recovery;
      try { recovery = await open(recoveryFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600); }
      catch (recoveryError) { if ((recoveryError as NodeJS.ErrnoException).code === 'EEXIST') throw new RunStoreError('writer_locked', 'Another writer is checking stale ownership; manual verification is required if interrupted'); throw recoveryError; }
      try {
      let before;
      try { before = await lstat(file); } catch (missing) { if ((missing as NodeJS.ErrnoException).code === 'ENOENT') continue; throw missing; }
      const raw = await readRegularFile(file, 4096);
      let lock: { schemaVersion?: number; pid?: number; nonce?: string };
      try { lock = JSON.parse(raw ?? ''); } catch { throw new RunStoreError('writer_locked', 'Writer lock is incomplete; manual verification is required'); }
      if (lock.schemaVersion !== 1 || !Number.isSafeInteger(lock.pid) || (lock.pid ?? 0) < 1 || typeof lock.nonce !== 'string') {
        throw new RunStoreError('writer_locked', 'Writer lock is invalid; manual verification is required');
      }
      try { process.kill(lock.pid!, 0); throw new RunStoreError('writer_locked', 'Conversation already has a live writer'); }
      catch (probeError) { if ((probeError as NodeJS.ErrnoException).code !== 'ESRCH') throw probeError; }
      const after = await lstat(file);
      if (before.dev !== after.dev || before.ino !== after.ino || await readFile(file, 'utf8') !== raw) continue;
      await unlink(file);
      await syncDirectory(directory);
      } finally { await recovery.close(); await unlink(recoveryFile); await syncDirectory(directory); }
    }
  }
  throw new RunStoreError('writer_locked', 'Cannot acquire conversation writer');
}
