import type { ApprovalDecision, JsonObject, JsonValue, PreparedTool, RunIdentity, ToolCall, ToolDefinition, ToolExecutionContext, ToolPort, ToolResult } from '@cc-desk/agent-core';
import { ProcessSupervisor } from '../process-supervisor.js';
import { loadProjectInstructions, type ProjectInstructions } from '../project-instructions.js';
import { contentHash, isSensitivePath, normalizeProjectPath, ProjectFiles, throwIfAborted, type FilePolicyOptions, type PathSnapshot, type PreparedPatch } from './project-files.js';

const string = { type: 'string' };
const integer = { type: 'integer' };
const schema = (properties: JsonObject, required: string[]): JsonObject => ({ type: 'object', properties, required, additionalProperties: false });
export const LOCAL_TOOL_DEFINITIONS: ToolDefinition[] = [
  { name: 'list_directory', risk: 'read', description: 'List an authorized project directory. Links and protected paths are omitted; depth, count and time are bounded.', inputSchema: schema({ path: string, depth: integer, maxEntries: integer }, ['path']) },
  { name: 'read_file', risk: 'read', description: 'Read bounded UTF-8 text. hash always covers the whole file, including bytes outside a requested range. Sensitive files require individual approval.', inputSchema: schema({ path: string, startLine: integer, endLine: integer, startByte: integer, maxBytes: integer }, ['path']) },
  { name: 'search', risk: 'read', description: 'Search literal text in ordinary project files, skipping sensitive files, links and generated directories. No regex or shell syntax. Results are bounded.', inputSchema: schema({ path: string, query: string, caseSensitive: { type: 'boolean' }, maxMatches: integer }, ['path', 'query']) },
  { name: 'apply_patch', risk: 'write', description: 'Create or replace exactly one UTF-8 text file. expectedHash is the SHA-256 from read_file, or null to create without overwriting. Read applicable AGENTS.md rules first. Always requires approval.', inputSchema: schema({ path: string, content: string, expectedHash: { type: ['string', 'null'] } }, ['path', 'content', 'expectedHash']) },
  { name: 'run_command', risk: 'command', description: 'Run an executable with literal argv and project-relative cwd (shell:false). Always requires approval. Commands may affect files/network beyond cwd: this is not an OS sandbox.', inputSchema: schema({ executable: string, argv: { type: 'array', items: string }, cwd: string, timeoutMs: integer, maxOutputBytes: integer }, ['executable', 'argv', 'cwd']) },
];
const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', 'release', '.next', 'coverage']);
const canonical = (value: JsonValue): string => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
const asJson = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;
const identityKey = (identity: RunIdentity) => canonical(asJson(identity));
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
function numberField(input: JsonObject, field: string, minimum: number, maximum: number): number | undefined {
  const value = input[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`Invalid ${field}; expected integer ${minimum}–${maximum}.`);
  return value;
}
function textField(input: JsonObject, field: string, maximum = 4096, empty = false): string {
  const value = input[field];
  if (typeof value !== 'string' || (!empty && !value) || value.length > maximum || value.includes('\0')) throw new Error(`Invalid ${field}.`);
  return value;
}
function exactFields(input: JsonObject, required: string[], optional: string[] = []): void {
  if (required.some(key => !Object.hasOwn(input, key)) || Object.keys(input).some(key => !required.includes(key) && !optional.includes(key))) throw new Error('Missing or unexpected tool arguments.');
}

export interface LocalToolOptions extends FilePolicyOptions {
  supervisor: ProcessSupervisor;
  ownerId: string;
  /** Host proves the current run/generation still owns its directory lease. */
  assertOwnership?: (identity: RunIdentity) => void | Promise<void>;
  /** Instructions actually supplied to the model before its first tool request. */
  initialInstructions?: ProjectInstructions;
  /** Resolved model credentials for this run, never serialized in tool input. */
  forbiddenValues?: readonly string[];
  maxScanEntries?: number;
  maxOperationMs?: number;
}
interface PreparedState {
  prepared: PreparedTool;
  identity: string;
  instructions: ProjectInstructions;
  target: PathSnapshot;
  patch?: PreparedPatch;
  executed: boolean;
  result?: ToolResult;
}

