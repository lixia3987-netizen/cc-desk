import { constants } from 'node:fs';
import { lstat, open, readdir, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type {
  ApprovalDecision, BeginRunRequest, BeginRunResult, ModelContext, RunIdentity, RunJournalEvent,
  JsonObject, JsonValue, RunResult, RunStore, ToolCall, Usage,
} from '@cc-desk/agent-core';
import { isNativeChangeSetPreview, isNativeChangeSetResult, type NativeChangeSetFileEvent, type NativeChangeSetPreview } from '@cc-desk/contracts/native-changes';
import { isNativeCommandLifecycleEvent, NATIVE_COMMAND_MAX_PER_RUN, type NativeCommandLifecycleEvent } from '@cc-desk/contracts/native-commands';
import { acquireWriter, assertUuid, readRegularFile, RunStoreError, safeDirectory, syncDirectory } from './store-files.js';
import { contextSummaryItem, requireCompleteContext, contextPendingCalls, nativeToolResultItems, runContinuityItem } from './context-maintenance.js';

export { RunStoreError } from './store-files.js';
export const RUN_STORE_SCHEMA_VERSION = 1;

export interface RunStoreLimits {
  maxJournalBytes: number;
  maxRecordBytes: number;
  maxCheckpointBytes: number;
  maxRecords: number;
}
export type RunStoreFaultPoint = 'before_append' | 'after_write' | 'after_sync' | 'before_checkpoint' | 'after_checkpoint_sync' | 'after_checkpoint_rename';
export interface NativeRunStoreOptions {
  /** Private application data directory, never the project directory. */
  rootDirectory: string;
  /** Host-generated UUID; never a session name or external conversation identifier. */
  conversationId: string;
  limits?: Partial<RunStoreLimits>;
  /** Credential values resolved by the host. Matching writes fail rather than silently corrupting context. */
  forbiddenValues?: readonly string[];
  /** Deterministic fault injection. Not persisted. */
  fault?: (point: RunStoreFaultPoint, eventType: string) => void | Promise<void>;
}
export interface StoredToolState {
  call: ToolCall;
  state: 'requested' | 'prepared' | 'completed' | 'unknown';
  prepared?: Extract<RunJournalEvent, { type: 'tool_prepared' }>;
  completed?: Extract<RunJournalEvent, { type: 'tool_completed' }>;
  preparedSeq?: number;
  completedSeq?: number;
  /** Host-attested receipts only; never supplied by the model worker. */
  changeSetProgress?: Array<NativeChangeSetFileEvent & { seq: number }>;
  /** Starting a command acknowledges its handle, not its eventual process outcome. */
  commandProgress?: Array<NativeCommandLifecycleEvent & { seq: number }>;
}
export interface StoredRun {
  identity: RunIdentity;
  input: string;
  inputDigest: string;
  configuration: BeginRunRequest['configuration'];
  policyRevision: string;
  startedSeq: number;
  status: 'active' | RunResult['status'];
  result?: RunResult;
  recoveryReason?: string;
  recoveryResolution?: { expectedHash: string; seq: number; result: RunResult };
  tools: StoredToolState[];
}
export interface RecoveryReport {
  runId: string;
  expectedHash: string;
  classification: 'safe_to_continue' | 'unknown_effects' | 'unsupported_protocol';
  tools: Array<{ callId: string; name: string; status: 'completed' | 'not_executed' | 'unknown' }>;
}
/** Host-only launch reservation. Environment values and process handles never enter this record. */
export interface NativeStartupRequest {
  identity: RunIdentity;
  startupId: string;
  inputDigest: string;
  optionsDigest: string;
  metadata: JsonObject;
  policyRevision: string;
  approval: ApprovalDecision;
}
export interface NativeStartupReceipt {
  identity: RunIdentity;
  inputDigest: string;
  optionsDigest: string;
  status: 'live' | 'closed' | 'recovery_required';
  startups: Array<{ startupId: string; metadata: JsonObject; preparedSeq: number; closedSeq?: number }>;
}
interface StoredStartup extends NativeStartupRequest { preparedSeq: number; closedSeq?: number }
export interface ContextCompactionSource {
  expectedHash: string;
  sourceSeq: number;
  /** Only the older prefix is sent for summarization; retained turns are excluded. */
  context: ModelContext;
  beforeBytes: number;
  scope: 'prefix';
}
export interface ContextCompactionPlan {
  expectedHash: string;
  sourceSeq: number;
  summary: string;
  keepRecentTurns: number;
  beforeBytes: number;
  afterBytes: number;
  context: ModelContext;
  retainedTurns: Array<{ runId: string; start: number }>;
  /** Actual summary request usage, when returned by the service. */
  usage?: Usage | null;
  /** Durable reservation for a single automatic summary request. */
  automaticRequestId?: string;
}
export interface ContextCompactionReceipt {
  expectedHash: string;
  seq: number;
  beforeBytes: number;
  afterBytes: number;
  createdAt: string;
  usage?: Usage | null;
  automaticRequestId?: string;
}
export interface AutoCompactionRequest {
  requestId: string;
  inputDigest: string;
  configurationDigest: string;
  /** Conversation head observed before reserving the summary request. */
  expectedHash: string;
}
export interface AutoCompactionAttempt extends AutoCompactionRequest {
  contextHash: string;
  seq: number;
  createdAt: string;
  status: 'attempted' | 'committed';
  compactionSeq?: number;
}
export interface RunCompactionSource extends ContextCompactionSource {
  contextHash: string;
  /** Irreducible exact goals and latest complete model/tool batch. */
  retainedContext: ModelContext;
}
export interface RunCompactionRequest { requestId: string; contextHash: string }
export interface RunCompactionAttempt extends RunCompactionRequest {
  runId: string;
  seq: number;
  createdAt: string;
  status: 'attempted' | 'committed' | 'failed';
  beforeBytes: number;
  afterBytes?: number;
  usage?: Usage | null;
  reason?: string;
  compactionSeq?: number;
  finishedSeq?: number;
}
export interface RunCompactionInput extends RunCompactionRequest {
  summary: string;
  continuity: string;
  usage: Usage | null;
}
export interface RunCompactionFailure { requestId: string; reason: string; usage: Usage | null }
interface RunCompactionPlan extends RunCompactionInput {
  beforeBytes: number;
  afterBytes: number;
  context: ModelContext;
  retainedTurns: Array<{ runId: string; start: number }>;
  retainedBatches: Array<{ runId: string; start: number }>;
}
export interface RunCompactionReceipt { seq: number; context: ModelContext; beforeBytes: number; afterBytes: number }
type RecoveryCompletion = Extract<RunJournalEvent, { type: 'tool_completed' }>;
type StoreEvent =
  | { type: 'conversation_created' }
  | { type: 'startup_prepared'; request: NativeStartupRequest }
  | { type: 'startup_closed'; startupId: string }
  | { type: 'change_set_file'; toolCallId: string; progress: NativeChangeSetFileEvent }
  | { type: 'command_lifecycle'; toolCallId: string; progress: NativeCommandLifecycleEvent }
  | { type: 'run_started'; request: BeginRunRequest; payloadDigest: string }
  | { type: 'run_recovered'; runId: string; reason: string }
  | { type: 'recovery_resolved'; runId: string; expectedHash: string; resourcesVerified: true; completions: RecoveryCompletion[]; result: RunResult }
  | { type: 'context_compacted'; plan: ContextCompactionPlan }
  | { type: 'context_compaction_attempted'; requestId: string; inputDigest: string; configurationDigest: string; expectedHash: string; contextHash: string }
  | { type: 'run_context_compaction_attempted'; request: RunCompactionRequest }
  | { type: 'run_context_compacted'; plan: RunCompactionPlan }
  | { type: 'run_context_compaction_failed'; failure: RunCompactionFailure }
  | RunJournalEvent;
export interface RunStoreRecord {
  schemaVersion: 1;
  conversationId: string;
  seq: number;
  committedAt: string;
  identity?: RunIdentity;
  event: StoreEvent;
  previousHash: string;
  hash: string;
}
interface InternalRun extends Omit<StoredRun, 'tools'> {
  payloadDigest: string;
  tools: Map<string, StoredToolState>;
  finishedSeq?: number;
}
interface Checkpoint {
  schemaVersion: 1;
  conversationId: string;
  seq: number;
  journalHash: string;
  context: ModelContext | null;
  hash: string;
}
const DEFAULT_LIMITS: RunStoreLimits = {
  maxJournalBytes: 256 * 1024 * 1024,
  maxRecordBytes: 16 * 1024 * 1024,
  maxCheckpointBytes: 16 * 1024 * 1024,
  maxRecords: 20_000,
};
const ZERO_HASH = '0'.repeat(64);
const VALID_STATUSES = new Set(['completed', 'cancelled', 'failed', 'budget_exhausted', 'recovery_required']);
const TOOL_STATUSES = new Set(['completed', 'failed', 'denied', 'cancelled', 'not_executed', 'unknown']);
// JSON may expand a retained UTF-8 byte to six ASCII bytes. The envelope covers
// every bounded identity/call field and the small running receipt.
const COMMAND_ENVELOPE_BYTES = 32 * 1024;
const commandTerminalBytes = (maxOutputBytes: number): number => maxOutputBytes * 6 + 2048 * 6 + COMMAND_ENVELOPE_BYTES;
const uncertainCommand = (tool: StoredToolState): boolean => !!tool.commandProgress?.length && tool.commandProgress.at(-1)?.status !== 'finished';
const SECRET_FIELD = /^(?:api[_-]?key|authorization|password|secret|client[_-]?secret|access[_-]?token|refresh[_-]?token|credentials?|token|bearer[_-]?token)$/i;

function fail(code: string, message: string): never { throw new RunStoreError(code, message); }
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function text(value: unknown, label: string, max = 4096): asserts value is string {
  if (typeof value !== 'string' || !value.length || value.length > max || value.includes('\0')) fail('invalid_record', `Invalid ${label}`);
}
function hash(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) fail('invalid_record', `Invalid ${label}`);
}
function validateAutoCompactionRequest(request: AutoCompactionRequest): void {
  if (!object(request)) fail('invalid_record', 'Invalid automatic compaction request');
  text(request.requestId, 'automatic request id', 256);
  hash(request.inputDigest, 'automatic input digest');
  hash(request.configurationDigest, 'automatic configuration digest');
  hash(request.expectedHash, 'automatic expected head');
}
function validateRunCompactionRequest(request: RunCompactionRequest): void {
  if (!object(request)) fail('invalid_record', 'Invalid in-turn compaction request');
  text(request.requestId, 'in-turn compaction request id', 256);
  hash(request.contextHash, 'in-turn context digest');
}
function validateSummaryUsage(usage: Usage | null): void {
  if (usage !== null && (!object(usage) || Object.entries(usage).some(([key, value]) => !['inputTokens', 'outputTokens', 'totalTokens'].includes(key) || !Number.isSafeInteger(value) || (value as number) < 0))) fail('invalid_usage', 'Summary usage must contain only nonnegative integer token counts');
}
function validateStartupRequest(request: NativeStartupRequest, conversationId: string): void {
  if (!object(request)) fail('invalid_record', 'Invalid startup reservation');
  validateIdentity(request.identity, conversationId);
  text(request.startupId, 'startup id', 256);
  hash(request.inputDigest, 'startup input digest');
  hash(request.optionsDigest, 'startup options digest');
  text(request.policyRevision, 'startup policy revision', 256);
  validateConfiguration(request.metadata);
  const approval = request.approval;
  if (!object(approval) || approval.decision !== 'approved' || !object(approval.binding)) fail('approval_required', 'Local service startup requires a bound approval');
  if (!Number.isSafeInteger(approval.expiresAt) || approval.expiresAt <= 0) fail('invalid_record', 'Invalid startup approval expiry');
  const { toolCallId, inputDigest, policyRevision, ...identity } = approval.binding;
  if (!equal(identity, request.identity) || toolCallId !== request.startupId || inputDigest !== digest(request.metadata) || policyRevision !== request.policyRevision) fail('stale_approval', 'Startup approval is not bound to this exact launch and identity');
}
function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return fail('invalid_record', 'Only finite JSON values may be persisted');
}
function digest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
function clone<T>(value: T): T { return JSON.parse(canonical(value)) as T; }
function equal(left: unknown, right: unknown): boolean { return canonical(left) === canonical(right); }
function validateIdentity(identity: RunIdentity, conversationId: string): void {
  if (!object(identity)) fail('invalid_identity', 'Missing run identity');
  assertUuid(identity.conversationId, 'conversationId');
  assertUuid(identity.runId, 'runId');
  if (identity.conversationId !== conversationId) fail('invalid_identity', 'Wrong conversation');
  text(identity.sessionId, 'sessionId', 512);
  text(identity.requestId, 'requestId', 1024);
  if (!Number.isSafeInteger(identity.workerGeneration) || identity.workerGeneration < 1) fail('invalid_identity', 'Invalid worker generation');
}
function validateContext(context: ModelContext): void {
  if (!object(context) || !object(context.protocol) || !Array.isArray(context.items)) fail('invalid_record', 'Invalid model context');
  text(context.protocol.id, 'protocol id', 128);
  if (!Number.isSafeInteger(context.protocol.version) || context.protocol.version < 1) fail('invalid_record', 'Invalid protocol version');
}
function validateCall(call: ToolCall): void {
  if (!object(call)) fail('invalid_record', 'Invalid tool call');
  text(call.id, 'tool call id', 512); text(call.name, 'tool name', 128);
  if (typeof call.arguments !== 'string') fail('invalid_record', 'Invalid tool arguments');
}
function validateConfiguration(value: unknown): void {
  if (!object(value)) fail('invalid_record', 'Configuration must be a JSON object');
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_FIELD.test(key)) fail('secret_rejected', 'Credential fields cannot enter a run configuration');
    const visit = (child: unknown): void => {
      if (object(child)) validateConfiguration(child);
      else if (Array.isArray(child)) child.forEach(visit);
    };
    visit(item);
  }
}
function payloadDigest(request: BeginRunRequest): string {
  return digest({ input: request.input, userItems: request.userItems, protocol: request.protocol, configuration: request.configuration, policyRevision: request.policyRevision });
}

