import { randomUUID } from 'node:crypto'
import type { JsonObject, JsonValue } from '@cc-desk/agent-core'
import { assertMcpInputSchema, assertMcpToolInput } from './mcp-schema.js'

/** This client intentionally does not negotiate or fall back to older MCP revisions. */
export const MCP_PROTOCOL_VERSION = '2026-07-28'

export interface McpTool {
  name: string
  description?: string
  inputSchema: JsonObject
}

export interface McpHttpClientOptions {
  endpoint: string
  allowLoopbackHttp?: boolean
  bearerToken?: string
  forbiddenValues?: readonly (string | undefined)[]
  /** Applies to the entire discovery operation, including all catalog pages. */
  timeoutMs?: number
}

export type McpCallOutcome = 'not_executed' | 'unknown' | 'failed'

/** Errors never contain a remote body, endpoint, header, credential, or original cause. */
export class McpClientError extends Error {
  constructor(readonly code: string, readonly outcome: McpCallOutcome) {
    super(`MCP request failed (${code}).`)
    this.name = 'McpClientError'
  }
}

const LIMIT = {
  responseBytes: 1024 * 1024,
  discoveryBytes: 2 * 1024 * 1024,
  requestBytes: 128 * 1024,
  pages: 8,
  tools: 64,
  schemaBytes: 16 * 1024,
  descriptionBytes: 8192,
  headers: 64,
  headerBytes: 8192,
  depth: 32,
  nodes: 16384,
} as const

const object = (value: unknown): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value)
const own = (value: JsonObject, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key)
function fail(code: string, outcome: McpCallOutcome = 'not_executed'): never { throw new McpClientError(code, outcome) }

function validateJson(value: unknown, code: string): asserts value is JsonValue {
  const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }]
  let nodes = 0
  while (pending.length) {
    const item = pending.pop()!
    if (++nodes > LIMIT.nodes || item.depth > LIMIT.depth) fail(code)
    const current = item.value
    if (current === null || typeof current === 'string' || typeof current === 'boolean') continue
    if (typeof current === 'number' && Number.isFinite(current)) continue
    if (Array.isArray(current) || object(current)) {
      if (!Array.isArray(current) && Object.getPrototypeOf(current) !== Object.prototype && Object.getPrototypeOf(current) !== null) fail(code)
      for (const child of Object.values(current)) pending.push({ value: child, depth: item.depth + 1 })
    } else fail(code)
  }
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

interface HeaderParameter { path: string[]; name: string; type: 'string' | 'integer' | 'boolean' }

/** Find all annotations, including invalid ones hidden under array/composition/$ref branches. */
function headerParameters(schema: JsonObject): HeaderParameter[] {
  const result: HeaderParameter[] = []
  const names = new Set<string>()
  const visit = (value: JsonValue, path: string[] | null, isProperty: boolean): void => {
    if (Array.isArray(value)) {
      for (const child of value) visit(child, null, false)
      return
    }
    if (!object(value)) return
    if (own(value, 'x-mcp-header')) {
      const name = value['x-mcp-header']
      if (!isProperty || !path || typeof name !== 'string' || name.length > 128 ||
          !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || names.has(name.toLowerCase()) ||
          !['string', 'integer', 'boolean'].includes(String(value.type)) || typeof value.type !== 'string' ||
          own(value, '$ref')) fail('tool_schema')
      names.add(name.toLowerCase())
      result.push({ path, name, type: value.type as HeaderParameter['type'] })
      if (result.length > LIMIT.headers) fail('tool_schema')
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === 'properties' && path && !own(value, '$ref') && object(child)) {
        for (const [property, definition] of Object.entries(child)) visit(definition, [...path, property], true)
      } else visit(child, null, false)
    }
  }
  visit(schema, [], false)
  return result
}

