import { randomUUID } from 'node:crypto'
import type { JsonObject } from '@cc-desk/agent-core'
import type { ProcessSupervisor, StdioProcessHandle } from './process-supervisor.js'
import { assertMcpToolInput } from './mcp-schema.js'
import { LIMIT, McpClientError, object, own, fail, validateJson, validateTool, assertNoSecrets, parseMessage,
  envelope, normalizeToolResult, validateInitialization, type McpTool } from './mcp-protocol.js'

export interface McpStdioClientOptions {
  supervisor: ProcessSupervisor
  ownerId: string
  executable: string
  argv: string[]
  cwd: string
  /** Explicitly resolved connection values; never the host's complete environment. */
  environment?: Record<string, string>
  forbiddenValues?: readonly (string | undefined)[]
  timeoutMs?: number
}

interface Operation { signal: AbortSignal; sentCall: boolean; bytes: number }
interface Request {
  resolve(result: JsonObject): void
  reject(error: McpClientError): void
}

/** A single owned 2025-11-25 process session. It never restarts or replays requests. */
export class McpStdioClient {
  readonly #options: McpStdioClientOptions
  readonly #forbidden: string[]
  readonly #timeoutMs: number
  readonly #lifetime = new AbortController()
  readonly #controllers = new Set<AbortController>()
  readonly #operations = new Set<Operation>()
  readonly #pendingOperations = new Set<Promise<void>>()
  readonly #requests = new Map<string, Request>()
  readonly #retired = new Set<string>()
  #handle: StdioProcessHandle | undefined
  #starting: Promise<StdioProcessHandle> | undefined
  #initialization: Promise<void> | undefined
  #hasTools = false
  #failure: McpClientError | undefined
  #cleanupFailure: Error | undefined
  #closed = false
  #closing: Promise<void> | undefined
  #terminating: Promise<void> | undefined
  #frame = Buffer.alloc(0)
  #receivedBytes = 0
  #serverRequests = 0
  #notifications = 0

