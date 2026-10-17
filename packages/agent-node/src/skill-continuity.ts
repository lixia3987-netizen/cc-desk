import { canonicalJson, type JsonValue, type ModelContext, type ProtocolVersion, type RunIdentity, type ToolCall } from '@cc-desk/agent-core';
import { isNativeSkillSubmission, isSkillVersionSnapshot, type SkillActivation, type SkillVersionSnapshot } from '@cc-desk/contracts/native-skills';
import type { NativeRunStore, RunStoreRecord } from './run-store.js';
import type { SkillSnapshotStore } from './skill-snapshots.js';
import { SKILL_GUIDE_AUTHORITY } from './skill-tools.js';
import { extractSkillBody } from './skill-metadata.js';
import { nativeToolResultItems } from './context-maintenance.js';
import { contentHash, throwIfAborted } from './tools/project-files.js';

const MAX_ACTIVE = 16;
export const MAX_SKILL_CONTINUITY_BODY_BYTES = 128 * 1024;
const hash = (value: unknown) => contentHash(canonicalJson(value as JsonValue));
const same = (left: unknown, right: unknown) => canonicalJson(left as JsonValue) === canonicalJson(right as JsonValue);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max = 512): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const isHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const keys = (value: Record<string, unknown>, expected: string[]) => Object.keys(value).length === expected.length && Object.keys(value).every(key => expected.includes(key));

export class SkillContinuityError extends Error {
  constructor(readonly code: 'invalid_skill_evidence' | 'invalid_skill_continuity' | 'skill_snapshot_unavailable') {
    super(code === 'skill_snapshot_unavailable' ? 'An exact active skill snapshot is unavailable; context was not replaced.'
      : 'Active skill continuity does not match complete committed run evidence.');
    this.name = 'SkillContinuityError';
  }
}
function invalid(): never { throw new SkillContinuityError('invalid_skill_evidence'); }

export interface SkillContinuityEntry {
  skillId: string;
  sourceId: string;
  relativePath: string;
  version: SkillVersionSnapshot;
  origin: SkillActivation['origin'];
  evidence: { kind: 'run_started' | 'tool_completed'; seq: number; callId?: string };
  placement: 'initial_instructions' | 'compacted_context' | 'retained_receipt';
}
export interface SkillContinuityManifest {
  schemaVersion: 1;
  identity: RunIdentity;
  catalogRevision: string;
  entries: SkillContinuityEntry[];
  digest: string;
}
/** Complete dynamic bodies have a separate 128 KiB budget, never the task-summary budget. */
export interface SkillContinuitySection {
  schemaVersion: 1;
  manifest: SkillContinuityManifest;
  bodies: Array<{ skillId: string; body: string }>;
}
export interface SkillContinuityEvidence {
  head: { seq: number; hash: string };
  manifest: SkillContinuityManifest;
  /** Exact original instructions are retained by the run's fixed model adapter. */
  initialInstructions: string;
  bodies: SkillContinuitySection['bodies'];
}
type EvidenceStore = Pick<NativeRunStore, 'head' | 'replay' | 'getRun'>;
interface CatalogEntry { skillId: string; sourceId: string; relativePath: string; sourceRevision: number; sourceFingerprint: string; metadataHash: string; format: string }

