import type { JsonObject, JsonValue, ModelContext, ModelPort, ModelRequest, ModelResponse, ToolCall, ToolDefinition, ToolResult, Usage } from '@cc-desk/agent-core'
import { canonicalJson, estimateContextInputTokens } from '@cc-desk/agent-core'
import { assertNoModelCredential, ResponsesModelError, SafeModelDeltas, type ResponsesModelOptions } from './responses-model.js'
import { chatCompletionsPendingCalls } from './context-maintenance.js'

/** API base excludes /chat/completions. Limits and credential policy match Responses. */
export type ChatCompletionsModelOptions = ResponsesModelOptions

/** Never retains a provider body, URL, header, original exception, or credential. */
export class ChatCompletionsModelError extends Error {
  constructor(readonly code: string, message: string, readonly httpStatus?: number) {
    super(message)
    this.name = code === 'cancelled' ? 'AbortError' : 'ChatCompletionsModelError'
  }
}

const failure = (code: string, message: string): never => { throw new ChatCompletionsModelError(code, message) }
const object = (value: unknown): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value)
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const positive = (value: number | undefined, fallback: number, maximum: number): number => {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result <= 0 || result > maximum) failure('configuration', 'Invalid model transport limit.')
  return result
}
const guard = (value: unknown, credential: string | undefined): void => {
  try { assertNoModelCredential(value, credential) } catch (error) {
    if (error instanceof ResponsesModelError) throw new ChatCompletionsModelError(error.code, error.message, error.httpStatus)
    throw error
  }
}

