import type { ChatMessage, ChatPage, ChatPageOptions, ChatSearchPage, ChatSnapshot } from '@cc-desk/contracts/chat';
import type { ChatJournalEvent } from '@cc-desk/contracts/execution-events';
import type { ClaudeCapabilities, ClaudeSession, ClaudeSessionPatch, Subtask, SubtaskObservation } from './types.js';

export interface ClaudeSessions {
  get(id: string): ClaudeSession | undefined;
  /** 同步且原子地提交。已确认配置补丁与当前存储值合并；失败必须抛出。 */
  update(id: string, patch: ClaudeSessionPatch): void;
}
export interface ClaudeHistory {
  /** 受控的可变投影：在被显式替换前，重复读取始终保留引用。 */
  get(id: string): ChatSnapshot;
  getMessage(id: string, messageId: string): ChatMessage | undefined;
  upsertMessage(id: string, message: ChatMessage): void;
  /** 应用有界界面投影前记录完整事件，关键写入失败必须抛出。 */
  append(id: string, event: ChatJournalEvent): void;
  changed(id: string): void;
  /** 完成交互轮次及释放归属责任前使用的持久化屏障；错误必须向上传播。 */
  flush(): void;
  delete(id: string): void;
  exportPath(id: string): string;
}
export interface ClaudeArchive {
  page(id: string, snapshot: ChatSnapshot, options?: ChatPageOptions): Promise<ChatPage>;
  search(id: string, snapshot: ChatSnapshot, query: string, before?: string): Promise<ChatSearchPage>;
  forget(id: string): void;
}
export interface ClaudeSubtasks {
  begin(id: string, turnId: string): void;
  observe(id: string, observation: SubtaskObservation): Subtask | undefined;
  end(id: string, status: 'interrupted' | 'failed' | 'unknown', reason?: string): void;
}
export interface ClaudeLaunchHost {
  environment(): Record<string, string>;
  invocation(env: Record<string, string>): { file: string; prefix: string[] };
}
/** 宿主管理的辅助作业可能在前台交互轮次结束后仍占用会话目录。 */
export interface ClaudeMetadata {
  readonly ids: readonly string[];
  has(id: string): boolean;
  assertReleased(id?: string): void;
  /** 仅在清理结束后完成；保留失败信息供 assertReleased 使用。 */
  cancel(id: string): Promise<void>;
  cancelAll(): Promise<void>;
}
export interface ClaudeHost {
  metadata?: ClaudeMetadata;
  sessions: ClaudeSessions;
  /** 延迟投影写入将错误报告给运行时，宿主不能仅记录日志。 */
  conversations(callbacks: { isActive(id: string): boolean; onError(id: string, error: Error): void }): { history: ClaudeHistory; archive: ClaudeArchive };
  subtasks(onState: () => void): ClaudeSubtasks;
  launch: ClaudeLaunchHost;
  maxSessions(): number;
  signalProcessGroup(pid: number, signal: NodeJS.Signals): Promise<void>;
  onState(): void;
  onConversation(id: string): void;
  /** 仅在 CLI 输入管道接受非命令提示词之后调用。 */
  onAcceptedPrompt(id: string, text: string, capabilities: ClaudeCapabilities): void;
}
