import { createHash } from 'node:crypto';
import type { ApprovalDecision, JsonValue, PreparedTool, ToolCall, ToolDefinition, ToolExecutionContext, ToolPort, ToolResult } from '@cc-desk/agent-core';
import { McpClientError, McpHttpClient, type McpTool, type McpProtocolVersion } from './mcp-client.js';
import { assertMcpInputSchema, assertMcpToolInput, assertMcpOutputSchema, assertMcpToolOutput } from './mcp-schema.js';

const MAX_CONNECTIONS = 4;
const MAX_TOOLS = 64;
const MAX_METADATA_BYTES = 128 * 1024;
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_PREPARED = 256;
const canonical = (value: JsonValue): string => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));
const stopped = (signal: AbortSignal): void => { if (signal.aborted) throw new Error('MCP operation cancelled.'); };

export interface McpToolConnection {
  connectionId: string;
  revision: number;
  name: string;
  endpoint: string;
  allowLoopbackHttp: boolean;
  bearerToken?: string;
  protocolVersion?: McpProtocolVersion;
}
/** The host owns this handle until all local requests have settled. */
export interface ManagedMcpToolPort extends ToolPort { close(): Promise<void> }
export interface McpToolOptions {
  connections: McpToolConnection[];
  forbiddenValues?: readonly (string | undefined)[];
  assertOwnership?: () => void | Promise<void>;
  assertConnectionCurrent?: (id: string, revision: number) => void;
}
interface Entry {
  connection: McpToolConnection;
  client: McpHttpClient;
  remote: McpTool;
  remoteHash: string;
  definition: ToolDefinition;
}
interface PreparedState {
  prepared: PreparedTool;
  identity: string;
  entry: Entry;
  executed: boolean;
  result?: ToolResult;
}

/** Independent JSON complexity and known-secret checks surround schema validation. */
function checkedJson(value: unknown, forbidden: readonly string[]): asserts value is JsonValue {
  let nodes = 0;
  const seen = new Set<object>();
  const text = (part: string) => {
    if (forbidden.some(secret => part.includes(secret))) throw new Error('MCP data contains protected credential material.');
  };
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > 8192 || depth > 32) throw new Error('MCP data exceeds the JSON complexity budget.');
    if (typeof item === 'string') { text(item); return; }
    if (item === null || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) return;
    if (!item || typeof item !== 'object' || seen.has(item)) throw new Error('MCP data must be finite JSON.');
    seen.add(item);
    if (Array.isArray(item)) { for (const child of item) visit(child, depth + 1); }
    else {
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new Error('MCP data must be plain JSON.');
      for (const [key, child] of Object.entries(item)) { text(key); visit(child, depth + 1); }
    }
    seen.delete(item);
  };
  visit(value, 0);
}

