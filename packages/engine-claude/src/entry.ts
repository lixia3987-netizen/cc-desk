import type { ChatApproval, ChatTurnResult } from '@cc-desk/contracts/chat';
import type { ClaudeCommand } from './claude-session.js';
import type { AssistantStream } from './assistant-stream.js';
import type { ClaudeConnection } from './connection.js';

interface Turn {
  id: string; resolve: (value: ChatTurnResult) => void; interrupted: boolean;
  command?: string; resetRequested?: boolean; resetApplied?: boolean;
  /** Fixed when this turn is dispatched or its first model metadata arrives. */
  contextModel?: string;
  configuredModel?: string;
}

export interface Entry {
  connection: ClaudeConnection; initialized: boolean;
  expectedId: string; enforceIdentity: boolean; bypassEnabled: boolean;
  turn?: Turn; approvals: Map<string, ChatApproval>;
  /** Public approval tokens never reuse provider request IDs across runs or sessions. */
  approvalRequests: Map<string, string>;
  assistant: AssistantStream; resultIds: Set<string>; tools: Set<string>; tasks: Set<string>;
  subtaskTools: Map<string, { foreground: boolean; parent?: string }>;
  approvalTasks: Map<string, string>;
  finishedTasks: Set<string>;
  backgroundTaskTools: Map<string, string>;
  interruptTimer?: NodeJS.Timeout;
  waitingBackgroundResult?: boolean; backgroundTimer?: NodeJS.Timeout;
  commands?: ClaudeCommand[];
  /** CLI selection for the next turn; never replaced by an assistant response model. */
  selectionModel?: string;
  contextRequest?: { id: string; usage: Record<string, unknown> };
}
