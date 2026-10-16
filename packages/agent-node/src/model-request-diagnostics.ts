import { createHash } from 'node:crypto'
import type { JsonObject, JsonValue, ModelAdapterDiagnostic, ModelDiagnosticComponent, ModelFailureProtocol, ModelInputMeasurement, ModelRequest } from '@cc-desk/agent-core'

const object = (value: unknown): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value)
const digest = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')
const measure = (value: string, accounting: ModelInputMeasurement['accounting'], count?: number): ModelInputMeasurement => ({
  bytes: Buffer.byteLength(value, 'utf8'), digest: digest(value), accounting, ...(count === undefined ? {} : { count }),
})

/** 保留诊断持久化的原始错误，不允许传输分类将其改写。 */
export class ModelRequestDiagnosticError extends Error {
  constructor(readonly original: unknown) { super('Model request diagnostic failed') }
}

/** fetch 已调用后才确认派发；持久化失败时中止并收回已经启动的传输。 */
export async function dispatchedModelResponse(request: ModelRequest, protocol: ModelFailureProtocol, model: string,
  controller: AbortController, pendingResponse: Promise<Response>): Promise<Response> {
  // 在等待日志之前接住 fetch 的拒绝，避免快速网络失败产生未处理的 Promise。
  const settled = pendingResponse.then(value => ({ status: 'fulfilled', value }) as const,
    reason => ({ status: 'rejected', reason }) as const)
  try { await request.onRequestDiagnostic?.({ phase: 'dispatched', protocol, model, startedAt: Date.now() }) }
  catch (error) {
    controller.abort()
    const completion = await settled
    if (completion.status === 'fulfilled') {
      try { await completion.value.body?.cancel() } catch { /* 已中止的响应可能已关闭。 */ }
    }
    throw new ModelRequestDiagnosticError(error)
  }
  const completion = await settled
  if (completion.status === 'rejected') throw completion.reason
  return completion.value
}

/** 字节与摘要来自已校验的实际发送正文；诊断绝不保存正文、URL 或请求头。 */
export function modelRequestDiagnostic(request: ModelRequest, body: string, protocol: ModelFailureProtocol, hasChatInstructions = false, model?: string): ModelAdapterDiagnostic {
  const payload = JSON.parse(body) as JsonObject
  const components: Partial<Record<ModelDiagnosticComponent, ModelInputMeasurement>> = {}
  const spans: Array<{ start: number; end: number }> = []
  let cursor = 1
  for (const [key, value] of Object.entries(payload)) {
    const serialized = JSON.stringify(value), start = cursor + JSON.stringify(key).length + 1
    const take = (name: ModelDiagnosticComponent, offset = 0, length = serialized.length, count?: number): void => {
      components[name] = measure(serialized.slice(offset, offset + length), 'serialized', count)
      spans.push({ start: start + offset, end: start + offset + length })
    }
    if (key === 'instructions' || key === 'system') take('instructions')
    else if (key === 'tools') take('tools', 0, serialized.length, Array.isArray(value) ? value.length : undefined)
    else if (key === 'input' || key === 'messages') {
      if (key === 'messages' && hasChatInstructions && Array.isArray(value)) {
        const instruction = JSON.stringify(value[0])
        take('instructions', 1, instruction.length, 1)
        const offset = 1 + instruction.length + (value.length > 1 ? 1 : 0)
        take('history', offset, serialized.length - offset - 1, value.length - 1)
      } else take('history', 0, serialized.length, Array.isArray(value) ? value.length : undefined)
    }
    cursor = start + serialized.length + 1
  }
  spans.sort((left, right) => left.start - right.start)
  let residual = '', previous = 0
  for (const span of spans) { residual += body.slice(previous, span.start); previous = span.end }
  residual += body.slice(previous)
  components.transport = measure(residual, 'serialized')

  // 以下分类可相互重叠，只作为逻辑视图；不能加到实际传输字节总量中。
  const groups: Partial<Record<ModelDiagnosticComponent, JsonValue[]>> = {}
  const visit = (value: JsonValue): void => {
    if (Array.isArray(value)) { value.forEach(visit); return }
    if (!object(value)) return
    const add = (name: ModelDiagnosticComponent): void => { (groups[name] ??= []).push(value) }
    if (value.role === 'user') add('userInput')
    if (value.role === 'tool' || ['function_call_output', 'tool_result'].includes(String(value.type))) add('toolResults')
    if (['reasoning', 'thinking', 'redacted_thinking'].includes(String(value.type))) add('reasoning')
    if (['input_image', 'image_url', 'image'].includes(String(value.type))) add('images')
    Object.values(value).forEach(visit)
  }
  request.context.items.forEach(visit)
  if (request.context.continuation !== undefined) groups.continuation = [request.context.continuation]
  for (const [name, values] of Object.entries(groups)) components[name as ModelDiagnosticComponent] = measure(JSON.stringify(values), 'logical', values!.length)
  for (const name of ['systemPrompt', 'permissions', 'projectRules', 'skills'] as const) {
    const section = request.diagnosticInstructionSections?.[name]
    if (section !== undefined) components[name] = measure(section, 'logical')
  }
  return { phase: 'request', protocol, ...(model === undefined ? {} : { model }),
    payloadBytes: Buffer.byteLength(body, 'utf8'), payloadDigest: digest(body), components, startedAt: Date.now() }
}
