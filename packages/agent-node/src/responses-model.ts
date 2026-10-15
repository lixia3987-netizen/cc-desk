import type { ContextInputEstimate, JsonObject, JsonValue, ModelContext, ModelFailureDiagnostic, ModelFailureReason, ModelFailureStage, ModelPort, ModelRequest, ModelResponse, ModelStreamEvent, ProviderUsage, ToolCall, ToolDefinition, ToolResult, UserImage } from '@cc-desk/agent-core'
import { canonicalJson, estimateContextInput, estimateContextInputTokens, validateUserImages } from '@cc-desk/agent-core'
import { classifyNativeModelFailure, defaultModelFailureReason, describeNativeModelFailure, nativeModelFailureDetails } from './model-failure.js'
import { validateResponsesImageInputs } from './context-maintenance.js'
import { normalizeOpenAIUsage, type NormalizedModelUsage } from './model-usage.js'
import { dispatchedModelResponse, ModelRequestDiagnosticError, modelRequestDiagnostic } from './model-request-diagnostics.js'

export interface ResponsesModelOptions {
  /** API 基础地址通常为 https://api.openai.com/v1。随后追加 /responses。 */
  baseURL: string
  model: string
  apiKey?: string
  instructions?: string
  /** 每次输入估算和请求均包含固定工具目录。默认不提供工具。 */
  toolDefinitions?: readonly ToolDefinition[]
  /** 仅显式启用后，才允许字面形式的回环地址或 localhost 使用 HTTP。 */
  allowLoopbackHttp?: boolean
  timeoutMs?: number
  maxResponseBytes?: number
  maxRequestBytes?: number
}

/** 有意不包含提供方响应体、URL、请求头或原始错误原因。 */
export class ResponsesModelError extends Error {
  constructor(readonly code: string, message: string, readonly httpStatus?: number) {
    super(message)
    this.name = code === 'cancelled' ? 'AbortError' : 'ResponsesModelError'
  }
}

// 仅错误码或状态不能授予重试权限：回调可能抛出
// 任意异常，包括手工构造的适配器错误。
const rejectedHttpRequests = new WeakMap<ResponsesModelError, number>()

const failure = (code: string, message: string, reason: ModelFailureReason | undefined = defaultModelFailureReason(code)): never => {
  const error = new ResponsesModelError(code, message)
  throw reason === undefined ? error : describeNativeModelFailure(error, { reason })
}
const object = (value: unknown): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value)
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const positive = (value: number | undefined, fallback: number, maximum: number): number => {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result <= 0 || result > maximum) failure('configuration', 'Invalid model transport limit.')
  return result
}

/** 有限的 SSE 分帧，接受 CRLF、CR、LF、注释和多行数据。 */
class EventStreamParser {
  private line = ''
  private data: string[] = []
  private event = ''
  private afterCR = false
  constructor(private readonly consume: (data: string, event: string) => void) {}
  push(text: string): void {
    for (const character of text) {
      if (this.afterCR) {
        this.afterCR = false
        if (character === '\n') continue
      }
      if (character === '\r' || character === '\n') {
        this.consumeLine()
        this.afterCR = character === '\r'
      } else this.line += character
    }
  }
  finish(): void {
    // 未终止的事件不属于完整的协议响应。
    if (this.line.length || this.data.length) failure('interrupted', 'The model stream ended inside an event.', 'truncated_event')
  }
  private consumeLine(): void {
    const line = this.line
    this.line = ''
    if (line === '') {
      if (this.data.length) this.consume(this.data.join('\n'), this.event)
      this.data = []
      this.event = ''
      return
    }
    if (line.startsWith(':')) return
    const colon = line.indexOf(':')
    const field = colon < 0 ? line : line.slice(0, colon)
    let value = colon < 0 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'data') this.data.push(value)
    else if (field === 'event') this.event = value
  }
}

