import { canonicalJson, type JsonValue } from '@cc-desk/agent-core';
import { createHash } from 'node:crypto';
import { isSkillVersionSnapshot, normalizeSkillInheritanceContext, type SkillCatalogSnapshot, type SkillDescriptor,
  type SkillInheritanceContext, type SkillVersionSnapshot } from '@cc-desk/contracts/native-skills';

export const MAX_NATIVE_SKILL_INHERITANCE_BYTES = 512 * 1024;
/** Host attestation only. Absolute source roots remain in the runtime's private captured capability. */
export interface NativeSkillInheritanceManifest {
  schemaVersion: 1;
  context: SkillInheritanceContext;
  catalog: SkillCatalogSnapshot;
  versions: SkillVersionSnapshot[];
  excludedSkillIds: string[];
  digest: string;
}
export const nativeSkillInheritanceDigest = (value: Omit<NativeSkillInheritanceManifest, 'digest'>): string =>
  createHash('sha256').update(canonicalJson(value as unknown as JsonValue)).digest('hex');
const same = (left: unknown, right: unknown) => canonicalJson(left as JsonValue) === canonicalJson(right as JsonValue);
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const skillId = (value: unknown): value is string => typeof value === 'string' && /^skill:[a-f0-9]{64}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, maximum: number) => typeof value === 'string' && value.length <= maximum && !value.includes('\0');
const exactKeys = (value: Record<string, unknown>, allowed: readonly string[], required = allowed) =>
  Object.keys(value).every(key => allowed.includes(key)) && required.every(key => Object.hasOwn(value, key));

/** Snapshot data properties before validation; accessors and custom JSON hooks are never invoked. */
function data(value: unknown, depth = 0, budget = { bytes: 0, nodes: 0 }): unknown {
  budget.nodes++;
  budget.bytes += typeof value === 'string' ? Buffer.byteLength(value) : 1;
  if (depth > 24 || budget.nodes > 65536 || budget.bytes > MAX_NATIVE_SKILL_INHERITANCE_BYTES) throw new Error('Invalid skill inheritance manifest.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value || typeof value !== 'object') throw new Error('Invalid skill inheritance manifest.');
  const prototype = Object.getPrototypeOf(value), properties = Object.getOwnPropertyDescriptors(value);
  if (Array.isArray(value)) {
    const length = properties.length?.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > 1024 || Reflect.ownKeys(properties).length !== length + 1) throw new Error('Invalid skill inheritance manifest.');
    return Array.from({ length }, (_, index) => {
      const property = properties[index];
      if (!property || !Object.hasOwn(property, 'value')) throw new Error('Invalid skill inheritance manifest.');
      return data(property.value, depth + 1, budget);
    });
  }
  if (prototype !== Object.prototype && prototype !== null || Reflect.ownKeys(properties).length > 128) throw new Error('Invalid skill inheritance manifest.');
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(properties)) {
    const property = properties[key as string];
    if (typeof key !== 'string' || !property || !Object.hasOwn(property, 'value')) throw new Error('Invalid skill inheritance manifest.');
    budget.bytes += Buffer.byteLength(key);
    result[key] = data(property.value, depth + 1, budget);
  }
  return result;
}
function diagnostics(value: unknown): boolean {
  return Array.isArray(value) && value.length <= 512 && value.every(item => object(item)
    && exactKeys(item, ['code', 'message', 'severity', 'sourceId', 'path'], ['code', 'message', 'severity'])
    && text(item.code, 256) && text(item.message, 32768) && ['error', 'warning'].includes(item.severity as string)
    && (item.sourceId === undefined || text(item.sourceId, 128)) && (item.path === undefined || text(item.path, 4096)));
}
function descriptor(value: unknown): value is SkillDescriptor {
  const required = ['format', 'name', 'description', 'autoMatchable', 'diagnostics', 'headerBytes', 'skillId', 'sourceId', 'scope',
    'relativePath', 'sourceRevision', 'sourceFingerprint', 'metadataHash', 'bytes'];
  const optional = ['license', 'compatibility', 'metadata', 'allowedTools', 'unknownFields'];
  if (!object(value) || !exactKeys(value, [...required, ...optional], required) || !skillId(value.skillId)
    || !text(value.name, 1024) || !text(value.description, 32768) || !text(value.sourceId, 128)
    || !['project', 'user'].includes(value.scope as string) || !text(value.relativePath, 4096)
    || !['legacy', 'standard'].includes(value.format as string) || typeof value.autoMatchable !== 'boolean'
    || !diagnostics(value.diagnostics) || !Number.isSafeInteger(value.headerBytes) || (value.headerBytes as number) < 0
    || !Number.isSafeInteger(value.sourceRevision) || (value.sourceRevision as number) < 1
    || !hash(value.sourceFingerprint) || !hash(value.metadataHash) || !Number.isSafeInteger(value.bytes)
    || (value.bytes as number) < 0 || (value.bytes as number) > 32768) return false;
  const relative = value.relativePath as string;
  if (!relative || relative.includes('\\') || relative.startsWith('/') || relative.split('/').some(part => !part || part === '.' || part === '..')
    || relative.split('/').length < 2 || relative.split('/').at(-1) !== 'SKILL.md') return false;
  for (const key of ['license', 'compatibility', 'allowedTools']) if (value[key] !== undefined && !text(value[key], 32768)) return false;
  if (value.metadata !== undefined && (!object(value.metadata) || Object.values(value.metadata).some(item => typeof item !== 'string'))) return false;
  if (value.unknownFields !== undefined && !object(value.unknownFields)) return false;
  return true;
}

