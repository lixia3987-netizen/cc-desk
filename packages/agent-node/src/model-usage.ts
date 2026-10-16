import type { JsonObject, JsonValue, ProviderUsage, Usage } from '@cc-desk/agent-core'

const object = (value: unknown): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value)
const count = (value: JsonValue | undefined): number | null => {
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid model usage count')
  return value
}
const details = (value: JsonValue | undefined): JsonObject => {
  if (value === undefined || value === null) return {}
  if (!object(value)) throw new Error('Invalid model usage details')
  return value
}
const preserve = (raw: ProviderUsage['raw'], key: string, value: JsonValue | undefined): void => {
  if (value !== undefined) raw[key] = count(value)
}
export interface NormalizedModelUsage { usage: Usage | null; providerUsage: ProviderUsage | null }

/** OpenAI 输入计数已包含缓存；缓存读取不能再次叠加到输入总量。 */
export function normalizeOpenAIUsage(value: JsonValue | undefined, protocol: 'responses' | 'chat'): NormalizedModelUsage {
  if (value === undefined || value === null) return { usage: null, providerUsage: null }
  if (!object(value)) throw new Error('Invalid model usage record')
  const inputName = protocol === 'responses' ? 'input_tokens' : 'prompt_tokens'
  const outputName = protocol === 'responses' ? 'output_tokens' : 'completion_tokens'
  const inputDetails = details(value[`${inputName}_details`]), outputDetails = details(value[`${outputName}_details`])
  const raw: ProviderUsage['raw'] = {}
  for (const key of [inputName, outputName, 'total_tokens']) preserve(raw, key, value[key])
  preserve(raw, 'cached_tokens', inputDetails.cached_tokens)
  preserve(raw, 'cache_write_tokens', inputDetails.cache_write_tokens)
  preserve(raw, 'input_audio_tokens', inputDetails.audio_tokens)
  preserve(raw, 'output_audio_tokens', outputDetails.audio_tokens)
  for (const key of ['reasoning_tokens', 'accepted_prediction_tokens', 'rejected_prediction_tokens']) preserve(raw, key, outputDetails[key])
  const input = count(value[inputName]), output = count(value[outputName]), total = count(value.total_tokens)
  const cached = count(inputDetails.cached_tokens), creation = count(inputDetails.cache_write_tokens)
  const cacheSum = (cached ?? 0) + (creation ?? 0)
  if (!Number.isSafeInteger(cacheSum) || input !== null && cacheSum > input) throw new Error('Invalid model cache usage count')
  // 缓存读取和写入都是输入总量的子集；任一缺失时不把普通输入推算成已知值。
  const usage: Usage = { cacheReadInputTokens: cached, cacheCreationInputTokens: creation,
    nonCachedInputTokens: input !== null && cached !== null && creation !== null ? input - cacheSum : null }
  if (input !== null) usage.inputTokens = input
  if (output !== null) usage.outputTokens = output
  // 原始总量始终保留；与已知输入、输出矛盾时不把它归一化为可靠总量。
  if (total !== null && (input === null || output === null || total === input + output)) usage.totalTokens = total
  return { usage: Object.values(raw).some(value => value !== null) ? usage : null,
    providerUsage: { raw, normalization: 'openai-inclusive-input' } }
}

/** 只保留固定计数字段，不把提供方文本或任意字段名写入诊断。 */
export function anthropicRawUsage(value: JsonValue | undefined): ProviderUsage['raw'] {
  if (value === undefined || value === null) return {}
  if (!object(value)) throw new Error('Invalid model usage record')
  const raw: ProviderUsage['raw'] = {}
  for (const key of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) preserve(raw, key, value[key])
  const creation = details(value.cache_creation)
  preserve(raw, 'cache_creation_5m_input_tokens', creation.ephemeral_5m_input_tokens)
  preserve(raw, 'cache_creation_1h_input_tokens', creation.ephemeral_1h_input_tokens)
  return raw
}

/** Anthropic input_tokens 仅表示非缓存输入；只有三项都已知才形成完整输入总量。 */
export function normalizeAnthropicUsage(raw: ProviderUsage['raw']): NormalizedModelUsage {
  const nonCached = raw.input_tokens ?? null, read = raw.cache_read_input_tokens ?? null, creation = raw.cache_creation_input_tokens ?? null
  const usage: Usage = { nonCachedInputTokens: nonCached, cacheReadInputTokens: read, cacheCreationInputTokens: creation }
  if (raw.output_tokens !== undefined && raw.output_tokens !== null) usage.outputTokens = raw.output_tokens
  if (nonCached !== null && read !== null && creation !== null) {
    const input = nonCached + read + creation
    if (!Number.isSafeInteger(input)) throw new Error('Invalid model usage count')
    usage.inputTokens = input
    if (usage.outputTokens !== undefined) {
      const total = input + usage.outputTokens
      if (!Number.isSafeInteger(total)) throw new Error('Invalid model usage count')
      usage.totalTokens = total
    }
  }
  return { usage: Object.values(raw).some(value => value !== null) ? usage : null,
    providerUsage: Object.keys(raw).length ? { raw: { ...raw }, normalization: 'anthropic-input-plus-cache' } : null }
}
