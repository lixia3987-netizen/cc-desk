import type { JsonObject, ModelContext, RunBudget } from './types.js'

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

/** 对历史记录和指令作保守的本地估算，不代表提供方计费量或模型上下文窗口。 */
export function estimateContextInputTokens(context: ModelContext, instructions = ''): number {
  return new TextEncoder().encode(JSON.stringify(context.items) + instructions).byteLength
}

/** 使用与运行时请求前检查相同的完整上下文字节边界。 */
export function contextBudgetUsage(context: ModelContext, estimatedInputTokens: number, budget: Pick<RunBudget, 'maxInputTokens' | 'maxContextBytes'>): ContextBudgetUsage {
  if (!Number.isFinite(estimatedInputTokens) || estimatedInputTokens < 0) throw new Error('Invalid context estimate')
  for (const limit of [budget.maxInputTokens, budget.maxContextBytes]) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid context budget')
  }
  const contextBytes = new TextEncoder().encode(JSON.stringify(context)).byteLength
  const ratio = Math.max(estimatedInputTokens / budget.maxInputTokens, contextBytes / budget.maxContextBytes)
  return { estimatedInputTokens, maxInputTokens: budget.maxInputTokens, contextBytes, maxContextBytes: budget.maxContextBytes, estimator: 'utf8_bytes', status: ratio > 1 ? 'exceeded' : ratio >= 0.9 ? 'near_limit' : 'within_budget' }
}