export function normalizeNativeSkillInheritanceManifest(value: unknown): NativeSkillInheritanceManifest {
  const snapshot = data(value);
  if (!object(snapshot) || !exactKeys(snapshot, ['schemaVersion', 'context', 'catalog', 'versions', 'excludedSkillIds', 'digest'])
    || snapshot.schemaVersion !== 1 || !hash(snapshot.digest) || !Array.isArray(snapshot.versions) || snapshot.versions.length > 512
    || !Array.isArray(snapshot.excludedSkillIds) || snapshot.excludedSkillIds.length > 512 || !snapshot.excludedSkillIds.every(skillId)
    || new Set(snapshot.excludedSkillIds).size !== snapshot.excludedSkillIds.length) throw new Error('Invalid skill inheritance manifest.');
  const context = normalizeSkillInheritanceContext(snapshot.context), catalog = snapshot.catalog;
  const parent = context.parentManifest;
  const parentDigest = createHash('sha256').update(canonicalJson({ schemaVersion: parent.schemaVersion, identity: parent.identity,
    catalogRevision: parent.catalogRevision, entries: parent.entries } as unknown as JsonValue)).digest('hex');
  if (parent.digest !== parentDigest || parent.entries.some(entry => entry.evidence.seq > context.parentHead.seq)) throw new Error('Invalid skill inheritance manifest.');
  if (!object(catalog) || !exactKeys(catalog, ['schemaVersion', 'revision', 'entries', 'issues', 'truncated']) || catalog.schemaVersion !== 1
    || !hash(catalog.revision) || !Array.isArray(catalog.entries) || catalog.entries.length > 512 || !catalog.entries.every(descriptor)
    || !diagnostics(catalog.issues) || typeof catalog.truncated !== 'boolean' || catalog.revision !== context.parentManifest.catalogRevision
    || snapshot.versions.length !== catalog.entries.length || new Set(catalog.entries.map(entry => entry.skillId)).size !== catalog.entries.length
    || catalog.entries.some(entry => (snapshot.excludedSkillIds as string[]).includes(entry.skillId))) throw new Error('Invalid skill inheritance manifest.');
  for (let index = 0; index < catalog.entries.length; index++) {
    const entry = catalog.entries[index], version = snapshot.versions[index];
    if (!isSkillVersionSnapshot(version) || version.skillId !== entry.skillId || version.sourceRevision !== entry.sourceRevision
      || version.sourceFingerprint !== entry.sourceFingerprint || version.format !== entry.format || version.bytes !== entry.bytes) throw new Error('Invalid skill inheritance manifest.');
  }
  for (const active of context.parentManifest.entries) {
    const index = catalog.entries.findIndex(entry => entry.skillId === active.skillId), entry = catalog.entries[index];
    if (!entry || entry.sourceId !== active.sourceId || entry.relativePath !== active.relativePath || !same(snapshot.versions[index], active.version)) throw new Error('Invalid skill inheritance manifest.');
  }
  const normalized = { schemaVersion: 1 as const, context, catalog: catalog as unknown as SkillCatalogSnapshot,
    versions: snapshot.versions as SkillVersionSnapshot[], excludedSkillIds: snapshot.excludedSkillIds as string[] };
  if (nativeSkillInheritanceDigest(normalized) !== snapshot.digest) throw new Error('Invalid skill inheritance manifest.');
  const result = { ...normalized, digest: snapshot.digest };
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_NATIVE_SKILL_INHERITANCE_BYTES) throw new Error('Skill inheritance manifest exceeds its 524288 byte limit.');
  return structuredClone(result);
}
export function isNativeSkillInheritanceManifest(value: unknown): value is NativeSkillInheritanceManifest {
  try { normalizeNativeSkillInheritanceManifest(value); return true; } catch { return false; }
}
