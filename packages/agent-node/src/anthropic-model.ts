import type { JsonObject, JsonValue, ModelContext, ModelFailureDiagnostic, ModelFailureReason, ModelFailureStage, ModelPort, ModelRequest, ModelResponse, ToolCall, ToolDefinition, ToolResult, Usage, UserImage } from '@cc-desk/agent-core'
import { canonicalJson, estimateContextInputTokens, validateUserImages } from '@cc-desk/agent-core'
import { assertNoModelCredential, ResponsesModelError, SafeModelDeltas, type ResponsesModelOptions } from './responses-model.js'
import { anthropicPendingCalls, nativeToolResultItems } from './context-maintenance.js'
import { classifyNativeModelFailure, defaultModelFailureReason, describeNativeModelFailure, nativeModelFailureDetails } from './model-failure.js'

export type AnthropicAuthHeader = 'x-api-key' | 'authorization'
/** A service root, gateway prefix, /v1 base, or complete /v1/messages endpoint. */
export interface AnthropicModelOptions extends ResponsesModelOptions { authHeader?: AnthropicAuthHeader }

/** Never retains a provider body, URL, header, original exception, or credential. */
export class AnthropicModelError extends Error {
  constructor(readonly code: string, message: string, readonly httpStatus?: number) {
    super(message)
    this.name = code === 'cancelled' ? 'AbortError' : 'AnthropicModelError'
  }
}
const rejectedHttpRequests = new WeakMap<AnthropicModelError, number>()
const failure = (code: string, message: string, reason: ModelFailureReason | undefined = defaultModelFailureReason(code)): never => {
  const error = new AnthropicModelError(code, message)
  throw reason === undefined ? error : describeNativeModelFailure(error, { reason })
}
const object = (value: unknown): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value)
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const positive = (value: number | undefined, fallback: number, maximum: number): number => {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result <= 0 || result > maximum) failure('configuration', 'Invalid model transport limit.')
  return result
}
const guard = (value: unknown, credential: string | undefined): void => {
  try { assertNoModelCredential(value, credential) } catch (error) {
    if (error instanceof ResponsesModelError) throw new AnthropicModelError(error.code, error.message, error.httpStatus)
    throw error
  }
}
function supported(value: JsonObject, fields: readonly string[], reason: ModelFailureReason = 'unsupported_content'): void {
  if (Object.entries(value).some(([key, child]) => !fields.includes(key) && child !== null && child !== undefined)) failure('unsupported', 'The model returned unsupported continuation state.', reason)
}

/** Byte limits are enforced before feeding the CR/LF/CRLF and multiline SSE parser. */
class EventStreamParser {
  private line = ''
  private data: string[] = []
  private event = ''
  private afterCR = false
  constructor(private readonly consume: (data: string, event: string) => void) {}
  push(text: string): void {
    for (const character of text) {
      if (this.afterCR) { this.afterCR = false; if (character === '\n') continue }
      if (character === '\r' || character === '\n') {
        this.consumeLine()
        this.afterCR = character === '\r'
      } else this.line += character
    }
  }
  finish(): void {
    if (this.line.length || this.data.length || this.event.length) failure('interrupted', 'The model stream ended inside an event.', 'truncated_event')
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
  const pathname = url.pathname.replace(/\/+$/, '')
  url.pathname = pathname.endsWith('/v1/messages') ? pathname : pathname.endsWith('/v1') ? `${pathname}/messages` : `${pathname}/v1/messages`
  return url.href
}

const anthropicTools = (tools: readonly ToolDefinition[]): JsonObject[] => tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema }))
const estimateWithTools = (context: ModelContext, instructions: string, toolsJson: string): number => estimateContextInputTokens(context, instructions + toolsJson)
/** Conservative UTF-8 estimate of native messages, instructions and the fixed tool catalog. */
export function estimateAnthropicInputTokens(context: ModelContext, instructions = '', tools: readonly ToolDefinition[] = []): number {
  return estimateWithTools(context, instructions, canonicalJson(anthropicTools(tools)))
}
interface StreamingBlock { block: JsonObject; stopped: boolean; partialJson?: string; signatureStarted?: boolean }
type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'refusal' | 'model_context_window_exceeded'

export class AnthropicModel implements ModelPort {
  readonly protocol = Object.freeze({ id: 'anthropic-messages', version: 1 })
  readonly #url: string
  readonly #apiKey: string | undefined
  readonly #authHeader: AnthropicAuthHeader
  readonly #model: string
  readonly #instructions: string | undefined
  readonly #tools: JsonObject[]
  readonly #toolsJson: string
  readonly #timeoutMs: number
  readonly #maxResponseBytes: number
  readonly #maxRequestBytes: number

