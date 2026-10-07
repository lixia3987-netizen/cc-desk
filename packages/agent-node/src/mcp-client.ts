import { randomUUID } from 'node:crypto'
import type { JsonObject, JsonValue } from '@cc-desk/agent-core'
import { assertMcpToolInput } from './mcp-schema.js'
import { MCP_PROTOCOL_VERSION, McpClientError, LIMIT, object, own, fail, validateJson, validateTool, headerParameters, assertNoSecrets, parseMessage, envelope, normalizeToolResult, validateInitialization, type McpTool, type McpProtocolVersion } from './mcp-protocol.js'
export { MCP_PROTOCOL_VERSION, McpClientError, type McpTool, type McpProtocolVersion, type McpCallOutcome } from './mcp-protocol.js'

export interface McpHttpClientOptions {
  endpoint: string
  /** Explicit revision selection; no protocol downgrade or automatic retry. */
  protocolVersion?: McpProtocolVersion
  allowLoopbackHttp?: boolean
  bearerToken?: string
  forbiddenValues?: readonly (string | undefined)[]
  /** Applies to the entire discovery operation, including all catalog pages. */
  timeoutMs?: number
}

function endpoint(value: string, allowLoopbackHttp: boolean): string {
  if (typeof value !== 'string' || value.length > 4096 || /[\s\\]/u.test(value)) fail('configuration')
  let url: URL
  try { url = new URL(value) } catch { return fail('configuration') }
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127\.(\d{1,3}\.){2}\d{1,3}$/.test(url.hostname)
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && allowLoopbackHttp && loopback))) fail('configuration')
  return url.href
}

function encodeHeader(value: string): string {
  return /^[\x20-\x7e\t]*$/.test(value) && value.trim() === value && !(value.startsWith('=?base64?') && value.endsWith('?='))
    ? value : `=?base64?${Buffer.from(value, 'utf8').toString('base64')}?=`
}

function toolHeaders(tool: McpTool, input: JsonObject): Record<string, string> {
  const headers: Record<string, string> = { 'Mcp-Name': encodeHeader(tool.name) }
  for (const parameter of headerParameters(tool.inputSchema)) {
    let value: JsonValue | undefined = input
    for (const key of parameter.path) {
      if (value === null || value === undefined) { value = undefined; break }
      if (!object(value)) fail('tool_arguments')
      value = own(value, key) ? value[key] : undefined
    }
    // The transport explicitly omits null and absent arguments.
    if (value === null || value === undefined) continue
    if ((parameter.type === 'string' && typeof value !== 'string') ||
        (parameter.type === 'boolean' && typeof value !== 'boolean') ||
        (parameter.type === 'integer' && (typeof value !== 'number' || !Number.isSafeInteger(value)))) fail('tool_arguments')
    headers[`Mcp-Param-${parameter.name}`] = encodeHeader(String(value))
  }
  if (Object.entries(headers).reduce((sum, [key, value]) => sum + Buffer.byteLength(key) + Buffer.byteLength(value), 0) > LIMIT.headerBytes) fail('request_limit')
  return headers
}

class SseParser {
  private line = ''
  private data: string[] = []
  private afterCR = false
  constructor(private readonly consume: (data: string) => void) {}
  push(text: string): void {
    for (const character of text) {
      if (this.afterCR) { this.afterCR = false; if (character === '\n') continue }
      if (character === '\r' || character === '\n') {
        const line = this.line
        this.line = ''
        this.afterCR = character === '\r'
        if (line === '') {
          if (this.data.length) this.consume(this.data.join('\n'))
          this.data = []
        } else if (!line.startsWith(':')) {
          const colon = line.indexOf(':')
          const field = colon < 0 ? line : line.slice(0, colon)
          let value = colon < 0 ? '' : line.slice(colon + 1)
          if (value.startsWith(' ')) value = value.slice(1)
          if (field === 'data') this.data.push(value)
        }
      } else this.line += character
    }
  }
}

