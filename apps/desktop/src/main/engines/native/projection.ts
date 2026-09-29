import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { contextBudgetUsage, DEFAULT_RUN_BUDGET, type AgentEvent, type JsonObject, type JsonValue, type RunResult, type ToolDefinition } from '@cc-desk/agent-core';
import { estimateNativeInputTokens, extractNativeAssistantText } from '@cc-desk/agent-node/native-model';
import { estimateNativeCost } from '../../../shared/native-cost';
import { isNativeImageAttachments } from '@cc-desk/contracts/chat';
import { isNativeChangeSetPreview, isNativeChangeSetResult, type NativeChangeSetPreview, type NativeChangeSetFileEvent, type NativeChangeSetResult } from '@cc-desk/contracts/native-changes';
import type { NativeRunStore, RunStoreRecord } from '@cc-desk/agent-node/run-store';
import type { ChatApproval, ChatMessage, ChatPageOptions, ChatSnapshot, NativeCommandSnapshot, TaskState } from '../../../shared/chat';
import type { ChatJournalEvent } from '../../../shared/execution-events';
import { getSessionIdentity } from '../../../shared/execution';
import type { Session } from '../../../shared/types';
import { ChatHistory } from '../../chat-history';
import { ChatArchive } from '../../chat-archive';
import type { ExecutionEvents } from '../../execution/events';
import { parseNativeConfig } from './config';
import { nativeRunError, nativeModelFailureMessage } from './run-errors';
import { projectNativeCommands, snapshotNativeCommands } from './command-projection';

export const MISSING_NATIVE_CONTEXT_MESSAGE = '原始模型记录缺失，此会话只读。已保留展示历史；展示内容不能代替完整模型上下文，请核查备份或新建会话。';

const MAX_TEXT = 256 * 1024;
const MAX_INPUT = 64 * 1024;
const MAX_PROJECTION = 256 * 1024 * 1024;
const clone = <T>(value: T): T => structuredClone(value);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeText = (value: unknown): string => typeof value === 'string' ? value : JSON.stringify(value) ?? '';
const bounded = (value: unknown, maximum = MAX_TEXT): { text: string; truncated?: boolean } => {
  const text = safeText(value);
  return text.length > maximum ? { text: text.slice(0, maximum), truncated: true } : { text };
};
const taskState = (result: Pick<RunResult, 'status'>): TaskState => result.status === 'completed' ? 'completed' : result.status === 'cancelled' ? 'interrupted' : 'error';
function outputText(item: JsonValue): string { return extractNativeAssistantText([item]); }
function displayInput(input: unknown): Record<string, unknown> {
  if (!object(input)) return {};
  const serialized = JSON.stringify(input);
  return serialized.length > MAX_INPUT ? { preview: serialized.slice(0, MAX_INPUT), truncated: true } : clone(input);
}
function changeSetProgress(preview: NativeChangeSetPreview, receipts: NativeChangeSetFileEvent[]): NativeChangeSetResult {
  const latest = new Map(receipts.map(receipt => [receipt.index, receipt]));
  return { digest: preview.digest, atomic: false, status: 'unknown', receiptCommitted: false,
    files: preview.files.map(file => {
      const receipt = latest.get(file.index);
      return { index: file.index, path: file.path, beforeHash: file.beforeHash, afterHash: file.afterHash,
        status: !receipt ? 'not_applied' : receipt.status === 'prepared' ? 'unknown' : receipt.status,
        ...(receipt?.errorCode ? { errorCode: receipt.errorCode } : {}) };
    }) };
}
interface ProjectionEntry {
  history: ChatHistory;
  seq: number;
  hash: string;
  conversationId: string;
  streamEpochs: Map<string, number>;
  currentIdentity?: AgentEvent['identity'];
  currentTerminal?: boolean;
  pending: ChatApproval[];
  commands?: NativeCommandSnapshot;
  stream?: { identity: AgentEvent['identity']; responseNumber: number; text: string; createdAt: string };
  override?: { taskState: TaskState; error?: string };
}

