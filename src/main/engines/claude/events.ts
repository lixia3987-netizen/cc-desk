import { randomUUID } from 'node:crypto';
import type { Session } from '../../../shared/types';
import type { ChatApproval, ChatDecision, ChatMessage, ChatQuestion, ChatTurnResult } from '../../../shared/chat';
import type { ChatJournalEvent } from '../../../shared/execution-events';
import type { SubtaskStatus } from '../../../shared/subtasks';
import { isPermissionMode } from '../../../shared/permissions';
import { normalizeCommands, tokenCount, type ContextUsage } from '../../../shared/claude-session';
import { object, string, type WireObject } from '../../chat-protocol';
import type { ChatHistory } from '../../chat-history';
import type { SubtaskTracker } from '../../subtask-tracker';
import type { Entry } from './entry';
import { ClaudeContext } from './context-tracker';

interface EventOutput {
  history: Pick<ChatHistory, 'get' | 'getMessage'>;
  session(id: string): Session;
  current(id: string, entry: Entry): boolean;
  update(id: string, patch: Partial<Session>): void;
  append(id: string, event: ChatJournalEvent): void;
  system(id: string, text: string, isError?: boolean): void;
  message(id: string, message: ChatMessage, delta?: string): void;
  context(id: string, context: ContextUsage): void;
  notify(id: string, immediate?: boolean): void;
  activity(id: string, entry: Entry): void;
  finish(id: string, entry: Entry, result: ChatTurnResult): void;
  fail(id: string, entry: Entry, error: string): void;
}
const now = () => new Date().toISOString();
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
const terminalTask = (status: string) => ['completed', 'failed', 'stopped', 'interrupted', 'unknown'].includes(status);
const taskStatus = (value: unknown): SubtaskStatus | undefined => {
  if (value === 'killed') return 'stopped';
  return ['pending', 'running', 'paused', 'waiting_approval', 'waiting_input', 'completed', 'failed', 'stopped', 'interrupted', 'unknown'].includes(string(value)) ? value as SubtaskStatus : undefined;
};


