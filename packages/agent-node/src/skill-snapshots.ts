import fs, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { constants, type BigIntStats } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { SkillVersionSnapshot } from '@cc-desk/contracts/native-skills';
import type { LoadedCatalogSkill } from './skill-registry.js';
import { extractSkillBody, parseSkillMetadata, SKILL_METADATA_MAX_FILE_BYTES } from './skill-metadata.js';
import { contentHash, ProjectFiles, throwIfAborted } from './tools/project-files.js';

export interface SkillSnapshotStoreOptions { directory: string; maxStorageBytes?: number }
const DEFAULT_STORAGE_BYTES = 128 * 1024 * 1024;
const MAX_OBJECTS = 8192;
const HASH = /^[a-f0-9]{64}$/;
const OBJECT_NAME = /^([a-f0-9]{64})\.skill$/;
const NOFOLLOW = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW ?? 0;
const DIRECTORY = process.platform === 'win32' ? 0 : constants.O_DIRECTORY ?? 0;
interface DirectoryIdentity { absolute: string; stat: BigIntStats }
const operationTails = new Map<string, Promise<void>>();
const changed = () => new Error('Skill snapshot directory or object changed. Retry after checking the private store.');
const sameObject = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.isDirectory() === b.isDirectory() && a.isFile() === b.isFile();
const stamp = (stat: BigIntStats) => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(value => value.toString()).join(':');
function validVersion(version: SkillVersionSnapshot): SkillVersionSnapshot {
  if (!version || typeof version.skillId !== 'string' || !version.skillId || version.skillId.length > 256 || /[\x00-\x1f\x7f]/.test(version.skillId)
    || !Number.isSafeInteger(version.sourceRevision) || version.sourceRevision < 1 || !HASH.test(version.sourceFingerprint)
    || !HASH.test(version.fullFileHash) || !HASH.test(version.bodyHash) || !Number.isSafeInteger(version.bytes)
    || version.bytes < 0 || version.bytes > SKILL_METADATA_MAX_FILE_BYTES || (version.format !== 'standard' && version.format !== 'legacy')) {
    throw new Error('Invalid skill version snapshot; complete files must fit the 32768 byte limit.');
  }
  return { skillId: version.skillId, sourceRevision: version.sourceRevision, sourceFingerprint: version.sourceFingerprint,
    fullFileHash: version.fullFileHash, bodyHash: version.bodyHash, bytes: version.bytes, format: version.format };
}
function verifyContent(version: SkillVersionSnapshot, content: string, expectedBody?: string): string {
  if (typeof content !== 'string' || Buffer.byteLength(content) !== version.bytes || content.includes('\0')
    || new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.from(content)) !== content || contentHash(content) !== version.fullFileHash) {
    throw new Error('Skill snapshot content does not match its complete file version.');
  }
  const metadata = parseSkillMetadata(content);
  if (metadata.format !== version.format || metadata.format === 'invalid') throw new Error('Skill snapshot format does not match its version.');
  const body = extractSkillBody(content);
  if (contentHash(body) !== version.bodyHash || (expectedBody !== undefined && expectedBody !== body)) throw new Error('Skill snapshot body does not match its complete version.');
  return body;
}
function safeError(error: unknown): Error {
  const text = error instanceof Error ? error.message : '';
  if (/^Skill snapshot |^Invalid skill /.test(text)) return new Error(text);
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === 'ENOENT') return new Error('Skill snapshot object is missing. Its exact historical version is unavailable.');
  if (/links are refused|ordinary/.test(text)) return new Error('Skill snapshot storage requires ordinary files and directories; links are refused.');
  if (/changed/.test(text)) return changed();
  if (/byte limit/.test(text)) return new Error('Skill snapshot object exceeds the 32768 byte limit.');
  if (/UTF-8|Binary/.test(text)) return new Error('Skill snapshot object must be valid UTF-8 text without binary data.');
  return new Error('Skill snapshot storage could not complete safely. Check private storage permissions and capacity.');
}

/**
 * Immutable raw bodies; authority for retaining versions stays in the queue and run ledger.
 * This store never infers references, deletes old objects, or replaces an unknown hash file.
 * Path checks are optimistic local filesystem checks, not an operating-system sandbox.
 */