  constructor(options: AnthropicModelOptions) {
    this.#url = endpoint(options.baseURL, options.allowLoopbackHttp === true)
    if (!nonempty(options.model) || options.model.length > 200) failure('configuration', 'A valid model ID is required.')
    if (options.apiKey !== undefined && (!nonempty(options.apiKey) || /[\r\n]/.test(options.apiKey))) failure('configuration', 'Invalid model credential.')
    if (new URL(this.#url).protocol === 'https:' && !options.apiKey) failure('credential', 'A model API credential is required.')
    if (options.authHeader !== undefined && !['x-api-key', 'authorization'].includes(options.authHeader)) failure('configuration', 'Invalid model authentication header.')
    this.#model = options.model
    this.#apiKey = options.apiKey
    this.#authHeader = options.authHeader ?? 'x-api-key'
    this.#instructions = options.instructions
    this.#tools = structuredClone(anthropicTools(options.toolDefinitions ?? []))
    this.#toolsJson = canonicalJson(this.#tools)
    this.#timeoutMs = positive(options.timeoutMs, 120_000, 600_000)
    this.#maxResponseBytes = positive(options.maxResponseBytes, 8 * 1024 * 1024, 64 * 1024 * 1024)
    this.#maxRequestBytes = positive(options.maxRequestBytes, 8 * 1024 * 1024, 64 * 1024 * 1024)
  }

  userItems(input: string, images: UserImage[] = []): JsonValue[] {
    validateUserImages(images)
    return [{ role: 'user', content: [{ type: 'text', text: input }, ...images.map(image => ({
      type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.dataUrl.slice(image.dataUrl.indexOf(',') + 1) },
    }))] }]
  }
  toolResultItems(call: ToolCall, result: ToolResult): JsonValue[] { return nativeToolResultItems(this.protocol, call, result) }
  estimateInputTokens(context: ModelContext): number { return estimateWithTools(context, this.#instructions ?? '', this.#toolsJson) }
  classifyError(error: unknown): ModelFailureDiagnostic {
    if (!(error instanceof AnthropicModelError)) return { category: 'unknown', retryable: false }
    const status = rejectedHttpRequests.get(error)
    return status === undefined ? classifyNativeModelFailure(error.code, error.httpStatus, false, nativeModelFailureDetails(error)) : classifyNativeModelFailure('http', status, true, nativeModelFailureDetails(error))
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    let stage: ModelFailureStage = 'request'
    try { return await this.generateResponse(request, value => { stage = value }) }
    catch (error) {
      if (error instanceof AnthropicModelError) throw describeNativeModelFailure(error, { protocol: 'anthropic-messages', stage })
      throw error
    }
  }

  private async generateResponse(request: ModelRequest, setStage: (stage: ModelFailureStage) => void): Promise<ModelResponse> {
    if (request.context.protocol.id !== this.protocol.id || request.context.protocol.version !== this.protocol.version) return failure('protocol', 'The saved conversation uses an incompatible model protocol.', 'protocol_mismatch')
    let pendingCalls: ToolCall[]
    try { pendingCalls = anthropicPendingCalls(request.context) }
    catch { return failure('protocol', 'The saved conversation contains unsupported or incomplete model messages.', 'invalid_history') }
    if (pendingCalls.length) return failure('protocol', 'The saved conversation contains unresolved model tool calls.', 'pending_tool_calls')
    if (!Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens <= 0) return failure('configuration', 'Invalid model output limit.')
    if (canonicalJson(anthropicTools(request.tools)) !== this.#toolsJson) return failure('tool_catalog', 'Model tools differ from the budgeted catalog.')
    const body = JSON.stringify({
      model: this.#model, messages: request.context.items, max_tokens: request.maxOutputTokens, stream: true,
      ...(this.#instructions === undefined ? {} : { system: this.#instructions }),
      ...(this.#tools.length ? { tools: this.#tools, tool_choice: { type: 'auto', disable_parallel_tool_use: true } } : {}),
    })
    guard(JSON.parse(body), this.#apiKey)
    if (Buffer.byteLength(body, 'utf8') > this.#maxRequestBytes) return failure('request_limit', 'The complete model context exceeds the transport limit.')
    if (request.signal.aborted) return failure('cancelled', 'Model request cancelled.')
    const controller = new AbortController()
    let timedOut = false
    const cancel = (): void => controller.abort()
    request.signal.addEventListener('abort', cancel, { once: true })
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, this.#timeoutMs)
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'text/event-stream', 'anthropic-version': '2023-06-01' }
      if (this.#apiKey) headers[this.#authHeader] = this.#authHeader === 'authorization' ? `Bearer ${this.#apiKey}` : this.#apiKey
      const response = await fetch(this.#url, { method: 'POST', headers, body, signal: controller.signal, redirect: 'error' })
      setStage('response_headers')
      if (!response.ok) {
        await response.body?.cancel()
        const error = new AnthropicModelError('http', `Model service returned HTTP ${response.status}.`, response.status)
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
      let started = false
      let done = false
      let stopReason: StopReason | undefined
      const blocks: StreamingBlock[] = []
      const callIds = new Set<string>()
      let tokenCounts = new Map<string, number>()
      const updateUsage = (value: JsonValue | undefined): void => {
        if (value === undefined || value === null) return
        if (!object(value)) return failure('schema', 'Invalid model usage record.', 'invalid_usage')
        const nextCounts = new Map(tokenCounts)
        for (const name of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']) {
          const count = value[name]
          if (count === undefined || count === null) continue
          if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) return failure('schema', 'Invalid model usage count.', 'invalid_usage')
          nextCounts.set(name, count)
        }
        // Input counters may be reclassified as cache hits at completion. Merge
        // the whole usage update before comparing the cumulative input total.
        const inputTotal = (counts: Map<string, number>): number => ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'].reduce((total, name) => total + (counts.get(name) ?? 0), 0)
        const nextInput = inputTotal(nextCounts)
        if (!Number.isSafeInteger(nextInput) || nextInput < inputTotal(tokenCounts) || (nextCounts.get('output_tokens') ?? 0) < (tokenCounts.get('output_tokens') ?? 0)) return failure('schema', 'Invalid model usage count.', 'invalid_usage')
        tokenCounts = nextCounts
      }
      const deltas = new SafeModelDeltas(this.#apiKey, event => {
        try { request.onEvent(event) } catch { failure('transport', 'Model transport failed or returned invalid UTF-8.') }
      })
      // Private thinking and signatures participate in the same credential
      // boundary as visible text, without producing display events.
      const protectedDeltas = new SafeModelDeltas(this.#apiKey, () => {})
      const scanDelta = (text: string): void => protectedDeltas.push({ type: 'text_delta', text })
      const parser = new EventStreamParser((data, eventName) => {
        if (done) return failure('schema', 'Model sent data after the completed stream.', 'invalid_sequence')
        let event: unknown
        try { event = JSON.parse(data) } catch { return failure('schema', 'Invalid model event JSON.', 'invalid_json') }
        guard(event, this.#apiKey)
        if (!object(event) || !nonempty(event.type) || eventName && eventName !== event.type) return failure('schema', 'Invalid model stream event.')
        if (event.type === 'error') return failure('provider', 'Model service reported a failed response.')
        if (event.type === 'ping') return
        if (event.type === 'message_start') {
          setStage('message_start')
          if (started || !object(event.message)) return failure('schema', 'Invalid model message start.')
          const message = event.message
          supported(message, ['id', 'type', 'role', 'content', 'model', 'stop_reason', 'stop_sequence', 'usage'])
          if (!nonempty(message.id) || message.type !== 'message' || message.role !== 'assistant' || !Array.isArray(message.content) || message.content.length || message.stop_reason !== null || message.stop_sequence !== null) return failure('schema', 'Invalid model message start.')
          started = true
          updateUsage(message.usage)
          return
        }
        if (!started) return failure('schema', 'Model sent content before message start.', 'invalid_sequence')
        if (event.type === 'content_block_start') {
          setStage(object(event.content_block) && ['thinking', 'redacted_thinking'].includes(event.content_block.type as string) ? 'thinking'
            : object(event.content_block) && event.content_block.type === 'tool_use' ? 'tool_call' : 'content')
          if (stopReason || !Number.isSafeInteger(event.index) || event.index !== blocks.length || blocks.length >= 256 || blocks.some(block => !block.stopped) || !object(event.content_block)) return failure('schema', 'Invalid model content block start.')
          const block = event.content_block
          if (block.type === 'text') {
            supported(block, ['type', 'text'])
            if (typeof block.text !== 'string') return failure('schema', 'Invalid model text block.')
            blocks.push({ block: { type: 'text', text: block.text }, stopped: false })
            scanDelta(block.text)
            deltas.push({ type: 'text_delta', text: block.text })
          } else if (block.type === 'thinking') {
            supported(block, ['type', 'thinking', 'signature'], 'invalid_thinking')
            if (typeof block.thinking !== 'string' || block.signature !== undefined && typeof block.signature !== 'string') return failure('schema', 'Invalid model thinking block.', 'invalid_thinking')
            blocks.push({ block: { type: 'thinking', thinking: block.thinking, ...(block.signature === undefined ? {} : { signature: block.signature }) }, stopped: false, signatureStarted: nonempty(block.signature) })
            scanDelta(block.thinking)
            if (typeof block.signature === 'string') scanDelta(block.signature)
          } else if (block.type === 'redacted_thinking') {
            supported(block, ['type', 'data'], 'invalid_thinking')
            if (!nonempty(block.data)) return failure('schema', 'Invalid redacted model thinking block.', 'invalid_thinking')
            blocks.push({ block: { type: 'redacted_thinking', data: block.data }, stopped: false })
            scanDelta(block.data)
          } else if (block.type === 'tool_use') {
            supported(block, ['type', 'id', 'name', 'input'])
            if (!nonempty(block.id) || !nonempty(block.name) || !object(block.input) || callIds.has(block.id)) return failure('schema', 'Invalid or duplicate model tool block.', 'invalid_tool_call')
            callIds.add(block.id)
            blocks.push({ block: structuredClone(block), stopped: false })
          } else return failure('unsupported', 'The model returned an unsupported content block.')
          return
        }
        if (event.type === 'content_block_delta' || event.type === 'content_block_stop') {
          if (stopReason || !Number.isSafeInteger(event.index) || (event.index as number) < 0) return failure('schema', 'Invalid model content block index.')
          const current = blocks[event.index as number]
          if (current) setStage(['thinking', 'redacted_thinking'].includes(current.block.type as string) ? 'thinking' : current.block.type === 'tool_use' ? 'tool_call' : 'content')
          if (!current || current.stopped) return failure('schema', 'Model changed a completed or absent content block.')
          if (event.type === 'content_block_stop') {
            if (current.block.type === 'tool_use' && current.partialJson !== undefined) {
              let input: unknown
              try { input = JSON.parse(current.partialJson) } catch { return failure('schema', 'Invalid completed model tool JSON.', 'invalid_tool_call') }
              if (!object(input)) return failure('schema', 'Model tool input must be a JSON object.', 'invalid_tool_call')
              current.block.input = input
            }
            guard(current.block, this.#apiKey)
            current.stopped = true
          } else {
            if (!object(event.delta)) return failure('schema', 'Invalid model content delta.')
            if (current.block.type === 'text' && event.delta.type === 'text_delta') {
              supported(event.delta, ['type', 'text'])
              if (typeof event.delta.text !== 'string') return failure('schema', 'Invalid model text delta.')
              current.block.text = (current.block.text as string) + event.delta.text
              scanDelta(event.delta.text)
              deltas.push({ type: 'text_delta', text: event.delta.text })
            } else if (current.block.type === 'thinking' && event.delta.type === 'thinking_delta') {
              supported(event.delta, ['type', 'thinking'], 'invalid_thinking')
              if (typeof event.delta.thinking !== 'string' || current.signatureStarted) return failure('schema', 'Invalid model thinking delta.', 'invalid_thinking')
              current.block.thinking = (current.block.thinking as string) + event.delta.thinking
              scanDelta(event.delta.thinking)
            } else if (current.block.type === 'thinking' && event.delta.type === 'signature_delta') {
              supported(event.delta, ['type', 'signature'], 'invalid_thinking')
              if (typeof event.delta.signature !== 'string') return failure('schema', 'Invalid model thinking signature delta.', 'invalid_thinking')
              current.signatureStarted = true
              current.block.signature = (current.block.signature as string | undefined ?? '') + event.delta.signature
              scanDelta(event.delta.signature)
            } else if (current.block.type === 'tool_use' && event.delta.type === 'input_json_delta') {
              supported(event.delta, ['type', 'partial_json'])
              if (typeof event.delta.partial_json !== 'string' || Object.keys(current.block.input as JsonObject).length) return failure('schema', 'Invalid model tool input delta.', 'invalid_tool_call')
              current.partialJson = (current.partialJson ?? '') + event.delta.partial_json
              scanDelta(event.delta.partial_json)
              deltas.push({ type: 'tool_arguments_delta', callId: current.block.id as string, delta: event.delta.partial_json })
            } else return failure('unsupported', 'The model returned an unsupported content delta.', current.block.type === 'thinking' ? 'invalid_thinking' : 'unsupported_content')
          }
          return
        }
        if (event.type === 'message_delta') {
          setStage('completion')
          if (!object(event.delta) || blocks.some(block => !block.stopped)) return failure('schema', 'Invalid model message delta.')
          supported(event.delta, ['stop_reason', 'stop_sequence'])
          const reason = event.delta.stop_reason
          if (reason !== undefined && reason !== null) {
            if (!['end_turn', 'tool_use', 'max_tokens', 'stop_sequence', 'refusal', 'model_context_window_exceeded'].includes(reason as string)) return failure('unsupported', 'The model returned an unsupported stop reason.')
            if (stopReason) return failure('schema', 'Model completed the message more than once.')
            if (reason === 'stop_sequence' ? !nonempty(event.delta.stop_sequence) : event.delta.stop_sequence !== undefined && event.delta.stop_sequence !== null) return failure('schema', 'Invalid model stop sequence.')
            stopReason = reason as StopReason
          } else if (event.delta.stop_sequence !== undefined && event.delta.stop_sequence !== null) return failure('schema', 'Invalid model stop sequence.')
          updateUsage(event.usage)
          return
        }
        if (event.type === 'message_stop') {
          setStage('completion')
          if (!stopReason || !blocks.length || blocks.some(block => !block.stopped)) return failure('interrupted', 'Model stream ended without a completed response.')
          if ((stopReason === 'tool_use') !== (callIds.size > 0)) return failure('schema', 'Model tool calls differ from the completion reason.', 'invalid_tool_call')
          done = true
          return
        }
        return failure('unsupported', 'The model returned an unsupported stream event.', 'unsupported_event')
      })
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        bytes += chunk.value.byteLength
        if (bytes > this.#maxResponseBytes) return failure('response_limit', 'Model stream exceeded its byte limit.')
        parser.push(decoder.decode(chunk.value, { stream: true }))
      }
      parser.push(decoder.decode())
      parser.finish()
      if (!done || !stopReason) return failure('interrupted', 'Model stream ended without a completed response.')
      const content = blocks.map(item => item.block)
      const message: JsonObject = { role: 'assistant', content }
      guard([message, content.filter(block => block.type === 'text').map(block => block.text).join('')], this.#apiKey)
      const toolCalls: ToolCall[] = content.filter(block => block.type === 'tool_use').map(block => ({ id: block.id as string, name: block.name as string, arguments: JSON.stringify(block.input) }))
      const usage: Usage = {}
      if (tokenCounts.has('input_tokens')) {
        usage.inputTokens = (tokenCounts.get('input_tokens') ?? 0) + (tokenCounts.get('cache_creation_input_tokens') ?? 0) + (tokenCounts.get('cache_read_input_tokens') ?? 0)
        if (!Number.isSafeInteger(usage.inputTokens)) return failure('schema', 'Invalid model usage count.', 'invalid_usage')
      }
      if (tokenCounts.has('output_tokens')) usage.outputTokens = tokenCounts.get('output_tokens')!
      if (usage.inputTokens !== undefined && usage.outputTokens !== undefined) {
        if (!Number.isSafeInteger(usage.inputTokens + usage.outputTokens)) return failure('schema', 'Invalid model usage count.', 'invalid_usage')
        usage.totalTokens = usage.inputTokens + usage.outputTokens
      }
      if (request.signal.aborted) return failure('cancelled', 'Model request cancelled.')
      deltas.finish()
      return { outputItems: [message], toolCalls, usage: Object.keys(usage).length ? usage : null,
        finishReason: stopReason === 'tool_use' ? 'tool_calls' : stopReason === 'refusal' ? 'refused' : ['max_tokens', 'model_context_window_exceeded'].includes(stopReason) ? 'incomplete' : 'completed' }
    } catch (error) {
      if (request.signal.aborted) return failure('cancelled', 'Model request cancelled.')
      if (timedOut) return failure('timeout', 'Model request timed out.')
      if (error instanceof AnthropicModelError) throw error
      if (error instanceof ResponsesModelError) throw new AnthropicModelError(error.code, error.message, error.httpStatus)
      return failure('transport', 'Model transport failed or returned invalid UTF-8.')
    } finally {
      clearTimeout(timer)
      request.signal.removeEventListener('abort', cancel)
      controller.abort()
      try { await reader?.cancel() } catch { /* transport already closed */ }
      reader?.releaseLock()
    }
  }
}
