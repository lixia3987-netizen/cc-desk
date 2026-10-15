/** 协议项保留为 JSON，绝不简化为显示文本。 */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

export interface ProtocolVersion { id: string; version: number }
export interface ModelContext {
  protocol: ProtocolVersion
  items: JsonValue[]
  continuation?: JsonValue
}
export interface RunIdentity {
  sessionId: string
  conversationId: string
  runId: string
  requestId: string
  workerGeneration: number
}
export type RunStatus = 'completed' | 'cancelled' | 'failed' | 'budget_exhausted' | 'recovery_required'
export interface Usage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  /** 输入总量已经包含缓存；缺失或 null 表示未知，不能补零。 */
  cacheReadInputTokens?: number | null
  cacheCreationInputTokens?: number | null
  nonCachedInputTokens?: number | null
}
export interface ProviderUsage {
  /** 只允许适配器固定的 token 计数字段，不保存提供商响应正文。 */
  raw: Record<string, number | null>
  normalization: 'openai-inclusive-input' | 'anthropic-input-plus-cache'
}
export type ModelDiagnosticComponent = 'systemPrompt' | 'permissions' | 'projectRules' | 'skills' | 'instructions' | 'tools' | 'userInput' | 'history' | 'toolResults' | 'reasoning' | 'continuation' | 'images' | 'transport'
export interface ModelInputMeasurement { bytes: number; digest: string; count?: number; accounting: 'serialized' | 'logical' }
export interface ModelAdapterDiagnostic {
  phase: 'request' | 'dispatched' | 'result'
  protocol: ModelFailureProtocol
  model?: string
  payloadBytes?: number
  payloadDigest?: string
  components?: Partial<Record<ModelDiagnosticComponent, ModelInputMeasurement>>
  startedAt?: number
  finishedAt?: number
  elapsedMs?: number
  result?: 'completed' | 'failed'
  providerUsage?: ProviderUsage | null
  failure?: ModelFailureDiagnostic
}
export interface ModelRequestDiagnostic {
  schemaVersion: 1
  requestKey: string
  identity: RunIdentity
  attempt: number
  purpose: 'normal' | 'child' | 'retry' | 'summary_in_run' | 'summary_before_send' | 'summary_manual'
  parentRunId?: string
  childId?: string
  protocol: ProtocolVersion
  model?: string
  phase: 'started' | 'request' | 'dispatched' | 'finished'
  /** true 仅确认 transport 已调用，不代表提供商已收到或已收费。 */
  requestSent: boolean | null
  startedAt: number
  finishedAt?: number
  elapsedMs?: number
  estimatedInputTokens: number | null
  estimateMethod: 'utf8_bytes' | 'tokenizer' | 'calibrated' | 'unknown'
  estimateSource: 'fallback' | 'tokenizer' | 'calibration' | 'unknown'
  contextBytes: number
  contextDigest: string
  toolsetDigest: string
  components: Partial<Record<ModelDiagnosticComponent, ModelInputMeasurement>>
  payloadBytes?: number
  payloadDigest?: string
  usage: Usage | null
  providerUsage?: ProviderUsage | null
  outcome?: 'completed' | 'failed' | 'cancelled'
  failure?: ModelFailureDiagnostic
}
export interface RunResult {
  identity: RunIdentity
  status: RunStatus
  reason: string
  modelRequests: number
  toolCalls: number
  usage: Usage | null
  context: ModelContext
  /** false 表示持久化失败；宿主必须保留恢复屏障。 */
  committed: boolean
  /** 持久化运行结果仍是权威来源；宿主必须修复失败的显示投影。 */
  projectionError?: string
}
export interface ToolCall { id: string; name: string; arguments: string }
export interface ToolDefinition {
  name: string
  description: string
  inputSchema: JsonObject
  risk: 'read' | 'write' | 'command'
}
export type ModelStreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_arguments_delta'; callId: string; delta: string }
export interface ModelRequest {
  identity: RunIdentity
  context: ModelContext
  tools: ToolDefinition[]
  maxOutputTokens: number
  signal: AbortSignal
  onEvent(event: ModelStreamEvent): void
  /** 发网前必须等待诊断持久化；失败时不继续发送付费请求。 */
  onRequestDiagnostic?(diagnostic: ModelAdapterDiagnostic): void | Promise<void>
  diagnosticInstructionSections?: Partial<Record<'systemPrompt' | 'permissions' | 'projectRules' | 'skills', string>>
}
export interface ModelResponse {
  /** 提供方完整且有序的输出，包含推理和续接项。 */
  outputItems: JsonValue[]
  toolCalls: ToolCall[]
  continuation?: JsonValue
  finishReason: 'completed' | 'tool_calls' | 'refused' | 'incomplete'
  usage: Usage | null
  providerUsage?: ProviderUsage | null
}
/** 经过脱敏的传输分类；绝不包含提供方文本、URL 或请求头。 */
export type ModelFailureProtocol = 'openai-responses' | 'openai-chat-completions' | 'anthropic-messages'
export type ModelFailureStage = 'request' | 'response_headers' | 'message_start' | 'content' | 'thinking' | 'tool_call' | 'completion'
export type ModelFailureReason =
  | 'protocol_mismatch' | 'invalid_history' | 'pending_tool_calls' | 'invalid_json' | 'invalid_event' | 'invalid_sequence'
  | 'unsupported_event' | 'unsupported_content' | 'invalid_thinking' | 'invalid_tool_call' | 'invalid_usage'
  | 'missing_terminal' | 'truncated_event' | 'stream_disconnected' | 'unexpected_content_type' | 'incomplete_response' | 'response_limit'
