import fs from 'node:fs/promises';
import path from 'node:path';
import type { BigIntStats } from 'node:fs';
import type { SkillCatalogSnapshot, SkillDescriptor, SkillDiagnostic, SkillMetadataResult, SkillScope, SkillSourceKind, SkillVersionSnapshot } from '@cc-desk/contracts/native-skills';
import { extractSkillBody, parseSkillMetadata, SKILL_METADATA_MAX_FILE_BYTES, SKILL_METADATA_MAX_HEADER_BYTES } from './skill-metadata.js';
import { contentHash, isSensitivePath, isWithin, normalizeProjectPath, ProjectFiles, throwIfAborted, type PathSnapshot } from './tools/project-files.js';

export interface SkillRegistrySource {
  id: string;
  scope: SkillScope;
  kind: SkillSourceKind;
  /** Project roots are project-relative; user roots are explicit absolute host paths. */
  rootPath: string;
  enabled: boolean;
  revision: number;
  /** Explicit sources never enumerate their surrounding directory. Paths are source-relative. */
  explicitPaths?: readonly string[];
}
export interface SkillRegistryOptions {
  projectId: string;
  projectRoot: string;
  sources: readonly SkillRegistrySource[];
  excludedRoots?: readonly string[];
  /** Host-only exception for the exact application-managed skill root. */
  managedRoot?: string;
}
export interface LoadedCatalogSkill { version: SkillVersionSnapshot; content: string; body: string }
export type SkillResolution = { status: 'resolved'; descriptor: SkillDescriptor; candidates: SkillDescriptor[] }
  | { status: 'ambiguous' | 'missing'; candidates: SkillDescriptor[] };
export interface SkillCatalogPage { revision: string; entries: SkillDescriptor[]; nextCursor: string | null }

