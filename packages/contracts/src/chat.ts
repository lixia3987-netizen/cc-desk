import type { SessionCommand, SessionStatus, ContextUsage } from './execution.js';
import type { NativeChangeSetPreview, NativeChangeSetResult } from './native-changes.js';
import type { NativeTaskIdentity, NativeTaskView } from './native-task.js';
import type { NativeCommandDescriptor, NativeCommandResult } from './native-commands.js';
/** State of a turn, independent of the lifetime of the CLI process. */
export type TaskState = 'idle' | 'starting' | 'thinking' | 'tool_running' | 'waiting_approval' | 'waiting_input' | 'completed' | 'interrupted' | 'error';
/** Immutable metadata of the bytes submitted with one Native user message. Never a file path or image payload. */
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
  text: string; createdAt: string;
  toolName?: string; toolUseId?: string; input?: Record<string, unknown>;
  isError?: boolean; parentToolUseId?: string;
  /** Submitted image version metadata; no live link to the original or staged file. */
  nativeImageAttachments?: NativeImageAttachment[];
  /** Structured host projection of durable multi-file effects. */
  nativeChangeSetResult?: NativeChangeSetResult;
  nativeChangeSetState?: 'pending' | 'running' | 'not_executed' | 'result';
  /** The visible text or tool input omits content retained in the event journal. */
  truncated?: boolean;
  /** Stable CLI identity used when reconciling a stopped session with its transcript. */
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
  /** Complete approval preview; never replaced with a truncated JSON string. */
  nativeChangeSet?: NativeChangeSetPreview;
}
export interface ChatDecision {
  behavior: 'allow' | 'deny'; message?: string;
  /** AskUserQuestion answers are keyed by the exact question text. */
  answers?: Record<string, string>;
}
export interface ChatUsage {
  inputTokens?: number; outputTokens?: number;
  cacheReadTokens?: number; cacheCreationTokens?: number;
  /** CLI-reported estimate; this is not the user's subscription quota. */
  costUSD?: number; durationMs?: number; turns?: number;
}
/** Derived from the native ledger by the host; the renderer never decides recovery safety. */
export interface NativeRecoveryStatus {
  status: 'recoverable' | 'blocked' | 'acknowledged';
  headHash: string;
  runId?: string;
  reason?: string;
  tools: { completed: number; notExecuted: number; unknown: number };
}
/** Metadata only, derived from the same durable head as the maintenance view. */
export type NativeContextCompactionPreview = {
  status: 'available';
  /** Independently serialized local context sizes, not provider tokens or net savings. */
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
  /** Local inspection does not request a summary or guarantee its size or quality. */
  preview?: NativeContextCompactionPreview;
  compacting?: boolean;
  compactionTrigger?: 'manual' | 'automatic' | 'in_turn';
  autoCompact?: { enabled: boolean; thresholdPercent: 90; blocked?: boolean; mode?: 'off' | 'before_send' | 'before_send_and_during_run' };
  lastCompaction?: { beforeBytes: number; afterBytes: number; createdAt: string; trigger?: 'manual' | 'automatic' | 'in_turn' };
  /** Host-owned receipt. A summary response alone is not a committed compaction. */
  inTurn?: {
    status: 'attempted' | 'committed' | 'failed' | 'unknown';
    runId: string; createdAt: string;
    beforeBytes?: number; afterBytes?: number;
    summaryUsage?: { inputTokens?: number; outputTokens?: number };
    summaryCostUSD?: number;
  };
}
/** Host lifetime and observable state ordering; independent from durable task revisions. */
export interface ChatSnapshotVersion {
  hostEpoch: string; revision: number; eventSequence: number;
  conversationId?: string; runId?: string; workerGeneration?: number;
}
/** Read-only host ledger projection. Starting or finishing a command is not task acceptance. */
export interface NativeCommandView {
  commandId: string; taskId: string; runId: string; toolCallId: string;
  command: NativeCommandDescriptor;
  status: 'prepared' | 'running' | 'finished' | 'unknown';
  preparedAt: string; runningAt?: string; finishedAt?: string;
  timeoutMs: number; maxOutputBytes: number;
  result?: NativeCommandResult;
  /** No durable terminal receipt; never attach to a process by its old PID. */
  missingTerminal?: boolean;
}
export interface NativeCommandSnapshot {
  /** Newest 64 commands, including every command from the current run (at most 8). */
  items: NativeCommandView[];
  omitted: number;
}
export interface ChatSnapshot {
  sessionId: string; taskState: TaskState;
  /** Read with this snapshot, so a lost workspace event cannot leave the pane stopping forever. */
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
  version?: ChatSnapshotVersion;
  /** The current process's command catalog; never restored from disk. */
  commands?: SessionCommand[];
  mcpServers?: { name: string; status: string }[];
  error?: string; truncated?: boolean;
  /** The CLI transcript was imported only in part; the local journal cannot supply that missing prefix. */
  sourceIncomplete?: boolean;
  /** Durable main-process submissions, independent of the current CLI turn. */
  queue?: ChatQueueSnapshot;
}
export interface QueuedChatMessage {
  id: string; text: string; attachments: string[]; createdAt: string;
  attachmentNames?: string[];
  /** Bytes selected at explicit submission; binds later Native dispatch to the same image version. */
  nativeImageAttachments?: NativeImageAttachment[];
  status: 'queued' | 'sending';
  nativeTaskId?: string;
}
/** Only explicit user selection continues an existing native task. */
export interface ChatSendOptions { nativeTaskId?: string }
export interface ChatQueueSnapshot { items: QueuedChatMessage[]; paused: boolean; error?: string }
export interface ChatSubmission { messageId: string }
export interface ChatTurnResult { success: boolean; summary: string; error?: string; interrupted?: boolean }

export interface ChatPageOptions { before?: string; after?: string; around?: string; query?: string }
export interface ChatPage {
  messages: ChatMessage[]; before: string | null; after: string | null;
  /** Some source content is unavailable or exceeded a safe reading limit. */
  incomplete: boolean;
}
export interface ChatSearchHit { id: string; role: ChatMessage['role']; toolName?: string; excerpt: string; createdAt: string }
export interface ChatSearchPage { hits: ChatSearchHit[]; nextBefore: string | null; incomplete: boolean }
export interface ChatAttention {
  sessionId: string; requestId: string; kind: ChatApproval['kind']; toolName: string; createdAt: string;
}
