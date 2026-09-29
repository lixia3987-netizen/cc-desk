export type NativeChangeSetLineEndings = 'none' | 'lf' | 'crlf' | 'cr' | 'mixed';
export interface NativeChangeSetFilePreview {
  index: number; path: string; kind: 'create' | 'replace';
  beforeHash: string | null; afterHash: string; beforeBytes: number; afterBytes: number;
  /** Complete changed region, including line ending and missing-final-newline markers. Not a minimal diff. */
  diff: string;
  lineEndings: { before: NativeChangeSetLineEndings; after: NativeChangeSetLineEndings };
  noFinalNewline: { before: boolean; after: boolean };
}
export interface NativeChangeSetPreview {
  schemaVersion: 1; digest: string; atomic: false;
  files: NativeChangeSetFilePreview[]; totalContentBytes: number; previewBytes: number;
}
/** beforeHash/afterHash are the exact approved old/intended-new versions, not guesses from disk. */
export interface NativeChangeSetFileEvent {
  changeSetDigest: string; index: number; path: string;
  status: 'prepared' | 'applied' | 'not_applied' | 'unknown';
  beforeHash: string | null; afterHash: string; errorCode?: string;
}
export interface NativeChangeSetFileResult {
  index: number; path: string; beforeHash: string | null; afterHash: string;
  status: 'applied' | 'not_applied' | 'unknown'; errorCode?: string;
}
export interface NativeChangeSetResult {
  digest: string; atomic: false; status: 'completed' | 'partial' | 'not_applied' | 'unknown';
  /** False means a host progress or final tool receipt is missing or failed to durably commit. */
  receiptCommitted: boolean;
  files: NativeChangeSetFileResult[]; errorCode?: string;
}

/** Portable UTF-8 accounting; malformed UTF-16 is never accepted as a preview. */
export function nativeChangeSetUtf8Bytes(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes++;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return Infinity;
      bytes += 4;
    } else if (code >= 0xdc00 && code <= 0xdfff) return Infinity;
    else bytes += 3;
  }
  return bytes;
}
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value: unknown, fields: string[]): value is Record<string, unknown> => isObject(value) && Object.keys(value).every(key => fields.includes(key));
const hash = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const bytes = (value: unknown, maximum: number): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= maximum;
const safePath = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 4096 && Number.isFinite(nativeChangeSetUtf8Bytes(value)) && !/[\x00-\x1f\x7f\\:]/.test(value) && !value.startsWith('/') && value.split('/').every(part => part && part !== '.' && part !== '..' && part.toLowerCase() !== '.git');
const ending = (value: unknown): value is NativeChangeSetLineEndings => ['none', 'lf', 'crlf', 'cr', 'mixed'].includes(String(value));
export function isNativeChangeSetPreview(value: unknown): value is NativeChangeSetPreview {
  try {
    if (!exact(value, ['schemaVersion', 'digest', 'atomic', 'files', 'totalContentBytes', 'previewBytes']) || value.schemaVersion !== 1 || value.atomic !== false || !hash(value.digest) || !Array.isArray(value.files) || value.files.length < 1 || value.files.length > 16 || !bytes(value.totalContentBytes, 256 * 1024) || !bytes(value.previewBytes, 128 * 1024)) return false;
    const paths = new Set<string>(); let total = 0, previousBytes = 0;
    for (const [index, file] of value.files.entries()) {
      if (!exact(file, ['index', 'path', 'kind', 'beforeHash', 'afterHash', 'beforeBytes', 'afterBytes', 'diff', 'lineEndings', 'noFinalNewline']) || file.index !== index || !safePath(file.path) || !['create', 'replace'].includes(String(file.kind)) || !(file.beforeHash === null || hash(file.beforeHash)) || !hash(file.afterHash) || !bytes(file.beforeBytes, 4 * 1024 * 1024) || !bytes(file.afterBytes, 256 * 1024) || typeof file.diff !== 'string' || !file.diff.length || !Number.isFinite(nativeChangeSetUtf8Bytes(file.diff))) return false;
      if (file.kind === 'create' ? file.beforeHash !== null || file.beforeBytes !== 0 : !hash(file.beforeHash)) return false;
      if (!exact(file.lineEndings, ['before', 'after']) || !ending(file.lineEndings.before) || !ending(file.lineEndings.after) || !exact(file.noFinalNewline, ['before', 'after']) || typeof file.noFinalNewline.before !== 'boolean' || typeof file.noFinalNewline.after !== 'boolean') return false;
      const key = file.path.normalize('NFC').toLowerCase();
      if (paths.has(key) || [...paths].some(other => key.startsWith(other + '/') || other.startsWith(key + '/'))) return false;
      paths.add(key); total += file.afterBytes; previousBytes += file.beforeBytes;
    }
    return total === value.totalContentBytes && previousBytes <= 4 * 1024 * 1024 && nativeChangeSetUtf8Bytes(JSON.stringify(value)) === value.previewBytes;
  } catch { return false; }
}
export function isNativeChangeSetResult(value: unknown): value is NativeChangeSetResult {
  try {
    if (!exact(value, ['digest', 'atomic', 'status', 'receiptCommitted', 'files', 'errorCode']) || !hash(value.digest) || value.atomic !== false || !['completed', 'partial', 'not_applied', 'unknown'].includes(String(value.status)) || typeof value.receiptCommitted !== 'boolean' || !Array.isArray(value.files) || value.files.length < 1 || value.files.length > 16 || value.errorCode !== undefined && (typeof value.errorCode !== 'string' || !/^[a-z0-9_]{1,64}$/.test(value.errorCode))) return false;
    const paths = new Set<string>();
    for (const [index, file] of value.files.entries()) {
      if (!exact(file, ['index', 'path', 'beforeHash', 'afterHash', 'status', 'errorCode']) || file.index !== index || !safePath(file.path) || !(file.beforeHash === null || hash(file.beforeHash)) || !hash(file.afterHash) || !['applied', 'not_applied', 'unknown'].includes(String(file.status)) || file.errorCode !== undefined && (typeof file.errorCode !== 'string' || !/^[a-z0-9_]{1,64}$/.test(file.errorCode))) return false;
    }
    for (const file of value.files) {
      const key = file.path.normalize('NFC').toLowerCase();
      if (paths.has(key) || [...paths].some(other => key.startsWith(other + '/') || other.startsWith(key + '/'))) return false;
      paths.add(key);
    }
    const applied = value.files.filter(file => file.status === 'applied').length;
    const unknown = value.files.some(file => file.status === 'unknown');
    if (value.status === 'completed') return value.receiptCommitted && applied === value.files.length;
    if (value.status === 'not_applied') return value.receiptCommitted && applied === 0 && !unknown;
    if (value.status === 'partial') return value.receiptCommitted && applied > 0 && applied < value.files.length && !unknown;
    return unknown || !value.receiptCommitted;
  } catch { return false; }
}