/**
 * Host-owned, single-writer, append-and-fsync conversation ledger. Checkpoints are
 * verified indexes of the journal, never an alternate source of model context.
 * No automatic recovery replays a prepared tool or resumes an interrupted run.
 */
export class NativeRunStore implements RunStore {
  readonly conversationId: string;
  readonly directory: string;
  readonly limits: Readonly<RunStoreLimits>;
  private readonly options: NativeRunStoreOptions;
  private releaseWriter: (() => Promise<void>) | undefined;
  private readonly records: RunStoreRecord[] = [];
  private readonly runs = new Map<string, InternalRun>();
  private readonly submissions = new Map<string, string>();
  private readonly startups = new Map<string, Map<string, StoredStartup>>();
  /** Not reconstructed during replay: only this writer may attest its own resource cleanup. */
  private readonly liveStartups = new Set<StoredStartup>();
  private readonly recoveredStartupRequests = new Set<string>();
  private context: ModelContext | null = null;
  private originalUserItems: JsonValue[] | undefined;
  private contextTurns: Array<{ runId: string; start: number }> = [];
  private contextBatches: Array<{ runId: string; start: number }> = [];
  private lastCompaction: ContextCompactionReceipt | null = null;
  private readonly autoCompactionAttempts = new Map<string, AutoCompactionAttempt>();
  private readonly autoCompactionContexts = new Map<string, string>();
  private readonly runCompactionAttempts = new Map<string, RunCompactionAttempt>();
  private journalBytes = 0;
  private closed = false;
  private closing = false;
  private poisoned = false;
  private tail: Promise<unknown> = Promise.resolve();
  private directoryIdentity: { dev: number; ino: number } | undefined;
  private journalIdentity: { dev: number; ino: number } | undefined;

  private constructor(options: NativeRunStoreOptions, directory: string, release: () => Promise<void>) {
    this.options = options;
    this.conversationId = options.conversationId;
    this.directory = directory;
    this.releaseWriter = release;
    this.limits = Object.freeze({ ...DEFAULT_LIMITS, ...options.limits });
    for (const value of Object.values(this.limits)) if (!Number.isSafeInteger(value) || value < 1) fail('invalid_limits', 'Store limits must be positive integers');
    if (this.limits.maxRecordBytes > this.limits.maxJournalBytes) fail('invalid_limits', 'Record limit exceeds journal limit');
  }

