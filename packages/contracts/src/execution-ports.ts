import type { NativeImageAttachment, ChatAttention, ChatDecision, ChatPage, ChatPageOptions, ChatSearchPage, ChatSnapshot, ChatTurnResult, TaskState } from './chat.js';
import type { EngineConfig, SessionStatus, TerminalChunk } from './execution.js';
export interface TerminalSnapshot { chunks: TerminalChunk[]; status: SessionStatus }

/** 资源的归属一直保持到整个进程树及其句柄均已释放。 */
export interface ExecutionLifecycle {
  readonly activeCount: number;
  has(id: string): boolean;
  isBusy(id: string): boolean;
  interrupt(id: string): void | Promise<void>;
  stop(id: string): void | Promise<void>;
  /** 请求停止，并且仅在进程、流、工具及持久化处理全部结束后完成。 */
  stopAndWait?(id: string): Promise<void>;
  /** 只等待物理资源，绝不等待队列或工作流的确认责任释放。 */
  whenReleased?(id: string): Promise<void>;
  /** 持久化的不确定影响及清理隔离状态，在应用重启后仍然保留。 */
  recoveryRequired?(id: string): boolean;
  /** 父任务恢复屏障保护的其他保留子工作区。 */
  recoveryDirectories?(id: string): Promise<readonly string[]>;
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

/** 稳定的来源身份在派发及确认重试后保持不变。 */
export interface NativeExecutionPolicy {
  toolPolicy: 'read_only' | 'standard';
  budget?: { maxModelRequests: number; maxToolCalls: number; maxActiveMs: number };
  parent?: { sessionId: string; runId: string; taskId: string; depth: number };
}
export interface ExecutionSubmission {
  requestId: string;
  /** 用户的显式选择，绝不根据模型文本或队列位置推断。 */
  nativeTaskId?: string;
  /** 接受排队请求时捕获的、由宿主绑定的图像选择。 */
  imageAttachments?: NativeImageAttachment[];
  source?: 'direct' | 'queue' | 'workflow';
  workflowRunId?: string;
  stageId?: string;
  attempt?: number;
  /** 由宿主强制执行的工作流及委派限制，纳入持久化请求身份。 */
  nativeExecutionPolicy?: NativeExecutionPolicy;
}

export interface StructuredExecutor extends ExecutionLifecycle {
  /** 可选的优雅中断屏障；路由器会安全关闭旧执行器。 */
  interruptAndWait?(id: string): Promise<void>;
  /** 原始提供商对话记录不可用时，由用户显式触发恢复。 */
  recoverContext?(id: string): Promise<void>;
  taskState(id: string): TaskState;
  hydrate(id: string): Promise<void>;
  snapshot(id: string): ChatSnapshot;
  /** 被动显示历史，不恢复执行器、不取得写入锁，也不执行工作区核查。 */
  readDisplay?(id: string, options?: ChatPageOptions): Promise<ChatPage>;
  page(id: string, options?: ChatPageOptions): Promise<ChatPage>;
  search(id: string, query: string, before?: string): Promise<ChatSearchPage>;
  attention(): ChatAttention[];
  send(id: string, text: string, attachments?: string[], titlePrompt?: string, submission?: ExecutionSubmission): Promise<ChatTurnResult>;
  prepareCommands(id: string): Promise<ChatSnapshot>;
  respond(id: string, requestId: string, decision: ChatDecision): void | Promise<void>;
  /** 通过宿主持久化每项已确认的配置变更；部分失败不得将其撤销。 */
  updateConfig(id: string, config: EngineConfig): Promise<void>;
  /** 只读取并刷新已完成 Native 阶段回执绑定的任务，绝不执行工具。 */
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
