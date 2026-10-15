import type { Usage, ProviderUsage } from './types.js'

export const USAGE_FIELDS = ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens', 'nonCachedInputTokens'] as const
const cacheFields = new Set<string>(USAGE_FIELDS.slice(3))
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
export function validateUsage(value: unknown, strictTotals = false): value is Usage | null {
  if (value === null) return true
  if (!object(value) || !Object.entries(value).every(([key, count]) => USAGE_FIELDS.includes(key as typeof USAGE_FIELDS[number]) &&
    (cacheFields.has(key) && count === null || Number.isSafeInteger(count) && (count as number) >= 0))) return false
  if (typeof value.inputTokens === 'number') {
    const partitions = ['cacheReadInputTokens', 'cacheCreationInputTokens', 'nonCachedInputTokens'].map(key => value[key])
    if (partitions.some(count => typeof count === 'number' && count > (value.inputTokens as number))) return false
    const knownTotal = partitions.reduce<number>((sum, count) => sum + (typeof count === 'number' ? count : 0), 0)
    if (knownTotal > value.inputTokens || partitions.every(count => typeof count === 'number') && knownTotal !== value.inputTokens) return false
  }
  if (strictTotals && typeof value.inputTokens === 'number' && typeof value.outputTokens === 'number' && typeof value.totalTokens === 'number' &&
    value.totalTokens !== value.inputTokens + value.outputTokens) return false
  return true
}
/** 任何请求缺少分项时保留未知；输入总量不再叠加缓存。 */
export function sumUsage(values: readonly (Usage | null)[]): Usage | null {
  if (!values.length || values.some(value => !validateUsage(value) || value === null)) return null
  const result: Usage = {}
  for (const key of USAGE_FIELDS) {
    const counts = values.map(value => value?.[key])
    if (counts.every(count => typeof count === 'number' && Number.isSafeInteger(count) && count >= 0)) {
      const total = counts.reduce<number>((sum, count) => sum + (count as number), 0)
      if (Number.isSafeInteger(total)) result[key] = total
      else if (cacheFields.has(key)) result[key as 'cacheReadInputTokens' | 'cacheCreationInputTokens' | 'nonCachedInputTokens'] = null
    } else if (cacheFields.has(key) && counts.some(count => count !== undefined)) result[key as 'cacheReadInputTokens' | 'cacheCreationInputTokens' | 'nonCachedInputTokens'] = null
  }
  return result
}
const rawUsageKeys = new Set(['input_tokens', 'output_tokens', 'total_tokens', 'cached_tokens', 'cache_write_tokens', 'prompt_tokens', 'completion_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'cache_creation_5m_input_tokens', 'cache_creation_1h_input_tokens', 'reasoning_tokens', 'input_audio_tokens', 'output_audio_tokens', 'accepted_prediction_tokens', 'rejected_prediction_tokens'])
export function validateProviderUsage(value: unknown): value is ProviderUsage | null {
  return value === null || object(value) && Object.keys(value).every(key => ['raw', 'normalization'].includes(key)) &&
    ['openai-inclusive-input', 'anthropic-input-plus-cache'].includes(value.normalization as string) && object(value.raw) &&
    Object.entries(value.raw).every(([key, count]) => rawUsageKeys.has(key) && (count === null || Number.isSafeInteger(count) && (count as number) >= 0))
}