export class LocalToolPort implements ToolPort {
  readonly definitions = LOCAL_TOOL_DEFINITIONS;
  private readonly files: ProjectFiles;
  private readonly prepared = new Map<string, PreparedState>();
  private readonly seenInstructions = new Set<string>();
  private readonly maxScanEntries: number;
  private readonly maxOperationMs: number;
  constructor(private readonly options: LocalToolOptions) {
    this.files = new ProjectFiles(options);
    this.maxScanEntries = options.maxScanEntries ?? 4000;
    this.maxOperationMs = options.maxOperationMs ?? 10000;
    if (!options.ownerId || !Number.isSafeInteger(this.maxScanEntries) || this.maxScanEntries < 1 || this.maxScanEntries > 20000 || !Number.isSafeInteger(this.maxOperationMs) || this.maxOperationMs < 1 || this.maxOperationMs > 30000) throw new Error('Invalid local tool bounds or owner.');
    this.markSeen(options.initialInstructions);
  }
  private markSeen(instructions?: ProjectInstructions) { for (const source of instructions?.sources ?? []) this.seenInstructions.add(`${source.path}:${source.hash}`); }
  private key(call: ToolCall, context: ToolExecutionContext) { return `${context.identity.runId}\0${context.identity.workerGeneration}\0${call.id}`; }
  private async instructions(targetPath: string, targetKind: 'file' | 'directory', signal: AbortSignal) {
    return loadProjectInstructions({ projectRoot: this.options.projectRoot, excludedRoots: this.options.excludedRoots, targetPath, targetKind }, signal);
  }
  async prepare(call: ToolCall, context: ToolExecutionContext): Promise<PreparedTool> {
    throwIfAborted(context.signal);
    await this.options.assertOwnership?.(context.identity);
    if (!call.id || call.id.length > 256 || call.arguments.length > this.files.maxFileBytes * 2 + 16384) throw new Error('Invalid tool call identity or argument size.');
    const definition = this.definitions.find(item => item.name === call.name);
    if (!definition) throw new Error('Unknown local tool.');
    const parsed: unknown = JSON.parse(call.arguments);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Tool arguments must be an object.');
    const input = parsed as JsonObject;
    const inputDigest = contentHash(canonical(input));
    const key = this.key(call, context);
    const old = this.prepared.get(key);
    if (old) {
      if (old.prepared.inputDigest !== inputDigest || old.prepared.call.name !== call.name || old.identity !== identityKey(context.identity) || old.prepared.policyRevision !== context.policyRevision) throw new Error('Tool call identity was reused with different input or ownership.');
      return structuredClone(old.prepared);
    }
    if (this.prepared.size >= 256) throw new Error('Local tool call budget exhausted.');
    let targetPath: string;
    let targetKind: 'file' | 'directory' = 'directory';
    let patch: PreparedPatch | undefined;
    if (call.name === 'run_command') {
      exactFields(input, ['executable', 'argv', 'cwd'], ['timeoutMs', 'maxOutputBytes']);
      const executable = textField(input, 'executable');
      if (/[\x00-\x1f\x7f]/.test(executable)) throw new Error('Invalid executable.');
      if (!Array.isArray(input.argv) || input.argv.length > 256 || input.argv.some(arg => typeof arg !== 'string' || arg.includes('\0')) || size(input.argv) > 32768) throw new Error('Invalid command argv.');
      targetPath = normalizeProjectPath(textField(input, 'cwd'), true);
      numberField(input, 'timeoutMs', 1, 120000);
      numberField(input, 'maxOutputBytes', 256, 1024 * 1024);
    } else {
      targetPath = normalizeProjectPath(textField(input, 'path'), call.name === 'search' || call.name === 'list_directory');
      if (call.name === 'apply_patch') {
        exactFields(input, ['path', 'content', 'expectedHash']);
        targetKind = 'file';
        const content = textField(input, 'content', this.files.maxFileBytes, true);
        if (input.expectedHash !== null && typeof input.expectedHash !== 'string') throw new Error('expectedHash must be a full SHA-256 hash or null.');
        patch = await this.files.preparePatch({ path: targetPath, content, expectedHash: input.expectedHash }, context.signal);
      } else if (call.name === 'read_file') {
        exactFields(input, ['path'], ['startLine', 'endLine', 'startByte', 'maxBytes']);
        targetKind = 'file';
        const startLine = numberField(input, 'startLine', 1, 1000000);
        const endLine = numberField(input, 'endLine', 1, 1000000);
        numberField(input, 'startByte', 0, this.files.maxFileBytes);
        numberField(input, 'maxBytes', 1, this.files.maxFileBytes);
        if ((startLine !== undefined || endLine !== undefined) && input.startByte !== undefined) throw new Error('Select a line range or byte range, not both.');
        if (endLine !== undefined && endLine < (startLine ?? 1)) throw new Error('Invalid line range.');
      } else if (call.name === 'list_directory') {
        exactFields(input, ['path'], ['depth', 'maxEntries']);
        numberField(input, 'depth', 0, 8);
        numberField(input, 'maxEntries', 1, 4000);
      } else {
        exactFields(input, ['path', 'query'], ['caseSensitive', 'maxMatches']);
        textField(input, 'query', 512);
        if (input.caseSensitive !== undefined && typeof input.caseSensitive !== 'boolean') throw new Error('Invalid caseSensitive.');
        numberField(input, 'maxMatches', 1, 1000);
      }
    }
    const instructions = await this.instructions(targetPath, targetKind, context.signal);
    if (definition.risk !== 'read' && instructions.sources.some(source => !this.seenInstructions.has(`${source.path}:${source.hash}`))) throw new Error('Applicable project instructions have not been shown to the model. First use read_file or list_directory for this target scope, then retry.');
    if (definition.risk === 'read' && size(instructions) > Math.max(0, context.maxOutputBytes - 2048)) throw new Error('Applicable project instructions exceed the tool output budget; increase the host budget before reading this scope.');
    const target = patch?.parent ?? await this.files.snapshot(targetPath, targetKind);
    const prepared: PreparedTool = {
      call: { ...call }, definition: structuredClone(definition), input, inputDigest, policyRevision: context.policyRevision,
      requiresApproval: definition.risk !== 'read' || isSensitivePath(targetPath),
      preconditions: { instructions: asJson(instructions.sources.map(({ path: instructionPath, scope, hash }) => ({ path: instructionPath, scope, hash }))), instructionDigest: instructions.digest, expectedHash: patch?.input.expectedHash ?? null, ownerId: this.options.ownerId },
    };
    this.prepared.set(key, { prepared: structuredClone(prepared), identity: identityKey(context.identity), instructions, target, patch, executed: false });
    return structuredClone(prepared);
  }
  private state(prepared: PreparedTool, context: ToolExecutionContext): PreparedState {
    const state = this.prepared.get(this.key(prepared.call, context));
    if (!state || state.identity !== identityKey(context.identity) || canonical(asJson(state.prepared)) !== canonical(asJson(prepared)) || context.policyRevision !== prepared.policyRevision) throw new Error('Prepared tool input, policy or owner changed.');
    return state;
  }
  async validate(prepared: PreparedTool, context: ToolExecutionContext): Promise<void> {
    throwIfAborted(context.signal);
    await this.options.assertOwnership?.(context.identity);
    const state = this.state(prepared, context);
    if (state.result) return;
    if (state.executed) throw new Error('Tool has an unknown or active outcome; it cannot be replayed.');
    const targetPath = String(prepared.input[prepared.call.name === 'run_command' ? 'cwd' : 'path']);
    const targetKind = prepared.call.name === 'read_file' || prepared.call.name === 'apply_patch' ? 'file' : 'directory';
    if ((await this.instructions(targetPath, targetKind, context.signal)).digest !== state.instructions.digest) throw new Error('Project instructions changed; the approval is invalid. Read the scope again.');
    await this.files.verify(state.target, state.target.kind === 'file');
    if (state.patch) {
      if (state.patch.previous) await this.files.verify(state.patch.previous.snapshot, true);
      await this.files.preparePatch(state.patch.input, context.signal);
    }
  }
  async execute(prepared: PreparedTool, context: ToolExecutionContext, approval?: ApprovalDecision): Promise<ToolResult> {
    const state = this.state(prepared, context);
    if (state.result) return structuredClone(state.result);
    await this.validate(prepared, context);
    if (prepared.requiresApproval) {
      const binding = { ...context.identity, toolCallId: prepared.call.id, inputDigest: prepared.inputDigest, policyRevision: context.policyRevision };
      if (!approval || approval.decision !== 'approved' || approval.expiresAt <= Date.now() || canonical(asJson(approval.binding)) !== canonical(asJson(binding))) throw new Error('A current approval for this exact tool input and run is required.');
    }
    await this.options.assertOwnership?.(context.identity);
    throwIfAborted(context.signal);
    state.executed = true;
    let result: ToolResult;
    try {
      if (prepared.call.name === 'apply_patch') {
        const effect = await this.files.applyPatch(state.patch!, context.signal);
        result = { status: 'completed', output: asJson(effect), effects: asJson(effect) };
      } else if (prepared.call.name === 'run_command') {
        const command = await this.options.supervisor.run(this.options.ownerId, { executable: String(prepared.input.executable), argv: prepared.input.argv as string[], cwd: state.target.absolute, timeoutMs: prepared.input.timeoutMs as number | undefined, maxOutputBytes: Math.min((prepared.input.maxOutputBytes as number | undefined) ?? context.maxOutputBytes, Math.max(256, Math.floor(context.maxOutputBytes / 2))) }, context.signal, this.options.forbiddenValues);
        result = { status: command.cleanup === 'cleanup_failed' ? 'unknown' : command.cancelled ? 'cancelled' : command.timedOut || command.exitCode !== 0 ? 'failed' : 'completed', output: asJson(command), truncated: command.truncated, effects: { exitCode: command.exitCode, cleanup: command.cleanup } };
      } else {
        result = await this.readTool(prepared, state, context);
      }
    } catch (error) {
      result = { status: prepared.definition.risk === 'read' ? (context.signal.aborted ? 'cancelled' : 'failed') : 'unknown', output: { error: error instanceof Error ? error.message.slice(0, 1024) : 'Tool execution failed.' } };
    }
    if (size(result.output) > context.maxOutputBytes) result = { status: result.status, output: { error: 'Tool output exceeded the configured byte budget.', truncated: true }, truncated: true, ...(result.effects ? { effects: result.effects } : {}) };
    state.result = structuredClone(result);
    return result;
  }
  private async readTool(prepared: PreparedTool, state: PreparedState, context: ToolExecutionContext): Promise<ToolResult> {
    const input = prepared.input;
    const instructions = asJson(state.instructions);
    const remaining = context.maxOutputBytes - size(instructions) - 1024;
    if (remaining < 256) throw new Error('Tool output budget is too small.');
    let output: JsonObject;
    let truncated = false;
    if (prepared.call.name === 'read_file') {
      const file = await this.files.read(String(input.path), context.signal);
      let content = file.content;
      if (input.startLine !== undefined || input.endLine !== undefined) content = content.split('\n').slice(Number(input.startLine ?? 1) - 1, input.endLine === undefined ? undefined : Number(input.endLine)).join('\n');
      let bytes = Buffer.from(content);
      if (input.startByte !== undefined) bytes = bytes.subarray(Number(input.startByte));
      const maxBytes = Math.min(Number(input.maxBytes ?? this.files.maxFileBytes), Math.floor(remaining / 6));
      truncated = bytes.length > maxBytes;
      content = bytes.subarray(0, maxBytes).toString('utf8');
      output = { path: file.path, content, hash: file.hash, bytes: file.bytes, truncated, instructions };
    } else {
      const walking = await this.walk(String(input.path), prepared.call.name === 'list_directory' ? Number(input.depth ?? 1) : 8, context.signal);
      truncated = walking.truncated;
      if (prepared.call.name === 'list_directory') {
        const entries = walking.entries.slice(0, Number(input.maxEntries ?? 1000));
        truncated ||= entries.length < walking.entries.length;
        while (size(entries) > remaining && entries.length) { entries.pop(); truncated = true; }
        output = { path: String(input.path), entries: asJson(entries), truncated, instructions };
      } else {
        const matches: JsonObject[] = [];
        const query = String(input.query);
        const caseSensitive = input.caseSensitive !== false;
        const needle = caseSensitive ? query : query.toLocaleLowerCase();
        const deadline = Date.now() + this.maxOperationMs;
        let scannedBytes = 0;
        for (const entry of walking.entries) {
          throwIfAborted(context.signal);
          if (entry.type !== 'file' || isSensitivePath(entry.path)) continue;
          if (Date.now() > deadline || scannedBytes >= 8 * 1024 * 1024) { truncated = true; break; }
          try {
            const file = await this.files.read(entry.path, context.signal);
            scannedBytes += file.bytes;
            const lines = file.content.split('\n');
            for (let index = 0; index < lines.length; index++) {
              const line = lines[index];
              const offset = (caseSensitive ? line : line.toLocaleLowerCase()).indexOf(needle);
              if (offset < 0) continue;
              const excerptStart = Math.max(0, offset - 120);
              const match = { path: entry.path, line: index + 1, text: line.slice(excerptStart, excerptStart + 512) };
              if (matches.length >= Number(input.maxMatches ?? 100) || size([...matches, match]) > remaining) { truncated = true; break; }
              matches.push(match);
            }
          } catch (error) { if (context.signal.aborted) throw error; /* Unsupported and raced files are not context sources. */ }
          if (matches.length >= Number(input.maxMatches ?? 100) || size(matches) > remaining - 1024) { truncated = true; break; }
        }
        output = { path: String(input.path), matches, scannedBytes, truncated, instructions };
      }
    }
    if (size(output) > context.maxOutputBytes) throw new Error('Instruction and tool output exceed the configured byte budget.');
    this.markSeen(state.instructions);
    return { status: 'completed', output, truncated };
  }
  private async walk(relative: string, depth: number, signal: AbortSignal): Promise<{ entries: { path: string; type: 'file' | 'directory' }[]; truncated: boolean }> {
    const entries: { path: string; type: 'file' | 'directory' }[] = [];
    const deadline = Date.now() + this.maxOperationMs;
    let visited = 0;
    let truncated = false;
    const visit = async (directory: string, level: number): Promise<void> => {
      throwIfAborted(signal);
      if (visited >= this.maxScanEntries || Date.now() > deadline) { truncated = true; return; }
      const children = await this.files.entries(directory, this.maxScanEntries - visited, signal);
      truncated ||= children.truncated;
      for (const name of children.names) {
        throwIfAborted(signal);
        if (visited++ >= this.maxScanEntries || Date.now() > deadline) { truncated = true; break; }
        const child = directory === '.' ? name : `${directory}/${name}`;
        if (name.toLowerCase() === '.git' || SKIP_DIRECTORIES.has(name) || isSensitivePath(child)) continue;
        let kind: 'file' | 'directory' = 'file';
        try { await this.files.snapshot(child, 'file'); }
        catch { try { await this.files.snapshot(child, 'directory'); kind = 'directory'; } catch { continue; } }
        entries.push({ path: child, type: kind });
        if (kind === 'directory' && level < depth) await visit(child, level + 1);
      }
    };
    await visit(normalizeProjectPath(relative, true), 0);
    return { entries, truncated };
  }
}
export function createLocalToolPort(options: LocalToolOptions): LocalToolPort { return new LocalToolPort(options); }
