/** State of a turn, independent of the lifetime of the CLI process. */
export type TaskState = 'idle' | 'starting' | 'thinking' | 'tool_running' | 'waiting_approval' | 'waiting_input' | 'completed' | 'interrupted' | 'error';
export interface ChatMessage {
  id: string; turnId: string; role: 'user' | 'assistant' | 'tool' | 'system';
  text: string; createdAt: string;
  toolName?: string; toolUseId?: string; input?: Record<string, unknown>;
  isError?: boolean; parentToolUseId?: string;
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
  mcpServers?: { name: string; status: string }[];
  error?: string; truncated?: boolean;
}
export interface ChatTurnResult { success: boolean; summary: string; error?: string; interrupted?: boolean }
