import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  isNativeChangeSetPreview, isNativeChangeSetResult, nativeChangeSetUtf8Bytes,
  type NativeChangeSetFileEvent, type NativeChangeSetFilePreview, type NativeChangeSetFileResult,
  type NativeChangeSetLineEndings, type NativeChangeSetPreview, type NativeChangeSetResult,
} from '@cc-desk/contracts/native-changes';
import { contentHash, isSensitivePath, normalizeProjectPath, ProjectFiles, throwIfAborted, type FilePolicyOptions, type PatchInput, type PreparedPatch } from './project-files.js';

export const CHANGE_SET_LIMITS = { files: 16, contentBytes: 256 * 1024, previousBytes: 4 * 1024 * 1024, previewBytes: 128 * 1024, diffLines: 50000, preparedBytes: 16 * 1024 * 1024, preparedSets: 32 } as const;
export interface ChangeSetInput { changes: PatchInput[] }
export interface ProjectChangeSetOptions extends FilePolicyOptions { protectedPaths?: readonly string[]; forbiddenValues?: readonly string[] }
export interface PreparedChangeSet { id: string; digest: string; input: ChangeSetInput; preview: NativeChangeSetPreview; resultMaxBytes: number }
export interface ChangeSetApplyOptions {
  signal: AbortSignal;
  /** Check exact run ownership, approval, policy and every applicable instruction scope. */
  assertCurrent(): void | Promise<void>;
  /** Must durably commit before resolving. Completion receipts must survive cancellation. */
  record(event: NativeChangeSetFileEvent): Promise<void>;
}
export class ChangeSetError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'ChangeSetError'; }
}
function fail(code: string, message: string): never { throw new ChangeSetError(code, message); }
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const canonical = (value: unknown): string => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
const pathKey = (value: string) => value.normalize('NFC').toLowerCase();
const forbiddenRule = (relative: string) => ['agents.md', 'claude.md'].includes(path.posix.basename(relative).toLowerCase());

