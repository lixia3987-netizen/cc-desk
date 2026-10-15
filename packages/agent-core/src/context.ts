import type { JsonObject, JsonValue, ModelContext, RunBudget } from './types.js'

/** 在具备无损维护策略之前，含图像的历史记录必须保持完整。 */
export function contextHasUserImages(context: ModelContext): boolean {
  return context.items.some(item => item !== null && typeof item === 'object' && !Array.isArray(item) && item.role === 'user' &&
    Array.isArray(item.content) && item.content.some(part => part !== null && typeof part === 'object' && !Array.isArray(part) &&
      ['input_image', 'image_url', 'image'].includes((part as JsonObject).type as string)))
}

export interface ContextBudgetUsage {
  estimatedInputTokens: number
  maxInputTokens: number
  contextBytes: number
  maxContextBytes: number
  estimator: 'utf8_bytes'
  status: 'within_budget' | 'near_limit' | 'exceeded'
}

export interface ContextInputEstimate {
  /** 用于预算的保守值；候选 tokenizer 不能在未校准时降低安全上限。 */
  estimatedInputTokens: number
  serializedBytes: number
  contextBytes: number
  method: 'utf8_bytes' | 'tokenizer' | 'calibrated'
  source: 'fallback' | 'tokenizer' | 'calibration'
  confidence: 'conservative'
  model?: string
  provenance?: string
  candidateInputTokens?: number
  fallbackReason?: 'not_configured' | 'model_mismatch' | 'protocol_mismatch' | 'invalid_estimate' | 'estimator_failed'
  components: { historyBytes: number; instructionBytes: number; toolDefinitionBytes: number; protocolStateBytes: number; imageBytes: number }
}

/** 绑定精确模型和协议的离线候选估算器；来源必须可追溯，不在此处猜测模型族。 */
export interface ContextInputEstimator {
  model: string
  protocol: ModelContext['protocol']
  method: 'tokenizer' | 'calibrated'
  provenance: string
  estimate(serializedInput: string): number
}

const bytes = (value: string): number => new TextEncoder().encode(value).byteLength
const object = (value: unknown): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value)

/** 分类只统计传输字节，不把图片或加密续接状态伪装成精确 token 数。 */
function nonTextBytes(value: unknown): { imageBytes: number; protocolStateBytes: number } {
  if (Array.isArray(value)) return value.reduce((total, item) => {
    const part = nonTextBytes(item)
    return { imageBytes: total.imageBytes + part.imageBytes, protocolStateBytes: total.protocolStateBytes + part.protocolStateBytes }
  }, { imageBytes: 0, protocolStateBytes: 0 })
  if (!object(value)) return { imageBytes: 0, protocolStateBytes: 0 }
  if (['input_image', 'image_url', 'image', 'output_image'].includes(String(value.type))) return { imageBytes: bytes(JSON.stringify(value)), protocolStateBytes: 0 }
  if (['reasoning', 'thinking', 'redacted_thinking'].includes(String(value.type))) return { imageBytes: 0, protocolStateBytes: bytes(JSON.stringify(value)) }
  return nonTextBytes(Object.values(value))
}

/**
 * 详细估算用于来源展示、离线误差比较及后续校准。默认仍为一字节一 token。
 * 未完成真实模型校准前，候选计数只能提高预算检查值，不能降低原来的保守边界。
 * serializedInput 可传入适配器实际发送的完整 payload；图片和协议状态继续计入字节上限。
 */
