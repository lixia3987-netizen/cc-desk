import path from 'node:path';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { RunIdentity } from '@cc-desk/agent-core';
import { BoundedRegex, BoundedRegexError, type RegexLineMatch } from './bounded-regex.js';
import { contentHash, isSensitivePath, normalizeProjectPath, ProjectFiles, throwIfAborted, type FilePolicyOptions, type PathSnapshot } from './project-files.js';

export interface ProjectSearchOptions extends FilePolicyOptions {
  ownerId: string; maxScanEntries?: number; maxOperationMs?: number;
  maxScanBytes?: number; maxCachedMatches?: number; maxRegexMs?: number;
}
export interface ProjectSearchInput {
  path: string; query?: string; mode?: 'literal' | 'regex' | 'files'; name?: string;
  glob?: string; ignoreDirectories?: string[]; caseSensitive?: boolean; pageSize?: number; cursor?: string;
}
export interface ProjectSearchContext {
  identity: RunIdentity; policyRevision: string; instructionDigest: string; signal: AbortSignal; maxOutputBytes?: number;
}
export interface ProjectSearchMatch {
  path: string; hash: string | null; hashStatus: 'complete' | 'not_read'; identity: string; bytes: number;
  line?: number; column?: number; text?: string; textStartColumn?: number; textTruncated?: boolean;
}
export interface ProjectSearchPage {
  matches: ProjectSearchMatch[];
  /** Whether all in-scope candidates were scanned without omissions or uncertain versions. */
  scanComplete: boolean;
  /** Whether this is the last page of the bounded observed snapshot. */
  pageComplete: boolean;
  complete: boolean; truncated: boolean; truncationReasons: string[];
  nextCursor: string | null;
  /** Exact only for this observed snapshot, never an estimated total for the repository. */
  totalMatches: number;
  scanned: { entries: number; files: number; bytes: number };
  skipped: Record<string, number>;
  scope: { root: string; mode: 'literal' | 'regex' | 'files'; glob?: string; name?: string; ignoreDirectories: string[]; sensitiveFiles: 'excluded'; links: 'excluded' };
  suggestion?: string;
}
export class ProjectSearchError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'ProjectSearchError'; }
}
const DEFAULT_IGNORES = ['.git', 'node_modules', 'dist', 'release', '.next', 'coverage'];
const MAX_SNAPSHOTS = 4, MAX_CACHE_BYTES = 8 * 1024 * 1024, MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
function fail(code: string, message: string): never { throw new ProjectSearchError(code, message); }
function bounded(value: unknown, fallback: number, minimum: number, maximum: number, label: string): number {
  const result = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(result) || (result as number) < minimum || (result as number) > maximum) fail('invalid_search', `Invalid ${label}`);
  return result as number;
}
function text(value: unknown, maximum: number, label: string): asserts value is string {
  if (typeof value !== 'string' || !value.length || value.length > maximum || value.includes('\0')) fail('invalid_search', `Invalid ${label}`);
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).filter(key => (value as Record<string, unknown>)[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
}
/** Restrict glob grammar to literal path segments, ?, *, and a whole-segment **. */
function validateGlob(glob: string): void {
  if (glob.length > 512 || /[\x00-\x1f\x7f\\:[\]{}()!]/.test(glob) || glob.startsWith('/') || glob.split('/').some(part => !part || part === '.' || part === '..' || part.includes('**') && part !== '**') || glob.split('/').length > 32) fail('invalid_search', 'Glob supports only literals, ?, *, and whole-segment **');
}
export function validateProjectSearchInput(input: ProjectSearchInput): ProjectSearchInput {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['path', 'query', 'mode', 'name', 'glob', 'ignoreDirectories', 'caseSensitive', 'pageSize', 'cursor'].includes(key))) fail('invalid_search', 'Unexpected search input fields');
  const root = normalizeProjectPath(input.path, true);
  if (isSensitivePath(root)) fail('invalid_search', 'Search does not traverse sensitive paths');
  const mode = input.mode ?? 'literal';
  if (!['literal', 'regex', 'files'].includes(mode)) fail('invalid_search', 'Invalid search mode');
  if (mode === 'files') { if (input.query !== undefined) fail('invalid_search', 'File-name search does not accept a content query'); }
  else { text(input.query, 512, 'query'); if (input.name !== undefined) fail('invalid_search', 'Content search does not accept a file-name query'); }
  if (input.name !== undefined) { text(input.name, 256, 'name'); if (/[\\/\x00-\x1f\x7f]/.test(input.name)) fail('invalid_search', 'Name must be a literal filename substring'); }
  if (input.glob !== undefined) { text(input.glob, 512, 'glob'); validateGlob(input.glob); }
  if (input.caseSensitive !== undefined && typeof input.caseSensitive !== 'boolean') fail('invalid_search', 'Invalid case sensitivity');
  if (input.ignoreDirectories !== undefined && (!Array.isArray(input.ignoreDirectories) || input.ignoreDirectories.length > 32)) fail('invalid_search', 'Too many ignored directories');
  const ignoreDirectories = [...new Set((input.ignoreDirectories ?? []).map(item => {
    text(item, 512, 'ignored directory'); if (/[?*]/.test(item)) fail('invalid_search', 'Ignored directories are literal names or project-relative paths');
    return normalizeProjectPath(item);
  }))].sort();
  if (input.cursor !== undefined) text(input.cursor, 160, 'cursor');
  return { path: root, mode, ...(input.query !== undefined ? { query: input.query } : {}), ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.glob !== undefined ? { glob: input.glob } : {}), ignoreDirectories, caseSensitive: input.caseSensitive ?? true,
    pageSize: bounded(input.pageSize, 100, 1, 1000, 'page size'), ...(input.cursor !== undefined ? { cursor: input.cursor } : {}) };
}
// Dynamic programming gives a finite O(pattern * path) bound; no glob regex executes.
function segmentMatches(pattern: string, name: string): boolean {
  const characters = [...name];
  let previous = new Uint8Array(characters.length + 1); previous[0] = 1;
  for (const token of pattern) {
    const next = new Uint8Array(characters.length + 1);
    if (token === '*') next[0] = previous[0];
    for (let index = 1; index <= characters.length; index++) next[index] = token === '*' ? Number(Boolean(previous[index] || next[index - 1])) : Number(Boolean(previous[index - 1] && (token === '?' || token === characters[index - 1])));
    previous = next;
  }
  return previous[characters.length] === 1;
}
function globMatches(pattern: string, relative: string, caseSensitive: boolean): boolean {
  if (!caseSensitive) { pattern = pattern.toLowerCase(); relative = relative.toLowerCase(); }
  if (!pattern.includes('/')) return pattern === '**' || segmentMatches(pattern, path.posix.basename(relative));
  const tokens = pattern.split('/'), parts = relative.split('/');
  let previous = new Uint8Array(parts.length + 1); previous[0] = 1;
  for (const token of tokens) {
    const next = new Uint8Array(parts.length + 1); if (token === '**') next[0] = previous[0];
    for (let index = 1; index <= parts.length; index++) next[index] = token === '**' ? Number(Boolean(previous[index] || next[index - 1])) : Number(Boolean(previous[index - 1] && segmentMatches(token, parts[index - 1])));
    previous = next;
  }
  return previous[parts.length] === 1;
}
function version(snapshot: PathSnapshot): string {
  return contentHash(canonical(snapshot.identities.map(({ stat }, index) => ({ dev: String(stat.dev), ino: String(stat.ino), mode: String(stat.mode),
    ...(index === snapshot.identities.length - 1 ? { size: String(stat.size), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) } : {}) }))));
}
interface ObservedVersion { path: string; kind: 'file' | 'directory'; version: string }
interface SearchSnapshot {
  id: string; binding: string; input: ProjectSearchInput; matches: ProjectSearchMatch[]; versions: ObservedVersion[];
  reasons: Set<string>; skipped: Record<string, number>; scanned: ProjectSearchPage['scanned']; bytes: number; createdAt: number;
}
function literalLines(content: string, query: string, caseSensitive: boolean, limit: number, check: () => void): { matches: RegexLineMatch[]; limited: boolean } {
  const matches: RegexLineMatch[] = []; const needle = caseSensitive ? query : query.toLowerCase();
  let offset = 0, line = 1;
  while (offset <= content.length) {
    check(); const newline = content.indexOf('\n', offset), end = newline < 0 ? content.length : newline;
    const value = content.slice(offset, end), normalized = caseSensitive ? value : value.toLowerCase();
    let index = normalized.indexOf(needle);
    if (index >= 0) {
      if (!caseSensitive && normalized.length !== value.length) {
        let folded = 0, original = 0;
        for (const point of value) { if (folded + point.toLowerCase().length > index) break; folded += point.toLowerCase().length; original += point.length; }
        index = original;
      }
      const start = Math.max(0, index - 160);
      matches.push({ line, column: index + 1, text: value.slice(start, start + 512), textStartColumn: start + 1, textTruncated: start > 0 || value.length > start + 512 });
      if (matches.length >= limit && newline >= 0) return { matches, limited: true };
    }
    if (newline < 0) break; offset = newline + 1; line++;
  }
  return { matches, limited: false };
}