/** Complete static validation precedes all project reads. Paths retain their exact spelling. */
export function validateChangeSetInput(value: unknown, protectedPaths: readonly string[] = []): ChangeSetInput {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => key !== 'changes')) fail('invalid_change_set', 'Expected only a changes array');
  const changes = (value as ChangeSetInput).changes;
  if (!Array.isArray(changes) || changes.length < 1 || changes.length > CHANGE_SET_LIMITS.files) fail('invalid_change_set', 'A change set must contain 1–16 files');
  const blocked = new Set(protectedPaths.map(relative => pathKey(normalizeProjectPath(relative))));
  const paths = new Set<string>(); let contentBytes = 0;
  const normalized = changes.map(change => {
    if (!change || typeof change !== 'object' || Array.isArray(change) || Object.keys(change).some(key => !['path', 'content', 'expectedHash'].includes(key))) fail('invalid_change_set', 'Unexpected change fields');
    const relative = normalizeProjectPath(change.path), key = pathKey(relative);
    if (!Number.isFinite(nativeChangeSetUtf8Bytes(relative))) fail('invalid_change_set', 'Paths require valid UTF-8 text');
    if (isSensitivePath(relative)) fail('sensitive_batch_path', 'Sensitive files require separate, individually approved operations');
    if (forbiddenRule(relative) || blocked.has(key)) fail('instruction_batch_path', 'Project instructions and selected Skills cannot be changed in a batch');
    if (paths.has(key) || [...paths].some(other => key.startsWith(other + '/') || other.startsWith(key + '/'))) fail('aliased_batch_path', 'Duplicate, Unicode/case aliases and parent/child paths are not allowed');
    paths.add(key);
    if (typeof change.content !== 'string' || change.content.includes('\0')) fail('invalid_change_set', 'Changes require UTF-8 text without NUL bytes');
    const bytes = nativeChangeSetUtf8Bytes(change.content); contentBytes += bytes;
    if (!Number.isFinite(bytes) || contentBytes > CHANGE_SET_LIMITS.contentBytes) fail('change_set_too_large', 'New content exceeds the 256 KiB batch limit; split the change set');
    if (change.expectedHash !== null && (typeof change.expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(change.expectedHash))) fail('invalid_change_set', 'Each existing file needs its complete previous SHA-256 hash');
    if (change.expectedHash !== null && contentHash(change.content) === change.expectedHash) fail('unchanged_file', 'Omit files whose complete content is unchanged');
    return { path: relative, content: change.content, expectedHash: change.expectedHash };
  });
  return { changes: normalized };
}
function lines(value: string, budget: { remaining: number }): string[] {
  const result: string[] = []; let start = 0;
  for (let index = 0; index < value.length; index++) {
    if (value[index] !== '\r' && value[index] !== '\n') continue;
    if (value[index] === '\r' && value[index + 1] === '\n') index++;
    if (--budget.remaining < 0) fail('change_set_too_large', 'Diff line budget exceeded; split the change set');
    result.push(value.slice(start, index + 1)); start = index + 1;
  }
  if (start < value.length) { if (--budget.remaining < 0) fail('change_set_too_large', 'Diff line budget exceeded; split the change set'); result.push(value.slice(start)); }
  return result;
}
function ending(line: string): 'LF' | 'CRLF' | 'CR' | 'no newline' { return line.endsWith('\r\n') ? 'CRLF' : line.endsWith('\n') ? 'LF' : line.endsWith('\r') ? 'CR' : 'no newline'; }
function endings(source: string[]): NativeChangeSetLineEndings {
  const kinds = new Set(source.map(ending).filter(value => value !== 'no newline'));
  return kinds.size > 1 ? 'mixed' : (kinds.values().next().value?.toLowerCase() ?? 'none') as NativeChangeSetLineEndings;
}
function renderLine(prefix: string, value: string): string {
  const label = ending(value), payload = label === 'CRLF' ? value.slice(0, -2) : label === 'no newline' ? value : value.slice(0, -1);
  // JSON-escaped lines make CR/LF, tabs and literal marker-like text unambiguous in a renderer <pre>.
  return `${prefix}${JSON.stringify(payload)} [${label}]\n`;
}
function previewFile(index: number, patch: PreparedPatch, budget: { remaining: number }): NativeChangeSetFilePreview {
  const before = lines(patch.previous?.content ?? '', budget), after = lines(patch.input.content, budget);
  let prefix = 0, suffix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - suffix - 1] === after[after.length - suffix - 1]) suffix++;
  const start = Math.max(0, prefix - 3), trailing = Math.min(suffix, 3);
  const oldCount = before.length - suffix + trailing - start, newCount = after.length - suffix + trailing - start;
  const oldLabel = patch.previous ? JSON.stringify(`a/${patch.input.path}`) : '/dev/null';
  let diff = `--- ${oldLabel}\n+++ ${JSON.stringify(`b/${patch.input.path}`)}\n@@ -${oldCount ? start + 1 : start},${oldCount} +${newCount ? start + 1 : start},${newCount} @@\n`;
  for (let index = start; index < prefix; index++) diff += renderLine(' ', before[index]);
  for (let index = prefix; index < before.length - suffix; index++) diff += renderLine('-', before[index]);
  for (let index = prefix; index < after.length - suffix; index++) diff += renderLine('+', after[index]);
  for (let index = before.length - suffix; index < before.length - suffix + trailing; index++) diff += renderLine(' ', before[index]);
  return { index, path: patch.input.path, kind: patch.previous ? 'replace' : 'create', beforeHash: patch.previous?.hash ?? null, afterHash: contentHash(patch.input.content),
    beforeBytes: patch.previous?.bytes ?? 0, afterBytes: nativeChangeSetUtf8Bytes(patch.input.content), diff,
    lineEndings: { before: endings(before), after: endings(after) },
    noFinalNewline: { before: !!before.length && ending(before.at(-1)!) === 'no newline', after: !!after.length && ending(after.at(-1)!) === 'no newline' } };
}
interface InternalChangeSet { public: PreparedChangeSet; encoded: string; patches: PreparedPatch[]; execution?: Promise<NativeChangeSetResult> }