/** Byte limits are enforced before feeding this CR/LF/CRLF and multiline SSE parser. */
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
    if (this.line.length || this.data.length) failure('interrupted', 'The model stream ended inside an event.')
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
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/chat/completions`
  return url.href
}

function usageFrom(value: JsonValue): Usage | null {
  if (!object(value)) return failure('schema', 'Invalid model usage record.')
  const result: Usage = {}
  for (const [provider, local] of [['prompt_tokens', 'inputTokens'], ['completion_tokens', 'outputTokens'], ['total_tokens', 'totalTokens']] as const) {
    const count = value[provider]
    if (count === undefined || count === null) continue
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) return failure('schema', 'Invalid model usage count.')
    result[local] = count
  }
  return Object.keys(result).length ? result : null
}

const chatTools = (tools: readonly ToolDefinition[]): JsonObject[] => tools.map(tool => ({
  type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema, strict: false },
}))
const estimateWithTools = (context: ModelContext, instructions: string, toolsJson: string): number => estimateContextInputTokens(context, instructions + toolsJson)

/** Conservative UTF-8 estimate, including the exact tool catalog; never billed usage. */
export function estimateChatCompletionsInputTokens(context: ModelContext, instructions = '', toolDefinitions: readonly ToolDefinition[] = []): number {
  return estimateWithTools(context, instructions, canonicalJson(chatTools(toolDefinitions)))
}

interface StreamingCall { id: string; name: string; arguments: string; type: 'function' }
type ChatFinishReason = 'stop' | 'tool_calls' | 'length' | 'content_filter'
const supportedDelta = new Set(['role', 'content', 'refusal', 'tool_calls'])
const supportedCall = new Set(['index', 'id', 'type', 'function'])
const supportedFunction = new Set(['name', 'arguments'])
function assertSupportedFields(value: JsonObject, fields: ReadonlySet<string>): void {
  // Message extensions can carry continuation state (e.g. vendor reasoning).
  // Reject active unknown fields instead of silently discarding that state.
  if (Object.entries(value).some(([key, child]) => !fields.has(key) && child !== null)) failure('unsupported', 'The model returned an unsupported message extension.')
}

export class ChatCompletionsModel implements ModelPort {
  readonly protocol = Object.freeze({ id: 'openai-chat-completions', version: 1 })
  readonly #url: string
  readonly #apiKey: string | undefined
  readonly #model: string
  readonly #instructions: string | undefined
  readonly #tools: JsonObject[]
  readonly #toolsJson: string
  readonly #timeoutMs: number
  readonly #maxResponseBytes: number
  readonly #maxRequestBytes: number

  constructor(options: ChatCompletionsModelOptions) {
    this.#url = endpoint(options.baseURL, options.allowLoopbackHttp === true)
    if (!nonempty(options.model) || options.model.length > 200) failure('configuration', 'A valid model ID is required.')
    if (options.apiKey !== undefined && (!nonempty(options.apiKey) || /[\r\n]/.test(options.apiKey))) failure('configuration', 'Invalid model credential.')
    if (new URL(this.#url).protocol === 'https:' && !options.apiKey) failure('credential', 'A model API credential is required.')
    this.#model = options.model
    this.#apiKey = options.apiKey
    this.#instructions = options.instructions
    this.#tools = structuredClone(chatTools(options.toolDefinitions ?? []))
    this.#toolsJson = canonicalJson(this.#tools)
    this.#timeoutMs = positive(options.timeoutMs, 120_000, 600_000)
    this.#maxResponseBytes = positive(options.maxResponseBytes, 8 * 1024 * 1024, 64 * 1024 * 1024)
    this.#maxRequestBytes = positive(options.maxRequestBytes, 8 * 1024 * 1024, 64 * 1024 * 1024)
  }

  userItems(input: string): JsonValue[] { return [{ role: 'user', content: input }] }

  toolResultItems(call: ToolCall, result: ToolResult): JsonValue[] {
    return [{ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) }]
  }

  estimateInputTokens(context: ModelContext): number { return estimateWithTools(context, this.#instructions ?? '', this.#toolsJson) }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    if (request.context.protocol.id !== this.protocol.id || request.context.protocol.version !== this.protocol.version) {
      return failure('protocol', 'The saved conversation uses an incompatible model protocol.')
    }
    try {
      if (chatCompletionsPendingCalls(request.context).length) return failure('protocol', 'The saved conversation contains unresolved model tool calls.')
    } catch {
      return failure('protocol', 'The saved conversation contains unsupported or incomplete model messages.')
    }
    if (!Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens <= 0) return failure('configuration', 'Invalid model output limit.')
    if (canonicalJson(chatTools(request.tools)) !== this.#toolsJson) return failure('tool_catalog', 'Model tools differ from the budgeted catalog.')
    const body = JSON.stringify({
      model: this.#model,
      messages: [...(this.#instructions === undefined ? [] : [{ role: 'system', content: this.#instructions }]), ...request.context.items],
      ...(this.#tools.length ? { tools: this.#tools, parallel_tool_calls: false } : {}),
      n: 1, store: false, stream: true, stream_options: { include_usage: true },
      max_completion_tokens: request.maxOutputTokens,
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
      const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'text/event-stream' }
      if (this.#apiKey) headers.Authorization = `Bearer ${this.#apiKey}`
      const response = await fetch(this.#url, { method: 'POST', headers, body, signal: controller.signal, redirect: 'manual' })
      if (!response.ok) {
        await response.body?.cancel()
        throw new ChatCompletionsModelError(response.status >= 300 && response.status < 400 ? 'redirect' : 'http', `Model service returned HTTP ${response.status}.`, response.status)
      }
      if (!response.body || !/^text\/event-stream(?:\s*;|\s*$)/i.test(response.headers.get('content-type') ?? '')) {
        await response.body?.cancel()
        return failure('schema', 'Model service did not return an event stream.')
      }
      reader = response.body.getReader()
      const decoder = new TextDecoder('utf-8', { fatal: true })
      let bytes = 0
      let responseId: string | undefined
      let text: string | null = null
      let refusal: string | null = null
      let finished: ChatFinishReason | undefined
      let done = false
      let usage: Usage | null = null
      let seenUsage = false
      const calls = new Map<number, StreamingCall>()
      const deltas = new SafeModelDeltas(this.#apiKey, request.onEvent)
      const parser = new EventStreamParser((data, eventName) => {
        if (done) failure('schema', 'Model sent data after the completed stream.')
        if (data === '[DONE]') {
          if (!finished) failure('interrupted', 'Model stream ended without a completed response.')
          done = true
          return
        }
        let event: unknown
        try { event = JSON.parse(data) } catch { return failure('schema', 'Invalid model event JSON.') }
        guard(event, this.#apiKey)
        if (!object(event)) return failure('schema', 'Invalid model stream event.')
        if (event.error !== undefined || eventName === 'error') return failure('provider', 'Model service reported a failed response.')
        if ((eventName && eventName !== 'message') || event.object !== 'chat.completion.chunk' || !nonempty(event.id) || !Array.isArray(event.choices)) {
          return failure('schema', 'Invalid model stream event.')
        }
        if (responseId && responseId !== event.id) return failure('schema', 'Model response identity changed.')
        responseId = event.id
        if (event.choices.length > 1) return failure('schema', 'The model returned multiple choices.')
        if (event.choices.length) {
          if (finished || seenUsage) return failure('schema', 'Model sent a choice after completion.')
          const choice = event.choices[0]
          if (!object(choice) || choice.index !== 0 || !object(choice.delta)) return failure('schema', 'Invalid model choice.')
          const delta = choice.delta
          assertSupportedFields(delta, supportedDelta)
          if (delta.role !== undefined && delta.role !== 'assistant') return failure('schema', 'Invalid model message role.')
          if (delta.content !== undefined && delta.content !== null) {
            if (typeof delta.content !== 'string') return failure('schema', 'Invalid model text delta.')
            text = (text ?? '') + delta.content
            deltas.push({ type: 'text_delta', text: delta.content })
          }
          if (delta.refusal !== undefined && delta.refusal !== null) {
            if (typeof delta.refusal !== 'string') return failure('schema', 'Invalid model refusal delta.')
            refusal = (refusal ?? '') + delta.refusal
            guard(refusal, this.#apiKey)
          }
          if (delta.tool_calls !== undefined && delta.tool_calls !== null) {
            if (!Array.isArray(delta.tool_calls)) return failure('schema', 'Invalid model tool call deltas.')
            for (const item of delta.tool_calls) {
              if (!object(item) || !Number.isSafeInteger(item.index) || (item.index as number) < 0 || (item.index as number) >= 256) return failure('schema', 'Invalid model tool call index.')
              assertSupportedFields(item, supportedCall)
              const index = item.index as number
              let call = calls.get(index)
              if (!call) {
                if (!nonempty(item.id) || item.type !== 'function') return failure('schema', 'Invalid streaming model tool identity.')
                call = { id: item.id, name: '', arguments: '', type: 'function' }
                calls.set(index, call)
              } else if ((item.id !== undefined && item.id !== call.id) || (item.type !== undefined && item.type !== 'function')) {
                return failure('schema', 'Model tool identity changed.')
              }
              if (item.function !== undefined) {
                if (!object(item.function)) return failure('schema', 'Invalid streaming model function.')
                assertSupportedFields(item.function, supportedFunction)
                if (item.function.name !== undefined) {
                  if (typeof item.function.name !== 'string') return failure('schema', 'Invalid streaming model function name.')
                  call.name += item.function.name
                  guard(call.name, this.#apiKey)
                }
                if (item.function.arguments !== undefined) {
                  if (typeof item.function.arguments !== 'string') return failure('schema', 'Invalid model tool argument delta.')
                  call.arguments += item.function.arguments
                  deltas.push({ type: 'tool_arguments_delta', callId: call.id, delta: item.function.arguments })
                }
              }
            }
          }
          if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
            if (!['stop', 'tool_calls', 'length', 'content_filter'].includes(choice.finish_reason as string)) return failure('unsupported', 'The model returned an unsupported completion reason.')
            finished = choice.finish_reason as ChatFinishReason
          }
        } else if (!finished || event.usage === undefined || event.usage === null) return failure('schema', 'Invalid model usage chunk.')
        if (event.usage !== undefined && event.usage !== null) {
          if (!finished || seenUsage) return failure('schema', 'Invalid repeated or premature model usage.')
          usage = usageFrom(event.usage)
          seenUsage = true
        }
        // Top-level metadata (model, fingerprint, obfuscation) has no message
        // semantics and is intentionally not replayed as conversation history.
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
      if (!done || !finished || !responseId) return failure('interrupted', 'Model stream ended without a completed response.')
      const ordered = [...calls].sort(([left], [right]) => left - right)
      const ids = new Set<string>()
      const toolCalls: ToolCall[] = ordered.map(([index, call], ordinal) => {
        if (index !== ordinal || !nonempty(call.name) || ids.has(call.id)) return failure('schema', 'Invalid or duplicate completed model tool call.')
        ids.add(call.id)
        return { id: call.id, name: call.name, arguments: call.arguments }
      })
      if ((finished === 'tool_calls' && !toolCalls.length) || (finished === 'stop' && toolCalls.length)) return failure('schema', 'Model tool calls differ from the completion reason.')
      const message: JsonObject = { role: 'assistant', content: text }
      if (refusal !== null) message.refusal = refusal
      if (toolCalls.length) message.tool_calls = toolCalls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } }))
      // Also scans decoded argument JSON, protecting against escaped credentials.
      guard(message, this.#apiKey)
      if (request.signal.aborted) return failure('cancelled', 'Model request cancelled.')
      deltas.finish()
      return {
        outputItems: [message], toolCalls, usage,
        finishReason: refusal || finished === 'content_filter' ? 'refused' : finished === 'length' ? 'incomplete' : toolCalls.length ? 'tool_calls' : 'completed',
      }
    } catch (error) {
      if (request.signal.aborted) return failure('cancelled', 'Model request cancelled.')
      if (timedOut) return failure('timeout', 'Model request timed out.')
      if (error instanceof ChatCompletionsModelError) throw error
      if (error instanceof ResponsesModelError) throw new ChatCompletionsModelError(error.code, error.message, error.httpStatus)
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
