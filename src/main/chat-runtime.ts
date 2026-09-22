import fs from 'node:fs';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID, type Hash } from 'node:crypto';
import type { Capabilities, Effort, PermissionMode, Session } from '../shared/types';
import { isPermissionMode } from '../shared/permissions';
import type { ChatApproval, ChatAttention, ChatDecision, ChatMessage, ChatPageOptions, ChatQuestion, ChatSnapshot, ChatTurnResult, TaskState } from '../shared/chat';
import { cliInvocation, environment } from './commands';
import { findClaudeTranscript, transcriptExists } from './history';
import { StateStore } from './store';
import { ChatHistory } from './chat-history';
import { ChatArchive } from './chat-archive';
import { readTranscriptPreview } from './chat-import';
import { chatArguments, JsonLineDecoder, object, string, userContent, type WireObject } from './chat-protocol';

interface ControlWaiter { resolve: (value: WireObject) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
interface Turn { id: string; resolve: (value: ChatTurnResult) => void; interrupted: boolean }
interface TextBlock { id: string; index: number; length: number; digest: string; hash?: Hash; finalized?: boolean; envelopeId?: string }
interface AssistantGroup { id: string; sourceId: string; parent?: string; blocks: Map<number, TextBlock>; completed: boolean; stopped?: boolean }

interface Entry {
  child: ChildProcessWithoutNullStreams; ending: boolean; initialized: boolean;
  expectedId: string; enforceIdentity: boolean; bypassEnabled: boolean;
  turn?: Turn; controls: Map<string, ControlWaiter>; approvals: Map<string, ChatApproval>;
  streams: Map<string, string>; assistants: Map<string, AssistantGroup>; latestRoot?: AssistantGroup; resultIds: Set<string>; tools: Set<string>; tasks: Set<string>;
  stderr: string; decoder: JsonLineDecoder; killTimer?: NodeJS.Timeout; interruptTimer?: NodeJS.Timeout;
  waitingBackgroundResult?: boolean; backgroundTimer?: NodeJS.Timeout;
}
/** Test injection is constructor-only; renderer callers cannot select commands or protocol frames. */
export interface ChatRuntimeOptions {
  invocation?: (session: Session, capabilities: Capabilities, resumed: boolean) => { file: string; args: string[] };
  transcriptExists?: (id: string) => Promise<boolean>;
  controlTimeoutMs?: number; initializationTimeoutMs?: number;
  backgroundResultTimeoutMs?: number;
}
const MAX_TEXT = 256 * 1024;
const now = () => new Date().toISOString();
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

/**
 * One persistent CLI subprocess per structured session. Wire protocol follows
 * anthropics/claude-agent-sdk-python, _internal/query.py (initialize,
 * can_use_tool, control_cancel_request, interrupt, set_model, set_permission_mode).
 * No SDK credentials or permissive CLI switches are injected.
 */
export class ChatRuntime {
  private entries = new Map<string, Entry>();
  private starting = new Set<string>();
  private busy = new Set<string>();
  private cancelled = new Set<string>();
  private shuttingDown = false;
  private history: ChatHistory;
  private archive: ChatArchive;
  private notifications = new Map<string, NodeJS.Timeout>();
  private hydrating = new Map<string, Promise<void>>();
  private transcriptVersions = new Map<string, string>();
  constructor(private store: StateStore, private onState: () => void, private onEvents: (sessionId: string) => void, private options: ChatRuntimeOptions = {}) {
    this.history = new ChatHistory(store.directory, id => this.has(id), (id, error) => {
      const snapshot = this.history.get(id);
      snapshot.error = '聊天记录写入失败：' + error.message;
      const entry = this.entries.get(id);
      if (entry) {
        entry.turn?.resolve({ success: false, summary: '', error: snapshot.error });
        entry.turn = undefined; this.terminate(entry);
      }
      snapshot.taskState = 'error'; snapshot.pending = [];
      try { this.update(id, { status: 'error', taskState: 'error', error: snapshot.error }); } catch { /* The disk may also reject workspace writes. */ }
      this.onEvents(id);
    });
    this.archive = new ChatArchive(this.history.directory);
  }
  get activeCount() { return new Set([...this.entries.keys(), ...this.starting]).size; }
  has(id: string) { return this.entries.has(id) || this.starting.has(id); }
  isBusy(id: string) { return this.busy.has(id); }
  taskState(id: string): TaskState { this.session(id); return this.history.get(id).taskState; }
  private session(id: string) {
    const session = this.store.state.sessions.find(item => item.id === id);
    if (!session) throw new Error('会话不存在。');
    return session;
  }
  private update(id: string, patch: Partial<Session>) {
    const current = this.session(id);
    if (Object.entries(patch).every(([key, value]) => current[key as keyof Session] === value)) return;
    this.store.change(state => {
      const session = state.sessions.find(item => item.id === id);
      if (session) Object.assign(session, patch, { updatedAt: now() });
    });
    this.onState();
  }
  private notify(id: string, immediate = false) {
    this.history.changed(id);
    if (immediate) {
      const timer = this.notifications.get(id); if (timer) clearTimeout(timer);
      this.notifications.delete(id); this.onEvents(id); return;
    }
    if (!this.notifications.has(id)) this.notifications.set(id, setTimeout(() => {
      this.notifications.delete(id); this.onEvents(id);
    }, 40));
  }
  private state(id: string, taskState: TaskState, error?: string) {
    const snapshot = this.history.get(id);
    if (snapshot.taskState === taskState && snapshot.error === error) return;
    snapshot.taskState = taskState; snapshot.error = error;
    this.update(id, { taskState, error });
    this.history.append(id, { type: 'state', taskState, error });
    this.notify(id, true);
  }
  private activity(id: string, entry: Entry) {
    const approvals = [...entry.approvals.values()];
    this.history.get(id).pending = approvals;
    if (approvals.length) this.state(id, approvals.some(item => item.kind === 'question') ? 'waiting_input' : 'waiting_approval');
    else if (entry.turn) this.state(id, entry.tools.size ? 'tool_running' : 'thinking');
    this.refreshBackgroundTimeout(id, entry);
    this.notify(id, true);
  }
  private message(id: string, message: ChatMessage, delta?: string) {
    // Journal the complete event before bounding the UI projection. A delta without
    // a visible block needs its metadata as well, so recovery can recreate it.
    const existing = this.history.getMessage(id, message.id);
    this.history.append(id, delta === undefined || !existing ? { type: 'message', message } : { type: 'text_delta', id: message.id, text: delta });
    if (message.text.length > MAX_TEXT) message = { ...message, text: message.text.slice(-MAX_TEXT), truncated: true };
    if (message.input) {
      const serialized = JSON.stringify(message.input);
      if (serialized.length > MAX_TEXT) message = { ...message, input: { preview: serialized.slice(0, MAX_TEXT), truncated: true }, truncated: true };
    }
    this.history.upsertMessage(id, message);
    this.notify(id);
  }
  private system(id: string, text: string, isError = false) {
    this.message(id, { id: randomUUID(), turnId: this.entries.get(id)?.turn?.id ?? '', role: 'system', text, isError, createdAt: now() });
  }
  snapshot(id: string): ChatSnapshot {
    this.session(id);
    return structuredClone(this.history.get(id));
  }
  async page(id:string,options:ChatPageOptions={}) {
    this.session(id);await this.hydrate(id);
    return this.archive.page(id,this.snapshot(id),options);
  }
  async search(id:string,query:string,before?:string) {
    this.session(id);await this.hydrate(id);
    return this.archive.search(id,this.snapshot(id),query,before);
  }
  attention():ChatAttention[] {
    const requests:ChatAttention[]=[];
    for(const [sessionId,entry] of this.entries){
      if(entry.ending)continue;
      for(const approval of this.history.get(sessionId).pending){
        if(entry.approvals.has(approval.requestId))requests.push({sessionId,requestId:approval.requestId,kind:approval.kind,toolName:approval.toolName,createdAt:approval.createdAt});
      }
    }
    return requests.sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
  }
  async hydrate(id: string): Promise<void> {
    const session = this.session(id);
    if (this.entries.has(id) || !(session.imported || session.resumeFrom || session.started)) return;
    const pending = this.hydrating.get(id); if (pending) return pending;
    const original = this.history.get(id).messages;
    const last = original.at(-1); const length = original.length;
    const operation = (async () => {
      const sourceId = session.resumeFrom && !session.started ? session.resumeFrom : session.claudeId;
      const project = this.store.state.projects.find(item => item.id === session.projectId);
      const source = await findClaudeTranscript(session.cwd, sourceId) ?? (project && project.path !== session.cwd ? await findClaudeTranscript(project.path, sourceId) : undefined);
      if (!source) return;
      const before = await fs.promises.stat(source);
      const version = [source, before.dev, before.ino, before.size, before.mtimeMs].join(':');
      if (this.transcriptVersions.get(id) === version) return;
      const preview = await readTranscriptPreview(source);
      const after = await fs.promises.stat(source);
      // Only merge a stable transcript into an idle, unchanged projection.
      // The journal is authoritative while this runtime owns a live CLI process.
      if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) return;
      if (!this.store.state.sessions.some(item => item.id === id) || this.entries.has(id)) return;
      const snapshot = this.history.get(id);
      if (snapshot.messages !== original || snapshot.messages.length !== length || snapshot.messages.at(-1) !== last) return;
      this.transcriptVersions.set(id, version);
      let additions = preview.messages;
      if (length) {
        // Older snapshots lack source identities. Do not guess from repeated text
        // or replace valid local history with an unrelated/truncated source tail.
        const identity = (message: ChatMessage) => JSON.stringify([message.parentToolUseId ?? null, message.sourceId ?? message.id.replace(/^import:/, '')]);
        const known = new Set(original.map(identity));
        const tail = [...original].reverse().find(message => message.role !== 'system');
        if (!tail || tail.role === 'assistant' && tail.turnId !== 'imported' && !tail.sourceId) return;
        const tailIdentity = identity(tail);
        let anchor = -1;
        for (let index = preview.messages.length - 1; index >= 0; index--) {
          if (identity(preview.messages[index]) === tailIdentity) { anchor = index; break; }
        }
        if (anchor < 0) return;
        additions = preview.messages.slice(anchor + 1).filter(message => !known.has(identity(message)));
      }
      for (const message of additions) this.message(id, message);
      if (!length) {
        snapshot.truncated = preview.truncated;
        snapshot.sourceIncomplete = preview.truncated || undefined;
        if (preview.messages.length || preview.truncated) this.system(id, preview.truncated ? '已载入原始对话的最近部分；Claude 恢复时使用原始会话记录。' : '已载入 Claude 原始对话记录。');
      }
      if (additions.length || !length && preview.truncated) this.history.flush();
    })();
    this.hydrating.set(id, operation);
    try { await operation; } finally { this.hydrating.delete(id); }
  }
  exportPath(id: string) { this.session(id); return this.history.exportPath(id); }
  delete(id: string) { this.forget(id); }
  forget(id: string) {
    if (this.has(id) || this.busy.has(id)) throw new Error('请先停止会话。');
    const timer = this.notifications.get(id); if (timer) clearTimeout(timer);
    this.notifications.delete(id); this.transcriptVersions.delete(id); this.history.delete(id); this.archive.forget(id);
  }

