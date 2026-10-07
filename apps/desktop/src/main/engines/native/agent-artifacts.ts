import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ensureWorktreeParent } from '../../worktree-paths';

async function syncDirectory(directory: string): Promise<void> {
  let handle;
  try { handle = await fs.open(directory, constants.O_RDONLY); await handle.sync(); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Node cannot portably fsync directory handles on Windows. Files always sync.
    if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EINVAL', 'EISDIR', 'ENOTSUP'].includes(code ?? '')) throw error;
  } finally { await handle?.close(); }
}
async function durableParent(directory: string): Promise<void> {
  const created: string[] = [];
  await ensureWorktreeParent(directory, created);
  for (const entry of created) await syncDirectory(path.dirname(entry));
}

/** Receipt publication is atomic; acknowledgements follow the file/directory release barrier. */
export async function writeAgentReceipt(file: string, value: unknown): Promise<void> {
  const directory = path.dirname(file), temporary = `${file}.${randomUUID()}.tmp`;
  await durableParent(directory);
  try {
    const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temporary, file); await syncDirectory(directory);
  } finally { await fs.rm(temporary, { force: true }); }
}

/** Artifacts are append-only and retained even if receipt publication subsequently fails. */
export async function writeAgentArtifact(file: string, content: string | Buffer): Promise<void> {
  await durableParent(path.dirname(file));
  const handle = await fs.open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
  await syncDirectory(path.dirname(file));
}