export class ProjectChangeSet {
  private readonly files: ProjectFiles;
  private readonly prepared = new Map<string, InternalChangeSet>();
  private preparedBytes = 0;
  private preparing: Promise<void> = Promise.resolve();
  private pendingPreparations = 0;
  constructor(private readonly options: ProjectChangeSetOptions) { this.files = new ProjectFiles(options); }
  private secrets(value: string): void { if (this.options.forbiddenValues?.some(secret => secret.length > 0 && value.includes(secret))) fail('secret_rejected', 'Protected credential values cannot enter a change set'); }
  async prepare(value: ChangeSetInput, signal?: AbortSignal): Promise<PreparedChangeSet> {
    const input = validateChangeSetInput(value, this.options.protectedPaths); this.secrets(JSON.stringify(input));
    for (const change of input.changes) { this.secrets(change.path); this.secrets(change.content); }
    // Serialize preparation so concurrent callers cannot exceed the retained-set cap or
    // multiply the bounded previous-content read buffers while awaiting file IO.
    if (this.prepared.size + this.pendingPreparations >= CHANGE_SET_LIMITS.preparedSets) fail('change_set_capacity', 'Prepared change-set limit reached');
    this.pendingPreparations++;
    const operation = this.preparing.then(() => this.prepareValidated(input, signal)).finally(() => { this.pendingPreparations--; });
    this.preparing = operation.then(() => undefined, () => undefined);
    return operation;
  }
  private async prepareValidated(input: ChangeSetInput, signal?: AbortSignal): Promise<PreparedChangeSet> {
    if (this.prepared.size >= CHANGE_SET_LIMITS.preparedSets) fail('change_set_capacity', 'Prepared change-set limit reached');
    throwIfAborted(signal);
    const patches: PreparedPatch[] = [], objects = new Set<string>(); let oldBytes = 0, retainedBytes = 0;
    for (const change of input.changes) {
      throwIfAborted(signal);
      let patch: PreparedPatch;
      if (change.expectedHash === null) patch = await this.files.preparePatch(change, signal);
      else {
        const parent = await this.files.snapshot(path.posix.dirname(change.path), 'directory');
        const remaining = Math.min(this.files.maxFileBytes, CHANGE_SET_LIMITS.previousBytes - oldBytes);
        const previous = await this.files.read(change.path, signal, remaining);
        if (previous.hash !== change.expectedHash) fail('version_conflict', 'A file changed; read current versions before preparing another change set');
        patch = { input: change, parent, previous };
      }
      if (patch.previous) {
        this.secrets(patch.previous.content); oldBytes += patch.previous.bytes;
        const stat = patch.previous.snapshot.identities.at(-1)!.stat, objectId = `${stat.dev}:${stat.ino}`;
        if (objects.has(objectId)) fail('aliased_batch_path', 'Multiple changes refer to the same existing file object'); objects.add(objectId);
      }
      this.secrets(change.content);
      retainedBytes += (patch.previous?.bytes ?? 0) + nativeChangeSetUtf8Bytes(change.content);
      if (this.preparedBytes + retainedBytes > CHANGE_SET_LIMITS.preparedBytes) fail('change_set_capacity', 'Prepared change-set byte limit reached');
      patches.push(patch);
    }
    const lineBudget = { remaining: CHANGE_SET_LIMITS.diffLines }, previews = patches.map((patch, index) => previewFile(index, patch, lineBudget));
    const previewBody = { schemaVersion: 1 as const, atomic: false as const, files: previews, totalContentBytes: input.changes.reduce((total, item) => total + nativeChangeSetUtf8Bytes(item.content), 0) };
    const digest = contentHash(canonical({ input, preview: previewBody }));
    const preview: NativeChangeSetPreview = { ...previewBody, digest, previewBytes: 0 };
    for (let index = 0; index < 4; index++) preview.previewBytes = nativeChangeSetUtf8Bytes(JSON.stringify(preview));
    if (!isNativeChangeSetPreview(preview)) fail('change_set_too_large', 'The complete preview exceeds 128 KiB; split the change set rather than approving truncated content');
    const worst = { digest, atomic: false, status: 'not_applied', receiptCommitted: false, errorCode: 'x'.repeat(64), files: previews.map(file => ({ index: file.index, path: file.path, beforeHash: file.beforeHash, afterHash: file.afterHash, status: 'not_applied', errorCode: 'x'.repeat(64) })) };
    const result: PreparedChangeSet = { id: randomUUID(), digest, input, preview, resultMaxBytes: nativeChangeSetUtf8Bytes(JSON.stringify(worst)) };
    const encoded = canonical(result);
    retainedBytes += Buffer.byteLength(encoded);
    if (this.preparedBytes + retainedBytes > CHANGE_SET_LIMITS.preparedBytes) fail('change_set_capacity', 'Prepared change-set byte limit reached');
    this.preparedBytes += retainedBytes;
    this.prepared.set(result.id, { public: clone(result), encoded, patches });
    return clone(result);
  }
  private state(prepared: PreparedChangeSet): InternalChangeSet {
    const state = this.prepared.get(prepared.id);
    if (!state || canonical(prepared) !== state.encoded) fail('changed_change_set', 'The prepared change set or complete preview changed');
    return state;
  }
  private async validateFile(patch: PreparedPatch, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal); await this.files.verify(patch.parent);
    if (patch.previous) await this.files.verify(patch.previous.snapshot, true);
    await this.files.preparePatch(patch.input, signal);
    throwIfAborted(signal);
  }
  async validate(prepared: PreparedChangeSet, signal?: AbortSignal): Promise<void> {
    const state = this.state(prepared);
    if (state.execution) fail('change_set_executed', 'An executed or uncertain change set cannot be revalidated for replay');
    for (const patch of state.patches) await this.validateFile(patch, signal);
  }
  async apply(prepared: PreparedChangeSet, options: ChangeSetApplyOptions): Promise<NativeChangeSetResult> {
    const state = this.state(prepared);
    if (typeof options.record !== 'function' || typeof options.assertCurrent !== 'function') fail('receipt_required', 'Durable per-file progress and ownership checks are required');
    state.execution ??= this.execute(state, options);
    return clone(await state.execution);
  }
  private async execute(state: InternalChangeSet, options: ChangeSetApplyOptions): Promise<NativeChangeSetResult> {
    const result: NativeChangeSetResult = { digest: state.public.digest, atomic: false, status: 'not_applied', receiptCommitted: true,
      files: state.public.preview.files.map(file => ({ index: file.index, path: file.path, beforeHash: file.beforeHash, afterHash: file.afterHash, status: 'not_applied', errorCode: 'not_attempted' })) };
    const guard = async () => { throwIfAborted(options.signal); await options.assertCurrent(); throwIfAborted(options.signal); };
    const record = async (file: NativeChangeSetFileResult, status: NativeChangeSetFileEvent['status'], errorCode?: string): Promise<boolean> => {
      try { await options.record({ changeSetDigest: result.digest, index: file.index, path: file.path, beforeHash: file.beforeHash, afterHash: file.afterHash, status, ...(errorCode ? { errorCode } : {}) }); return true; }
      catch { result.status = 'unknown'; result.receiptCommitted = false; result.errorCode = 'receipt_not_committed'; return false; }
    };
    const stopped = async (start: number, reason: string): Promise<NativeChangeSetResult> => {
      for (let index = start; index < result.files.length; index++) {
        const file = result.files[index]; file.status = 'not_applied'; file.errorCode = index === start ? reason : 'not_attempted_after_stop';
        if (!await record(file, 'not_applied', file.errorCode)) return result;
      }
      if (result.status !== 'unknown') result.status = result.files.some(file => file.status === 'applied') ? 'partial' : 'not_applied';
      result.errorCode ??= reason; return result;
    };
    try { await guard(); for (const patch of state.patches) await this.validateFile(patch, options.signal); await guard(); }
    catch { return stopped(0, options.signal.aborted ? 'cancelled' : 'preflight_changed'); }
    for (const [index, patch] of state.patches.entries()) {
      const file = result.files[index];
      try { await guard(); await this.validateFile(patch, options.signal); }
      catch { return stopped(index, options.signal.aborted ? 'cancelled' : 'preconditions_changed'); }
      if (!await record(file, 'prepared')) return result;
      try { await guard(); await this.validateFile(patch, options.signal); await guard(); }
      catch { return stopped(index, options.signal.aborted ? 'cancelled' : 'preconditions_changed'); }
      try { await this.files.applyPatch(patch, options.signal, guard); }
      catch {
        file.status = 'unknown'; file.errorCode = 'write_outcome_unknown'; result.status = 'unknown'; result.errorCode = 'write_outcome_unknown';
        if (!await record(file, 'unknown', file.errorCode)) return result;
        return index + 1 < result.files.length ? stopped(index + 1, 'not_attempted_after_stop') : result;
      }
      file.status = 'applied'; delete file.errorCode;
      if (!await record(file, 'applied')) { file.status = 'unknown'; file.errorCode = 'receipt_not_committed'; return result; }
    }
    result.status = 'completed';
    if (!isNativeChangeSetResult(result)) fail('invalid_change_set_result', 'Host change-set result violated its contract');
    return result;
  }
}