/** Rebuildable UI projection. The native ledger is the only model context source. */
export class NativeProjection {
  private entries = new Map<string, ProjectionEntry>();
  private serial = new Map<string, Promise<void>>();
  private missingContext = new Set<string>();
  private archive: ChatArchive;
  private directory: string;
  constructor(
    private dataDirectory: string,
    private events: ExecutionEvents,
    private getSession: (id: string) => Session,
    private isActive: (id: string) => boolean,
    private onError: (id: string, error: Error) => void,
    private isAutoCompacting: (id: string) => boolean = () => false,
  ) {
    this.directory = path.join(dataDirectory, 'chat');
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.archive = new ChatArchive(this.directory);
  }
  private validId(id: string): void { if (!/^[a-z0-9-]{1,100}$/i.test(id)) throw new Error('无效会话 ID。'); }
  private history(): ChatHistory { return new ChatHistory(this.dataDirectory, this.isActive, this.onError, true); }
  private entry(id: string): ProjectionEntry {
    this.validId(id);
    let entry = this.entries.get(id);
    if (!entry) {
      entry = { history: this.history(), seq: 0, hash: '', conversationId: '', streamEpochs: new Map(), pending: [] };
      this.entries.set(id, entry);
    }
    return entry;
  }
  private changed(id: string): void { this.events.emit({ type: 'conversation.changed', identity: getSessionIdentity(this.getSession(id)), taskState: this.snapshot(id).taskState }); }
  private journal(id: string, event: ChatJournalEvent): void { this.events.emit({ type: 'journal', identity: getSessionIdentity(this.getSession(id)), event }); }

