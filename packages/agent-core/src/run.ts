import type {
  AgentPorts, AgentRunRequest, ApprovalBinding, ApprovalDecision, JsonObject, JsonValue,
  ContextMaintenanceResult, ModelFailureDiagnostic, ModelResponse, PreparedTool, RunBudget, RunIdentity, RunJournalEvent,
  RunResult, RunStatus, ToolCall, ToolExecutionContext, ToolResult, Usage,
} from './types.js'
import { contextBudgetUsage } from './context.js'
import { validateModelFailureDiagnostic } from './recovery.js'

export const DEFAULT_RUN_BUDGET: Readonly<RunBudget> = Object.freeze({
  maxModelRequests: 30,
  maxToolCalls: 60,
  maxActiveMs: 10 * 60_000,
  approvalTimeoutMs: 5 * 60_000,
  maxToolOutputBytes: 64 * 1024,
  maxContextBytes: 8 * 1024 * 1024,
  maxInputTokens: 100_000,
  maxOutputTokens: 16_384,
})

/** Shared exact-input representation for approvals and durable submission identity. */
export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Non-finite JSON number')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value !== 'object') throw new Error('Non-JSON value')
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
}

export class RunAlreadyActiveError extends Error {
  readonly code = 'run_already_active'
  constructor(readonly identity: RunIdentity) { super('This submission already has an active run'); this.name = 'RunAlreadyActiveError' }
}

class Stop extends Error {
  constructor(readonly status: RunStatus, readonly reason: string) { super(reason) }
}
class PersistenceFailure extends Error {
  constructor(readonly operation: string) { super(operation) }
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const byteLength = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength
const isObject = (value: JsonValue): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value)

