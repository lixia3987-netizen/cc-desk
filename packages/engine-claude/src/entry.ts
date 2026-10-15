import type { ChatApproval, ChatTurnResult } from '@cc-desk/contracts/chat';
import type { ClaudeCommand } from './claude-session.js';
import type { AssistantStream } from './assistant-stream.js';
import type { ClaudeConnection } from './connection.js';

export type ContextObservationSource = 'assistant' | 'message_start' | 'message_delta';

interface Turn {
  id: string; resolve: (value: ChatTurnResult) => void; interrupted: boolean;
  command?: string; resetRequested?: boolean; resetApplied?: boolean;
  /** 在本次交互轮次派发时，或首个模型元数据到达时固定。 */
  contextModel?: string;
  configuredModel?: string;
}

export interface Entry {
  connection: ClaudeConnection; initialized: boolean;
  expectedId: string; enforceIdentity: boolean; bypassEnabled: boolean;
  turn?: Turn; approvals: Map<string, ChatApproval>;
  /** 公开审批令牌绝不跨运行或会话复用提供商请求 ID。 */
  approvalRequests: Map<string, string>;
  assistant: AssistantStream; resultIds: Set<string>; tools: Set<string>; tasks: Set<string>;
  subtaskTools: Map<string, { foreground: boolean; parent?: string }>;
  approvalTasks: Map<string, string>;
  finishedTasks: Set<string>;
  backgroundTaskTools: Map<string, string>;
  interruptTimer?: NodeJS.Timeout;
  waitingBackgroundResult?: boolean; backgroundTimer?: NodeJS.Timeout;
  commands?: ClaudeCommand[];
  /** 下一交互轮次的 CLI 选择，绝不被助手响应中的模型替换。 */
  selectionModel?: string;
  contextRequest?: {
    id: string; usage: Record<string, unknown>;
    /** 流开始事件界定此消息边界，在用量到达之前也有效。 */
    streamed?: boolean;
    /** 增量报告的输入组成项优先于封包。 */
    deltaFields?: string[];
  };
}
