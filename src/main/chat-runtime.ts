import fs from 'node:fs';
import { ClaudeConnection } from './engines/claude/connection';
import { randomUUID } from 'node:crypto';
import { AssistantStream } from './engines/claude/assistant-stream';
import { ClaudeEvents } from './engines/claude/events';
import type { Entry } from './engines/claude/entry';
import type { ChatJournalEvent } from '../shared/execution-events';
import type { Capabilities, Effort, PermissionMode, Session } from '../shared/types';
import { automaticSessionTitlePatch } from '../shared/session-title';
import type { ChatAttention, ChatDecision, ChatMessage, ChatPageOptions, ChatSnapshot, ChatTurnResult, TaskState } from '../shared/chat';
import { cliInvocation, environment } from './commands';
import { transcriptExists } from './history';
import { TranscriptHydrator } from './engines/claude/transcript-hydrator';
import { StateStore } from './store';
import { ChatHistory } from './chat-history';
import { ChatArchive } from './chat-archive';
import { chatArguments, userContent } from './chat-protocol';
import { SubtaskTracker } from './subtask-tracker';
import { normalizeCommands, invokedCommand, type ContextUsage } from '../shared/claude-session';

/** Test injection is constructor-only; renderer callers cannot select commands or protocol frames. */
export interface ChatRuntimeOptions {
  invocation?: (session: Session, capabilities: Capabilities, resumed: boolean) => { file: string; args: string[] };
  transcriptExists?: (id: string) => Promise<boolean>;
  controlTimeoutMs?: number; initializationTimeoutMs?: number;
  backgroundResultTimeoutMs?: number;
  onEvent?: (id: string, event: ChatJournalEvent) => void;
}
const MAX_TEXT = 256 * 1024;
const now = () => new Date().toISOString();
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * One persistent CLI subprocess per structured session. Wire protocol follows
 * anthropics/claude-agent-sdk-python, _internal/query.py (initialize,
 * can_use_tool, control_cancel_request, interrupt, set_model, set_permission_mode).
 * No SDK credentials or permissive CLI switches are injected.
 */
