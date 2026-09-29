import type { ChatApproval, ChatTurnResult } from '../../../shared/chat';
import type { ClaudeCommand } from '../../../shared/claude-session';
import type { AssistantStream } from './assistant-stream';
import type { ClaudeConnection } from './connection';

export type ContextObservationSource = 'assistant' | 'message_start' | 'message_delta';

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
  contextRequest?: {
    id: string; usage: Record<string, unknown>;
    /** A stream start owns this message boundary, including before usage arrives. */
    streamed?: boolean;
    /** Input components reported by deltas take precedence over envelopes. */
    deltaFields?: string[];
  };
}
