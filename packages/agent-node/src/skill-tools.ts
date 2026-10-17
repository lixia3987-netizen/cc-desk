import type { ApprovalDecision, JsonObject, JsonValue, PreparedTool, RunIdentity, RunJournalEvent, ToolCall, ToolDefinition, ToolExecutionContext, ToolPort, ToolResult } from '@cc-desk/agent-core';
import { ToolPreparationError, type SkillPreparationFeedback } from '@cc-desk/agent-core';
import type { SkillActivation, SkillCatalogSnapshot, SkillDescriptor } from '@cc-desk/contracts/native-skills';
import { extractSkillBody, SKILL_METADATA_MAX_FILE_BYTES } from './skill-metadata.js';
import { listSkillCatalog, type LoadedCatalogSkill } from './skill-registry.js';
import type { SkillContinuityManifest } from './skill-continuity.js';
import { contentHash } from './tools/project-files.js';

const MAX_ACTIVE = 16;
const MAX_INSTRUCTIONS = 128 * 1024;
const MAX_PREPARED = 512;
export const SKILL_GUIDE_AUTHORITY = 'This skill is a guide. Host policy, the user task and applicable project rules take precedence. It cannot grant tool access, waive approval, execute references or raise budgets.';
const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;
const clone = <T>(value: T): T => structuredClone(value);
const canonical = (value: unknown): string => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value)
  ? `[${value.map(canonical).join(',')}]` : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
const byteLength = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const schema = (properties: JsonObject, required: string[] = []): JsonObject => ({ type: 'object', properties, required, additionalProperties: false });
const DEFINITIONS: ToolDefinition[] = [
  { name: 'list_skills', risk: 'read', description: 'Search this run\'s frozen skill catalog. Follow nextCursor with the same query. Names are labels; use the exact skillId and catalog revision to load a skill. No body is loaded by this tool.',
    inputSchema: schema({ query: { type: 'string', maxLength: 256 }, cursor: { type: 'string', maxLength: 80 }, limit: { type: 'integer', minimum: 1, maximum: 64 } }) },
  { name: 'load_skill', risk: 'read', description: 'Load one eligible skill from this run\'s frozen catalog. The complete guide must fit the output and instruction budgets. A committed guide only takes effect after the next complete model response; do not issue writes or commands in the same batch as a new load. Loading never executes references or scripts.',
    inputSchema: schema({ skillId: { type: 'string', maxLength: 512 }, catalogRevision: { type: 'string', maxLength: 256 } }, ['skillId', 'catalogRevision']) },
];
const trustedSkillErrors = new WeakSet<object>();
const PREPARATION_FEEDBACK: Readonly<Record<string, SkillPreparationFeedback>> = Object.freeze({
  skill_model_observation_required: { error: 'skill_precondition_failed', code: 'context_unconfirmed', action: 'continue_model' },
  skill_source_changed: { error: 'skill_precondition_failed', code: 'source_changed', action: 'restart_turn' },
  active_skills_changed: { error: 'skill_precondition_failed', code: 'activation_changed', action: 'prepare_again' },
  activation_blocked_by_operation: { error: 'skill_precondition_failed', code: 'activation_blocked', action: 'settle_operations' },
  output_byte_limit: { error: 'skill_precondition_failed', code: 'output_limit', action: 'adjust_skill_limits' },
  active_skill_limit: { error: 'skill_precondition_failed', code: 'skill_limit', action: 'adjust_skill_limits' },
  instruction_byte_limit: { error: 'skill_precondition_failed', code: 'skill_limit', action: 'adjust_skill_limits' },
});

