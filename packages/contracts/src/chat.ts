import type { SessionCommand, SessionStatus, ContextUsage } from './execution.js';
import type { NativeChangeSetPreview, NativeChangeSetResult } from './native-changes.js';
import type { NativeTaskIdentity, NativeTaskView } from './native-task.js';
import type { NativeCommandDescriptor, NativeCommandResult } from './native-commands.js';
import type { NativeAgentSnapshot, NativeAgentApprovalScope } from './native-agents.js';
export type { NativeAgentView, NativeAgentSnapshot, NativeAgentApprovalScope, NativeAgentResultRequest, NativeAgentResult, NativeAgentPatchPage } from './native-agents.js';
/** 一轮交互的状态，与 CLI 进程的生命周期无关。 */
export type TaskState = 'idle' | 'starting' | 'thinking' | 'tool_running' | 'waiting_approval' | 'waiting_input' | 'completed' | 'interrupted' | 'error';
/** 随一条 Native 用户消息提交的字节数据的不可变元数据，绝不包含文件路径或图像载荷。 */
export interface NativeImageAttachment {
  name: string;
  mimeType: 'image/png' | 'image/jpeg';
  bytes: number;
  sha256: string;
}
export function isNativeImageAttachments(value: unknown): value is NativeImageAttachment[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) return false;
  let bytes = 0;
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const image = item as Record<string, unknown>;
    if (Object.keys(image).some(key => !['name', 'mimeType', 'bytes', 'sha256'].includes(key))
      || typeof image.name !== 'string' || !image.name || image.name.length > 1024 || /[\\/\x00-\x1f\x7f]/.test(image.name)
      || !['image/png', 'image/jpeg'].includes(String(image.mimeType))
      || typeof image.bytes !== 'number' || !Number.isSafeInteger(image.bytes) || image.bytes < 1
      || typeof image.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(image.sha256)) return false;
    bytes += image.bytes;
  }
  return bytes <= 1024 * 1024;
}
export interface ChatMessage {
  id: string; turnId: string; role: 'user' | 'assistant' | 'tool' | 'system';
  /** 宿主执行提交标识；队列发送时等于队列消息 id，与 CLI 消息 id 独立。 */
  submissionId?: string;
  /** 只读展示中由宿主以持久接收记录补充的精确关联；不表示执行或状态同步。 */
  clientRequestId?: string;
  text: string; createdAt: string;
  toolName?: string; toolUseId?: string; input?: Record<string, unknown>;
  isError?: boolean; parentToolUseId?: string;
  /** 已提交图像版本的元数据，不与原始文件或暂存文件保持实时关联。 */
  nativeImageAttachments?: NativeImageAttachment[];
  /** 由宿主提供的、持久化多文件影响的结构化投影。 */
  nativeChangeSetResult?: NativeChangeSetResult;
  nativeChangeSetState?: 'pending' | 'running' | 'not_executed' | 'result';
  /** 可见文本或工具输入省略了事件日志中保留的内容。 */
  truncated?: boolean;
  /** 用于将已停止会话与其对话记录核对的稳定 CLI 身份。 */
  sourceId?: string;
}
export interface ChatQuestion {
  question: string; header?: string;
  options: { label: string; description?: string }[];
  multiSelect?: boolean;
}
export interface ChatApproval {
  requestId: string; toolName: string; input: Record<string, unknown>;
  kind: 'permission' | 'question'; questions?: ChatQuestion[];
  createdAt: string; toolUseId?: string;
  /** 完整的审批预览，绝不替换为截断的 JSON 字符串。 */
  nativeChangeSet?: NativeChangeSetPreview;
  /** 宿主绑定的子任务归属方及工作区，与不可信的工具输入无关。 */
  nativeDelegation?: NativeAgentApprovalScope;
}
export interface ChatDecision {
  behavior: 'allow' | 'deny'; message?: string;
  /** AskUserQuestion 的回答以完整的问题文本为键。 */
  answers?: Record<string, string>;
}
export interface ChatUsage {
  inputTokens?: number; outputTokens?: number;
  cacheReadTokens?: number; cacheCreationTokens?: number;
  /** Native 的互斥输入分项；旧记录缺失或 null 均表示未知。 */
  nonCachedInputTokens?: number | null;
  cacheReadInputTokens?: number | null;
  cacheCreationInputTokens?: number | null;
  nativeCost?: {
    source: 'user_rates'; status: 'ready' | 'unknown'; model?: string; costUSD?: number;
    reason?: 'missing_usage' | 'missing_pricing' | 'model_mismatch' | 'missing_cache_usage' | 'inconsistent_usage' | 'missing_cache_pricing' | 'incomplete_requests';
  };
  /** 本地汇总只统计当前父回合与其回合内摘要，子代理账本另计。 */
  nativeRequests?: { scope: 'parent_run_with_in_turn_summaries'; recorded: number; expected: number; complete: boolean };
  /** CLI 报告的估算值，并非用户的订阅额度。 */
  costUSD?: number; durationMs?: number; turns?: number;
}
/** 由宿主根据原生账本派生；渲染进程绝不判断恢复是否安全。 */
export interface NativeRecoveryStatus {
  status: 'recoverable' | 'blocked' | 'acknowledged';
  headHash: string;
  runId?: string;
  reason?: string;
  tools: { completed: number; notExecuted: number; unknown: number };
}
/** 仅包含元数据，与维护视图取自同一持久化日志头。 */
export type NativeContextCompactionPreview = {
  status: 'available';
  /** 单独序列化的本地上下文大小，并非提供商的 token 数或净节省量。 */
  summarizableBytes: number;
  retainedBytes: number;
  retainedImages: number;
  retention: 'recent_turns' | 'image_suffix';
} | {
  status: 'unavailable';
  reason: 'no_complete_prefix' | 'image_prefix_unavailable' | 'busy' | 'recovery_required' | 'unsupported_context' | 'unavailable';
};
export interface NativeContextMaintenance {
  headHash: string;
  canCompact: boolean;
  /** 本地检查不会请求摘要，也不保证摘要的大小或质量。 */
  preview?: NativeContextCompactionPreview;
  compacting?: boolean;
  compactionTrigger?: 'manual' | 'automatic' | 'in_turn';
  autoCompact?: { enabled: boolean; thresholdPercent: 90; blocked?: boolean; mode?: 'off' | 'before_send' | 'before_send_and_during_run' };
  lastCompaction?: { beforeBytes: number; afterBytes: number; createdAt: string; trigger?: 'manual' | 'automatic' | 'in_turn' };
  /** 宿主管理的回执。仅收到摘要响应并不代表压缩已提交。 */
  inTurn?: {
    status: 'attempted' | 'committed' | 'failed' | 'unknown';
    runId: string; createdAt: string;
    beforeBytes?: number; afterBytes?: number;
    summaryUsage?: { inputTokens?: number; outputTokens?: number };
    summaryCostUSD?: number;
  };
}
/** 宿主生命周期及可观测状态的顺序，与持久化任务修订号无关。 */
export interface ChatSnapshotVersion {
  hostEpoch: string; revision: number; eventSequence: number;
  conversationId?: string; runId?: string; workerGeneration?: number;
}
/** 宿主账本的只读投影。启动或结束命令不代表任务验收通过。 */
export interface NativeCommandView {
  commandId: string; taskId: string; runId: string; toolCallId: string;
  command: NativeCommandDescriptor;
  status: 'prepared' | 'running' | 'finished' | 'unknown';
  preparedAt: string; runningAt?: string; finishedAt?: string;
  timeoutMs: number; maxOutputBytes: number;
  result?: NativeCommandResult;
  /** 缺少持久化终态回执；绝不根据旧 PID 重新关联进程。 */
  missingTerminal?: boolean;
}
export interface NativeCommandSnapshot {
  /** 最近 64 条命令，包含当前运行的所有命令（最多 8 条）。 */
  items: NativeCommandView[];
  omitted: number;
}
export interface ChatSnapshot {
  sessionId: string; taskState: TaskState;
  /** 随此快照一同读取，避免工作区事件丢失后面板永远停留在停止中。 */
  sessionStatus?: SessionStatus;
  messages: ChatMessage[]; pending: ChatApproval[];
  usage?: ChatUsage; model?: string; permissionMode?: string;
  context?: ContextUsage;
  nativeRecovery?: NativeRecoveryStatus;
  nativeContextMaintenance?: NativeContextMaintenance;
  nativeRun?: NativeTaskIdentity;
  nativeTask?: NativeTaskView;
  nativeTaskError?: string;
  nativeCommands?: NativeCommandSnapshot;
  nativeAgents?: NativeAgentSnapshot;
  version?: ChatSnapshotVersion;
  /** 当前进程的命令目录，绝不从磁盘恢复。 */
  commands?: SessionCommand[];
  mcpServers?: { name: string; status: string }[];
  error?: string; truncated?: boolean;
  /** CLI 对话记录仅部分导入；本地日志无法补全缺失的前缀。 */
  sourceIncomplete?: boolean;
  /** 持久化的主进程提交记录，与当前 CLI 交互轮次无关。 */
  queue?: ChatQueueSnapshot;
}
export interface QueuedChatMessage {
  id: string; text: string; attachments: string[]; createdAt: string;
  /** 客户端 queue.submit 请求标识，用于接收确认返回前精确关联本次提交。 */
  clientRequestId?: string;
  attachmentNames?: string[];
  /** 显式提交时选定的字节数据，将后续 Native 派发绑定到同一图像版本。 */
  nativeImageAttachments?: NativeImageAttachment[];
  status: 'queued' | 'sending';
  nativeTaskId?: string;
}
/** 只有用户显式选择时才延续已有的原生任务。 */
export interface ChatSendOptions { nativeTaskId?: string }
export interface ChatQueueSnapshot {
  items: QueuedChatMessage[]; paused: boolean; error?: string;
  /** 有界的持久接收证明；消息出队后仍可关联原提交，不代表执行或验收成功。 */
  receipts?: { requestId: string; messageId: string }[];
}
export interface ChatSubmission { messageId: string }
export interface ChatTurnResult { success: boolean; summary: string; error?: string; interrupted?: boolean; nativeReceipt?: import('./native-task.js').NativeExecutionReceipt }

export interface ChatPageOptions { before?: string; after?: string; around?: string; query?: string }
export interface ChatPage {
  messages: ChatMessage[]; before: string | null; after: string | null;
  /** 部分来源内容不可用，或超出了安全读取上限。 */
  incomplete: boolean;
}
/** 只读展示页不携带运行、审批或恢复结论；这些状态必须读取权威快照。 */
export interface ChatDisplayPage extends ChatPage {
  sessionId: string;
  conversationId?: string;
}
export interface ChatSearchHit { id: string; role: ChatMessage['role']; toolName?: string; excerpt: string; createdAt: string }
export interface ChatSearchPage { hits: ChatSearchHit[]; nextBefore: string | null; incomplete: boolean }
export interface ChatAttention {
  sessionId: string; requestId: string; kind: ChatApproval['kind']; toolName: string; createdAt: string;
}
