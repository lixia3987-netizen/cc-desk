import fs from 'node:fs';
import { ClaudeConnection } from './connection.js';
import { randomUUID } from 'node:crypto';
import { AssistantStream } from './assistant-stream.js';
import { ClaudeEvents } from './events.js';
import type { Entry } from './entry.js';
import type { ChatJournalEvent } from '@cc-desk/contracts/execution-events';
import type { ClaudeCapabilities as Capabilities, Effort, PermissionMode, ClaudeSession as Session, ClaudeSessionPatch } from './types.js';
import type { ChatAttention, ChatDecision, ChatMessage, ChatPage, ChatPageOptions, ChatSnapshot, ChatTurnResult, TaskState } from '@cc-desk/contracts/chat';
import { transcriptExists } from './history.js';
import { TranscriptHydrator } from './transcript-hydrator.js';
import type { ClaudeHost, ClaudeHistory, ClaudeArchive, ClaudeSubtasks } from './host.js';
import { chatArguments, userContent } from './chat-protocol.js';
import { normalizeCommands, invokedCommand, type ContextUsage } from './claude-session.js';
import { isMissingTranscriptError } from './session-recovery.js';
/** 测试注入仅限构造函数；渲染进程调用方不能选择命令或协议帧。 */
export interface ClaudeRuntimeOptions {
  invocation?: (session: Session, capabilities: Capabilities, resumed: boolean) => { file: string; args: string[] };
  transcriptExists?: (id: string) => Promise<boolean>;
  controlTimeoutMs?: number; initializationTimeoutMs?: number;
  backgroundResultTimeoutMs?: number;
  onEvent?: (id: string, event: ChatJournalEvent) => void;
}
const MAX_TEXT = 256 * 1024;
const PROCESS_RELEASE_TIMEOUT_MS = process.platform === 'win32' ? 12000 : 5000;
const now = () => new Date().toISOString();
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * 每个结构化会话使用一个持久 CLI 子进程，通信协议遵循
 * anthropics/claude-agent-sdk-python 的 _internal/query.py（initialize，
 * 以及 can_use_tool、control_cancel_request、interrupt、set_model、set_permission_mode）。
 * 不注入 SDK 凭据或宽松的 CLI 开关。
 */