export class SkillToolError extends Error {
  constructor(readonly code: string) { super(`Skill tool precondition failed: ${code}.`); this.name = 'SkillToolError'; trustedSkillErrors.add(this); }
}
function preparationFailure(error: unknown): never {
  if (error !== null && typeof error === 'object' && trustedSkillErrors.has(error)) {
    const code = Object.getOwnPropertyDescriptor(error, 'code');
    if (code && 'value' in code && typeof code.value === 'string' && Object.hasOwn(PREPARATION_FEEDBACK, code.value)) {
      throw new ToolPreparationError(PREPARATION_FEEDBACK[code.value]);
    }
  }
  throw error;
}
export interface SkillToolOptions {
  identity: RunIdentity;
  catalog: SkillCatalogSnapshot;
  load(descriptor: SkillDescriptor, signal: AbortSignal): Promise<LoadedCatalogSkill>;
  /** Persists immutable bytes; it does not activate the guide or replace tool_completed. */
  persist?(loaded: LoadedCatalogSkill, signal: AbortSignal): Promise<void>;
  /** Must reject changed source identity/content. Without it, load is repeated for verification. */
  verify?(descriptor: SkillDescriptor, signal: AbortSignal): Promise<void>;
  assertOwnership?(identity: RunIdentity, signal: AbortSignal): void | Promise<void>;
  /** Host checks unresolved operations and live command handles before allowing a new load. */
  canActivate?(signal: AbortSignal): boolean | Promise<boolean>;
  baseInstructionBytes?: number;
  /** Trusted host includes these exact bodies in the run's durable initial instructions. */
  initialSkills?: Array<{ descriptor: SkillDescriptor; loaded: LoadedCatalogSkill; origin: 'explicit' | 'pinned' | 'legacy' }>;
}
interface Active { descriptor: SkillDescriptor; loaded: LoadedCatalogSkill; activation: SkillActivation; loadCallId?: string }
interface OwnState { prepared: PreparedTool; maxOutputBytes: number; signal?: AbortSignal; result?: ToolResult; execution?: Promise<ToolResult>; pending?: { descriptor: SkillDescriptor; loaded: LoadedCatalogSkill }; committed?: boolean }
interface GuardState { prepared: PreparedTool; original: PreparedTool; maxOutputBytes: number; revision: number; digest: string; execution?: Promise<ToolResult>; result?: ToolResult; executionSettled?: boolean }
interface CommittedCall { callHash: string; preparedHash: string; policyHash: string; maxOutputBytes: number; receiptSeq: number; status: ToolResult['status']; result?: ToolResult }
interface GuardRecords { pending: Map<string, GuardState>; committed: Map<string, CommittedCall>; preparing: Set<string> }
type SkillGuardContext = Pick<ToolExecutionContext, 'identity' | 'signal'>;

/** A per-run port. The trusted host calls observeCommitted only after its real append succeeds. */
export class SkillToolPort implements ToolPort {
  private readonly identity: RunIdentity;
  private readonly catalog: SkillCatalogSnapshot;
  private readonly entries: Map<string, SkillDescriptor>;
  private readonly prepared = new Map<string, OwnState>();
  private readonly committed = new Map<string, CommittedCall>();
  private readonly guards = new Set<GuardRecords>();
  private readonly active = new Map<string, Active>();
  private readonly reservations = new Map<string, string>();
  private revision = 0;
  private lastSequence = 0;
  private lastEvent = '';
  private readonly contextReplacements = new Map<number, string>();
  private initialReceiptSeq?: number;
  private preparing = 0;
  private offered?: { requestId: string; skillIds: string[] };
  private batchHasNewLoad = false;
  private terminated = false;
  private readonly baseBytes: number;