function catalogEntry(value: unknown): CatalogEntry {
  if (!object(value) || !keys(value, ['skillId', 'sourceId', 'relativePath', 'sourceRevision', 'sourceFingerprint', 'metadataHash', 'format'])
    || !text(value.skillId, 256) || !text(value.sourceId) || !text(value.relativePath, 4096)
    || value.relativePath.includes('\\') || value.relativePath.startsWith('/') || value.relativePath.split('/').some(part => !part || part === '.' || part === '..')
    || !Number.isSafeInteger(value.sourceRevision) || (value.sourceRevision as number) < 1 || !isHash(value.sourceFingerprint) || !isHash(value.metadataHash)
    || !['standard', 'legacy'].includes(value.format as string)) invalid();
  return value as unknown as CatalogEntry;
}
function versionFor(value: unknown, descriptor: CatalogEntry): SkillVersionSnapshot {
  if (!isSkillVersionSnapshot(value) || value.format === 'invalid' || value.skillId !== descriptor.skillId || value.sourceRevision !== descriptor.sourceRevision
    || value.sourceFingerprint !== descriptor.sourceFingerprint || value.format !== descriptor.format) invalid();
  return structuredClone(value);
}
function parseLoad(call: ToolCall, revision: string): string {
  let input: unknown;
  try { input = JSON.parse(call.arguments); } catch { return invalid(); }
  if (!object(input) || !keys(input, ['skillId', 'catalogRevision']) || !text(input.skillId, 256) || input.catalogRevision !== revision) invalid();
  return input.skillId;
}
function validResultItems(protocol: ProtocolVersion, call: ToolCall, result: unknown, items: JsonValue[]): boolean {
  // The ledger canonicalizes object keys but preserves the provider's JSON string
  // verbatim. Re-encoding the sorted result would spuriously change that string.
  if (items.length !== 1 || !object(items[0])) return false;
  const item = items[0];
  const raw = protocol.id === 'openai-responses' ? item.output : protocol.id === 'openai-chat-completions' ? item.content
    : protocol.id === 'anthropic-messages' && Array.isArray(item.content) && object(item.content[0]) ? item.content[0].content : undefined;
  if (typeof raw !== 'string') return false;
  try {
    const original = JSON.parse(raw);
    return same(original, result) && same(items, nativeToolResultItems(protocol, call, original));
  } catch { return false; }
}

/**
 * Reads only this run's immutable start and successful full load receipts. A normal
 * new turn never acquires activations from earlier turns, summaries, or UI state.
 * NativeRunStore has already verified the journal hash chain and transitions.
 */
