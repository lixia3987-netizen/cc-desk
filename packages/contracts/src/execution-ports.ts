import type { NativeImageAttachment, ChatAttention, ChatDecision, ChatPage, ChatPageOptions, ChatSearchPage, ChatSnapshot, ChatTurnResult, TaskState } from './chat.js';
import type { EngineConfig, SessionStatus, TerminalChunk } from './execution.js';
export interface TerminalSnapshot { chunks: TerminalChunk[]; status: SessionStatus }

/** Resource ownership lasts until the whole process tree and its handles are released. */
export interface ExecutionLifecycle {
  readonly activeCount: number;
  has(id: string): boolean;
  isBusy(id: string): boolean;
  interrupt(id: string): void | Promise<void>;
  stop(id: string): void | Promise<void>;
  /** Request stop and resolve only after processes, streams, tools and persistence settle. */
  stopAndWait?(id: string): Promise<void>;
  /** Physical resources only; never waits for queue/workflow acknowledgement ownership. */
  whenReleased?(id: string): Promise<void>;
  /** Persisted uncertain effects/cleanup quarantine, including after application restart. */
  recoveryRequired?(id: string): boolean;
  stopIdle(id: string): Promise<void>;
  forget(id: string): void;
  setMaintenance(value: boolean): void;
  setSessionMaintenance?(ids: readonly string[], value: boolean): void;
  disconnectSessions?(ids: readonly string[]): Promise<void>;
  disconnectAll(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface SessionExport {
  label: string;
  extension: 'jsonl' | 'txt';
  suffix?: string;
  write(destination: string): Promise<void>;
}

/** Stable source identity survives dispatch/acknowledgement retries. */
export interface NativeExecutionPolicy {
  toolPolicy: 'read_only' | 'standard';
  budget?: { maxModelRequests: number; maxToolCalls: number; maxActiveMs: number };
  parent?: { sessionId: string; runId: string; taskId: string; depth: number };
}
export interface ExecutionSubmission {
  requestId: string;
  /** Explicit user selection; never inferred from model text or queue position. */
  nativeTaskId?: string;
  /** Host-bound image selection captured when the queued request was accepted. */
  imageAttachments?: NativeImageAttachment[];
  source?: 'direct' | 'queue' | 'workflow';
  workflowRunId?: string;
  stageId?: string;
  attempt?: number;
  /** Host-enforced workflow/delegation restrictions, included in the durable request identity. */
  nativeExecutionPolicy?: NativeExecutionPolicy;
}

export interface StructuredExecutor extends ExecutionLifecycle {
  /** Optional graceful-interrupt barrier; routers safely close older executors. */
  interruptAndWait?(id: string): Promise<void>;
  /** Explicit user recovery when the original provider transcript is unavailable. */
  recoverContext?(id: string): Promise<void>;
  taskState(id: string): TaskState;
  hydrate(id: string): Promise<void>;
  snapshot(id: string): ChatSnapshot;
  page(id: string, options?: ChatPageOptions): Promise<ChatPage>;
  search(id: string, query: string, before?: string): Promise<ChatSearchPage>;
  attention(): ChatAttention[];
  send(id: string, text: string, attachments?: string[], titlePrompt?: string, submission?: ExecutionSubmission): Promise<ChatTurnResult>;
  prepareCommands(id: string): Promise<ChatSnapshot>;
  respond(id: string, requestId: string, decision: ChatDecision): void | Promise<void>;
  /** Persist each confirmed configuration change through the host; partial failure must not revert it. */
  updateConfig(id: string, config: EngineConfig): Promise<void>;
  /** Read and refresh exactly the task bound to a completed Native stage receipt. Never executes tools. */
  inspectTaskReceipt?(receipt: import('./native-task.js').NativeExecutionReceipt): Promise<import('./native-task.js').NativeTaskView | undefined>;
  exports(id: string): Promise<SessionExport[]>;
}

export interface TerminalExecutor extends ExecutionLifecycle {
  start(id: string): Promise<void>;
  write(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
  snapshot(id: string): TerminalSnapshot;
  exports(id: string): Promise<SessionExport[]>;
}
