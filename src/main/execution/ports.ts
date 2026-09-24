import type { ChatAttention, ChatDecision, ChatPage, ChatPageOptions, ChatSearchPage, ChatSnapshot, ChatTurnResult, TaskState } from '../../shared/chat';
import type { ExecutionCapabilities, ExecutionMode, SessionExecution } from '../../shared/execution';
import type { Effort, PermissionMode, Session, TerminalSnapshot } from '../../shared/types';

/** Resource ownership lasts until the whole process tree and its handles are released. */
export interface ExecutionLifecycle {
  readonly activeCount: number;
  has(id: string): boolean;
  isBusy(id: string): boolean;
  interrupt(id: string): void | Promise<void>;
  stop(id: string): void | Promise<void>;
  stopIdle(id: string): Promise<void>;
  forget(id: string): void;
  setMaintenance(value: boolean): void;
  disconnectAll(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface SessionExport {
  label: string;
  extension: 'jsonl' | 'txt';
  suffix?: string;
  write(destination: string): Promise<void>;
}

export interface StructuredExecutor extends ExecutionLifecycle {
  /** Optional graceful-interrupt barrier; routers safely close older executors. */
  interruptAndWait?(id: string): Promise<void>;
  taskState(id: string): TaskState;
  hydrate(id: string): Promise<void>;
  snapshot(id: string): ChatSnapshot;
  page(id: string, options?: ChatPageOptions): Promise<ChatPage>;
  search(id: string, query: string, before?: string): Promise<ChatSearchPage>;
  attention(): ChatAttention[];
  send(id: string, text: string, attachments?: string[], titlePrompt?: string): Promise<ChatTurnResult>;
  prepareCommands(id: string): Promise<ChatSnapshot>;
  respond(id: string, requestId: string, decision: ChatDecision): void | Promise<void>;
  updateConfig(id: string, config: {model?: string; effort?: Effort; permissionMode?: PermissionMode}): Promise<void>;
  exports(id: string): Promise<SessionExport[]>;
}

export interface TerminalExecutor extends ExecutionLifecycle {
  start(id: string): Promise<void>;
  write(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
  snapshot(id: string): TerminalSnapshot;
  exports(id: string): Promise<SessionExport[]>;
}

interface RegistrationBase {
  providerId: string;
  capabilities(): ExecutionCapabilities;
  /** Provider-specific identity validation belongs to its adapter. */
  validateSession?(session: Session): void;
  createIdentity?(input: { conversationId?: string; fork?: boolean }): SessionExecution;
}
export type ExecutionRegistration = RegistrationBase & (
  | { mode: Extract<ExecutionMode, 'structured'>; executor: StructuredExecutor }
  | { mode: Extract<ExecutionMode, 'terminal'>; executor: TerminalExecutor }
);
