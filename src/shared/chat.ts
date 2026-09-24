import type { SessionCommand, ContextUsage } from './execution';
/** State of a turn, independent of the lifetime of the CLI process. */
export type TaskState = 'idle' | 'starting' | 'thinking' | 'tool_running' | 'waiting_approval' | 'waiting_input' | 'completed' | 'interrupted' | 'error';
export interface ChatMessage {
  id: string; turnId: string; role: 'user' | 'assistant' | 'tool' | 'system';
  text: string; createdAt: string;
  toolName?: string; toolUseId?: string; input?: Record<string, unknown>;
  isError?: boolean; parentToolUseId?: string;
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
export interface ChatSnapshot {
  sessionId: string; taskState: TaskState;
  messages: ChatMessage[]; pending: ChatApproval[];
  usage?: ChatUsage; model?: string; permissionMode?: string;
  context?: ContextUsage;
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
}
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