export class ChatRuntime {
  private entries = new Map<string, Entry>();
  private releasing = new Map<string, Entry>();
  private starting = new Set<string>();
  private busy = new Set<string>();
  private cancelled = new Set<string>();
  private shuttingDown = false;
  private maintenance = false;
  private terminations = new Set<Promise<boolean>>();
  private terminationFailed = false;
  private history: ChatHistory;
  private archive: ChatArchive;
  private subtasks: SubtaskTracker;
  private notifications = new Map<string, NodeJS.Timeout>();
  private hydrator: TranscriptHydrator;
  private events: ClaudeEvents;
  constructor(private store: StateStore, private onState: () => void, private onEvents: (sessionId: string) => void, private options: ChatRuntimeOptions = {}) {
    this.subtasks = new SubtaskTracker(store, onState);
    this.history = new ChatHistory(store.directory, id => this.has(id), (id, error) => {
      const snapshot = this.history.get(id);
      snapshot.error = '聊天记录写入失败：' + error.message;
      const entry = this.entries.get(id);
      if (entry) {
        try { this.subtasks.end(id, 'failed', snapshot.error); } catch { /* Preserve the original disk failure. */ }
        entry.turn?.resolve({ success: false, summary: '', error: snapshot.error });
        entry.turn = undefined; this.terminate(entry);
      }
      snapshot.taskState = 'error'; snapshot.pending = [];
      try { this.update(id, { status: 'error', taskState: 'error', error: snapshot.error }); } catch { /* The disk may also reject workspace writes. */ }
      this.onEvents(id);
    });
    this.events = new ClaudeEvents({
      history: this.history, session: id => this.session(id), current: (id, entry) => this.entries.get(id) === entry,
      update: (id, patch) => this.update(id, patch), append: (id, event) => this.append(id, event),
      system: (id, text, error) => this.system(id, text, error), message: (id, message, delta) => this.message(id, message, delta),
      context: (id, context) => this.context(id, context), notify: (id, immediate) => this.notify(id, immediate),
      activity: (id, entry) => this.activity(id, entry), finish: (id, entry, result) => this.finish(id, entry, result),
      fail: (id, entry, error) => this.fail(id, entry, error),
    }, this.subtasks, options.backgroundResultTimeoutMs);
    this.archive = new ChatArchive(this.history.directory);
    this.hydrator = new TranscriptHydrator(store, this.history, id => this.entries.has(id), {
      message: (id, message) => this.message(id, message), system: (id, text) => this.system(id, text),
    });
  }
  get activeCount() { return new Set([...this.entries.keys(), ...this.releasing.keys(), ...this.starting]).size; }
  has(id: string) { return this.entries.has(id) || this.releasing.has(id) || this.starting.has(id); }
  isBusy(id: string) {
    const entry = this.entries.get(id) ?? this.releasing.get(id);
    return this.busy.has(id) || this.starting.has(id) || Boolean(entry &&
      (entry.turn || entry.tasks.size || entry.approvals.size || entry.connection.controls.size));
  }
  /** Release a reusable idle CLI before changing its working directory or reclaiming a slot. */
  async stopIdle(id: string) {
    if (this.isBusy(id)) throw new Error('请先停止正在执行的任务。');
    await this.stopAndWait(id);
  }
  private async stopAndWait(id: string) {
    const entry = this.entries.get(id) ?? this.releasing.get(id);
    if (entry) this.releasing.set(id, entry);
    this.stop(id);
    if (!entry) return;
    // A root process may exit before its MCP/tool descendants. Wait for the
    // process-group escalation as well, rather than treating root exit as a
    // guarantee that the working directory is no longer held on Windows.
    const deadline = Date.now() + 5000;
    while (this.entries.get(id) === entry && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    if (this.entries.get(id) === entry) throw new Error('CLI 尚未停止，工作目录未释放，请稍后重试。');
    if (entry.connection.termination) {
      entry.connection.killTimer?.ref();
      let timer: NodeJS.Timeout | undefined;
      const stopped = await Promise.race([entry.connection.termination, new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), Math.max(1, deadline - Date.now())); })]);
      if (timer) clearTimeout(timer);
      if (!stopped) throw new Error('无法确认 CLI 子进程已停止，工作目录操作已取消。请关闭残留的 Claude 进程并重新打开工作台后重试。');
    }
    this.releasing.delete(id);
  }
  taskState(id: string): TaskState { this.session(id); return this.history.get(id).taskState; }
  private session(id: string) {
    const session = this.store.state.sessions.find(item => item.id === id);
    if (!session) throw new Error('会话不存在。');
    if (session.kind !== 'agent' || session.execution.providerId !== 'claude' || session.execution.mode !== 'structured') throw new Error('此执行器只支持图形化 Claude 会话。');
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
  private append(id: string, event: ChatJournalEvent) {
    this.history.append(id, event);
    this.options.onEvent?.(id, structuredClone(event));
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
    this.append(id, { type: 'state', taskState, error });
    this.notify(id, true);
  }
  private activity(id: string, entry: Entry) {
    const approvals = [...entry.approvals.values()];
    this.history.get(id).pending = approvals;
    if (approvals.length) this.state(id, approvals.some(item => item.kind === 'question') ? 'waiting_input' : 'waiting_approval');
    else if (entry.turn) this.state(id, entry.tools.size ? 'tool_running' : 'thinking');
    this.events.refreshBackgroundTimeout(id, entry);
    this.notify(id, true);
  }
  private message(id: string, message: ChatMessage, delta?: string) {
    // Journal the complete event before bounding the UI projection. A delta without
    // a visible block needs its metadata as well, so recovery can recreate it.
    const existing = this.history.getMessage(id, message.id);
    this.append(id, delta === undefined || !existing ? { type: 'message', message } : { type: 'text_delta', id: message.id, text: delta });
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
    return structuredClone({ ...this.history.get(id), commands: this.entries.get(id)?.commands });
  }
  /** Initialize the CLI without sending a prompt or spending a model turn. */
  async prepareCommands(id: string, capabilities: Capabilities): Promise<ChatSnapshot> {
    if (this.shuttingDown) throw new Error('工作台正在退出。');
    if (this.maintenance) throw new Error('Claude Code 正在更新，暂时不能连接会话。');
    const session = this.session(id);
    if (session.kind !== 'agent' || session.execution.providerId !== 'claude' || session.execution.mode !== 'structured' || session.archived) throw new Error('此功能需要未归档的图形化 Claude 会话。');
    if (this.busy.has(id) || this.starting.has(id)) throw new Error('当前会话正在处理任务，请稍后重试。');
    if (this.entries.has(id)) return this.snapshot(id);
    this.busy.add(id);
    try {
      await this.hydrate(id);
      const state = this.history.get(id).taskState;
      await this.start(id, capabilities);
      this.state(id, state);
      return this.snapshot(id);
    } finally { this.busy.delete(id); }
  }
  private context(id: string, context: ContextUsage) {
    this.history.get(id).context = context;
    this.append(id, { type: 'context', context });
    this.notify(id);
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
      const session = this.store.state.sessions.find(session => session.id === sessionId);
      if(entry.connection.ending || session?.execution.providerId !== 'claude' || session.execution.mode !== 'structured')continue;
      for(const approval of this.history.get(sessionId).pending){
        if(entry.approvals.has(approval.requestId))requests.push({sessionId,requestId:approval.requestId,kind:approval.kind,toolName:approval.toolName,createdAt:approval.createdAt});
      }
    }
    return requests.sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
  }
  hydrate(id: string) { this.session(id); return this.hydrator.hydrate(id); }
  exportPath(id: string) { this.session(id); return this.history.exportPath(id); }
  delete(id: string) { this.forget(id); }
  forget(id: string) {
    if (this.has(id) || this.busy.has(id)) throw new Error('请先停止会话。');
    const timer = this.notifications.get(id); if (timer) clearTimeout(timer);
    this.notifications.delete(id); this.hydrator.forget(id); this.history.delete(id); this.archive.forget(id);
  }

  async send(id: string, text: string, capabilities: Capabilities, attachments: string[] = [], titlePrompt = text): Promise<ChatTurnResult> {
    if (this.shuttingDown) throw new Error('工作台正在退出。');
    if (this.maintenance) throw new Error('Claude Code 正在更新，暂时不能发送任务。');
    const session = this.session(id);
    if (session.kind !== 'agent' || session.execution.providerId !== 'claude' || session.execution.mode === 'terminal') throw new Error('该会话没有使用结构化适配器。');
    if (session.archived) throw new Error('请先取消会话归档。');
    if ((!text.trim() && !attachments.length) || text.length > 128 * 1024) throw new Error('消息为空或超过 128 KiB 上限。');
    const command = invokedCommand(text);
    if (command && attachments.length) throw new Error('执行斜杠命令时请先移除附件，再单独发送命令。');
    if (this.busy.has(id) || this.entries.get(id)?.approvals.size) throw new Error('当前会话仍在处理上一轮，请等待完成或先中断。');
    this.busy.add(id);
    this.cancelled.delete(id);
    try {
      await this.hydrate(id);
      const content = await userContent(text, attachments);
      if (this.cancelled.has(id)) throw new Error('消息发送已取消。');
      if (this.shuttingDown || this.maintenance) throw new Error('会话连接已暂停。');
      const previousState = this.history.get(id).taskState;
      const entry = this.entries.get(id) ?? await this.start(id, capabilities);
      if (entry.connection.ending || !entry.initialized) throw new Error('会话正在停止或尚未初始化。');
      const definition = entry.commands?.find(item => item.name === command || item.aliases.includes(command ?? ''));
      if (definition?.disabledReason) { this.state(id, previousState); throw new Error(definition.disabledReason); }
      const commandName = definition?.name ?? command;
      const result = new Promise<ChatTurnResult>(resolve => { entry.turn = { id: randomUUID(), resolve, interrupted: false, command: definition?.kind === 'skill' ? undefined : commandName,
        resetRequested: definition?.kind !== 'skill' && ['clear','reset','new'].includes(commandName ?? '') }; });
      entry.tools.clear(); entry.assistant.reset(); entry.resultIds.clear();
      entry.contextRequest = undefined;
      entry.subtaskTools.clear(); entry.approvalTasks.clear(); entry.finishedTasks.clear(); entry.backgroundTaskTools.clear();
      this.subtasks.begin(id, entry.turn!.id);
      const userId = randomUUID();
      this.message(id, { id: userId, sourceId: userId, turnId: entry.turn!.id, role: 'user', text: text + (attachments.length ? '\n\n附件：\n' + attachments.join('\n') : ''), createdAt: now() });
      this.state(id, 'thinking');
      try {
        // Built-in command parsing expects a prompt string; ordinary multimodal
        // messages continue to use content blocks.
        entry.connection.write({ type: 'user', uuid: userId, message: { role: 'user', content: command ? text.trimStart() : content }, parent_tool_use_id: null, session_id: this.session(id).execution.conversationId });
        const title = command ? undefined : automaticSessionTitlePatch(this.session(id), titlePrompt);
        if (title) this.update(id, title);
      } catch (error) { this.fail(id, entry, messageOf(error)); }
      return await result;
    } catch (error) {
      const entry = this.entries.get(id);
      if (entry?.turn) this.fail(id, entry, messageOf(error));
      throw error;
    } finally { this.busy.delete(id); this.cancelled.delete(id); }
  }

  private async start(id: string, capabilities: Capabilities): Promise<Entry> {
    if (this.shuttingDown || this.maintenance) throw new Error('会话连接已暂停。');
    if (this.has(id)) throw new Error('会话正在启动。');
    if (this.activeCount >= this.store.state.settings.maxSessions) throw new Error('已达到并发会话上限。');
    this.starting.add(id);
    let entry: Entry | undefined;
    try {
      const session = this.session(id);
      const conversationId = session.execution.conversationId;
      if (!conversationId) throw new Error('Claude 会话缺少原生会话标识。');
      if (!fs.statSync(session.cwd).isDirectory()) throw new Error('项目目录不存在。');
      const resumed = await (this.options.transcriptExists ?? transcriptExists)(conversationId);
      if (this.shuttingDown || this.maintenance || !this.starting.has(id)) throw new Error('会话启动已取消。');
      const env = environment();
      const invocation = this.options.invocation?.(session, capabilities, resumed) ?? (() => {
        const cli = cliInvocation(this.store.state.settings, env);
        return { file: cli.file, args: [...cli.prefix, ...chatArguments(session, capabilities, resumed)] };
      })();
      this.state(id, 'starting');
      entry = { connection: undefined as unknown as ClaudeConnection, initialized: false, expectedId: conversationId, enforceIdentity: resumed || session.started || session.execution.imported === true, bypassEnabled: session.permissionMode==='bypassPermissions', approvals: new Map(), assistant: undefined as unknown as AssistantStream, resultIds: new Set(), tools: new Set(), tasks: new Set(), subtaskTools: new Map(), approvalTasks: new Map(), finishedTasks: new Set(), backgroundTaskTools: new Map() };
      const current = entry;
      current.assistant = new AssistantStream({
        turnId: () => current.turn?.id, getMessage: key => this.history.getMessage(id, key),
        message: (message, delta) => this.message(id, message, delta), context: payload => this.events.observeContext(id, current, payload),
        model: model => { this.history.get(id).model = model; this.notify(id); },
      });
      current.connection = new ClaudeConnection(invocation, session.cwd, env, {
        frame: frame => this.events.receive(id, current, frame), error: error => this.fail(id, current, error),
        close: (code, signal) => {
          try { this.closed(id, current, code, signal); }
          catch (error) {
            this.entries.delete(id); this.starting.delete(id);
            const message = '记录进程退出状态失败：' + messageOf(error);
            current.turn?.resolve({ success: false, summary: '', error: message }); current.turn = undefined;
            const snapshot = this.history.get(id); snapshot.taskState = 'error'; snapshot.error = message; snapshot.pending = [];
            this.onEvents(id);
          }
        },
      }, this.options.controlTimeoutMs);
      this.entries.set(id, current);
      this.update(id, { status: 'running', ...(resumed ? { started: true } : {}), error: undefined, exitCode: undefined });
      const initialization = await current.connection.control({ subtype: 'initialize', hooks: null }, this.options.initializationTimeoutMs ?? 60_000);
      if (Array.isArray(initialization.commands)) current.commands = normalizeCommands(initialization.commands, [], initialization.skills);
      if (current.connection.ending || this.shuttingDown) throw new Error('会话初始化已取消。');
      current.initialized = true;
      return current;
    } catch (error) {
      if (entry?.connection) this.fail(id, entry, '结构化会话启动失败：' + messageOf(error));
      else { this.state(id, 'error', messageOf(error)); this.update(id, { status: 'error' }); }
      throw error;
    } finally { this.starting.delete(id); }
  }
  respond(id: string, requestId: string, decision: ChatDecision) {
    this.events.respond(id, this.entries.get(id), requestId, decision);
  }
  async interrupt(id: string) {
    const entry = this.entries.get(id);
    if (!entry?.turn || entry.connection.ending) { if (this.starting.has(id) || this.busy.has(id)) this.stop(id); return; }
    if (entry.turn.interrupted) return;
    entry.turn.interrupted = true;
    for (const requestId of entry.approvals.keys()) entry.connection.reply(requestId, { behavior: 'deny', message: '用户中断了当前任务。', interrupt: true });
    entry.approvals.clear(); this.history.get(id).pending = []; this.notify(id, true);
    this.system(id, '已请求中断，等待 CLI 确认结束当前任务。');
    entry.interruptTimer = setTimeout(() => { if (entry.turn?.interrupted) { this.system(id, 'CLI 未及时结束，正在停止进程。'); this.stop(id); } }, 5000);
    try { await entry.connection.control({ subtype: 'interrupt' }, 5000); }
    catch (error) { if (this.entries.get(id) === entry && entry.turn) { this.system(id, messageOf(error), true); this.stop(id); } }
  }
  /** Priority sends must outlive both interrupt acknowledgement and process cleanup. */
  async interruptAndWait(id: string) {
    const entry = this.entries.get(id) ?? this.releasing.get(id);
    if (entry) this.releasing.set(id, entry);
    await this.interrupt(id);
    const deadline = Date.now() + 10_000;
    while (this.isBusy(id) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    // Closing an interrupted connection also discards any delayed old-turn frames.
    await this.stopAndWait(id);
    while (this.busy.has(id) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    if (this.busy.has(id) || this.has(id)) throw new Error('上一轮尚未完全停止，排队消息没有发送。');
  }
  async updateConfig(id: string, patch: { model?: string; permissionMode?: PermissionMode; effort?: Effort }) {
    const session = this.session(id); let entry = this.entries.get(id);
    const invalidateModelContext = () => {
      if (patch.model === undefined || patch.model === session.model) return;
      if (entry) { entry.contextRequest = undefined; entry.requestModel = undefined; }
      this.context(id, { status: 'unknown' });
    };
    if (this.busy.has(id) || this.starting.has(id) || entry?.approvals.size) throw new Error('请等待当前任务完成后修改模型或权限。');
    if (patch.effort !== undefined && patch.effort !== session.effort && entry) throw new Error('修改推理强度前请先停止会话，然后重新发送以恢复。');
    if (entry?.connection.ending) throw new Error('请等待会话停止。');
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
          await entry.connection.control({ subtype: 'set_model', model: patch.model || null });
          // A confirmed model change stands even if a later permission control fails.
          // A rejected model control leaves the previous context untouched.
          invalidateModelContext();
          this.update(id, { model: patch.model }); this.history.get(id).model = patch.model || undefined;
        }
        if (patch.permissionMode !== undefined) {
          await entry.connection.control({ subtype: 'set_permission_mode', mode: patch.permissionMode });
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
        invalidateModelContext();
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
    const context = this.history.get(id).context;
    if (context?.status === 'compacting') this.context(id, { ...context, status: context.inputTokens === undefined ? 'unknown' : 'ready' });
    if (entry.interruptTimer) clearTimeout(entry.interruptTimer);
    if (entry.backgroundTimer) clearTimeout(entry.backgroundTimer);
    entry.interruptTimer = undefined;
    entry.backgroundTimer = undefined; entry.waitingBackgroundResult = false;
    const turn = entry.turn; entry.turn = undefined; entry.tools.clear(); entry.tasks.clear(); entry.approvals.clear(); entry.approvalTasks.clear();
    entry.assistant.reset(); entry.resultIds.clear();
    this.history.get(id).pending = [];
    try {
      this.subtasks.end(id, result.interrupted ? 'interrupted' : result.success ? 'unknown' : 'failed', result.error);
      this.state(id, result.interrupted ? 'interrupted' : result.success ? 'completed' : 'error', result.error);
      this.history.flush(); turn?.resolve(result);
    } catch (error) {
      turn?.resolve({ success: false, summary: result.summary, error: '聊天记录保存失败：' + messageOf(error) });
      throw error;
    }
  }
  private fail(id: string, entry: Entry, error: string) {
    if (entry.connection.ending) return;
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
    const entry = this.entries.get(id); if (!entry || entry.connection.ending) return;
    try {
      if (entry.turn) this.finish(id, entry, { success: false, summary: '', interrupted: true });
      else { this.subtasks.end(id, 'interrupted'); if (this.history.get(id).taskState === 'starting') this.state(id, 'interrupted'); }
      this.update(id, { status: 'stopping' });
    } finally { this.terminate(entry); }
  }
  private terminate(entry: Entry) {
    if (entry.connection.ending) return;
    if (entry.backgroundTimer) clearTimeout(entry.backgroundTimer);
    entry.approvals.clear();
    entry.connection.terminate();
    // Keep tracking descendants even after `closed` removes the root entry.
    const termination = entry.connection.termination!;
    this.terminations.add(termination);
    void termination.then(stopped => { if (!stopped) this.terminationFailed = true; this.terminations.delete(termination); });
  }
  private closed(id: string, entry: Entry, code: number | null, signal: NodeJS.Signals | null) {
    if (this.entries.get(id) !== entry) return;
    entry.connection.finish();
    this.entries.delete(id); this.starting.delete(id);
    const error = 'CLI 进程已退出（' + (code ?? signal ?? '未知') + '）。' + (entry.connection.stderr ? '\n' + entry.connection.stderr.trim() : '');
    entry.connection.closeControls(error);
    if (entry.interruptTimer) clearTimeout(entry.interruptTimer);
    if (entry.turn) this.finish(id, entry, { success: false, summary: '', error: entry.connection.ending ? undefined : error, interrupted: entry.connection.ending });
    else this.subtasks.end(id, entry.connection.ending ? 'interrupted' : 'failed', entry.connection.ending ? undefined : error);
    const previous = this.history.get(id).taskState;
    this.update(id, { status: previous === 'error' || !entry.connection.ending && code !== 0 ? 'error' : 'stopped', exitCode: code ?? undefined, error: previous === 'error' ? this.history.get(id).error : !entry.connection.ending && code !== 0 ? error : undefined });
    this.history.get(id).pending = []; this.notify(id, true);
  }
  async shutdown() {
    this.shuttingDown = true;
    for (const id of this.starting) this.starting.delete(id);
    const errors: unknown[] = [];
    for (const id of this.entries.keys()) { try { this.stop(id); } catch (error) { errors.push(error); } }
    const deadline = Date.now() + 2500;
    while (this.entries.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    for (const entry of this.entries.values()) { try { entry.connection.child.kill('SIGKILL'); } catch { /* Exited. */ } }
    // Root close does not release its detached process group. Keep the event loop
    // alive until the tracked escalation has confirmed every descendant stop.
    let terminationDeadline: NodeJS.Timeout | undefined;
    try {
      const stopped = await Promise.race([
        Promise.all([...this.terminations]).then(results => results.every(Boolean)),
        new Promise<boolean>(resolve => { terminationDeadline = setTimeout(() => resolve(false), 5000); }),
      ]);
      if (!stopped || this.terminationFailed || this.terminations.size || this.entries.size) {
        errors.push(new Error('无法确认全部聊天子进程已停止，请关闭残留进程后重试退出。'));
      }
    } finally { if (terminationDeadline) clearTimeout(terminationDeadline); }
    for (const timer of this.notifications.values()) clearTimeout(timer);
    this.notifications.clear();
    try { this.history.flush(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, '聊天会话退出未完成：' + errors.map(messageOf).join('；'));
  }
  setMaintenance(value: boolean) { this.maintenance = value; }
  async disconnectAll() {
    if (!this.maintenance) throw new Error('断开聊天前必须暂停新会话。');
    const ids = new Set([...this.entries.keys(), ...this.releasing.keys(), ...this.starting, ...this.busy]);
    const results = await Promise.allSettled([...ids].map(id => this.stopAndWait(id)));
    // Pending hydration / attachment reads must settle while starts remain blocked.
    const deadline = Date.now() + 10_000;
    while ((this.busy.size || this.terminations.size) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    if (results.some(result => result.status === 'rejected') || this.activeCount || this.busy.size || this.terminations.size || this.terminationFailed) throw new Error('无法确认全部聊天进程已停止，已取消更新。请等待或重启工作台后重试。');
    this.history.flush();
  }
}
