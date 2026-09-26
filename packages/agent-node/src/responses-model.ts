import type { JsonObject, JsonValue, ModelContext, ModelPort, ModelRequest, ModelResponse, ModelStreamEvent, ToolCall, ToolResult, Usage } from '@cc-desk/agent-core'

export interface ResponsesModelOptions {
  /** API base, normally https://api.openai.com/v1. /responses is appended. */
  baseURL: string
  model: string
  apiKey?: string
  instructions?: string
  /** HTTP is accepted only for literal loopback/localhost and this explicit opt-in. */
  allowLoopbackHttp?: boolean
  timeoutMs?: number
  maxResponseBytes?: number
  maxRequestBytes?: number
}

/** Deliberately contains no provider body, URL, header, or original error cause. */
export class ResponsesModelError extends Error {
  constructor(readonly code: string, message: string, readonly httpStatus?: number) {
    super(message)
    this.name = code === 'cancelled' ? 'AbortError' : 'ResponsesModelError'
  }
}

const failure = (code: string, message: string): never => { throw new ResponsesModelError(code, message) }
const object = (value: unknown): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value)
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const positive = (value: number | undefined, fallback: number, maximum: number): number => {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result <= 0 || result > maximum) failure('configuration', 'Invalid model transport limit.')
  return result
}