export interface ModelFailureDiagnostic {
  category: 'authentication' | 'configuration' | 'rate_limit' | 'service_unavailable' | 'service_error' | 'protocol' | 'network' | 'timeout' | 'security' | 'unknown'
  httpStatus?: number
  retryable: boolean
  /** 兼容旧日志的可选字段；仅接受适配器定义的有限取值。 */
  protocol?: ModelFailureProtocol
  stage?: ModelFailureStage
  reason?: ModelFailureReason
}
export interface ToolResult {
  status: 'completed' | 'failed' | 'denied' | 'cancelled' | 'not_executed' | 'unknown'
  output: JsonValue
  truncated?: boolean
  /** 实际变更或退出状态；与限制大小的模型输出一同保存。 */
  effects?: JsonValue
}
/** 经宿主校验的本地图像；不接受远程 URL 和文件引用。 */
export interface UserImage { mimeType: 'image/png' | 'image/jpeg'; dataUrl: string }
export interface ModelPort {
  readonly protocol: ProtocolVersion
  readonly requestDiagnostics?: true
  userItems(input: string, images?: UserImage[]): JsonValue[]
  toolResultItems(call: ToolCall, result: ToolResult): JsonValue[]
  estimateInputTokens(context: ModelContext): number
  estimateInputUsage?(context: ModelContext, maxOutputTokens?: number): import('./context.js').ContextInputEstimate
  generate(request: ModelRequest): Promise<ModelResponse>
  /** 仅分类可信的适配器错误；无法识别的错误必须归为 unknown。 */
  classifyError?(error: unknown): ModelFailureDiagnostic
}
export interface ApprovalBinding extends RunIdentity {
  toolCallId: string
  inputDigest: string
  policyRevision: string
}
export interface ApprovalRequest {
  binding: ApprovalBinding
  tool: ToolDefinition
  input: JsonObject
  preconditions: JsonValue
  expiresAt: number
}
export interface ApprovalDecision {
  binding: ApprovalBinding
  decision: 'approved' | 'denied' | 'expired'
  expiresAt: number
}
export interface ApprovalPort {
  request(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision>
}
export interface ToolExecutionContext {
  identity: RunIdentity
  policyRevision: string
  signal: AbortSignal
  maxOutputBytes: number
}
export interface PreparedTool {
  call: ToolCall
  definition: ToolDefinition
  /** 返回此值之前，必须通过宿主的结构校验。 */
  input: JsonObject
  inputDigest: string
  policyRevision: string
  requiresApproval: boolean
  /** 文件版本、作用域内的指令哈希，以及目录所有权证明。 */
  preconditions: JsonValue
}
export interface ToolPort {
  readonly definitions: ToolDefinition[]
  prepare(call: ToolCall, context: ToolExecutionContext): Promise<PreparedTool>
  /** 审批后重新核对精确输入、所有权、指令修订和文件版本。 */
  validate(prepared: PreparedTool, context: ToolExecutionContext): Promise<void>
  /** 普通工具在释放资源后结束。宿主显式管理的命令句柄可以
   * 在启动调用返回后继续存在；宿主必须在运行完成前将其结束。准备后的异常或 unknown
   * 表示结果不确定，绝不能据此自动重放。 */
  execute(prepared: PreparedTool, context: ToolExecutionContext, approval?: ApprovalDecision): Promise<ToolResult>
}
export interface BeginRunRequest {
  identity: RunIdentity
  input: string
  inputDigest: string
  userItems: JsonValue[]
  protocol: ProtocolVersion
  configuration: JsonObject
  policyRevision: string
}
export type BeginRunResult =
  | { kind: 'accepted'; context: ModelContext }
  | { kind: 'duplicate'; identity: RunIdentity; result?: RunResult }
export type RunJournalEvent =
  | { type: 'model_request_diagnostic'; diagnostic: ModelRequestDiagnostic }
  | { type: 'model_request_started'; attempt: number }
  | { type: 'model_request_failed'; attempt: number; failure: ModelFailureDiagnostic; partial: boolean; retryDelayMs?: number }
  | { type: 'model_response'; response: ModelResponse }
  | { type: 'tool_prepared'; prepared: PreparedTool; approval?: ApprovalDecision }
  | { type: 'tool_completed'; call: ToolCall; result: ToolResult; resultItems: JsonValue[] }
  | { type: 'run_finished'; result: RunResult }
export interface RunStore {
  /** 原子占用 requestId/payload 并追加 userItems；接纳后的上下文包含这些内容。 */
  beginRun(request: BeginRunRequest): Promise<BeginRunResult>
  /** 仅在持久化提交后完成。追加请求被拒绝时，绝不能假定其已提交。 */
  append(identity: RunIdentity, event: RunJournalEvent): Promise<{ seq: number }>
  /** 产生任何副作用之前预留足够存储空间；不得静默裁剪历史记录。 */
  ensureCapacity(identity: RunIdentity, bytes: number): Promise<void>
  /** 已提交事件的持久化快照；失败时阻止后续执行。 */
  checkpoint(identity: RunIdentity, context: ModelContext): Promise<void>
}
export interface RunBudget {
  maxModelRequests: number
  maxToolCalls: number
  maxActiveMs: number
  approvalTimeoutMs: number
  maxToolOutputBytes: number
  maxContextBytes: number
  maxInputTokens: number
  maxOutputTokens: number
}
export type AgentEvent =
  | (ModelStreamEvent & { identity: RunIdentity })
  | { type: 'tool_result'; identity: RunIdentity; call: ToolCall; result: ToolResult }
  | { type: 'run_finished'; identity: RunIdentity; result: RunResult }
export interface Deadline { signal: AbortSignal; dispose(): void }
export interface RuntimeHost {
  /** 可选的宿主协调活跃计时器，排除共享嵌套审批的耗时。now() 仍以实际时间判断过期。 */
  activeNow?(): number
  /** 与审批及工具宿主共用的 Unix 时间戳毫秒值；同一轮运行内不得倒退。 */
  now(): number
  /** 宿主提供的稳定加密摘要；输入为规范 JSON。 */
  digest(input: string): string | Promise<string>
  /** 父级取消和超时取消都必须中止返回的信号。 */
  deadline(timeoutMs: number, parent: AbortSignal): Deadline
  /** 可取消的退避等待。未提供此能力时，自动重试保持禁用。 */
  wait?(milliseconds: number, signal: AbortSignal): Promise<void>
  /** 写入模型请求或工具准备日志之前，预留父级共享额度；false 表示额度耗尽。 */
  consumeBudget?(kind: 'model' | 'tool', identity: RunIdentity): Promise<boolean>
  emit(event: AgentEvent): void | Promise<void>
}
export interface AgentRunRequest {
  identity: RunIdentity
  input: string
  images?: UserImage[]
  configuration: JsonObject
  policyRevision: string
  signal: AbortSignal
  budget?: Partial<RunBudget>
  /** 默认关闭。每轮最多重试两次明确属于暂时性问题的 HTTP 失败。 */
  modelRetry?: 'off' | 'safe_transient'
  diagnosticPurpose?: Exclude<ModelRequestDiagnostic['purpose'], 'retry'>
  diagnosticIdentity?: { parentRunId?: string; childId?: string }
  diagnosticInstructionSections?: Partial<Record<'systemPrompt' | 'permissions' | 'projectRules' | 'skills', string>>
}
export interface ContextMaintenanceRequest {
  identity: RunIdentity
  /** 完整且已持久化的模型及工具执行边界；宿主必须核验自身日志。 */
  context: ModelContext
  budget: RunBudget
  /** 发起本次维护请求之前已消耗的请求数。 */
  modelRequests: number
  toolCalls: number
  remainingActiveMs: number
  signal: AbortSignal
}
export type ContextMaintenanceFailureReason = 'context_maintenance_failed' | 'context_maintenance_unhelpful' | 'context_maintenance_images_unsupported'
export type ContextMaintenanceResult =
  | { kind: 'unchanged'; modelRequests: 0; usage: null }
  | { kind: 'compacted'; modelRequests: 1; usage: Usage | null; context: ModelContext }
  | { kind: 'failed'; modelRequests: 0 | 1; usage: Usage | null; reason: ContextMaintenanceFailureReason }
export interface ContextMaintenancePort {
  /** 最多发起一次仅调用模型的请求。替换内容必须已完成持久化提交。
   * unchanged/failed 确认原上下文仍为权威来源；提交或清理状态
   * 不确定时抛出异常。绝不重放工具或复用审批。 */
  maintain(request: ContextMaintenanceRequest): Promise<ContextMaintenanceResult>
}
export interface AgentPorts {
  model: ModelPort
  tools: ToolPort
  store: RunStore
  approvals: ApprovalPort
  host: RuntimeHost
  contextMaintenance?: ContextMaintenancePort
}
