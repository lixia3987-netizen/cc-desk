import { constants } from 'node:fs';
import { lstat, open, readdir, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type {
  ApprovalDecision, BeginRunRequest, BeginRunResult, ModelContext, RunIdentity, RunJournalEvent,
  JsonObject, JsonValue, RunResult, RunStore, ToolCall, Usage, ModelRequestDiagnostic,
} from '@cc-desk/agent-core';
import { contextHasUserImages, MAX_COMPLETION_CORRECTIONS, validateCompletionDecision, validateModelFailureDiagnostic, validateModelRequestDiagnostic, validateUsage, validateProviderUsage, sumUsage } from '@cc-desk/agent-core';
import { isNativeChangeSetPreview, isNativeChangeSetResult, type NativeChangeSetFileEvent, type NativeChangeSetPreview } from '@cc-desk/contracts/native-changes';
import { isNativeCommandLifecycleEvent, NATIVE_COMMAND_MAX_PER_RUN, type NativeCommandLifecycleEvent } from '@cc-desk/contracts/native-commands';
import { acquireWriter, assertUuid, readRegularFile, RunStoreError, safeDirectory, syncDirectory } from './store-files.js';
import { readStoreSnapshot } from './store-read.js';
import { contextSummaryItem, requireCompleteContext, contextPendingCalls, nativeCompletionFeedbackItems, nativeToolResultItems, runContinuityItem } from './context-maintenance.js';

export { RunStoreError } from './store-files.js';
export const RUN_STORE_SCHEMA_VERSION = 1;

/** 确保引入图像之前的请求标识与现有日志逐字节兼容。 */
export function nativeSubmissionInputDigest(input: string, imageAttachments?: JsonValue): string {
  const value = Array.isArray(imageAttachments) && imageAttachments.length ? canonical({ input, imageAttachments }) : input;
  return createHash('sha256').update(value).digest('hex');
}

export interface RunStoreLimits {
  maxJournalBytes: number;
  maxRecordBytes: number;
  maxCheckpointBytes: number;
  maxRecords: number;
}
export type RunStoreFaultPoint = 'before_append' | 'after_write' | 'after_sync' | 'before_checkpoint' | 'after_checkpoint_sync' | 'after_checkpoint_rename';
export interface NativeRunStoreOptions {
  /** 应用的私有数据目录，绝不使用项目目录。 */
  rootDirectory: string;
  /** 宿主生成的 UUID；绝不使用会话名称或外部对话标识。 */
  conversationId: string;
  limits?: Partial<RunStoreLimits>;
  /** 宿主解析的凭据值。写入内容命中凭据时失败，避免静默破坏上下文。 */
  forbiddenValues?: readonly string[];
  /** 确定性的故障注入，不会被持久化。 */
  fault?: (point: RunStoreFaultPoint, eventType: string) => void | Promise<void>;
}
export interface StoredToolState {
  call: ToolCall;
  state: 'requested' | 'prepared' | 'completed' | 'unknown';
  prepared?: Extract<RunJournalEvent, { type: 'tool_prepared' }>;
  completed?: Extract<RunJournalEvent, { type: 'tool_completed' }>;
  preparedSeq?: number;
  completedSeq?: number;
  /** 仅接受宿主认证的回执；绝不由模型执行进程提供。 */
  changeSetProgress?: Array<NativeChangeSetFileEvent & { seq: number }>;
  /** 启动命令只确认句柄已建立，不表示最终进程结果。 */
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
/** 仅供宿主使用的启动预留记录。环境变量值和进程句柄绝不进入此记录。 */
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
  /** 仅将较旧的前缀发送给摘要模型；保留的对话轮次不包含在内。 */
  context: ModelContext;
  /** 摘要不能移除的精确目标及完整后缀。 */
  retainedContext: ModelContext;
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
  /** 服务返回的实际摘要请求用量。 */
  usage?: Usage | null;
  /** 为单次自动摘要请求持久化预留的额度。 */
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
  /** 预留摘要请求之前观察到的对话头部。 */
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
interface ModelRequestState {
  attempt: number;
  outcome?: 'response' | 'failed';
  retryDelayMs?: number;
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
// JSON 可能将保留的一个 UTF-8 字节扩展为六个 ASCII 字节。封装预留覆盖
// 所有限制大小的标识及调用字段，以及较小的运行中回执。
const COMMAND_ENVELOPE_BYTES = 32 * 1024;
const MODEL_DIAGNOSTIC_BYTES = 32 * 1024;
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
  if (!validateUsage(usage)) fail('invalid_usage', 'Summary usage must contain only nonnegative integer token counts or unknown cache counts');
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
 * 宿主管理、单写入方、每次追加后执行 fsync 的对话账本。检查点是
 * 经校验的日志索引，绝不是模型上下文的另一数据源。
 * 自动恢复绝不重放已准备的工具，也不恢复被中断的运行。
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
  /** 重放时不重新构造：仅此写入方能确认自身资源已清理。 */
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
  private readonly modelRequests = new Map<string, ModelRequestState[]>();
  private readonly legacyModelResponses = new Map<string, number>();
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

  /** 读取不可变的提交字节，不取得写入方所有权，也不恢复运行。 */
  static async readSubmission(options: Pick<NativeRunStoreOptions, 'rootDirectory' | 'conversationId' | 'limits'>, runId: string): Promise<BeginRunRequest | undefined> {
    assertUuid(options.conversationId, 'conversationId');
    assertUuid(runId, 'runId');
    const directory = path.join(path.resolve(options.rootDirectory), options.conversationId);
    const snapshot = new NativeRunStore(options, directory, async () => {});
    return readStoreSnapshot(directory, snapshot.limits, (journal, checkpoint) => {
      snapshot.replaySnapshot(journal, checkpoint);
      const run = snapshot.runs.get(runId);
      if (!run) return undefined;
      const started = snapshot.records[run.startedSeq - 1];
      return started?.event.type === 'run_started' ? clone(started.event.request) : undefined;
    });
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
    // 检查点写入中断后可能留下一份限制大小的临时副本。持有写入方
    // 所有权时，仅移除我们创建的以 UUID 命名的私有普通文件。
    for (const name of await readdir(this.directory)) {
      if (!/^checkpoint-[0-9a-f-]{36}\.tmp$/.test(name)) continue;
      const temporary = path.join(this.directory, name);
      await readRegularFile(temporary, this.limits.maxCheckpointBytes);
      await unlink(temporary);
    }
    const journal = await readRegularFile(path.join(this.directory, 'journal.jsonl'), this.limits.maxJournalBytes);
    const rawCheckpoint = await readRegularFile(path.join(this.directory, 'checkpoint.json'), this.limits.maxCheckpointBytes);
    if (journal !== undefined) {
      const journalStat = await lstat(path.join(this.directory, 'journal.jsonl'));
      this.journalIdentity = { dev: journalStat.dev, ino: journalStat.ino };
    }
    if (!this.replaySnapshot(journal, rawCheckpoint)) {
      await this.commit(undefined, { type: 'conversation_created' });
      return;
    }
    // 即使被中断的运行只调用模型，也可能在旧主进程中持有
    // 外部资源。宿主必须确认清理完成后，才能开始新的尝试。
    for (const run of this.runs.values()) {
      if (run.status === 'active') await this.commit(undefined, { type: 'run_recovered', runId: run.identity.runId, reason: 'Previous host stopped before committing a terminal run; resources and prepared effects require verification' });
    }
    for (const [requestId, startups] of this.startups) {
      if ([...startups.values()].some(startup => startup.closedSeq === undefined)) this.recoveredStartupRequests.add(requestId);
    }
  }

  /** 共享的纯重放逻辑：写入方启动和只读查询都执行全部状态转换检查。 */
  private replaySnapshot(journal: string | undefined, rawCheckpoint: string | undefined): boolean {
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
      return false;
    }
    if (!journal.length || !journal.endsWith('\n')) fail('corrupt_store', 'Journal is empty or has an uncommitted/truncated tail');
    this.journalBytes = Buffer.byteLength(journal);
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
    return true;
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
            if (startup.inputDigest !== nativeSubmissionInputDigest(request.input, request.configuration.imageAttachments) || startup.optionsDigest !== digest(request.configuration.sessionOptions)) fail('payload_mismatch', 'Run input/options differ from the approved startup submission');
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
    if (event.type === 'model_request_diagnostic') {
      if (Object.keys(event).some(key => !['type', 'diagnostic'].includes(key)) || !validateModelRequestDiagnostic(event.diagnostic) || Buffer.byteLength(JSON.stringify(event)) > MODEL_DIAGNOSTIC_BYTES) fail('invalid_record', 'Invalid model request diagnostic');
      const diagnostic = event.diagnostic;
      validateIdentity(diagnostic.identity, this.conversationId);
      if (identity) {
        this.activeOwner(identity);
        const pending = this.modelRequests.get(identity.runId)?.at(-1);
        if (!equal(identity, diagnostic.identity) || !pending || pending.attempt !== diagnostic.attempt || pending.outcome) fail('invalid_identity', 'Diagnostic must match an unresolved model attempt');
      } else if (!diagnostic.purpose.startsWith('summary_')) fail('invalid_identity', 'Only host summary diagnostics can omit a run owner');
      const previous = this.records.filter(record => record.event.type === 'model_request_diagnostic' && record.event.diagnostic.requestKey === diagnostic.requestKey).at(-1);
      const prior = previous?.event.type === 'model_request_diagnostic' ? previous.event.diagnostic : undefined;
      if (!prior ? diagnostic.phase !== 'started' : prior.phase === 'finished' || diagnostic.phase === 'started' ||
        diagnostic.phase === 'request' && prior.phase !== 'started' || diagnostic.phase === 'dispatched' && (prior.phase !== 'request' || diagnostic.requestSent !== true) ||
        !equal(prior.identity, diagnostic.identity) ||
        prior.attempt !== diagnostic.attempt || prior.purpose !== diagnostic.purpose || prior.contextDigest !== diagnostic.contextDigest || prior.toolsetDigest !== diagnostic.toolsetDigest ||
        prior.parentRunId !== diagnostic.parentRunId || prior.childId !== diagnostic.childId) fail('invalid_record', 'Diagnostic phases must follow one stable request identity');
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
    if (event.type === 'model_request_started') {
      const attempts = this.modelRequests.get(identity.runId) ?? [];
      if (!Number.isSafeInteger(event.attempt) || event.attempt !== attempts.length + 1 || Object.keys(event).some(key => !['type', 'attempt'].includes(key))) fail('invalid_record', 'Model attempts must use consecutive run-local identities');
      const last = attempts.at(-1);
      if (last && !last.outcome) fail('pending_model_request', 'A model request already has an unresolved outcome');
      if (last?.outcome === 'failed' && last.retryDelayMs === undefined) fail('model_retry_unavailable', 'A stopped model failure does not authorize another request');
      if ([...run.tools.values()].some(tool => !tool.completed || tool.completed.result.status === 'unknown')) fail('pending_tools', 'Model requests require complete known tool outcomes');
      if (this.runCompactionAttempts.get(identity.runId)?.status === 'attempted') fail('pending_model_request', 'A context summary has an unresolved outcome');
      if (this.records.filter(record => record.identity?.runId === identity.runId && record.event.type === 'completion_rejected').length > MAX_COMPLETION_CORRECTIONS) fail('invalid_record', 'Completion correction limit exhausted');
      return;
    }
    if (event.type === 'model_request_failed') {
      const pending = this.modelRequests.get(identity.runId)?.at(-1);
      if (!pending || pending.outcome || pending.attempt !== event.attempt) fail('pending_model_request', 'Model failure does not match an unresolved request');
      const diagnostic = this.records.filter(record => record.identity?.runId === identity.runId && record.event.type === 'model_request_diagnostic' && record.event.diagnostic.attempt === event.attempt).at(-1);
      if (diagnostic?.event.type === 'model_request_diagnostic' && (diagnostic.event.diagnostic.phase !== 'finished' || diagnostic.event.diagnostic.outcome === 'completed' || diagnostic.event.diagnostic.usage !== null)) fail('invalid_record', 'Model failure contradicts its diagnostic receipt');
      if (!validateModelFailureDiagnostic(event.failure) || typeof event.partial !== 'boolean' || Object.keys(event).some(key => !['type', 'attempt', 'failure', 'partial', 'retryDelayMs'].includes(key))) fail('invalid_record', 'Invalid model failure diagnostic');
      if (event.retryDelayMs !== undefined) {
        const retries = this.records.filter(record => record.identity?.runId === identity.runId && record.event.type === 'model_request_failed' && record.event.retryDelayMs !== undefined).length;
        if (event.partial || !event.failure.retryable || retries >= 2 || event.retryDelayMs !== [500, 1500][retries]) fail('invalid_record', 'Invalid bounded model retry delay');
      }
      return;
    }
    if (event.type === 'model_response') {
      const attempts = this.modelRequests.get(identity.runId);
      if (attempts?.length && attempts.at(-1)!.outcome) fail('pending_model_request', 'A complete model response requires an unresolved request');
      if ([...run.tools.values()].some(tool => !tool.completed)) fail('pending_tools', 'Previous model tool calls have no durable result');
      const response = event.response;
      if (!object(response) || !Array.isArray(response.outputItems) || !Array.isArray(response.toolCalls) || !['completed', 'tool_calls', 'refused', 'incomplete'].includes(response.finishReason)) fail('invalid_record', 'Invalid model response');
      if (!validateUsage(response.usage) || response.providerUsage !== undefined && !validateProviderUsage(response.providerUsage)) fail('invalid_usage', 'Invalid normalized or raw provider usage');
      const diagnostic = this.records.filter(record => record.identity?.runId === identity.runId && record.event.type === 'model_request_diagnostic' && record.event.diagnostic.attempt === attempts?.at(-1)?.attempt).at(-1);
      if (diagnostic?.event.type === 'model_request_diagnostic' && (diagnostic.event.diagnostic.phase !== 'finished' || diagnostic.event.diagnostic.outcome !== 'completed' ||
        !equal(diagnostic.event.diagnostic.usage, response.usage) || !equal(diagnostic.event.diagnostic.providerUsage ?? null, response.providerUsage ?? null))) fail('invalid_record', 'Model response contradicts its diagnostic counters');
      const ids = new Set<string>();
      for (const call of response.toolCalls) {
        validateCall(call);
        if (ids.has(call.id) || run.tools.has(call.id)) fail('payload_mismatch', 'Tool call identity was reused');
        ids.add(call.id);
      }
      return;
    }
    if (event.type === 'completion_rejected') {
      const attempt = this.modelRequests.get(identity.runId)?.at(-1);
      const previous = this.records.filter(record => record.identity?.runId === identity.runId && ['model_response', 'completion_rejected'].includes(record.event.type)).at(-1)?.event;
      if (!Number.isSafeInteger(event.attempt) || !attempt || attempt.attempt !== event.attempt || attempt.outcome !== 'response' ||
        this.records.filter(record => record.identity?.runId === identity.runId && record.event.type === 'completion_rejected').length > MAX_COMPLETION_CORRECTIONS ||
        previous?.type !== 'model_response' || previous.response.finishReason !== 'completed' || previous.response.toolCalls.length ||
        Object.keys(event).some(key => !['type', 'attempt', 'feedback', 'feedbackItems'].includes(key)) ||
        !validateCompletionDecision(event.feedback) || event.feedback.kind !== 'continue' ||
        !equal(event.feedbackItems, nativeCompletionFeedbackItems(this.context!.protocol, event.feedback))) fail('invalid_record', 'Completion feedback must bind the current complete model response');
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
      if (!validateUsage(result.usage)) fail('invalid_usage', 'Invalid terminal usage');
      validateContext(result.context);
      if (!equal(result.context, this.context)) fail('context_mismatch', 'Terminal context differs from durable model/tool items');
      const completionBoundary = this.records.filter(record => record.identity?.runId === identity.runId && ['model_response', 'completion_rejected'].includes(record.event.type)).at(-1)?.event;
      if (result.status === 'completed' && completionBoundary?.type === 'completion_rejected') fail('invalid_record', 'Rejected completion needs a new complete model response');
      const attempts = this.modelRequests.get(identity.runId);
      const modelPending = !!attempts?.length && !attempts.at(-1)!.outcome;
      if (attempts?.length) {
        if (attempts.at(-1)!.outcome === 'failed' && result.status === 'completed') fail('invalid_record', 'A failed model outcome cannot become a completed run');
        const expectedRequests = attempts.length + (this.legacyModelResponses.get(identity.runId) ?? 0) + (this.runCompactionAttempts.has(identity.runId) ? 1 : 0);
        if (result.modelRequests !== expectedRequests) fail('invalid_record', 'Terminal model request count differs from durable attempts');
        if ((modelPending || attempts.some(attempt => attempt.outcome === 'failed')) && result.usage !== null) fail('invalid_usage', 'Unreported failed model requests cannot have complete run usage');
      }
      const instrumented = this.records.some(record => record.identity?.runId === identity.runId && record.event.type === 'model_request_diagnostic');
      if (instrumented) {
        if (!validateUsage(result.usage, true)) fail('invalid_usage', 'Terminal usage has inconsistent token totals');
        const responses = this.records.filter(record => record.identity?.runId === identity.runId && record.event.type === 'model_response')
          .map(record => record.event.type === 'model_response' ? record.event.response.usage : null);
        const maintenance = this.runCompactionAttempts.get(identity.runId);
        const unknown = modelPending || attempts?.some(attempt => attempt.outcome !== 'response');
        const expectedUsage = sumUsage([...responses, ...(maintenance ? [maintenance.usage ?? null] : []), ...(unknown ? [null] : [])]);
        if (!equal(result.usage, expectedUsage)) fail('invalid_usage', 'Terminal usage differs from durable response and summary receipts');
      }
      const unresolved = modelPending || [...run.tools.values()].some(tool => !tool.completed || tool.completed.result.status === 'unknown' || uncertainCommand(tool)) || this.runCompactionAttempts.get(run.identity.runId)?.status === 'attempted';
      if (unresolved && result.status !== 'recovery_required') fail('recovery_required', 'Unresolved model requests or tool effects require recovery');
      return;
    }
    fail('invalid_record', 'Unknown journal event type');
  }

  private apply(record: RunStoreRecord): void {
    const event = record.event;
    if (event.type === 'model_request_diagnostic') return;
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
      // 已提交的原始提交回执不可变，即使其恢复屏障
      // 随后由另一项独立宿主操作解除，也不例外。
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
    } else if (event.type === 'model_request_started') {
      const attempts = this.modelRequests.get(run.identity.runId) ?? [];
      attempts.push({ attempt: event.attempt }); this.modelRequests.set(run.identity.runId, attempts);
    } else if (event.type === 'model_request_failed') {
      Object.assign(this.modelRequests.get(run.identity.runId)!.at(-1)!, { outcome: 'failed', ...(event.retryDelayMs === undefined ? {} : { retryDelayMs: event.retryDelayMs }) });
    } else if (event.type === 'model_response') {
      const attempts = this.modelRequests.get(run.identity.runId);
      if (attempts?.length) attempts.at(-1)!.outcome = 'response';
      else this.legacyModelResponses.set(run.identity.runId, (this.legacyModelResponses.get(run.identity.runId) ?? 0) + 1);
      this.contextBatches.push({ runId: run.identity.runId, start: this.context!.items.length });
      this.context = { protocol: this.context!.protocol, items: [...this.context!.items, ...event.response.outputItems], ...(event.response.continuation === undefined ? {} : { continuation: event.response.continuation }) };
      for (const call of event.response.toolCalls) run.tools.set(call.id, { call, state: 'requested' });
    } else if (event.type === 'completion_rejected') {
      this.context = { ...this.context!, items: [...this.context!.items, ...event.feedbackItems] };
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

  /** 不相关的模型或工具追加记录时，剩余回执仍保留各自的预留额度。 */
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

  private runRequestHeadroom(identity: RunIdentity | undefined, event: StoreEvent): { bytes: number; records: number } {
    let records = 0;
    for (const run of this.runs.values()) {
      if (run.status !== 'active' || event.type === 'run_recovered' && event.runId === run.identity.runId || event.type === 'run_finished' && identity?.runId === run.identity.runId) continue;
      const changed = identity?.runId === run.identity.runId;
      const model = this.modelRequests.get(run.identity.runId)?.at(-1);
      const summary = this.runCompactionAttempts.get(run.identity.runId);
      const modelPending = changed && event.type === 'model_request_started' || !!model && !model.outcome && !(changed && ['model_response', 'model_request_failed'].includes(event.type));
      const summaryPending = changed && event.type === 'run_context_compaction_attempted' || summary?.status === 'attempted' && !(changed && ['run_context_compacted', 'run_context_compaction_failed'].includes(event.type));
      // 普通请求与摘要请求不能重叠。两者共享同一轮运行的
      // 终止预留额度；待完成请求还单独持有其结果的预留额度。
      if (modelPending || summaryPending) records += 2;
      else if (model || summary) records++;
    }
    // 发网之前预留其余诊断阶段；元数据按独立上限预留，不按整块模型响应预算膨胀。
    const diagnostics = new Map<string, ModelRequestDiagnostic>();
    for (const record of this.records) if (record.event.type === 'model_request_diagnostic') diagnostics.set(record.event.diagnostic.requestKey, record.event.diagnostic);
    if (event.type === 'model_request_diagnostic') diagnostics.set(event.diagnostic.requestKey, event.diagnostic);
    let diagnosticRecords = 0;
    for (const diagnostic of diagnostics.values()) {
      const ownerId = diagnostic.purpose === 'summary_in_run' ? diagnostic.parentRunId : diagnostic.purpose.startsWith('summary_') ? undefined : diagnostic.identity.runId;
      if (ownerId !== undefined) {
        const owner = this.runs.get(ownerId);
        if (owner?.status !== 'active' || event.type === 'run_finished' && identity?.runId === ownerId ||
          (event.type === 'run_recovered' || event.type === 'recovery_resolved') && event.runId === ownerId) continue;
      }
      // 未完成请求的诊断只允许继续向终态收敛；旧记录不引入新的正文或付费请求。
      diagnosticRecords += diagnostic.phase === 'started' ? 3 : diagnostic.phase === 'request' ? 2 : diagnostic.phase === 'dispatched' ? 1 : 0;
    }
    return { bytes: records * this.limits.maxRecordBytes + diagnosticRecords * MODEL_DIAGNOSTIC_BYTES, records: records + diagnosticRecords };
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
    const requestHeadroom = this.runRequestHeadroom(ownedIdentity, event);
    if (event.type === 'command_lifecycle' && event.progress.status === 'prepared' && commandTerminalBytes(event.progress.maxOutputBytes) > this.limits.maxRecordBytes) fail('limit_exceeded', 'Command terminal receipt exceeds the configured record budget');
    if (this.journalBytes + bytes + commandHeadroom.bytes > this.limits.maxJournalBytes || this.records.length + 1 + commandHeadroom.records > this.limits.maxRecords) fail('limit_exceeded', 'Outstanding command terminal receipts have reserved durable storage');
    if (this.journalBytes + bytes + commandHeadroom.bytes + requestHeadroom.bytes > this.limits.maxJournalBytes || this.records.length + 1 + commandHeadroom.records + requestHeadroom.records > this.limits.maxRecords) fail('limit_exceeded', 'Model outcome and terminal run have reserved durable storage');
    if (event.type === 'tool_prepared' && event.prepared.call.name === 'apply_change_set') {
      const preview = (event.prepared.preconditions as JsonObject).changeSet as unknown as NativeChangeSetPreview;
      // 现在就为每个文件的操作前后回执预留空间。后续文件不得占用
      // 确认自身副作用、工具结果及运行终止状态所需的空间。
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

  /** 启动任何本地服务进程之前，提交精确的宿主审批。绝不据此授权重放。 */
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

  /** 只有准备启动的写入方，才能确认其所有本地资源已关闭。 */
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
      if (!['model_request_diagnostic', 'model_request_started', 'model_request_failed', 'model_response', 'completion_rejected', 'tool_prepared', 'tool_completed', 'run_finished'].includes((event as { type: string }).type)) fail('invalid_record', 'Host records cannot be appended by the execution worker');
      const run = this.owner(identity);
      if (event.type === 'model_request_diagnostic') {
        const prior = this.records.find(record => record.event.type === 'model_request_diagnostic' && record.event.diagnostic.requestKey === event.diagnostic.requestKey && record.event.diagnostic.phase === event.diagnostic.phase);
        if (prior) {
          if (!equal(prior.event, event) || !equal(prior.identity, identity)) fail('payload_mismatch', 'Request diagnostic identity was reused with different counters');
          return { seq: prior.seq };
        }
      }
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

  /** 摘要 worker 的身份只在诊断中保存，回合内摘要用量仍由原始压缩回执计入一次。 */
  recordModelDiagnostic(diagnostic: ModelRequestDiagnostic): Promise<{ seq: number }> {
    return this.exclusive(async () => {
      this.writable();
      if (!validateModelRequestDiagnostic(diagnostic) || !diagnostic.purpose.startsWith('summary_')) fail('invalid_record', 'Invalid host summary diagnostic');
      const event: RunJournalEvent = { type: 'model_request_diagnostic', diagnostic };
      const prior = this.records.find(record => record.event.type === 'model_request_diagnostic' && record.event.diagnostic.requestKey === diagnostic.requestKey && record.event.diagnostic.phase === diagnostic.phase);
      if (prior) {
        if (!equal(prior.event, event) || prior.identity !== undefined) fail('payload_mismatch', 'Summary diagnostic identity was reused');
        return { seq: prior.seq };
      }
      return this.commit(undefined, event);
    });
  }

  private changeSetPreview(tool: StoredToolState | undefined): NativeChangeSetPreview {
    const prepared = tool?.prepared;
    if (!prepared || tool!.completed || prepared.prepared.call.name !== 'apply_change_set' || !prepared.prepared.requiresApproval || prepared.approval?.decision !== 'approved' || !object(prepared.prepared.preconditions) || !isNativeChangeSetPreview(prepared.prepared.preconditions.changeSet)) fail('not_prepared', 'File receipts require an unfinished durable approved change-set call');
    return prepared.prepared.preconditions.changeSet;
  }

  /** 仅供宿主使用的预写及副作用回执。执行进程 RPC 不暴露此方法。 */
  recordChangeSetEvent(identity: RunIdentity, call: ToolCall, progress: NativeChangeSetFileEvent): Promise<{ seq: number }> {
    return this.exclusive(async () => {
      this.writable();
      const run = this.activeOwner(identity), tool = run.tools.get(call.id);
      if (!tool || !equal(tool.call, call)) fail('payload_mismatch', 'File receipt does not belong to the committed tool call');
      this.changeSetPreview(tool);
      return this.commit(identity, { type: 'change_set_file', toolCallId: call.id, progress });
    });
  }

  /** 仅供宿主记录的生命周期事实；执行进程不能调用或伪造此 API。 */
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
      // 单写入方、串行核心：其他运行无法消耗这些预留空间。
      // 为限制大小的准备及结果记录、终止上下文，以及原子检查点的
      // 旧副本和新副本保留空间；两份副本各自限制大小。
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
    const attempts = this.modelRequests.get(runId) ?? [];
    const unreported = attempts.some(attempt => attempt.outcome !== 'response');
    const usages = [...responses.map(response => response.usage), ...(unreported ? [null] : []), ...(maintenance ? [maintenance.usage ?? null] : [])];
    let usage: RunResult['usage'] = null;
    if (run.result) usage = clone(run.result.usage);
    else usage = sumUsage(usages);
    return { completions, result: { identity: clone(run.identity), status: 'cancelled', reason: 'recovery_resolved',
      modelRequests: run.result?.modelRequests ?? attempts.length + (this.legacyModelResponses.get(runId) ?? 0) + (maintenance ? 1 : 0),
      toolCalls: run.result?.toolCalls ?? [...run.tools.values()].filter(tool => tool.prepared || tool.completed).length,
      usage, context, committed: true } };
  }

  /** 清理后的显式宿主操作，绝不自动执行工具或复用审批。 */
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

  /** 图像会固定其所属的完整原始轮次及其后所有项目。 */
  private firstImageTurnStart(): number | undefined {
    if (!this.context || !contextHasUserImages(this.context)) return undefined;
    const imageIndex = this.context.items.findIndex(item => contextHasUserImages({ protocol: this.context!.protocol, items: [item] }));
    const turn = this.contextTurns.filter(item => item.start <= imageIndex).at(-1);
    if (!turn || turn.start === 0) fail('image_context_compaction_unsupported', 'No complete text-only prefix precedes the first image turn');
    return turn.start;
  }

  private runCompactionBoundary(identity: RunIdentity): { boundary: number; goals: JsonValue[]; currentStart: number; imageSuffix?: true } {
    const run = this.activeOwner(identity);
    if (this.recoveryRequired) fail('recovery_required', 'Context maintenance cannot cross a recovery barrier');
    const model = this.modelRequests.get(identity.runId)?.at(-1);
    if (model && model.outcome !== 'response') fail('pending_model_request', 'Context maintenance requires a complete successful model outcome');
    if ([...run.tools.values()].some(tool => !tool.completed || tool.completed.result.status === 'unknown')) fail('pending_tools', 'In-turn compaction requires complete durable tool outcomes');
    if ([...run.tools.values()].some(tool => uncertainCommand(tool))) fail('commands_active', 'In-turn compaction waits for all command handles to finish');
    if (!this.context) fail('nothing_to_compact', 'No model context is available');
    requireCompleteContext(this.context);
    const imageStart = this.firstImageTurnStart();
    const batch = this.contextBatches.filter(item => item.runId === identity.runId).at(-1);
    if (!batch || !this.contextBatches.some(item => item.start < batch.start)) fail('nothing_to_compact', 'An older complete batch and a retained current batch are required');
    const start = this.records[run.startedSeq - 1].event;
    if (start.type !== 'run_started') fail('corrupt_store', 'Current run has no original input');
    const firstRun = this.runs.values().next().value!;
    const sameOriginal = firstRun.identity.runId === identity.runId;
    // 当前完整轮次已包含在此后缀中，因此不得将其输入复制到
    // 摘要之前，也不得丢失此前保留的轮次或批次。
    if (imageStart !== undefined) return { boundary: imageStart, goals: clone(this.originalUserItems!), currentStart: 0, imageSuffix: true };
    return { boundary: batch.start, goals: [...clone(this.originalUserItems!), ...(sameOriginal ? [] : clone(start.request.userItems))], currentStart: sameOriginal ? 0 : this.originalUserItems!.length };
  }

  /** 完整且已持久化的模型及工具执行边界。执行进程不能调用此宿主 API。 */
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

  /** 每轮运行在任何付费摘要请求之前只预留一次额度。确认丢失绝不授予重试权限。 */
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
    const { boundary, goals, currentStart, imageSuffix } = this.runCompactionBoundary(identity);
    const prefix = [...goals, contextSummaryItem(input.summary, this.context!.protocol), runContinuityItem(input.continuity, this.context!.protocol)];
    const context: ModelContext = { protocol: clone(this.context!.protocol), items: [...prefix, ...clone(this.context!.items.slice(boundary))] };
    requireCompleteContext(context);
    const afterBytes = Buffer.byteLength(JSON.stringify(context));
    if (afterBytes >= source.beforeBytes) fail('compaction_not_smaller', 'In-turn summary would not reduce the model context');
    if (Buffer.byteLength(canonical({ schemaVersion: 1, conversationId: this.conversationId, seq: this.records.length + 1, journalHash: ZERO_HASH, context, hash: ZERO_HASH })) > this.limits.maxCheckpointBytes) fail('limit_exceeded', 'Compacted context exceeds checkpoint limit');
    return { requestId: input.requestId, contextHash: input.contextHash, summary: input.summary, continuity: input.continuity, usage: clone(input.usage), beforeBytes: source.beforeBytes, afterBytes, context,
      retainedTurns: imageSuffix ? this.contextTurns.filter(turn => turn.start >= boundary).map(turn => ({ runId: turn.runId, start: turn.start - boundary + prefix.length }))
        : [{ runId: identity.runId, start: currentStart }],
      retainedBatches: imageSuffix ? this.contextBatches.filter(batch => batch.start >= boundary).map(batch => ({ runId: batch.runId, start: batch.start - boundary + prefix.length }))
        : [{ runId: identity.runId, start: prefix.length }] };
  }

  /** 在一次串行的追加及 fsync 操作中，构造并发布完整的替换内容。 */
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
    const imageStart = this.firstImageTurnStart();
    if (!this.context || this.contextTurns.length <= keepRecentTurns) fail('nothing_to_compact', 'At least one older and one retained complete turn are required');
    requireCompleteContext(this.context);
    return Math.min(this.contextTurns[this.contextTurns.length - keepRecentTurns].start, imageStart ?? Infinity);
  }

  getCompactionSource(options: { keepRecentTurns?: number } = {}): ContextCompactionSource {
    this.writable();
    const boundary = this.compactionBoundary(options.keepRecentTurns ?? 1);
    const latest = this.records.at(-1)!;
    const context = { protocol: clone(this.context!.protocol), items: clone(this.context!.items.slice(0, boundary)) };
    requireCompleteContext(context);
    return { expectedHash: latest.hash, sourceSeq: latest.seq, context, beforeBytes: Buffer.byteLength(JSON.stringify(this.context)), scope: 'prefix',
      retainedContext: { protocol: clone(this.context!.protocol), items: [...clone(this.originalUserItems!), ...clone(this.context!.items.slice(boundary))] } };
  }

  /** 联系模型之前先预留额度。追加状态不确定时，必须在重新打开后检查。 */
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
      validateSummaryUsage(options.usage);
    }
    const keepRecentTurns = options.keepRecentTurns ?? 1;
    const source = this.getCompactionSource({ keepRecentTurns });
    if (options.expectedHash !== undefined && source.expectedHash !== options.expectedHash) fail('stale_context', 'Conversation changed while producing the summary');
    if (options.automaticRequestId !== undefined) {
      text(options.automaticRequestId, 'automatic request id', 256);
      const attempt = this.autoCompactionAttempts.get(options.automaticRequestId);
      if (!attempt || attempt.status !== 'attempted') fail('auto_compaction_unavailable', 'Automatic compaction requires an unused durable reservation');
      const afterReservation = this.records.slice(attempt.seq, source.sourceSeq);
      const diagnosticOnly = afterReservation.every(record => record.identity === undefined && record.event.type === 'model_request_diagnostic' &&
        record.event.diagnostic.purpose === 'summary_before_send' && record.event.diagnostic.identity.requestId === `auto-compact:${attempt.requestId}`);
      if (options.expectedHash !== source.expectedHash || attempt.contextHash !== digest(this.context) || !diagnosticOnly) fail('stale_context', 'Automatic compaction reservation no longer owns the current conversation head');
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
      retainedTurns: (contextHasUserImages(this.context!) ? this.contextTurns.filter(turn => turn.start >= boundary) : this.contextTurns.slice(-keepRecentTurns))
        .map(turn => ({ runId: turn.runId, start: turn.start - boundary + prefix.length })) };
  }

  /** 以单个追加并 fsync 的事件发布新上下文；所有原始记录保持完整。 */
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

  /** 当前协议上下文；原始协议记录仍可通过重放获取。 */
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
  getRun(runId: string): StoredRun | undefined {
    const run = this.runs.get(runId);
    if (!run) return undefined;
    const { payloadDigest: _digest, finishedSeq: _seq, tools, ...publicRun } = run;
    return clone({ ...publicRun, tools: [...tools.values()] });
  }
  getToolState(runId: string, toolCallId: string): StoredToolState | undefined {
    const tool = this.runs.get(runId)?.tools.get(toolCallId);
    return tool ? clone(tool) : undefined;
  }
  /** 稳定的 seq 支持宿主及 UI 的幂等投影。 */
  replay(afterSeq = 0, limit = 1000): RunStoreRecord[] {
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) fail('invalid_limits', 'Invalid replay range');
    // 加载及追加均验证 seq 从 1 连续递增。按游标直接分页，避免恢复长历史时
    // 每取一页或查询末条记录都扫描整份账本；对外仍返回独立副本。
    return clone(this.records.slice(afterSeq, afterSeq + limit));
  }
  get recoveryRequired(): boolean { return this.poisoned || this.recoveredStartupRequests.size > 0 || [...this.runs.values()].some(run => run.status === 'recovery_required'); }
  get usage(): { journalBytes: number; records: number } { return { journalBytes: this.journalBytes, records: this.records.length }; }
  /** 元数据查询无需复制最后一条记录中可能包含的完整模型上下文。 */
  get head(): { seq: number; hash: string } | undefined {
    const record = this.records.at(-1);
    return record ? { seq: record.seq, hash: record.hash } : undefined;
  }
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