/** Bounded snapshots are local to one tool host; a cursor never authorizes another run. */
export class ProjectSearch {
  private readonly files: ProjectFiles;
  private readonly secret = randomBytes(32);
  private readonly snapshots = new Map<string, SearchSnapshot>();
  private readonly validatedPatterns = new Set<string>();
  private readonly maxEntries: number;
  private readonly maxMs: number;
  private readonly maxBytes: number;
  private readonly maxMatches: number;
  private readonly regexMs: number;
  private active = false;
  constructor(private readonly options: ProjectSearchOptions) {
    text(options.ownerId, 512, 'owner id');
    this.files = new ProjectFiles(options);
    this.maxEntries = bounded(options.maxScanEntries, 4000, 1, 20000, 'scan entries');
    this.maxMs = bounded(options.maxOperationMs, 10000, 1, 30000, 'operation time');
    this.maxBytes = bounded(options.maxScanBytes, 8 * 1024 * 1024, 1, 64 * 1024 * 1024, 'scan bytes');
    this.maxMatches = bounded(options.maxCachedMatches, 2000, 1, 4000, 'cached matches');
    this.regexMs = bounded(options.maxRegexMs, 200, 1, 2000, 'regex time');
  }
  async validate(input: ProjectSearchInput, signal?: AbortSignal): Promise<void> {
    input = validateProjectSearchInput(input); throwIfAborted(signal);
    if (input.mode !== 'regex') return;
    const key = canonical([input.query, input.caseSensitive]);
    if (this.validatedPatterns.has(key)) return;
    const worker = await BoundedRegex.create(input.query!, input.caseSensitive!, Math.min(this.maxMs, 1000), signal);
    await worker.close();
    if (this.validatedPatterns.size >= 64) this.validatedPatterns.delete(this.validatedPatterns.values().next().value!);
    this.validatedPatterns.add(key);
  }
  private binding(input: ProjectSearchInput, context: ProjectSearchContext): string {
    const identity = context.identity;
    if (!identity || !Number.isSafeInteger(identity.workerGeneration) || identity.workerGeneration < 1) fail('invalid_search', 'Invalid search run identity');
    for (const value of [identity.sessionId, identity.conversationId, identity.runId, identity.requestId, context.policyRevision, context.instructionDigest]) text(value, 2048, 'search binding');
    const { cursor: _cursor, ...query } = input;
    return contentHash(canonical({ ownerId: this.options.ownerId, projectRoot: path.resolve(this.options.projectRoot), identity, policyRevision: context.policyRevision, instructionDigest: context.instructionDigest, query }));
  }
  private cursor(snapshot: SearchSnapshot, offset: number): string {
    const payload = `${snapshot.id}.${offset}`;
    return `${payload}.${createHmac('sha256', this.secret).update(payload).digest('hex')}`;
  }
  private decode(cursor: string, binding: string): { snapshot: SearchSnapshot; offset: number } {
    const parts = cursor.split('.');
    if (parts.length !== 3 || !/^[a-f0-9-]{36}$/.test(parts[0]) || !/^(?:0|[1-9]\d{0,4})$/.test(parts[1]) || !/^[a-f0-9]{64}$/.test(parts[2])) fail('invalid_cursor', 'Invalid search cursor; start a new search');
    const expected = createHmac('sha256', this.secret).update(`${parts[0]}.${parts[1]}`).digest();
    if (!timingSafeEqual(expected, Buffer.from(parts[2], 'hex'))) fail('invalid_cursor', 'Search cursor signature does not match this tool host');
    const snapshot = this.snapshots.get(parts[0]), offset = Number(parts[1]);
    if (!snapshot || Date.now() - snapshot.createdAt > 5 * 60_000) { this.snapshots.delete(parts[0]); fail('cursor_expired', 'Bounded search snapshot expired or was evicted; start a new search'); }
    if (snapshot.binding !== binding) fail('cursor_binding_changed', 'Search cursor belongs to another query, run, owner, policy or instruction revision');
    if (offset < 1 || offset >= snapshot.matches.length) fail('invalid_cursor', 'Search cursor offset is outside the observed snapshot');
    return { snapshot, offset };
  }
  private async verify(snapshot: SearchSnapshot, signal: AbortSignal, deadline: number): Promise<void> {
    for (const observed of snapshot.versions) {
      throwIfAborted(signal);
      if (performance.now() >= deadline) fail('verification_time_limit', 'Search version validation exceeded its deadline; narrow the path');
      try {
        const current = await this.files.snapshot(observed.path, observed.kind);
        if (version(current) !== observed.version) fail('cursor_stale', 'A scanned file or directory changed; start a new search');
      } catch (error) {
        throwIfAborted(signal);
        if (error instanceof ProjectSearchError) throw error;
        fail('cursor_stale', 'A scanned file or directory is no longer available; start a new search');
      }
    }
    throwIfAborted(signal);
  }
  async search(raw: ProjectSearchInput, context: ProjectSearchContext): Promise<ProjectSearchPage> {
    const input = validateProjectSearchInput(raw), binding = this.binding(input, context);
    const outputBudget = bounded(context.maxOutputBytes, 64 * 1024, 512, 4 * 1024 * 1024, 'search output budget');
    throwIfAborted(context.signal);
    if (this.active) fail('search_busy', 'Another search is still using this tool host');
    this.active = true;
    try {
      const deadline = performance.now() + this.maxMs;
      if (input.cursor) {
        const { snapshot, offset } = this.decode(input.cursor, binding);
        try { await this.verify(snapshot, context.signal, deadline); }
        catch (error) { this.snapshots.delete(snapshot.id); throw error; }
        return this.page(snapshot, offset, outputBudget);
      }
      const snapshot = await this.scan(input, context, binding, deadline);
      this.snapshots.set(snapshot.id, snapshot);
      while (this.snapshots.size > MAX_SNAPSHOTS || [...this.snapshots.values()].reduce((sum, item) => sum + item.bytes, 0) > MAX_CACHE_BYTES) this.snapshots.delete(this.snapshots.keys().next().value!);
      try { return this.page(snapshot, 0, outputBudget); }
      catch (error) { this.snapshots.delete(snapshot.id); throw error; }
    } finally { this.active = false; }
  }
  private async scan(input: ProjectSearchInput, context: ProjectSearchContext, binding: string, deadline: number): Promise<SearchSnapshot> {
    const snapshot: SearchSnapshot = { id: randomUUID(), binding, input, matches: [], versions: [], reasons: new Set(), skipped: {}, scanned: { entries: 0, files: 0, bytes: 0 }, bytes: 0, createdAt: Date.now() };
    const ignored = [...DEFAULT_IGNORES, ...input.ignoreDirectories!];
    if (input.path !== '.' && ignored.some(item => item.includes('/') ? input.path === item || input.path.startsWith(item + '/') : input.path.split('/').includes(item))) fail('ignored_search_root', 'Search root is inside an ignored directory; choose another scope or use an explicit read_file');
    let matcher: BoundedRegex | undefined;
    const check = () => { throwIfAborted(context.signal); if (performance.now() >= deadline) fail('time_limit', 'Search exceeded its operation time budget'); };
    const skip = (reason: string, incomplete = false) => { snapshot.skipped[reason] = (snapshot.skipped[reason] ?? 0) + 1; if (incomplete) snapshot.reasons.add(reason); };
    const remember = (observed: PathSnapshot) => {
      const record = { path: observed.relative, kind: observed.kind, version: version(observed) };
      const bytes = Buffer.byteLength(JSON.stringify(record));
      if (snapshot.bytes + bytes > MAX_SNAPSHOT_BYTES) fail('snapshot_byte_limit', 'Bounded search snapshot capacity reached');
      snapshot.versions.push(record); snapshot.bytes += bytes;
    };
    const append = (match: ProjectSearchMatch) => {
      const bytes = Buffer.byteLength(JSON.stringify(match));
      if (snapshot.bytes + bytes > MAX_SNAPSHOT_BYTES) fail('snapshot_byte_limit', 'Bounded search snapshot capacity reached');
      snapshot.matches.push(match); snapshot.bytes += bytes;
      if (snapshot.matches.length >= this.maxMatches) fail('match_limit', 'Bounded observed match limit reached');
    };
    const ignoredDirectory = (relative: string, name: string) => ignored.some(item => item.includes('/') ? relative === item : name === item);
    const visit = async (directory: string, depth: number): Promise<void> => {
      check();
      if (depth > 20) { skip('depth_limit', true); return; }
      if (snapshot.scanned.entries >= this.maxEntries) fail('entry_limit', 'Search entry limit reached');
      const observed = await this.files.snapshot(directory, 'directory'); remember(observed);
      const listed = await this.files.entries(directory, this.maxEntries - snapshot.scanned.entries, context.signal);
      if (listed.truncated) snapshot.reasons.add('entry_limit');
      for (const name of listed.names) {
        check(); if (snapshot.scanned.entries >= this.maxEntries) fail('entry_limit', 'Search entry limit reached');
        snapshot.scanned.entries++;
        const relative = directory === '.' ? name : `${directory}/${name}`;
        if (name.toLowerCase() === '.git' || isSensitivePath(relative)) { skip('policy_excluded'); continue; }
        try { normalizeProjectPath(relative); }
        catch { skip('unsafe_path', true); continue; }
        let observedFile: PathSnapshot;
        try { observedFile = await this.files.snapshot(relative); }
        catch {
          try {
            await this.files.snapshot(relative, 'directory');
            if (ignoredDirectory(relative, name)) skip('ignored_directory'); else await visit(relative, depth + 1);
          } catch (error) {
            throwIfAborted(context.signal);
            if (error instanceof ProjectSearchError) throw error;
            const code = (error as NodeJS.ErrnoException).code;
            // Do not reveal a protected root or follow any link merely to classify the failure.
            if (String((error as Error)?.message).includes('Protected path')) skip('policy_excluded');
            else skip(code === 'ENOENT' ? 'changed_during_scan' : 'unreadable_or_link', true);
          }
          continue;
        }
        // Metadata for all ordinary candidates participates in cursor validity,
        // including scoped AGENTS/CLAUDE files excluded by a filename glob.
        remember(observedFile);
        const within = input.path === '.' ? relative : relative.slice(input.path.length + 1);
        if (input.glob && !globMatches(input.glob, within, input.caseSensitive!)) { skip('glob_excluded'); continue; }
        const basename = path.posix.basename(relative);
        if (input.name && !(input.caseSensitive ? basename.includes(input.name) : basename.toLowerCase().includes(input.name.toLowerCase()))) { skip('name_excluded'); continue; }
        const stat = observedFile.identities.at(-1)!.stat;
        if (stat.size > BigInt(Number.MAX_SAFE_INTEGER)) { skip('file_size_unrepresentable', true); continue; }
        const bytes = Number(stat.size), identity = version(observedFile);
        snapshot.scanned.files++;
        if (input.mode === 'files') { append({ path: relative, hash: null, hashStatus: 'not_read', identity, bytes }); continue; }
        if (bytes > this.files.maxFileBytes) { skip('file_byte_limit', true); continue; }
        if (snapshot.scanned.bytes + bytes > this.maxBytes) { skip('scan_byte_limit', true); continue; }
        // Invalid UTF-8 and binary reads still consume I/O budget. Reserve before reading.
        snapshot.scanned.bytes += bytes;
        try {
          const file = await this.files.read(relative, context.signal, bytes);
          snapshot.scanned.bytes += Math.max(0, file.bytes - bytes);
          if (snapshot.scanned.bytes > this.maxBytes) { skip('scan_byte_limit', true); continue; }
          if (version(file.snapshot) !== identity) { skip('changed_during_scan', true); continue; }
          check();
          const remaining = this.maxMatches - snapshot.matches.length;
          const found = matcher
            ? await matcher.match(file.content, remaining, Math.min(this.regexMs, Math.max(1, deadline - performance.now())), context.signal)
            : literalLines(file.content, input.query!, input.caseSensitive!, remaining, check);
          for (const hit of found.matches) append({ path: file.path, hash: file.hash, hashStatus: 'complete', identity, bytes: file.bytes, ...hit });
          if (found.limited) snapshot.reasons.add('match_limit');
        } catch (error) {
          throwIfAborted(context.signal);
          if (error instanceof ProjectSearchError) throw error;
          if (error instanceof BoundedRegexError) { if (error.code === 'search_cancelled' || error.code === 'invalid_regex') throw error; snapshot.reasons.add(error.code); break; }
          const message = String((error as Error)?.message);
          skip(message.includes('UTF-8') ? 'invalid_encoding' : message.includes('Binary') ? 'binary_file' : message.includes('byte limit') ? 'file_byte_limit' : 'unreadable_or_changed', true);
        }
      }
    };
    try {
      // Root scope is validated even if the first operation cannot fit its scan budget.
      await this.files.snapshot(input.path, 'directory');
      if (input.mode === 'regex') matcher = await BoundedRegex.create(input.query!, input.caseSensitive!, Math.min(1000, Math.max(1, deadline - performance.now())), context.signal);
      await visit(input.path, 0);
    } catch (error) {
      throwIfAborted(context.signal);
      if (error instanceof ProjectSearchError && ['time_limit', 'entry_limit', 'match_limit', 'snapshot_byte_limit'].includes(error.code)) snapshot.reasons.add(error.code);
      else if (error instanceof BoundedRegexError && error.code !== 'invalid_regex' && error.code !== 'search_cancelled') snapshot.reasons.add(error.code);
      else throw error;
    } finally { await matcher?.close(); }
    try { await this.verify(snapshot, context.signal, deadline); }
    catch (error) {
      throwIfAborted(context.signal);
      if (error instanceof ProjectSearchError) snapshot.reasons.add(error.code === 'cursor_stale' ? 'changed_during_scan' : error.code); else throw error;
    }
    return snapshot;
  }
  private page(snapshot: SearchSnapshot, offset: number, budget: number): ProjectSearchPage {
    const remaining = snapshot.matches.slice(offset, offset + snapshot.input.pageSize!);
    let outputLimited = false;
    const build = (): ProjectSearchPage => {
      const pageComplete = offset + remaining.length >= snapshot.matches.length, scanComplete = snapshot.reasons.size === 0;
      const reasons = [...snapshot.reasons];
      if (offset + snapshot.input.pageSize! < snapshot.matches.length) reasons.push('page_limit');
      if (outputLimited) reasons.push('output_byte_limit');
      return { matches: remaining, scanComplete, pageComplete, complete: scanComplete && pageComplete, truncated: !scanComplete || !pageComplete,
        truncationReasons: reasons, nextCursor: pageComplete ? null : this.cursor(snapshot, offset + remaining.length), totalMatches: snapshot.matches.length,
        scanned: { ...snapshot.scanned }, skipped: { ...snapshot.skipped },
        scope: { root: snapshot.input.path, mode: snapshot.input.mode!, ...(snapshot.input.glob ? { glob: snapshot.input.glob } : {}), ...(snapshot.input.name ? { name: snapshot.input.name } : {}),
          ignoreDirectories: [...new Set([...DEFAULT_IGNORES, ...snapshot.input.ignoreDirectories!])], sensitiveFiles: 'excluded', links: 'excluded' },
        ...(!scanComplete ? { suggestion: 'Scan incomplete: narrow path/glob/name, simplify regex, or split the query. The cursor pages only the observed bounded snapshot, not the unscanned repository.' } : {}) };
    };
    let result = build();
    while (Buffer.byteLength(JSON.stringify(result)) > budget && remaining.length) { remaining.pop(); outputLimited = true; result = build(); if (!remaining.length && snapshot.matches.length > offset) break; }
    if (Buffer.byteLength(JSON.stringify(result)) > budget || !remaining.length && snapshot.matches.length > offset) fail('output_budget_exceeded', 'Search result metadata or one match exceeds the output budget; narrow the query or increase the host tool budget');
    return JSON.parse(JSON.stringify(result)) as ProjectSearchPage;
  }
}
