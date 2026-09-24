import type { ChatApproval, ChatTurnResult } from '../../../shared/chat';
import type { ClaudeCommand } from '../../../shared/claude-session';
import type { AssistantStream } from './assistant-stream';
import type { ClaudeConnection } from './connection';

interface Turn { id: string; resolve: (value: ChatTurnResult) => void; interrupted: boolean; command?: string; resetRequested?: boolean; resetApplied?: boolean }

export interface Entry {
  connection: ClaudeConnection; initialized: boolean;
  expectedId: string; enforceIdentity: boolean; bypassEnabled: boolean;
  turn?: Turn; approvals: Map<string, ChatApproval>;
  assistant: AssistantStream; resultIds: Set<string>; tools: Set<string>; tasks: Set<string>;
  subtaskTools: Map<string, { foreground: boolean; parent?: string }>;
  approvalTasks: Map<string, string>;
  finishedTasks: Set<string>;
  backgroundTaskTools: Map<string, string>;
  interruptTimer?: NodeJS.Timeout;
  waitingBackgroundResult?: boolean; backgroundTimer?: NodeJS.Timeout;
  commands?: ClaudeCommand[];
  /** Actual API identity observed in this process, never a /context label. */
  requestModel?: string;
  contextRequest?: { id: string; usage: Record<string, unknown> };
}