class McpToolPort implements ManagedMcpToolPort {
  private readonly prepared = new Map<string, PreparedState>();
  private readonly entries: Map<string, Entry>;
  private closed = false;
  private closing?: Promise<void>;
  constructor(entries: Entry[], private readonly options: McpToolOptions, private readonly forbidden: string[], private readonly clients: McpHttpClient[]) {
    this.entries = new Map(entries.map(entry => [entry.definition.name, entry]));
  }
  get definitions(): ToolDefinition[] { return [...this.entries.values()].map(entry => structuredClone(entry.definition)); }
  private assertOpen(): void { if (this.closed) throw new Error('MCP tool port is closed.'); }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = closeClients(this.clients);
    return this.closing;
  }
  private key(call: ToolCall, context: ToolExecutionContext): string { return `${context.identity.runId}\0${context.identity.workerGeneration}\0${call.id}`; }
  private assertCurrent(entry: Entry): void { this.options.assertConnectionCurrent?.(entry.connection.connectionId, entry.connection.revision); }
  private state(prepared: PreparedTool, context: ToolExecutionContext): PreparedState {
    this.assertOpen();
    const state = this.prepared.get(this.key(prepared.call, context));
    if (!state || state.identity !== canonical(json(context.identity)) || canonical(json(state.prepared)) !== canonical(json(prepared)) || context.policyRevision !== state.prepared.policyRevision) throw new Error('MCP prepared input, policy or owner changed.');
    return state;
  }
  async prepare(call: ToolCall, context: ToolExecutionContext): Promise<PreparedTool> {
    this.assertOpen();
    stopped(context.signal);
    await this.options.assertOwnership?.();
    this.assertOpen();
    stopped(context.signal);
    const entry = this.entries.get(call.name);
    if (!entry || !call.id || call.id.length > 256 || call.id.includes('\0') || typeof call.arguments !== 'string' || Buffer.byteLength(call.arguments) > MAX_INPUT_BYTES) throw new Error('Invalid MCP tool call or argument budget.');
    if (!Number.isSafeInteger(context.maxOutputBytes) || context.maxOutputBytes < 256) throw new Error('MCP output budget is too small.');
    this.assertCurrent(entry);
    const input: unknown = JSON.parse(call.arguments);
    checkedJson(input, this.forbidden);
    checkedJson(json(call), this.forbidden);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('MCP tool arguments must be a JSON object.');
    assertMcpToolInput(entry.remote.inputSchema, input);
    const inputDigest = hash(canonical(input)); // The core contract hashes input only; policyRevision binds the catalog snapshot.
    const key = this.key(call, context);
    const existing = this.prepared.get(key);
    if (existing) {
      if (canonical(json(existing.prepared.call)) !== canonical(json(call)) || existing.identity !== canonical(json(context.identity)) || existing.prepared.policyRevision !== context.policyRevision) throw new Error('MCP tool call identity was reused with changed input or ownership.');
      return structuredClone(existing.prepared);
    }
    if (this.prepared.size >= MAX_PREPARED) throw new Error('MCP tool call budget exhausted.');
    const prepared: PreparedTool = {
      call: structuredClone(call), definition: structuredClone(entry.definition), input,
      inputDigest, policyRevision: context.policyRevision, requiresApproval: true,
      preconditions: {
        connectionId: entry.connection.connectionId, connectionRevision: entry.connection.revision,
        protocolVersion: entry.connection.protocolVersion ?? '2026-07-28',
        server: entry.connection.name, endpointHash: hash(entry.connection.endpoint), remoteTool: entry.remote.name,
        toolDefinitionHash: entry.remoteHash, schemaHash: hash(canonical(entry.remote.inputSchema)),
      },
    };
    checkedJson(json(prepared), this.forbidden);
    this.prepared.set(key, { prepared: structuredClone(prepared), identity: canonical(json(context.identity)), entry, executed: false });
    return structuredClone(prepared);
  }
  async validate(prepared: PreparedTool, context: ToolExecutionContext): Promise<void> {
    this.assertOpen();
    stopped(context.signal);
    await this.options.assertOwnership?.();
    const state = this.state(prepared, context);
    if (state.result) return;
    if (state.executed) throw new Error('MCP tool outcome is active or unknown; replay is forbidden.');
    this.assertCurrent(state.entry);
    let tools: McpTool[];
    try { tools = await state.entry.client.discoverTools(context.signal); }
    catch { throw new Error('MCP tool catalog could not be revalidated.'); }
    checkedJson(json(tools), this.forbidden);
    const matching = tools.filter(tool => tool.name === state.entry.remote.name);
    if (matching.length !== 1 || hash(canonical(json(matching[0]))) !== state.entry.remoteHash) throw new Error('MCP tool definition changed; a new approval is required.');
    await this.options.assertOwnership?.();
    this.assertOpen();
    this.assertCurrent(state.entry);
    stopped(context.signal);
  }
  private approval(prepared: PreparedTool, context: ToolExecutionContext, approval?: ApprovalDecision): void {
    const binding = { ...context.identity, toolCallId: prepared.call.id, inputDigest: prepared.inputDigest, policyRevision: context.policyRevision };
    if (!approval || approval.decision !== 'approved' || !Number.isFinite(approval.expiresAt) || approval.expiresAt <= Date.now() || canonical(json(approval.binding)) !== canonical(json(binding))) throw new Error('A current approval for this exact MCP input and run is required.');
  }
  async execute(prepared: PreparedTool, context: ToolExecutionContext, approval?: ApprovalDecision): Promise<ToolResult> {
    let state: PreparedState | undefined;
    try {
      state = this.state(prepared, context);
      if (state.result) return structuredClone(state.result);
      if (state.executed) return { status: 'unknown', output: { error: 'mcp_tool_already_started' } };
      this.approval(prepared, context, approval);
      // Revalidate after the durable prepared marker too. Remote tools are not transactional;
      // this prevents using a catalog we already know changed, without claiming server-side atomicity.
      await this.validate(prepared, context);
      await this.options.assertOwnership?.();
      this.state(prepared, context);
      this.assertCurrent(state.entry);
      stopped(context.signal);
      this.approval(prepared, context, approval);
      if (state.executed) return { status: 'unknown', output: { error: 'mcp_tool_already_started' } };
    } catch {
      if (state?.executed) return { status: 'unknown', output: { error: 'mcp_tool_already_started' } };
      return { status: 'not_executed', output: { error: 'mcp_preconditions_or_approval_invalid', executed: false } };
    }
    state.executed = true;
    let result: ToolResult;
    try {
      const output = await state.entry.client.callTool(structuredClone(state.entry.remote), structuredClone(state.prepared.input), context.signal);
      checkedJson(output, this.forbidden);
      if (output.resultType !== 'complete' || !Array.isArray(output.content) || output.content.some(item => !item || typeof item !== 'object' || Array.isArray(item) || item.type !== 'text' || typeof item.text !== 'string') || output.isError !== undefined && typeof output.isError !== 'boolean') throw new Error('Unsupported MCP tool result.');
      if (state.entry.remote.outputSchema && (output.isError !== true || output.structuredContent !== undefined)) {
        assertMcpToolOutput(state.entry.remote.outputSchema, output.structuredContent as JsonValue);
      }
      if (bytes(output) > context.maxOutputBytes) result = { status: 'unknown', output: { error: 'mcp_output_budget_exceeded' }, truncated: true };
      else result = { status: output.isError === true ? 'failed' : 'completed', output };
    } catch (error) {
      // Never forward remote error strings or AbortSignal.reason into model/journal output.
      result = { status: error instanceof McpClientError ? error.outcome : 'unknown', output: { error: 'mcp_tool_execution_failed' } };
    }
    state.result = structuredClone(result);
    return result;
  }
}