export class SkillSnapshotStore {
  private readonly directory: string;
  private readonly maxStorageBytes: number;
  private binding?: DirectoryIdentity[];
  private files?: ProjectFiles;
  private inventory?: Map<string, number>;
  private inventoryStamp?: string;
  private storageBytes = 0;
  constructor(options: SkillSnapshotStoreOptions) {
    if (!options || typeof options.directory !== 'string' || !path.isAbsolute(options.directory) || options.directory.length > 4096 || /[\x00-\x1f\x7f]/.test(options.directory)) throw new Error('Invalid skill snapshot directory.');
    this.directory = path.resolve(options.directory);
    this.maxStorageBytes = options.maxStorageBytes ?? DEFAULT_STORAGE_BYTES;
    if (!Number.isSafeInteger(this.maxStorageBytes) || this.maxStorageBytes < 0) throw new Error('Invalid skill snapshot storage byte limit.');
  }
  private async serial<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    throwIfAborted(signal);
    const key = process.platform === 'win32' ? this.directory.toLowerCase() : this.directory;
    const previous = operationTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    operationTails.set(key, current);
    try {
      await previous;
      throwIfAborted(signal);
      return await operation();
    } catch (error) {
      throwIfAborted(signal);
      throw safeError(error);
    } finally { release(); if (operationTails.get(key) === current) operationTails.delete(key); }
  }
  private async verifyDirectory(identities = this.binding!, signal?: AbortSignal): Promise<void> {
    for (const expected of identities) {
      throwIfAborted(signal);
      const current = await fs.lstat(expected.absolute, { bigint: true });
      if (!current.isDirectory() || current.isSymbolicLink()) throw new Error('Only ordinary skill snapshot directories are allowed; links are refused.');
      if (!sameObject(expected.stat, current)) throw changed();
    }
    throwIfAborted(signal);
  }
  private async syncParent(identities: DirectoryIdentity[], signal?: AbortSignal): Promise<void> {
    if (process.platform === 'win32' || !identities.length) return;
    await this.verifyDirectory(identities, signal);
    const parent = identities.at(-1)!;
    const handle = await fs.open(parent.absolute, constants.O_RDONLY | NOFOLLOW | DIRECTORY);
    try {
      if (!sameObject(parent.stat, await handle.stat({ bigint: true }))) throw changed();
      await handle.sync();
      await this.verifyDirectory(identities, signal);
    } finally { await handle.close(); }
  }
  private async initialize(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    if (!this.binding) {
      const volume = path.parse(this.directory).root;
      const parts = path.relative(volume, this.directory).split(path.sep).filter(Boolean);
      const identities: DirectoryIdentity[] = [];
      let current = volume;
      for (let index = -1; index < parts.length; index++) {
        throwIfAborted(signal);
        if (index >= 0) current = path.join(current, parts[index]);
        let stat: BigIntStats;
        try { stat = await fs.lstat(current, { bigint: true }); }
        catch (error) {
          if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
          await this.verifyDirectory(identities, signal);
          try { await fs.mkdir(current, { mode: 0o700 }); }
          catch (mkdirError) { if ((mkdirError as NodeJS.ErrnoException)?.code !== 'EEXIST') throw mkdirError; }
          await this.syncParent(identities, signal);
          stat = await fs.lstat(current, { bigint: true });
        }
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Only ordinary skill snapshot directories are allowed; links are refused.');
        identities.push({ absolute: current, stat });
        await this.verifyDirectory(identities, signal);
      }
      this.binding = identities;
      this.files = new ProjectFiles({ projectRoot: this.directory, maxFileBytes: SKILL_METADATA_MAX_FILE_BYTES });
    }
    await this.verifyDirectory(undefined, signal);
    const current = stamp(await fs.lstat(this.directory, { bigint: true }));
    if (!this.inventory || current !== this.inventoryStamp) await this.scanInventory(signal);
  }
  private async scanInventory(signal?: AbortSignal): Promise<void> {
    await this.verifyDirectory(undefined, signal);
    const before = stamp(await fs.lstat(this.directory, { bigint: true }));
    const listing = await this.files!.entries('.', MAX_OBJECTS, signal);
    if (listing.truncated) throw new Error('Skill snapshot inventory exceeds the 8192 entry limit. No objects were removed.');
    const inventory = new Map<string, number>();
    let bytes = 0;
    for (const name of listing.names) {
      throwIfAborted(signal);
      const match = OBJECT_NAME.exec(name);
      if (!match) continue;
      const snapshot = await this.files!.snapshot(name);
      const size = snapshot.identities.at(-1)!.stat.size;
      if (size > BigInt(SKILL_METADATA_MAX_FILE_BYTES)) throw new Error('Skill snapshot object exceeds the 32768 byte limit.');
      inventory.set(match[1], Number(size));
      bytes += Number(size);
    }
    await this.verifyDirectory(undefined, signal);
    const after = stamp(await fs.lstat(this.directory, { bigint: true }));
    if (before !== after) throw changed();
    this.inventory = inventory;
    this.storageBytes = bytes;
    this.inventoryStamp = after;
  }
  private async readObject(version: SkillVersionSnapshot, signal?: AbortSignal): Promise<LoadedCatalogSkill> {
    await this.verifyDirectory(undefined, signal);
    const read = await this.files!.read(`${version.fullFileHash}.skill`, signal);
    await this.verifyDirectory(undefined, signal);
    const body = verifyContent(version, read.content);
    throwIfAborted(signal);
    return { version: { ...version }, content: read.content, body };
  }
  private async openDirectory(signal?: AbortSignal): Promise<FileHandle | undefined> {
    await this.verifyDirectory(undefined, signal);
    if (process.platform === 'win32') return undefined;
    const handle = await fs.open(this.directory, constants.O_RDONLY | NOFOLLOW | DIRECTORY);
    try {
      if (!sameObject(this.binding!.at(-1)!.stat, await handle.stat({ bigint: true }))) throw changed();
      await this.verifyDirectory(undefined, signal);
      return handle;
    } catch (error) { await handle.close(); throw error; }
  }

  async put(loaded: LoadedCatalogSkill, signal?: AbortSignal): Promise<SkillVersionSnapshot> {
    throwIfAborted(signal);
    const version = validVersion(loaded?.version);
    const content = loaded?.content, body = loaded?.body;
    if (typeof body !== 'string') throw new Error('Skill snapshot requires a complete body.');
    verifyContent(version, content, body);
    return this.serial(async () => {
      await this.initialize(signal);
      if (this.inventory!.has(version.fullFileHash)) { await this.readObject(version, signal); return { ...version }; }
      if (this.inventory!.size >= MAX_OBJECTS) throw new Error('Skill snapshot inventory reached its 8192 object limit. No referenced versions were removed.');
      if (this.storageBytes + version.bytes > this.maxStorageBytes) throw new Error('Skill snapshot storage byte quota is full. No referenced versions were removed.');
      const directory = await this.openDirectory(signal);
      const root = process.platform === 'linux' ? `/proc/self/fd/${directory!.fd}` : this.directory;
      const temporary = path.join(root, `.native-skill-snapshot-${randomUUID()}.tmp`);
      const target = path.join(root, `${version.fullFileHash}.skill`);
      let created = false;
      let temporaryIdentity: BigIntStats | undefined;
      try {
        const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
        created = true;
        try {
          temporaryIdentity = await handle.stat({ bigint: true });
          await handle.writeFile(content, 'utf8');
          throwIfAborted(signal);
          await handle.sync();
        }
        finally { await handle.close(); }
        throwIfAborted(signal);
        await this.verifyDirectory(undefined, signal);
        // Atomic hard-link publication refuses an existing target instead of replacing it.
        try { await fs.link(temporary, target); }
        catch (error) { if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error; }
        if (directory) await directory.sync();
        throwIfAborted(signal);
        await this.readObject(version, signal);
        if (!this.inventory!.has(version.fullFileHash)) {
          this.inventory!.set(version.fullFileHash, version.bytes);
          this.storageBytes += version.bytes;
        }
        return { ...version };
      } finally {
        try {
          if (created && temporaryIdentity) {
            // Linux keeps the original directory handle. On other platforms a changed
            // parent makes cleanup unsafe; leave the unconfirmed temp in the old directory.
            const reachable = process.platform === 'linux' || await this.verifyDirectory().then(() => true, () => false);
            if (reachable) {
              let current: BigIntStats | undefined;
              try { current = await fs.lstat(temporary, { bigint: true }); }
              catch (error) { if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error; }
              if (current && current.isFile() && !current.isSymbolicLink() && sameObject(temporaryIdentity, current)) await fs.unlink(temporary);
            }
          }
        } finally {
          if (directory) await directory.close();
          // Any failed operation must force a fresh bounded inventory on the next attempt.
          this.inventoryStamp = undefined;
        }
      }
    }, signal);
  }
  async read(input: SkillVersionSnapshot, signal?: AbortSignal): Promise<LoadedCatalogSkill> {
    throwIfAborted(signal);
    const version = validVersion(input);
    return this.serial(async () => { await this.initialize(signal); return this.readObject(version, signal); }, signal);
  }
}