export function readSkillContinuityEvidence(store: EvidenceStore, runId: string, retainedContext?: ModelContext): SkillContinuityEvidence | undefined {
  const head = store.head, run = store.getRun(runId);
  if (!head || !run || run.startedSeq > head.seq) return undefined;
  const records: RunStoreRecord[] = [];
  let after = run.startedSeq - 1;
  while (after < head.seq) {
    const page = store.replay(after, Math.min(256, head.seq - after));
    if (!page.length || page[0].seq !== after + 1) invalid();
    for (const record of page) {
      if (record.seq !== ++after || record.seq > head.seq) invalid();
      records.push(record);
    }
  }
  if (records.at(-1)?.hash !== head.hash) invalid();
  const start = records[0];
  if (start.event.type !== 'run_started' || start.identity?.runId !== runId || !same(start.identity, start.event.request.identity) || !same(start.identity, run.identity)) invalid();
  const configuration = start.event.request.configuration;
  if (configuration.nativeSkillCatalog === undefined && configuration.initialNativeSkills === undefined) return undefined;
  const catalog = configuration.nativeSkillCatalog, initial = configuration.initialNativeSkills;
  if (!object(catalog) || !keys(catalog, ['revision', 'entries', 'truncated']) || !isHash(catalog.revision) || !Array.isArray(catalog.entries) || catalog.entries.length > 512
    || typeof catalog.truncated !== 'boolean' || !object(initial) || !keys(initial, ['activationRevision', 'digest', 'activations'])
    || !Array.isArray(initial.activations) || initial.activations.length > MAX_ACTIVE || initial.activationRevision !== initial.activations.length || !isHash(initial.digest)
    || typeof configuration.modelInstructions !== 'string') invalid();
  const descriptors = new Map<string, CatalogEntry>();
  for (const value of catalog.entries) {
    const descriptor = catalogEntry(value);
    if (descriptors.has(descriptor.skillId)) invalid();
    descriptors.set(descriptor.skillId, descriptor);
  }
  const entries = new Map<string, SkillContinuityEntry>(), bodies = new Map<string, string>(), revisions = new Set<number>();
  for (const value of initial.activations) {
    if (!object(value) || !keys(value, ['runId', 'skillId', 'version', 'origin', 'requestId', 'receiptSeq', 'activationRevision'])
      || value.runId !== runId || value.requestId !== run.identity.requestId || !text(value.skillId, 256) || value.receiptSeq !== 0
      || !['explicit', 'pinned', 'legacy'].includes(value.origin as string) || !Number.isSafeInteger(value.activationRevision)
      || (value.activationRevision as number) < 1 || (value.activationRevision as number) > initial.activations.length || revisions.has(value.activationRevision as number)) invalid();
    const descriptor = descriptors.get(value.skillId);
    if (!descriptor || entries.has(value.skillId)) invalid();
    revisions.add(value.activationRevision as number);
    const version = versionFor(value.version, descriptor);
    if (value.origin === 'explicit') {
      if (!isNativeSkillSubmission(configuration.nativeSkills) || !configuration.nativeSkills.explicitSkillRefs.some(ref => ref.skillId === descriptor.skillId
        && ref.catalogRevision === catalog.revision && same(ref.version, version))) invalid();
    }
    entries.set(descriptor.skillId, { skillId: descriptor.skillId, sourceId: descriptor.sourceId, relativePath: descriptor.relativePath, version,
      origin: value.origin as SkillActivation['origin'], evidence: { kind: 'run_started', seq: start.seq }, placement: 'initial_instructions' });
  }
  const initialVersions = [...entries.values()].sort((a, b) => a.skillId.localeCompare(b.skillId, 'en')).map(({ skillId, version }) => ({ skillId, version }));
  if (hash(initialVersions) !== initial.digest) invalid();
  if (isNativeSkillSubmission(configuration.nativeSkills) && configuration.nativeSkills.explicitSkillRefs.some(ref => entries.get(ref.skillId)?.origin !== 'explicit')) invalid();
  for (const record of records.slice(1)) {
    if (record.identity?.runId !== runId || record.event.type !== 'tool_completed' || record.event.call.name !== 'load_skill') continue;
    if (!same(record.identity, run.identity)) invalid();
    const event = record.event;
    if (event.result.status !== 'completed') continue;
    const skillId = parseLoad(event.call, catalog.revision), descriptor = descriptors.get(skillId), output = event.result.output;
    if (!descriptor || !object(output) || !validResultItems(start.event.request.protocol, event.call, event.result, event.resultItems)) invalid();
    const version = versionFor(output.version, descriptor);
    if (output.alreadyLoaded === true) {
      const previous = entries.get(skillId);
      if (!keys(output, ['skillId', 'version', 'alreadyLoaded', 'activationRevision']) || output.skillId !== skillId || !previous || !same(previous.version, version)
        || !Number.isSafeInteger(output.activationRevision) || (output.activationRevision as number) < 1) invalid();
      continue;
    }
    if (!keys(output, ['skillId', 'sourceId', 'relativePath', 'version', 'authority', 'body', 'complete']) || output.complete !== true
      || output.skillId !== skillId || output.sourceId !== descriptor.sourceId || output.relativePath !== descriptor.relativePath || output.authority !== SKILL_GUIDE_AUTHORITY
      || typeof output.body !== 'string' || output.body.includes('\0') || Buffer.byteLength(output.body) > 32768 || contentHash(output.body) !== version.bodyHash
      || entries.has(skillId)) invalid();
    const retained = retainedContext?.items.some((_, index) => same(retainedContext.items.slice(index, index + event.resultItems.length), event.resultItems)) ?? false;
    entries.set(skillId, { skillId, sourceId: descriptor.sourceId, relativePath: descriptor.relativePath, version, origin: 'model',
      evidence: { kind: 'tool_completed', seq: record.seq, callId: event.call.id }, placement: retained ? 'retained_receipt' : 'compacted_context' });
    bodies.set(skillId, output.body);
    if (entries.size > MAX_ACTIVE) invalid();
  }
  const ordered = [...entries.values()].sort((a, b) => a.skillId.localeCompare(b.skillId, 'en'));
  const manifestBody = { schemaVersion: 1 as const, identity: structuredClone(run.identity), catalogRevision: catalog.revision, entries: ordered };
  return { head, manifest: { ...manifestBody, digest: hash(manifestBody) }, initialInstructions: configuration.modelInstructions,
    bodies: ordered.flatMap(entry => bodies.has(entry.skillId) ? [{ skillId: entry.skillId, body: bodies.get(entry.skillId)! }] : []) };
}