const MAX_SOURCES = 16;
const MAX_SOURCE_ENTRIES = 256;
const MAX_CATALOG_ENTRIES = 512;
const MAX_PARALLEL_READS = 4;
const MAX_CACHE_BYTES = 8 * 1024 * 1024;
const kinds = new Set<SkillSourceKind>(['project-agents', 'project-claude', 'project-explicit', 'managed', 'user-agents', 'user-claude', 'custom']);
const changed = () => new Error('Skill source or file version changed. Refresh the catalog before retrying.');
const safeId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\x00-\x1f\x7f]/.test(value);
const issue = (code: string, message: string, sourceId: string, relative?: string, severity: SkillDiagnostic['severity'] = 'error'): SkillDiagnostic => ({ code, message, severity, sourceId, ...(relative === undefined ? {} : { path: relative }) });
function safeIssue(error: unknown, sourceId: string, relative?: string): SkillDiagnostic {
  const code = (error as NodeJS.ErrnoException)?.code;
  const text = error instanceof Error ? error.message : '';
  if (code === 'ENOENT' || code === 'ENOTDIR') return issue('source_missing', 'Skill source or selected file is missing. Refresh the catalog.', sourceId, relative);
  if (/byte limit/.test(text)) return issue('file_limit', 'Skill exceeds the 32768 byte file limit.', sourceId, relative);
  if (/UTF-8|Binary/.test(text)) return issue('file_text', 'Skill must contain valid UTF-8 text without binary data.', sourceId, relative);
  if (/links are refused|ordinary files|ordinary directory/.test(text)) return issue('source_links', 'Skill sources require ordinary files and directories; links are refused.', sourceId, relative);
  if (/protected|Protected/.test(text)) return issue('source_protected', 'Skill source overlaps a protected host directory.', sourceId, relative);
  if (/changed/.test(text)) return issue('source_changed', 'Skill source or file version changed. Refresh the catalog.', sourceId, relative);
  return issue('source_unavailable', 'Skill source could not be read safely. Check its registration and file permissions.', sourceId, relative);
}
function normalizedSkillPath(value: string): string {
  const relative = normalizeProjectPath(value);
  const parts = relative.split('/');
  if (parts.length < 2 || parts.length > 22 || parts[0] === '~' || parts.at(-1) !== 'SKILL.md' || isSensitivePath(relative)) throw new Error('Skills require a non-sensitive relative directory/SKILL.md path.');
  return relative;
}
function validateOptions(options: SkillRegistryOptions): SkillRegistryOptions {
  if (!safeId(options.projectId) || typeof options.projectRoot !== 'string' || !path.isAbsolute(options.projectRoot)) throw new Error('Skill registry requires a logical project ID and absolute project root.');
  if (!Array.isArray(options.sources) || options.sources.length > 64 || options.sources.filter(item => item?.enabled === true).length > MAX_SOURCES) throw new Error('Enable at most 16 skill sources (at most 64 registrations).');
  if (options.managedRoot !== undefined && (typeof options.managedRoot !== 'string' || !path.isAbsolute(options.managedRoot))) throw new Error('Managed skill root must be an absolute host path.');
  const ids = new Set<string>();
  const sources = options.sources.map(source => {
    if (!source || !safeId(source.id) || ids.has(source.id) || !['project', 'user'].includes(source.scope) || !kinds.has(source.kind)
      || typeof source.enabled !== 'boolean' || !Number.isSafeInteger(source.revision) || source.revision < 1 || typeof source.rootPath !== 'string') throw new Error('Invalid or duplicate skill source registration.');
    ids.add(source.id);
    let rootPath: string;
    if (source.scope === 'project') {
      rootPath = normalizeProjectPath(source.rootPath, true);
      if (rootPath.split('/')[0] === '~' || isSensitivePath(rootPath)) throw new Error('Project skill sources require non-sensitive project-relative roots.');
      if (source.kind === 'managed' || source.kind === 'user-agents' || source.kind === 'user-claude') throw new Error('Skill source kind does not match its scope.');
    } else {
      if (!path.isAbsolute(source.rootPath) || /[\x00-\x1f\x7f]/.test(source.rootPath) || source.rootPath.length > 4096) throw new Error('User skill sources require explicit absolute roots.');
      if (source.kind.startsWith('project-')) throw new Error('Skill source kind does not match its scope.');
      rootPath = path.resolve(source.rootPath);
    }
    let explicitPaths: string[] | undefined;
    if (source.explicitPaths !== undefined) {
      if (!Array.isArray(source.explicitPaths) || source.explicitPaths.length > MAX_SOURCE_ENTRIES) throw new Error('Register at most 256 explicit skill paths per source.');
      const seen = new Set<string>();
      explicitPaths = source.explicitPaths.map((value: string) => {
        const relative = normalizedSkillPath(value);
        const key = relative.toLowerCase();
        if (seen.has(key)) throw new Error('Duplicate explicit skill paths are not allowed.');
        seen.add(key);
        return relative;
      }).sort();
    }
    if (source.kind === 'project-explicit' && explicitPaths === undefined) throw new Error('Explicit skill sources require explicit paths.');
    return { ...source, rootPath, ...(explicitPaths === undefined ? {} : { explicitPaths }) };
  });
  return { ...options, sources, excludedRoots: options.excludedRoots ? [...options.excludedRoots] : undefined };
}
function statIdentity(stat: BigIntStats, file: boolean): string[] {
  return (file ? [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs] : [stat.dev, stat.ino, stat.mode]).map(value => value.toString());
}
function sameObject(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.isDirectory() === b.isDirectory() && a.isFile() === b.isFile();
}
function skillId(projectId: string, source: SkillRegistrySource, relativePath: string): string {
  return `skill:${contentHash(JSON.stringify([1, source.scope === 'project' ? projectId : 'user', source.scope, source.id, relativePath]))}`;
}
interface SourceAccess {
  files: ProjectFiles;
  prefix: string;
  verifyRoot(): Promise<void>;
}
interface CacheEntry { fingerprint: string; metadata: SkillMetadataResult; metadataHash: string; bytes: number; cacheBytes: number }
interface Candidate { source: SkillRegistrySource; access: SourceAccess; relative: string }

/** No HOME expansion or default roots: the trusted host must provide every enabled source. */
export class SkillRegistry {
  private readonly options: SkillRegistryOptions;
  private readonly cache = new Map<string, CacheEntry>();
  private cacheBytes = 0;
  constructor(options: SkillRegistryOptions) { this.options = validateOptions(options); }

