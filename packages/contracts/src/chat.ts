import type { SessionCommand, SessionStatus, ContextUsage } from './execution.js';
import type { NativeChangeSetPreview, NativeChangeSetResult } from './native-changes.js';
import type { NativeTaskIdentity, NativeTaskView } from './native-task.js';
/** State of a turn, independent of the lifetime of the CLI process. */
export type TaskState = 'idle' | 'starting' | 'thinking' | 'tool_running' | 'waiting_approval' | 'waiting_input' | 'completed' | 'interrupted' | 'error';
export interface ChatMessage {
  id: string; turnId: string; role: 'user' | 'assistant' | 'tool' | 'system';
  text: string; createdAt: string;
  toolName?: string; toolUseId?: string; input?: Record<string, unknown>;
  isError?: boolean; parentToolUseId?: string;
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
export interface NativeContextMaintenance {
  headHash: string;
  canCompact: boolean;
  compacting?: boolean;
  compactionTrigger?: 'manual' | 'automatic';
  autoCompact?: { enabled: boolean; thresholdPercent: 90; blocked?: boolean };
  lastCompaction?: { beforeBytes: number; afterBytes: number; createdAt: string; trigger?: 'manual' | 'automatic' };
}
/** Host lifetime and observable state ordering; independent from durable task revisions. */
export interface ChatSnapshotVersion {
  hostEpoch: string; revision: number; eventSequence: number;
  conversationId?: string; runId?: string; workerGeneration?: number;
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