export class ClaudeRuntime {
  private entries = new Map<string, Entry>();
  private releasing = new Map<string, Entry>();
  private releaseCompletions = new Map<string, Promise<void>>();
  private releaseErrors = new Map<string, unknown>();
  private starting = new Set<string>();
  private busy = new Set<string>();
  private cancelled = new Set<string>();
  private shuttingDown = false;
  private maintenance = false;
  private terminations = new Set<Promise<boolean>>();
  private terminationFailed = false;
  private history: ClaudeHistory;
  private archive: ClaudeArchive;
  private subtasks: ClaudeSubtasks;
  private notifications = new Map<string, NodeJS.Timeout>();
  private hydrator: TranscriptHydrator;
  private events: ClaudeEvents;
  constructor(private host: ClaudeHost, private options: ClaudeRuntimeOptions = {}) {
    this.subtasks = host.subtasks(() => this.publishState());
    const conversations = host.conversations({ isActive: id => this.has(id), onError: (id, error) => {
      const snapshot = this.history.get(id);
      snapshot.error = '聊天记录写入失败：' + error.message;
      const entry = this.entries.get(id);
      if (entry) {
        try { this.subtasks.end(id, 'failed', snapshot.error); } catch { /* 保留原始磁盘失败信息。 */ }
        entry.turn?.resolve({ success: false, summary: '', error: snapshot.error });
        entry.turn = undefined; this.terminate(entry);
      }
      snapshot.taskState = 'error'; snapshot.pending = [];
      try { this.update(id, { status: 'error', taskState: 'error', error: snapshot.error }); } catch { /* 磁盘也可能拒绝工作区写入。 */ }
      this.publishConversation(id);
    } });
    this.history = conversations.history;
    this.archive = conversations.archive;
    this.events = new ClaudeEvents({
      history: this.history, session: id => this.session(id), current: (id, entry) => this.entries.get(id) === entry,
      update: (id, patch) => this.update(id, patch), append: (id, event) => this.append(id, event),
      system: (id, text, error) => this.system(id, text, error), message: (id, message, delta) => this.message(id, message, delta),
      context: (id, context) => this.context(id, context), notify: (id, immediate) => this.notify(id, immediate),
      activity: (id, entry) => this.activity(id, entry), finish: (id, entry, result) => this.finish(id, entry, result),
      fail: (id, entry, error) => this.fail(id, entry, error),
    }, this.subtasks, options.backgroundResultTimeoutMs);
    this.hydrator = new TranscriptHydrator(host.sessions, this.history, id => this.entries.has(id), {
      message: (id, message) => this.message(id, message), system: (id, text) => this.system(id, text),
    });
  }
  private publishState() { try { this.host.onState(); } catch { /* 观测方不负责持久化或执行。 */ } }
  private publishConversation(id: string) { try { this.host.onConversation(id); } catch { /* 观测方不能中断清理。 */ } }
  get activeCount() { return new Set([...this.entries.keys(), ...this.releasing.keys(), ...this.starting]).size; }
  has(id: string) { return this.entries.has(id) || this.releasing.has(id) || this.starting.has(id) || Boolean(this.host.metadata?.has(id)); }
  isBusy(id: string) {
    const entry = this.entries.get(id) ?? this.releasing.get(id);
    return this.busy.has(id) || this.starting.has(id) || Boolean(entry &&
      (entry.turn || entry.tasks.size || entry.approvals.size || entry.connection.controls.size));
  }
  /** 更改工作目录或回收槽位之前，先释放可复用的空闲 CLI。 */
  async stopIdle(id: string) {
    if (this.isBusy(id)) throw new Error('请先停止正在执行的任务。');
    await this.stopAndWait(id);
  }
  async stopAndWait(id: string) {
    const entry = this.entries.get(id) ?? this.releasing.get(id);
    if (entry) this.releasing.set(id, entry);
    this.stop(id);
    await this.host.metadata?.cancel(id);
    this.host.metadata?.assertReleased(id);
    if (!entry) { await this.whenReleased(id); return; }
    // 根进程可能先于其 MCP 或工具后代退出。也要等待
    // 进程组升级终止，不能仅凭根进程退出就断定
    // Windows 上的工作目录已不再被占用。
    const deadline = Date.now() + PROCESS_RELEASE_TIMEOUT_MS;
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
    await this.whenReleased(id);
  }
  /** 等待物理层面的 CLI、进程树、流及历史屏障，绝不等待外层队列 ACK。 */
  async whenReleased(id: string): Promise<void> {
    await this.host.metadata?.cancel(id);
    this.host.metadata?.assertReleased(id);
    let streamDeadline: number | undefined;
    while (this.entries.has(id) || this.starting.has(id) || this.busy.has(id)) {
      const connection = this.entries.get(id)?.connection;
      if (connection?.termination) {
        if (!await connection.termination) throw new Error('无法确认 CLI 子进程已停止，工作目录未释放。');
        streamDeadline ??= Date.now() + 5000;
        if (Date.now() >= streamDeadline) throw new Error('CLI 流或当前运行尚未释放，工作目录未释放。');
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    await this.releaseCompletions.get(id);
    const entry = this.releasing.get(id);
    if (entry?.connection.termination && !await entry.connection.termination) throw new Error('无法确认 CLI 子进程已停止，工作目录未释放。');
    this.history.flush();
    if (this.releaseErrors.has(id)) throw new Error('CLI 资源或聊天记录释放失败。', { cause: this.releaseErrors.get(id) });
    if (this.releasing.get(id) === entry) this.releasing.delete(id);
  }
  private trackRelease(id: string, entry: Entry, finalize?: () => void) {
    this.releasing.set(id, entry);
    if (this.releaseCompletions.has(id)) return;
    const termination = entry.connection.termination;
    if (termination) {
      this.terminations.add(termination);
      void termination.then(stopped => { if (!stopped) this.terminationFailed = true; this.terminations.delete(termination); });
    }
    const completion = (async () => {
      const stopped = await entry.connection.termination;
      if (stopped !== true) throw new Error('无法确认 CLI 后代进程已停止。');
      if (this.releasing.get(id) === entry) this.releasing.delete(id);
      finalize?.();
      this.history.flush();
    })().catch(error => { this.releaseErrors.set(id, error); this.terminationFailed = true; });
    this.releaseCompletions.set(id, completion);
  }
  taskState(id: string): TaskState { this.session(id); return this.history.get(id).taskState; }
  private session(id: string) {
    const session = this.host.sessions.get(id);
    if (!session) throw new Error('会话不存在。');
    if (session.kind !== 'agent' || session.execution.providerId !== 'claude' || session.execution.mode !== 'structured') throw new Error('此执行器只支持图形化 Claude 会话。');
    return session;
  }
  private update(id: string, patch: ClaudeSessionPatch) {
    const current = this.session(id);
    if (Object.entries(patch).every(([key, value]) => current[key as keyof Session] === value)) return;
    try { this.host.sessions.update(id, patch); }
    catch (cause) {
      const error = new Error('保存 Claude 会话状态失败：' + messageOf(cause), { cause });
      error.name = 'ClaudePersistenceError';
      throw error;
    }
    this.publishState();
  }
  private append(id: string, event: ChatJournalEvent) {
    this.history.append(id, event);
    try { this.options.onEvent?.(id, structuredClone(event)); } catch { /* 日志已提交，观测方不能将其置为无效。 */ }
  }
  private notify(id: string, immediate = false) {
    this.history.changed(id);
    if (immediate) {
      const timer = this.notifications.get(id); if (timer) clearTimeout(timer);
      this.notifications.delete(id); this.publishConversation(id); return;
    }
    if (!this.notifications.has(id)) this.notifications.set(id, setTimeout(() => {
      this.notifications.delete(id); this.publishConversation(id);
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
    // 限制界面投影之前，先将完整事件写入日志。没有可见内容块的增量
    // 也需要保留元数据，以便恢复时重建。
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
  /** 初始化 CLI，不发送提示词，也不消耗模型交互轮次。 */
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
  async readDisplay(id:string,options:ChatPageOptions={}):Promise<ChatPage> {
    this.session(id);
    if (this.archive.readDisplay) return this.archive.readDisplay(id,options);
    // 旧宿主没有独立显示端口时，不能为首屏调用可能重放日志的 history.get。
    return {messages:[],before:null,after:null,incomplete:true};
  }
  async search(id:string,query:string,before?:string) {
    this.session(id);await this.hydrate(id);
    return this.archive.search(id,this.snapshot(id),query,before);
  }
  attention():ChatAttention[] {
    const requests:ChatAttention[]=[];
    for(const [sessionId,entry] of this.entries){
      const session = this.host.sessions.get(sessionId);
      if(entry.connection.ending || session?.execution.providerId !== 'claude' || session.execution.mode !== 'structured')continue;
      for(const approval of this.history.get(sessionId).pending){
        if(entry.approvals.has(approval.requestId))requests.push({sessionId,requestId:approval.requestId,kind:approval.kind,toolName:approval.toolName,createdAt:approval.createdAt});
      }
    }
    return requests.sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
  }
  hydrate(id: string) { this.session(id); return this.hydrator.hydrate(id); }
  exportPath(id: string) { this.session(id); return this.history.exportPath(id); }
  /** 仅限用户确认的恢复；正常续接绝不回退为空白对话。 */
  async recoverContext(id: string): Promise<void> {
    const assertReady = () => {
      if (this.shuttingDown || this.maintenance) throw new Error('会话连接已暂停。');
      const session = this.session(id);
      if (session.archived) throw new Error('请先取消会话归档。');
      if (this.has(id)) throw new Error('请先停止会话，再重建上下文。');
      if (!session.started || !session.execution.conversationId ||
        ![session.error, this.history.get(id).error].some(isMissingTranscriptError)) throw new Error('只有缺失原始记录的会话可以重建空白上下文。');
      return session;
    };
    const previous = assertReady();
    if (this.busy.has(id)) throw new Error('当前会话正在处理任务，请稍后重试。');
    this.busy.add(id);
    try {
      const previousConversationId = previous.execution.conversationId!;
      if (await (this.options.transcriptExists ?? transcriptExists)(previousConversationId)) throw new Error('已找到原会话记录，请重新发送消息恢复原上下文。');
      const session = assertReady();
      if (session.execution.conversationId !== previousConversationId) throw new Error('会话标识已改变，请刷新后重试。');
      const conversationId = randomUUID();
      // 更改工作区元数据前，先持久化保留旧身份。
      // 如果保存元数据失败，其原始 ID 及续接保护仍保持完整。
      this.history.flush();
      this.append(id, { type: 'conversation_recovered', previousConversationId, conversationId });
      this.update(id, { execution: { ...session.execution, conversationId, forkFrom: undefined, imported: undefined },
        started: false, status: 'stopped', taskState: 'idle', error: undefined, exitCode: undefined });
      const snapshot = this.history.get(id);
      snapshot.context = undefined; snapshot.usage = undefined;
      this.hydrator.forget(id);
      this.state(id, 'idle');
      this.system(id, '已重建空白上下文。本地聊天记录、草稿和工作目录已保留；之前的聊天不会自动发送给 Claude。原 CLI 会话：' + previousConversationId + '；新 CLI 会话：' + conversationId);
      this.history.flush();
      this.notify(id, true);
    } finally { this.busy.delete(id); }
  }
  delete(id: string) { this.forget(id); }
  forget(id: string) {
    if (this.has(id) || this.busy.has(id)) throw new Error('请先停止会话。');
    void this.host.metadata?.cancel(id);
    const timer = this.notifications.get(id); if (timer) clearTimeout(timer);
    this.notifications.delete(id); this.hydrator.forget(id); this.history.delete(id); this.archive.forget(id);
  }

  async send(id: string, text: string, capabilities: Capabilities, attachments: string[] = [], titlePrompt = text, submissionId?: string): Promise<ChatTurnResult> {
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
      this.events.context.begin(id, entry, session.model);
      entry.subtaskTools.clear(); entry.approvalTasks.clear(); entry.finishedTasks.clear(); entry.backgroundTaskTools.clear();
      this.subtasks.begin(id, entry.turn!.id);
      const userId = randomUUID();
      this.message(id, { id: userId, sourceId: userId, turnId: entry.turn!.id, role: 'user', ...(submissionId === undefined ? {} : { submissionId }), text: text + (attachments.length ? '\n\n附件：\n' + attachments.join('\n') : ''), createdAt: now() });
      this.state(id, 'thinking');
      try {
        // 内置命令解析需要提示词字符串；普通多模态
        // 消息继续使用内容块。
        entry.connection.write({ type: 'user', uuid: userId, message: { role: 'user', content: command ? text.trimStart() : content }, parent_tool_use_id: null, session_id: this.session(id).execution.conversationId });
        if (!command) this.host.onAcceptedPrompt(id, titlePrompt, capabilities);
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
    this.host.metadata?.assertReleased(id);
    if (this.entries.has(id) || this.releasing.has(id) || this.starting.has(id)) throw new Error('会话正在启动。');
    // 元数据清理不消耗前台对话槽位。
    void this.host.metadata?.cancel(id);
    if (this.releaseErrors.has(id)) throw new Error('上一轮资源释放失败，请重启工作台后重试。');
    this.releaseCompletions.delete(id);
    if (this.activeCount >= this.host.maxSessions()) throw new Error('已达到并发会话上限。');
    this.starting.add(id);
    let entry: Entry | undefined;
    try {
      const session = this.session(id);
      const conversationId = session.execution.conversationId;
      if (!conversationId) throw new Error('Claude 会话缺少原生会话标识。');
      if (!fs.statSync(session.cwd).isDirectory()) throw new Error('项目目录不存在。');
      const resumed = await (this.options.transcriptExists ?? transcriptExists)(conversationId);
      if (this.shuttingDown || this.maintenance || !this.starting.has(id)) throw new Error('会话启动已取消。');
      const env = this.host.launch.environment();
      const invocation = this.options.invocation?.(session, capabilities, resumed) ?? (() => {
        const cli = this.host.launch.invocation(env);
        return { file: cli.file, args: [...cli.prefix, ...chatArguments(session, capabilities, resumed)] };
      })();
      this.state(id, 'starting');
      entry = { connection: undefined as unknown as ClaudeConnection, initialized: false, expectedId: conversationId, enforceIdentity: resumed || session.started || session.execution.imported === true, bypassEnabled: session.permissionMode==='bypassPermissions', approvals: new Map(), approvalRequests: new Map(), assistant: undefined as unknown as AssistantStream, resultIds: new Set(), tools: new Set(), tasks: new Set(), subtaskTools: new Map(), approvalTasks: new Map(), finishedTasks: new Set(), backgroundTaskTools: new Map() };
      const current = entry;
      current.assistant = new AssistantStream({
        turnId: () => current.turn?.id, getMessage: key => this.history.getMessage(id, key),
        message: (message, delta) => this.message(id, message, delta), context: (payload, source) => this.events.context.observe(id, current, payload, undefined, source),
        model: model => { this.history.get(id).model = model; this.notify(id); },
      });
      current.connection = new ClaudeConnection(invocation, session.cwd, env, {
        frame: frame => this.events.receive(id, current, frame), error: error => this.fail(id, current, error),
        close: (code, signal) => {
          try { this.closed(id, current, code, signal); }
          catch (error) {
            this.entries.delete(id); this.starting.delete(id);
            void this.host.metadata?.cancel(id);
            this.releaseErrors.set(id, error);
            this.trackRelease(id, current);
            const message = '记录进程退出状态失败：' + messageOf(error);
            current.turn?.resolve({ success: false, summary: '', error: message }); current.turn = undefined;
            const snapshot = this.history.get(id); snapshot.taskState = 'error'; snapshot.error = message; snapshot.pending = [];
            this.publishConversation(id);
          }
        },
      }, this.options.controlTimeoutMs, this.host.signalProcessGroup);
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
    for (const wireRequestId of entry.approvalRequests.values()) entry.connection.reply(wireRequestId, { behavior: 'deny', message: '用户中断了当前任务。', interrupt: true });
    entry.approvals.clear(); entry.approvalRequests.clear(); this.history.get(id).pending = []; this.notify(id, true);
    this.system(id, '已请求中断，等待 CLI 确认结束当前任务。');
    entry.interruptTimer = setTimeout(() => { if (entry.turn?.interrupted) { this.system(id, 'CLI 未及时结束，正在停止进程。'); this.stop(id); } }, 5000);
    try { await entry.connection.control({ subtype: 'interrupt' }, 5000); }
    catch (error) { if (this.entries.get(id) === entry && entry.turn) { this.system(id, messageOf(error), true); this.stop(id); } }
  }
  /** 优先发送必须等待中断确认及进程清理全部完成。 */
  async interruptAndWait(id: string) {
    const entry = this.entries.get(id) ?? this.releasing.get(id);
    if (entry) this.releasing.set(id, entry);
    await this.interrupt(id);
    const deadline = Date.now() + 10_000;
    while (this.isBusy(id) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    // 关闭已中断的连接也会丢弃所有延迟的旧交互轮次帧。
    await this.stopAndWait(id);
    while (this.busy.has(id) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    if (this.busy.has(id) || this.has(id)) throw new Error('上一轮尚未完全停止，排队消息没有发送。');
  }
  async updateConfig(id: string, patch: { model?: string; permissionMode?: PermissionMode; effort?: Effort }) {
    const session = this.session(id); let entry = this.entries.get(id);
    const invalidateModelContext = () => {
      if (patch.model === undefined) return;
      const previousModel = entry?.selectionModel ?? session.model;
      if (entry) { entry.contextRequest = undefined; entry.selectionModel = patch.model || undefined; }
      if (patch.model !== previousModel) this.context(id, { status: 'unknown' });
    };
    if (this.busy.has(id) || this.starting.has(id) || entry?.approvals.size) throw new Error('请等待当前任务完成后修改模型或权限。');
    if (patch.effort !== undefined && patch.effort !== session.effort && entry) throw new Error('修改推理强度前请先停止会话，然后重新发送以恢复。');
    if (entry?.connection.ending) throw new Error('请等待会话停止。');
    this.busy.add(id);
    try {
      // Bypass 必须在 CLI 启动时启用。进入或退出该模式时，
      // 重启空闲进程，确保其他模式不继承绕过审批的启动参数。
      if (entry && patch.permissionMode !== undefined && entry.bypassEnabled !== (patch.permissionMode === 'bypassPermissions')) {
        this.update(id, { status: 'stopping' });
        this.terminate(entry);
        const deadline = Date.now() + PROCESS_RELEASE_TIMEOUT_MS;
        while (this.entries.get(id) === entry && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
        if (this.entries.get(id) === entry) throw new Error('CLI 尚未停止，权限配置未保存。请等待停止后重试。');
        // 此方法负责运行时的 busy 标志。此处仅等待物理连接
        // 释放；whenReleased 还会等待 busy，因此会等待
        // 当前配置操作本身。仅关闭根进程是不够的。
        if (!entry.connection.termination || !await entry.connection.termination) throw new Error('CLI 后代进程尚未停止，权限配置未保存。');
        await this.releaseCompletions.get(id);
        if (this.releaseErrors.has(id)) throw new Error('CLI 资源释放失败，权限配置未保存。', { cause: this.releaseErrors.get(id) });
        this.history.flush();
        entry = undefined;
      }
      if (entry) {
        if (patch.model !== undefined) {
          await entry.connection.control({ subtype: 'set_model', model: patch.model || null });
          // 即使后续权限控制失败，已确认的模型变更仍然有效。
          // 模型控制被拒绝时，先前上下文保持不变。
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
      if (entry && (error instanceof Error && ['ChatControlTimeoutError', 'ClaudePersistenceError'].includes(error.name) || /控制响应格式不兼容/.test(messageOf(error)))) {
        this.fail(id, entry, '配置变更未完成确认或持久化，已停止会话以避免界面与实际权限不一致：' + messageOf(error));
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
    const turn = entry.turn; entry.turn = undefined; entry.tools.clear(); entry.tasks.clear(); entry.approvals.clear(); entry.approvalRequests.clear(); entry.approvalTasks.clear();
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
      // 磁盘失败不得搁置待处理工作流，也不得从标准输出监听器中逸出。
      entry.turn = undefined;
      const snapshot = this.history.get(id); snapshot.taskState = 'error'; snapshot.error = error; snapshot.pending = [];
      turn?.resolve({ success: false, summary: '', error }); this.publishConversation(id);
    } finally { this.terminate(entry); }
  }
  stop(id: string) {
    void this.host.metadata?.cancel(id);
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
    entry.approvals.clear(); entry.approvalRequests.clear();
    entry.connection.terminate();
    // 即使 `closed` 已移除根条目，也继续跟踪后代进程。
    const termination = entry.connection.termination!;
    this.terminations.add(termination);
    void termination.then(stopped => { if (!stopped) this.terminationFailed = true; this.terminations.delete(termination); });
  }
  private closed(id: string, entry: Entry, code: number | null, signal: NodeJS.Signals | null) {
    if (this.entries.get(id) !== entry) return;
    entry.connection.terminate(true);
    this.trackRelease(id, entry, () => {
      const previous = this.history.get(id).taskState;
      const error = 'CLI 进程已退出（' + (code ?? signal ?? '未知') + '）。';
      this.update(id, { status: previous === 'error' || !entry.connection.ending && code !== 0 ? 'error' : 'stopped', exitCode: code ?? undefined,
        error: previous === 'error' ? this.history.get(id).error : !entry.connection.ending && code !== 0 ? error : undefined });
      this.notify(id, true);
    });
    entry.connection.finish();
    this.entries.delete(id); this.starting.delete(id);
    void this.host.metadata?.cancel(id);
    const error = 'CLI 进程已退出（' + (code ?? signal ?? '未知') + '）。' + (entry.connection.stderr ? '\n' + entry.connection.stderr.trim() : '');
    entry.connection.closeControls(error);
    if (entry.interruptTimer) clearTimeout(entry.interruptTimer);
    if (entry.turn) this.finish(id, entry, { success: false, summary: '', error: entry.connection.ending ? undefined : error, interrupted: entry.connection.ending });
    else this.subtasks.end(id, entry.connection.ending ? 'interrupted' : 'failed', entry.connection.ending ? undefined : error);
    const previous = this.history.get(id).taskState;
    this.update(id, { status: 'stopping', exitCode: code ?? undefined, error: previous === 'error' ? this.history.get(id).error : !entry.connection.ending && code !== 0 ? error : undefined });
    this.history.get(id).pending = []; this.notify(id, true);
  }
  async shutdown() {
    this.shuttingDown = true;
    const metadataStopped = this.host.metadata?.cancelAll();
    for (const id of this.starting) this.starting.delete(id);
    const errors: unknown[] = [];
    for (const id of this.entries.keys()) { try { this.stop(id); } catch (error) { errors.push(error); } }
    const deadline = Date.now() + 2500;
    while (this.entries.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    for (const entry of this.entries.values()) { try { entry.connection.child.kill('SIGKILL'); } catch { /* 已退出。 */ } }
    // 根进程关闭不会释放其分离的进程组。保持事件循环运行，
    // 直到已跟踪的升级终止操作确认所有后代均已停止。
    let terminationDeadline: NodeJS.Timeout | undefined;
    try {
      const stopped = await Promise.race([
        Promise.all([...this.terminations, ...[...this.releaseCompletions.values()].map(completion => completion.then(() => true))]).then(results => results.every(Boolean)),
        new Promise<boolean>(resolve => { terminationDeadline = setTimeout(() => resolve(false), PROCESS_RELEASE_TIMEOUT_MS); }),
      ]);
      if (!stopped || this.terminationFailed || this.terminations.size || this.entries.size) {
        errors.push(new Error('无法确认全部聊天子进程已停止，请关闭残留进程后重试退出。'));
      }
    } finally { if (terminationDeadline) clearTimeout(terminationDeadline); }
    await metadataStopped;
    try { this.host.metadata?.assertReleased(); } catch (error) { errors.push(error); }
    for (const timer of this.notifications.values()) clearTimeout(timer);
    this.notifications.clear();
    try { this.history.flush(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, '聊天会话退出未完成：' + errors.map(messageOf).join('；'));
  }
  setMaintenance(value: boolean) { this.maintenance = value; }
  async disconnectAll() {
    if (!this.maintenance) throw new Error('断开聊天前必须暂停新会话。');
    const ids = new Set([...this.entries.keys(), ...this.releasing.keys(), ...this.starting, ...this.busy, ...(this.host.metadata?.ids ?? [])]);
    const results = await Promise.allSettled([...ids].map(id => this.stopAndWait(id)));
    // 在仍禁止启动期间，完成待处理的恢复加载及附件读取。
    const deadline = Date.now() + 10_000;
    while ((this.busy.size || this.terminations.size) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    if (results.some(result => result.status === 'rejected') || this.activeCount || this.busy.size || this.terminations.size || this.terminationFailed) throw new Error('无法确认全部聊天进程已停止，已取消更新。请等待或重启工作台后重试。');
    this.history.flush();
  }
}