  static async open(options: NativeRunStoreOptions): Promise<NativeRunStore> {
    const directory = await safeDirectory(options.rootDirectory, options.conversationId);
    const release = await acquireWriter(directory);
    let store: NativeRunStore;
    try {
      store = new NativeRunStore(options, directory, release);
      const directoryStat = await lstat(directory);
      store.directoryIdentity = { dev: directoryStat.dev, ino: directoryStat.ino };
      await store.load();
      return store;
    } catch (error) { await release().catch(() => undefined); throw error; }
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => undefined);
    return result;
  }
  private writable(): void {
    if (this.closed || this.closing) fail('store_closed', 'Conversation store is closed or releasing its writer');
    if (this.poisoned) fail('recovery_required', 'A persistence failure requires reopening and inspecting the conversation');
  }
  private owner(identity: RunIdentity): InternalRun {
    validateIdentity(identity, this.conversationId);
    const run = this.runs.get(identity.runId);
    if (!run || !equal(run.identity, identity)) fail('stale_owner', 'Run or worker no longer owns this conversation');
    return run;
  }
  private activeOwner(identity: RunIdentity): InternalRun {
    const run = this.owner(identity);
    if (run.status !== 'active') fail('run_not_active', 'Run is no longer active');
    return run;
  }
  private rejectSecrets(value: unknown): void {
    const raw = canonical(value);
    for (const secret of this.options.forbiddenValues ?? []) {
      if (secret && raw.includes(JSON.stringify(secret).slice(1, -1))) fail('secret_rejected', 'Resolved credentials cannot be persisted');
    }
  }
  private async checkPath(): Promise<void> {
    const stat = await lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== this.directoryIdentity?.dev || stat.ino !== this.directoryIdentity?.ino) fail('unsafe_path', 'Conversation directory changed');
  }

  private async load(): Promise<void> {
    // An interrupted checkpoint can leave one bounded temporary copy. Remove
    // only our UUID-named private regular files while holding writer ownership.
    for (const name of await readdir(this.directory)) {
      if (!/^checkpoint-[0-9a-f-]{36}\.tmp$/.test(name)) continue;
      const temporary = path.join(this.directory, name);
      await readRegularFile(temporary, this.limits.maxCheckpointBytes);
      await unlink(temporary);
    }
    const journal = await readRegularFile(path.join(this.directory, 'journal.jsonl'), this.limits.maxJournalBytes);
    const rawCheckpoint = await readRegularFile(path.join(this.directory, 'checkpoint.json'), this.limits.maxCheckpointBytes);
    let checkpoint: Checkpoint | undefined;
    if (rawCheckpoint !== undefined) {
      try { checkpoint = JSON.parse(rawCheckpoint) as Checkpoint; } catch { fail('corrupt_store', 'Checkpoint is not valid JSON'); }
      if (!object(checkpoint) || checkpoint.schemaVersion !== 1) fail('unsupported_schema', 'Unsupported checkpoint schema');
      const { hash, ...body } = checkpoint;
      if (checkpoint.conversationId !== this.conversationId || !Number.isSafeInteger(checkpoint.seq) || checkpoint.seq < 1 || digest(body) !== hash) fail('corrupt_store', 'Checkpoint integrity verification failed');
      if (checkpoint.context !== null) validateContext(checkpoint.context);
    }
    if (journal === undefined) {
      if (checkpoint) fail('corrupt_store', 'Checkpoint has no journal');
      await this.commit(undefined, { type: 'conversation_created' });
      return;
    }
    if (!journal.length || !journal.endsWith('\n')) fail('corrupt_store', 'Journal is empty or has an uncommitted/truncated tail');
    this.journalBytes = Buffer.byteLength(journal);
    const journalStat = await lstat(path.join(this.directory, 'journal.jsonl'));
    this.journalIdentity = { dev: journalStat.dev, ino: journalStat.ino };
    const lines = journal.slice(0, -1).split('\n');
    if (lines.length > this.limits.maxRecords) fail('limit_exceeded', 'Journal record count exceeds configured limit');
    for (const line of lines) {
      if (Buffer.byteLength(line) + 1 > this.limits.maxRecordBytes) fail('limit_exceeded', 'Journal record exceeds configured limit');
      let record: RunStoreRecord;
      try { record = JSON.parse(line) as RunStoreRecord; } catch { fail('corrupt_store', 'Journal is not valid JSON'); }
      if (!object(record) || record.schemaVersion !== 1) fail('unsupported_schema', 'Unsupported journal schema');
      const { hash, ...body } = record;
      if (record.conversationId !== this.conversationId || record.seq !== this.records.length + 1 || record.previousHash !== (this.records.at(-1)?.hash ?? ZERO_HASH) || digest(body) !== hash) fail('corrupt_store', 'Journal integrity verification failed');
      try { this.validateEvent(record.identity, record.event); this.apply(record); } catch (error) {
        throw new RunStoreError('corrupt_store', `Invalid journal state transition: ${error instanceof RunStoreError ? error.code : 'invalid_record'}`);
      }
      this.records.push(record);
      if (checkpoint?.seq === record.seq && (checkpoint.journalHash !== record.hash || !equal(checkpoint.context, this.context))) fail('corrupt_store', 'Checkpoint does not match its committed journal sequence');
    }
    if (this.records[0]?.event.type !== 'conversation_created' || (checkpoint && checkpoint.seq > this.records.length)) fail('corrupt_store', 'Journal/checkpoint sequence is incomplete');
    // Even a model-only interrupted run may have owned external resources in the
    // old main process. The host must verify cleanup before opening a new attempt.
    for (const run of this.runs.values()) {
      if (run.status === 'active') await this.commit(undefined, { type: 'run_recovered', runId: run.identity.runId, reason: 'Previous host stopped before committing a terminal run; resources and prepared effects require verification' });
    }
    for (const [requestId, startups] of this.startups) {
      if ([...startups.values()].some(startup => startup.closedSeq === undefined)) this.recoveredStartupRequests.add(requestId);
    }
  }

  private validateEvent(identity: RunIdentity | undefined, event: StoreEvent): void {
    if (!object(event) || typeof event.type !== 'string') fail('invalid_record', 'Invalid event');
    if (event.type === 'conversation_created') {
      if (identity || this.records.length) fail('invalid_record', 'Duplicate conversation creation');
      return;
    }
    if (event.type === 'startup_prepared') {
      const request = event.request;
      validateStartupRequest(request, this.conversationId);
      if (!identity || !equal(identity, request.identity)) fail('invalid_identity', 'Startup identity mismatch');
      if (this.submissions.has(identity.requestId) || this.runs.has(identity.runId)) fail('payload_mismatch', 'A started submission cannot launch another service');
      if ([...this.runs.values()].some(run => run.status === 'active' || run.status === 'recovery_required')) fail('conversation_busy', 'Conversation has an active or unresolved run');
      const previous = this.startups.get(identity.requestId);
      if (previous?.has(request.startupId)) fail('startup_already_prepared', 'Service startup has already been reserved; replay is forbidden');
      for (const [requestId, startups] of this.startups) {
        for (const startup of startups.values()) {
          if (requestId === identity.requestId) {
            if (!equal(startup.identity, identity) || startup.inputDigest !== request.inputDigest || startup.optionsDigest !== request.optionsDigest) fail('payload_mismatch', 'Startup submission identity was reused with different input/configuration');
            if (startup.closedSeq !== undefined) fail('startup_already_prepared', 'A completed startup submission cannot launch another service');
          } else {
            if (startup.identity.runId === identity.runId) fail('payload_mismatch', 'Startup run identity was reused');
            if (startup.closedSeq === undefined) fail('conversation_busy', 'Previous startup resources are unresolved');
          }
        }
      }
      return;
    }
    if (event.type === 'startup_closed') {
      if (!identity) fail('invalid_identity', 'Startup cleanup is missing identity');
      validateIdentity(identity, this.conversationId);
      text(event.startupId, 'startup id', 256);
      const startup = this.startups.get(identity.requestId)?.get(event.startupId);
      if (!startup || !equal(startup.identity, identity)) fail('stale_owner', 'Startup no longer belongs to this execution');
      if (startup.closedSeq !== undefined) fail('invalid_record', 'Duplicate startup cleanup in journal');
      return;
    }
    if (event.type === 'run_started') {
      const request = event.request;
      if (!object(request)) fail('invalid_record', 'Invalid run request');
      validateIdentity(request.identity, this.conversationId);
      if (!identity || !equal(identity, request.identity)) fail('invalid_identity', 'Run start identity mismatch');
      if (typeof request.input !== 'string' || !Array.isArray(request.userItems)) fail('invalid_record', 'Invalid user input');
      text(request.inputDigest, 'input digest', 256); text(request.policyRevision, 'policy revision', 256);
      validateContext({ protocol: request.protocol, items: request.userItems });
      validateConfiguration(request.configuration);
      if (event.payloadDigest !== payloadDigest(request)) fail('payload_mismatch', 'Submission payload digest mismatch');
      if (this.runs.has(identity.runId) || this.submissions.has(identity.requestId)) fail('payload_mismatch', 'Duplicate run or submission in journal');
      for (const [requestId, startups] of this.startups) {
        for (const startup of startups.values()) {
          if (requestId === identity.requestId) {
            if (!equal(startup.identity, identity)) fail('stale_owner', 'Only the startup owner may begin its associated run');
            if (startup.closedSeq !== undefined) fail('startup_already_prepared', 'A completed startup submission cannot begin a new run');
            if (startup.inputDigest !== createHash('sha256').update(request.input).digest('hex') || startup.optionsDigest !== digest(request.configuration.sessionOptions)) fail('payload_mismatch', 'Run input/options differ from the approved startup submission');
          } else if (startup.closedSeq === undefined) fail('conversation_busy', 'Previous startup resources are unresolved');
        }
      }
      if ([...this.runs.values()].some(run => run.status === 'active' || run.status === 'recovery_required')) fail('conversation_busy', 'Conversation has an active or unresolved run');
      if (this.context && !equal(this.context.protocol, request.protocol)) fail('protocol_mismatch', 'Existing conversation protocol cannot change');
      return;
    }
    if (event.type === 'run_recovered') {
      const run = this.runs.get(event.runId);
      if (identity || !run || run.status !== 'active') fail('invalid_record', 'Invalid recovery transition');
      text(event.reason, 'recovery reason');
      return;
    }
    if (event.type === 'recovery_resolved') {
      if (identity || event.resourcesVerified !== true) fail('invalid_record', 'Recovery requires explicit host resource verification');
      const expected = this.recoveryResolution(event.runId, event.expectedHash);
      if (!equal(event.completions, expected.completions) || !equal(event.result, expected.result)) fail('invalid_record', 'Recovery receipt differs from durable tool outcomes');
      return;
    }
    if (event.type === 'context_compacted') {
      if (identity || !object(event.plan)) fail('invalid_record', 'Invalid context compaction event');
      const expected = this.planContextCompaction({ summary: event.plan.summary, keepRecentTurns: event.plan.keepRecentTurns, expectedHash: event.plan.expectedHash, usage: event.plan.usage, automaticRequestId: event.plan.automaticRequestId });
      if (!equal(event.plan, expected)) fail('invalid_record', 'Compaction cannot introduce context absent from its verified plan');
      return;
    }
    if (event.type === 'context_compaction_attempted') {
      if (identity) fail('invalid_identity', 'Automatic compaction reservation cannot own a run');
      validateAutoCompactionRequest(event);
      hash(event.contextHash, 'automatic context digest');
      const source = this.getCompactionSource();
      if (event.expectedHash !== source.expectedHash || event.contextHash !== digest(this.context)) fail('stale_context', 'Conversation changed before reserving automatic compaction');
      if (this.autoCompactionAttempts.has(event.requestId) || this.autoCompactionContexts.has(event.contextHash)) fail('payload_mismatch', 'Automatic compaction has already been attempted for this request or context');
      return;
    }
    if (!identity) fail('invalid_identity', 'Run event is missing identity');
    const run = this.activeOwner(identity);
    if (event.type === 'run_context_compaction_attempted') {
      validateRunCompactionRequest(event.request);
      if (this.runCompactionAttempts.has(identity.runId)) fail('compaction_already_attempted', 'Each run permits only one summary request');
      const source = this.getRunCompactionSource(identity);
      if (source.contextHash !== event.request.contextHash) fail('stale_context', 'Run context changed before reserving compaction');
      return;
    }
    if (event.type === 'run_context_compacted') {
      if (!object(event.plan)) fail('invalid_record', 'Invalid in-turn compaction plan');
      const expected = this.planRunCompaction(identity, event.plan);
      if (!equal(event.plan, expected)) fail('invalid_record', 'In-turn compaction cannot introduce unverified context');
      return;
    }
    if (event.type === 'run_context_compaction_failed') {
      const failure = event.failure;
      if (!object(failure)) fail('invalid_record', 'Invalid in-turn compaction failure');
      text(failure.requestId, 'in-turn compaction request id', 256); text(failure.reason, 'in-turn compaction failure reason', 128);
      validateSummaryUsage(failure.usage);
      const attempt = this.runCompactionAttempts.get(identity.runId);
      if (!attempt || attempt.requestId !== failure.requestId || attempt.status !== 'attempted') fail('compaction_unavailable', 'Summary failure requires an unused durable reservation');
      return;
    }
    if (event.type === 'command_lifecycle') {
      text(event.toolCallId, 'command tool call id', 512);
      const tool = run.tools.get(event.toolCallId);
      const prepared = tool?.prepared;
      if (!prepared || prepared.prepared.call.name !== 'start_command' || !prepared.prepared.requiresApproval || prepared.approval?.decision !== 'approved') fail('not_prepared', 'Command receipts require a durable approved start call');
      const progress = event.progress;
      if (!isNativeCommandLifecycleEvent(progress)) fail('invalid_record', 'Invalid command lifecycle receipt');
      const previous = tool!.commandProgress ?? [];
      if (progress.status === 'prepared') {
        if (previous.length || tool!.completed) fail('command_already_prepared', 'A command start cannot be replayed');
        if ([...this.runs.values()].some(item => [...item.tools.values()].some(candidate => candidate.commandProgress?.[0]?.commandId === progress.commandId))) fail('payload_mismatch', 'Command handle identity was reused');
        if ([...run.tools.values()].filter(candidate => candidate.commandProgress?.length).length >= NATIVE_COMMAND_MAX_PER_RUN) fail('limit_exceeded', 'Run command handle budget exhausted');
        const input = prepared.prepared.input;
        if (!equal(progress.command, { executable: input.executable, argv: input.argv, cwd: input.cwd }) || progress.taskId !== run.configuration.nativeTaskId || progress.timeoutMs > (typeof input.timeoutMs === 'number' ? input.timeoutMs : 120_000) || progress.maxOutputBytes > (typeof input.maxOutputBytes === 'number' ? input.maxOutputBytes : 16_384)) fail('payload_mismatch', 'Command intent differs from the approved command, task or limits');
      } else {
        const intent = previous[0], current = previous.at(-1);
        if (intent?.status !== 'prepared' || !current || progress.commandId !== intent.commandId) fail('not_prepared', 'Command receipt has no matching durable intent');
        if (current.status === 'finished' || current.status === 'unknown' || current.status === 'running' && progress.status === 'running') fail('invalid_record', 'Command lifecycle cannot repeat or replace a terminal fact');
        if ('result' in progress && Buffer.byteLength(progress.result.stdout) + Buffer.byteLength(progress.result.stderr) > intent.maxOutputBytes) fail('invalid_record', 'Command logs exceed the approved retained output bound');
      }
      return;
    }
    if (event.type === 'change_set_file') {
      text(event.toolCallId, 'change-set tool call id', 512);
      const tool = run.tools.get(event.toolCallId);
      const preview = this.changeSetPreview(tool);
      const progress = event.progress;
      if (!object(progress) || !Number.isSafeInteger(progress.index) || !['prepared', 'applied', 'not_applied', 'unknown'].includes(progress.status)) fail('invalid_record', 'Invalid change-set file receipt');
      const file = preview.files[progress.index];
      if (!file || progress.changeSetDigest !== preview.digest || progress.path !== file.path || progress.beforeHash !== file.beforeHash || progress.afterHash !== file.afterHash) fail('payload_mismatch', 'File receipt differs from the exact approved change set');
      if (progress.errorCode !== undefined && (typeof progress.errorCode !== 'string' || !/^[a-z0-9_]{1,64}$/.test(progress.errorCode))) fail('invalid_record', 'Invalid change-set error code');
      if (Object.keys(progress).some(key => !['changeSetDigest', 'index', 'path', 'status', 'beforeHash', 'afterHash', 'errorCode'].includes(key))) fail('invalid_record', 'Unexpected change-set receipt field');
      const previous = tool!.changeSetProgress ?? [];
      const current = previous.at(-1);
      const nextIndex = current ? current.index + (current.status === 'prepared' ? 0 : 1) : 0;
      if (progress.index !== nextIndex) fail('invalid_record', 'Change-set file receipts must follow the approved order');
      if (current?.status === 'prepared' && progress.status === 'prepared' || current?.status !== 'prepared' && ['applied', 'unknown'].includes(progress.status)) fail('invalid_record', 'File effects require exactly one prior prepared receipt');
      if (progress.status === 'prepared' && previous.some(item => item.status === 'not_applied' || item.status === 'unknown')) fail('recovery_required', 'A stopped change set cannot resume or replay');
      return;
    }
    if (event.type === 'model_response') {
      if ([...run.tools.values()].some(tool => !tool.completed)) fail('pending_tools', 'Previous model tool calls have no durable result');
      const response = event.response;
      if (!object(response) || !Array.isArray(response.outputItems) || !Array.isArray(response.toolCalls) || !['completed', 'tool_calls', 'refused', 'incomplete'].includes(response.finishReason)) fail('invalid_record', 'Invalid model response');
      const ids = new Set<string>();
      for (const call of response.toolCalls) {
        validateCall(call);
        if (ids.has(call.id) || run.tools.has(call.id)) fail('payload_mismatch', 'Tool call identity was reused');
        ids.add(call.id);
      }
      return;
    }
    if (event.type === 'tool_prepared') {
      const prepared = event.prepared;
      if (!object(prepared) || !object(prepared.input) || !object(prepared.definition)) fail('invalid_record', 'Invalid prepared tool');
      validateCall(prepared.call);
      const tool = run.tools.get(prepared.call.id);
      if (!tool || !equal(tool.call, prepared.call)) fail('payload_mismatch', 'Prepared tool does not match the committed model request');
      if (tool.prepared || tool.completed) fail('tool_already_prepared', 'Tool has already been prepared or completed; automatic replay is forbidden');
      if (prepared.policyRevision !== run.policyRevision || prepared.definition.name !== prepared.call.name) fail('invalid_record', 'Prepared tool policy/name mismatch');
      text(prepared.inputDigest, 'tool input digest', 256);
      if (prepared.call.name === 'apply_change_set' && (!prepared.requiresApproval || (!object(prepared.preconditions) || !isNativeChangeSetPreview(prepared.preconditions.changeSet)))) fail('invalid_record', 'Change sets require a complete approved preview');
      if (prepared.requiresApproval) {
        const approval = event.approval;
        if (!approval || approval.decision !== 'approved' || !object(approval.binding)) fail('approval_required', 'Side effects require a bound approval');
        const { toolCallId, inputDigest, policyRevision, ...bindingIdentity } = approval.binding;
        if (!equal(bindingIdentity, identity) || toolCallId !== prepared.call.id || inputDigest !== prepared.inputDigest || policyRevision !== run.policyRevision) fail('stale_approval', 'Approval is not bound to this exact run and input');
      }
      return;
    }
    if (event.type === 'tool_completed') {
      validateCall(event.call);
      const tool = run.tools.get(event.call.id);
      if (!tool || !equal(tool.call, event.call)) fail('payload_mismatch', 'Tool result does not match a committed model request');
      if (tool.completed) fail('payload_mismatch', 'Duplicate tool result in journal');
      if (!object(event.result) || !TOOL_STATUSES.has(event.result.status) || !Array.isArray(event.resultItems)) fail('invalid_record', 'Invalid tool result');
      if (event.result.status === 'completed' && !tool.prepared) fail('not_prepared', 'Executed tool has no durable prepared record');
      if (tool.call.name === 'start_command') {
        const progress = tool.commandProgress, latest = progress?.at(-1);
        if (event.result.status === 'completed' && (!latest || !['running', 'finished'].includes(latest.status))) fail('not_prepared', 'A completed start needs a host-attested command handle');
        if (progress?.length && event.result.status !== 'unknown' && (!object(event.result.output) || event.result.output.commandId !== progress[0].commandId)) fail('payload_mismatch', 'Start result differs from its durable command handle');
        if (latest?.status === 'unknown' && event.result.status !== 'unknown') fail('recovery_required', 'Unknown command effects cannot become a known start result');
      }
      if (tool.call.name === 'apply_change_set' && tool.prepared && (event.result.status === 'completed' || isNativeChangeSetResult(event.result.output) || (tool.changeSetProgress?.length && event.result.status !== 'unknown'))) {
        const preview = this.changeSetPreview(tool);
        const result = event.result.output;
        if (!isNativeChangeSetResult(result) || result.digest !== preview.digest || result.files.length !== preview.files.length || result.files.some((file, index) => {
          const approved = preview.files[index];
          return file.path !== approved.path || file.beforeHash !== approved.beforeHash || file.afterHash !== approved.afterHash;
        })) fail('invalid_record', 'Change-set result differs from the approved file manifest');
        const receipts = new Map((tool.changeSetProgress ?? []).map(receipt => [receipt.index, receipt]));
        if (result.status !== 'unknown' && (receipts.size !== preview.files.length || result.files.some(file => receipts.get(file.index)?.status !== file.status))) fail('recovery_required', 'Known change-set results require every exact durable file receipt');
        if (result.status === 'unknown' && result.files.some(file => {
          const receipt = receipts.get(file.index);
          const status = !receipt ? 'not_applied' : receipt.status === 'prepared' ? 'unknown' : receipt.status;
          return file.status !== status;
        })) fail('payload_mismatch', 'Unknown change-set result cannot invent or replace durable file facts');
        if (result.status === 'unknown' && event.result.status !== 'unknown' || result.status === 'completed' && event.result.status !== 'completed' || result.status === 'partial' && event.result.status !== 'failed' || result.status === 'not_applied' && event.result.status !== 'not_executed') fail('invalid_record', 'Change-set result status cannot downgrade unknown effects');
      }

      return;
    }
    if (event.type === 'run_finished') {
      const result = event.result;
      if (!object(result) || !VALID_STATUSES.has(result.status) || result.committed !== true || !equal(result.identity, identity)) fail('invalid_record', 'Invalid terminal run result');
      validateContext(result.context);
      if (!equal(result.context, this.context)) fail('context_mismatch', 'Terminal context differs from durable model/tool items');
      const unresolved = [...run.tools.values()].some(tool => !tool.completed || tool.completed.result.status === 'unknown' || uncertainCommand(tool)) || this.runCompactionAttempts.get(run.identity.runId)?.status === 'attempted';
      if (unresolved && result.status !== 'recovery_required') fail('recovery_required', 'Unresolved tool effects require recovery');
      return;
    }
    fail('invalid_record', 'Unknown journal event type');
  }

  private apply(record: RunStoreRecord): void {
    const event = record.event;
    if (event.type === 'conversation_created') return;
    if (event.type === 'startup_prepared') {
      const request = event.request;
      let startups = this.startups.get(request.identity.requestId);
      if (!startups) { startups = new Map(); this.startups.set(request.identity.requestId, startups); }
      startups.set(request.startupId, { ...request, preparedSeq: record.seq });
      return;
    }
    if (event.type === 'startup_closed') {
      this.startups.get(record.identity!.requestId)!.get(event.startupId)!.closedSeq = record.seq;
      return;
    }
    if (event.type === 'run_started') {
      const request = event.request;
      this.originalUserItems ??= clone(request.userItems);
      this.contextTurns.push({ runId: request.identity.runId, start: this.context?.items.length ?? 0 });
      this.runs.set(request.identity.runId, {
        identity: request.identity, input: request.input, inputDigest: request.inputDigest,
        configuration: request.configuration, policyRevision: request.policyRevision,
        payloadDigest: event.payloadDigest, startedSeq: record.seq, status: 'active', tools: new Map(),
      });
      this.submissions.set(request.identity.requestId, request.identity.runId);
      this.context = { ...(this.context ?? { protocol: request.protocol }), items: [...(this.context?.items ?? []), ...request.userItems] };
      return;
    }
    if (event.type === 'run_recovered') {
      const run = this.runs.get(event.runId)!;
      run.status = 'recovery_required'; run.recoveryReason = event.reason;
      for (const tool of run.tools.values()) if (tool.prepared && !tool.completed || uncertainCommand(tool)) tool.state = 'unknown';
      return;
    }
    if (event.type === 'recovery_resolved') {
      const run = this.runs.get(event.runId)!;
      for (const completion of event.completions) {
        const tool = run.tools.get(completion.call.id)!;
        tool.completed = completion; tool.completedSeq = record.seq; tool.state = 'completed';
      }
      this.context = clone(event.result.context);
      run.status = 'cancelled';
      run.recoveryResolution = { expectedHash: event.expectedHash, seq: record.seq, result: event.result };
      // A committed original submission receipt is immutable, even if its
      // recovery barrier is subsequently resolved by a distinct host action.
      if (!run.result) { run.result = event.result; run.finishedSeq = record.seq; }
      return;
    }
    if (event.type === 'context_compacted') {
      const firstRetained = event.plan.retainedTurns[0];
      const previousStart = this.contextTurns.find(turn => turn.runId === firstRetained.runId)!.start;
      this.contextBatches = this.contextBatches.filter(batch => batch.start >= previousStart).map(batch => ({ ...batch, start: batch.start - previousStart + firstRetained.start }));
      this.context = clone(event.plan.context);
      this.contextTurns = clone(event.plan.retainedTurns);
      this.lastCompaction = { expectedHash: event.plan.expectedHash, seq: record.seq, beforeBytes: event.plan.beforeBytes, afterBytes: event.plan.afterBytes, createdAt: record.committedAt, ...(event.plan.usage === undefined ? {} : { usage: clone(event.plan.usage) }), ...(event.plan.automaticRequestId === undefined ? {} : { automaticRequestId: event.plan.automaticRequestId }) };
      if (event.plan.automaticRequestId !== undefined) {
        const attempt = this.autoCompactionAttempts.get(event.plan.automaticRequestId)!;
        attempt.status = 'committed'; attempt.compactionSeq = record.seq;
      }
      return;
    }
    if (event.type === 'context_compaction_attempted') {
      const { type: _type, ...request } = event;
      this.autoCompactionAttempts.set(event.requestId, { ...request, seq: record.seq, createdAt: record.committedAt, status: 'attempted' });
      this.autoCompactionContexts.set(event.contextHash, event.requestId);
      return;
    }
    const run = this.runs.get(record.identity!.runId)!;
    if (event.type === 'run_context_compaction_attempted') {
      this.runCompactionAttempts.set(run.identity.runId, { ...clone(event.request), runId: run.identity.runId, seq: record.seq, createdAt: record.committedAt, status: 'attempted', beforeBytes: Buffer.byteLength(JSON.stringify(this.context)) });
    } else if (event.type === 'run_context_compacted') {
      this.context = clone(event.plan.context);
      this.contextTurns = clone(event.plan.retainedTurns);
      this.contextBatches = clone(event.plan.retainedBatches);
      Object.assign(this.runCompactionAttempts.get(run.identity.runId)!, { status: 'committed', usage: clone(event.plan.usage), afterBytes: event.plan.afterBytes, compactionSeq: record.seq, finishedSeq: record.seq });
    } else if (event.type === 'run_context_compaction_failed') {
      Object.assign(this.runCompactionAttempts.get(run.identity.runId)!, { status: 'failed', usage: clone(event.failure.usage), reason: event.failure.reason, finishedSeq: record.seq });
    } else if (event.type === 'model_response') {
      this.contextBatches.push({ runId: run.identity.runId, start: this.context!.items.length });
      this.context = { protocol: this.context!.protocol, items: [...this.context!.items, ...event.response.outputItems], ...(event.response.continuation === undefined ? {} : { continuation: event.response.continuation }) };
      for (const call of event.response.toolCalls) run.tools.set(call.id, { call, state: 'requested' });
    } else if (event.type === 'tool_prepared') {
      const tool = run.tools.get(event.prepared.call.id)!;
      tool.prepared = event; tool.preparedSeq = record.seq; tool.state = 'prepared';
    } else if (event.type === 'change_set_file') {
      const tool = run.tools.get(event.toolCallId)!;
      (tool.changeSetProgress ??= []).push({ ...event.progress, seq: record.seq });
    } else if (event.type === 'command_lifecycle') {
      const tool = run.tools.get(event.toolCallId)!;
      (tool.commandProgress ??= []).push({ ...event.progress, seq: record.seq });
    } else if (event.type === 'tool_completed') {
      const tool = run.tools.get(event.call.id)!;
      tool.completed = event; tool.completedSeq = record.seq; tool.state = event.result.status === 'unknown' ? 'unknown' : 'completed';
      this.context = { ...this.context!, items: [...this.context!.items, ...event.resultItems] };
    } else if (event.type === 'run_finished') {
      run.status = event.result.status; run.result = event.result; run.finishedSeq = record.seq;
      if (run.status === 'recovery_required') for (const tool of run.tools.values()) if (tool.prepared && !tool.completed || uncertainCommand(tool)) tool.state = 'unknown';
    }
  }

  /** Remaining receipts retain their reservation while unrelated model/tools append. */
  private commandHeadroom(identity?: RunIdentity, event?: StoreEvent): { bytes: number; records: number } {
    let bytes = 0, records = 0;
    for (const run of this.runs.values()) {
      if (run.status !== 'active' || event?.type === 'run_finished' && identity?.runId === run.identity.runId || event?.type === 'run_recovered' && event.runId === run.identity.runId) continue;
      let pending = false;
      for (const tool of run.tools.values()) {
        const replacement = event?.type === 'command_lifecycle' && identity?.runId === run.identity.runId && event.toolCallId === tool.call.id ? event.progress : undefined;
        const intent = replacement?.status === 'prepared' ? replacement : tool.commandProgress?.[0];
        const current = replacement ?? tool.commandProgress?.at(-1);
        if (intent?.status !== 'prepared' || !current) continue;
        const lifecyclePending = current.status !== 'finished' && current.status !== 'unknown';
        const acknowledgementPending = !tool.completed && !(event?.type === 'tool_completed' && identity?.runId === run.identity.runId && event.call.id === tool.call.id);
        if (!lifecyclePending && !acknowledgementPending) continue;
        pending = true;
        if (lifecyclePending) {
          bytes += commandTerminalBytes(intent.maxOutputBytes) + (current.status === 'prepared' ? COMMAND_ENVELOPE_BYTES : 0);
          records += current.status === 'prepared' ? 2 : 1;
        }
        if (acknowledgementPending) { bytes += this.limits.maxRecordBytes; records++; }
      }
      if (pending) { bytes += this.limits.maxRecordBytes; records++; }
    }
    return { bytes, records };
  }

  private runCompactionHeadroom(identity: RunIdentity | undefined, event: StoreEvent): { bytes: number; records: number } {
    let records = 0;
    for (const run of this.runs.values()) {
      if (run.status !== 'active' || event.type === 'run_recovered' && event.runId === run.identity.runId || event.type === 'run_finished' && identity?.runId === run.identity.runId) continue;
      const changed = identity?.runId === run.identity.runId;
      if (changed && (event.type === 'run_context_compacted' || event.type === 'run_context_compaction_failed')) { records++; continue; }
      const attempt = this.runCompactionAttempts.get(run.identity.runId);
      if (attempt || changed && event.type === 'run_context_compaction_attempted') records += !attempt || attempt.status === 'attempted' ? 2 : 1;
    }
    return { bytes: records * this.limits.maxRecordBytes, records };
  }

  private async commit(identity: RunIdentity | undefined, value: StoreEvent): Promise<{ seq: number }> {
    this.writable();
    const event = clone(value);
    const ownedIdentity = identity ? clone(identity) : undefined;
    this.rejectSecrets(event);
    this.validateEvent(ownedIdentity, event);
    const body = { schemaVersion: 1 as const, conversationId: this.conversationId, seq: this.records.length + 1, committedAt: new Date().toISOString(), ...(ownedIdentity ? { identity: ownedIdentity } : {}), event, previousHash: this.records.at(-1)?.hash ?? ZERO_HASH };
    const record: RunStoreRecord = { ...body, hash: digest(body) };
    const line = `${canonical(record)}\n`;
    const bytes = Buffer.byteLength(line);
    if (bytes > this.limits.maxRecordBytes || this.journalBytes + bytes > this.limits.maxJournalBytes || this.records.length >= this.limits.maxRecords) fail('limit_exceeded', 'Conversation disk budget exhausted; history is never silently pruned');
    const commandHeadroom = this.commandHeadroom(ownedIdentity, event);
    const compactionHeadroom = this.runCompactionHeadroom(ownedIdentity, event);
    if (event.type === 'command_lifecycle' && event.progress.status === 'prepared' && commandTerminalBytes(event.progress.maxOutputBytes) > this.limits.maxRecordBytes) fail('limit_exceeded', 'Command terminal receipt exceeds the configured record budget');
    if (this.journalBytes + bytes + commandHeadroom.bytes > this.limits.maxJournalBytes || this.records.length + 1 + commandHeadroom.records > this.limits.maxRecords) fail('limit_exceeded', 'Outstanding command terminal receipts have reserved durable storage');
    if (this.journalBytes + bytes + commandHeadroom.bytes + compactionHeadroom.bytes > this.limits.maxJournalBytes || this.records.length + 1 + commandHeadroom.records + compactionHeadroom.records > this.limits.maxRecords) fail('limit_exceeded', 'In-turn summary outcome and terminal run have reserved durable storage');
    if (event.type === 'tool_prepared' && event.prepared.call.name === 'apply_change_set') {
      const preview = (event.prepared.preconditions as JsonObject).changeSet as unknown as NativeChangeSetPreview;
      // Reserve every before/after file receipt now. A later file must not consume
      // the room needed to attest its own effects, tool result and terminal run.
      const receiptBytes = preview.files.reduce((sum, file) => sum + 2 * (Buffer.byteLength(canonical({ type: 'change_set_file', toolCallId: event.prepared.call.id, progress: { changeSetDigest: preview.digest, index: file.index, path: file.path, status: 'not_applied', beforeHash: file.beforeHash, afterHash: file.afterHash, errorCode: 'x'.repeat(64) } })) + Buffer.byteLength(canonical(ownedIdentity)) + 1024), 0);
      if (this.journalBytes + bytes + receiptBytes + 2 * this.limits.maxRecordBytes + commandHeadroom.bytes > this.limits.maxJournalBytes || this.records.length + 1 + 2 * preview.files.length + 2 + commandHeadroom.records > this.limits.maxRecords) fail('limit_exceeded', 'Insufficient durable headroom for every change-set file receipt');
    }
    if ((event.type === 'tool_prepared' || event.type === 'startup_prepared') && (this.journalBytes + bytes + 2 * this.limits.maxRecordBytes + commandHeadroom.bytes > this.limits.maxJournalBytes || this.records.length + 3 + commandHeadroom.records > this.limits.maxRecords)) fail('limit_exceeded', 'Insufficient cleanup and terminal record headroom before preparing a side effect');
    try {
      await this.checkPath();
      await this.options.fault?.('before_append', event.type);
      const file = path.join(this.directory, 'journal.jsonl');
      const handle = await open(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size !== this.journalBytes || (this.journalIdentity && (this.journalIdentity.dev !== stat.dev || this.journalIdentity.ino !== stat.ino))) fail('writer_lost', 'Journal changed outside the active writer');
        this.journalIdentity = { dev: stat.dev, ino: stat.ino };
        await handle.writeFile(line, 'utf8');
        await this.options.fault?.('after_write', event.type);
        await handle.sync();
        await this.options.fault?.('after_sync', event.type);
      } finally { await handle.close(); }
      if (record.seq === 1) await syncDirectory(this.directory);
      this.apply(record); this.records.push(record); this.journalBytes += bytes;
      return { seq: record.seq };
    } catch (error) { this.poisoned = true; throw error; }
  }

  /** Commit exact host approval before any local service process may be spawned. Never authorizes a replay. */
  prepareStartup(request: NativeStartupRequest): Promise<{ seq: number }> {
    return this.exclusive(async () => {
      this.writable();
      if (this.recoveredStartupRequests.size) fail('conversation_busy', 'Previous startup resources require recovery');
      const owned = clone(request);
      validateStartupRequest(owned, this.conversationId);
      if (owned.approval.expiresAt <= Date.now()) fail('stale_approval', 'Startup approval has expired');
      const accepted = await this.commit(owned.identity, { type: 'startup_prepared', request: owned });
      this.liveStartups.add(this.startups.get(owned.identity.requestId)!.get(owned.startupId)!);
      return accepted;
    });
  }

  /** Only the writer that prepared the startup can confirm all of its local resources have closed. */
  closeStartup(identity: RunIdentity, startupId: string): Promise<{ seq: number }> {
    return this.exclusive(async () => {
      this.writable();
      validateIdentity(identity, this.conversationId);
      text(startupId, 'startup id', 256);
      const startup = this.startups.get(identity.requestId)?.get(startupId);
      if (!startup || !equal(startup.identity, identity)) fail('stale_owner', 'Startup no longer belongs to this execution');
      if (startup.closedSeq !== undefined) return { seq: startup.closedSeq };
      if (!this.liveStartups.has(startup)) fail('recovery_required', 'A new writer cannot attest cleanup of a previous host startup');
      const closed = await this.commit(identity, { type: 'startup_closed', startupId });
      this.liveStartups.delete(startup);
      return closed;
    });
  }

  lookupStartup(requestId: string): NativeStartupReceipt | undefined {
    const startups = this.startups.get(requestId);
    if (!startups?.size) return undefined;
    const first = startups.values().next().value!;
    return clone({ identity: first.identity, inputDigest: first.inputDigest, optionsDigest: first.optionsDigest,
      status: this.recoveredStartupRequests.has(requestId) ? 'recovery_required' : [...startups.values()].every(startup => startup.closedSeq !== undefined) ? 'closed' : 'live',
      startups: [...startups.values()].map(({ startupId, metadata, preparedSeq, closedSeq }) => ({ startupId, metadata, preparedSeq, ...(closedSeq === undefined ? {} : { closedSeq }) })),
    });
  }

  beginRun(request: BeginRunRequest): Promise<BeginRunResult> {
    return this.exclusive(async () => {
      this.writable();
      if (this.recoveredStartupRequests.size) fail('conversation_busy', 'Previous startup resources require recovery');
      validateIdentity(request.identity, this.conversationId);
      const existingId = this.submissions.get(request.identity.requestId);
      if (existingId) {
        const run = this.runs.get(existingId)!;
        if (run.identity.sessionId !== request.identity.sessionId || run.payloadDigest !== payloadDigest(request) || run.inputDigest !== request.inputDigest) fail('payload_mismatch', 'Submission identity was reused with different input/configuration');
        return clone({ kind: 'duplicate' as const, identity: run.identity, ...(run.result ? { result: run.result } : {}) });
      }
      await this.commit(request.identity, { type: 'run_started', request, payloadDigest: payloadDigest(request) });
      return { kind: 'accepted', context: clone(this.context!) };
    });
  }

  append(identity: RunIdentity, event: RunJournalEvent): Promise<{ seq: number }> {
    return this.exclusive(async () => {
      this.writable();
      if (!['model_response', 'tool_prepared', 'tool_completed', 'run_finished'].includes((event as { type: string }).type)) fail('invalid_record', 'Host records cannot be appended by the execution worker');
      const run = this.owner(identity);
      if (event.type === 'tool_completed') {
        const tool = run.tools.get(event.call.id);
        if (tool?.completed) {
          if (!equal(tool.completed, event)) fail('payload_mismatch', 'Tool call identity was reused with a different result');
          return { seq: tool.completedSeq! };
        }
      }
      if (event.type === 'run_finished' && run.result) {
        if (!equal(run.result, event.result)) fail('payload_mismatch', 'Terminal run result changed');
        return { seq: run.finishedSeq! };
      }
      return this.commit(identity, event);
    });
  }

  private changeSetPreview(tool: StoredToolState | undefined): NativeChangeSetPreview {
    const prepared = tool?.prepared;
    if (!prepared || tool!.completed || prepared.prepared.call.name !== 'apply_change_set' || !prepared.prepared.requiresApproval || prepared.approval?.decision !== 'approved' || !object(prepared.prepared.preconditions) || !isNativeChangeSetPreview(prepared.prepared.preconditions.changeSet)) fail('not_prepared', 'File receipts require an unfinished durable approved change-set call');
    return prepared.prepared.preconditions.changeSet;
  }

  /** Host-only write-ahead/effect receipts. No worker RPC exposes this method. */
  recordChangeSetEvent(identity: RunIdentity, call: ToolCall, progress: NativeChangeSetFileEvent): Promise<{ seq: number }> {
    return this.exclusive(async () => {
      this.writable();
      const run = this.activeOwner(identity), tool = run.tools.get(call.id);
      if (!tool || !equal(tool.call, call)) fail('payload_mismatch', 'File receipt does not belong to the committed tool call');
      this.changeSetPreview(tool);
      return this.commit(identity, { type: 'change_set_file', toolCallId: call.id, progress });
    });
  }

  /** Host-only lifecycle facts; the execution worker cannot call or forge this API. */
  recordCommandEvent(identity: RunIdentity, call: ToolCall, progress: NativeCommandLifecycleEvent): Promise<{ seq: number }> {
    return this.exclusive(async () => {
      this.writable();
      const run = this.activeOwner(identity), tool = run.tools.get(call.id);
      if (!tool || !equal(tool.call, call)) fail('payload_mismatch', 'Command receipt does not belong to the committed start call');
      return this.commit(identity, { type: 'command_lifecycle', toolCallId: call.id, progress });
    });
  }

  ensureCapacity(identity: RunIdentity, bytes: number): Promise<void> {
    return this.exclusive(async () => {
      this.writable(); this.activeOwner(identity);
      if (!Number.isSafeInteger(bytes) || bytes < 0) fail('invalid_limits', 'Capacity request must be a nonnegative integer');
      // One writer, sequential core: no other run can consume this headroom.
      // Keep room for a bounded prepared/result record and terminal context, plus
      // the atomic checkpoint's old and new copies (separately size-limited).
      const reserved = bytes + 3 * this.limits.maxRecordBytes;
      const commands = this.commandHeadroom();
      if (this.journalBytes + reserved + commands.bytes > this.limits.maxJournalBytes || this.records.length + 3 + commands.records > this.limits.maxRecords) fail('limit_exceeded', 'Insufficient durable storage headroom before tool execution');
    });
  }

  checkpoint(identity: RunIdentity, context: ModelContext): Promise<void> {
    return this.exclusive(async () => {
      this.writable(); this.owner(identity); validateContext(context);
      if (!equal(context, this.context)) fail('context_mismatch', 'Checkpoint cannot introduce context absent from the durable journal');
      const last = this.records.at(-1)!;
      const body = { schemaVersion: 1 as const, conversationId: this.conversationId, seq: last.seq, journalHash: last.hash, context: clone(context) };
      const checkpoint: Checkpoint = { ...body, hash: digest(body) };
      this.rejectSecrets(checkpoint);
      const data = canonical(checkpoint);
      if (Buffer.byteLength(data) > this.limits.maxCheckpointBytes) fail('limit_exceeded', 'Complete model context exceeds checkpoint budget');
      const temporary = path.join(this.directory, `checkpoint-${randomUUID()}.tmp`);
      try {
        await this.checkPath();
        await this.options.fault?.('before_checkpoint', 'checkpoint');
        const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
        try { await handle.writeFile(data, 'utf8'); await handle.sync(); await this.options.fault?.('after_checkpoint_sync', 'checkpoint'); } finally { await handle.close(); }
        await rename(temporary, path.join(this.directory, 'checkpoint.json'));
        await syncDirectory(this.directory);
        await this.options.fault?.('after_checkpoint_rename', 'checkpoint');
      } catch (error) { this.poisoned = true; throw error; }
      finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
    });
  }

  getRecoveryReport(): RecoveryReport | null {
    const startupRequestId = this.recoveredStartupRequests.values().next().value;
    if (startupRequestId !== undefined) {
      const startups = [...this.startups.get(startupRequestId)!.values()];
      const run = this.runs.get(startups[0].identity.runId);
      const tools: RecoveryReport['tools'] = [...run?.tools.values() ?? []].map(tool => ({
        callId: tool.call.id, name: tool.call.name,
        status: tool.completed?.result.status === 'unknown' || !tool.completed && tool.prepared || uncertainCommand(tool) ? 'unknown' : tool.completed ? 'completed' : 'not_executed',
      }));
      for (const startup of startups) if (startup.closedSeq === undefined) tools.push({ callId: startup.startupId, name: 'mcp_stdio_startup', status: 'unknown' });
      return { runId: startups[0].identity.runId, expectedHash: this.records.at(-1)!.hash, classification: 'unknown_effects', tools };
    }
    const run = [...this.runs.values()].find(item => item.status === 'recovery_required');
    if (!run) return null;
    const tools: RecoveryReport['tools'] = [...run.tools.values()].map(tool => ({
      callId: tool.call.id, name: tool.call.name,
      status: tool.completed?.result.status === 'unknown' || !tool.completed && tool.prepared || uncertainCommand(tool) ? 'unknown' : tool.completed ? 'completed' : 'not_executed',
    }));
    let classification: RecoveryReport['classification'] = tools.some(tool => tool.status === 'unknown') ? 'unknown_effects' : 'safe_to_continue';
    if (classification === 'safe_to_continue') {
      try {
        if (!this.context) throw new Error();
        const pending = contextPendingCalls(this.context);
        const expected = [...run.tools.values()].filter(tool => !tool.completed).map(tool => tool.call);
        if (!equal(pending, expected)) throw new Error();
      } catch { classification = 'unsupported_protocol'; }
    }
    return { runId: run.identity.runId, expectedHash: this.records.at(-1)!.hash, classification, tools };
  }

  private recoveryResolution(runId: string, expectedHash: string): { completions: RecoveryCompletion[]; result: RunResult } {
    if (expectedHash !== this.records.at(-1)?.hash) fail('stale_context', 'Conversation changed since recovery inspection');
    const report = this.getRecoveryReport();
    if (!report || report.runId !== runId) fail('recovery_unavailable', 'No matching unresolved run');
    if (report.classification !== 'safe_to_continue') fail(report.classification, 'Uncertain tool outcomes cannot be replayed or bypassed');
    const run = this.runs.get(runId)!;
    const completions: RecoveryCompletion[] = [...run.tools.values()].filter(tool => !tool.completed).map(tool => {
      const result = { status: 'not_executed' as const, output: { error: 'host_interrupted_before_execution', executed: false } };
      return { type: 'tool_completed', call: clone(tool.call), result, resultItems: nativeToolResultItems(this.context!.protocol, tool.call, result) };
    });
    const context: ModelContext = { ...clone(this.context!), items: [...clone(this.context!.items), ...completions.flatMap(item => item.resultItems)] };
    requireCompleteContext(context);
    const responses = this.records.filter(record => record.identity?.runId === runId).flatMap(record => record.event.type === 'model_response' ? [record.event.response] : []);
    const maintenance = this.runCompactionAttempts.get(runId);
    const usages = [...responses.map(response => response.usage), ...(maintenance ? [maintenance.usage ?? null] : [])];
    let usage: RunResult['usage'] = null;
    if (run.result) usage = clone(run.result.usage);
    else if (usages.length && usages.every(value => value !== null)) {
      usage = {};
      for (const key of ['inputTokens', 'outputTokens', 'totalTokens'] as const) {
        const values = usages.map(value => value?.[key]);
        if (values.every((value): value is number => value !== undefined && Number.isFinite(value) && value >= 0)) {
          const total = values.reduce((sum, value) => sum + value, 0);
          if (Number.isFinite(total)) usage[key] = total;
        }
      }
    }
    return { completions, result: { identity: clone(run.identity), status: 'cancelled', reason: 'recovery_resolved',
      modelRequests: run.result?.modelRequests ?? responses.length + (maintenance ? 1 : 0),
      toolCalls: run.result?.toolCalls ?? [...run.tools.values()].filter(tool => tool.prepared || tool.completed).length,
      usage, context, committed: true } };
  }

  /** Explicit host action after cleanup, never automatic tool execution or approval reuse. */
  resolveRecovery(request: { runId: string; expectedHash: string; resourcesVerified: true }): Promise<RunResult> {
    return this.exclusive(async () => {
      this.writable();
      if (request.resourcesVerified !== true) fail('resources_unverified', 'Host must verify old execution resources are released');
      const previous = this.runs.get(request.runId)?.recoveryResolution;
      if (previous?.expectedHash === request.expectedHash) return clone(previous.result);
      const resolution = this.recoveryResolution(request.runId, request.expectedHash);
      await this.commit(undefined, { type: 'recovery_resolved', runId: request.runId, expectedHash: request.expectedHash, resourcesVerified: true, ...resolution });
      return clone(resolution.result);
    });
  }

  private runCompactionBoundary(identity: RunIdentity): { boundary: number; goals: JsonValue[]; currentStart: number } {
    const run = this.activeOwner(identity);
    if (this.recoveryRequired) fail('recovery_required', 'Context maintenance cannot cross a recovery barrier');
    if ([...run.tools.values()].some(tool => !tool.completed || tool.completed.result.status === 'unknown')) fail('pending_tools', 'In-turn compaction requires complete durable tool outcomes');
    if ([...run.tools.values()].some(tool => uncertainCommand(tool))) fail('commands_active', 'In-turn compaction waits for all command handles to finish');
    if (!this.context) fail('nothing_to_compact', 'No model context is available');
    requireCompleteContext(this.context);
    const batch = this.contextBatches.filter(item => item.runId === identity.runId).at(-1);
    if (!batch || !this.contextBatches.some(item => item.start < batch.start)) fail('nothing_to_compact', 'An older complete batch and a retained current batch are required');
    const start = this.records[run.startedSeq - 1].event;
    if (start.type !== 'run_started') fail('corrupt_store', 'Current run has no original input');
    const firstRun = this.runs.values().next().value!;
    const sameOriginal = firstRun.identity.runId === identity.runId;
    return { boundary: batch.start, goals: [...clone(this.originalUserItems!), ...(sameOriginal ? [] : clone(start.request.userItems))], currentStart: sameOriginal ? 0 : this.originalUserItems!.length };
  }

  /** Complete durable model/tool boundary. The execution worker cannot invoke this host API. */
  getRunCompactionSource(identity: RunIdentity, expectedContext?: ModelContext): RunCompactionSource {
    this.writable();
    if (expectedContext !== undefined && !equal(expectedContext, this.context)) fail('context_mismatch', 'Worker context differs from the durable run context');
    const { boundary, goals } = this.runCompactionBoundary(identity);
    const context: ModelContext = { protocol: clone(this.context!.protocol), items: clone(this.context!.items.slice(0, boundary)) };
    requireCompleteContext(context);
    const latest = this.records.at(-1)!;
    return { expectedHash: latest.hash, sourceSeq: latest.seq, contextHash: digest(this.context), scope: 'prefix', context,
      beforeBytes: Buffer.byteLength(JSON.stringify(this.context)), retainedContext: { protocol: clone(this.context!.protocol), items: [...goals, ...clone(this.context!.items.slice(boundary))] } };
  }

  /** Reserve once per run before any billable summary request. A lost acknowledgment never authorizes retry. */
  reserveRunCompaction(identity: RunIdentity, request: RunCompactionRequest): Promise<{ kind: 'reserved' | 'existing'; attempt: RunCompactionAttempt }> {
    return this.exclusive(async () => {
      this.writable(); this.owner(identity); validateRunCompactionRequest(request);
      const prior = this.runCompactionAttempts.get(identity.runId);
      if (prior) {
        if (prior.requestId !== request.requestId || prior.contextHash !== request.contextHash) fail('payload_mismatch', 'In-turn summary reservation was reused with different input');
        return { kind: 'existing', attempt: clone(prior) };
      }
      await this.commit(identity, { type: 'run_context_compaction_attempted', request });
      return { kind: 'reserved', attempt: clone(this.runCompactionAttempts.get(identity.runId)!) };
    });
  }

  private planRunCompaction(identity: RunIdentity, input: RunCompactionInput): RunCompactionPlan {
    validateRunCompactionRequest(input); validateSummaryUsage(input.usage);
    const attempt = this.runCompactionAttempts.get(identity.runId);
    if (!attempt || attempt.requestId !== input.requestId || attempt.contextHash !== input.contextHash || attempt.status !== 'attempted') fail('compaction_unavailable', 'In-turn compaction requires an unused durable reservation');
    const source = this.getRunCompactionSource(identity);
    if (source.contextHash !== input.contextHash) fail('stale_context', 'Run context changed while producing the summary');
    const { boundary, goals, currentStart } = this.runCompactionBoundary(identity);
    const prefix = [...goals, contextSummaryItem(input.summary, this.context!.protocol), runContinuityItem(input.continuity, this.context!.protocol)];
    const context: ModelContext = { protocol: clone(this.context!.protocol), items: [...prefix, ...clone(this.context!.items.slice(boundary))] };
    requireCompleteContext(context);
    const afterBytes = Buffer.byteLength(JSON.stringify(context));
    if (afterBytes >= source.beforeBytes) fail('compaction_not_smaller', 'In-turn summary would not reduce the model context');
    if (Buffer.byteLength(canonical({ schemaVersion: 1, conversationId: this.conversationId, seq: this.records.length + 1, journalHash: ZERO_HASH, context, hash: ZERO_HASH })) > this.limits.maxCheckpointBytes) fail('limit_exceeded', 'Compacted context exceeds checkpoint limit');
    return { requestId: input.requestId, contextHash: input.contextHash, summary: input.summary, continuity: input.continuity, usage: clone(input.usage), beforeBytes: source.beforeBytes, afterBytes, context,
      retainedTurns: [{ runId: identity.runId, start: currentStart }], retainedBatches: [{ runId: identity.runId, start: prefix.length }] };
  }

  /** Construct and publish the complete replacement in one serialized append+fsync. */
  commitRunCompaction(identity: RunIdentity, input: RunCompactionInput): Promise<RunCompactionReceipt> {
    return this.exclusive(async () => {
      this.writable(); this.owner(identity);
      const attempt = this.runCompactionAttempts.get(identity.runId);
      if (attempt?.compactionSeq !== undefined) {
        const prior = this.records[attempt.compactionSeq - 1].event;
        if (prior.type !== 'run_context_compacted' || !equal(input, { requestId: prior.plan.requestId, contextHash: prior.plan.contextHash, summary: prior.plan.summary, continuity: prior.plan.continuity, usage: prior.plan.usage })) fail('payload_mismatch', 'In-turn compaction receipt cannot change');
        return { seq: attempt.compactionSeq, context: clone(prior.plan.context), beforeBytes: prior.plan.beforeBytes, afterBytes: prior.plan.afterBytes };
      }
      const plan = this.planRunCompaction(identity, input);
      const receipt = await this.commit(identity, { type: 'run_context_compacted', plan });
      return { ...receipt, context: clone(plan.context), beforeBytes: plan.beforeBytes, afterBytes: plan.afterBytes };
    });
  }

  failRunCompaction(identity: RunIdentity, failure: RunCompactionFailure): Promise<{ seq: number }> {
    return this.exclusive(async () => {
      this.writable(); this.owner(identity);
      const attempt = this.runCompactionAttempts.get(identity.runId);
      if (attempt?.status === 'failed') {
        const prior = this.records[attempt.finishedSeq! - 1].event;
        if (prior.type !== 'run_context_compaction_failed' || !equal(prior.failure, failure)) fail('payload_mismatch', 'Summary failure receipt cannot change');
        return { seq: attempt.finishedSeq! };
      }
      return this.commit(identity, { type: 'run_context_compaction_failed', failure });
    });
  }

  lookupRunCompaction(runId: string): RunCompactionAttempt | undefined {
    const attempt = this.runCompactionAttempts.get(runId);
    return attempt ? clone(attempt) : undefined;
  }

  private compactionBoundary(keepRecentTurns: number): number {
    if (!Number.isSafeInteger(keepRecentTurns) || keepRecentTurns < 1 || keepRecentTurns > 10_000) fail('invalid_limits', 'At least one complete recent turn must be retained');
    if (this.recoveryRequired || [...this.runs.values()].some(run => run.status === 'active')) fail('conversation_busy', 'Context maintenance requires an idle conversation without recovery barriers');
    if (!this.context || this.contextTurns.length <= keepRecentTurns) fail('nothing_to_compact', 'At least one older and one retained complete turn are required');
    requireCompleteContext(this.context);
    return this.contextTurns[this.contextTurns.length - keepRecentTurns].start;
  }

  getCompactionSource(options: { keepRecentTurns?: number } = {}): ContextCompactionSource {
    this.writable();
    const boundary = this.compactionBoundary(options.keepRecentTurns ?? 1);
    const latest = this.records.at(-1)!;
    const context = { protocol: clone(this.context!.protocol), items: clone(this.context!.items.slice(0, boundary)) };
    requireCompleteContext(context);
    return { expectedHash: latest.hash, sourceSeq: latest.seq, context, beforeBytes: Buffer.byteLength(JSON.stringify(this.context)), scope: 'prefix' };
  }

  /** Reserve before contacting a model. An uncertain append must be inspected after reopening. */
  reserveAutoCompaction(request: AutoCompactionRequest): Promise<{ kind: 'reserved' | 'existing'; attempt: AutoCompactionAttempt }> {
    return this.exclusive(async () => {
      this.writable();
      validateAutoCompactionRequest(request);
      const existing = this.autoCompactionAttempts.get(request.requestId);
      if (existing) {
        if (existing.inputDigest !== request.inputDigest || existing.configurationDigest !== request.configurationDigest) fail('payload_mismatch', 'Automatic compaction request was reused with different input or configuration');
        return { kind: 'existing', attempt: clone(existing) };
      }
      const source = this.getCompactionSource();
      const contextHash = digest(this.context);
      const contextRequestId = this.autoCompactionContexts.get(contextHash);
      if (contextRequestId !== undefined) return { kind: 'existing', attempt: clone(this.autoCompactionAttempts.get(contextRequestId)!) };
      if (request.expectedHash !== source.expectedHash) fail('stale_context', 'Conversation changed before reserving automatic compaction');
      await this.commit(undefined, { type: 'context_compaction_attempted', requestId: request.requestId, inputDigest: request.inputDigest, configurationDigest: request.configurationDigest, expectedHash: request.expectedHash, contextHash });
      return { kind: 'reserved', attempt: clone(this.autoCompactionAttempts.get(request.requestId)!) };
    });
  }

  lookupAutoCompaction(requestId: string): AutoCompactionAttempt | undefined {
    const attempt = this.autoCompactionAttempts.get(requestId);
    return attempt === undefined ? undefined : clone(attempt);
  }

  getAutoCompactionForCurrentContext(): AutoCompactionAttempt | null {
    if (this.autoCompactionContexts.size === 0) return null;
    const requestId = this.autoCompactionContexts.get(digest(this.context));
    return requestId === undefined ? null : clone(this.autoCompactionAttempts.get(requestId)!);
  }

  planContextCompaction(options: { summary: string; keepRecentTurns?: number; expectedHash?: string; usage?: Usage | null; automaticRequestId?: string }): ContextCompactionPlan {
    if (options.usage !== undefined && options.usage !== null) {
      if (!object(options.usage) || Object.entries(options.usage).some(([key, value]) => !['inputTokens', 'outputTokens', 'totalTokens'].includes(key) || !Number.isSafeInteger(value) || (value as number) < 0)) fail('invalid_usage', 'Summary usage must contain only nonnegative integer token counts');
    }
    const keepRecentTurns = options.keepRecentTurns ?? 1;
    const source = this.getCompactionSource({ keepRecentTurns });
    if (options.expectedHash !== undefined && source.expectedHash !== options.expectedHash) fail('stale_context', 'Conversation changed while producing the summary');
    if (options.automaticRequestId !== undefined) {
      text(options.automaticRequestId, 'automatic request id', 256);
      const attempt = this.autoCompactionAttempts.get(options.automaticRequestId);
      if (!attempt || attempt.status !== 'attempted') fail('auto_compaction_unavailable', 'Automatic compaction requires an unused durable reservation');
      if (options.expectedHash !== source.expectedHash || attempt.contextHash !== digest(this.context) || this.records[attempt.seq - 1]?.hash !== source.expectedHash) fail('stale_context', 'Automatic compaction reservation no longer owns the current conversation head');
    }
    const summary = contextSummaryItem(options.summary, this.context!.protocol);
    const boundary = this.compactionBoundary(keepRecentTurns);
    const prefix = [...clone(this.originalUserItems!), summary];
    const context: ModelContext = { protocol: clone(this.context!.protocol), items: [...prefix, ...clone(this.context!.items.slice(boundary))] };
    requireCompleteContext(context);
    const afterBytes = Buffer.byteLength(JSON.stringify(context));
    if (afterBytes >= source.beforeBytes) fail('compaction_not_smaller', 'Summary would not reduce the complete model context');
    const checkpointBytes = Buffer.byteLength(canonical({ schemaVersion: 1, conversationId: this.conversationId, seq: source.sourceSeq + 1, journalHash: ZERO_HASH, context, hash: ZERO_HASH }));
    if (checkpointBytes > this.limits.maxCheckpointBytes) fail('limit_exceeded', 'Compacted context exceeds checkpoint limit');
    return { expectedHash: source.expectedHash, sourceSeq: source.sourceSeq, summary: options.summary, keepRecentTurns,
      beforeBytes: source.beforeBytes, afterBytes, context,
      ...(options.usage === undefined ? {} : { usage: clone(options.usage) }),
      ...(options.automaticRequestId === undefined ? {} : { automaticRequestId: options.automaticRequestId }),
      retainedTurns: this.contextTurns.slice(-keepRecentTurns).map(turn => ({ runId: turn.runId, start: turn.start - boundary + prefix.length })) };
  }

  /** One append-and-fsync event publishes the new context; all raw records stay intact. */
  commitContextCompaction(plan: ContextCompactionPlan): Promise<{ seq: number }> {
    return this.exclusive(async () => {
      this.writable();
      const automaticReceipt = plan.automaticRequestId === undefined ? undefined : this.autoCompactionAttempts.get(plan.automaticRequestId)?.compactionSeq;
      const priorSeq = automaticReceipt ?? (this.lastCompaction?.expectedHash === plan.expectedHash ? this.lastCompaction.seq : undefined);
      if (priorSeq !== undefined) {
        const prior = this.records[priorSeq - 1].event;
        if (prior.type !== 'context_compacted' || !equal(prior.plan, plan)) fail('payload_mismatch', 'Compaction identity was reused with a different plan');
        return { seq: priorSeq };
      }
      return this.commit(undefined, { type: 'context_compacted', plan });
    });
  }

  getLastCompaction(): ContextCompactionReceipt | null { return clone(this.lastCompaction); }

  /** Current protocol context; original protocol records remain available through replay. */
  loadContext(): ModelContext | null { return clone(this.context); }
  listRuns(): StoredRun[] {
    return [...this.runs.values()].map(run => {
      const { payloadDigest: _digest, finishedSeq: _seq, tools, ...publicRun } = run;
      return clone({ ...publicRun, tools: [...tools.values()] });
    });
  }
  lookupSubmission(requestId: string): { request: BeginRunRequest; identity: RunIdentity; status: StoredRun['status']; result?: RunResult } | undefined {
    const runId = this.submissions.get(requestId);
    if (!runId) return undefined;
    const run = this.runs.get(runId)!;
    const started = this.records.find(record => record.seq === run.startedSeq)!;
    if (started.event.type !== 'run_started') return undefined;
    return clone({ request: started.event.request, identity: run.identity, status: run.status, ...(run.result ? { result: run.result } : {}) });
  }
  getRun(runId: string): StoredRun | undefined { return this.listRuns().find(run => run.identity.runId === runId); }
  getToolState(runId: string, toolCallId: string): StoredToolState | undefined {
    const tool = this.runs.get(runId)?.tools.get(toolCallId);
    return tool ? clone(tool) : undefined;
  }
  /** Stable seq supports idempotent host/UI projection. */
  replay(afterSeq = 0, limit = 1000): RunStoreRecord[] {
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) fail('invalid_limits', 'Invalid replay range');
    return clone(this.records.filter(record => record.seq > afterSeq).slice(0, limit));
  }
  get recoveryRequired(): boolean { return this.poisoned || this.recoveredStartupRequests.size > 0 || [...this.runs.values()].some(run => run.status === 'recovery_required'); }
  get usage(): { journalBytes: number; records: number } { return { journalBytes: this.journalBytes, records: this.records.length }; }
  close(): Promise<void> {
    return this.exclusive(async () => {
      if (this.closed) return;
      this.closing = true;
      await this.releaseWriter?.();
      this.closed = true;
      this.releaseWriter = undefined;
    });
  }
}