interface Operation { signal: AbortSignal; sentCall: boolean; bytes: number; serverPings: number }

/** Explicitly join body cancellation even when fetch does not forward its abort. */
function responseReader(response: Response, signal: AbortSignal): {
  reader: ReadableStreamDefaultReader<Uint8Array>
  close(): Promise<void>
} | undefined {
  const reader = response.body?.getReader()
  if (!reader) return undefined
  let cancellation: Promise<void> | undefined
  const cancel = (): void => { cancellation ??= reader.cancel().catch(() => undefined) }
  signal.addEventListener('abort', cancel, { once: true })
  // Abort can occur between fetch resolving and this body acquiring its reader.
  if (signal.aborted) cancel()
  return {
    reader,
    async close() {
      signal.removeEventListener('abort', cancel)
      cancel()
      // A second reader.cancel() may resolve while the first upstream cleanup
      // is still pending. Join the original promise before releasing ownership.
      await cancellation
      reader.releaseLock()
    },
  }
}

export class McpHttpClient {
  readonly #endpoint: string
  readonly #bearerToken: string | undefined
  readonly #forbiddenValues: string[]
  readonly #timeoutMs: number
  readonly #protocolVersion: McpProtocolVersion
  readonly #controllers = new Set<AbortController>()
  readonly #pending = new Set<Promise<void>>()
  #sessionId: string | undefined
  #initialization: Promise<void> | undefined
  #hasTools = false
  #invalid = false
  #closed = false
  #closePromise: Promise<void> | undefined

