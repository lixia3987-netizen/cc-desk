import type { JsonObject, JsonValue } from '@cc-desk/agent-core'
import { assertMcpInputSchema, assertMcpOutputSchema, assertMcpToolOutput } from './mcp-schema.js'

/** This client intentionally does not negotiate or fall back to older MCP revisions. */
export const MCP_PROTOCOL_VERSION = '2026-07-28'
export type McpProtocolVersion = typeof MCP_PROTOCOL_VERSION | '2025-11-25'

export interface McpTool {
  name: string
  description?: string
  inputSchema: JsonObject
  outputSchema?: JsonObject
}

export type McpCallOutcome = 'not_executed' | 'unknown' | 'failed'

/** Errors never contain a remote body, endpoint, header, credential, or original cause. */
export class McpClientError extends Error {
  constructor(readonly code: string, readonly outcome: McpCallOutcome) {
    super(`MCP request failed (${code}).`)
    this.name = 'McpClientError'
  }
}

export const LIMIT = {
  responseBytes: 1024 * 1024,
  discoveryBytes: 2 * 1024 * 1024,
  requestBytes: 128 * 1024,
  pages: 8,
  tools: 64,
  schemaBytes: 16 * 1024,
  descriptionBytes: 8192,
  headers: 64,
  headerBytes: 8192,
  serverPings: 8,
  cleanupMs: 2000,
  depth: 32,
  nodes: 16384,
} as const

export const object = (value: unknown): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value)
export const own = (value: JsonObject, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key)
export function fail(code: string, outcome: McpCallOutcome = 'not_executed'): never { throw new McpClientError(code, outcome) }

export function validateJson(value: unknown, code: string): asserts value is JsonValue {
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

export interface HeaderParameter { path: string[]; name: string; type: 'string' | 'integer' | 'boolean' }

/** Find all annotations, including invalid ones hidden under array/composition/$ref branches. */
export function headerParameters(schema: JsonObject): HeaderParameter[] {
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

export function validateTool(value: unknown, legacy = false): McpTool {
  validateJson(value, 'tool_schema')
  if (!object(value) || typeof value.name !== 'string' || !value.name.length || value.name.length > 128 ||
      !object(value.inputSchema) || value.inputSchema.type !== 'object' ||
      (value.description !== undefined && (typeof value.description !== 'string' || Buffer.byteLength(value.description) > LIMIT.descriptionBytes)) ||
      Buffer.byteLength(JSON.stringify(value.inputSchema)) > LIMIT.schemaBytes) fail('tool_schema')
  if (!legacy) headerParameters(value.inputSchema)
  try {
    assertMcpInputSchema(value.inputSchema)
    if (own(value, 'outputSchema')) {
      if (!object(value.outputSchema) || legacy && value.outputSchema.type !== 'object') fail('tool_schema')
      assertMcpOutputSchema(value.outputSchema)
    }
  } catch { fail('tool_schema') }
  if (own(value, 'execution') && (!object(value.execution) ||
      (value.execution.taskSupport !== undefined && !['optional', 'forbidden'].includes(String(value.execution.taskSupport))))) fail('tool_schema')
  // Server annotations, instructions, icons and extension metadata grant no local privileges.
  return { name: value.name, ...(typeof value.description === 'string' ? { description: value.description } : {}), inputSchema: value.inputSchema,
    ...(object(value.outputSchema) ? { outputSchema: value.outputSchema } : {}) }
}

export function assertNoSecrets(value: unknown, forbiddenValues: readonly string[]): void {
  if (!forbiddenValues.length) return
  const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }]
  const strings: string[] = []
  let visited = 0
  while (pending.length) {
    const item = pending.pop()!
    if (++visited > LIMIT.nodes * 4 || item.depth > LIMIT.depth * 2) fail('response_limit')
    if (typeof item.value === 'string') {
      const text = item.value
      strings.push(text)
      if (forbiddenValues.some(secret => text.includes(secret))) fail('credential_echo')
      // Also inspect escaped JSON strings that downstream tools may decode.
      if (/^\s*[\[{"]/.test(item.value)) {
        try { pending.push({ value: JSON.parse(item.value), depth: item.depth + 1 }) } catch { /* ordinary text */ }
      }
    } else if (Array.isArray(item.value)) {
      for (let index = item.value.length - 1; index >= 0; index--) pending.push({ value: item.value[index], depth: item.depth + 1 })
    } else if (object(item.value)) {
      for (const [key, child] of Object.entries(item.value)) {
        if (forbiddenValues.some(secret => key.includes(secret))) fail('credential_echo')
        pending.push({ value: child, depth: item.depth + 1 })
      }
      if (Array.isArray(item.value.content)) {
        pending.push({ value: item.value.content.filter(part => object(part) && typeof part.text === 'string').map(part => (part as JsonObject).text).join(''), depth: item.depth + 1 })
      }
    }
  }
  const joined = strings.join('')
  if (forbiddenValues.some(secret => joined.includes(secret))) fail('credential_echo')
}

export function parseMessage(text: string, forbiddenValues: readonly string[]): JsonObject {
  assertNoSecrets(text, forbiddenValues)
  let value: unknown
  try { value = JSON.parse(text) } catch { return fail('response_json') }
  validateJson(value, 'response_schema')
  assertNoSecrets(value, forbiddenValues)
  if (!object(value)) fail('response_schema')
  return value
}

export function envelope(message: JsonObject, id: string, allowNotification: boolean): JsonObject | undefined {
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


/** Normalize the bounded synchronous result subset shared by both transports. */
export function normalizeToolResult(result: JsonObject, tool: McpTool, legacy: boolean): JsonObject {
  if ((legacy ? own(result, 'resultType') : result.resultType !== 'complete') || !Array.isArray(result.content) ||
      (result.isError !== undefined && typeof result.isError !== 'boolean') || own(result, 'inputRequests') || own(result, 'requestState') || own(result, 'task') ||
      (legacy && own(result, 'structuredContent') && !object(result.structuredContent))) fail('unsupported_result', 'unknown')
  if (result.content.some(item => !object(item) || item.type !== 'text' || typeof item.text !== 'string')) fail('unsupported_content', 'unknown')
  if (tool.outputSchema && (own(result, 'structuredContent') || result.isError !== true)) {
    if (!own(result, 'structuredContent')) fail('output_schema', 'unknown')
    try { assertMcpToolOutput(tool.outputSchema, result.structuredContent) } catch { fail('output_schema', 'unknown') }
  }
  return { resultType: 'complete', content: result.content.map(item => ({ type: 'text', text: (item as JsonObject).text })),
    ...(own(result, 'structuredContent') ? { structuredContent: result.structuredContent } : {}),
    ...(typeof result.isError === 'boolean' ? { isError: result.isError } : {}) }
}

export function validateInitialization(result: JsonObject, version: McpProtocolVersion): boolean {
  if (result.protocolVersion !== version) fail('unsupported_server')
  if (own(result, 'resultType') || !object(result.serverInfo) ||
      typeof result.serverInfo.name !== 'string' || !result.serverInfo.name.length || result.serverInfo.name.length > 200 ||
      typeof result.serverInfo.version !== 'string' || !result.serverInfo.version.length || result.serverInfo.version.length > 200 ||
      !object(result.capabilities) || (own(result.capabilities, 'tools') && !object(result.capabilities.tools))) fail('response_schema')
  return own(result.capabilities, 'tools')
}