  hydrate(id: string, store: NativeRunStore): Promise<void> {
    this.validId(id);
    const previous = this.serial.get(id) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(() => this.rebuild(id, store)).catch(error => {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.onError(id, failure); throw failure;
    });
    this.serial.set(id, pending);
    void pending.finally(() => { if (this.serial.get(id) === pending) this.serial.delete(id); }).catch(() => {});
    return pending;
  }
  private async rebuild(id: string, store: NativeRunStore): Promise<void> {
    const old = this.entry(id);
    for (const name of await fsp.readdir(this.directory)) {
      if (name.startsWith(`${id}.native-`) && /^[a-z0-9-]+\.native-[0-9a-f-]{36}\.tmp$/i.test(name)) await fsp.rm(path.join(this.directory, name), { force: true });
    }
    const count = store.usage.records;
    const latest = store.replay(Math.max(0, count - 1), 1)[0];
    // An empty ledger cannot erase a pre-existing display record. It may mean
    // the authoritative model ledger was lost, not that this is a new chat.
    if ((!latest || count === 1 && latest.event.type === 'conversation_created') && await this.preserveMissingContext(id, old)) return;
    if (!latest || old.conversationId === store.conversationId && old.seq === latest.seq && old.hash === latest.hash) return;
    const records: RunStoreRecord[] = [];
    for (let cursor = 0; cursor < latest.seq;) {
      const page = store.replay(cursor, 1000).filter(record => record.seq <= latest.seq);
      if (!page.length) throw new Error('Native 记录投影序列不完整。');
      records.push(...page); cursor = page.at(-1)!.seq;
    }
    if (!records.some(record => record.event.type === 'run_started') && await this.preserveMissingContext(id, old)) return;
    const session = this.getSession(id);
    const modelCounts = new Map<string, number>();
    const summaryCounts = new Map<string, number>();
    const streamEpochs = new Map<string, number>();
    const failures = new Map<string, Extract<RunStoreRecord['event'], { type: 'model_request_failed' }>>();
    const retryCounts = new Map<string, number>();
    const scheduledRetries = new Set<string>();
    const tools = new Map<string, ChatMessage>();
    const preparedTools = new Set<string>();
    const changeSets = new Map<string, { preview: NativeChangeSetPreview; receipts: NativeChangeSetFileEvent[] }>();
    const projected: Array<{ seq: number; event: ChatJournalEvent }> = [];
    let finalState: TaskState = 'idle';
    let currentIdentity: AgentEvent['identity'] | undefined;
    let currentTerminal = false;
    let configuration: JsonObject | undefined;
    let inputTokens: number | undefined;
    let measuredAt: string | undefined;
    for (const record of records) {
      const event = record.event;
      if (record.identity && record.identity.sessionId !== id) throw new Error('Native 记录不属于当前会话。');
      const runId = record.identity?.runId ?? (event.type === 'run_recovered' || event.type === 'recovery_resolved' ? event.runId : '');
      const createdAt = record.committedAt ?? session.createdAt;
      const add = (value: ChatJournalEvent) => { projected.push({ seq: record.seq, event: value }); if (value.type === 'state') finalState = value.taskState; };
      if (event.type === 'run_started') {
        currentIdentity = event.request.identity;
        currentTerminal = false;
        configuration = event.request.configuration;
        inputTokens = undefined;
        measuredAt = undefined;
        const model = event.request.configuration.model;
        add({ type: 'metadata', resetUsage: true, ...(typeof model === 'string' ? { model } : {}) });
        const images = configuration.imageAttachments;
        if (images !== undefined && !isNativeImageAttachments(images)) throw new Error('Native 图片记录元数据损坏，原始记录已保留。');
        add({ type: 'message', message: { id: `${runId}:user`, turnId: runId, role: 'user', ...bounded(event.request.input), createdAt,
          ...(images === undefined ? {} : { nativeImageAttachments: clone(images) }) } });
        add({ type: 'state', taskState: 'thinking' });
      } else if (event.type === 'model_request_started') {
        streamEpochs.set(runId, (streamEpochs.get(runId) ?? 0) + 1);
        if (scheduledRetries.delete(runId)) retryCounts.set(runId, (retryCounts.get(runId) ?? 0) + 1);
        add({ type: 'state', taskState: 'thinking' });
      } else if (event.type === 'model_request_failed') {
        streamEpochs.set(runId, (streamEpochs.get(runId) ?? 0) + 1);
        failures.set(runId, event);
        if (event.retryDelayMs !== undefined) scheduledRetries.add(runId);
        add({ type: 'message', message: { id: `model-failure:${record.seq}`, turnId: runId, role: 'system', text: nativeModelFailureMessage(event.failure, event.partial, event.retryDelayMs), isError: true, createdAt } });
        add({ type: 'state', taskState: 'thinking' });
      } else if (event.type === 'model_response') {
        streamEpochs.set(runId, (streamEpochs.get(runId) ?? 0) + 1);
        const reported = event.response.usage?.inputTokens;
        inputTokens = typeof reported === 'number' && Number.isSafeInteger(reported) && reported >= 0 ? reported : undefined;
        measuredAt = createdAt;
        modelCounts.set(runId, (modelCounts.get(runId) ?? 0) + 1);
        event.response.outputItems.forEach((item, index) => {
          const text = outputText(item);
          if (text) add({ type: 'message', message: { id: `${runId}:response:${record.seq}:${index}`, turnId: runId, role: 'assistant', ...bounded(text), createdAt } });
        });
        for (const call of event.response.toolCalls) {
          let input: unknown;
          try { input = JSON.parse(call.arguments); } catch { input = { invalidArguments: true }; }
          const message: ChatMessage = { id: `${runId}:tool:${call.id}`, turnId: runId, role: 'tool', text: '等待执行', toolName: call.name, toolUseId: call.id, input: displayInput(input), createdAt };
          if (call.name === 'apply_change_set') message.nativeChangeSetState = 'pending';
          tools.set(message.id, message); add({ type: 'message', message });
        }
        add({ type: 'state', taskState: 'thinking' });
      } else if (event.type === 'tool_prepared') {
        const call = event.prepared.call;
        const message: ChatMessage = { id: `${runId}:tool:${call.id}`, turnId: runId, role: 'tool', text: '执行中', toolName: call.name, toolUseId: call.id, input: displayInput(event.prepared.input), createdAt: tools.get(`${runId}:tool:${call.id}`)?.createdAt ?? createdAt };
        if (call.name === 'apply_change_set' && object(event.prepared.preconditions) && isNativeChangeSetPreview(event.prepared.preconditions.changeSet)) {
          const preview = event.prepared.preconditions.changeSet;
          changeSets.set(message.id, { preview, receipts: [] });
          message.nativeChangeSetResult = changeSetProgress(preview, []);
          message.nativeChangeSetState = 'running';
        }
        tools.set(message.id, message); preparedTools.add(message.id); add({ type: 'message', message }); add({ type: 'state', taskState: 'tool_running' });
      } else if (event.type === 'change_set_file') {
        const messageId = `${runId}:tool:${event.toolCallId}`;
        const message = tools.get(messageId), changeSet = changeSets.get(messageId);
        if (message && changeSet) {
          changeSet.receipts.push(event.progress);
          const updated = { ...message, nativeChangeSetResult: changeSetProgress(changeSet.preview, changeSet.receipts) };
          tools.set(messageId, updated); add({ type: 'message', message: updated });
        }
      } else if (event.type === 'tool_completed') {
        const messageId = `${runId}:tool:${event.call.id}`;
        preparedTools.delete(messageId);
        const message: ChatMessage = { ...tools.get(messageId), id: messageId, turnId: runId, role: 'tool', ...bounded(event.result.output), toolName: event.call.name, toolUseId: event.call.id, createdAt: tools.get(messageId)?.createdAt ?? createdAt, isError: event.result.status !== 'completed', ...(event.result.truncated ? { truncated: true } : {}) };
        if (event.call.name === 'apply_change_set') {
          message.nativeChangeSetState = !changeSets.has(messageId) && ['denied', 'not_executed', 'cancelled', 'failed'].includes(event.result.status) ? 'not_executed' : 'result';
          const progress = changeSets.get(messageId);
          if (isNativeChangeSetResult(event.result.output) && event.result.output.status !== 'unknown') message.nativeChangeSetResult = clone(event.result.output);
          else if (progress) message.nativeChangeSetResult = changeSetProgress(progress.preview, progress.receipts);
        }
        tools.set(message.id, message); add({ type: 'message', message }); add({ type: 'state', taskState: 'thinking' });
      } else if (event.type === 'run_finished') {
        currentTerminal = true;
        const result = event.result;
        // A failed request can consume service tokens without yielding a durable response.
        // Earlier reported usage is then partial and cannot price the complete run.
        const costUSD = !failures.has(runId) && result.modelRequests === (modelCounts.get(runId) ?? 0) + (summaryCounts.get(runId) ?? 0)
          ? estimateNativeCost(result.usage, configuration?.pricing, configuration?.model) : undefined;
        const failure = failures.get(runId);
        const error = nativeRunError(result.reason, { modelRequests: result.modelRequests, toolCalls: result.toolCalls, retries: retryCounts.get(runId) ?? 0, ...(failure ? { modelFailure: failure.failure.category, partial: failure.partial } : {}) });
        add({ type: 'result', success: result.status === 'completed', summary: '', usage: { ...result.usage, ...(costUSD === undefined ? {} : { costUSD }) }, ...(result.status === 'completed' ? {} : { error }) });
        add({ type: 'state', taskState: taskState(result), ...(result.status === 'completed' ? {} : { error }) });
        if (result.status === 'recovery_required') for (const messageId of preparedTools) {
          const message = tools.get(messageId);
          if (message?.turnId === runId) add({ type: 'message', message: { ...message, text: '执行结果未知，需要人工核查；不会自动重试。', isError: true, ...(message.toolName === 'apply_change_set' ? { nativeChangeSetState: 'result' as const } : {}) } });
        }
      } else if (event.type === 'recovery_resolved') {
        currentTerminal = true;
        inputTokens = undefined; measuredAt = undefined;
        for (const completion of event.completions) {
          const messageId = `${runId}:tool:${completion.call.id}`;
          const message = tools.get(messageId);
          if (message) add({ type: 'message', message: { ...message, text: '未执行：原回合已收束，不会重放旧工具或审批。', isError: true, ...(message.toolName === 'apply_change_set' ? { nativeChangeSetState: 'not_executed' as const } : {}) } });
        }
        add({ type: 'message', message: { id: `recovery:${record.seq}`, turnId: runId, role: 'system', text: '已恢复为可继续状态。请发送新指令继续；已完成的操作保留原结果，未执行的操作不会自动重放。', createdAt } });
        add({ type: 'state', taskState: 'interrupted' });
      } else if (event.type === 'run_context_compaction_attempted') {
        summaryCounts.set(runId, (summaryCounts.get(runId) ?? 0) + 1);
        add({ type: 'message', message: { id: `run-compaction-attempt:${record.seq}`, turnId: runId, role: 'system', text: '本回合尝试压缩完整的旧模型与工具记录。原始回执继续保留；摘要计入本轮请求和用量，不会重复尝试或重放工具。', createdAt } });
        add({ type: 'state', taskState: 'thinking' });
      } else if (event.type === 'run_context_compacted') {
        inputTokens = undefined; measuredAt = undefined;
        add({ type: 'message', message: { id: `run-compaction:${record.seq}`, turnId: runId, role: 'system', text: '回合内上下文已压缩并持久保存。用户请求、最新完整工具结果和任务证据引用已保留；当前回合继续执行。', createdAt } });
        add({ type: 'state', taskState: 'thinking' });
      } else if (event.type === 'run_context_compaction_failed') {
        add({ type: 'message', message: { id: `run-compaction-failure:${record.seq}`, turnId: runId, role: 'system', text: nativeRunError(event.failure.reason), isError: true, createdAt } });
        add({ type: 'state', taskState: 'thinking' });
      } else if (event.type === 'context_compaction_attempted') {
        const attempt = store.lookupAutoCompaction(event.requestId);
        if (attempt?.status === 'attempted') {
          currentTerminal = true;
          add({ type: 'message', message: { id: `auto-compaction:${record.seq}`, turnId: currentIdentity?.runId ?? '', role: 'system', text: '本次发送尝试自动压缩。原始记录保留；若未完成，请手动压缩或调整设置后继续。摘要可能产生费用，不会自动重复尝试。', createdAt } });
          add(this.isAutoCompacting(id) ? { type: 'state', taskState: 'thinking' }
            : { type: 'state', taskState: 'error', error: '自动压缩未完成，请手动处理后重新发送。' });
        }
      } else if (event.type === 'context_compacted') {
        currentTerminal = true;
        inputTokens = undefined; measuredAt = undefined;
        add({ type: 'metadata', resetUsage: true });
        add({ type: 'message', message: { id: `compaction:${record.seq}`, turnId: currentIdentity?.runId ?? '', role: 'system', text: (event.plan.automaticRequestId ? '发送前自动压缩已完成；' : '') + '上下文已压缩为历史摘要；原始对话记录、最初目标和最近完整回合已保留。摘要可能遗漏细节，后续重要约束可重新补充。', createdAt } });
        add({ type: 'state', taskState: 'interrupted' });
      } else if (event.type === 'run_recovered') {
        currentTerminal = true;
        for (const message of tools.values()) {
          if (message.turnId === runId && message.text === '等待执行') add({ type: 'message', message: { ...message, text: '未执行：回合已中断。', isError: true, ...(message.toolName === 'apply_change_set' ? { nativeChangeSetState: 'not_executed' as const } : {}) } });
        }
        add({ type: 'state', taskState: 'error', error: event.reason });
        for (const messageId of preparedTools) {
          const message = tools.get(messageId);
          if (message?.turnId === runId) add({ type: 'message', message: { ...message, text: '执行结果未知，需要人工核查；不会自动重试。', isError: true, ...(message.toolName === 'apply_change_set' ? { nativeChangeSetState: 'result' as const } : {}) } });
        }
      }
    }
    const modelContext = store.loadContext();
    if (configuration && modelContext) {
      const options = parseNativeConfig({ schemaVersion: 1, options: object(configuration.sessionOptions) ? configuration.sessionOptions : {} });
      const instructions = typeof configuration.modelInstructions === 'string' ? configuration.modelInstructions : '';
      const definitions = Array.isArray(configuration.toolDefinitions) ? configuration.toolDefinitions as unknown as ToolDefinition[] : [];
      const model = typeof configuration.model === 'string' ? configuration.model : undefined;
      let budget;
      try { budget = contextBudgetUsage(modelContext, estimateNativeInputTokens(modelContext, instructions, definitions), { maxInputTokens: options.maxInputTokens, maxContextBytes: DEFAULT_RUN_BUDGET.maxContextBytes }); }
      catch { /* Unknown protocol records remain readable, with no invented budget. */ }
      projected.push({ seq: latest.seq, event: { type: 'context', context: {
        ...(model ? { model, requestModel: model } : {}),
        ...(inputTokens !== undefined ? { inputTokens } : {}),
        ...(measuredAt ? { measuredAt } : {}), source: 'request', status: inputTokens === undefined ? 'unknown' : 'ready',
        ...(budget ? { budget } : {}),
      } } });
    }
    const temporary = path.join(this.directory, `${id}.native-${randomUUID()}.tmp`);
    const file = path.join(this.directory, `${id}.jsonl`);
    let bytes = 0;
    try {
      const handle = await fsp.open(temporary, 'wx', 0o600);
      try {
        for (const { seq, event } of projected) {
          const line = JSON.stringify({ nativeSchemaVersion: 1, nativeSeq: seq, ...event }) + '\n';
          bytes += Buffer.byteLength(line);
          if (bytes > MAX_PROJECTION) throw new Error('Native 展示记录超过磁盘预算。');
          await handle.writeFile(line);
        }
        await handle.sync();
      } finally { await handle.close(); }
      old.history.flush();
      // This projection never writes bounded snapshots. Removing a legacy cache
      // before publishing the atomic journal makes either crash outcome replayable.
      await fsp.rm(path.join(this.directory, `${id}.json`), { force: true });
      await fsp.rename(temporary, file);
      if (process.platform !== 'win32') {
        const directoryHandle = await fsp.open(this.directory, 'r');
        try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
      }
    } finally { await fsp.rm(temporary, { force: true }); }
    const history = this.history();
    const snapshot = history.get(id);
    // ChatHistory correctly treats restored live states as interrupted. This
    // host still owns a live run, so use the current committed state in memory.
    if (this.isActive(id)) snapshot.taskState = finalState;
    const stream = old.stream && (streamEpochs.get(old.stream.identity.runId) ?? 0) === old.stream.responseNumber && !['completed', 'interrupted', 'error'].includes(finalState) ? old.stream : undefined;
    const terminal = ['completed', 'interrupted', 'error'].includes(finalState);
    this.missingContext.delete(id);
    this.entries.set(id, { history, seq: latest.seq, hash: latest.hash, conversationId: store.conversationId, streamEpochs, currentIdentity, currentTerminal, pending: terminal ? [] : old.pending, stream, commands: projectNativeCommands(records) });
    this.archive.forget(id);
    if (old.seq && old.conversationId === store.conversationId) for (const item of projected) if (item.seq > old.seq) this.journal(id, item.event);
    this.changed(id);
  }

