import type { ChatMessage, ChatPage, ChatPageOptions, ChatSearchPage, ChatSnapshot } from '@cc-desk/contracts/chat';
import type { ChatJournalEvent } from '@cc-desk/contracts/execution-events';
import type { ClaudeSession, ClaudeSessionPatch, Subtask, SubtaskObservation } from './types.js';

export interface ClaudeSessions {
  get(id: string): ClaudeSession | undefined;
  /** Commit synchronously and atomically. Confirmed configuration patches merge with current stored values; failures must throw. */
  update(id: string, patch: ClaudeSessionPatch): void;
}
export interface ClaudeHistory {
  /** A controlled mutable projection: repeated reads preserve references until explicitly replaced. */
  get(id: string): ChatSnapshot;
  getMessage(id: string, messageId: string): ChatMessage | undefined;
  upsertMessage(id: string, message: ChatMessage): void;
  /** Record the complete event before applying a bounded UI projection. Critical write failures throw. */
  append(id: string, event: ChatJournalEvent): void;
  changed(id: string): void;
  /** Durable barrier used before resolving turns and releasing ownership. Errors must propagate. */
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
export interface ClaudeHost {
  sessions: ClaudeSessions;
  /** Delayed projection writes report errors back into the runtime; the host must not merely log them. */
  conversations(callbacks: { isActive(id: string): boolean; onError(id: string, error: Error): void }): { history: ClaudeHistory; archive: ClaudeArchive };
  subtasks(onState: () => void): ClaudeSubtasks;
  launch: ClaudeLaunchHost;
  maxSessions(): number;
  signalProcessGroup(pid: number, signal: NodeJS.Signals): Promise<void>;
  onState(): void;
  onConversation(id: string): void;
  /** Called only after a non-command prompt has been accepted by the CLI input pipe. */
  onAcceptedPrompt(id: string, text: string): void;
}
