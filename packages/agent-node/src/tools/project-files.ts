import fs, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { constants, type BigIntStats } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';

export const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const NOFOLLOW = process.platform === 'win32' ? 0 : ((constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
const DIRECTORY = process.platform === 'win32' ? 0 : constants.O_DIRECTORY;
export interface FileIdentity { path: string; stat: BigIntStats }
export interface PathSnapshot { relative: string; absolute: string; kind: 'file' | 'directory'; identities: FileIdentity[] }
export interface TextFile { path: string; content: string; hash: string; bytes: number; mode: number; snapshot: PathSnapshot }
export interface PatchInput { path: string; content: string; expectedHash: string | null }
export interface PreparedPatch { input: PatchInput; parent: PathSnapshot; previous?: TextFile }
export interface FilePolicyOptions { projectRoot: string; excludedRoots?: readonly string[]; maxFileBytes?: number }

export function contentHash(content: string | Uint8Array): string { return createHash('sha256').update(content).digest('hex'); }
export function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}
export function isSensitivePath(relative: string): boolean {
  return relative.split('/').some(part => /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|_netrc|\.pypirc|\.ssh|\.aws|\.azure|\.gnupg|credentials(?:\.[^/]*)?|secrets?(?:\.[^/]*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.*\.(?:pem|key|p12|pfx)|application_default_credentials\.json)$/i.test(part));
}
export function normalizeProjectPath(relative: string, allowRoot = false): string {
  if (typeof relative !== 'string' || relative.length > 4096 || /[\x00-\x1f\x7f\\:]/.test(relative) || path.isAbsolute(relative) || path.win32.isAbsolute(relative)) throw new Error('Path must be project-relative.');
  if (allowRoot && (relative === '' || relative === '.')) return '.';
  const parts = relative.split('/');
  if (!relative || parts.some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git' || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part))) throw new Error('Unsafe or Git-internal project path.');
  return parts.join('/');
}
const changed = () => new Error('File or parent directory changed; read again before retrying.');
const sameObject = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.isFile() === b.isFile() && a.isDirectory() === b.isDirectory();
const sameVersion = (a: BigIntStats, b: BigIntStats) => sameObject(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
export function throwIfAborted(signal?: AbortSignal): void { if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Operation cancelled.'); }

/**
 * Secure handle reads are adapted from desktop main/files.ts, intentionally copied
 * until the desktop preview can migrate without changing its public contract.
 * Node path checks are an optimistic boundary, not a hostile-local-process OS sandbox.
 */
export class ProjectFiles {
  readonly maxFileBytes: number;
  private rootPromise?: Promise<{ root: string; stat: BigIntStats; excluded: string[] }>;
  constructor(private readonly options: FilePolicyOptions) {
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    if (!Number.isSafeInteger(this.maxFileBytes) || this.maxFileBytes < 1 || this.maxFileBytes > 4 * 1024 * 1024) throw new Error('Invalid file byte limit.');
  }
  private root() {
    return this.rootPromise ??= (async () => {
      const root = await fs.realpath(this.options.projectRoot);
      const stat = await fs.lstat(root, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Project root must be a directory.');
      const excluded: string[] = [];
      for (const candidate of this.options.excludedRoots ?? []) {
        const absolute = path.resolve(candidate);
        const canonical = await fs.realpath(absolute).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return absolute; });
        excluded.push(canonical, absolute);
      }
      if (excluded.some(item => isWithin(item, root))) throw new Error('Project root overlaps a protected host directory.');
      return { root, stat, excluded };
    })();
  }
  async snapshot(relative: string, kind: 'file' | 'directory' = 'file'): Promise<PathSnapshot> {
    relative = normalizeProjectPath(relative, kind === 'directory');
    const { root, stat, excluded } = await this.root();
    const absolute = path.resolve(root, relative);
    if (!isWithin(root, absolute) || excluded.some(item => isWithin(item, absolute))) throw new Error('Protected path is outside the authorized project.');
    if (await fs.realpath(root) !== root) throw changed();
    const identities: FileIdentity[] = [];
    const parts = relative === '.' ? [] : relative.split('/');
    let current = root;
    for (let index = -1; index < parts.length; index++) {
      if (index >= 0) current = path.join(current, parts[index]);
      const object = await fs.lstat(current, { bigint: true });
      const isLast = index === parts.length - 1;
      if (object.isSymbolicLink() || (isLast && kind === 'file' ? !object.isFile() : !object.isDirectory())) throw new Error('Only ordinary files and directories are allowed; links are refused.');
      if (index === -1 && !sameObject(stat, object)) throw changed();
      identities.push({ path: current, stat: object });
    }
    if (await fs.realpath(absolute) !== absolute) throw changed();
    return { relative, absolute, kind, identities };
  }
  async verify(snapshot: PathSnapshot, fileVersion = false): Promise<void> {
    const current = await this.snapshot(snapshot.relative, snapshot.kind);
    if (current.identities.length !== snapshot.identities.length || current.identities.some((item, index) => !(fileVersion && index === current.identities.length - 1 ? sameVersion : sameObject)(item.stat, snapshot.identities[index].stat))) throw changed();
  }
  private async openSnapshot(snapshot: PathSnapshot): Promise<{ handle: FileHandle; handles: FileHandle[] }> {
    const handles: FileHandle[] = [];
    try {
      let handle: FileHandle;
      if (process.platform === 'linux') {
        handle = await fs.open(snapshot.identities[0].path, constants.O_RDONLY | DIRECTORY | NOFOLLOW);
        handles.push(handle);
        if (!sameObject(await handle.stat({ bigint: true }), snapshot.identities[0].stat)) throw changed();
        for (let index = 1; index < snapshot.identities.length; index++) {
          const directory = index < snapshot.identities.length - 1 || snapshot.kind === 'directory';
          handle = await fs.open(`/proc/self/fd/${handle.fd}/${path.basename(snapshot.identities[index].path)}`, constants.O_RDONLY | NOFOLLOW | (directory ? DIRECTORY : 0));
          handles.push(handle);
          if (!sameObject(await handle.stat({ bigint: true }), snapshot.identities[index].stat)) throw changed();
        }
      } else {
        handle = await fs.open(snapshot.absolute, constants.O_RDONLY | NOFOLLOW | (snapshot.kind === 'directory' ? DIRECTORY : 0));
        handles.push(handle);
      }
      if (!sameObject(await handle.stat({ bigint: true }), snapshot.identities.at(-1)!.stat)) throw changed();
      await this.verifyHandle(handle, snapshot);
      return { handle, handles };
    } catch (error) { await Promise.all(handles.map(handle => handle.close())); throw error; }
  }
  private async verifyHandle(handle: FileHandle, snapshot: PathSnapshot): Promise<void> {
    if (process.platform === 'linux' && await fs.realpath(`/proc/self/fd/${handle.fd}`) !== snapshot.absolute) throw changed();
    await this.verify(snapshot);
  }
  async read(relative: string, signal?: AbortSignal): Promise<TextFile> {
    throwIfAborted(signal);
    const snapshot = await this.snapshot(relative);
    const { handle, handles } = await this.openSnapshot(snapshot);
    try {
      const before = await handle.stat({ bigint: true });
      if (before.size > BigInt(this.maxFileBytes)) throw new Error(`File exceeds the ${this.maxFileBytes} byte limit.`);
      // Read the entire object even when callers later select a range: its version is never a fragment hash.
      const buffer = Buffer.alloc(Number(before.size));
      let offset = 0;
      while (offset < buffer.length) {
        throwIfAborted(signal);
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (!bytesRead) throw changed();
        offset += bytesRead;
      }
      if (!sameVersion(before, await handle.stat({ bigint: true }))) throw changed();
      await this.verifyHandle(handle, snapshot);
      await this.verify(snapshot, true);
      if (buffer.includes(0)) throw new Error('Binary files are not supported.');
      let content: string;
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch { throw new Error('Only valid UTF-8 text files are supported.'); }
      throwIfAborted(signal);
      return { path: snapshot.relative, content, hash: contentHash(buffer), bytes: buffer.length, mode: Number(before.mode & 0o777n), snapshot };
    } finally { await Promise.all(handles.map(item => item.close())); }
  }
  async entries(relative: string, limit: number, signal?: AbortSignal): Promise<{ names: string[]; truncated: boolean }> {
    const snapshot = await this.snapshot(relative, 'directory');
    // Windows cannot reliably open directory handles with Node. Keep the same pre/post identity checks there.
    const opened = process.platform === 'win32' ? undefined : await this.openSnapshot(snapshot);
    const directoryPath = process.platform === 'linux' ? `/proc/self/fd/${opened!.handle.fd}` : snapshot.absolute;
    const names: string[] = [];
    let truncated = false;
    try {
      const directory = await fs.opendir(directoryPath);
      for await (const entry of directory) {
        throwIfAborted(signal);
        if (names.length >= limit) { truncated = true; break; }
        names.push(entry.name);
      }
      if (opened) await this.verifyHandle(opened.handle, snapshot); else await this.verify(snapshot);
      return { names: names.sort(), truncated };
    } finally { if (opened) await Promise.all(opened.handles.map(item => item.close())); }
  }
  async preparePatch(input: PatchInput, signal?: AbortSignal): Promise<PreparedPatch> {
    const relative = normalizeProjectPath(input.path);
    if (typeof input.content !== 'string' || Buffer.byteLength(input.content) > this.maxFileBytes || input.content.includes('\0') || new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(input.content)) !== input.content) throw new Error('Patch must contain bounded UTF-8 text.');
    if (input.expectedHash !== null && !/^[a-f0-9]{64}$/.test(input.expectedHash)) throw new Error('Update requires the complete previous SHA-256 hash; create requires null.');
    const parent = await this.snapshot(path.posix.dirname(relative), 'directory');
    throwIfAborted(signal);
    if (input.expectedHash === null) {
      try { await fs.lstat(path.join(parent.absolute, path.posix.basename(relative))); throw new Error('Create conflict: target already exists.'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      return { input: { ...input, path: relative }, parent };
    }
    const previous = await this.read(relative, signal);
    if (previous.hash !== input.expectedHash) throw new Error('File version conflict; read the complete current version before retrying.');
    return { input: { ...input, path: relative }, parent, previous };
  }
  async applyPatch(prepared: PreparedPatch, signal?: AbortSignal): Promise<{ path: string; previousHash: string | null; hash: string; bytes: number; created: boolean }> {
    const { input, parent, previous } = prepared;
    throwIfAborted(signal);
    await this.verify(parent);
    const opened = process.platform === 'win32' ? undefined : await this.openSnapshot(parent);
    const directory = process.platform === 'linux' ? `/proc/self/fd/${opened!.handle.fd}` : parent.absolute;
    const temporary = path.join(directory, `.native-patch-${randomUUID()}.tmp`);
    const target = path.join(directory, path.posix.basename(input.path));
    let temporaryCreated = false;
    try {
      if (previous) await this.verify(previous.snapshot, true);
      const current = await this.preparePatch(input, signal);
      if (current.previous?.hash !== previous?.hash) throw changed();
      const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, previous?.mode ?? 0o600);
      temporaryCreated = true;
      try { await handle.writeFile(input.content, 'utf8'); if (previous) await handle.chmod(previous.mode); await handle.sync(); } finally { await handle.close(); }
      throwIfAborted(signal);
      await this.verify(parent);
      if (opened) await this.verifyHandle(opened.handle, parent);
      if (previous) {
        await this.verify(previous.snapshot, true);
        const latest = await this.read(input.path, signal);
        if (latest.hash !== input.expectedHash) throw changed();
        await fs.rename(temporary, target);
        temporaryCreated = false;
      } else {
        // Hard-link publication is atomic and refuses an existing target on every supported platform.
        await fs.link(temporary, target);
        await fs.unlink(temporary);
        temporaryCreated = false;
      }
      if (opened) await opened.handle.sync();
      await this.verify(parent);
      const written = await this.read(input.path);
      if (written.hash !== contentHash(input.content)) throw changed();
      return { path: input.path, previousHash: input.expectedHash, hash: written.hash, bytes: written.bytes, created: input.expectedHash === null };
    } finally {
      if (temporaryCreated) await fs.unlink(temporary).catch(() => undefined);
      if (opened) await Promise.all(opened.handles.map(item => item.close()));
    }
  }
}