  constructor(options: McpStdioClientOptions) {
    if (!options || !Array.isArray(options.argv) || options.argv.some(value => typeof value !== 'string')) fail('configuration')
    this.#options = { ...options, argv: [...options.argv], environment: options.environment ? { ...options.environment } : undefined }
    this.#forbidden = [...new Set([...(options.forbiddenValues ?? []), ...Object.values(options.environment ?? {})]
      .filter((value): value is string => typeof value === 'string' && value.length > 0))]
    this.#timeoutMs = options.timeoutMs ?? 30_000
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1 || this.#timeoutMs > 120_000 ||
        !options.ownerId || !options.supervisor) fail('configuration')
  }

  async discoverTools(signal: AbortSignal): Promise<McpTool[]> {
    return this.operation(signal, async operation => {
      await this.initialize(operation)
      if (!this.#hasTools) return []
      const tools: McpTool[] = []
      const names = new Set<string>()
      const cursors = new Set<string>()
      let cursor: string | undefined
      let count = 0
      for (let page = 0; page < LIMIT.pages; page++) {
        const result = await this.request('tools/list', cursor === undefined ? {} : { cursor }, operation)
        if (own(result, 'resultType') || !Array.isArray(result.tools)) fail('response_schema')
        count += result.tools.length
        if (count > LIMIT.tools) fail('catalog_limit')
        for (const candidate of result.tools) {
          let tool: McpTool
          try { tool = validateTool(candidate, true) } catch (error) {
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
      const checked = validateTool(tool, true)
      validateJson(input, 'tool_arguments')
      if (!object(input)) fail('tool_arguments')
      try { assertMcpToolInput(checked.inputSchema, input) } catch { fail('tool_arguments') }
      assertNoSecrets(input, this.#forbidden)
      await this.initialize(operation)
      if (!this.#hasTools) fail('unsupported_server')
      const result = await this.request('tools/call', { name: checked.name, arguments: input }, operation)
      return normalizeToolResult(result, checked, true)
    })
  }

  /** Join requests and process-tree cleanup before releasing host ownership. */
  close(): Promise<void> {
    if (this.#closing) return this.#closing
    this.#closed = true
    for (const controller of this.#controllers) controller.abort()
    this.#closing = (async () => {
      // Request cancellation notices are bounded and settle before process disposal.
      await Promise.all([...this.#pendingOperations])
      await this.terminate()
      if (this.#cleanupFailure) throw this.#cleanupFailure
    })()
    return this.#closing
  }

  private available(signal?: AbortSignal): void {
    if (this.#closed) fail('closed')
    if (this.#failure) throw this.#failure
    if (signal?.aborted) fail('cancelled')
  }

  private invalidate(error: unknown): McpClientError {
    const safe = error instanceof McpClientError ? error : new McpClientError('transport', 'not_executed')
    this.#failure ??= safe
    for (const pending of this.#requests.values()) pending.reject(this.#failure)
    this.#requests.clear()
    return this.#failure
  }

  private cleanupError(): Error {
    return Object.assign(new Error('MCP process cleanup could not be confirmed.'), { cleanupUnconfirmed: true })
  }

  private terminate(): Promise<void> {
    if (this.#terminating) return this.#terminating
    this.#terminating = (async () => {
      let handle = this.#handle
      if (!handle) this.#lifetime.abort()
      try { handle ??= await this.#starting } catch (error) {
        if (object(error) && error.cleanupUnconfirmed === true) this.#cleanupFailure ??= this.cleanupError()
      }
      if (!handle) return
      try {
        const result = await handle.close()
        if (result.cleanup !== 'released') this.#cleanupFailure ??= this.cleanupError()
      } catch { this.#cleanupFailure ??= this.cleanupError() }
      finally { this.#lifetime.abort() }
    })()
    return this.#terminating
  }

  private async start(signal: AbortSignal): Promise<void> {
    this.available(signal)
    if (!this.#starting) {
      this.#starting = Promise.resolve().then(() => this.#options.supervisor.openStdio(this.#options.ownerId, {
        executable: this.#options.executable, argv: this.#options.argv, cwd: this.#options.cwd,
        environment: this.#options.environment, maxInputBytes: LIMIT.requestBytes + 1, onStdout: chunk => this.receive(chunk),
      }, this.#lifetime.signal, this.#forbidden)).then(handle => {
        this.#handle = handle
        void handle.closed.then(result => {
          if (result.cleanup !== 'released') this.#cleanupFailure ??= this.cleanupError()
          this.invalidate(new McpClientError(this.#frame.length ? 'response_incomplete' : 'transport_closed', 'not_executed'))
        }, () => { this.#cleanupFailure ??= this.cleanupError(); this.invalidate(new McpClientError('transport_closed', 'not_executed')) })
        return handle
      })
    }
    await this.wait(this.#starting, signal)
    this.available(signal)
  }

  private async initialize(operation: Operation): Promise<void> {
    this.available(operation.signal)
    if (!this.#initialization) this.#initialization = (async () => {
      await this.start(operation.signal)
      const result = await this.request('initialize', {
        protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'cc-desk-native', version: '0.0.0' },
      }, operation)
      const hasTools = validateInitialization(result, '2025-11-25')
      await this.wait(this.write({ jsonrpc: '2.0', method: 'notifications/initialized' }), operation.signal)
      this.available(operation.signal)
      this.#hasTools = hasTools
    })()
    await this.wait(this.#initialization, operation.signal)
    this.available(operation.signal)
  }

  private wait<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      const abort = (): void => reject(new McpClientError('cancelled', 'not_executed'))
      if (signal.aborted) { promise.catch(() => undefined); abort(); return }
      signal.addEventListener('abort', abort, { once: true })
      promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
    })
  }

  private async operation<T>(signal: AbortSignal, action: (operation: Operation) => Promise<T>): Promise<T> {
    this.available(signal)
    const controller = new AbortController()
    let finish!: () => void
    const pending = new Promise<void>(resolve => { finish = resolve })
    this.#pendingOperations.add(pending)
    this.#controllers.add(controller)
    let timedOut = false
    const abort = (): void => controller.abort()
    signal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => { if (!controller.signal.aborted) { timedOut = true; controller.abort() } }, this.#timeoutMs)
    const operation: Operation = { signal: controller.signal, sentCall: false, bytes: 0 }
    this.#operations.add(operation)
    try { return await action(operation) } catch (error) {
      const safe = this.invalidate(error)
      await this.terminate()
      if (this.#cleanupFailure) throw Object.assign(new McpClientError('cleanup_failed', operation.sentCall ? 'unknown' : 'not_executed'), { cleanupUnconfirmed: true })
      const code = timedOut ? 'timeout' : signal.aborted ? 'cancelled' : this.#closed ? 'closed' : safe.code
      throw new McpClientError(code, operation.sentCall ? 'unknown' : safe.outcome)
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      controller.abort()
      this.#controllers.delete(controller)
      this.#operations.delete(operation)
      this.#pendingOperations.delete(pending)
      finish()
    }
  }

  private async write(message: JsonObject): Promise<void> {
    const line = JSON.stringify(message)
    assertNoSecrets(line, this.#forbidden)
    if (Buffer.byteLength(line) > LIMIT.requestBytes) fail('request_limit')
    if (!this.#handle) fail('transport')
    await this.#handle.write(`${line}\n`)
  }

  private async cancel(id: string): Promise<void> {
    let timer: NodeJS.Timeout | undefined
    try {
      await Promise.race([this.write({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id } }),
        new Promise<void>(resolve => { timer = setTimeout(resolve, LIMIT.cleanupMs) })])
    } catch { /* A notification cannot establish whether a tool executed. */ }
    finally { clearTimeout(timer) }
  }

  private async request(method: string, params: JsonObject, operation: Operation): Promise<JsonObject> {
    this.available(operation.signal)
    if (this.#requests.size >= LIMIT.tools) fail('request_limit')
    const id = randomUUID()
    // Validate the complete outbound frame before classifying a tool call as issued.
    const message = { jsonrpc: '2.0', id, method, params }
    const serialized = JSON.stringify(message)
    assertNoSecrets(serialized, this.#forbidden)
    if (Buffer.byteLength(serialized) > LIMIT.requestBytes) fail('request_limit')
    let resolve!: (result: JsonObject) => void
    let reject!: (error: McpClientError) => void
    const response = new Promise<JsonObject>((done, failed) => { resolve = done; reject = failed })
    // Attach before write: local fixtures and fast children may answer synchronously.
    this.#requests.set(id, { resolve, reject })
    response.catch(() => undefined)
    let complete = false
    try {
      if (method === 'tools/call') operation.sentCall = true
      await this.wait(this.write(message), operation.signal)
      const result = await this.wait(response, operation.signal)
      this.available(operation.signal)
      complete = true
      return result
    } finally {
      this.#requests.delete(id)
      if (!complete) {
        this.#retired.add(id)
        if (this.#retired.size > LIMIT.tools) this.#retired.delete(this.#retired.values().next().value!)
        if (method !== 'initialize' && operation.signal.aborted) await this.cancel(id)
      }
    }
  }

  /** stdout is protocol data only. No stderr or child diagnostic reaches this parser. */
  private receive(chunk: Buffer): void {
    if (this.#failure || this.#closed) return
    try {
      this.#receivedBytes += chunk.length
      // Bound lifetime notifications and idle output as well as individual operations.
      if (this.#receivedBytes > 16 * LIMIT.discoveryBytes) fail('response_limit')
      for (const operation of this.#operations) {
        operation.bytes += chunk.length
        if (operation.bytes > LIMIT.discoveryBytes) fail('response_limit')
      }
      let offset = 0
      while (offset < chunk.length) {
        const newline = chunk.indexOf(10, offset)
        const end = newline < 0 ? chunk.length : newline
        const part = chunk.subarray(offset, end)
        if (this.#frame.length + part.length > LIMIT.responseBytes) fail('response_limit')
        this.#frame = this.#frame.length ? Buffer.concat([this.#frame, part]) : Buffer.from(part)
        if (newline < 0) break
        const text = new TextDecoder('utf-8', { fatal: true }).decode(this.#frame)
        this.#frame = Buffer.alloc(0)
        this.consume(parseMessage(text, this.#forbidden))
        offset = newline + 1
      }
    } catch (error) {
      this.invalidate(error)
      void this.terminate()
    }
  }

  private consume(message: JsonObject): void {
    if (message.jsonrpc !== '2.0') fail('response_schema')
    if (typeof message.method === 'string') {
      if (own(message, 'result') || own(message, 'error') || own(message, 'params') && !object(message.params)) fail('response_schema')
      if (!own(message, 'id')) {
        if (!message.method.startsWith('notifications/')) fail('response_schema')
        if (++this.#notifications > 128) fail('server_request_limit')
        return
      }
      if (!(typeof message.id === 'string' && message.id.length > 0 && message.id.length <= 128 ||
          typeof message.id === 'number' && Number.isSafeInteger(message.id))) fail('response_schema')
      if (++this.#serverRequests > LIMIT.serverPings) fail('server_request_limit')
      const response: JsonObject = message.method === 'ping'
        ? { jsonrpc: '2.0', id: message.id, result: {} }
        : { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not supported.' } }
      // Early unsolicited requests cannot enqueue output before process ownership exists.
      if (!this.#handle) fail('response_schema')
      void this.write(response).catch(error => { this.invalidate(error); void this.terminate() })
      return
    }
    if (typeof message.id !== 'string') fail('response_schema')
    if (this.#retired.has(message.id)) return
    const pending = this.#requests.get(message.id)
    if (!pending) fail('response_schema')
    const result = envelope(message, message.id, false)
    if (!result) fail('response_schema')
    this.#requests.delete(message.id)
    pending.resolve(result)
  }
}