  private async preserveMissingContext(id: string, entry: ProjectionEntry): Promise<boolean> {
    const snapshot = entry.history.get(id);
    let hasLog = false;
    try { const stat = await fsp.lstat(path.join(this.directory, `${id}.jsonl`)); hasLog = stat.isFile() && stat.size > 0; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (!this.missingContext.has(id) && !snapshot.messages.length && !hasLog) return false;
    this.missingContext.add(id);
    snapshot.sourceIncomplete = true;
    entry.override = { taskState: 'error', error: MISSING_NATIVE_CONTEXT_MESSAGE };
    entry.currentTerminal = true;
    entry.pending = [];
    entry.stream = undefined;
    this.changed(id);
    return true;
  }

  hasMissingContext(id: string): boolean { return this.missingContext.has(id); }
  notifyTask(id: string): void { this.changed(id); }

  snapshot(id: string): ChatSnapshot {
    const entry = this.entry(id);
    const snapshot = clone(entry.history.get(id));
    if (entry.currentIdentity) snapshot.nativeRun = clone(entry.currentIdentity);
    // An active entry can remain solely to quarantine its directory after an
    // unconfirmed cleanup or journal failure. It is not evidence of live work.
    const terminalOverride = !!entry.override && ['completed', 'interrupted', 'error'].includes(entry.override.taskState);
    if (entry.commands?.items.length) snapshot.nativeCommands = snapshotNativeCommands(entry.commands,
      this.isActive(id) && !entry.currentTerminal && !terminalOverride ? entry.currentIdentity?.runId : undefined);
    snapshot.pending = clone(entry.pending);
    if (entry.override) { snapshot.taskState = entry.override.taskState; snapshot.error = entry.override.error; }
    else if (entry.pending.length) snapshot.taskState = entry.pending.some(item => item.kind === 'question') ? 'waiting_input' : 'waiting_approval';
    if (entry.stream?.text) snapshot.messages.push({ id: `${entry.stream.identity.runId}:stream:${entry.stream.responseNumber}`, turnId: entry.stream.identity.runId, role: 'assistant', text: entry.stream.text, createdAt: entry.stream.createdAt });
    return snapshot;
  }
  page(id: string, options?: ChatPageOptions) { return this.archive.page(id, clone(this.entry(id).history.get(id)), options); }
  search(id: string, query: string, before?: string) { return this.archive.search(id, clone(this.entry(id).history.get(id)), query, before); }
  event(id: string, event: AgentEvent): void {
    const entry = this.entry(id);
    if (event.identity.sessionId !== id || entry.currentIdentity && (['sessionId', 'conversationId', 'runId', 'requestId', 'workerGeneration'] as const).some(key => event.identity[key] !== entry.currentIdentity![key])) return;
    if (event.type !== 'text_delta' || entry.currentTerminal) return;
    if (!entry.stream || entry.stream.identity.runId !== event.identity.runId) entry.stream = { identity: clone(event.identity), responseNumber: entry.streamEpochs.get(event.identity.runId) ?? 0, text: '', createdAt: new Date().toISOString() };
    entry.stream.text = (entry.stream.text + event.text).slice(0, MAX_TEXT);
    this.changed(id);
  }
  approval(id: string, approval: ChatApproval | undefined): void {
    const entry = this.entry(id);
    entry.pending = approval ? [clone(approval)] : [];
    if (!approval && (entry.override?.taskState === 'waiting_approval' || entry.override?.taskState === 'waiting_input')) entry.override = undefined;
    if (approval) this.journal(id, { type: 'approval_requested', approval: clone(approval) });
    this.changed(id);
  }
  state(id: string, taskState: TaskState, error?: string): void {
    this.entry(id).override = { taskState, ...(error ? { error } : {}) };
    this.journal(id, { type: 'state', taskState, ...(error ? { error } : {}) }); this.changed(id);
  }
  flush(): void { for (const entry of this.entries.values()) entry.history.flush(); }
  forget(id: string): void { this.entries.get(id)?.history.flush(); this.entries.delete(id); this.archive.forget(id); }
  exportPath(id: string): string { this.validId(id); this.flush(); return path.join(this.directory, `${id}.jsonl`); }
}
