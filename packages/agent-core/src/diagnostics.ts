import type { JsonValue, ModelContext, ModelRequestDiagnostic, RuntimeHost, RunIdentity, ToolDefinition } from './types.js'
import { validateModelFailureDiagnostic } from './recovery.js'
import { validateProviderUsage, validateUsage } from './usage.js'

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const hash = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
const id = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_.:/-]{1,1024}$/.test(value)
const keys = (value: Record<string, unknown>, allowed: readonly string[]) => Object.keys(value).every(key => allowed.includes(key))
const componentKeys = ['systemPrompt', 'permissions', 'projectRules', 'skills', 'instructions', 'tools', 'userInput', 'history', 'toolResults', 'reasoning', 'continuation', 'images', 'transport']
/** 严格白名单阻止诊断入口意外保存正文、URL、错误信息或凭据。 */
export function validateModelRequestDiagnostic(value: unknown): value is ModelRequestDiagnostic {
  if (!object(value) || !keys(value, ['schemaVersion', 'requestKey', 'identity', 'attempt', 'purpose', 'parentRunId', 'childId', 'protocol', 'model', 'phase', 'requestSent', 'startedAt', 'finishedAt', 'elapsedMs', 'estimatedInputTokens', 'estimateMethod', 'estimateSource', 'contextBytes', 'contextDigest', 'toolsetDigest', 'components', 'payloadBytes', 'payloadDigest', 'usage', 'providerUsage', 'outcome', 'failure'])) return false
  if (value.schemaVersion !== 1 || !id(value.requestKey) || !integer(value.attempt) || value.attempt < 1 ||
    !['normal', 'child', 'retry', 'summary_in_run', 'summary_before_send', 'summary_manual'].includes(value.purpose as string) ||
    !['started', 'request', 'dispatched', 'finished'].includes(value.phase as string) || ![true, false, null].includes(value.requestSent as boolean | null) ||
    !integer(value.startedAt) || !integer(value.contextBytes) || !hash(value.contextDigest) || !hash(value.toolsetDigest) ||
    value.estimatedInputTokens !== null && !integer(value.estimatedInputTokens) ||
    !['utf8_bytes', 'tokenizer', 'calibrated', 'unknown'].includes(value.estimateMethod as string) ||
    !['fallback', 'tokenizer', 'calibration', 'unknown'].includes(value.estimateSource as string) || !validateUsage(value.usage, true)) return false
  const identity = value.identity
  if (!object(identity) || !keys(identity, ['sessionId', 'conversationId', 'runId', 'requestId', 'workerGeneration']) ||
    !['sessionId', 'conversationId', 'runId', 'requestId'].every(key => id(identity[key])) || !integer(identity.workerGeneration)) return false
  if (!object(value.protocol) || !keys(value.protocol, ['id', 'version']) || !id(value.protocol.id) || !integer(value.protocol.version)) return false
  if ([value.parentRunId, value.childId, value.model].some(item => item !== undefined && !id(item))) return false
  if (value.finishedAt !== undefined && (!integer(value.finishedAt) || value.finishedAt < value.startedAt) ||
    value.elapsedMs !== undefined && (typeof value.elapsedMs !== 'number' || !Number.isFinite(value.elapsedMs) || value.elapsedMs < 0) ||
    value.payloadBytes !== undefined && !integer(value.payloadBytes) || value.payloadDigest !== undefined && !hash(value.payloadDigest) ||
    value.providerUsage !== undefined && !validateProviderUsage(value.providerUsage) ||
    value.outcome !== undefined && !['completed', 'failed', 'cancelled'].includes(value.outcome as string) ||
    value.failure !== undefined && !validateModelFailureDiagnostic(value.failure)) return false
  if (!object(value.components) || !keys(value.components, componentKeys)) return false
  for (const component of Object.values(value.components)) {
    if (!object(component) || !keys(component, ['bytes', 'digest', 'count', 'accounting']) || !integer(component.bytes) || !hash(component.digest) ||
      !['logical', 'serialized'].includes(component.accounting as string) || component.count !== undefined && !integer(component.count)) return false
  }
  return value.phase !== 'finished' || value.finishedAt !== undefined && value.outcome !== undefined
}

export interface DiagnosticStartOptions {
  identity: RunIdentity
  requestKey: string
  attempt: number
  purpose: ModelRequestDiagnostic['purpose']
  context: ModelContext
  tools: readonly ToolDefinition[]
  estimatedInputTokens: number | null
  estimateMethod?: ModelRequestDiagnostic['estimateMethod']
  estimateSource?: ModelRequestDiagnostic['estimateSource']
  parentRunId?: string
  childId?: string
  model?: string
  host: Pick<RuntimeHost, 'now' | 'digest'>
}
/** 只测量 JSON，绝不改写协议块；logical 分项不与 serialized 分项相加。 */
export async function createModelRequestDiagnostic(options: DiagnosticStartOptions): Promise<ModelRequestDiagnostic> {
  const measure = async (value: unknown, count?: number) => {
    const json = JSON.stringify(value)
    return { bytes: new TextEncoder().encode(json).byteLength, digest: await options.host.digest(json), accounting: 'logical' as const, ...(count === undefined ? {} : { count }) }
  }
  const context = await measure(options.context)
  const history = await measure(options.context.items, options.context.items.length)
  const tools = await measure(options.tools, options.tools.length)
  const components: ModelRequestDiagnostic['components'] = { history, tools }
  if (options.context.continuation !== undefined) components.continuation = await measure(options.context.continuation)
  const find = (name: string) => options.context.items.filter(item => object(item) && (item.type === name || item.role === name))
  const reasoning = find('reasoning')
  if (reasoning.length) components.reasoning = await measure(reasoning, reasoning.length)
  const toolResults = [...find('function_call_output'), ...find('tool')]
  if (toolResults.length) components.toolResults = await measure(toolResults, toolResults.length)
  const latestUser = [...options.context.items].reverse().find(item => object(item) && item.role === 'user')
  if (latestUser !== undefined) components.userInput = await measure(latestUser)
  const images: JsonValue[] = []
  const visit = (value: JsonValue): void => {
    if (Array.isArray(value)) { value.forEach(visit); return }
    if (!object(value)) return
    if (['input_image', 'image_url', 'image'].includes(value.type as string)) { images.push(value as JsonValue); return }
    Object.values(value).forEach(item => visit(item as JsonValue))
  }
  options.context.items.forEach(visit)
  if (images.length) components.images = await measure(images, images.length)
  return {
    schemaVersion: 1, requestKey: options.requestKey, identity: options.identity, attempt: options.attempt, purpose: options.purpose,
    ...(options.parentRunId === undefined ? {} : { parentRunId: options.parentRunId }), ...(options.childId === undefined ? {} : { childId: options.childId }),
    ...(options.model === undefined ? {} : { model: options.model }), protocol: options.context.protocol,
    phase: 'started', requestSent: null, startedAt: options.host.now(), estimatedInputTokens: options.estimatedInputTokens,
    estimateMethod: options.estimateMethod ?? 'unknown', estimateSource: options.estimateSource ?? 'unknown',
    contextBytes: context.bytes, contextDigest: context.digest, toolsetDigest: tools.digest, components, usage: null,
  }
}
