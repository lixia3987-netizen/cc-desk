import { constants } from 'node:fs';
import { lstat, open, readdir, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type {
  BeginRunRequest, BeginRunResult, ModelContext, RunIdentity, RunJournalEvent,
  RunResult, RunStore, ToolCall,
} from '@cc-desk/agent-core';
import { acquireWriter, assertUuid, readRegularFile, RunStoreError, safeDirectory, syncDirectory } from './store-files.js';

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
  tools: StoredToolState[];
}
type StoreEvent =
  | { type: 'conversation_created' }
  | { type: 'run_started'; request: BeginRunRequest; payloadDigest: string }
  | { type: 'run_recovered'; runId: string; reason: string }
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
const SECRET_FIELD = /^(?:api[_-]?key|authorization|password|secret|client[_-]?secret|access[_-]?token|refresh[_-]?token|credentials?|token|bearer[_-]?token)$/i;

function fail(code: string, message: string): never { throw new RunStoreError(code, message); }
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function text(value: unknown, label: string, max = 4096): asserts value is string {
  if (typeof value !== 'string' || !value.length || value.length > max || value.includes('\0')) fail('invalid_record', `Invalid ${label}`);
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
  private context: ModelContext | null = null;
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
  }

  private validateEvent(identity: RunIdentity | undefined, event: StoreEvent): void {
    if (!object(event) || typeof event.type !== 'string') fail('invalid_record', 'Invalid event');
    if (event.type === 'conversation_created') {
      if (identity || this.records.length) fail('invalid_record', 'Duplicate conversation creation');
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
    if (!identity) fail('invalid_identity', 'Run event is missing identity');
    const run = this.activeOwner(identity);
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
      return;
    }
    if (event.type === 'run_finished') {
      const result = event.result;
      if (!object(result) || !VALID_STATUSES.has(result.status) || result.committed !== true || !equal(result.identity, identity)) fail('invalid_record', 'Invalid terminal run result');
      validateContext(result.context);
      if (!equal(result.context, this.context)) fail('context_mismatch', 'Terminal context differs from durable model/tool items');
      const unresolved = [...run.tools.values()].some(tool => !tool.completed || tool.completed.result.status === 'unknown');
      if (unresolved && result.status !== 'recovery_required') fail('recovery_required', 'Unresolved tool effects require recovery');
      return;
    }
    fail('invalid_record', 'Unknown journal event type');
  }

  private apply(record: RunStoreRecord): void {
    const event = record.event;
    if (event.type === 'conversation_created') return;
    if (event.type === 'run_started') {
      const request = event.request;
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
      for (const tool of run.tools.values()) if (tool.prepared && !tool.completed) tool.state = 'unknown';
      return;
    }
    const run = this.runs.get(record.identity!.runId)!;
    if (event.type === 'model_response') {
      this.context = { protocol: this.context!.protocol, items: [...this.context!.items, ...event.response.outputItems], ...(event.response.continuation === undefined ? {} : { continuation: event.response.continuation }) };
      for (const call of event.response.toolCalls) run.tools.set(call.id, { call, state: 'requested' });
    } else if (event.type === 'tool_prepared') {
      const tool = run.tools.get(event.prepared.call.id)!;
      tool.prepared = event; tool.preparedSeq = record.seq; tool.state = 'prepared';
    } else if (event.type === 'tool_completed') {
      const tool = run.tools.get(event.call.id)!;
      tool.completed = event; tool.completedSeq = record.seq; tool.state = event.result.status === 'unknown' ? 'unknown' : 'completed';
      this.context = { ...this.context!, items: [...this.context!.items, ...event.resultItems] };
    } else if (event.type === 'run_finished') {
      run.status = event.result.status; run.result = event.result; run.finishedSeq = record.seq;
      if (run.status === 'recovery_required') for (const tool of run.tools.values()) if (tool.prepared && !tool.completed) tool.state = 'unknown';
    }
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
    if (event.type === 'tool_prepared' && (this.journalBytes + bytes + 2 * this.limits.maxRecordBytes > this.limits.maxJournalBytes || this.records.length + 3 > this.limits.maxRecords)) fail('limit_exceeded', 'Insufficient result and terminal record headroom before preparing a tool');
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

  beginRun(request: BeginRunRequest): Promise<BeginRunResult> {
    return this.exclusive(async () => {
      this.writable();
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

  ensureCapacity(identity: RunIdentity, bytes: number): Promise<void> {
    return this.exclusive(async () => {
      this.writable(); this.activeOwner(identity);
      if (!Number.isSafeInteger(bytes) || bytes < 0) fail('invalid_limits', 'Capacity request must be a nonnegative integer');
      // One writer, sequential core: no other run can consume this headroom.
      // Keep room for a bounded prepared/result record and terminal context, plus
      // the atomic checkpoint's old and new copies (separately size-limited).
      const reserved = bytes + 3 * this.limits.maxRecordBytes;
      if (this.journalBytes + reserved > this.limits.maxJournalBytes || this.records.length + 3 > this.limits.maxRecords) fail('limit_exceeded', 'Insufficient durable storage headroom before tool execution');
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

  /** Full local protocol context, including all provider output and result items. */
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
  get recoveryRequired(): boolean { return this.poisoned || [...this.runs.values()].some(run => run.status === 'recovery_required'); }
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
