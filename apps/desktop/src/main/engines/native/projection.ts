import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentEvent, JsonValue, RunResult } from '@cc-desk/agent-core';
import type { NativeRunStore, RunStoreRecord } from '@cc-desk/agent-node/run-store';
import type { ChatApproval, ChatMessage, ChatPageOptions, ChatSnapshot, TaskState } from '../../../shared/chat';
import type { ChatJournalEvent } from '../../../shared/execution-events';
import { getSessionIdentity } from '../../../shared/execution';
import type { Session } from '../../../shared/types';
import { ChatHistory } from '../../chat-history';
import { ChatArchive } from '../../chat-archive';
import type { ExecutionEvents } from '../../execution/events';

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
function outputText(item: JsonValue): string {
  if (!object(item)) return '';
  // Opaque continuation/reasoning is never projected or exported. Only the
  // protocol's explicit assistant text/refusal content is a display message.
  if (item.type === 'message' && item.role === 'assistant' && Array.isArray(item.content)) return item.content.flatMap(part => {
    if (!object(part)) return [];
    return part.type === 'output_text' && typeof part.text === 'string' ? [part.text] : part.type === 'refusal' && typeof part.refusal === 'string' ? [part.refusal] : [];
  }).join('\n');
  if ((item.type === undefined || item.type === 'message') && item.role === 'assistant' && typeof item.content === 'string') return item.content;
  if (item.type === 'output_text' && typeof item.text === 'string') return item.text;
  return '';
}
function displayInput(input: unknown): Record<string, unknown> {
  if (!object(input)) return {};
  const serialized = JSON.stringify(input);
  return serialized.length > MAX_INPUT ? { preview: serialized.slice(0, MAX_INPUT), truncated: true } : clone(input);
}
interface ProjectionEntry {
  history: ChatHistory;
  seq: number;
  hash: string;
  conversationId: string;
  modelCounts: Map<string, number>;
  currentIdentity?: AgentEvent['identity'];
  currentTerminal?: boolean;
  pending: ChatApproval[];
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
      entry = { history: this.history(), seq: 0, hash: '', conversationId: '', modelCounts: new Map(), pending: [] };
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
    const tools = new Map<string, ChatMessage>();
    const preparedTools = new Set<string>();
    const projected: Array<{ seq: number; event: ChatJournalEvent }> = [];
    let finalState: TaskState = 'idle';
    let currentIdentity: AgentEvent['identity'] | undefined;
    let currentTerminal = false;
    for (const record of records) {
      const event = record.event;
      if (record.identity && record.identity.sessionId !== id) throw new Error('Native 记录不属于当前会话。');
      const runId = record.identity?.runId ?? (event.type === 'run_recovered' ? event.runId : '');
      const createdAt = record.committedAt ?? session.createdAt;
      const add = (value: ChatJournalEvent) => { projected.push({ seq: record.seq, event: value }); if (value.type === 'state') finalState = value.taskState; };
      if (event.type === 'run_started') {
        currentIdentity = event.request.identity;
        currentTerminal = false;
        const model = event.request.configuration.model;
        add({ type: 'metadata', ...(typeof model === 'string' ? { model } : {}) });
        add({ type: 'message', message: { id: `${runId}:user`, turnId: runId, role: 'user', ...bounded(event.request.input), createdAt } });
        add({ type: 'state', taskState: 'thinking' });
      } else if (event.type === 'model_response') {
        modelCounts.set(runId, (modelCounts.get(runId) ?? 0) + 1);
        event.response.outputItems.forEach((item, index) => {
          const text = outputText(item);
          if (text) add({ type: 'message', message: { id: `${runId}:response:${record.seq}:${index}`, turnId: runId, role: 'assistant', ...bounded(text), createdAt } });
        });
        for (const call of event.response.toolCalls) {
          let input: unknown;
          try { input = JSON.parse(call.arguments); } catch { input = { invalidArguments: true }; }
          const message: ChatMessage = { id: `${runId}:tool:${call.id}`, turnId: runId, role: 'tool', text: '等待执行', toolName: call.name, toolUseId: call.id, input: displayInput(input), createdAt };
          tools.set(message.id, message); add({ type: 'message', message });
        }
        add({ type: 'state', taskState: 'thinking' });
      } else if (event.type === 'tool_prepared') {
        const call = event.prepared.call;
        const message: ChatMessage = { id: `${runId}:tool:${call.id}`, turnId: runId, role: 'tool', text: '执行中', toolName: call.name, toolUseId: call.id, input: displayInput(event.prepared.input), createdAt: tools.get(`${runId}:tool:${call.id}`)?.createdAt ?? createdAt };
        tools.set(message.id, message); preparedTools.add(message.id); add({ type: 'message', message }); add({ type: 'state', taskState: 'tool_running' });
      } else if (event.type === 'tool_completed') {
        const messageId = `${runId}:tool:${event.call.id}`;
        preparedTools.delete(messageId);
        const message: ChatMessage = { ...tools.get(messageId), id: messageId, turnId: runId, role: 'tool', ...bounded(event.result.output), toolName: event.call.name, toolUseId: event.call.id, createdAt: tools.get(messageId)?.createdAt ?? createdAt, isError: event.result.status !== 'completed', ...(event.result.truncated ? { truncated: true } : {}) };
        tools.set(message.id, message); add({ type: 'message', message }); add({ type: 'state', taskState: 'thinking' });
      } else if (event.type === 'run_finished') {
        currentTerminal = true;
        const result = event.result;
        add({ type: 'result', success: result.status === 'completed', summary: '', usage: result.usage ?? {}, ...(result.status === 'completed' ? {} : { error: result.reason }) });
        add({ type: 'state', taskState: taskState(result), ...(result.status === 'completed' ? {} : { error: result.reason }) });
        if (result.status === 'recovery_required') for (const messageId of preparedTools) {
          const message = tools.get(messageId);
          if (message?.turnId === runId) add({ type: 'message', message: { ...message, text: '执行结果未知，需要人工核查；不会自动重试。', isError: true } });
        }
      } else if (event.type === 'run_recovered') {
        currentTerminal = true;
        for (const message of tools.values()) {
          if (message.turnId === runId && message.text === '等待执行') add({ type: 'message', message: { ...message, text: '未执行：回合已中断。', isError: true } });
        }
        add({ type: 'state', taskState: 'error', error: event.reason });
        for (const messageId of preparedTools) {
          const message = tools.get(messageId);
          if (message?.turnId === runId) add({ type: 'message', message: { ...message, text: '执行结果未知，需要人工核查；不会自动重试。', isError: true } });
        }
      }
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
    const stream = old.stream && (modelCounts.get(old.stream.identity.runId) ?? 0) === old.stream.responseNumber && !['completed', 'interrupted', 'error'].includes(finalState) ? old.stream : undefined;
    const terminal = ['completed', 'interrupted', 'error'].includes(finalState);
    this.missingContext.delete(id);
    this.entries.set(id, { history, seq: latest.seq, hash: latest.hash, conversationId: store.conversationId, modelCounts, currentIdentity, currentTerminal, pending: terminal ? [] : old.pending, stream });
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

  snapshot(id: string): ChatSnapshot {
    const entry = this.entry(id);
    const snapshot = clone(entry.history.get(id));
    snapshot.pending = clone(entry.pending);
    if (entry.override) { snapshot.taskState = entry.override.taskState; snapshot.error = entry.override.error; }
    else if (entry.pending.length) snapshot.taskState = 'waiting_approval';
    if (entry.stream?.text) snapshot.messages.push({ id: `${entry.stream.identity.runId}:stream:${entry.stream.responseNumber}`, turnId: entry.stream.identity.runId, role: 'assistant', text: entry.stream.text, createdAt: entry.stream.createdAt });
    return snapshot;
  }
  page(id: string, options?: ChatPageOptions) { return this.archive.page(id, clone(this.entry(id).history.get(id)), options); }
  search(id: string, query: string, before?: string) { return this.archive.search(id, clone(this.entry(id).history.get(id)), query, before); }
  event(id: string, event: AgentEvent): void {
    const entry = this.entry(id);
    if (event.identity.sessionId !== id || entry.currentIdentity && (['sessionId', 'conversationId', 'runId', 'requestId', 'workerGeneration'] as const).some(key => event.identity[key] !== entry.currentIdentity![key])) return;
    if (event.type !== 'text_delta' || entry.currentTerminal) return;
    if (!entry.stream || entry.stream.identity.runId !== event.identity.runId) entry.stream = { identity: clone(event.identity), responseNumber: entry.modelCounts.get(event.identity.runId) ?? 0, text: '', createdAt: new Date().toISOString() };
    entry.stream.text = (entry.stream.text + event.text).slice(0, MAX_TEXT);
    this.changed(id);
  }
  approval(id: string, approval: ChatApproval | undefined): void {
    const entry = this.entry(id);
    entry.pending = approval ? [clone(approval)] : [];
    if (!approval && entry.override?.taskState === 'waiting_approval') entry.override = undefined;
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