  private async sourceAccess(source: SkillRegistrySource, signal?: AbortSignal): Promise<SourceAccess> {
    throwIfAborted(signal);
    let excludedRoots = this.options.excludedRoots;
    let managedCanonical: string | undefined;
    if (source.scope === 'user' && source.kind === 'managed' && this.options.managedRoot !== undefined && path.resolve(this.options.managedRoot) === source.rootPath) {
      const ancestors = this.options.excludedRoots?.filter(excluded => isWithin(path.resolve(excluded), source.rootPath)) ?? [];
      // A link below the protected application directory must not turn this precise
      // exception into permission for a different host directory.
      for (const ancestor of ancestors) {
        const expected = path.resolve(await fs.realpath(ancestor), path.relative(path.resolve(ancestor), source.rootPath));
        if (managedCanonical !== undefined && managedCanonical !== expected) throw new Error('Managed skill root changed.');
        managedCanonical = expected;
      }
      if (managedCanonical !== undefined && await fs.realpath(source.rootPath) !== managedCanonical) throw new Error('Managed skill roots require ordinary directories; links are refused.');
      excludedRoots = this.options.excludedRoots?.filter(excluded => !ancestors.includes(excluded));
    }
    const requestedSource = source.scope === 'project' ? path.resolve(this.options.projectRoot, source.rootPath) : source.rootPath;
    if (excludedRoots?.some(excluded => isWithin(path.resolve(excluded), requestedSource))) throw new Error('Skill root overlaps a protected host directory.');
    const files = new ProjectFiles({ projectRoot: source.scope === 'project' ? this.options.projectRoot : source.rootPath,
      excludedRoots, maxFileBytes: SKILL_METADATA_MAX_FILE_BYTES });
    const prefix = source.scope === 'project' ? source.rootPath : '.';
    const requestedRoot = source.scope === 'project' ? this.options.projectRoot : source.rootPath;
    const canonical = await fs.realpath(requestedRoot);
    const registered = await fs.lstat(requestedRoot, { bigint: true });
    // ProjectFiles intentionally accepts a canonical authorized project alias. A user source
    // is itself a registered capability and must not be silently rebound through an alias.
    if (source.scope === 'user' && (!registered.isDirectory() || registered.isSymbolicLink())) throw new Error('Skill root must be an ordinary directory; links are refused.');
    const authorized = await files.snapshot(prefix, 'directory');
    const verifyRoot = async () => {
      throwIfAborted(signal);
      if ((managedCanonical !== undefined && canonical !== managedCanonical) || await fs.realpath(requestedRoot) !== canonical
        || !sameObject(registered, await fs.lstat(requestedRoot, { bigint: true }))) throw changed();
      await files.verify(authorized);
      throwIfAborted(signal);
    };
    await verifyRoot();
    return { files, prefix, verifyRoot };
  }
  private actualPath(access: SourceAccess, relative: string): string { return access.prefix === '.' ? relative : `${access.prefix}/${relative}`; }
  private fingerprint(source: SkillRegistrySource, snapshot: PathSnapshot): string {
    return contentHash(JSON.stringify([1, source.scope === 'project' ? this.options.projectId : 'user', source.scope, source.id, source.kind, source.rootPath, source.revision,
      snapshot.identities.map((item, index) => [item.path, ...statIdentity(item.stat, index === snapshot.identities.length - 1 && snapshot.kind === 'file')])]));
  }
  private async inspect(candidate: Candidate, signal?: AbortSignal): Promise<SkillDescriptor> {
    const { source, access, relative } = candidate;
    const actual = this.actualPath(access, relative);
    throwIfAborted(signal);
    await access.verifyRoot();
    const initial = await access.files.snapshot(actual);
    const fingerprint = this.fingerprint(source, initial);
    const id = skillId(this.options.projectId, source, relative);
    let cached = this.cache.get(id);
    if (!cached || cached.fingerprint !== fingerprint) {
      const prefix = await access.files.readPrefix(actual, SKILL_METADATA_MAX_HEADER_BYTES, signal);
      await access.verifyRoot();
      await access.files.verify(initial, true);
      if (this.fingerprint(source, prefix.snapshot) !== fingerprint || this.fingerprint(source, await access.files.snapshot(actual)) !== fingerprint) throw changed();
      const metadata = parseSkillMetadata(prefix.content, { directoryName: relative.split('/').at(-2), headerComplete: !prefix.truncated });
      const metadataHash = contentHash(JSON.stringify(metadata));
      cached = { fingerprint, metadata, metadataHash, bytes: Number(initial.identities.at(-1)!.stat.size), cacheBytes: 0 };
      cached.cacheBytes = Buffer.byteLength(JSON.stringify([id, cached]));
      const previous = this.cache.get(id);
      if (previous) { this.cacheBytes -= previous.cacheBytes; this.cache.delete(id); }
      this.cache.set(id, cached);
      this.cacheBytes += cached.cacheBytes;
      while (this.cacheBytes > MAX_CACHE_BYTES || this.cache.size > MAX_CATALOG_ENTRIES) {
        const key = this.cache.keys().next().value!;
        this.cacheBytes -= this.cache.get(key)!.cacheBytes;
        this.cache.delete(key);
      }
    } else {
      // Cache hits still need real path/version checks, including registered root aliases.
      await access.verifyRoot();
      await access.files.verify(initial, true);
      if (this.fingerprint(source, await access.files.snapshot(actual)) !== fingerprint) throw changed();
      this.cache.delete(id);
      this.cache.set(id, cached);
    }
    throwIfAborted(signal);
    return { ...structuredClone(cached.metadata), skillId: id, sourceId: source.id, scope: source.scope, relativePath: relative,
      sourceRevision: source.revision, sourceFingerprint: fingerprint, metadataHash: cached.metadataHash, bytes: cached.bytes };
  }