  constructor(private readonly options: SkillToolOptions) {
    this.identity = clone(options.identity);
    this.catalog = clone(options.catalog);
    this.entries = new Map(this.catalog.entries.map(entry => [entry.skillId, entry]));
    this.baseBytes = options.baseInstructionBytes ?? 0;
    if (this.catalog.schemaVersion !== 1 || typeof this.catalog.revision !== 'string' || !this.catalog.revision || this.entries.size !== this.catalog.entries.length
      || this.entries.size > 512 || !Number.isSafeInteger(this.baseBytes) || this.baseBytes < 0 || this.baseBytes > MAX_INSTRUCTIONS
      || !this.identity.runId || !Number.isSafeInteger(this.identity.workerGeneration) || this.identity.workerGeneration < 1) throw new SkillToolError('invalid_options');
    for (const initial of options.initialSkills ?? []) {
      const descriptor = this.entries.get(initial.descriptor.skillId);
      if (!descriptor || canonical(descriptor) !== canonical(initial.descriptor) || !['legacy', 'pinned', 'explicit'].includes(initial.origin)) throw new SkillToolError('initial_skill_not_in_catalog');
      this.checkLoaded(descriptor, initial.loaded);
      const existing = this.active.get(descriptor.skillId);
      if (existing) {
        if (canonical(existing.loaded.version) !== canonical(initial.loaded.version)) throw new SkillToolError('initial_skill_conflict');
        continue;
      }
      this.checkCapacity(initial.loaded);
      this.revision++;
      this.active.set(descriptor.skillId, { descriptor, loaded: clone(initial.loaded), activation: {
        runId: this.identity.runId, skillId: descriptor.skillId, version: clone(initial.loaded.version), origin: initial.origin,
        requestId: this.identity.requestId, receiptSeq: 0, activationRevision: this.revision,
      } });
    }
  }
  get definitions(): ToolDefinition[] { return clone(DEFINITIONS); }
  snapshot(): { activationRevision: number; digest: string; activations: SkillActivation[] } {
    const activations = [...this.active.values()].map(item => clone(item.activation)).sort((a, b) => a.skillId.localeCompare(b.skillId, 'en'));
    return { activationRevision: this.revision, digest: contentHash(canonical(activations.map(({ skillId, version }) => ({ skillId, version })))), activations };
  }
  /** Final host effect checks can reuse the same guard without inventing a policy revision. */
  async assertSideEffectsCurrent(signal: AbortSignal): Promise<void> {
    await this.ready({ identity: this.identity, signal });
  }
  /** Compaction preserves exact guides even before their next model observation. */
  async assertSourcesCurrent(signal: AbortSignal): Promise<void> {
    const context = { identity: this.identity, signal };
    await this.runOwnership(context);
    const revision = this.revision;
    for (const active of this.active.values()) await this.verifyOne(active, context);
    if (revision !== this.revision) throw new SkillToolError('active_skills_changed');
    await this.runOwnership(context);
    if (revision !== this.revision) throw new SkillToolError('active_skills_changed');
  }
  /** Called only after the host has durably committed an exact context replacement. */
  observeContextReplacement(seq: number, manifest: SkillContinuityManifest): void {
    if (!Number.isSafeInteger(seq) || seq < 1) throw new SkillToolError('journal_sequence');
    let receiptHash: string;
    try {
      if (!manifest || manifest.schemaVersion !== 1 || !Array.isArray(manifest.entries) || manifest.entries.length > MAX_ACTIVE
        || Object.keys(manifest).sort().join(',') !== 'catalogRevision,digest,entries,identity,schemaVersion'
        || manifest.digest !== contentHash(canonical({ schemaVersion: manifest.schemaVersion, identity: manifest.identity,
          catalogRevision: manifest.catalogRevision, entries: manifest.entries }))) throw new SkillToolError('context_replacement_invalid');
      receiptHash = contentHash(canonical(manifest));
    } catch { throw new SkillToolError('context_replacement_invalid'); }
    const previous = this.contextReplacements.get(seq);
    if (previous !== undefined) {
      if (previous !== receiptHash) throw new SkillToolError('journal_sequence');
      return;
    }
    if (seq <= this.lastSequence) throw new SkillToolError('journal_sequence');
    if (this.terminated) throw new SkillToolError('cancelled');
    if (this.preparing || this.reservations.size || [...this.prepared.values()].some(state => state.prepared.call.name === 'load_skill' || state.execution)
      || [...this.guards].some(guard => guard.preparing.size || [...guard.pending.values()].some(state => state.execution))) {
      throw new SkillToolError('activation_blocked_by_operation');
    }
    if (canonical(manifest.identity) !== canonical(this.identity) || manifest.catalogRevision !== this.catalog.revision
      || manifest.entries.length !== this.active.size || this.revision === Number.MAX_SAFE_INTEGER) throw new SkillToolError('context_replacement_invalid');
    const seen = new Set<string>();
    let initialReceiptSeq = this.initialReceiptSeq;
    for (const entry of manifest.entries) {
      const active = entry && this.active.get(entry.skillId);
      if (!active || seen.has(entry.skillId) || Object.keys(entry).sort().join(',') !== 'evidence,origin,placement,relativePath,skillId,sourceId,version'
        || entry.sourceId !== active.descriptor.sourceId || entry.relativePath !== active.descriptor.relativePath
        || canonical(entry.version) !== canonical(active.loaded.version) || entry.origin !== active.activation.origin
        || !['initial_instructions', 'compacted_context', 'retained_receipt'].includes(entry.placement)
        || !entry.evidence || !Number.isSafeInteger(entry.evidence.seq) || entry.evidence.seq < 1 || entry.evidence.seq >= seq) {
        throw new SkillToolError('context_replacement_invalid');
      }
      seen.add(entry.skillId);
      if (entry.origin === 'model') {
        if (!['compacted_context', 'retained_receipt'].includes(entry.placement)
          || entry.evidence.kind !== 'tool_completed' || entry.evidence.seq !== active.activation.receiptSeq || entry.evidence.callId !== active.loadCallId
          || Object.keys(entry.evidence).sort().join(',') !== 'callId,kind,seq') throw new SkillToolError('context_replacement_invalid');
      } else {
        if (entry.placement !== 'initial_instructions' || entry.evidence.kind !== 'run_started' || Object.keys(entry.evidence).sort().join(',') !== 'kind,seq'
          || initialReceiptSeq !== undefined && entry.evidence.seq !== initialReceiptSeq) throw new SkillToolError('context_replacement_invalid');
        // run_started is a host store event; its first sequence is proved by the durable manifest validator.
        initialReceiptSeq = entry.evidence.seq;
      }
    }
    this.revision++;
    for (const active of this.active.values()) {
      delete active.activation.offeredToRequestId;
      delete active.activation.confirmedByResponseId;
    }
    this.offered = undefined;
    this.batchHasNewLoad = false;
    this.initialReceiptSeq = initialReceiptSeq;
    this.contextReplacements.set(seq, receiptHash);
    this.lastSequence = seq;
    this.lastEvent = `context_replacement:${receiptHash}`;
  }
  private async runOwnership(context: SkillGuardContext): Promise<void> {
    if (this.terminated || context.signal.aborted) throw new SkillToolError('cancelled');
    if (canonical(context.identity) !== canonical(this.identity)) throw new SkillToolError('ownership_changed');
    await this.options.assertOwnership?.(clone(this.identity), context.signal);
    if (this.terminated || context.signal.aborted || canonical(context.identity) !== canonical(this.identity)) throw new SkillToolError('cancelled');
  }
  private async ownership(context: ToolExecutionContext): Promise<void> {
    if (typeof context.policyRevision !== 'string' || !Number.isSafeInteger(context.maxOutputBytes) || context.maxOutputBytes < 128) throw new SkillToolError('ownership_changed');
    await this.runOwnership(context);
  }
  private async canActivate(context: ToolExecutionContext): Promise<void> {
    await this.ownership(context);
    if (this.options.canActivate && !await this.options.canActivate(context.signal)) throw new SkillToolError('activation_blocked_by_operation');
    await this.ownership(context);
  }
  private checkLoaded(descriptor: SkillDescriptor, loaded: LoadedCatalogSkill): void {
    const version = loaded?.version;
    if (!version || typeof loaded.content !== 'string' || typeof loaded.body !== 'string' || descriptor.format === 'invalid'
      || version.skillId !== descriptor.skillId || version.sourceRevision !== descriptor.sourceRevision || version.sourceFingerprint !== descriptor.sourceFingerprint
      || version.format !== descriptor.format || version.bytes !== Buffer.byteLength(loaded.content) || version.bytes > SKILL_METADATA_MAX_FILE_BYTES
      || version.fullFileHash !== contentHash(loaded.content) || version.bodyHash !== contentHash(loaded.body)
      || extractSkillBody(loaded.content) !== loaded.body) throw new SkillToolError('loaded_version_invalid');
  }
  private checkCapacity(loaded: LoadedCatalogSkill, ownId?: string): void {
    const pending = [...this.prepared.entries()].filter(([id, state]) => id !== ownId && state.pending && !state.committed);
    if (this.active.size + pending.length >= MAX_ACTIVE) throw new SkillToolError('active_skill_limit');
    const used = this.baseBytes + [...this.active.values()].reduce((sum, item) => sum + Buffer.byteLength(item.loaded.body), 0)
      + pending.reduce((sum, [, state]) => sum + Buffer.byteLength(state.pending!.loaded.body), 0);
    if (used + Buffer.byteLength(loaded.body) > MAX_INSTRUCTIONS) throw new SkillToolError('instruction_byte_limit');
  }
  private match(prepared: PreparedTool, context: ToolExecutionContext): OwnState {
    const state = this.prepared.get(prepared.call.id);
    if (!state || canonical(state.prepared) !== canonical(prepared) || prepared.policyRevision !== context.policyRevision || state.maxOutputBytes !== context.maxOutputBytes) throw new SkillToolError('prepared_changed');
    return state;
  }
  private committedCall(prepared: PreparedTool, maxOutputBytes: number, result: ToolResult, receiptSeq: number): CommittedCall {
    return { callHash: contentHash(canonical(prepared.call)), preparedHash: contentHash(canonical(prepared)), policyHash: contentHash(prepared.policyRevision),
      maxOutputBytes, receiptSeq, status: result.status, ...(byteLength(result) <= 1024 ? { result: clone(result) } : {}) };
  }
  private matchCommitted(receipt: CommittedCall, prepared: PreparedTool, context: ToolExecutionContext): void {
    if (receipt.preparedHash !== contentHash(canonical(prepared)) || receipt.policyHash !== contentHash(context.policyRevision)
      || receipt.maxOutputBytes !== context.maxOutputBytes) throw new SkillToolError('prepared_changed');
  }
  private replayCommitted(receipt: CommittedCall, prepared: PreparedTool, context: ToolExecutionContext): ToolResult {
    this.matchCommitted(receipt, prepared, context);
    if (receipt.result && byteLength(receipt.result.output) <= context.maxOutputBytes) return clone(receipt.result);
    // A large historical result is a receipt reference, never a newly loaded or complete body.
    const output = { error: 'tool_call_already_committed', receiptSeq: receipt.receiptSeq, previousStatus: receipt.status, bodyIncluded: false };
    return { status: 'not_executed', output: byteLength(output) <= context.maxOutputBytes ? output : { error: 'tool_call_already_committed', receiptSeq: receipt.receiptSeq } };
  }
  private rejectCommitted(receipt: CommittedCall | undefined, call: ToolCall, context: ToolExecutionContext): void {
    if (!receipt) return;
    if (receipt.callHash !== contentHash(canonical(call)) || receipt.policyHash !== contentHash(context.policyRevision)
      || receipt.maxOutputBytes !== context.maxOutputBytes) throw new SkillToolError('call_id_reused');
    throw new SkillToolError('call_already_committed');
  }
  async prepare(call: ToolCall, context: ToolExecutionContext): Promise<PreparedTool> {
    this.preparing++;
    try {
    await this.ownership(context);
    const definition = DEFINITIONS.find(item => item.name === call.name);
    if (!definition || typeof call.id !== 'string' || !call.id || call.id.length > 256 || typeof call.arguments !== 'string' || Buffer.byteLength(call.arguments) > 4096) throw new SkillToolError('invalid_input');
    this.rejectCommitted(this.committed.get(call.id), call, context);
    let input: JsonObject;
    try { input = JSON.parse(call.arguments); } catch { throw new SkillToolError('invalid_input'); }
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new SkillToolError('invalid_input');
    const fields = Object.keys(input);
    if (call.name === 'load_skill') {
      if (fields.length !== 2 || fields.some(key => !['skillId', 'catalogRevision'].includes(key)) || typeof input.skillId !== 'string' || typeof input.catalogRevision !== 'string'
        || input.catalogRevision !== this.catalog.revision || !this.entries.get(input.skillId)?.autoMatchable) throw new SkillToolError('skill_not_in_catalog');
    } else {
      if (fields.some(key => !['query', 'cursor', 'limit'].includes(key))) throw new SkillToolError('invalid_input');
      if (('query' in input && typeof input.query !== 'string') || ('cursor' in input && typeof input.cursor !== 'string')
        || ('limit' in input && (typeof input.limit !== 'number' || !Number.isSafeInteger(input.limit)))) throw new SkillToolError('invalid_input');
      listSkillCatalog(this.catalog, input as { query?: string; cursor?: string; limit?: number });
    }
    const prepared: PreparedTool = { call: clone(call), definition: clone(definition), input: clone(input), inputDigest: contentHash(canonical(input)), policyRevision: context.policyRevision,
      requiresApproval: false, preconditions: { catalogRevision: this.catalog.revision } };
    const old = this.prepared.get(call.id);
    if (old) {
      if (canonical(old.prepared) !== canonical(prepared) || old.maxOutputBytes !== context.maxOutputBytes) throw new SkillToolError('call_id_reused');
      return clone(old.prepared);
    }
    if (this.prepared.size >= MAX_PREPARED) throw new SkillToolError('prepared_limit');
    this.prepared.set(call.id, { prepared: clone(prepared), maxOutputBytes: context.maxOutputBytes });
    return prepared;
    } finally { this.preparing--; }
  }
  async validate(prepared: PreparedTool, context: ToolExecutionContext): Promise<void> {
    await this.ownership(context);
    const receipt = this.committed.get(prepared.call.id);
    if (receipt) { this.matchCommitted(receipt, prepared, context); return; }
    this.match(prepared, context);
  }
  async execute(prepared: PreparedTool, context: ToolExecutionContext): Promise<ToolResult> {
    let state: OwnState;
    try {
      await this.validate(prepared, context);
      const receipt = this.committed.get(prepared.call.id);
      if (receipt) return this.replayCommitted(receipt, prepared, context);
      state = this.match(prepared, context);
    }
    catch (error) { return this.failure(error); }
    if (state.execution) return clone(await state.execution);
    state.signal = context.signal;
    state.execution = this.executeOwn(state, context);
    return clone(await state.execution);
  }
  private failure(error: unknown): ToolResult {
    return { status: 'not_executed', output: { error: error instanceof SkillToolError ? error.code : 'skill_source_unavailable', executed: false } };
  }
  private async executeOwn(state: OwnState, context: ToolExecutionContext): Promise<ToolResult> {
    let reserved: string | undefined;
    try {
      const input = state.prepared.input;
      if (state.prepared.call.name === 'list_skills') {
        let page = listSkillCatalog(this.catalog, input as { query?: string; cursor?: string; limit?: number });
        let output: JsonValue = json({ catalogRevision: page.revision, entries: page.entries, nextCursor: page.nextCursor, truncated: this.catalog.truncated });
        while (byteLength(output) > context.maxOutputBytes && page.entries.length > 1) {
          page = listSkillCatalog(this.catalog, { ...input, limit: page.entries.length - 1 } as { query?: string; cursor?: string; limit?: number });
          output = json({ catalogRevision: page.revision, entries: page.entries, nextCursor: page.nextCursor, truncated: this.catalog.truncated });
        }
        if (byteLength(output) > context.maxOutputBytes) throw new SkillToolError('output_byte_limit');
        await this.ownership(context);
        return state.result = { status: 'completed', output };
      }
      const descriptor = this.entries.get(input.skillId as string)!;
      const active = this.active.get(descriptor.skillId);
      if (active) {
        await this.verifyOne(active, context);
        const output = json({ skillId: descriptor.skillId, version: active.loaded.version, alreadyLoaded: true, activationRevision: active.activation.activationRevision });
        if (byteLength(output) > context.maxOutputBytes) throw new SkillToolError('output_byte_limit');
        return state.result = { status: 'completed', output };
      }
      await this.canActivate(context);
      if (this.reservations.has(descriptor.skillId)) throw new SkillToolError('skill_load_pending_commit');
      this.reservations.set(descriptor.skillId, state.prepared.call.id);
      reserved = descriptor.skillId;
      const loaded = clone(await this.options.load(clone(descriptor), context.signal));
      this.checkLoaded(descriptor, loaded);
      this.checkCapacity(loaded, state.prepared.call.id);
      const output = json({ skillId: descriptor.skillId, sourceId: descriptor.sourceId, relativePath: descriptor.relativePath, version: loaded.version,
        authority: SKILL_GUIDE_AUTHORITY, body: loaded.body, complete: true });
      if (byteLength(output) > context.maxOutputBytes) throw new SkillToolError('output_byte_limit');
      await this.canActivate(context);
      await this.options.persist?.(clone(loaded), context.signal);
      await this.canActivate(context);
      await this.verifyLoaded(descriptor, loaded, context);
      await this.canActivate(context);
      // There is no asynchronous gap between this final capacity check and reservation.
      this.checkCapacity(loaded, state.prepared.call.id);
      state.pending = { descriptor, loaded };
      return state.result = { status: 'completed', output };
    } catch (error) {
      if (reserved) this.reservations.delete(reserved);
      return state.result = this.failure(error);
    }
  }
  private async verifyOne(active: Active, context: SkillGuardContext): Promise<void> {
    return this.verifyLoaded(active.descriptor, active.loaded, context);
  }
  private async verifyLoaded(descriptor: SkillDescriptor, loaded: LoadedCatalogSkill, context: SkillGuardContext): Promise<void> {
    try {
      if (this.options.verify) await this.options.verify(clone(descriptor), context.signal);
      else {
        const current = await this.options.load(clone(descriptor), context.signal);
        this.checkLoaded(descriptor, current);
        if (canonical(current.version) !== canonical(loaded.version)) throw new SkillToolError('skill_source_changed');
      }
    } catch { throw new SkillToolError('skill_source_changed'); }
    await this.runOwnership(context);
  }
  private async ready(context: SkillGuardContext): Promise<void> {
    await this.runOwnership(context);
    if (this.batchHasNewLoad) throw new SkillToolError('skill_model_observation_required');
    if ([...this.active.values()].some(item => !item.activation.confirmedByResponseId)) throw new SkillToolError('skill_model_observation_required');
    const revision = this.revision;
    for (const active of this.active.values()) await this.verifyOne(active, context);
    if (revision !== this.revision) throw new SkillToolError('active_skills_changed');
    await this.runOwnership(context);
    // Ownership callbacks may await. Recheck synchronously at the actual return boundary.
    if (revision !== this.revision) throw new SkillToolError('active_skills_changed');
    if (this.batchHasNewLoad || [...this.active.values()].some(item => !item.activation.confirmedByResponseId)) throw new SkillToolError('skill_model_observation_required');
  }
  /** Consumes only matching private load results; externally shaped tool JSON cannot activate a skill. */
  observeCommitted(event: RunJournalEvent, seq: number): void {
    if (!Number.isSafeInteger(seq) || seq < 1 || seq < this.lastSequence) throw new SkillToolError('journal_sequence');
    const digest = contentHash(canonical(event));
    if (seq === this.lastSequence) {
      if (digest !== this.lastEvent) throw new SkillToolError('journal_sequence');
      return;
    }
    this.lastSequence = seq; this.lastEvent = digest;
    if (this.terminated) return;
    if (event.type === 'tool_completed') {
      const state = this.prepared.get(event.call.id);
      if (!event.resultItems.length || event.result.status === 'unknown') return;
      if (state && canonical(event.call) === canonical(state.prepared.call) && (!state.result || canonical(event.result) === canonical(state.result))
        && (!state.execution || state.result)) {
        const pending = state.pending;
        if (pending) {
          this.reservations.delete(pending.descriptor.skillId);
          if (event.result.status === 'completed' && state.result && !state.signal?.aborted) {
            this.revision++;
            this.active.set(pending.descriptor.skillId, { ...pending, loadCallId: event.call.id, activation: { runId: this.identity.runId, skillId: pending.descriptor.skillId,
              version: clone(pending.loaded.version), origin: 'model', requestId: this.identity.requestId, receiptSeq: seq, activationRevision: this.revision } });
          }
        }
        this.committed.set(event.call.id, this.committedCall(state.prepared, state.maxOutputBytes, event.result, seq));
        this.prepared.delete(event.call.id);
      }
      for (const guard of this.guards) {
        const record = guard.pending.get(event.call.id);
        if (!record || canonical(record.prepared.call) !== canonical(event.call) || record.result && canonical(record.result) !== canonical(event.result)) continue;
        if (record.execution && !record.result && (!record.executionSettled || record.original.definition.risk !== 'read' || event.result.status === 'completed')) continue;
        guard.committed.set(event.call.id, this.committedCall(record.prepared, record.maxOutputBytes, event.result, seq));
        guard.pending.delete(event.call.id);
      }
    } else if (event.type === 'model_request_started') {
      const requestId = `${this.identity.requestId}:attempt:${event.attempt}`;
      const skillIds = [...this.active.keys()];
      for (const id of skillIds) this.active.get(id)!.activation.offeredToRequestId = requestId;
      this.offered = { requestId, skillIds };
    } else if (event.type === 'model_request_failed') {
      this.offered = undefined;
    } else if (event.type === 'model_response') {
      if (this.offered && ['completed', 'tool_calls'].includes(event.response.finishReason)) {
        for (const id of this.offered.skillIds) {
          const active = this.active.get(id);
          if (active?.activation.offeredToRequestId === this.offered.requestId) active.activation.confirmedByResponseId = `${this.identity.runId}:response:${seq}`;
        }
      }
      this.offered = undefined;
      this.batchHasNewLoad = event.response.toolCalls.some(call => {
        if (call.name !== 'load_skill') return false;
        try { const input = JSON.parse(call.arguments); return !!this.entries.get(input.skillId)?.autoMatchable && !this.active.has(input.skillId); }
        catch { return false; }
      });
    } else if (event.type === 'run_finished') {
      this.terminated = true;
      this.reservations.clear();
    }
  }
  /** Wrap the final non-skill port so every write/command shares the same dynamic guard. */
  guard(otherPort: ToolPort): ToolPort {
    const definitions = clone(otherPort.definitions);
    const guard: GuardRecords = { pending: new Map(), committed: new Map(), preparing: new Set() };
    this.guards.add(guard);
    const records = guard.pending;
    const definitionFor = (name: string) => definitions.find(item => item.name === name);
    const match = (prepared: PreparedTool, context: ToolExecutionContext): GuardState => {
      const record = records.get(prepared.call.id);
      if (!record || canonical(record.prepared) !== canonical(prepared) || prepared.policyRevision !== context.policyRevision || record.maxOutputBytes !== context.maxOutputBytes) throw new SkillToolError('prepared_changed');
      return record;
    };
    const check = async (record: GuardState, context: ToolExecutionContext) => {
      await this.ready(context);
      const current = this.snapshot();
      if (record.revision !== current.activationRevision || record.digest !== current.digest) throw new SkillToolError('active_skills_changed');
    };
    return {
      get definitions() { return clone(definitions); },
      prepare: async (call, context) => {
        this.preparing++;
        let reserved = false;
        try {
        await this.ownership(context);
        const definition = definitionFor(call.name);
        if (!definition) throw new SkillToolError('unknown_tool');
        this.rejectCommitted(guard.committed.get(call.id), call, context);
        if (!records.has(call.id)) {
          if (guard.preparing.has(call.id)) throw new SkillToolError('prepare_in_progress');
          if (records.size + guard.preparing.size >= MAX_PREPARED) throw new SkillToolError('prepared_limit');
          guard.preparing.add(call.id); reserved = true;
        }
        if (definition.risk === 'read') {
          const result = clone(await otherPort.prepare(clone(call), context));
          await this.ownership(context);
          const old = records.get(call.id);
          if (old && (canonical(old.prepared) !== canonical(result) || old.maxOutputBytes !== context.maxOutputBytes)) throw new SkillToolError('call_id_reused');
          if (!old) {
            if (records.size >= MAX_PREPARED) throw new SkillToolError('prepared_limit');
            records.set(call.id, { prepared: clone(result), original: result, maxOutputBytes: context.maxOutputBytes, revision: this.revision, digest: this.snapshot().digest });
          }
          return result;
        }
        await this.ready(context);
        const current = this.snapshot();
        const original = clone(await otherPort.prepare(clone(call), context));
        await this.ready(context);
        if (this.revision !== current.activationRevision || original.policyRevision !== context.policyRevision || original.definition.risk !== definition.risk) throw new SkillToolError('active_skills_changed');
        const objectPreconditions = original.preconditions !== null && typeof original.preconditions === 'object' && !Array.isArray(original.preconditions);
        if (objectPreconditions && Object.hasOwn(original.preconditions as object, 'nativeSkillGuard')) throw new SkillToolError('guard_key_collision');
        const preconditions = objectPreconditions ? original.preconditions as JsonObject : { operation: original.preconditions };
        const prepared = { ...original, preconditions: json({ ...preconditions, nativeSkillGuard: { catalogRevision: this.catalog.revision,
          activationRevision: current.activationRevision, digest: current.digest } }) };
        const old = records.get(call.id);
        if (old) {
          if (canonical(old.prepared) !== canonical(prepared) || old.maxOutputBytes !== context.maxOutputBytes) throw new SkillToolError('call_id_reused');
          return clone(old.prepared);
        }
        if (records.size >= MAX_PREPARED) throw new SkillToolError('prepared_limit');
        records.set(call.id, { prepared: clone(prepared), original, maxOutputBytes: context.maxOutputBytes, revision: current.activationRevision, digest: current.digest });
        return prepared;
        } catch (error) { return preparationFailure(error); }
        finally { this.preparing--; if (reserved) guard.preparing.delete(call.id); }
      },
      validate: async (prepared, context) => {
        await this.ownership(context);
        const receipt = guard.committed.get(prepared.call.id);
        if (receipt) { this.matchCommitted(receipt, prepared, context); return; }
        const record = match(prepared, context);
        if (record.original.definition.risk === 'read') { await otherPort.validate(clone(record.original), context); await this.ownership(context); match(prepared, context); return; }
        await check(record, context);
        await otherPort.validate(clone(record.original), context);
        await check(record, context);
        match(prepared, context);
      },
      execute: async (prepared, context, approval?: ApprovalDecision) => {
        let record: GuardState;
        try {
          await this.ownership(context);
          const receipt = guard.committed.get(prepared.call.id);
          if (receipt) return this.replayCommitted(receipt, prepared, context);
          record = match(prepared, context);
        } catch (error) { return this.failure(error); }
        if (!record.execution) record.execution = (async () => {
          try {
            if (record.original.definition.risk === 'read') await this.ownership(context); else await check(record, context);
            match(prepared, context);
          } catch (error) { record.executionSettled = true; return record.result = this.failure(error); }
          // Do not convert an operation exception into not_executed: its side effects may be unknown.
          try { return record.result = clone(await otherPort.execute(clone(record.original), context, approval)); }
          finally { record.executionSettled = true; }
        })();
        return clone(await record.execution);
      },
    };
  }
}

export function createSkillToolPort(options: SkillToolOptions): SkillToolPort { return new SkillToolPort(options); }