async function closeClients(clients: McpHttpClient[]): Promise<void> {
  const results = await Promise.allSettled(clients.map(async client => client.close()));
  if (results.some(result => result.status === 'rejected')) {
    // Only a failure to settle local requests reaches here. Remote DELETE is best effort.
    throw Object.assign(new Error('MCP 本地请求清理尚未确认。'), { cleanupUnconfirmed: true });
  }
}

export async function createMcpToolPort(options: McpToolOptions, signal: AbortSignal): Promise<ManagedMcpToolPort> {
  stopped(signal);
  if (!Array.isArray(options.connections) || options.connections.length > MAX_CONNECTIONS) throw new Error('MCP connection budget exceeded.');
  // A server must never echo credentials belonging to another selected connection/model.
  const forbidden = [...new Set([...(options.forbiddenValues ?? []), ...options.connections.map(connection => connection.bearerToken)].filter((value): value is string => typeof value === 'string' && value.length > 0))];
  const entries: Entry[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  const clients: McpHttpClient[] = [];
  let metadataBytes = 0;
  let definitionBytes = 0;
  try {
    for (const source of options.connections) {
      const connection = { ...structuredClone(source), protocolVersion: source.protocolVersion ?? '2026-07-28' as const };
      if (!/^[a-zA-Z0-9_-]{1,200}$/.test(connection.connectionId) || ids.has(connection.connectionId) || !Number.isSafeInteger(connection.revision) || connection.revision < 1 || !connection.name || connection.name.length > 200) throw new Error('Invalid or duplicate MCP connection.');
      ids.add(connection.connectionId);
      checkedJson({ connectionId: connection.connectionId, name: connection.name, endpoint: connection.endpoint }, forbidden);
      await options.assertOwnership?.();
      options.assertConnectionCurrent?.(connection.connectionId, connection.revision);
      const client = new McpHttpClient({ endpoint: connection.endpoint, protocolVersion: connection.protocolVersion, allowLoopbackHttp: connection.allowLoopbackHttp, bearerToken: connection.bearerToken, forbiddenValues: forbidden });
      clients.push(client);
      let remoteTools: McpTool[];
      try { remoteTools = await client.discoverTools(signal); }
      catch { throw new Error('无法读取 MCP 工具目录，请检查所选协议版本、连接凭据和网络。'); }
      options.assertConnectionCurrent?.(connection.connectionId, connection.revision);
      stopped(signal);
      checkedJson(json(remoteTools), forbidden);
      metadataBytes += bytes(remoteTools);
      if (entries.length + remoteTools.length > MAX_TOOLS || metadataBytes > MAX_METADATA_BYTES) throw new Error('MCP 工具目录超出上限：最多 64 个工具，目录总大小最多 128 KiB。');
      for (const remote of remoteTools) {
        try {
          assertMcpInputSchema(remote.inputSchema);
          if (remote.outputSchema) {
            if (connection.protocolVersion === '2025-11-25' && remote.outputSchema.type !== 'object') continue;
            assertMcpOutputSchema(remote.outputSchema);
          }
        } catch { continue; }
        const name = `mcp_${hash(connection.connectionId).slice(0, 16)}_${hash(remote.name).slice(0, 43)}`;
        if (names.has(name)) throw new Error('Duplicate or colliding MCP tool name.');
        names.add(name);
        const definition: ToolDefinition = {
          name, risk: 'command', inputSchema: structuredClone(remote.inputSchema),
          description: `MCP server: ${connection.name}. Remote tool: ${remote.name}. Requires approval for each call.${remote.description ? `\n${remote.description.slice(0, 2048)}` : ''}`,
        };
        checkedJson(json(definition), forbidden);
        definitionBytes += bytes(definition);
        if (definitionBytes > MAX_METADATA_BYTES) throw new Error('MCP 工具目录超出上限：最多 64 个工具，目录总大小最多 128 KiB。');
        entries.push({ connection, client, remote: structuredClone(remote), remoteHash: hash(canonical(json(remote))), definition });
      }
    }
    await options.assertOwnership?.();
    for (const entry of entries) options.assertConnectionCurrent?.(entry.connection.connectionId, entry.connection.revision);
    stopped(signal);
    return new McpToolPort(entries, options, forbidden, clients);
  } catch (error) {
    await closeClients(clients);
    throw error;
  }
}

/** Route exact names only, reject collisions, and bind each prepared definition to its owner. */
export function composeToolPorts(ports: ToolPort[]): ToolPort {
  const routes = new Map<string, { port: ToolPort; definition: ToolDefinition }>();
  for (const port of ports) for (const definition of port.definitions) {
    if (routes.has(definition.name)) throw new Error('Composed tool names must be unique.');
    routes.set(definition.name, { port, definition: structuredClone(definition) });
  }
  const route = (name: string, definition?: ToolDefinition): ToolPort => {
    const found = routes.get(name);
    if (!found || definition && canonical(json(definition)) !== canonical(json(found.definition))) throw new Error('Unknown or changed composed tool definition.');
    return found.port;
  };
  return {
    get definitions() { return [...routes.values()].map(item => structuredClone(item.definition)); },
    async prepare(call, context) {
      const prepared = await route(call.name).prepare(call, context);
      route(prepared.call.name, prepared.definition);
      if (prepared.call.name !== call.name) throw new Error('Composed tool changed its routing name.');
      return prepared;
    },
    validate(prepared, context) { return route(prepared.call.name, prepared.definition).validate(prepared, context); },
    execute(prepared, context, approval) { return route(prepared.call.name, prepared.definition).execute(prepared, context, approval); },
  };
}