function validateTool(value: unknown): McpTool {
  validateJson(value, 'tool_schema')
  if (!object(value) || typeof value.name !== 'string' || !value.name.length || value.name.length > 128 ||
      !object(value.inputSchema) || value.inputSchema.type !== 'object' ||
      (value.description !== undefined && (typeof value.description !== 'string' || Buffer.byteLength(value.description) > LIMIT.descriptionBytes)) ||
      Buffer.byteLength(JSON.stringify(value.inputSchema)) > LIMIT.schemaBytes) fail('tool_schema')
  headerParameters(value.inputSchema)
  try { assertMcpInputSchema(value.inputSchema) } catch { fail('tool_schema') }
  // Server annotations, instructions, icons and extension metadata grant no local privileges.
  return { name: value.name, ...(typeof value.description === 'string' ? { description: value.description } : {}), inputSchema: value.inputSchema }
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

interface Operation { signal: AbortSignal; sentCall: boolean; bytes: number }

export class McpHttpClient {
  readonly #endpoint: string
  readonly #bearerToken: string | undefined
  readonly #forbiddenValues: string[]
  readonly #timeoutMs: number

  constructor(options: McpHttpClientOptions) {
    this.#endpoint = endpoint(options.endpoint, options.allowLoopbackHttp === true)
    if (options.bearerToken !== undefined && (!options.bearerToken.length || options.bearerToken.length > 8192 || !/^[\x21-\x7e]+$/.test(options.bearerToken))) fail('configuration')
    this.#bearerToken = options.bearerToken
    this.#forbiddenValues = [...new Set([options.bearerToken, ...(options.forbiddenValues ?? [])].filter((item): item is string => typeof item === 'string' && item.length > 0))]
    this.#timeoutMs = options.timeoutMs ?? 30_000
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1 || this.#timeoutMs > 120_000) fail('configuration')
    this.assertNoSecrets(this.#endpoint)
  }

  async discoverTools(signal: AbortSignal): Promise<McpTool[]> {
    return this.operation(signal, async operation => {
      const discovery = await this.request('server/discover', {}, {}, operation)
      if (discovery.resultType !== 'complete' || !Array.isArray(discovery.supportedVersions) ||
          discovery.supportedVersions.some(version => typeof version !== 'string') ||
          !discovery.supportedVersions.includes(MCP_PROTOCOL_VERSION) || !object(discovery.capabilities)) fail('unsupported_server')
      if (!own(discovery.capabilities, 'tools')) return []
      if (!object(discovery.capabilities.tools)) fail('response_schema')
      const tools: McpTool[] = []
      const names = new Set<string>()
      const cursors = new Set<string>()
      let cursor: string | undefined
      let count = 0
      for (let page = 0; page < LIMIT.pages; page++) {
        const result = await this.request('tools/list', cursor === undefined ? {} : { cursor }, {}, operation)
        if (result.resultType !== 'complete' || !Array.isArray(result.tools)) fail('response_schema')
        count += result.tools.length
        if (count > LIMIT.tools) fail('catalog_limit')
        for (const candidate of result.tools) {
          let tool: McpTool
          try { tool = validateTool(candidate) } catch (error) {
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
      const checkedTool = validateTool(tool)
      validateJson(input, 'tool_arguments')
      if (!object(input)) fail('tool_arguments')
      try { assertMcpToolInput(checkedTool.inputSchema, input) } catch { fail('tool_arguments') }
      this.assertNoSecrets(input)
      const headers = toolHeaders(checkedTool, input)
      const result = await this.request('tools/call', { name: checkedTool.name, arguments: input }, headers, operation)
      if (result.resultType !== 'complete' || !Array.isArray(result.content) ||
          (result.isError !== undefined && typeof result.isError !== 'boolean') || own(result, 'inputRequests') || own(result, 'requestState')) fail('unsupported_result', 'unknown')
      // This release accepts text and structured JSON only. It never follows resource links,
      // runs server requests, opens elicitation URLs, or feeds unvalidated binary content onward.
      if (result.content.some(item => !object(item) || item.type !== 'text' || typeof item.text !== 'string')) fail('unsupported_content', 'unknown')
      return { resultType: 'complete', content: result.content.map(item => ({ type: 'text', text: (item as JsonObject).text })),
        ...(own(result, 'structuredContent') ? { structuredContent: result.structuredContent } : {}),
        ...(typeof result.isError === 'boolean' ? { isError: result.isError } : {}) }
    })
  }

  private async operation<T>(signal: AbortSignal, action: (operation: Operation) => Promise<T>): Promise<T> {
    if (signal.aborted) fail('cancelled')
    const controller = new AbortController()
    let timedOut = false
    const abort = (): void => { controller.abort() }
    signal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, this.#timeoutMs)
    const operation: Operation = { signal: controller.signal, sentCall: false, bytes: 0 }
    try { return await action(operation) } catch (error) {
      const outcome = operation.sentCall ? 'unknown' : 'not_executed'
      if (timedOut) throw new McpClientError('timeout', outcome)
      if (signal.aborted) throw new McpClientError('cancelled', outcome)
      if (error instanceof McpClientError) throw new McpClientError(error.code, operation.sentCall && error.outcome === 'not_executed' ? 'unknown' : error.outcome)
      throw new McpClientError('transport', outcome)
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      controller.abort()
    }
  }

  private assertNoSecrets(value: unknown): void {
    if (!this.#forbiddenValues.length) return
    const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }]
    const strings: string[] = []
    let visited = 0
    while (pending.length) {
      const item = pending.pop()!
      if (++visited > LIMIT.nodes * 4 || item.depth > LIMIT.depth * 2) fail('response_limit')
      if (typeof item.value === 'string') {
        const text = item.value
        strings.push(text)
        if (this.#forbiddenValues.some(secret => text.includes(secret))) fail('credential_echo')
        // Also inspect escaped JSON strings that downstream tools may decode.
        if (/^\s*[\[{"]/.test(item.value)) {
          try { pending.push({ value: JSON.parse(item.value), depth: item.depth + 1 }) } catch { /* ordinary text */ }
        }
      } else if (Array.isArray(item.value)) {
        for (let index = item.value.length - 1; index >= 0; index--) pending.push({ value: item.value[index], depth: item.depth + 1 })
      } else if (object(item.value)) {
        for (const [key, child] of Object.entries(item.value)) {
          if (this.#forbiddenValues.some(secret => key.includes(secret))) fail('credential_echo')
          pending.push({ value: child, depth: item.depth + 1 })
        }
        if (Array.isArray(item.value.content)) {
          pending.push({ value: item.value.content.filter(part => object(part) && typeof part.text === 'string').map(part => (part as JsonObject).text).join(''), depth: item.depth + 1 })
        }
      }
    }
    const joined = strings.join('')
    if (this.#forbiddenValues.some(secret => joined.includes(secret))) fail('credential_echo')
  }

  private parse(text: string): JsonObject {
    this.assertNoSecrets(text)
    let value: unknown
    try { value = JSON.parse(text) } catch { return fail('response_json') }
    validateJson(value, 'response_schema')
    this.assertNoSecrets(value)
    if (!object(value)) fail('response_schema')
    return value
  }

  private envelope(message: JsonObject, id: string, allowNotification: boolean): JsonObject | undefined {
    if (message.jsonrpc !== '2.0') fail('response_schema')
    if (allowNotification && typeof message.method === 'string' && message.method.startsWith('notifications/') && !own(message, 'id') && !own(message, 'result') && !own(message, 'error')) return undefined
    if (message.id !== id || own(message, 'method') || own(message, 'result') === own(message, 'error')) fail('response_schema')
    if (own(message, 'error')) {
      if (!object(message.error) || !Number.isInteger(message.error.code) || typeof message.error.message !== 'string') fail('response_schema')
      // Even an internal-error response can arrive after a tool committed effects.
      // Only a complete tool result determines completion; RPC errors do not.
      return fail('rpc_error')
    }
    if (!object(message.result)) fail('response_schema')
    return message.result
  }

  private async request(method: string, params: JsonObject, extraHeaders: Record<string, string>, operation: Operation): Promise<JsonObject> {
    if (operation.signal.aborted) fail('cancelled')
    const id = randomUUID()
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...params, _meta: {
      'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_VERSION,
      'io.modelcontextprotocol/clientInfo': { name: 'cc-desk-native', version: '0.0.0' },
      'io.modelcontextprotocol/clientCapabilities': {},
    } } })
    this.assertNoSecrets(body)
    if (Buffer.byteLength(body) > LIMIT.requestBytes) fail('request_limit')
    const headers = { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json',
      'MCP-Protocol-Version': MCP_PROTOCOL_VERSION, 'Mcp-Method': method, ...extraHeaders,
      ...(this.#bearerToken ? { Authorization: `Bearer ${this.#bearerToken}` } : {}) }
    // Once fetch receives a call, transport failures cannot prove whether it executed.
    if (method === 'tools/call') operation.sentCall = true
    const response = await fetch(this.#endpoint, { method: 'POST', headers, body, signal: operation.signal,
      redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' })
    const reader = response.body?.getReader()
    if (!reader) fail('response_empty')
    try {
      const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase()
      if (contentType !== 'application/json' && contentType !== 'text/event-stream') fail('response_type')
      const decoder = new TextDecoder('utf-8', { fatal: true })
      let bytes = 0
      let text = ''
      let result: JsonObject | undefined
      const sse = contentType === 'text/event-stream' ? new SseParser(data => {
        if (result !== undefined) fail('response_schema')
        result = this.envelope(this.parse(data), id, true)
      }) : undefined
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        bytes += chunk.value.byteLength
        operation.bytes += chunk.value.byteLength
        if (bytes > LIMIT.responseBytes || operation.bytes > LIMIT.discoveryBytes) fail('response_limit')
        const decoded = decoder.decode(chunk.value, { stream: true })
        if (sse) {
          sse.push(decoded)
          if (result !== undefined) break
        } else text += decoded
      }
      const remainder = decoder.decode()
      if (sse) sse.push(remainder)
      else result = this.envelope(this.parse(text + remainder), id, false)
      if (!response.ok) fail('http_error')
      if (result === undefined) fail('response_incomplete')
      return result
    } finally {
      await reader.cancel().catch(() => undefined)
      reader.releaseLock()
    }
  }
}