function checkBudget(budget: RunBudget): void {
  for (const [name, value] of Object.entries(budget)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid run budget: ${name}`)
  }
}

function sameBinding(a: ApprovalBinding, b: ApprovalBinding): boolean {
  return a.sessionId === b.sessionId && a.conversationId === b.conversationId &&
    a.runId === b.runId && a.requestId === b.requestId && a.workerGeneration === b.workerGeneration &&
    a.toolCallId === b.toolCallId && a.inputDigest === b.inputDigest && a.policyRevision === b.policyRevision
}

/** Sequential, framework-free loop. Host promises own durable storage and resource release. */
export async function runAgent(request: AgentRunRequest, ports: AgentPorts): Promise<RunResult> {
  const { model, tools, store, approvals, host } = ports
  const budget: RunBudget = { ...DEFAULT_RUN_BUDGET, ...request.budget }
  checkBudget(budget)
  if (request.modelRetry !== undefined && !['off', 'safe_transient'].includes(request.modelRetry)) throw new Error('Invalid model retry policy')
  const identity = clone(request.identity)
  const userItems = clone(model.userItems(request.input))
  const configuration = clone(request.configuration)
  const inputDigest = await host.digest(canonicalJson({
    input: request.input, userItems, protocol: { ...model.protocol }, configuration, policyRevision: request.policyRevision,
  }))
  // Admission failures and active duplicates do not manufacture a new run/terminal event.
  const admission = await store.beginRun({
    identity, input: request.input, inputDigest, userItems, protocol: clone(model.protocol),
    configuration, policyRevision: request.policyRevision,
  })
  if (admission.kind === 'duplicate') {
    if (admission.result) return clone(admission.result)
    throw new RunAlreadyActiveError(admission.identity)
  }
  let context = clone(admission.context)
  let modelRequests = 0
  let modelAttempt = 0
  let modelRetries = 0
  let toolCalls = 0
  let usage: Usage | null = null
  let usageUnknown = false
  let maintenanceAttempted = false
  let pausedMs = 0
  const startedAt = host.now()
  let pending: ToolCall[] = []
  let uncommittedSideEffect = false
  let projectionFailure = false
  const emitted: Promise<void>[] = []
  const seenToolCallIds = new Set<string>()
  const deniedInputs = new Set<string>()
  let batchResults: { call: ToolCall; result: ToolResult }[] = []
  let lastStalledBatch: string | undefined
  let stalledBatches = 0
  const activeMs = (): number => Math.max(0, host.now() - startedAt - pausedMs)
  const makeResult = (status: RunStatus, reason: string, committed: boolean): RunResult => ({
    identity, status, reason, modelRequests, toolCalls, usage: usageUnknown ? null : usage,
    context: clone(context), committed,
  })
  const append = async (event: RunJournalEvent): Promise<void> => {
    try { await store.append(identity, clone(event)) } catch { throw new PersistenceFailure(event.type) }
  }
  const checkpoint = async (): Promise<void> => {
    try { await store.checkpoint(identity, clone(context)) } catch { throw new PersistenceFailure('checkpoint') }
  }
  const capacity = async (bytes: number): Promise<void> => {
    try { await store.ensureCapacity(identity, bytes) } catch { throw new PersistenceFailure('capacity') }
  }
  const emit = (event: Parameters<typeof host.emit>[0]): void => {
    try {
      emitted.push(Promise.resolve(host.emit(clone(event))).catch(() => { projectionFailure = true }))
    } catch { projectionFailure = true }
  }
  const flushEvents = async (): Promise<void> => {
    await Promise.all(emitted.splice(0))
    if (projectionFailure) throw new Stop('failed', 'projection_failed')
  }
  const checkStopped = (): void => {
    if (request.signal.aborted) throw new Stop('cancelled', 'cancelled')
    if (activeMs() >= budget.maxActiveMs) throw new Stop('budget_exhausted', 'active_time_budget')
  }
  const activeOperation = async <T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    checkStopped()
    const deadline = host.deadline(Math.max(1, budget.maxActiveMs - activeMs()), request.signal)
    try { return await operation(deadline.signal) } finally { deadline.dispose() }
  }
  const toolContext = (signal: AbortSignal): ToolExecutionContext => ({
    identity, policyRevision: request.policyRevision, signal, maxOutputBytes: budget.maxToolOutputBytes,
  })
  const completeTool = async (call: ToolCall, result: ToolResult, project = true): Promise<void> => {
    if (result.status === 'unknown') throw new Stop('recovery_required', 'tool_result_unknown')
    // Never silently replace a returned result with a lossy summary in the context.
    if (byteLength(result.output) > budget.maxToolOutputBytes) {
      throw new Stop('recovery_required', 'tool_output_limit_violated')
    }
    const resultItems = clone(model.toolResultItems(clone(call), clone(result)))
    if (resultItems.length === 0) throw new Stop('recovery_required', 'tool_result_encoding_failed')
    await append({ type: 'tool_completed', call, result, resultItems })
    if (project) batchResults.push({ call: clone(call), result: clone(result) })
    uncommittedSideEffect = false
    context.items.push(...resultItems)
    pending.shift()
    await checkpoint()
    if (project) {
      emit({ type: 'tool_result', identity, call, result })
      await flushEvents()
    }
  }
  const endPending = async (status: 'cancelled' | 'not_executed', reason: string): Promise<void> => {
    while (pending.length) {
      await completeTool(pending[0], { status, output: { error: reason, executed: false } }, false)
    }
  }
  const accumulateUsage = (next: Usage | null): void => {
    if (!next) { usageUnknown = true; return }
    const previous = usage
    const total: Usage = {}
    for (const key of ['inputTokens', 'outputTokens', 'totalTokens'] as const) {
      const n = next[key]
      if (n !== undefined && Number.isFinite(n) && n >= 0 && (!previous || previous[key] !== undefined)) {
        total[key] = (previous?.[key] ?? 0) + n
      }
    }
    usage = total
  }
  const maintainContext = async (): Promise<void> => {
    if (!ports.contextMaintenance || maintenanceAttempted || modelRequests === 0 ||
      budget.maxModelRequests - modelRequests < 2) return
    // This is called only between complete model/tool batches. Reserve one
    // request before the host can contact a model, retaining a continuation slot.
    const previousRequests = modelRequests++
    let maintained: ContextMaintenanceResult
    try {
      maintained = clone(await activeOperation((signal) => ports.contextMaintenance!.maintain({
        identity: clone(identity), context: clone(context), budget: clone(budget),
        modelRequests: previousRequests, toolCalls,
        remainingActiveMs: Math.max(1, budget.maxActiveMs - activeMs()), signal,
      })))
      if (!maintained || !['unchanged', 'compacted', 'failed'].includes(maintained.kind) ||
        ![0, 1].includes(maintained.modelRequests) || maintained.modelRequests === 0 && maintained.usage !== null ||
        maintained.kind === 'unchanged' && maintained.modelRequests !== 0 ||
        maintained.usage !== null && (typeof maintained.usage !== 'object' || Array.isArray(maintained.usage) ||
          Object.entries(maintained.usage).some(([key, value]) => !['inputTokens', 'outputTokens', 'totalTokens'].includes(key) || !Number.isSafeInteger(value) || value < 0))) {
        throw new Error('Invalid context maintenance result')
      }
      if (maintained.kind === 'compacted' && (maintained.modelRequests !== 1 || !maintained.context ||
        maintained.context.protocol?.id !== model.protocol.id || maintained.context.protocol?.version !== model.protocol.version ||
        !Array.isArray(maintained.context.items) || byteLength(maintained.context) >= byteLength(context))) {
        throw new Error('Invalid compacted context')
      }
      if (maintained.kind === 'failed' && !['context_maintenance_failed', 'context_maintenance_unhelpful'].includes(maintained.reason)) {
        throw new Error('Invalid context maintenance failure')
      }
    } catch (error) {
      if (error instanceof Stop) { modelRequests--; throw error }
      // The host may have committed a replacement without acknowledging it. Do
      // not checkpoint the old context, retry the summary, or run another tool.
      maintenanceAttempted = true
      usageUnknown = true
      throw new PersistenceFailure('context_maintenance')
    }
    if (maintained.modelRequests === 0) modelRequests--
    else {
      maintenanceAttempted = true
      accumulateUsage(maintained.usage)
    }
    if (maintained.kind === 'compacted') {
      context = clone(maintained.context)
      await checkpoint()
    }
    checkStopped()
    if (maintained.kind === 'failed') throw new Stop('failed', maintained.reason)
  }
  const finish = async (status: RunStatus, reason: string): Promise<RunResult> => {
    await checkpoint()
    const result = makeResult(status, reason, true)
    await append({ type: 'run_finished', result })
    emit({ type: 'run_finished', identity, result })
    // A terminal projection failure cannot rewrite the already committed outcome or replay it.
    await Promise.all(emitted.splice(0))
    if (projectionFailure) result.projectionError = 'projection_failed'
    return result
  }
  const recordResponse = async (response: ModelResponse): Promise<void> => {
    await capacity(byteLength(response) + 4096)
    await append({ type: 'model_response', response })
    context.items.push(...clone(response.outputItems))
    if (response.continuation !== undefined) context.continuation = clone(response.continuation)
    else delete context.continuation
    pending = clone(response.toolCalls)
    await checkpoint()
  }
  const requestModel = async (): Promise<ModelResponse> => {
    while (true) {
      checkStopped()
      if (modelRequests >= budget.maxModelRequests) throw new Stop('budget_exhausted', 'model_request_budget')
      await capacity(8192)
      checkStopped()
      // Reserve before append: an acknowledgement may be lost after a durable
      // attempt. Never turn that uncertainty into another paid request.
      modelRequests++
      const attempt = ++modelAttempt
      await append({ type: 'model_request_started', attempt })
      let acceptingEvents = true
      let partial = false
      try {
        return clone(await activeOperation((signal) => model.generate({
          identity, context: clone(context), tools: clone(tools.definitions), maxOutputTokens: budget.maxOutputTokens,
          signal, onEvent(event) {
            if (acceptingEvents && !signal.aborted) { partial = true; emit({ ...event, identity }) }
          },
        })))
      } catch (error) {
        acceptingEvents = false
        // A rejected request may have been billed. Unknown usage must not be
        // presented as a free retry or as an exact aggregate token/cost total.
        usageUnknown = true
        let failure: ModelFailureDiagnostic = { category: 'unknown', retryable: false }
        try {
          const classified = error instanceof Stop ? undefined : model.classifyError?.(error)
          if (validateModelFailureDiagnostic(classified)) failure = clone(classified)
        } catch { /* Adapter classification never exposes arbitrary errors. */ }
        const eligible = request.modelRetry === 'safe_transient' && !!host.wait && failure.retryable && !partial
        const delay = modelRetries === 0 ? 500 : 1500
        const retryDelayMs = eligible && modelRetries < 2 && modelRequests < budget.maxModelRequests &&
          !request.signal.aborted && budget.maxActiveMs - activeMs() > delay ? delay : undefined
        await append({ type: 'model_request_failed', attempt, failure, partial, ...(retryDelayMs === undefined ? {} : { retryDelayMs }) })
        await flushEvents()
        checkStopped()
        if (retryDelayMs !== undefined) {
          modelRetries++
          try { await activeOperation(signal => host.wait!(retryDelayMs, signal)) }
          catch { checkStopped(); throw new Stop('failed', 'model_retry_wait_failed') }
          checkStopped()
          continue
        }
        if (eligible && modelRetries >= 2) throw new Stop('failed', 'model_retry_exhausted')
        if (eligible && modelRequests >= budget.maxModelRequests) throw new Stop('budget_exhausted', 'model_request_budget')
        if (eligible && budget.maxActiveMs - activeMs() <= delay) throw new Stop('budget_exhausted', 'active_time_budget')
        throw new Stop('failed', `model_${failure.category}`)
      } finally { acceptingEvents = false }
    }
  }
  const checkProgress = async (): Promise<void> => {
    // Assess only complete, durable batches. Polling a host command can be
    // useful even when a sample has not changed; it is not a stalled task.
    const failed = batchResults.length > 0 && batchResults.every(item => ['failed', 'denied'].includes(item.result.status))
    const repeatedRead = batchResults.length > 0 && batchResults.every(item => item.result.status === 'completed' &&
      tools.definitions.find(definition => definition.name === item.call.name)?.risk === 'read' &&
      !['command_status', 'read_command_output'].includes(item.call.name))
    if (!failed && !repeatedRead) { lastStalledBatch = undefined; stalledBatches = 0; return }
    const fingerprint = await host.digest(canonicalJson(batchResults.map(({ call, result }) => {
      let input: JsonValue = call.arguments
      try { input = JSON.parse(call.arguments) as JsonValue } catch { /* Invalid input is itself a stable failure. */ }
      return { name: call.name, input, result: result as unknown as JsonValue }
    })))
    stalledBatches = fingerprint === lastStalledBatch ? stalledBatches + 1 : 1
    lastStalledBatch = fingerprint
    if (stalledBatches >= 3) throw new Stop('failed', failed ? 'tool_failure_repeated' : 'tool_no_progress')
  }
  const validatePrepared = async (prepared: PreparedTool, call: ToolCall, input: JsonObject): Promise<void> => {
    const definition = tools.definitions.find((item) => item.name === call.name)
    if (!definition || canonicalJson(prepared.call as unknown as JsonValue) !== canonicalJson(call as unknown as JsonValue) ||
      canonicalJson(prepared.input) !== canonicalJson(input) || prepared.definition.name !== call.name ||
      prepared.definition.risk !== definition.risk || prepared.policyRevision !== request.policyRevision ||
      prepared.inputDigest !== await host.digest(canonicalJson(input))) {
      throw new Error('Invalid prepared tool binding')
    }
  }
  const executeCall = async (call: ToolCall): Promise<void> => {
    checkStopped()
    if (toolCalls >= budget.maxToolCalls) throw new Stop('budget_exhausted', 'tool_call_budget')
    toolCalls++
    let prepared: PreparedTool
    try {
      const input: JsonValue = JSON.parse(call.arguments)
      if (!isObject(input)) throw new Error('Tool arguments must be a JSON object')
      if (!tools.definitions.some((definition) => definition.name === call.name)) throw new Error('Unknown tool')
      prepared = clone(await activeOperation((signal) => tools.prepare(clone(call), toolContext(signal))))
      await validatePrepared(prepared, call, input)
    } catch {
      checkStopped()
      await completeTool(call, { status: 'failed', output: { error: 'invalid_tool_input', executed: false } })
      return
    }
    checkStopped()
    let approval: ApprovalDecision | undefined
    if (prepared.requiresApproval || prepared.definition.risk !== 'read') {
      const approvalKey = `${call.name}:${prepared.inputDigest}`
      if (deniedInputs.has(approvalKey)) {
        await completeTool(call, { status: 'denied', output: { error: 'approval_previously_denied', executed: false } })
        return
      }
      const binding: ApprovalBinding = { ...identity, toolCallId: call.id, inputDigest: prepared.inputDigest, policyRevision: prepared.policyRevision }
      const pauseStart = host.now()
      const expiresAt = pauseStart + budget.approvalTimeoutMs
      const deadline = host.deadline(budget.approvalTimeoutMs, request.signal)
      try {
        approval = clone(await approvals.request({
          binding, tool: prepared.definition, input: prepared.input, preconditions: prepared.preconditions, expiresAt,
        }, deadline.signal))
      } catch {
        if (request.signal.aborted) throw new Stop('cancelled', 'cancelled')
        deniedInputs.add(approvalKey)
        await completeTool(call, { status: 'denied', output: { error: 'approval_expired_or_failed', executed: false } })
        return
      } finally {
        pausedMs += Math.max(0, host.now() - pauseStart)
        deadline.dispose()
      }
      checkStopped()
      if (!sameBinding(approval.binding, binding) || approval.expiresAt > expiresAt || approval.expiresAt <= host.now() || approval.decision !== 'approved') {
        deniedInputs.add(approvalKey)
        await completeTool(call, { status: 'denied', output: { error: 'approval_denied_or_invalid', executed: false } })
        return
      }
    }
    try {
      await activeOperation((signal) => tools.validate(clone(prepared), toolContext(signal)))
    } catch {
      checkStopped()
      await completeTool(call, { status: 'failed', output: { error: 'tool_preconditions_changed', executed: false } })
      return
    }
    checkStopped()
    // Reserve bounded result + protocol envelope/checkpoint before writing a prepared marker.
    await capacity(budget.maxToolOutputBytes * 3 + byteLength(prepared) + byteLength(context) + 8192)
    checkStopped()
    if (approval && approval.expiresAt <= host.now()) {
      await completeTool(call, { status: 'denied', output: { error: 'approval_expired', executed: false } })
      return
    }
    await append({ type: 'tool_prepared', prepared, ...(approval ? { approval } : {}) })
    checkStopped()
    uncommittedSideEffect = prepared.definition.risk !== 'read'
    let result: ToolResult
    try {
      result = clone(await activeOperation((signal) => tools.execute(clone(prepared), toolContext(signal), approval)))
    } catch {
      if (uncommittedSideEffect) throw new Stop('recovery_required', 'tool_execution_outcome_unknown')
      result = { status: request.signal.aborted ? 'cancelled' : 'failed', output: { error: 'tool_execution_failed' } }
    }
    await completeTool(call, result)
    checkStopped()
  }

  try {
    if (context.protocol.id !== model.protocol.id || context.protocol.version !== model.protocol.version) {
      throw new Stop('recovery_required', 'protocol_context_mismatch')
    }
    await checkpoint()
    while (true) {
      checkStopped()
      if (modelRequests >= budget.maxModelRequests) throw new Stop('budget_exhausted', 'model_request_budget')
      let estimatedTokens = model.estimateInputTokens(clone(context))
      if (Number.isFinite(estimatedTokens) && estimatedTokens >= 0 &&
        contextBudgetUsage(context, estimatedTokens, budget).status !== 'within_budget') {
        await maintainContext()
        estimatedTokens = model.estimateInputTokens(clone(context))
      }
      if (!Number.isFinite(estimatedTokens) || estimatedTokens < 0 || contextBudgetUsage(context, estimatedTokens, budget).status === 'exceeded') {
        throw new Stop('budget_exhausted', 'context_budget')
      }
      const response = await requestModel()
      accumulateUsage(response.usage)
      // No tool may run before the complete response and continuation are durable.
      await recordResponse(response)
      await flushEvents()
      checkStopped()
      for (const call of response.toolCalls) {
        if (!call.id || seenToolCallIds.has(call.id)) throw new Stop('recovery_required', 'invalid_tool_call_identity')
        seenToolCallIds.add(call.id)
      }
      if (response.finishReason === 'refused' || response.finishReason === 'incomplete') {
        await endPending('not_executed', `model_${response.finishReason}`)
        throw new Stop('failed', `model_${response.finishReason}`)
      }
      if (response.toolCalls.length === 0) {
        if (response.finishReason === 'tool_calls') throw new Stop('failed', 'model_tool_calls_missing')
        return await finish('completed', 'model_completed')
      }
      batchResults = []
      while (pending.length) await executeCall(pending[0])
      await checkProgress()
    }
  } catch (error) {
    if (error instanceof PersistenceFailure) return makeResult('recovery_required', `store_${error.operation}_failed`, false)
    const stop = error instanceof Stop ? error : new Stop(uncommittedSideEffect ? 'recovery_required' : 'failed', 'core_operation_failed')
    try {
      if (stop.status !== 'recovery_required' && !uncommittedSideEffect) {
        await endPending(stop.status === 'cancelled' ? 'cancelled' : 'not_executed', stop.reason)
      }
      return await finish(stop.status, stop.reason)
    } catch (finishError) {
      const reason = finishError instanceof PersistenceFailure ? `store_${finishError.operation}_failed` : 'terminal_commit_failed'
      return makeResult('recovery_required', reason, false)
    }
  }
}