  constructor(options: McpHttpClientOptions) {
    this.#endpoint = endpoint(options.endpoint, options.allowLoopbackHttp === true)
    this.#protocolVersion = options.protocolVersion ?? MCP_PROTOCOL_VERSION
    if (this.#protocolVersion !== MCP_PROTOCOL_VERSION && this.#protocolVersion !== '2025-11-25') fail('configuration')
    if (options.bearerToken !== undefined && (!options.bearerToken.length || options.bearerToken.length > 8192 || !/^[\x21-\x7e]+$/.test(options.bearerToken))) fail('configuration')
    this.#bearerToken = options.bearerToken
    this.#forbiddenValues = [...new Set([options.bearerToken, ...(options.forbiddenValues ?? [])].filter((item): item is string => typeof item === 'string' && item.length > 0))]
    this.#timeoutMs = options.timeoutMs ?? 30_000
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1 || this.#timeoutMs > 120_000) fail('configuration')
    this.assertNoSecrets(this.#endpoint)
  }

  async discoverTools(signal: AbortSignal): Promise<McpTool[]> {
    return this.operation(signal, async operation => {
      if (this.legacy) {
        await this.initialize(operation)
        if (!this.#hasTools) return []
      } else {
        const discovery = await this.request('server/discover', {}, {}, operation)
        if (discovery.resultType !== 'complete' || !Array.isArray(discovery.supportedVersions) ||
            discovery.supportedVersions.some(version => typeof version !== 'string') ||
            !discovery.supportedVersions.includes(MCP_PROTOCOL_VERSION) || !object(discovery.capabilities)) fail('unsupported_server')
        if (!own(discovery.capabilities, 'tools')) return []
        if (!object(discovery.capabilities.tools)) fail('response_schema')
      }
      const tools: McpTool[] = []
      const names = new Set<string>()
      const cursors = new Set<string>()
      let cursor: string | undefined
      let count = 0
      for (let page = 0; page < LIMIT.pages; page++) {
        const result = await this.request('tools/list', cursor === undefined ? {} : { cursor }, {}, operation)
        if (!this.completeResult(result) || !Array.isArray(result.tools)) fail('response_schema')
        count += result.tools.length
        if (count > LIMIT.tools) fail('catalog_limit')
        for (const candidate of result.tools) {
          let tool: McpTool
          try { tool = validateTool(candidate, this.legacy) } catch (error) {
            // MCP requires excluding invalid header annotations without hiding other tools.
            if (error instanceof McpClientError && error.code === 'tool_schema') continue
            throw error
          }
          if (names.has(tool.name)) fail('duplicate_tool')
          names.add(tool.name)
          tools.push(tool)
        }
        if (result.nextCursor === undefined) return tools
        if (typeof result.nextCursor !== 'string' || !result.nextCursor.length || result.nextCursor.length > 4096 || cursors.has(result.nextCursor)) fail('catalog_cursor')
        cursors.add(result.nextCursor)
        cursor = result.nextCursor
      }
      return fail('catalog_limit')
    })
  }

  async callTool(tool: McpTool, input: JsonObject, signal: AbortSignal): Promise<JsonObject> {
    return this.operation(signal, async operation => {
      const checkedTool = validateTool(tool, this.legacy)
      validateJson(input, 'tool_arguments')
      if (!object(input)) fail('tool_arguments')
      try { assertMcpToolInput(checkedTool.inputSchema, input) } catch { fail('tool_arguments') }
      this.assertNoSecrets(input)
      if (this.legacy) {
        await this.initialize(operation)
        if (!this.#hasTools) fail('unsupported_server')
      }
      const headers = this.legacy ? {} : toolHeaders(checkedTool, input)
      const result = await this.request('tools/call', { name: checkedTool.name, arguments: input }, headers, operation)
      return normalizeToolResult(result, checkedTool, this.legacy)
    })
  }

  private get legacy(): boolean { return this.#protocolVersion === '2025-11-25' }

  private completeResult(result: JsonObject): boolean {
    return this.legacy ? !own(result, 'resultType') : result.resultType === 'complete'
  }

  private assertAvailable(signal?: AbortSignal): void {
    if (this.#closed) fail('closed')
    if (this.#invalid) fail('session_expired')
    if (signal?.aborted) fail('cancelled')
  }

  private async initialize(operation: Operation): Promise<void> {
    this.assertAvailable(operation.signal)
    if (!this.#initialization) this.#initialization = (async () => {
      const result = await this.request('initialize', {
        protocolVersion: this.#protocolVersion,
        capabilities: {}, clientInfo: { name: 'cc-desk-native', version: '0.0.0' },
      }, {}, operation)
      const hasTools = validateInitialization(result, this.#protocolVersion)
      await this.postAcknowledged({ jsonrpc: '2.0', method: 'notifications/initialized' }, operation.signal)
      this.#hasTools = hasTools
    })()
    // Concurrent discovery shares the handshake, but an aborted waiter does not cancel it.
    await new Promise<void>((resolve, reject) => {
      const abort = (): void => { reject(new McpClientError('cancelled', 'not_executed')) }
      if (operation.signal.aborted) { abort(); return }
      operation.signal.addEventListener('abort', abort, { once: true })
      this.#initialization!.then(resolve, reject).finally(() => operation.signal.removeEventListener('abort', abort))
    })
    this.assertAvailable(operation.signal)
  }

  /** Abort and join every local request before best-effort remote session disposal. */
  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise
    this.#closed = true
    for (const controller of this.#controllers) controller.abort()
    this.#closePromise = (async () => {
      await Promise.all([...this.#pending])
      // A handshake can be settling after its caller was aborted; it may never
      // continue into tools/list or tools/call after this point.
      await this.#initialization?.catch(() => undefined)
      if (this.legacy && this.#sessionId) {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), LIMIT.cleanupMs)
        try {
          const response = await fetch(this.#endpoint, { method: 'DELETE', headers: this.headers(), signal: controller.signal,
            redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' })
          // DELETE is advisory: 404/405 and all other failures cannot establish
          // that a remote task stopped, and do not retain local session ownership.
          await response.body?.cancel().catch(() => undefined)
        } catch { /* No remote body, headers or diagnostic escape cleanup. */ }
        finally { clearTimeout(timer); controller.abort() }
      }
    })()
    return this.#closePromise
  }

  private async operation<T>(signal: AbortSignal, action: (operation: Operation) => Promise<T>): Promise<T> {
    this.assertAvailable(signal)
    const controller = new AbortController()
    let finish!: () => void
    const pending = new Promise<void>(resolve => { finish = resolve })
    this.#pending.add(pending)
    this.#controllers.add(controller)
    let timedOut = false
    const abort = (): void => { controller.abort() }
    signal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => { if (!controller.signal.aborted) { timedOut = true; controller.abort() } }, this.#timeoutMs)
    const operation: Operation = { signal: controller.signal, sentCall: false, bytes: 0, serverPings: 0 }
    try { return await action(operation) } catch (error) {
      const outcome = operation.sentCall ? 'unknown' : 'not_executed'
      if (timedOut) throw new McpClientError('timeout', outcome)
      if (signal.aborted) throw new McpClientError('cancelled', outcome)
      if (this.#closed) throw new McpClientError('closed', outcome)
      if (this.#invalid) throw new McpClientError('session_expired', outcome)
      if (error instanceof McpClientError) throw new McpClientError(error.code, operation.sentCall && error.outcome === 'not_executed' ? 'unknown' : error.outcome)
      throw new McpClientError('transport', outcome)
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      controller.abort()
      this.#controllers.delete(controller)
      this.#pending.delete(pending)
      finish()
    }
  }

  private assertNoSecrets(value: unknown): void { assertNoSecrets(value, this.#forbiddenValues) }

  private parse(text: string): JsonObject { return parseMessage(text, this.#forbiddenValues) }

  private envelope(message: JsonObject, id: string, allowNotification: boolean): JsonObject | undefined {
    return envelope(message, id, allowNotification)
  }

  private headers(method?: string, extra: Record<string, string> = {}): Record<string, string> {
    return { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json',
      ...(this.legacy && method === 'initialize' ? {} : { 'MCP-Protocol-Version': this.#protocolVersion }),
      ...(!this.legacy && method ? { 'Mcp-Method': method } : {}), ...extra,
      ...(this.#sessionId ? { 'Mcp-Session-Id': this.#sessionId } : {}),
      ...(this.#bearerToken ? { Authorization: `Bearer ${this.#bearerToken}` } : {}) }
  }

  private checkSession(response: Response, initialize = false): void {
    if (!this.legacy) return
    if (response.status === 404 && !initialize) {
      this.#invalid = true
      for (const controller of this.#controllers) controller.abort()
      fail('session_expired')
    }
    const session = response.headers.get('mcp-session-id')
    if (session === null) return
    if (!session.length || session.length > 1024 || !/^[\x21-\x7e]+$/.test(session) ||
        (!initialize && session !== this.#sessionId) || (initialize && this.#sessionId !== undefined && session !== this.#sessionId)) {
      this.#invalid = true
      for (const controller of this.#controllers) controller.abort()
      fail('session_expired')
    }
    if (initialize) {
      this.#sessionId = session
      if (!this.#forbiddenValues.includes(session)) this.#forbiddenValues.push(session)
    }
  }

  private async postAcknowledged(message: JsonObject, signal: AbortSignal, cleanup = false): Promise<void> {
    if (!cleanup) this.assertAvailable(signal)
    const body = JSON.stringify(message)
    this.assertNoSecrets(body)
    if (Buffer.byteLength(body) > LIMIT.requestBytes) fail('request_limit')
    const response = await fetch(this.#endpoint, { method: 'POST', headers: this.headers(typeof message.method === 'string' ? message.method : undefined),
      body, signal, redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' })
    const bodyReader = responseReader(response, signal)
    const reader = bodyReader?.reader
    try {
      this.checkSession(response)
      if (response.status !== 202) fail('http_error')
      if (reader) {
        const first = await reader.read()
        if (signal.aborted) fail('cancelled')
        if (!first.done) fail('response_schema')
      }
    } finally {
      await bodyReader?.close()
    }
  }

  private async cancelRequest(id: string): Promise<void> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), LIMIT.cleanupMs)
    try {
      await this.postAcknowledged({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id } }, controller.signal, true)
    } catch { /* Cancellation acknowledgement never proves whether the tool ran. */ }
    finally { clearTimeout(timer); controller.abort() }
  }

  private async request(method: string, params: JsonObject, extraHeaders: Record<string, string>, operation: Operation): Promise<JsonObject> {
    this.assertAvailable(operation.signal)
    const id = randomUUID()
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params: this.legacy ? params : { ...params, _meta: {
      'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_VERSION,
      'io.modelcontextprotocol/clientInfo': { name: 'cc-desk-native', version: '0.0.0' },
      'io.modelcontextprotocol/clientCapabilities': {},
    } } })
    this.assertNoSecrets(body)
    if (Buffer.byteLength(body) > LIMIT.requestBytes) fail('request_limit')
    // Once fetch receives a call, transport failures cannot prove whether it executed.
    if (method === 'tools/call') operation.sentCall = true
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    let bodyReader: ReturnType<typeof responseReader>
    let received = false
    try {
      const response = await fetch(this.#endpoint, { method: 'POST', headers: this.headers(method, extraHeaders), body, signal: operation.signal,
        redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' })
      bodyReader = responseReader(response, operation.signal)
      reader = bodyReader?.reader
      this.checkSession(response, method === 'initialize')
      if (!reader) fail('response_empty')
      const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase()
      if (contentType !== 'application/json' && contentType !== 'text/event-stream') fail('response_type')
      const decoder = new TextDecoder('utf-8', { fatal: true })
      let bytes = 0
      let text = ''
      let result: JsonObject | undefined
      const pings: JsonValue[] = []
      const sse = contentType === 'text/event-stream' ? new SseParser(data => {
        if (data === '') return // Empty SSE primers carry no JSON-RPC message.
        if (result !== undefined) fail('response_schema')
        const message = this.parse(data)
        if (this.legacy && message.jsonrpc === '2.0' && message.method === 'ping' && own(message, 'id') &&
            !own(message, 'result') && !own(message, 'error') && (!own(message, 'params') || object(message.params)) &&
            (typeof message.id === 'string' && message.id.length > 0 && message.id.length <= 128 || typeof message.id === 'number' && Number.isSafeInteger(message.id))) {
          if (++operation.serverPings > LIMIT.serverPings) fail('server_request_limit')
          pings.push(message.id)
          return
        }
        result = this.envelope(message, id, true)
      }) : undefined
      while (true) {
        const chunk = await reader.read()
        if (operation.signal.aborted) fail('cancelled')
        if (chunk.done) break
        bytes += chunk.value.byteLength
        operation.bytes += chunk.value.byteLength
        if (bytes > LIMIT.responseBytes || operation.bytes > LIMIT.discoveryBytes) fail('response_limit')
        const decoded = decoder.decode(chunk.value, { stream: true })
        if (sse) {
          sse.push(decoded)
          for (const pingId of pings.splice(0)) await this.postAcknowledged({ jsonrpc: '2.0', id: pingId, result: {} }, operation.signal)
          if (result !== undefined) break
        } else text += decoded
      }
      const remainder = decoder.decode()
      if (sse) sse.push(remainder)
      else result = this.envelope(this.parse(text + remainder), id, false)
      if (!response.ok) fail('http_error')
      if (result === undefined) fail('response_incomplete')
      received = true
      return result
    } finally {
      await bodyReader?.close()
      if (this.legacy && method !== 'initialize' && !received && operation.signal.aborted && !this.#invalid) await this.cancelRequest(id)
    }
  }
}
