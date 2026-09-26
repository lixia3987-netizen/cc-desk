import type {
  AgentPorts, AgentRunRequest, ApprovalBinding, ApprovalDecision, JsonObject, JsonValue,
  ModelResponse, PreparedTool, RunBudget, RunIdentity, RunJournalEvent,
  RunResult, RunStatus, ToolCall, ToolExecutionContext, ToolResult, Usage,
} from './types.js'

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
  let toolCalls = 0
  let usage: Usage | null = null
  let usageUnknown = false
  let pausedMs = 0
  const startedAt = host.now()
  let pending: ToolCall[] = []
  let uncommittedSideEffect = false
  let projectionFailure = false
  const emitted: Promise<void>[] = []
  const seenToolCallIds = new Set<string>()
  const deniedInputs = new Set<string>()
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
      const estimatedTokens = model.estimateInputTokens(clone(context))
      if (!Number.isFinite(estimatedTokens) || estimatedTokens < 0 || estimatedTokens > budget.maxInputTokens || byteLength(context) > budget.maxContextBytes) {
        throw new Stop('budget_exhausted', 'context_budget')
      }
      modelRequests++
      let response: ModelResponse
      let acceptingEvents = true
      try {
        response = clone(await activeOperation((signal) => model.generate({
          identity, context: clone(context), tools: clone(tools.definitions), maxOutputTokens: budget.maxOutputTokens,
          signal, onEvent(event) { if (acceptingEvents && !signal.aborted) emit({ ...event, identity }) },
        })))
      } catch {
        checkStopped()
        throw new Stop('failed', 'model_request_failed')
      } finally { acceptingEvents = false }
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
      while (pending.length) await executeCall(pending[0])
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