/** Bounded SSE framing, accepting CRLF, CR, LF, comments, and multi-line data. */
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
    // An unterminated event is not a complete protocol response.
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
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback && allowLoopbackHttp))) {
    return failure('configuration', 'Model service requires HTTPS, or explicitly enabled loopback HTTP, without URL credentials or query parameters.')
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/responses`
  return url.href
}

function usageFrom(value: JsonValue | undefined): Usage | null {
  if (value === null || value === undefined) return null
  if (!object(value)) return failure('schema', 'Invalid model usage record.')
  const result: Usage = {}
  for (const [provider, local] of [['input_tokens', 'inputTokens'], ['output_tokens', 'outputTokens'], ['total_tokens', 'totalTokens']] as const) {
    const count = value[provider]
    if (count === undefined || count === null) continue
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) return failure('schema', 'Invalid model usage count.')
    result[local] = count
  }
  return Object.keys(result).length ? result : null
}

/** Fail closed if a service echoes its bearer credential into any provider data. */
export function assertNoModelCredential(value: unknown, secret: string | undefined): void {
  if (!secret) return
  const pending: unknown[] = [value]
  while (pending.length) {
    const current = pending.pop()
    if (typeof current === 'string') {
      if (current.includes(secret)) failure('credential_echo', 'Model data contained a protected credential.')
      // Function arguments and tool outputs are nested JSON strings. Escaping a
      // key must not bypass the check before those strings are later decoded.
      if (/^[\s]*[\[{\"]/.test(current)) {
        try { pending.push(JSON.parse(current)) } catch { /* ordinary model text */ }
      }
    }
    if (Array.isArray(current)) {
      for (const child of current) pending.push(child)
      const messages = current.filter(item => object(item) && item.type === 'message')
      if (messages.length) pending.push(messages.flatMap(item => Array.isArray(item.content) ? item.content.filter((part: unknown) => object(part) && typeof part.text === 'string').map((part: unknown) => (part as JsonObject).text) : []).join(''))
    }
    else if (object(current)) {
      for (const [key, child] of Object.entries(current)) { pending.push(key, child) }
      if (current.type === 'message' && Array.isArray(current.content)) {
        pending.push(current.content.filter(part => object(part) && typeof part.text === 'string').map(part => (part as JsonObject).text).join(''))
      }
    }
  }
}

/** Hold the suffix that could become a credential when the next delta arrives. */
export class SafeModelDeltas {
  private pending: ModelStreamEvent[] = []
  private channels = new Map<string, { length: number; safe: number; scanTail: string }>()
  private globalTail = ''
  readonly #secret: string | undefined
  constructor(secret: string | undefined, private readonly emit: (event: ModelStreamEvent) => void) { this.#secret = secret }
  push(event: ModelStreamEvent): void {
    if (!this.#secret) { this.emit(event); return }
    const channel = this.channel(event)
    const state = this.channels.get(channel) ?? { length: 0, safe: 0, scanTail: '' }
    const delta = event.type === 'text_delta' ? event.text : event.delta
    const candidate = state.scanTail + delta
    assertNoModelCredential(candidate, this.#secret)
    assertNoModelCredential(this.globalTail + delta, this.#secret)
    this.globalTail = this.#secret.length > 1 ? (this.globalTail + delta).slice(-(this.#secret.length - 1)) : ''
    state.scanTail = this.#secret.length > 1 ? candidate.slice(-(this.#secret.length - 1)) : ''
    state.length += delta.length
    state.safe = Math.max(0, state.length - this.#secret.length + 1)
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

function completeResponse(response: JsonObject): ModelResponse {
  if (!nonempty(response.id) || response.status !== 'completed' || !Array.isArray(response.output)) {
    return failure('schema', 'Invalid completed model response.')
  }
  const toolCalls: ToolCall[] = []
  const ids = new Set<string>()
  let refused = false
  for (const item of response.output) {
    if (!object(item) || !nonempty(item.type)) return failure('schema', 'Invalid model output item.')
    if (item.status !== undefined && item.status !== 'completed') return failure('incomplete', 'The model returned an incomplete output item.')
    if (item.type === 'function_call') {
      if (!nonempty(item.call_id) || !nonempty(item.name) || typeof item.arguments !== 'string' || ids.has(item.call_id)) {
        return failure('schema', 'Invalid or duplicate model tool call.')
      }
      // Preserve even an unknown function name or malformed argument string.
      // Core durably records the complete response before rejecting that call;
      // no argument delta or provider name directly reaches ToolPort execution.
      ids.add(item.call_id)
      toolCalls.push({ id: item.call_id, name: item.name, arguments: item.arguments })
    } else if (item.type === 'message') {
      if (item.role !== 'assistant' || !Array.isArray(item.content)) return failure('schema', 'Invalid model message.')
      for (const part of item.content) {
        if (!object(part) || !nonempty(part.type)) return failure('schema', 'Invalid model message content.')
        if (part.type === 'refusal') {
          if (typeof part.refusal !== 'string') return failure('schema', 'Invalid model refusal.')
          refused = true
        }
        if (part.type === 'output_text' && typeof part.text !== 'string') return failure('schema', 'Invalid model text.')
      }
    }
  }
  // Preserve all output fields (including unknown passive items, phase, annotations,
  // and encrypted reasoning). They are replayed verbatim as manual input history.
  return {
    outputItems: response.output,
    toolCalls,
    continuation: { responseId: response.id },
    finishReason: refused ? 'refused' : toolCalls.length ? 'tool_calls' : 'completed',
    usage: usageFrom(response.usage),
  }
}

export class ResponsesModel implements ModelPort {
  readonly protocol = Object.freeze({ id: 'openai-responses', version: 1 })
  readonly #url: string
  readonly #apiKey: string | undefined
  readonly #model: string
  readonly #instructions: string | undefined
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
    this.#timeoutMs = positive(options.timeoutMs, 120_000, 600_000)
    this.#maxResponseBytes = positive(options.maxResponseBytes, 8 * 1024 * 1024, 64 * 1024 * 1024)
    this.#maxRequestBytes = positive(options.maxRequestBytes, 8 * 1024 * 1024, 64 * 1024 * 1024)
  }

  userItems(input: string): JsonValue[] { return [{ role: 'user', content: input }] }

  toolResultItems(call: ToolCall, result: ToolResult): JsonValue[] {
    return [{ type: 'function_call_output', call_id: call.id, output: JSON.stringify(result) }]
  }

  estimateInputTokens(context: ModelContext): number {
    // Conservative UTF-8 byte estimate; never represents provider-billed usage.
    return Buffer.byteLength(JSON.stringify(context.items) + (this.#instructions ?? ''), 'utf8')
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    if (request.context.protocol.id !== this.protocol.id || request.context.protocol.version !== this.protocol.version) {
      return failure('protocol', 'The saved conversation uses an incompatible model protocol.')
    }
    if (!Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens <= 0) return failure('configuration', 'Invalid model output limit.')
    const body = JSON.stringify({
      model: this.#model,
      input: request.context.items,
      ...(this.#instructions === undefined ? {} : { instructions: this.#instructions }),
      tools: request.tools.map(tool => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.inputSchema, strict: false })),
      // ToolPort executes the completed batch sequentially. The flag also asks the
      // provider to emit at most one call, but incoming batches remain supported.
      parallel_tool_calls: false,
      store: false,
      stream: true,
      include: ['reasoning.encrypted_content'],
      max_output_tokens: request.maxOutputTokens,
    })
    assertNoModelCredential(JSON.parse(body), this.#apiKey)
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
        throw new ResponsesModelError(response.status >= 300 && response.status < 400 ? 'redirect' : 'http', `Model service returned HTTP ${response.status}.`, response.status)
      }
      if (!response.body || !/^text\/event-stream(?:\s*;|\s*$)/i.test(response.headers.get('content-type') ?? '')) {
        await response.body?.cancel()
        return failure('schema', 'Model service did not return an event stream.')
      }
      reader = response.body.getReader()
      const decoder = new TextDecoder('utf-8', { fatal: true })
      let bytes = 0
      let result: ModelResponse | undefined
      let responseId: string | undefined
      let refused = false
      const deltas = new SafeModelDeltas(this.#apiKey, request.onEvent)
      const calls = new Map<number, { itemId: string; callId: string }>()
      const parser = new EventStreamParser((data, eventName) => {
        if (data === '[DONE]') {
          if (!result) failure('interrupted', 'Model stream ended without a completed response.')
          return
        }
        let event: unknown
        try { event = JSON.parse(data) } catch { return failure('schema', 'Invalid model event JSON.') }
        assertNoModelCredential(event, this.#apiKey)
        if (!object(event) || !nonempty(event.type) || (eventName && eventName !== 'message' && eventName !== event.type)) return failure('schema', 'Invalid model stream event.')
        if (result) return failure('schema', 'Model sent data after the completed response.')
        if (event.type === 'error' || event.type === 'response.failed') return failure('provider', 'Model service reported a failed response.')
        if (event.type === 'response.incomplete') return failure('incomplete', 'Model response was incomplete.')
        if (event.type === 'response.refusal.delta' || event.type === 'response.refusal.done') {
          const refusal = event.type === 'response.refusal.delta' ? event.delta : event.refusal
          if (typeof refusal !== 'string') return failure('schema', 'Invalid model refusal event.')
          refused = true
        }
        if (event.type === 'response.created' || event.type === 'response.in_progress') {
          if (!object(event.response) || !nonempty(event.response.id)) return failure('schema', 'Invalid model response identity.')
          if (responseId && responseId !== event.response.id) return failure('schema', 'Model response identity changed.')
          responseId = event.response.id
        }
        if (event.response_id !== undefined && (!nonempty(event.response_id) || (responseId && event.response_id !== responseId))) return failure('schema', 'Model event response identity mismatch.')
        if (event.type === 'response.output_item.added') {
          if (!Number.isSafeInteger(event.output_index) || (event.output_index as number) < 0 || !object(event.item) || !nonempty(event.item.type)) return failure('schema', 'Invalid added model output item.')
          if (event.item.type === 'function_call') {
            if (!nonempty(event.item.id) || !nonempty(event.item.call_id) || calls.has(event.output_index as number)) return failure('schema', 'Invalid streaming model tool call.')
            calls.set(event.output_index as number, { itemId: event.item.id, callId: event.item.call_id })
          }
        }
        if (event.type === 'response.output_text.delta') {
          if (typeof event.delta !== 'string') return failure('schema', 'Invalid model text delta.')
          deltas.push({ type: 'text_delta', text: event.delta })
        }
        if (event.type === 'response.function_call_arguments.delta') {
          const call = calls.get(event.output_index as number)
          if (!call || event.item_id !== call.itemId || typeof event.delta !== 'string') return failure('schema', 'Invalid model tool argument delta.')
          deltas.push({ type: 'tool_arguments_delta', callId: call.callId, delta: event.delta })
        }
        if (event.type === 'response.completed') {
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
              try { parsed = JSON.parse(item.arguments) } catch { /* core records invalid arguments */ }
              assertNoModelCredential(parsed, this.#apiKey)
            }
          }
          assertNoModelCredential(displayText.join(''), this.#apiKey)
          if (refused) result.finishReason = 'refused'
          for (const [index, call] of calls) {
            const item = result.outputItems[index]
            if (!object(item) || item.type !== 'function_call' || item.id !== call.itemId || item.call_id !== call.callId) return failure('schema', 'Completed tool calls differ from the model stream.')
          }
        }
        // Unknown event types are forward-compatible display metadata. Only a
        // validated response.completed supplies executable calls or saved items.
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
      if (request.signal.aborted) return failure('cancelled', 'Model request cancelled.')
      if (timedOut) return failure('timeout', 'Model request timed out.')
      if (error instanceof ResponsesModelError) throw error
      // fetch errors and callback errors can include credentials or remote text.
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
