/** Native Skills v1 contracts. These types alone do not enable runtime activation. */
export type SkillScope = 'project' | 'user';
export type SkillSourceKind = 'project-agents' | 'project-claude' | 'project-explicit' | 'managed' | 'user-agents' | 'user-claude' | 'custom';
export type SkillMetadataValue = null | boolean | number | string | SkillMetadataValue[] | { [key: string]: SkillMetadataValue };
export interface SkillDiagnostic {
  code: string;
  message: string;
  severity: 'warning' | 'error';
  sourceId?: string;
  path?: string;
}
export interface SkillMetadataResult {
  format: 'standard' | 'legacy' | 'invalid';
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  allowedTools?: string;
  unknownFields?: Record<string, SkillMetadataValue>;
  autoMatchable: boolean;
  diagnostics: SkillDiagnostic[];
  headerBytes: number;
}
/** Root mappings stay in the trusted host; catalog entries never expose absolute paths. */
export interface SkillDescriptor extends SkillMetadataResult {
  skillId: string;
  sourceId: string;
  scope: SkillScope;
  relativePath: string;
  sourceRevision: number;
  sourceFingerprint: string;
  metadataHash: string;
  bytes: number;
}
export interface SkillCatalogSnapshot {
  schemaVersion: 1;
  revision: string;
  entries: SkillDescriptor[];
  issues: SkillDiagnostic[];
  truncated: boolean;
}
export interface SkillVersionSnapshot {
  skillId: string;
  sourceRevision: number;
  sourceFingerprint: string;
  fullFileHash: string;
  bodyHash: string;
  bytes: number;
  format: SkillMetadataResult['format'];
}
/** Structural identity only; the host ledger separately validates its own UUIDs. */
export interface SkillRunIdentity {
  sessionId: string;
  conversationId: string;
  runId: string;
  requestId: string;
  workerGeneration: number;
}
export interface SkillParentManifestEntry {
  skillId: string;
  sourceId: string;
  relativePath: string;
  version: SkillVersionSnapshot;
  origin: 'legacy' | 'pinned' | 'explicit' | 'model';
  evidence: { kind: 'run_started' | 'tool_completed'; seq: number; callId?: string };
  placement: 'initial_instructions' | 'compacted_context' | 'retained_receipt';
}
/** Shared host-attested parent evidence, persisted once in the child's configuration. */
export interface SkillInheritanceContext {
  schemaVersion: 1;
  parentHead: { seq: number; hash: string };
  parentManifest: {
    schemaVersion: 1;
    identity: SkillRunIdentity;
    catalogRevision: string;
    entries: SkillParentManifestEntry[];
    digest: string;
  };
}
/** This names the exact parent source/version; activation.version is the child binding. */
export interface SkillInheritedFrom {
  parentIdentity: SkillRunIdentity;
  parentHead: { seq: number; hash: string };
  manifestDigest: string;
  catalogRevision: string;
  skillId: string;
  sourceId: string;
  relativePath: string;
  version: SkillVersionSnapshot;
}
export interface SkillActivation {
  runId: string;
  skillId: string;
  version: SkillVersionSnapshot;
  origin: 'legacy' | 'pinned' | 'explicit' | 'model' | 'inherited';
  /** Required exactly for inherited activations; never aliases a parent confirmation. */
  inheritedFrom?: SkillInheritedFrom;
  requestId: string;
  receiptSeq: number;
  activationRevision: number;
  offeredToRequestId?: string;
  confirmedByResponseId?: string;
}
export interface SkillResourceReceipt {
  skillId: string;
  version: SkillVersionSnapshot;
  relativePath: string;
  contentHash: string;
  bytes: number;
  operation: 'read' | 'copy' | 'execute';
}
/** Explicit, immutable versions; accepting these references alone never activates a skill. */
export interface NativeSkillSubmission {
  schemaVersion: 1;
  explicitSkillRefs: Array<{ skillId: string; catalogRevision: string; version: SkillVersionSnapshot }>;
  excludedSkillIds: string[];
}
export type NativeSkillPin = { kind: 'legacy'; path: string } | { kind: 'skill'; skillId: string };
export interface NativeSkillPolicy {
  mode: 'legacy' | 'catalog';
  autoActivation: boolean;
  pins: NativeSkillPin[];
  disabledIds: string[];
}
export interface NativeSkillSourceSetting {
  id: string;
  kind: 'managed' | 'user-agents' | 'user-claude' | 'custom';
  enabled: boolean;
  rootPath: string;
  revision: number;
}
export interface NativeSkillsSettings {
  schemaVersion: 1;
  revision: number;
  sources: NativeSkillSourceSetting[];
  /** Host-maintained tombstones prevent deleted source identities from being rebound. */
  retiredSourceIds?: string[];
}

const skillHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const skillId = (value: unknown): value is string => typeof value === 'string' && /^skill:[a-f0-9]{64}$/.test(value);
function dataObject(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const properties = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(properties).length !== keys.length) return undefined;
  const snapshot: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    if (!Object.hasOwn(properties, key)) return undefined;
    const property = properties[key];
    if (!Object.hasOwn(property, 'value')) return undefined;
    snapshot[key] = property.value;
  }
  return snapshot;
}
function dataArray(value: unknown, maximum: number): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const properties = Object.getOwnPropertyDescriptors(value) as unknown as Record<PropertyKey, PropertyDescriptor>;
  if (!Object.hasOwn(properties, 'length') || !Object.hasOwn(properties.length, 'value')) return undefined;
  const size: unknown = properties.length.value;
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0 || size > maximum || Reflect.ownKeys(properties).length !== size + 1) return undefined;
  const snapshot: unknown[] = [];
  for (let index = 0; index < size; index++) {
    if (!Object.hasOwn(properties, index)) return undefined;
    const property = properties[index];
    if (!Object.hasOwn(property, 'value')) return undefined;
    snapshot.push(property.value);
  }
  return snapshot;
}
function parseSkillVersionSnapshot(value: unknown): SkillVersionSnapshot | undefined {
  const snapshot = dataObject(value, ['skillId', 'sourceRevision', 'sourceFingerprint', 'fullFileHash', 'bodyHash', 'bytes', 'format']);
  if (!snapshot || !skillId(snapshot.skillId) || typeof snapshot.sourceRevision !== 'number' || !Number.isSafeInteger(snapshot.sourceRevision) || snapshot.sourceRevision < 1
    || !skillHash(snapshot.sourceFingerprint) || !skillHash(snapshot.fullFileHash) || !skillHash(snapshot.bodyHash)
    || typeof snapshot.bytes !== 'number' || !Number.isSafeInteger(snapshot.bytes) || snapshot.bytes < 0 || snapshot.bytes > 32 * 1024
    || (snapshot.format !== 'standard' && snapshot.format !== 'legacy')) return undefined;
  return { skillId: snapshot.skillId, sourceRevision: snapshot.sourceRevision, sourceFingerprint: snapshot.sourceFingerprint,
    fullFileHash: snapshot.fullFileHash, bodyHash: snapshot.bodyHash, bytes: snapshot.bytes, format: snapshot.format };
}
const boundedSkillText = (value: unknown, maximum = 512): value is string => typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\x00-\x1f\x7f]/.test(value);
const skillPath = (value: unknown): value is string => boundedSkillText(value, 4096) && !value.includes('\\') && !value.startsWith('/')
  && !/^[a-z]:/i.test(value) && !value.split('/').some(part => !part || part === '.' || part === '..');