  async send(id: string, text: string, capabilities: Capabilities, attachments: string[] = []): Promise<ChatTurnResult> {
    if (this.shuttingDown) throw new Error('工作台正在退出。');
    const session = this.session(id);
    if (session.kind !== 'claude' || session.adapter === 'terminal') throw new Error('该会话没有使用结构化适配器。');
    if (session.archived) throw new Error('请先取消会话归档。');
    if ((!text.trim() && !attachments.length) || text.length > 128 * 1024) throw new Error('消息为空或超过 128 KiB 上限。');
    if (this.busy.has(id) || this.entries.get(id)?.approvals.size) throw new Error('当前会话仍在处理上一轮，请等待完成或先中断。');
    this.busy.add(id);
    this.cancelled.delete(id);
    try {
      await this.hydrate(id);
      const content = await userContent(text, attachments);
      if (this.cancelled.has(id)) throw new Error('消息发送已取消。');
      if (this.shuttingDown) throw new Error('工作台正在退出。');
      const entry = this.entries.get(id) ?? await this.start(id, capabilities);
      if (entry.ending || !entry.initialized) throw new Error('会话正在停止或尚未初始化。');
      const result = new Promise<ChatTurnResult>(resolve => { entry.turn = { id: randomUUID(), resolve, interrupted: false }; });
      entry.tools.clear(); entry.streams.clear(); entry.assistants.clear(); entry.latestRoot = undefined; entry.resultIds.clear();
      const userId = randomUUID();
      this.message(id, { id: userId, sourceId: userId, turnId: entry.turn!.id, role: 'user', text: text + (attachments.length ? '\n\n附件：\n' + attachments.join('\n') : ''), createdAt: now() });
      this.state(id, 'thinking');
      try {
        this.write(entry, { type: 'user', uuid: userId, message: { role: 'user', content }, parent_tool_use_id: null, session_id: this.session(id).claudeId });
      } catch (error) { this.fail(id, entry, messageOf(error)); }
      return await result;
    } catch (error) {
      const entry = this.entries.get(id);
      if (entry?.turn) this.fail(id, entry, messageOf(error));
      throw error;
    } finally { this.busy.delete(id); this.cancelled.delete(id); }
  }

