import type { ChatApproval, ChatDecision, ChatMessage, ChatSnapshot, ChatUsage, TaskState } from './chat';
import type { ContextUsage, SessionIdentity } from './execution';
import type { SessionStatus, TerminalChunk } from './types';

/** Durable, provider-neutral chat events. Transport frames and raw protocol data stay inside adapters. */
export type ChatJournalEvent =
  | { type: 'state'; taskState: TaskState; error?: string }
  | { type: 'message'; message: ChatMessage }
  | { type: 'text_delta'; id: string; text: string }
  | { type: 'context'; context: ContextUsage }
  | { type: 'metadata'; model?: string; permissionMode?: string; mcpServers?: ChatSnapshot['mcpServers'] }
  | { type: 'result'; success: boolean; summary: string; error?: string; usage?: ChatUsage }
  | { type: 'conversation_recovered'; previousConversationId: string; conversationId: string }
  | { type: 'approval_requested'; approval: ChatApproval }
  | { type: 'approval_resolved'; requestId: string; decision: ChatDecision };

/** Session-scoped execution events emitted by registered provider adapters. */
export type ExecutionEvent =
  | { type: 'journal'; identity: SessionIdentity; event: ChatJournalEvent }
  | { type: 'conversation.changed'; identity: SessionIdentity; taskState: TaskState }
  | { type: 'session.changed'; identity: SessionIdentity; status: SessionStatus; taskState?: TaskState }
  | { type: 'identity.changed'; identity: SessionIdentity; previous: SessionIdentity }
  | { type: 'terminal.data'; identity: SessionIdentity; chunk: TerminalChunk };