/** Translates Claude protocol frames into normalized chat, approval and child-task state. */
export class ClaudeEvents {
  readonly context: ClaudeContext;
  constructor(private output: EventOutput, private subtasks: SubtaskTracker, private backgroundResultTimeoutMs = 120_000) {
    this.context = new ClaudeContext(output.history, output.context);
  }
  private resetConversation(id: string, entry: Entry, nextId: string) {
    if (!entry.turn?.resetRequested || !uuid(nextId)) throw new Error('CLI 意外切换了会话，已停止以保留原会话。');
    if (entry.turn.resetApplied) {
      if (nextId !== entry.expectedId) throw new Error('CLI 重复切换了会话，已停止。');
      return;
    }
    entry.turn.resetApplied = true;
    entry.contextRequest = undefined;
    const previous = entry.expectedId;
    entry.expectedId = nextId; entry.enforceIdentity = true;
    this.output.update(id, { execution: { ...this.output.session(id).execution, conversationId: nextId, forkFrom: undefined, imported: undefined }, started: true });
    this.output.history.get(id).usage = undefined;
    this.output.context(id, { model: entry.turn.contextModel ?? entry.selectionModel, status: 'unknown' });
    this.output.system(id, '已清空 Claude 上下文。此前的聊天记录仍保留；原 CLI 会话：' + previous);
  }
  receive(id: string, entry: Entry, frame: WireObject) {
    if (entry.connection.ending || !this.output.current(id, entry)) return;
    const type = string(frame.type);
    this.refreshBackgroundTimeout(id, entry);
    if (type === 'control_response') { entry.connection.receiveControl(frame); return; }
    if (type === 'control_request') { this.permission(id, entry, frame); return; }
    if (type === 'control_cancel_request') {
      const approval = entry.approvals.get(string(frame.request_id));
      if (approval) this.subtaskApproval(id, entry, approval, 'running');
      entry.approvals.delete(string(frame.request_id)); this.output.activity(id, entry); return;
    }
    const parent = string(frame.parent_tool_use_id) || undefined;
    if (type === 'conversation_reset' && !parent) { this.resetConversation(id, entry, string(frame.new_conversation_id)); return; }
    if (!parent && (type === 'system' && frame.subtype === 'init' || type === 'result') && uuid(frame.session_id)) {
      // Older CLIs report /clear's new ID only on the result. All unrelated
      // identity changes retain the existing fail-closed behavior.
      if (entry.enforceIdentity && frame.session_id !== entry.expectedId && entry.turn?.resetRequested) this.resetConversation(id, entry, string(frame.session_id));
      if (entry.enforceIdentity && frame.session_id !== entry.expectedId) throw new Error('CLI 返回了不同的会话 ID，已停止以避免恢复到错误会话。原会话标识已保留。');
      if (this.output.session(id).execution.conversationId !== frame.session_id) this.output.update(id, { execution: { ...this.output.session(id).execution, conversationId: frame.session_id } });
      entry.expectedId = frame.session_id; entry.enforceIdentity = true;
    }
    if (type === 'system') { this.systemEvent(id, entry, frame, parent); return; }
    if (type === 'stream_event') {
      if (parent) this.subtasks.observe(id, { source: 'stream', kind: 'agent', toolUseId: parent, status: this.observedSubtaskStatus(entry, parent, 'running'), phase: 'progress' });
      entry.assistant.stream(object(frame.event), parent); return;
    }
    if (type === 'assistant' || type === 'user') {
      const payload = object(frame.message);
      if (type === 'assistant' && !parent) this.context.observe(id, entry, payload, frame.context_usage);
      const blocks = Array.isArray(payload.content) ? payload.content : [];
      if (!entry.turn) {
        for (const raw of blocks) { const block = object(raw); if (block.type === 'tool_result') this.subtaskToolResult(id, entry, string(block.tool_use_id), block, object(frame.tool_use_result)); }
        return;
      }
      if (parent) this.subtasks.observe(id, { source: 'stream', kind: 'agent', toolUseId: parent, status: this.observedSubtaskStatus(entry, parent, 'running'), phase: 'progress' });
      const group = type === 'assistant' ? entry.assistant.groupFor(payload, frame, parent) : undefined;
      const used = new Set<number>();
      for (const [index, raw] of blocks.entries()) {
        const block = object(raw);
        if (block.type === 'text' && type === 'assistant') {
          entry.assistant.completeText(group!, index, string(block.text), used, blocks.length === 1, string(frame.uuid));
        } else if (block.type === 'tool_use') {
          const toolId = string(block.id); if (!toolId) continue;
          if (!this.output.session(id).started) this.output.update(id, { started: true });
          entry.tools.add(toolId);
          this.output.message(id, { id: 'tool:' + toolId, sourceId: 'tool:' + toolId, turnId: entry.turn?.id ?? '', role: 'tool', text: '', createdAt: now(), toolName: string(block.name), toolUseId: toolId, input: object(block.input), parentToolUseId: parent });
          if (block.name === 'Agent' || block.name === 'Task') {
            const input = object(block.input);
            entry.subtaskTools.set(toolId, { foreground: input.run_in_background === false, parent });
            const observed = this.output.session(id).subtasks?.tasks.find(task => task.toolUseId === toolId && task.turnId === entry.turn?.id);
            this.subtasks.observe(id, { source: 'stream', kind: 'agent', status: observed?.status ?? 'pending', phase: 'start', toolUseId: toolId, parentToolUseId: parent, description: string(input.description) || string(input.subagent_type) || undefined, ...(typeof input.run_in_background === 'boolean' ? { background: input.run_in_background } : {}) });
          }
          this.output.activity(id, entry);
        } else if (block.type === 'tool_result') {
          const toolId = string(block.tool_use_id); entry.tools.delete(toolId);
          const existing = this.output.history.getMessage(id, 'tool:' + toolId);
          const text = typeof block.content === 'string' ? block.content : Array.isArray(block.content) ? block.content.map(value => {
            const item = object(value); return item.type === 'text' ? string(item.text) : '[' + string(item.type) + ']';
          }).join('\n') : '';
          this.output.message(id, { id: 'tool:' + toolId, sourceId: 'tool:' + toolId, turnId: entry.turn?.id ?? '', role: 'tool', createdAt: now(), ...existing, text, toolUseId: toolId, isError: block.is_error === true, parentToolUseId: parent });
          this.subtaskToolResult(id, entry, toolId, block, object(frame.tool_use_result), text);
          this.output.activity(id, entry);
        } else if (block.type === 'text' && parent) {
          this.output.message(id, { id: string(frame.uuid) || randomUUID(), turnId: entry.turn?.id ?? '', role: 'user', text: string(block.text), parentToolUseId: parent, createdAt: now() });
        }
      }
      if (group) {
        group.completed = true;
        if (!parent && group.blocks.size) entry.assistant.latestRoot = group;
        if (group.stopped) entry.assistant.streams.delete(JSON.stringify(parent ?? null));
        entry.assistant.prune();
      }
      return;
    }
    if (type === 'result' && parent) {
      const failed = frame.is_error === true || (typeof frame.subtype === 'string' && frame.subtype !== 'success');
      this.subtasks.observe(id, { source: 'stream', kind: 'agent', toolUseId: parent, status: failed ? 'failed' : 'completed', phase: 'finish', summary: string(frame.result) || (Array.isArray(frame.errors) ? frame.errors.map(String).join('\n') : undefined), durationMs: number(frame.duration_ms) });
      // Child results report a child lifecycle; they cannot end or rewrite the parent turn.
      this.settleBackgroundTask(id, entry, parent);
      return;
    }
    if (type === 'result' && !parent) {
      if (!entry.turn) return;
      const resultId = string(frame.uuid);
      if (resultId && entry.resultIds.has(resultId)) return;
      if (resultId) entry.resultIds.add(resultId);
      const snapshot = this.output.history.get(id); const usage = object(frame.usage);
      this.context.capacity(id, entry, frame.modelUsage);
      snapshot.usage = { inputTokens: number(usage.input_tokens), outputTokens: number(usage.output_tokens), cacheReadTokens: number(usage.cache_read_input_tokens), cacheCreationTokens: number(usage.cache_creation_input_tokens), costUSD: number(frame.total_cost_usd), durationMs: number(frame.duration_ms), turns: number(frame.num_turns) };
      const failed = frame.is_error === true || (typeof frame.subtype === 'string' && frame.subtype !== 'success');
      if (!failed && !this.output.session(id).started) this.output.update(id, { started: true });
      const summary = string(frame.result);
      const error = failed ? (Array.isArray(frame.errors) ? frame.errors.map(String).join('\n') : summary || string(frame.subtype) || 'Claude 执行失败。') : undefined;
      this.output.append(id, { type: 'result', success: !failed, summary, error, usage: snapshot.usage });
      if (summary && !entry.assistant.matchesSummary(summary)) this.output.message(id, { id: randomUUID(), turnId: entry.turn?.id ?? '', role: 'assistant', text: summary, createdAt: now(), isError: failed });
      entry.assistant.latestRoot = undefined;
      if (entry.tasks.size && !failed && !entry.turn?.interrupted) {
        entry.waitingBackgroundResult = true;
        this.output.system(id, '本轮输出已结束，后台子任务仍在运行。'); this.output.activity(id, entry); return;
      }
      const interrupted = entry.turn?.interrupted === true;
      this.output.finish(id, entry, { success: !failed && !interrupted, summary, error, interrupted });
      return;
    }
    if (type === 'error') this.output.fail(id, entry, string(frame.error) || string(object(frame.error).message) || 'Claude 返回了错误。');
  }
  refreshBackgroundTimeout(id: string, entry: Entry) {
    if (entry.backgroundTimer) clearTimeout(entry.backgroundTimer);
    entry.backgroundTimer = undefined;
    if (!entry.waitingBackgroundResult || !entry.turn || entry.turn.interrupted || entry.tasks.size || entry.approvals.size || entry.connection.ending) return;
    // This is an inactivity deadline. Progress restarts it and human approval
    // pauses it, so a long healthy continuation cannot be stopped by wall time.
    entry.backgroundTimer = setTimeout(() => {
      entry.backgroundTimer = undefined;
      if (entry.turn && entry.waitingBackgroundResult && !entry.tasks.size && !entry.approvals.size) this.output.fail(id, entry, '后台子任务已结束，但 CLI 未返回最终结果。会话已停止，可恢复后继续；工作流没有自动进入下一阶段。');
    }, this.backgroundResultTimeoutMs ?? 120_000);
  }
  private settleBackgroundTask(id: string, entry: Entry, toolUseId: string) {
    this.backgroundTask(entry, undefined, toolUseId, 'completed');
    for (const task of this.output.session(id).subtasks?.tasks ?? []) if (task.toolUseId === toolUseId && terminalTask(task.status)) {
      if (task.taskId) this.backgroundTask(entry, task.taskId, toolUseId, task.status);
    }
    this.refreshBackgroundTimeout(id, entry);
  }
  private backgroundTask(entry: Entry, taskId: string | undefined, toolUseId: string | undefined, status: SubtaskStatus) {
    const valid = (value: string | undefined) => !!value && value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value);
    if (!valid(taskId)) taskId = undefined;
    if (!valid(toolUseId)) toolUseId = undefined;
    toolUseId ??= taskId ? entry.backgroundTaskTools.get(taskId) : undefined;
    if (!taskId && !toolUseId) return;
    if (taskId && toolUseId) {
      // A resumed agent can retain its agent id with a fresh tool invocation.
      // Keep execution keys distinct and do not let an old terminal replay
      // replace the alias belonging to its newer invocation.
      if (!terminalTask(status) || !entry.backgroundTaskTools.has(taskId)) entry.backgroundTaskTools.set(taskId, toolUseId);
      if (entry.backgroundTaskTools.get(taskId) === toolUseId) entry.tasks.delete('task:' + taskId);
    }
    const key = toolUseId ? 'tool:' + toolUseId : 'task:' + taskId;
    if (terminalTask(status)) { entry.tasks.delete(key); entry.finishedTasks.add(key); }
    else if (!entry.finishedTasks.has(key)) entry.tasks.add(key);
  }
  private observedSubtaskStatus(entry: Entry, toolUseId: string | undefined, fallback: SubtaskStatus): SubtaskStatus {
    if (!toolUseId || terminalTask(fallback)) return fallback;
    const approvals = [...entry.approvals.values()].filter(approval => entry.approvalTasks.get(approval.requestId) === toolUseId);
    return approvals.some(approval => approval.kind === 'question') ? 'waiting_input' : approvals.length ? 'waiting_approval' : fallback;
  }
  private subtaskToolResult(id: string, entry: Entry, toolUseId: string, block: WireObject, result: WireObject, text = '') {
    const launched = entry.subtaskTools.get(toolUseId);
    const previous = this.output.session(id).subtasks?.tasks.find(task => task.toolUseId === toolUseId && task.kind === 'agent');
    if (!toolUseId || !launched && !previous) return;
    const status = block.is_error === true ? 'failed' : taskStatus(result.status) ?? (result.status === 'async_launched' || result.status === 'remote_launched' ? 'running' : launched?.foreground ? 'completed' : undefined);
    if (!status) return;
    const report = Array.isArray(result.content) ? result.content.map(object).filter(item => item.type === 'text').map(item => string(item.text)).join('\n') : '';
    const task = this.subtasks.observe(id, {
      source: 'stream', kind: 'agent', status, phase: terminalTask(status) ? 'finish' : 'progress', toolUseId,
      parentToolUseId: launched?.parent, agentId: string(result.agentId) || undefined, taskId: string(result.taskId) || undefined,
      description: string(result.description) || undefined, summary: terminalTask(status) ? report || text || undefined : undefined,
      toolUses: number(result.totalToolUseCount), durationMs: number(result.totalDurationMs),
      ...(result.status === 'async_launched' || result.status === 'remote_launched' ? { background: true } : {}),
    });
    const observed = task?.status ?? status;
    if (result.status === 'async_launched' || result.status === 'remote_launched') this.backgroundTask(entry, string(result.taskId) || string(result.agentId) || undefined, toolUseId, observed);
    if (terminalTask(observed)) this.settleBackgroundTask(id, entry, toolUseId);
  }
  private systemEvent(id: string, entry: Entry, frame: WireObject, parent?: string) {
    const subtype = string(frame.subtype); const snapshot = this.output.history.get(id);
    if (subtype === 'init') {
      if (parent) return;
      const model = string(frame.model);
      this.context.selection(id, entry, model);
      snapshot.model = string(frame.model) || undefined;
      snapshot.permissionMode = string(frame.permissionMode) || this.output.session(id).permissionMode;
      snapshot.mcpServers = Array.isArray(frame.mcp_servers) ? frame.mcp_servers.map(value => { const item = object(value); return { name: string(item.name), status: string(item.status) }; }) : [];
      if (Array.isArray(frame.slash_commands)) entry.commands = normalizeCommands(frame.slash_commands, entry.commands, frame.skills);
      if (isPermissionMode(snapshot.permissionMode)) this.output.update(id, { permissionMode: snapshot.permissionMode, observedPermissionMode: snapshot.permissionMode });
      this.output.append(id, { type: 'metadata', model: snapshot.model, permissionMode: snapshot.permissionMode, mcpServers: snapshot.mcpServers });
      for (const field of ['plugin_errors', 'mcp_server_errors']) if (Array.isArray(frame[field]) && frame[field].length) this.output.system(id, field + ': ' + JSON.stringify(frame[field]), true);
      this.output.notify(id, true);
    } else if (['task_started', 'task_progress', 'task_notification', 'task_updated'].includes(subtype)) {
      const patch = subtype === 'task_updated' ? object(frame.patch) : frame;
      const status = subtype === 'task_started' || subtype === 'task_progress' ? 'running' : taskStatus(patch.status);
      const taskId = string(frame.task_id); const toolUseId = string(frame.tool_use_id) || undefined;
      const usage = object(frame.usage);
      // Description-only task_updated frames have no status transition. Preserve
      // the observed status rather than inventing a running task from a label.
      const activity = this.output.session(id).subtasks;
      const matches = (activity?.tasks ?? []).filter(task => toolUseId ? task.toolUseId === toolUseId : taskId && (task.taskId === taskId || task.kind === 'agent' && task.agentId === taskId));
      const current = matches.filter(task => task.turnId === activity?.turnId);
      const relevant = current.length ? current : matches;
      const existing = relevant.filter(task => !terminalTask(task.status)).at(-1) ?? relevant.at(-1);
      const observed = status ?? existing?.status;
      if (observed) {
        const kind = /(?:bash|shell|command)/i.test(string(frame.task_type)) ? 'shell' : frame.task_type === 'local_agent' || string(frame.subagent_type) ? 'agent' : undefined;
        const task = this.subtasks.observe(id, {
          source: 'stream', kind, status: this.observedSubtaskStatus(entry, toolUseId ?? existing?.toolUseId, observed), phase: subtype === 'task_started' ? 'start' : terminalTask(observed) ? 'finish' : 'progress', taskId: taskId || undefined, toolUseId,
          parentToolUseId: parent, description: string(patch.description) || undefined,
          summary: string(patch.summary) || string(patch.error) || undefined, progress: subtype === 'task_progress' ? string(frame.summary) || undefined : undefined,
          lastTool: string(frame.last_tool_name) || undefined, toolUses: number(usage.tool_uses), totalTokens: number(usage.total_tokens), durationMs: number(usage.duration_ms),
          ...(typeof patch.is_backgrounded === 'boolean' ? { background: patch.is_backgrounded } : subtype === 'task_started' ? { background: true } : {}),
        });
        // Waiting for the CLI must remain correct even when the bounded UI
        // projection has no room for another task row.
        if (taskId) this.backgroundTask(entry, taskId, task?.toolUseId ?? toolUseId, task?.status ?? observed);
      }
      if (subtype === 'task_started') this.output.system(id, '子任务开始：' + (string(frame.description) || taskId));
      else if (subtype === 'task_notification') this.output.system(id, '子任务 ' + string(frame.status) + '：' + (string(frame.summary) || taskId), frame.status === 'failed');
      this.refreshBackgroundTimeout(id, entry);
    } else if (subtype === 'commands_changed' && !parent) {
      entry.commands = normalizeCommands(frame.commands, entry.commands, frame.skills); this.output.notify(id);
    } else if (subtype === 'compact_boundary' && !parent) {
      entry.contextRequest = undefined;
      const metadata = object(frame.compact_metadata), trigger = metadata.trigger === 'manual' || metadata.trigger === 'auto' ? metadata.trigger : undefined;
      this.output.context(id, { ...snapshot.context, status: 'compacted', inputTokens: undefined, measuredAt: undefined,
        lastCompaction: { at: now(), trigger, preTokens: tokenCount(metadata.pre_tokens) } });
      this.output.system(id, (trigger === 'auto' ? '自动' : '') + '上下文压缩已完成，等待下一次请求更新用量。');
    } else if (subtype === 'local_command_output' && !parent && typeof frame.content === 'string') {
      this.output.system(id, frame.content);
    } else if (subtype === 'api_retry') this.output.system(id, '模型请求重试 ' + String(frame.attempt ?? '') + '/' + String(frame.max_retries ?? '') + '：' + string(frame.error), true);
    else if (subtype === 'permission_denied') this.output.system(id, 'CLI 权限规则拒绝了操作：' + JSON.stringify(frame), true);
    else if (subtype === 'status' && !parent && frame.status === 'compacting') {
      this.output.context(id, { ...snapshot.context, status: 'compacting' }); this.output.system(id, '正在压缩上下文…');
    }
  }

  private permission(id: string, entry: Entry, frame: WireObject) {
    const requestId = string(frame.request_id); const request = object(frame.request);
    if (!requestId) throw new Error('CLI 审批请求缺少 request_id。');
    if (request.subtype !== 'can_use_tool') {
      entry.connection.reply(requestId, {}, 'Unsupported control request: ' + string(request.subtype));
      this.output.system(id, '当前客户端不支持 CLI 控制请求：' + string(request.subtype), true); return;
    }
    if (!entry.turn || entry.turn.interrupted || entry.approvals.size >= 32) {
      entry.connection.reply(requestId, { behavior: 'deny', message: 'No active turn or permission queue full.' }); return;
    }
    if (entry.approvals.has(requestId)) return;
    const toolName = string(request.tool_name); const input = object(request.input);
    const questions: ChatQuestion[] | undefined = toolName === 'AskUserQuestion' && Array.isArray(input.questions) ? input.questions.map(value => {
      const question = object(value);
      return { question: string(question.question), header: string(question.header), multiSelect: question.multiSelect === true, options: Array.isArray(question.options) ? question.options.map(option => { const item = object(option); return { label: string(item.label), description: string(item.description) }; }) : [] };
    }) : undefined;
    const approval: ChatApproval = { requestId, toolName, input: structuredClone(input), kind: toolName === 'AskUserQuestion' ? 'question' : 'permission', questions, createdAt: now(), toolUseId: string(request.tool_use_id) || undefined };
    entry.approvals.set(requestId, approval);
    const parent = string(frame.parent_tool_use_id) || string(request.parent_tool_use_id) || (approval.toolUseId && this.output.history.getMessage(id, 'tool:' + approval.toolUseId)?.parentToolUseId);
    const taskTool = toolName === 'Agent' || toolName === 'Task' ? approval.toolUseId : parent;
    if (taskTool) {
      entry.approvalTasks.set(requestId, taskTool);
      this.subtasks.observe(id, { source: 'stream', kind: 'agent', toolUseId: taskTool, status: approval.kind === 'question' ? 'waiting_input' : 'waiting_approval', phase: 'progress' });
    }
    this.output.append(id, { type: 'approval_requested', approval });
    this.output.activity(id, entry);
  }
  private subtaskApproval(id: string, entry: Entry, approval: ChatApproval, status: 'running' | 'stopped') {
    const toolUseId = entry.approvalTasks.get(approval.requestId);
    entry.approvalTasks.delete(approval.requestId);
    if (!toolUseId) return;
    const waiting = [...entry.approvals.values()].find(item => item.requestId !== approval.requestId && entry.approvalTasks.get(item.requestId) === toolUseId);
    const observed = waiting ? waiting.kind === 'question' ? 'waiting_input' : 'waiting_approval'
      : status === 'running' && (approval.toolName === 'Agent' || approval.toolName === 'Task') ? 'pending' : status;
    this.subtasks.observe(id, { source: 'stream', kind: 'agent', toolUseId, status: observed, phase: observed === 'stopped' ? 'finish' : 'progress' });
  }
  respond(id: string, entry: Entry | undefined, requestId: string, decision: ChatDecision) {
    const approval = entry?.approvals.get(requestId);
    if (!entry || entry.connection.ending || !approval) throw new Error('该审批已失效或已处理，请刷新会话。');
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
    entry.connection.reply(requestId, response);
    entry.approvals.delete(requestId);
    this.subtaskApproval(id, entry, approval, decision.behavior === 'deny' && (approval.toolName === 'Agent' || approval.toolName === 'Task') ? 'stopped' : 'running');
    this.output.append(id, { type: 'approval_resolved', requestId, decision });
    this.output.activity(id, entry);
  }
}