  private async start(id: string, capabilities: Capabilities): Promise<Entry> {
    if (this.has(id)) throw new Error('会话正在启动。');
    if (this.activeCount >= this.store.state.settings.maxSessions) throw new Error('已达到并发会话上限。');
    this.starting.add(id);
    let entry: Entry | undefined;
    try {
      const session = this.session(id);
      if (!fs.statSync(session.cwd).isDirectory()) throw new Error('项目目录不存在。');
      const resumed = await (this.options.transcriptExists ?? transcriptExists)(session.claudeId);
      if (this.shuttingDown || !this.starting.has(id)) throw new Error('会话启动已取消。');
      const env = environment();
      const invocation = this.options.invocation?.(session, capabilities, resumed) ?? (() => {
        const cli = cliInvocation(this.store.state.settings, env);
        return { file: cli.file, args: [...cli.prefix, ...chatArguments(session, capabilities, resumed)] };
      })();
      this.state(id, 'starting');
      const child = spawn(invocation.file, invocation.args, { cwd: session.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32', shell: false });
      entry = { child, ending: false, initialized: false, expectedId: session.claudeId, enforceIdentity: resumed || session.started || session.imported === true, bypassEnabled: session.permissionMode==='bypassPermissions', controls: new Map(), approvals: new Map(), streams: new Map(), assistants: new Map(), resultIds: new Set(), tools: new Set(), tasks: new Set(), stderr: '', decoder: undefined as unknown as JsonLineDecoder };
      const current = entry;
      current.decoder = new JsonLineDecoder(value => this.receive(id, current, value));
      this.entries.set(id, current);
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => { if (current.ending) return; try { current.decoder.push(chunk); } catch (error) { this.fail(id, current, messageOf(error)); } });
      child.stderr.on('data', (chunk: string) => { current.stderr = (current.stderr + chunk).slice(-8000); });
      child.on('error', error => this.fail(id, current, messageOf(error)));
      child.stdin.on('error', error => { if (!current.ending) this.fail(id, current, 'CLI 输入连接已关闭：' + error.message); });
      child.on('close', (code, signal) => {
        try { this.closed(id, current, code, signal); }
        catch (error) {
          this.entries.delete(id); this.starting.delete(id);
          const message = '记录进程退出状态失败：' + messageOf(error);
          current.turn?.resolve({ success: false, summary: '', error: message }); current.turn = undefined;
          const snapshot = this.history.get(id); snapshot.taskState = 'error'; snapshot.error = message; snapshot.pending = [];
          this.onEvents(id);
        }
      });
      this.update(id, { status: 'running', ...(resumed ? { started: true } : {}), error: undefined, exitCode: undefined });
      await this.control(current, { subtype: 'initialize', hooks: null }, this.options.initializationTimeoutMs ?? 60_000);
      if (current.ending || this.shuttingDown) throw new Error('会话初始化已取消。');
      current.initialized = true;
      return current;
    } catch (error) {
      if (entry) this.fail(id, entry, '结构化会话启动失败：' + messageOf(error));
      else { this.state(id, 'error', messageOf(error)); this.update(id, { status: 'error' }); }
      throw error;
    } finally { this.starting.delete(id); }
  }
  private write(entry: Entry, value: WireObject) {
    if (entry.ending || entry.child.stdin.destroyed || !entry.child.stdin.writable) throw new Error('CLI 输入连接已关闭。');
    // Only one user turn is outstanding; control traffic is bounded separately.
    if (entry.child.stdin.writableLength > 24 * 1024 * 1024) throw new Error('CLI 输入队列已满。');
    entry.child.stdin.write(JSON.stringify(value) + '\n');
  }
  private control(entry: Entry, request: WireObject, timeout = this.options.controlTimeoutMs ?? 15_000): Promise<WireObject> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { entry.controls.delete(requestId); const error = new Error('CLI 控制请求超时：' + string(request.subtype)); error.name = 'ChatControlTimeoutError'; reject(error); }, timeout);
      entry.controls.set(requestId, { resolve, reject, timer });
      try { this.write(entry, { type: 'control_request', request_id: requestId, request }); }
      catch (error) { clearTimeout(timer); entry.controls.delete(requestId); reject(error); }
    });
  }
  private reply(entry: Entry, requestId: string, response: WireObject, error?: string) {
    this.write(entry, { type: 'control_response', response: error ? { subtype: 'error', request_id: requestId, error } : { subtype: 'success', request_id: requestId, response } });
  }

  private receive(id: string, entry: Entry, frame: WireObject) {
    if (entry.ending || this.entries.get(id) !== entry) return;
    const type = string(frame.type);
    this.refreshBackgroundTimeout(id, entry);
    if (type === 'control_response') {
      const response = object(frame.response); const requestId = string(response.request_id);
      const pending = entry.controls.get(requestId); if (!pending) return;
      entry.controls.delete(requestId); clearTimeout(pending.timer);
      if (response.subtype === 'error') pending.reject(new Error(string(response.error) || 'CLI 拒绝了控制请求。'));
      else if (response.subtype === 'success') pending.resolve(object(response.response));
      else pending.reject(new Error('CLI 控制响应格式不兼容。'));
      return;
    }
    if (type === 'control_request') { this.permission(id, entry, frame); return; }
    if (type === 'control_cancel_request') {
      entry.approvals.delete(string(frame.request_id)); this.activity(id, entry); return;
    }
    const parent = string(frame.parent_tool_use_id) || undefined;
    if (!parent && (type === 'system' && frame.subtype === 'init' || type === 'result') && uuid(frame.session_id)) {
      if (entry.enforceIdentity && frame.session_id !== entry.expectedId) throw new Error('CLI 返回了不同的会话 ID，已停止以避免恢复到错误会话。原会话标识已保留。');
      if (this.session(id).claudeId !== frame.session_id) this.update(id, { claudeId: frame.session_id });
      entry.expectedId = frame.session_id; entry.enforceIdentity = true;
    }
    if (type === 'system') { if (!parent) this.systemEvent(id, entry, frame); return; }
    if (type === 'stream_event') { this.stream(id, entry, object(frame.event), parent); return; }
    if (type === 'assistant' || type === 'user') {
      const payload = object(frame.message);
      const blocks = Array.isArray(payload.content) ? payload.content : [];
      if (!entry.turn) return;
      const group = type === 'assistant' ? this.assistantGroup(entry, payload, frame, parent) : undefined;
      const used = new Set<number>();
      for (const [index, raw] of blocks.entries()) {
        const block = object(raw);
        if (block.type === 'text' && type === 'assistant') {
          this.completeText(id, entry, group!, index, string(block.text), used, blocks.length === 1, string(frame.uuid));
        } else if (block.type === 'tool_use') {
          const toolId = string(block.id); if (!toolId) continue;
          if (!this.session(id).started) this.update(id, { started: true });
          entry.tools.add(toolId);
          this.message(id, { id: 'tool:' + toolId, sourceId: 'tool:' + toolId, turnId: entry.turn?.id ?? '', role: 'tool', text: '', createdAt: now(), toolName: string(block.name), toolUseId: toolId, input: object(block.input), parentToolUseId: parent });
          this.activity(id, entry);
        } else if (block.type === 'tool_result') {
          const toolId = string(block.tool_use_id); entry.tools.delete(toolId);
          const existing = this.history.getMessage(id, 'tool:' + toolId);
          const text = typeof block.content === 'string' ? block.content : Array.isArray(block.content) ? block.content.map(value => {
            const item = object(value); return item.type === 'text' ? string(item.text) : '[' + string(item.type) + ']';
          }).join('\n') : '';
          this.message(id, { id: 'tool:' + toolId, sourceId: 'tool:' + toolId, turnId: entry.turn?.id ?? '', role: 'tool', createdAt: now(), ...existing, text, toolUseId: toolId, isError: block.is_error === true, parentToolUseId: parent });
          this.activity(id, entry);
        } else if (block.type === 'text' && parent) {
          this.message(id, { id: string(frame.uuid) || randomUUID(), turnId: entry.turn?.id ?? '', role: 'user', text: string(block.text), parentToolUseId: parent, createdAt: now() });
        }
      }
      if (group) {
        group.completed = true;
        if (!parent && group.blocks.size) entry.latestRoot = group;
        if (group.stopped) entry.streams.delete(JSON.stringify(parent ?? null));
        this.pruneAssistants(entry);
      }
      return;
    }
    if (type === 'result' && !parent) {
      if (!entry.turn) return;
      const resultId = string(frame.uuid);
      if (resultId && entry.resultIds.has(resultId)) return;
      if (resultId) entry.resultIds.add(resultId);
      const snapshot = this.history.get(id); const usage = object(frame.usage);
      snapshot.usage = { inputTokens: number(usage.input_tokens), outputTokens: number(usage.output_tokens), cacheReadTokens: number(usage.cache_read_input_tokens), cacheCreationTokens: number(usage.cache_creation_input_tokens), costUSD: number(frame.total_cost_usd), durationMs: number(frame.duration_ms), turns: number(frame.num_turns) };
      const failed = frame.is_error === true || (typeof frame.subtype === 'string' && frame.subtype !== 'success');
      if (!failed && !this.session(id).started) this.update(id, { started: true });
      const summary = string(frame.result);
      const error = failed ? (Array.isArray(frame.errors) ? frame.errors.map(String).join('\n') : summary || string(frame.subtype) || 'Claude 执行失败。') : undefined;
      this.history.append(id, { type: 'result', success: !failed, summary, error, usage: snapshot.usage });
      if (summary && !this.matchesSummary(entry.latestRoot, summary)) this.message(id, { id: randomUUID(), turnId: entry.turn?.id ?? '', role: 'assistant', text: summary, createdAt: now(), isError: failed });
      entry.latestRoot = undefined;
      if (entry.tasks.size && !failed && !entry.turn?.interrupted) {
        entry.waitingBackgroundResult = true;
        this.system(id, '本轮输出已结束，后台子任务仍在运行。'); this.activity(id, entry); return;
      }
      const interrupted = entry.turn?.interrupted === true;
      this.finish(id, entry, { success: !failed && !interrupted, summary, error, interrupted });
      return;
    }
    if (type === 'error') this.fail(id, entry, string(frame.error) || string(object(frame.error).message) || 'Claude 返回了错误。');
  }
  private groupId(entry: Entry, sourceId: string, parent?: string) { return JSON.stringify([entry.turn?.id, parent ?? null, sourceId]); }
  private group(entry: Entry, sourceId: string, parent?: string): AssistantGroup {
    const id = this.groupId(entry, sourceId, parent);
    let group = entry.assistants.get(id);
    if (!group) { group = { id, sourceId, parent, blocks: new Map(), completed: false }; entry.assistants.set(id, group); }
    return group;
  }
  private digest(text: string) { return createHash('sha256').update(text, 'utf16le').digest('hex'); }
  private compatible(block: TextBlock, text: string) {
    return text.length >= block.length && this.digest(text.slice(0, block.length)) === block.digest;
  }
  private assistantGroup(entry: Entry, payload: WireObject, frame: WireObject, parent?: string) {
    const sourceId = string(payload.id);
    const envelopeId = string(frame.uuid);
    const knownEnvelope = envelopeId ? entry.assistants.get(this.groupId(entry, envelopeId, parent)) : undefined;
    if (knownEnvelope) return knownEnvelope;
    if (sourceId) {
      const group = this.group(entry, sourceId, parent);
      if (envelopeId) entry.assistants.set(this.groupId(entry, envelopeId, parent), group);
      return group;
    }
    const streamed = entry.assistants.get(entry.streams.get(JSON.stringify(parent ?? null)) ?? '');
    const texts = (Array.isArray(payload.content) ? payload.content : []).map(object).filter(block => block.type === 'text');
    // An envelope without an API message id can only reconcile against the
    // pending stream in this exact parent/turn scope.
    if (streamed && !streamed.completed && texts.length && texts.every(block => [...streamed.blocks.values()].some(candidate => this.compatible(candidate, string(block.text))))) {
      if (envelopeId) entry.assistants.set(this.groupId(entry, envelopeId, parent), streamed);
      return streamed;
    }
    return this.group(entry, string(frame.uuid) || randomUUID(), parent);
  }
  private completeText(id: string, entry: Entry, group: AssistantGroup, index: number, text: string, used: Set<number>, singleBlock: boolean, envelopeId: string) {
    const indexed = group.blocks.get(index);
    // A completed envelope can contain one block at a time, with indexes relative
    // to that envelope. Match it to the stream's block before trusting the index.
    const digest = this.digest(text);
    const candidates = [...group.blocks.values()].filter(block => !used.has(block.index) && (!block.finalized || !envelopeId || block.envelopeId === envelopeId));
    const exact = (block: TextBlock) => block.length === text.length && block.digest === digest;
    const eligibleIndex = indexed && candidates.includes(indexed) ? indexed : undefined;
    const match = candidates.find(block => !block.finalized && exact(block)) ?? (eligibleIndex && exact(eligibleIndex) ? eligibleIndex : candidates.find(exact))
      ?? (eligibleIndex && this.compatible(eligibleIndex, text) ? eligibleIndex : candidates.find(block => this.compatible(block, text)));
    const blockIndex = match?.index ?? (indexed?.finalized && (singleBlock || envelopeId && indexed.envelopeId !== envelopeId) ? Math.max(...group.blocks.keys()) + 1 : index);
    used.add(blockIndex);
    const messageId = group.id + ':' + blockIndex;
    const existing = this.history.getMessage(id, messageId);
    if (existing && match?.finalized && match.length === text.length && match.digest === digest && (!envelopeId || existing.sourceId === envelopeId)) return;
    group.blocks.set(blockIndex, { id: messageId, index: blockIndex, length: text.length, digest, finalized: true, envelopeId: envelopeId || undefined });
    this.message(id, { id: messageId, sourceId: envelopeId || group.sourceId, turnId: entry.turn!.id, role: 'assistant', text, createdAt: existing?.createdAt ?? now(), parentToolUseId: group.parent });
  }
  private matchesSummary(group: AssistantGroup | undefined, summary: string) {
    if (!group) return false;
    const blocks = [...group.blocks.values()].sort((a, b) => a.index - b.index).filter(block => block.length);
    if (!blocks.length) return false;
    // Result text describes the latest root reply, not a new assistant message.
    // Compare full-content fingerprints, independent of the bounded UI text.
    const last = blocks[blocks.length - 1];
    if (last.length === summary.length && last.digest === this.digest(summary)) return true;
    return ['', '\n', '\n\n'].some(separator => {
      if (blocks.reduce((length, block) => length + block.length, separator.length * (blocks.length - 1)) !== summary.length) return false;
      let offset = 0;
      return blocks.every((block, index) => {
        if (index) { if (summary.slice(offset, offset + separator.length) !== separator) return false; offset += separator.length; }
        const part = summary.slice(offset, offset + block.length); offset += block.length;
        return block.digest === this.digest(part);
      });
    });
  }
  private stream(id: string, entry: Entry, event: WireObject, parent?: string) {
    if (!entry.turn) return;
    const key = JSON.stringify(parent ?? null);
    if (event.type === 'message_start') {
      const message = object(event.message); const group = this.group(entry, string(message.id) || randomUUID(), parent);
      entry.streams.set(key, group.id);
      if (!parent) { entry.latestRoot = group; if (typeof message.model === 'string') { this.history.get(id).model = message.model; this.notify(id); } }
      return;
    }
    const index = typeof event.index === 'number' ? event.index : 0;
    const group = entry.assistants.get(entry.streams.get(key) ?? ''); if (!group) return;
    if (event.type === 'message_stop') { group.stopped = true; for (const block of group.blocks.values()) block.hash = undefined; return; }
    if (event.type === 'content_block_stop') { const block = group.blocks.get(index); if (block) block.hash = undefined; return; }
    const content = object(event.content_block); const delta = object(event.delta);
    const messageId = group.id + ':' + index;
    if (event.type === 'content_block_start' && content.type === 'text') {
      const text = string(content.text); const hash = createHash('sha256').update(text, 'utf16le');
      group.completed = false;
      group.blocks.set(index, { id: messageId, index, length: text.length, digest: hash.copy().digest('hex'), hash });
      this.message(id, { id: messageId, sourceId: group.sourceId, turnId: entry.turn.id, role: 'assistant', text, createdAt: now(), parentToolUseId: parent });
    } else if (event.type === 'content_block_delta' && delta.type === 'text_delta') {
      const text = string(delta.text);
      const block = group.blocks.get(index) ?? { id: messageId, index, length: 0, digest: this.digest(''), hash: createHash('sha256') };
      if (!block.hash) return;
      block.hash.update(text, 'utf16le'); block.length += text.length; block.digest = block.hash.copy().digest('hex'); group.blocks.set(index, block);
      const existing = this.history.getMessage(id, messageId);
      this.message(id, { id: messageId, sourceId: group.sourceId, turnId: entry.turn.id, role: 'assistant', createdAt: now(), parentToolUseId: parent, ...existing, text: (existing?.text ?? '') + text }, text);
    }
    // Thinking content is not persisted; its events still reset the idle watchdog.
  }
  private pruneAssistants(entry: Entry) {
    // Retain a bounded identity window for replayed complete envelopes. Active
    // streams and the root reply needed for result reconciliation stay protected.
    if (entry.assistants.size <= 1024) return;
    const active = new Set(entry.streams.values());
    for (const [key, group] of entry.assistants) {
      if (entry.assistants.size <= 1024) break;
      if (group !== entry.latestRoot && !active.has(group.id)) entry.assistants.delete(key);
    }
  }
  private refreshBackgroundTimeout(id: string, entry: Entry) {
    if (entry.backgroundTimer) clearTimeout(entry.backgroundTimer);
    entry.backgroundTimer = undefined;
    if (!entry.waitingBackgroundResult || !entry.turn || entry.turn.interrupted || entry.tasks.size || entry.approvals.size || entry.ending) return;
    // This is an inactivity deadline. Progress restarts it and human approval
    // pauses it, so a long healthy continuation cannot be stopped by wall time.
    entry.backgroundTimer = setTimeout(() => {
      entry.backgroundTimer = undefined;
      if (entry.turn && entry.waitingBackgroundResult && !entry.tasks.size && !entry.approvals.size) this.fail(id, entry, '后台子任务已结束，但 CLI 未返回最终结果。会话已停止，可恢复后继续；工作流没有自动进入下一阶段。');
    }, this.options.backgroundResultTimeoutMs ?? 120_000);
  }
  private systemEvent(id: string, entry: Entry, frame: WireObject) {
    const subtype = string(frame.subtype); const snapshot = this.history.get(id);
    if (subtype === 'init') {
      snapshot.model = string(frame.model) || undefined;
      snapshot.permissionMode = string(frame.permissionMode) || this.session(id).permissionMode;
      snapshot.mcpServers = Array.isArray(frame.mcp_servers) ? frame.mcp_servers.map(value => { const item = object(value); return { name: string(item.name), status: string(item.status) }; }) : [];
      if (isPermissionMode(snapshot.permissionMode)) this.update(id, { permissionMode: snapshot.permissionMode, observedPermissionMode: snapshot.permissionMode });
      this.history.append(id, { type: 'metadata', model: snapshot.model, permissionMode: snapshot.permissionMode, mcpServers: snapshot.mcpServers });
      for (const field of ['plugin_errors', 'mcp_server_errors']) if (Array.isArray(frame[field]) && frame[field].length) this.system(id, field + ': ' + JSON.stringify(frame[field]), true);
      this.notify(id, true);
    } else if (subtype === 'task_started') {
      const taskId = string(frame.task_id); if (taskId) entry.tasks.add(taskId);
      this.system(id, '子任务开始：' + (string(frame.description) || taskId));
      this.refreshBackgroundTimeout(id, entry);
    } else if (subtype === 'task_notification') {
      entry.tasks.delete(string(frame.task_id));
      this.system(id, '子任务 ' + string(frame.status) + '：' + (string(frame.summary) || string(frame.task_id)), frame.status === 'failed');
      this.refreshBackgroundTimeout(id, entry);
    } else if (subtype === 'api_retry') this.system(id, '模型请求重试 ' + String(frame.attempt ?? '') + '/' + String(frame.max_retries ?? '') + '：' + string(frame.error), true);
    else if (subtype === 'permission_denied') this.system(id, 'CLI 权限规则拒绝了操作：' + JSON.stringify(frame), true);
    else if (subtype === 'status' && frame.status === 'compacting') this.system(id, '正在压缩上下文…');
  }

  private permission(id: string, entry: Entry, frame: WireObject) {
    const requestId = string(frame.request_id); const request = object(frame.request);
    if (!requestId) throw new Error('CLI 审批请求缺少 request_id。');
    if (request.subtype !== 'can_use_tool') {
      this.reply(entry, requestId, {}, 'Unsupported control request: ' + string(request.subtype));
      this.system(id, '当前客户端不支持 CLI 控制请求：' + string(request.subtype), true); return;
    }
    if (!entry.turn || entry.turn.interrupted || entry.approvals.size >= 32) {
      this.reply(entry, requestId, { behavior: 'deny', message: 'No active turn or permission queue full.' }); return;
    }
    if (entry.approvals.has(requestId)) return;
    const toolName = string(request.tool_name); const input = object(request.input);
    const questions: ChatQuestion[] | undefined = toolName === 'AskUserQuestion' && Array.isArray(input.questions) ? input.questions.map(value => {
      const question = object(value);
      return { question: string(question.question), header: string(question.header), multiSelect: question.multiSelect === true, options: Array.isArray(question.options) ? question.options.map(option => { const item = object(option); return { label: string(item.label), description: string(item.description) }; }) : [] };
    }) : undefined;
    const approval: ChatApproval = { requestId, toolName, input: structuredClone(input), kind: toolName === 'AskUserQuestion' ? 'question' : 'permission', questions, createdAt: now(), toolUseId: string(request.tool_use_id) || undefined };
    entry.approvals.set(requestId, approval);
    this.history.append(id, { type: 'approval_requested', approval });
    this.activity(id, entry);
  }
  respond(id: string, requestId: string, decision: ChatDecision) {
    const entry = this.entries.get(id); const approval = entry?.approvals.get(requestId);
    if (!entry || entry.ending || !approval) throw new Error('该审批已失效或已处理，请刷新会话。');
    if (decision.behavior !== 'allow' && decision.behavior !== 'deny') throw new Error('无效审批决定。');
    let updatedInput = approval.input;
    if (approval.kind === 'question' && decision.behavior === 'allow') {
      if (!approval.questions?.length) throw new Error('问题格式不受支持，请拒绝后让 Claude 重新提问。');
      const answers: Record<string, string> = Object.create(null) as Record<string, string>;
      for (const question of approval.questions) {
        const answer = decision.answers?.[question.question];
        if (typeof answer !== 'string' || !answer.trim() || answer.length > 16_000) throw new Error('请回答全部问题。');
        answers[question.question] = answer;
      }
      updatedInput = { ...approval.input, answers };
    }
    const response = decision.behavior === 'allow' ? { behavior: 'allow', updatedInput } : { behavior: 'deny', message: decision.message?.slice(0, 16_000) || '用户拒绝了这次操作。' };
    this.reply(entry, requestId, response);
    entry.approvals.delete(requestId);
    this.history.append(id, { type: 'approval_resolved', requestId, decision });
    this.activity(id, entry);
  }
  async interrupt(id: string) {
    const entry = this.entries.get(id);
    if (!entry?.turn || entry.ending) { if (this.starting.has(id) || this.busy.has(id)) this.stop(id); return; }
    if (entry.turn.interrupted) return;
    entry.turn.interrupted = true;
    for (const requestId of entry.approvals.keys()) this.reply(entry, requestId, { behavior: 'deny', message: '用户中断了当前任务。', interrupt: true });
    entry.approvals.clear(); this.history.get(id).pending = []; this.notify(id, true);
    this.system(id, '已请求中断，等待 CLI 确认结束当前任务。');
    entry.interruptTimer = setTimeout(() => { if (entry.turn?.interrupted) { this.system(id, 'CLI 未及时结束，正在停止进程。'); this.stop(id); } }, 5000);
    try { await this.control(entry, { subtype: 'interrupt' }, 5000); }
    catch (error) { if (this.entries.get(id) === entry && entry.turn) { this.system(id, messageOf(error), true); this.stop(id); } }
  }
  async updateConfig(id: string, patch: { model?: string; permissionMode?: PermissionMode; effort?: Effort }) {
    const session = this.session(id); let entry = this.entries.get(id);
    if (this.busy.has(id) || this.starting.has(id) || entry?.approvals.size) throw new Error('请等待当前任务完成后修改模型或权限。');
    if (patch.effort !== undefined && patch.effort !== session.effort && entry) throw new Error('修改推理强度前请先停止会话，然后重新发送以恢复。');
    if (entry?.ending) throw new Error('请等待会话停止。');
    this.busy.add(id);
    try {
      // Bypass must be enabled when the CLI starts. Restart an idle process when
      // entering or leaving it so other modes never inherit a bypass launch flag.
      if (entry && patch.permissionMode !== undefined && entry.bypassEnabled !== (patch.permissionMode === 'bypassPermissions')) {
        this.update(id, { status: 'stopping' });
        this.terminate(entry);
        const deadline = Date.now() + 5000;
        while (this.entries.get(id) === entry && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
        if (this.entries.get(id) === entry) throw new Error('CLI 尚未停止，权限配置未保存。请等待停止后重试。');
        entry = undefined;
      }
      if (entry) {
        if (patch.model !== undefined) {
          await this.control(entry, { subtype: 'set_model', model: patch.model || null });
          this.update(id, { model: patch.model }); this.history.get(id).model = patch.model || undefined;
        }
        if (patch.permissionMode !== undefined) {
          await this.control(entry, { subtype: 'set_permission_mode', mode: patch.permissionMode });
          this.update(id, { permissionMode: patch.permissionMode, observedPermissionMode: patch.permissionMode }); this.history.get(id).permissionMode = patch.permissionMode;
        }
      } else {
        this.update(id, {
          ...(patch.model !== undefined ? { model: patch.model } : {}),
          ...(patch.effort !== undefined ? { effort: patch.effort } : {}),
          ...(patch.permissionMode !== undefined ? { permissionMode: patch.permissionMode, observedPermissionMode: patch.permissionMode } : {}),
        });
        if (patch.permissionMode !== undefined) this.history.get(id).permissionMode = patch.permissionMode;
        if (patch.model !== undefined) this.history.get(id).model = patch.model || undefined;
      }
      this.notify(id, true);
    } catch (error) {
      if (entry && (error instanceof Error && error.name === 'ChatControlTimeoutError' || /控制响应格式不兼容/.test(messageOf(error)))) {
        this.fail(id, entry, '配置变更未获 CLI 确认，已停止会话以避免界面与实际权限不一致：' + messageOf(error));
      }
      throw error;
    } finally { this.busy.delete(id); }
  }
  private finish(id: string, entry: Entry, result: ChatTurnResult) {
    if (entry.interruptTimer) clearTimeout(entry.interruptTimer);
    if (entry.backgroundTimer) clearTimeout(entry.backgroundTimer);
    entry.interruptTimer = undefined;
    entry.backgroundTimer = undefined; entry.waitingBackgroundResult = false;
    const turn = entry.turn; entry.turn = undefined; entry.tools.clear(); entry.tasks.clear(); entry.approvals.clear();
    entry.streams.clear(); entry.assistants.clear(); entry.latestRoot = undefined; entry.resultIds.clear();
    this.history.get(id).pending = [];
    try {
      this.state(id, result.interrupted ? 'interrupted' : result.success ? 'completed' : 'error', result.error);
      this.history.flush(); turn?.resolve(result);
    } catch (error) {
      turn?.resolve({ success: false, summary: result.summary, error: '聊天记录保存失败：' + messageOf(error) });
      throw error;
    }
  }
  private fail(id: string, entry: Entry, error: string) {
    if (entry.ending) return;
    const turn = entry.turn;
    try {
      this.system(id, error, true);
      this.finish(id, entry, { success: false, summary: '', error });
      this.update(id, { status: 'error', error });
    } catch {
      // Disk failure must not strand a pending workflow or escape a stdout listener.
      entry.turn = undefined;
      const snapshot = this.history.get(id); snapshot.taskState = 'error'; snapshot.error = error; snapshot.pending = [];
      turn?.resolve({ success: false, summary: '', error }); this.onEvents(id);
    } finally { this.terminate(entry); }
  }
  stop(id: string) {
    if (this.busy.has(id)) this.cancelled.add(id);
    this.starting.delete(id);
    const entry = this.entries.get(id); if (!entry || entry.ending) return;
    try {
      if (entry.turn) this.finish(id, entry, { success: false, summary: '', interrupted: true });
      else if (this.history.get(id).taskState === 'starting') this.state(id, 'interrupted');
      this.update(id, { status: 'stopping' });
    } finally { this.terminate(entry); }
  }
  private terminate(entry: Entry) {
    entry.ending = true;
    if (entry.backgroundTimer) clearTimeout(entry.backgroundTimer);
    for (const waiter of entry.controls.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('会话进程已停止。')); }
    entry.controls.clear(); entry.approvals.clear();
    entry.child.stdin.destroy();
    const signal = (value: NodeJS.Signals) => {
      if (!entry.child.pid) return;
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/PID', String(entry.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => { try { entry.child.kill(value); } catch { /* Already exited. */ } });
      } else { try { process.kill(-entry.child.pid, value); } catch { try { entry.child.kill(value); } catch { /* Already exited. */ } } }
    };
    signal('SIGTERM');
    // Keep escalation even if the CLI root exits before an ignoring descendant.
    entry.killTimer = setTimeout(() => signal('SIGKILL'), 1500); entry.killTimer.unref();
  }
  private closed(id: string, entry: Entry, code: number | null, signal: NodeJS.Signals | null) {
    if (this.entries.get(id) !== entry) return;
    if (!entry.ending) { try { entry.decoder.finish(); } catch (error) { this.fail(id, entry, messageOf(error)); } }
    this.entries.delete(id); this.starting.delete(id);
    const error = 'CLI 进程已退出（' + (code ?? signal ?? '未知') + '）。' + (entry.stderr ? '\n' + entry.stderr.trim() : '');
    for (const waiter of entry.controls.values()) { clearTimeout(waiter.timer); waiter.reject(new Error(error)); }
    entry.controls.clear();
    if (entry.interruptTimer) clearTimeout(entry.interruptTimer);
    if (entry.turn) this.finish(id, entry, { success: false, summary: '', error: entry.ending ? undefined : error, interrupted: entry.ending });
    const previous = this.history.get(id).taskState;
    this.update(id, { status: previous === 'error' || !entry.ending && code !== 0 ? 'error' : 'stopped', exitCode: code ?? undefined, error: previous === 'error' ? this.history.get(id).error : !entry.ending && code !== 0 ? error : undefined });
    this.history.get(id).pending = []; this.notify(id, true);
  }
  async shutdown() {
    this.shuttingDown = true;
    for (const id of this.starting) this.starting.delete(id);
    const errors: unknown[] = [];
    for (const id of this.entries.keys()) { try { this.stop(id); } catch (error) { errors.push(error); } }
    const deadline = Date.now() + 2500;
    while (this.entries.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    for (const entry of this.entries.values()) { try { entry.child.kill('SIGKILL'); } catch { /* Exited. */ } }
    for (const timer of this.notifications.values()) clearTimeout(timer);
    this.notifications.clear();
    try { this.history.flush(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, '聊天会话退出时部分记录未能保存：' + errors.map(messageOf).join('；'));
  }
}
