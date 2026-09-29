/** Protocol items are preserved as JSON, never reduced to display text. */
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
export interface Usage { inputTokens?: number; outputTokens?: number; totalTokens?: number }
export interface RunResult {
  identity: RunIdentity
  status: RunStatus
  reason: string
  modelRequests: number
  toolCalls: number
  usage: Usage | null
  context: ModelContext
  /** False means persistence failed; the host must retain a recovery barrier. */
  committed: boolean
  /** Durable run outcome remains authoritative; host must repair failed display projection. */
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
}
export interface ModelResponse {
  /** Complete, ordered provider output, including reasoning/continuation items. */
  outputItems: JsonValue[]
  toolCalls: ToolCall[]
  continuation?: JsonValue
  finishReason: 'completed' | 'tool_calls' | 'refused' | 'incomplete'
  usage: Usage | null
}
/** Sanitized transport classification; never contains provider text, URLs or headers. */
export interface ModelFailureDiagnostic {
  category: 'authentication' | 'configuration' | 'rate_limit' | 'service_unavailable' | 'service_error' | 'protocol' | 'network' | 'timeout' | 'security' | 'unknown'
  httpStatus?: number
  retryable: boolean
}
export interface ToolResult {
  status: 'completed' | 'failed' | 'denied' | 'cancelled' | 'not_executed' | 'unknown'
  output: JsonValue
  truncated?: boolean
  /** Actual changes/exit status; stored with the bounded model output. */
  effects?: JsonValue
}
/** Host-validated local image; remote URLs and file references are not accepted. */
export interface UserImage { mimeType: 'image/png' | 'image/jpeg'; dataUrl: string }
export interface ModelPort {
  readonly protocol: ProtocolVersion
  userItems(input: string, images?: UserImage[]): JsonValue[]
  toolResultItems(call: ToolCall, result: ToolResult): JsonValue[]
  estimateInputTokens(context: ModelContext): number
  generate(request: ModelRequest): Promise<ModelResponse>
  /** Classify only trusted adapter errors; unrecognized errors must be unknown. */
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
  /** Host schema validation must succeed before returning this value. */
  input: JsonObject
  inputDigest: string
  policyRevision: string
  requiresApproval: boolean
  /** File versions, scoped instruction hashes and directory ownership proof. */
  preconditions: JsonValue
}
export interface ToolPort {
  readonly definitions: ToolDefinition[]
  prepare(call: ToolCall, context: ToolExecutionContext): Promise<PreparedTool>
  /** Recheck exact input, ownership, instruction revisions and file versions after approval. */
  validate(prepared: PreparedTool, context: ToolExecutionContext): Promise<void>
  /** Ordinary tools settle after resource release. An explicit host-owned command handle may
   * outlive its start call; the host must settle it before run completion. Throw/unknown
   * after preparation is uncertain and never authorizes automatic replay. */
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
  | { type: 'model_request_started'; attempt: number }
  | { type: 'model_request_failed'; attempt: number; failure: ModelFailureDiagnostic; partial: boolean; retryDelayMs?: number }
  | { type: 'model_response'; response: ModelResponse }
  | { type: 'tool_prepared'; prepared: PreparedTool; approval?: ApprovalDecision }
  | { type: 'tool_completed'; call: ToolCall; result: ToolResult; resultItems: JsonValue[] }
  | { type: 'run_finished'; result: RunResult }
export interface RunStore {
  /** Atomically claim requestId/payload and append userItems; accepted context includes them. */
  beginRun(request: BeginRunRequest): Promise<BeginRunResult>
  /** Resolves only after durable commit. A rejected append must never be assumed committed. */
  append(identity: RunIdentity, event: RunJournalEvent): Promise<{ seq: number }>
  /** Reserve enough storage before any side effect; do not silently prune history. */
  ensureCapacity(identity: RunIdentity, bytes: number): Promise<void>
  /** Durable snapshot of committed events; a failure blocks subsequent execution. */
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
  /** Epoch milliseconds, shared with the approval/tool host; must not move backwards within a run. */
  now(): number
  /** Stable cryptographic digest supplied by the host; input is canonical JSON. */
  digest(input: string): string | Promise<string>
  /** Parent cancellation and deadline cancellation must both abort the returned signal. */
  deadline(timeoutMs: number, parent: AbortSignal): Deadline
  /** Cancellable backoff. Without this capability automatic retries stay disabled. */
  wait?(milliseconds: number, signal: AbortSignal): Promise<void>
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
  /** Default off. Retry at most two explicitly transient HTTP failures per run. */
  modelRetry?: 'off' | 'safe_transient'
}
export interface ContextMaintenanceRequest {
  identity: RunIdentity
  /** Complete durable model/tool boundary; the host must verify its own journal. */
  context: ModelContext
  budget: RunBudget
  /** Requests already consumed before the prospective maintenance request. */
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
  /** At most one model-only request. A replacement must already be durably committed.
   * Unchanged/failed confirm the original context remains authoritative; throw when
   * commit or cleanup is uncertain. Never replay tools or reuse an approval. */
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