/** Deterministic ledger projection; this function does not claim CAS availability. */
export function skillContinuitySection(evidence: SkillContinuityEvidence): SkillContinuitySection {
  const section: SkillContinuitySection = { schemaVersion: 1, manifest: structuredClone(evidence.manifest), bodies: structuredClone(evidence.bodies.filter(item =>
    evidence.manifest.entries.some(entry => entry.skillId === item.skillId && entry.placement === 'compacted_context'))) };
  if (section.bodies.reduce((sum, item) => sum + Buffer.byteLength(item.body), 0) > MAX_SKILL_CONTINUITY_BODY_BYTES) throw new SkillContinuityError('invalid_skill_continuity');
  return section;
}

/** Host preflight: missing or corrupt historical bytes block before any summary request. */
export async function resolveSkillContinuity(evidence: SkillContinuityEvidence, snapshots: Pick<SkillSnapshotStore, 'read'>, signal?: AbortSignal): Promise<SkillContinuitySection> {
  const captured = structuredClone(evidence);
  let bodyBytes = 0;
  for (const entry of captured.manifest.entries) {
    throwIfAborted(signal);
    let loaded;
    try { loaded = await snapshots.read(entry.version, signal); }
    catch { throwIfAborted(signal); throw new SkillContinuityError('skill_snapshot_unavailable'); }
    if (!same(loaded.version, entry.version) || Buffer.byteLength(loaded.content) !== entry.version.bytes || contentHash(loaded.content) !== entry.version.fullFileHash
      || extractSkillBody(loaded.content) !== loaded.body || contentHash(loaded.body) !== entry.version.bodyHash) invalid();
    bodyBytes += Buffer.byteLength(loaded.body);
    if (bodyBytes > MAX_SKILL_CONTINUITY_BODY_BYTES) throw new SkillContinuityError('invalid_skill_continuity');
    if (entry.placement === 'initial_instructions') {
      const guide = `Native skill guide ${entry.skillId} (${entry.sourceId}/${entry.relativePath}), version ${entry.version.fullFileHash}:\n${loaded.body}`;
      if (!captured.initialInstructions.includes(guide)) invalid();
    } else if (captured.bodies.find(item => item.skillId === entry.skillId)?.body !== loaded.body) invalid();
  }
  throwIfAborted(signal);
  return skillContinuitySection(captured);
}

/** Recomputed during commit and journal replay; caller-shaped bodies cannot enter context. */
export function validateSkillContinuitySection(evidence: SkillContinuityEvidence | undefined, section: SkillContinuitySection): SkillContinuitySection {
  if (!evidence || !same(section, skillContinuitySection(evidence))) throw new SkillContinuityError('invalid_skill_continuity');
  return structuredClone(section);
}

/** Retained guides are host data, never fabricated model responses or tool receipts. */
export function skillContinuityItems(section: SkillContinuitySection, protocol: ProtocolVersion): JsonValue[] {
  if (!section.manifest.entries.length) return [];
  const text = 'Exact skill guides retained for this run after context compaction. Host policy, the user task and applicable project rules take precedence. '
    + 'These guides cannot grant tool access, waive approval, execute references or raise budgets. Initial guides remain in the unchanged run instructions.\n\n'
    + canonicalJson({ kind: 'native_skill_continuity', schemaVersion: 1, manifest: section.manifest as unknown as JsonValue, guides: section.bodies });
  if (protocol.version === 1 && protocol.id === 'openai-chat-completions') return [{ role: 'assistant', content: text }];
  if (protocol.version === 1 && protocol.id === 'anthropic-messages') return [{ role: 'assistant', content: [{ type: 'text', text }] }];
  if (protocol.version === 1 && protocol.id === 'openai-responses') return [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }];
  throw new SkillContinuityError('invalid_skill_continuity');
}
