import { getSessionIdentity, type SessionExecution, type SessionStatus, type TerminalChunk } from '@cc-desk/contracts/execution';
import type { ChatApproval, ChatDecision, ChatSnapshot, ChatTurnResult } from '@cc-desk/contracts/chat';
import type { ChatJournalEvent, ExecutionEvent } from '@cc-desk/contracts/execution-events';

// A host can create execution events without importing the desktop Session type.
export function hostEvent(session: { id: string; execution: SessionExecution; status: SessionStatus }): ExecutionEvent {
  return { type: 'session.changed', identity: getSessionIdentity(session), status: session.status };
}

// A view can project chat, approvals and terminal data without DOM or Node types.
export function viewState(snapshot: ChatSnapshot, approval: ChatApproval, decision: ChatDecision, chunk: TerminalChunk) {
  const resolved: ChatJournalEvent = { type: 'approval_resolved', requestId: approval.requestId, decision };
  const result: ChatTurnResult = { success: !snapshot.error, summary: snapshot.messages.at(-1)?.text ?? '' };
  return { result, resolved, messages: snapshot.messages, queued: snapshot.queue?.items, terminalText: chunk.data };
}