export function estimateContextInput(context: ModelContext, options: {
  instructions?: string; toolDefinitions?: JsonValue; model?: string; serializedInput?: string; estimator?: ContextInputEstimator
} = {}): ContextInputEstimate {
  const history = JSON.stringify(context.items), instructions = options.instructions ?? ''
  const tools = options.toolDefinitions === undefined ? '' : JSON.stringify(options.toolDefinitions)
  const serialized = options.serializedInput ?? history + instructions + tools
  const classified = nonTextBytes(context.items)
  const result: ContextInputEstimate = {
    estimatedInputTokens: bytes(serialized), serializedBytes: bytes(serialized), contextBytes: bytes(JSON.stringify(context)),
    method: 'utf8_bytes', source: 'fallback', confidence: 'conservative',
    ...(options.model === undefined ? {} : { model: options.model }),
    components: { historyBytes: bytes(history), instructionBytes: bytes(instructions), toolDefinitionBytes: bytes(tools),
      protocolStateBytes: classified.protocolStateBytes + (context.continuation === undefined ? 0 : bytes(JSON.stringify(context.continuation))), imageBytes: classified.imageBytes },
  }
  const estimator = options.estimator
  if (!estimator) { result.fallbackReason = 'not_configured'; return result }
  if (!options.model || estimator.model !== options.model) { result.fallbackReason = 'model_mismatch'; return result }
  if (!estimator.protocol || estimator.protocol.id !== context.protocol.id || estimator.protocol.version !== context.protocol.version) { result.fallbackReason = 'protocol_mismatch'; return result }
  if (typeof estimator.provenance !== 'string' || !estimator.provenance.trim() || !['tokenizer', 'calibrated'].includes(estimator.method)
    || typeof estimator.estimate !== 'function') { result.fallbackReason = 'invalid_estimate'; return result }
  try {
    const candidate = estimator.estimate(serialized)
    if (!Number.isSafeInteger(candidate) || candidate < 0 || candidate === 0 && serialized.length > 0) { result.fallbackReason = 'invalid_estimate'; return result }
    result.candidateInputTokens = candidate
    result.estimatedInputTokens = Math.max(result.estimatedInputTokens, candidate)
    result.method = estimator.method
    result.source = estimator.method === 'tokenizer' ? 'tokenizer' : 'calibration'
    result.provenance = estimator.provenance
    return result
  } catch { result.fallbackReason = 'estimator_failed'; return result }
}

/** usage 缺失时返回 unknown；误差记录不等于真实模型通过或节省费用。 */
export function compareContextEstimate(estimate: ContextInputEstimate, actualInputTokens: number | null | undefined):
  { status: 'unknown' } | { status: 'measured'; estimatedInputTokens: number; actualInputTokens: number; difference: number; relativeError: number | null; underestimated: boolean } {
  if (actualInputTokens === null || actualInputTokens === undefined) return { status: 'unknown' }
  if (!Number.isSafeInteger(actualInputTokens) || actualInputTokens < 0) throw new Error('Invalid measured input usage')
  const estimatedInputTokens = estimate.candidateInputTokens ?? estimate.estimatedInputTokens
  if (!Number.isSafeInteger(estimatedInputTokens) || estimatedInputTokens < 0) throw new Error('Invalid context estimate')
  const difference = estimatedInputTokens - actualInputTokens
  return { status: 'measured', estimatedInputTokens, actualInputTokens, difference,
    relativeError: actualInputTokens === 0 ? null : difference / actualInputTokens, underestimated: difference < 0 }
}

/** 对历史记录和指令作保守的本地估算，不代表提供方计费量或模型上下文窗口。 */
export function estimateContextInputTokens(context: ModelContext, instructions = ''): number {
  return new TextEncoder().encode(JSON.stringify(context.items) + instructions).byteLength
}

/** 使用与运行时请求前检查相同的完整上下文字节边界。 */
export function contextBudgetUsage(context: ModelContext, estimate: number | ContextInputEstimate, budget: Pick<RunBudget, 'maxInputTokens' | 'maxContextBytes'>): ContextBudgetUsage {
  if (typeof estimate !== 'number' && (!Number.isSafeInteger(estimate.serializedBytes) || estimate.serializedBytes < 0)) throw new Error('Invalid context byte estimate')
  const estimatedInputTokens = typeof estimate === 'number' ? estimate : Math.max(estimate.estimatedInputTokens, estimate.serializedBytes)
  if (!Number.isFinite(estimatedInputTokens) || estimatedInputTokens < 0) throw new Error('Invalid context estimate')
  for (const limit of [budget.maxInputTokens, budget.maxContextBytes]) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid context budget')
  }
  // 持久化上下文与实际 payload 各自守住字节上限；低估的 token 值不能绕过它。
  const contextBytes = Math.max(bytes(JSON.stringify(context)), typeof estimate === 'number' ? 0 : estimate.serializedBytes)
  if (!Number.isSafeInteger(contextBytes) || contextBytes < 0) throw new Error('Invalid context byte estimate')
  const ratio = Math.max(estimatedInputTokens / budget.maxInputTokens, contextBytes / budget.maxContextBytes)
  return { estimatedInputTokens, maxInputTokens: budget.maxInputTokens, contextBytes, maxContextBytes: budget.maxContextBytes, estimator: 'utf8_bytes', status: ratio > 1 ? 'exceeded' : ratio >= 0.9 ? 'near_limit' : 'within_budget' }
}