  async discover(signal?: AbortSignal): Promise<SkillCatalogSnapshot> {
    throwIfAborted(signal);
    const entries: SkillDescriptor[] = [], issues: SkillDiagnostic[] = [];
    const candidates: Candidate[] = [];
    let truncated = false;
    const sources = this.options.sources.filter(item => item.enabled).sort((a, b) => a.scope === b.scope ? a.id.localeCompare(b.id, 'en') : a.scope === 'project' ? -1 : 1);
    for (const source of sources) {
      throwIfAborted(signal);
      if (candidates.length >= MAX_CATALOG_ENTRIES) { truncated = true; issues.push(issue('catalog_limit', 'Skill catalog reached its 512 candidate limit.', source.id, undefined, 'warning')); break; }
      try {
        const access = await this.sourceAccess(source, signal);
        let relatives: string[];
        if (source.explicitPaths !== undefined) relatives = [...source.explicitPaths];
        else {
          const listing = await access.files.entries(access.prefix, MAX_SOURCE_ENTRIES, signal);
          await access.verifyRoot();
          if (listing.truncated) { truncated = true; issues.push(issue('source_limit', 'Skill source reached its 256 direct entry limit.', source.id, undefined, 'warning')); }
          relatives = [];
          for (const name of listing.names) {
            try { relatives.push(normalizedSkillPath(`${name}/SKILL.md`)); }
            catch { issues.push(issue('unsafe_path', 'An unsafe or sensitive skill path was omitted.', source.id)); }
          }
        }
        const remaining = MAX_CATALOG_ENTRIES - candidates.length;
        if (relatives.length > remaining) { truncated = true; issues.push(issue('catalog_limit', 'Skill catalog reached its 512 candidate limit.', source.id, undefined, 'warning')); }
        candidates.push(...relatives.slice(0, remaining).map(relative => ({ source, access, relative })));
      } catch (error) {
        throwIfAborted(signal);
        const optionalEmpty = (error as NodeJS.ErrnoException)?.code === 'ENOENT'
          && (source.kind === 'managed' || (source.scope === 'project' && (source.kind === 'project-agents' || source.kind === 'project-claude')));
        if (!optionalEmpty) issues.push(safeIssue(error, source.id));
      }
    }
    // Workers settle together on cancellation so no discarded promise continues disk reads.
    let next = 0;
    const inspected: Array<SkillDescriptor | undefined> = new Array(candidates.length);
    const candidateIssues: Array<SkillDiagnostic | undefined> = new Array(candidates.length);
    const workers = Array.from({ length: Math.min(MAX_PARALLEL_READS, candidates.length) }, async () => {
      while (true) {
        throwIfAborted(signal);
        const index = next++;
        if (index >= candidates.length) return;
        const candidate = candidates[index];
        try { inspected[index] = await this.inspect(candidate, signal); }
        catch (error) {
          throwIfAborted(signal);
          if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT' || candidate.source.explicitPaths !== undefined) candidateIssues[index] = safeIssue(error, candidate.source.id, candidate.relative);
        }
      }
    });
    const results = await Promise.allSettled(workers);
    throwIfAborted(signal);
    for (const result of results) if (result.status === 'rejected') throw result.reason;
    for (let index = 0; index < candidates.length; index++) {
      if (inspected[index]) entries.push(inspected[index]!);
      if (candidateIssues[index]) issues.push(candidateIssues[index]!);
    }
    const active = new Set(entries.map(item => item.skillId));
    for (const [key, cached] of this.cache) if (!active.has(key)) { this.cacheBytes -= cached.cacheBytes; this.cache.delete(key); }
    const shape = { schemaVersion: 1 as const, entries, issues, truncated };
    return { ...shape, revision: contentHash(JSON.stringify(shape)) };
  }