function parseSkillRunIdentity(value: unknown): SkillRunIdentity | undefined {
  const snapshot = dataObject(value, ['sessionId', 'conversationId', 'runId', 'requestId', 'workerGeneration']);
  if (!snapshot || !boundedSkillText(snapshot.sessionId, 256) || !boundedSkillText(snapshot.conversationId, 256) || !boundedSkillText(snapshot.runId, 256)
    || !boundedSkillText(snapshot.requestId, 256) || typeof snapshot.workerGeneration !== 'number' || !Number.isSafeInteger(snapshot.workerGeneration) || snapshot.workerGeneration < 1) return undefined;
  return { sessionId: snapshot.sessionId, conversationId: snapshot.conversationId, runId: snapshot.runId, requestId: snapshot.requestId, workerGeneration: snapshot.workerGeneration };
}
function parseSkillParentHead(value: unknown): SkillInheritanceContext['parentHead'] | undefined {
  const snapshot = dataObject(value, ['seq', 'hash']);
  if (!snapshot || typeof snapshot.seq !== 'number' || !Number.isSafeInteger(snapshot.seq) || snapshot.seq < 1 || !skillHash(snapshot.hash)) return undefined;
  return { seq: snapshot.seq, hash: snapshot.hash };
}
function parseSkillParentManifestEntry(value: unknown, headSeq: number): SkillParentManifestEntry | undefined {
  const snapshot = dataObject(value, ['skillId', 'sourceId', 'relativePath', 'version', 'origin', 'evidence', 'placement']);
  if (!snapshot || !skillId(snapshot.skillId) || !boundedSkillText(snapshot.sourceId) || !skillPath(snapshot.relativePath)
    || !['legacy', 'pinned', 'explicit', 'model'].includes(snapshot.origin as string)) return undefined;
  const version = parseSkillVersionSnapshot(snapshot.version);
  const model = snapshot.origin === 'model';
  const evidence = dataObject(snapshot.evidence, model ? ['kind', 'seq', 'callId'] : ['kind', 'seq']);
  if (!version || version.skillId !== snapshot.skillId || !evidence || evidence.kind !== (model ? 'tool_completed' : 'run_started')
    || typeof evidence.seq !== 'number' || !Number.isSafeInteger(evidence.seq) || evidence.seq < 1 || evidence.seq > headSeq
    || model && !boundedSkillText(evidence.callId, 512)
    || (model ? !['compacted_context', 'retained_receipt'].includes(snapshot.placement as string) : snapshot.placement !== 'initial_instructions')) return undefined;
  return { skillId: snapshot.skillId, sourceId: snapshot.sourceId, relativePath: snapshot.relativePath, version,
    origin: snapshot.origin as SkillParentManifestEntry['origin'], evidence: { kind: model ? 'tool_completed' : 'run_started', seq: evidence.seq,
      ...(model ? { callId: evidence.callId as string } : {}) }, placement: snapshot.placement as SkillParentManifestEntry['placement'] };
}
function parseSkillInheritanceContext(value: unknown): SkillInheritanceContext | undefined {
  const snapshot = dataObject(value, ['schemaVersion', 'parentHead', 'parentManifest']);
  if (!snapshot || snapshot.schemaVersion !== 1) return undefined;
  const parentHead = parseSkillParentHead(snapshot.parentHead), manifest = dataObject(snapshot.parentManifest, ['schemaVersion', 'identity', 'catalogRevision', 'entries', 'digest']);
  if (!parentHead || !manifest || manifest.schemaVersion !== 1 || !skillHash(manifest.catalogRevision) || !skillHash(manifest.digest)) return undefined;
  const identity = parseSkillRunIdentity(manifest.identity), values = dataArray(manifest.entries, 16);
  if (!identity || !values) return undefined;
  const entries: SkillParentManifestEntry[] = [], seen = new Set<string>();
  for (const value of values) {
    const entry = parseSkillParentManifestEntry(value, parentHead.seq);
    if (!entry || seen.has(entry.skillId)) return undefined;
    seen.add(entry.skillId); entries.push(entry);
  }
  return { schemaVersion: 1, parentHead, parentManifest: { schemaVersion: 1, identity, catalogRevision: manifest.catalogRevision, entries, digest: manifest.digest } };
}
function parseSkillInheritedFrom(value: unknown): SkillInheritedFrom | undefined {
  const snapshot = dataObject(value, ['parentIdentity', 'parentHead', 'manifestDigest', 'catalogRevision', 'skillId', 'sourceId', 'relativePath', 'version']);
  if (!snapshot || !skillHash(snapshot.manifestDigest) || !skillHash(snapshot.catalogRevision) || !skillId(snapshot.skillId)
    || !boundedSkillText(snapshot.sourceId) || !skillPath(snapshot.relativePath)) return undefined;
  const parentIdentity = parseSkillRunIdentity(snapshot.parentIdentity), parentHead = parseSkillParentHead(snapshot.parentHead), version = parseSkillVersionSnapshot(snapshot.version);
  if (!parentIdentity || !parentHead || !version || version.skillId !== snapshot.skillId) return undefined;
  return { parentIdentity, parentHead, manifestDigest: snapshot.manifestDigest, catalogRevision: snapshot.catalogRevision,
    skillId: snapshot.skillId, sourceId: snapshot.sourceId, relativePath: snapshot.relativePath, version };
}
function parseNativeSkillSubmission(value: unknown): NativeSkillSubmission | undefined {
  const snapshot = dataObject(value, ['schemaVersion', 'explicitSkillRefs', 'excludedSkillIds']);
  if (!snapshot || snapshot.schemaVersion !== 1) return undefined;
  const refs = dataArray(snapshot.explicitSkillRefs, 16), excludedIds = dataArray(snapshot.excludedSkillIds, 16);
  if (!refs || !excludedIds) return undefined;
  const seen = new Set<string>(), excluded = new Set<string>();
  const explicitSkillRefs: NativeSkillSubmission['explicitSkillRefs'] = [], excludedSkillIds: string[] = [];
  for (const value of refs) {
    const ref = dataObject(value, ['skillId', 'catalogRevision', 'version']);
    if (!ref || !skillId(ref.skillId) || !skillHash(ref.catalogRevision) || seen.has(ref.skillId)) return undefined;
    const version = parseSkillVersionSnapshot(ref.version);
    if (!version || version.skillId !== ref.skillId) return undefined;
    seen.add(ref.skillId);
    explicitSkillRefs.push({ skillId: ref.skillId, catalogRevision: ref.catalogRevision, version });
  }
  for (const id of excludedIds) {
    if (!skillId(id) || excluded.has(id) || seen.has(id)) return undefined;
    excluded.add(id);
    excludedSkillIds.push(id);
  }
  explicitSkillRefs.sort((a, b) => a.skillId < b.skillId ? -1 : a.skillId > b.skillId ? 1 : 0);
  excludedSkillIds.sort();
  return { schemaVersion: 1, explicitSkillRefs, excludedSkillIds };
}
export function isSkillVersionSnapshot(value: unknown): value is SkillVersionSnapshot {
  try { return parseSkillVersionSnapshot(value) !== undefined; } catch { return false; }
}
export function isSkillInheritanceContext(value: unknown): value is SkillInheritanceContext {
  try { return parseSkillInheritanceContext(value) !== undefined; } catch { return false; }
}
export function normalizeSkillInheritanceContext(value: unknown): SkillInheritanceContext {
  try { const parsed = parseSkillInheritanceContext(value); if (parsed) return parsed; } catch { /* Invalid hostile input. */ }
  throw new Error('Invalid Native skill inheritance context.');
}
export function isSkillInheritedFrom(value: unknown): value is SkillInheritedFrom {
  try { return parseSkillInheritedFrom(value) !== undefined; } catch { return false; }
}
export function normalizeSkillInheritedFrom(value: unknown): SkillInheritedFrom {
  try { const parsed = parseSkillInheritedFrom(value); if (parsed) return parsed; } catch { /* Invalid hostile input. */ }
  throw new Error('Invalid Native skill inherited provenance.');
}
export function isNativeSkillSubmission(value: unknown): value is NativeSkillSubmission {
  try { return parseNativeSkillSubmission(value) !== undefined; } catch { return false; }
}
/** Return a fresh canonical value without dropping unknown keys or repairing bad versions. */
export function normalizeNativeSkillSubmission(value: unknown): NativeSkillSubmission {
  try {
    const parsed = parseNativeSkillSubmission(value);
    if (parsed) return parsed;
  } catch { /* Getter and proxy failures remain ordinary invalid input. */ }
  throw new Error('Invalid Native skill submission.');
}