function endpoint(baseURL: string, allowLoopbackHttp: boolean): string {
  let url: URL
  try { url = new URL(baseURL) } catch { return failure('configuration', 'Invalid model service URL.') }
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127\.(\d{1,3}\.){2}\d{1,3}$/.test(url.hostname)
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback && allowLoopbackHttp))) {
    return failure('configuration', 'Model service requires HTTPS, or explicitly enabled loopback HTTP, without URL credentials or query parameters.')
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/responses`
  return url.href
}

function usageFrom(value: JsonValue | undefined): NormalizedModelUsage {
  try { return normalizeOpenAIUsage(value, 'responses') }
  catch { return failure('schema', 'Invalid model usage count.', 'invalid_usage') }
}

type ProtectedValues = string | readonly (string | undefined)[] | undefined
const protectedValues = (value: ProtectedValues): string[] => [...new Set((Array.isArray(value) ? value : [value]).filter((item): item is string => typeof item === 'string' && item.length > 0))]
// 扫描所有组合，避免无关私有字段隔开其他一对内容字段
// 中携带的凭据片段。
const contentCredentialGroups = [
  ['text'], ['thinking'], ['signature'], ['data'],
  ['text', 'thinking'], ['text', 'signature'], ['text', 'data'], ['thinking', 'signature'], ['thinking', 'data'], ['signature', 'data'],
  ['text', 'thinking', 'signature'], ['text', 'thinking', 'data'], ['text', 'signature', 'data'], ['thinking', 'signature', 'data'],
  ['text', 'thinking', 'signature', 'data']
]
const contentStrings = (items: JsonObject[], fields: string[]): string => items.flatMap(item => Array.isArray(item.content)
  ? item.content.flatMap(part => object(part) ? fields.flatMap(field => typeof part[field] === 'string' ? [part[field] as string] : []) : []) : []).join('')

/** 模型输入、输出或宿主 RPC 数据出现受保护凭据时，默认拒绝。 */
export function assertNoModelCredential(value: unknown, secrets: ProtectedValues): void {
  const values = protectedValues(secrets)
  if (!values.length) return
  const pending: unknown[] = [value]
  while (pending.length) {
    const current = pending.pop()
    if (typeof current === 'string') {
      if (values.some(secret => current.includes(secret))) failure('credential_echo', 'Model data contained a protected credential.')
      // 函数参数和工具输出是嵌套 JSON 字符串。对密钥进行转义
      // 不得绕过检查，因为这些字符串随后还会被解码。
      if (/^[\s]*[\[{\"]/.test(current)) {
        try { pending.push(JSON.parse(current)) } catch { /* 普通模型文本 */ }
      }
    }
    if (Array.isArray(current)) {
      for (const child of current) pending.push(child)
      const messages = current.filter(item => object(item) && (item.type === 'message' || item.type === undefined && ['user', 'assistant'].includes(item.role as string)))
      if (messages.length) pending.push(...contentCredentialGroups.map(fields => contentStrings(messages as JsonObject[], fields)))
    }
    else if (object(current)) {
      for (const [key, child] of Object.entries(current)) { pending.push(key, child) }
      if ((current.type === 'message' || current.type === undefined && ['user', 'assistant'].includes(current.role as string)) && Array.isArray(current.content)) {
        pending.push(...contentCredentialGroups.map(fields => contentStrings([current], fields)))
      }
    }
  }
}

/** 保留下一段增量到达时可能构成凭据的后缀。 */
export class SafeModelDeltas {
  private pending: ModelStreamEvent[] = []
  private channels = new Map<string, { length: number; safe: number; scanTail: string }>()
  private globalTail = ''
  readonly #secrets: string[]
  readonly #holdLength: number
  constructor(secrets: ProtectedValues, private readonly emit: (event: ModelStreamEvent) => void) {
    this.#secrets = protectedValues(secrets)
    this.#holdLength = Math.max(0, ...this.#secrets.map(secret => secret.length - 1))
  }
  push(event: ModelStreamEvent): void {
    if (!this.#secrets.length) { this.emit(event); return }
    const channel = this.channel(event)
    const state = this.channels.get(channel) ?? { length: 0, safe: 0, scanTail: '' }
    const delta = event.type === 'text_delta' ? event.text : event.delta
    const candidate = state.scanTail + delta
    assertNoModelCredential(candidate, this.#secrets)
    assertNoModelCredential(this.globalTail + delta, this.#secrets)
    this.globalTail = this.#holdLength ? (this.globalTail + delta).slice(-this.#holdLength) : ''
    state.scanTail = this.#holdLength ? candidate.slice(-this.#holdLength) : ''
    state.length += delta.length
    state.safe = Math.max(0, state.length - this.#holdLength)
    this.channels.set(channel, state)
    this.pending.push(event)
    this.flush()
  }
  finish(): void {
    for (const state of this.channels.values()) state.safe = state.length
    this.flush()
  }
  private channel(event: ModelStreamEvent): string { return event.type === 'text_delta' ? 'text' : `arguments:${event.callId}` }
  private flush(): void {
    while (this.pending.length) {
      const event = this.pending[0]
      const state = this.channels.get(this.channel(event))!
      const text = event.type === 'text_delta' ? event.text : event.delta
      if (!state.safe && text.length) break
      const emitted = text.slice(0, state.safe)
      if (emitted) this.emit(event.type === 'text_delta' ? { ...event, text: emitted } : { ...event, delta: emitted })
      state.safe -= emitted.length
      state.length -= emitted.length
      if (emitted.length === text.length) this.pending.shift()
      else {
        this.pending[0] = event.type === 'text_delta' ? { ...event, text: text.slice(emitted.length) } : { ...event, delta: text.slice(emitted.length) }
      }
    }
  }
}

const responsesTools = (tools: readonly ToolDefinition[]): JsonObject[] => tools.map(tool => ({
  type: 'function', name: tool.name, description: tool.description, parameters: tool.inputSchema, strict: false,
}))
const estimateWithTools = (context: ModelContext, instructions: string, toolsJson: string): number => estimateContextInputTokens(context, instructions + toolsJson)

/** 与 ResponsesModel 共用相同的保守 UTF-8 估算，无凭据时也可使用。 */
export function estimateResponsesInputTokens(context: ModelContext, instructions = '', toolDefinitions: readonly ToolDefinition[] = []): number {
  return estimateWithTools(context, instructions, canonicalJson(responsesTools(toolDefinitions)))
}

function completeResponse(response: JsonObject): ModelResponse {
  if (!nonempty(response.id) || response.status !== 'completed' || !Array.isArray(response.output)) {
    return failure('schema', 'Invalid completed model response.')
  }
  const toolCalls: ToolCall[] = []
  const ids = new Set<string>()
  let refused = false
  for (const item of response.output) {
    if (!object(item) || !nonempty(item.type)) return failure('schema', 'Invalid model output item.')
    if (['input_image', 'output_image', 'image_url'].includes(item.type)) return failure('schema', 'Model image output is not supported.')
    if (item.status !== undefined && item.status !== 'completed') return failure('incomplete', 'The model returned an incomplete output item.')
    if (item.type === 'function_call') {
      if (!nonempty(item.call_id) || !nonempty(item.name) || typeof item.arguments !== 'string' || ids.has(item.call_id)) {
        return failure('schema', 'Invalid or duplicate model tool call.', 'invalid_tool_call')
      }
      // 即使函数名称未知或参数字符串格式错误，也保留原内容。
      // 核心先持久化完整响应，再拒绝该调用；
      // 参数增量或提供方名称都不能直接进入 ToolPort 执行。
      ids.add(item.call_id)
      toolCalls.push({ id: item.call_id, name: item.name, arguments: item.arguments })
    } else if (item.type === 'message') {
      if (item.role !== 'assistant' || !Array.isArray(item.content)) return failure('schema', 'Invalid model message.')
      for (const part of item.content) {
        if (!object(part) || !nonempty(part.type)) return failure('schema', 'Invalid model message content.')
        if (['input_image', 'output_image', 'image_url'].includes(part.type)) return failure('schema', 'Model image output is not supported.')
        if (part.type === 'refusal') {
          if (typeof part.refusal !== 'string') return failure('schema', 'Invalid model refusal.')
          refused = true
        }
        if (part.type === 'output_text' && typeof part.text !== 'string') return failure('schema', 'Invalid model text.')
      }
    }
  }
  // 保留所有输出字段，包括未知的无执行语义项、phase、注解和
  // 加密推理。这些字段作为手工输入历史原样重放。
  return {
    outputItems: response.output,
    toolCalls,
    continuation: { responseId: response.id },
    finishReason: refused ? 'refused' : toolCalls.length ? 'tool_calls' : 'completed',
    ...usageFrom(response.usage),
  }
}

export class ResponsesModel implements ModelPort {
  readonly protocol = Object.freeze({ id: 'openai-responses', version: 1 })
  readonly requestDiagnostics = true as const
  readonly #url: string
  readonly #apiKey: string | undefined
  readonly #model: string
  readonly #instructions: string | undefined
  readonly #tools: JsonObject[]
  readonly #toolsJson: string
  readonly #timeoutMs: number
  readonly #maxResponseBytes: number
  readonly #maxRequestBytes: number

  constructor(options: ResponsesModelOptions) {
    this.#url = endpoint(options.baseURL, options.allowLoopbackHttp === true)
    if (!nonempty(options.model) || options.model.length > 200) failure('configuration', 'A valid model ID is required.')
    if (options.apiKey !== undefined && (!nonempty(options.apiKey) || /[\r\n]/.test(options.apiKey))) failure('configuration', 'Invalid model credential.')
    if (new URL(this.#url).protocol === 'https:' && !options.apiKey) failure('credential', 'A model API credential is required.')
    this.#model = options.model
    this.#apiKey = options.apiKey
    this.#instructions = options.instructions
    // 将结构与可变的发现结果分离，并使生成使用的工具目录
    // 与运行循环在任何网络请求前核算预算的目录一致。
    this.#tools = structuredClone(responsesTools(options.toolDefinitions ?? []))
    this.#toolsJson = canonicalJson(this.#tools)
    this.#timeoutMs = positive(options.timeoutMs, 120_000, 600_000)
    this.#maxResponseBytes = positive(options.maxResponseBytes, 8 * 1024 * 1024, 64 * 1024 * 1024)
    this.#maxRequestBytes = positive(options.maxRequestBytes, 8 * 1024 * 1024, 64 * 1024 * 1024)
  }

  userItems(input: string, images: UserImage[] = []): JsonValue[] {
    validateUserImages(images)
    return [{ role: 'user', content: images.length
      ? [{ type: 'input_text', text: input }, ...images.map(image => ({ type: 'input_image', image_url: image.dataUrl, detail: 'auto' }))]
      : input }]
  }

  toolResultItems(call: ToolCall, result: ToolResult): JsonValue[] {
    return [{ type: 'function_call_output', call_id: call.id, output: JSON.stringify(result) }]
  }

  estimateInputTokens(context: ModelContext): number {
    // 保守的 UTF-8 字节估算；绝不代表提供方计费用量。
    return estimateWithTools(context, this.#instructions ?? '', this.#toolsJson)
  }

  estimateInputUsage(context: ModelContext, maxOutputTokens = 4096): ContextInputEstimate {
    return estimateContextInput(context, { instructions: this.#instructions, toolDefinitions: this.#tools, model: this.#model,
      serializedInput: this.requestBody(context, maxOutputTokens) })
  }

  private requestBody(context: ModelContext, maxOutputTokens: number): string {
    return JSON.stringify({ model: this.#model, input: context.items,
      ...(this.#instructions === undefined ? {} : { instructions: this.#instructions }), tools: this.#tools,
      // 执行器逐一处理调用；保留完整协议选项用于字节安全边界。
      parallel_tool_calls: false, store: false, stream: true, include: ['reasoning.encrypted_content'], max_output_tokens: maxOutputTokens })
  }

  classifyError(error: unknown): ModelFailureDiagnostic {
    if (!(error instanceof ResponsesModelError)) return { category: 'unknown', retryable: false }
    const status = rejectedHttpRequests.get(error)
    return status === undefined ? classifyNativeModelFailure(error.code, error.httpStatus, false, nativeModelFailureDetails(error))
      : classifyNativeModelFailure('http', status, true, nativeModelFailureDetails(error))
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    let stage: ModelFailureStage = 'request'
    const startedAt = Date.now(), started = performance.now()
    const modelIdentity = this.#apiKey && this.#model.includes(this.#apiKey) ? {} : { model: this.#model }
    let response: ModelResponse
    let providerUsage: ProviderUsage | null = null
    try { response = await this.generateResponse(request, value => { stage = value }, value => { providerUsage = value }) }
    catch (error) {
      const described = error instanceof ResponsesModelError ? describeNativeModelFailure(error, { protocol: 'openai-responses', stage }) : error
      await request.onRequestDiagnostic?.({ phase: 'result', protocol: 'openai-responses', ...modelIdentity, result: 'failed', startedAt, finishedAt: Date.now(),
        elapsedMs: performance.now() - started, providerUsage, failure: this.classifyError(described) })
      throw described
    }
    await request.onRequestDiagnostic?.({ phase: 'result', protocol: 'openai-responses', ...modelIdentity, result: 'completed', startedAt, finishedAt: Date.now(),
      elapsedMs: performance.now() - started, providerUsage: response.providerUsage ?? null })
    return response
  }

  private async generateResponse(request: ModelRequest, setStage: (stage: ModelFailureStage) => void, recordUsage: (usage: ProviderUsage | null) => void): Promise<ModelResponse> {
    if (request.context.protocol.id !== this.protocol.id || request.context.protocol.version !== this.protocol.version) {
      return failure('protocol', 'The saved conversation uses an incompatible model protocol.', 'protocol_mismatch')
    }
    try { validateResponsesImageInputs(request.context) } catch {
      return failure('protocol', 'The saved conversation contains unsupported image inputs.')
    }
    if (!Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens <= 0) return failure('configuration', 'Invalid model output limit.')
    if (canonicalJson(responsesTools(request.tools)) !== this.#toolsJson) return failure('tool_catalog', 'Model tools differ from the budgeted catalog.')
    const body = this.requestBody(request.context, request.maxOutputTokens)
    assertNoModelCredential(JSON.parse(body), this.#apiKey)
    if (Buffer.byteLength(body, 'utf8') > this.#maxRequestBytes) return failure('request_limit', 'The complete model context exceeds the transport limit.')
    if (request.signal.aborted) return failure('cancelled', 'Model request cancelled.')
    await request.onRequestDiagnostic?.(modelRequestDiagnostic(request, body, 'openai-responses', false, this.#model))
    if (request.signal.aborted) return failure('cancelled', 'Model request cancelled.')
    const controller = new AbortController()
    let timedOut = false
    const cancel = (): void => controller.abort()
    request.signal.addEventListener('abort', cancel, { once: true })
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, this.#timeoutMs)
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'text/event-stream' }
      if (this.#apiKey) headers.Authorization = `Bearer ${this.#apiKey}`
      const pendingResponse = fetch(this.#url, { method: 'POST', headers, body, signal: controller.signal, redirect: 'manual' })
      const response = await dispatchedModelResponse(request, 'openai-responses', this.#model, controller, pendingResponse)
      setStage('response_headers')
      if (!response.ok) {
        await response.body?.cancel()
        const error = new ResponsesModelError(response.status >= 300 && response.status < 400 ? 'redirect' : 'http', `Model service returned HTTP ${response.status}.`, response.status)
        rejectedHttpRequests.set(error, response.status)
        throw error
      }
      if (!response.body || !/^text\/event-stream(?:\s*;|\s*$)/i.test(response.headers.get('content-type') ?? '')) {
        await response.body?.cancel()
        return failure('schema', 'Model service did not return an event stream.', 'unexpected_content_type')
      }
      setStage('message_start')
      reader = response.body.getReader()
      const decoder = new TextDecoder('utf-8', { fatal: true })
      let bytes = 0
      let result: ModelResponse | undefined
      let responseId: string | undefined
      let refused = false
      const deltas = new SafeModelDeltas(this.#apiKey, event => {
        try { request.onEvent(event) } catch { failure('transport', 'Model transport failed or returned invalid UTF-8.') }
      })
      const calls = new Map<number, { itemId: string; callId: string }>()
      const parser = new EventStreamParser((data, eventName) => {
        if (data === '[DONE]') {
          setStage('completion')
          if (!result) failure('interrupted', 'Model stream ended without a completed response.')
          return
        }
        let event: unknown
        try { event = JSON.parse(data) } catch { return failure('schema', 'Invalid model event JSON.', 'invalid_json') }
        assertNoModelCredential(event, this.#apiKey)
        if (!object(event) || !nonempty(event.type) || (eventName && eventName !== 'message' && eventName !== event.type)) return failure('schema', 'Invalid model stream event.')
        if (result) return failure('schema', 'Model sent data after the completed response.', 'invalid_sequence')
        if (['response.completed', 'response.failed', 'response.incomplete'].includes(event.type) && object(event.response)) {
          setStage('completion')
          recordUsage(usageFrom(event.response.usage).providerUsage)
        }
        if (event.type === 'error' || event.type === 'response.failed') return failure('provider', 'Model service reported a failed response.')
        if (event.type === 'response.incomplete') { setStage('completion'); return failure('incomplete', 'Model response was incomplete.') }
        if (event.type === 'response.refusal.delta' || event.type === 'response.refusal.done') {
          const refusal = event.type === 'response.refusal.delta' ? event.delta : event.refusal
          if (typeof refusal !== 'string') return failure('schema', 'Invalid model refusal event.')
          refused = true
        }
        if (event.type === 'response.created' || event.type === 'response.in_progress') {
          setStage('message_start')
          if (!object(event.response) || !nonempty(event.response.id)) return failure('schema', 'Invalid model response identity.')
          if (responseId && responseId !== event.response.id) return failure('schema', 'Model response identity changed.', 'invalid_sequence')
          responseId = event.response.id
        }
        if (event.response_id !== undefined && (!nonempty(event.response_id) || (responseId && event.response_id !== responseId))) return failure('schema', 'Model event response identity mismatch.')
        if (event.type === 'response.output_item.added') {
          setStage(object(event.item) && event.item.type === 'function_call' ? 'tool_call' : object(event.item) && event.item.type === 'reasoning' ? 'thinking' : 'content')
          if (!Number.isSafeInteger(event.output_index) || (event.output_index as number) < 0 || !object(event.item) || !nonempty(event.item.type)) return failure('schema', 'Invalid added model output item.')
          if (event.item.type === 'function_call') {
            if (!nonempty(event.item.id) || !nonempty(event.item.call_id) || calls.has(event.output_index as number)) return failure('schema', 'Invalid streaming model tool call.', 'invalid_tool_call')
            calls.set(event.output_index as number, { itemId: event.item.id, callId: event.item.call_id })
          }
        }
        if (event.type === 'response.output_text.delta') {
          setStage('content')
          if (typeof event.delta !== 'string') return failure('schema', 'Invalid model text delta.')
          deltas.push({ type: 'text_delta', text: event.delta })
        }
        if (event.type === 'response.function_call_arguments.delta') {
          setStage('tool_call')
          const call = calls.get(event.output_index as number)
          if (!call || event.item_id !== call.itemId || typeof event.delta !== 'string') return failure('schema', 'Invalid model tool argument delta.', 'invalid_tool_call')
          deltas.push({ type: 'tool_arguments_delta', callId: call.callId, delta: event.delta })
        }
        if (event.type === 'response.completed') {
          setStage('completion')
          if (!object(event.response) || (responseId && event.response.id !== responseId)) return failure('schema', 'Invalid completed model response identity.')
          result = completeResponse(event.response)
          const displayText: string[] = []
          for (const item of result.outputItems) {
            if (!object(item)) continue
            if (item.type === 'message' && Array.isArray(item.content)) {
              for (const part of item.content) if (object(part) && typeof part.text === 'string') displayText.push(part.text)
            }
            if (item.type === 'function_call' && typeof item.arguments === 'string') {
              let parsed: unknown
              try { parsed = JSON.parse(item.arguments) } catch { /* 核心记录无效参数 */ }
              assertNoModelCredential(parsed, this.#apiKey)
            }
          }
          assertNoModelCredential(displayText.join(''), this.#apiKey)
          if (refused) result.finishReason = 'refused'
          for (const [index, call] of calls) {
            const item = result.outputItems[index]
            if (!object(item) || item.type !== 'function_call' || item.id !== call.itemId || item.call_id !== call.callId) return failure('schema', 'Completed tool calls differ from the model stream.', 'invalid_tool_call')
          }
        }
        // 未知事件类型视为向前兼容的显示元数据。只有通过校验的
        // response.completed 才提供可执行调用或待保存项。
      })
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        bytes += chunk.value.byteLength
        if (bytes > this.#maxResponseBytes) return failure('response_limit', 'Model stream exceeded its byte limit.')
        parser.push(decoder.decode(chunk.value, { stream: true }))
      }
      parser.push(decoder.decode())
      parser.finish()
      if (!result) return failure('interrupted', 'Model stream ended without a completed response.')
      if (request.signal.aborted) return failure('cancelled', 'Model request cancelled.')
      deltas.finish()
      return result
    } catch (error) {
      if (error instanceof ModelRequestDiagnosticError) throw error.original
      if (request.signal.aborted) return failure('cancelled', 'Model request cancelled.')
      if (timedOut) return failure('timeout', 'Model request timed out.')
      if (error instanceof ResponsesModelError) throw error
      // fetch 错误及回调错误可能包含凭据或远程文本。
      return failure('transport', 'Model transport failed or returned invalid UTF-8.')
    } finally {
      clearTimeout(timer)
      request.signal.removeEventListener('abort', cancel)
      controller.abort()
      try { await reader?.cancel() } catch { /* 传输已关闭 */ }
      reader?.releaseLock()
    }
  }
}
