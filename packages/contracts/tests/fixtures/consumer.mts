import { getSessionIdentity, type SessionExecution, type SessionStatus, type TerminalChunk } from '@cc-desk/contracts/execution';
import type { ChatApproval, ChatDecision, ChatSnapshot, ChatTurnResult } from '@cc-desk/contracts/chat';
import type { ChatJournalEvent, ExecutionEvent } from '@cc-desk/contracts/execution-events';
import type { EngineConfig } from '@cc-desk/contracts/execution';
import type { StructuredExecutor, ExecutionLifecycle, TerminalSnapshot } from '@cc-desk/contracts/execution-ports';

export function configureProvider(executor: StructuredExecutor, sessionId: string, config: EngineConfig): Promise<void> {
  return executor.updateConfig(sessionId, config);
}
export function countResources(executor: ExecutionLifecycle, terminal: TerminalSnapshot) { return { count: executor.activeCount, status: terminal.status }; }

// 宿主可以创建执行事件，无需导入桌面端的 Session 类型。
export function hostEvent(session: { id: string; execution: SessionExecution; status: SessionStatus }): ExecutionEvent {
  return { type: 'session.changed', identity: getSessionIdentity(session), status: session.status };
}

// 视图可以投影聊天、审批及终端数据，无需依赖 DOM 或 Node 类型。
export function viewState(snapshot: ChatSnapshot, approval: ChatApproval, decision: ChatDecision, chunk: TerminalChunk) {
  const resolved: ChatJournalEvent = { type: 'approval_resolved', requestId: approval.requestId, decision };
  const result: ChatTurnResult = { success: !snapshot.error, summary: snapshot.messages.at(-1)?.text ?? '' };
  return { result, resolved, messages: snapshot.messages, queued: snapshot.queue?.items, terminalText: chunk.data };
}

export type { NativeTaskSnapshot, NativeTaskUpdate } from '@cc-desk/contracts/native-task';

export type { NativeChangeSetPreview, NativeChangeSetResult } from '@cc-desk/contracts/native-changes';
export type { NativeCommandLifecycleEvent, NativeCommandResult } from '@cc-desk/contracts/native-commands';
import type { SkillDescriptor, NativeSkillsSettings } from '@cc-desk/contracts/native-skills';