  /** The caller must first enforce membership in its frozen per-run catalog. */
  async loadCatalogSkill(expected: SkillDescriptor, signal?: AbortSignal): Promise<LoadedCatalogSkill> {
    throwIfAborted(signal);
    const source = this.options.sources.find(item => item.id === expected.sourceId);
    if (!source?.enabled || source.scope !== expected.scope || source.revision !== expected.sourceRevision) throw changed();
    const relative = normalizedSkillPath(expected.relativePath);
    if (skillId(this.options.projectId, source, relative) !== expected.skillId || (source.explicitPaths !== undefined && !source.explicitPaths.includes(relative))
      || (source.explicitPaths === undefined && relative.split('/').length !== 2)) throw changed();
    try {
      const access = await this.sourceAccess(source, signal);
      const actual = this.actualPath(access, relative);
      const before = await access.files.snapshot(actual);
      if (this.fingerprint(source, before) !== expected.sourceFingerprint) throw changed();
      const read = await access.files.read(actual, signal);
      await access.verifyRoot();
      await access.files.verify(before, true);
      if (this.fingerprint(source, read.snapshot) !== expected.sourceFingerprint || this.fingerprint(source, await access.files.snapshot(actual)) !== expected.sourceFingerprint) throw changed();
      const metadata = parseSkillMetadata(read.content, { directoryName: relative.split('/').at(-2) });
      if (contentHash(JSON.stringify(metadata)) !== expected.metadataHash) throw changed();
      if (metadata.format === 'invalid') throw new Error('Skill metadata is invalid. Repair the guide and refresh before loading.');
      const body = extractSkillBody(read.content);
      throwIfAborted(signal);
      return { content: read.content, body, version: { skillId: expected.skillId, sourceRevision: source.revision, sourceFingerprint: expected.sourceFingerprint,
        fullFileHash: read.hash, bodyHash: contentHash(body), bytes: read.bytes, format: metadata.format } };
    } catch (error) {
      throwIfAborted(signal);
      if (error instanceof Error && /metadata is invalid/.test(error.message)) throw error;
      throw new Error(safeIssue(error, source.id, relative).message);
    }
  }
}

export async function discoverSkillCatalog(options: SkillRegistryOptions, signal?: AbortSignal): Promise<SkillCatalogSnapshot> {
  return new SkillRegistry(options).discover(signal);
}
export async function loadCatalogSkill(options: SkillRegistryOptions, expected: SkillDescriptor, signal?: AbortSignal): Promise<LoadedCatalogSkill> {
  return new SkillRegistry(options).loadCatalogSkill(expected, signal);
}
/** Same-scope names never silently choose whichever source was scanned first. */
export function resolveCatalogSkill(catalog: SkillCatalogSnapshot, reference: string): SkillResolution {
  const exact = catalog.entries.find(item => item.skillId === reference);
  if (exact) return { status: 'resolved', descriptor: exact, candidates: [exact] };
  const matches = catalog.entries.filter(item => item.name.toLowerCase() === reference.toLowerCase());
  const project = matches.filter(item => item.scope === 'project');
  const candidates = project.length ? project : matches;
  if (candidates.length === 1) return { status: 'resolved', descriptor: candidates[0], candidates };
  return { status: candidates.length ? 'ambiguous' : 'missing', candidates };
}
/** Cursor is bound to the exact catalog revision and query; metadata is never cut mid-field. */
export function listSkillCatalog(catalog: SkillCatalogSnapshot, options: { query?: string; cursor?: string; limit?: number } = {}): SkillCatalogPage {
  const limit = options.limit ?? 64;
  const query = options.query ?? '';
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64 || typeof query !== 'string' || query.length > 256 || /[\x00-\x1f\x7f]/.test(query)) throw new Error('Invalid skill catalog page options.');
  const token = contentHash(JSON.stringify([catalog.revision, query]));
  let offset = 0;
  if (options.cursor !== undefined) {
    const match = /^([a-f0-9]{64}):([0-9]{1,4})$/.exec(options.cursor);
    if (!match || match[1] !== token || !Number.isSafeInteger(offset = Number(match[2])) || offset < 0 || offset > MAX_CATALOG_ENTRIES) throw new Error('Invalid or stale skill catalog cursor.');
  }
  const needle = query.toLowerCase();
  const entries = catalog.entries.filter(item => !needle || `${item.name}\n${item.description}\n${item.sourceId}`.toLowerCase().includes(needle));
  if (offset > entries.length) throw new Error('Invalid skill catalog cursor offset.');
  const next = Math.min(entries.length, offset + limit);
  return { revision: catalog.revision, entries: structuredClone(entries.slice(offset, next)), nextCursor: next < entries.length ? `${token}:${next}` : null };
}
