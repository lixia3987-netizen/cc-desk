import type { ApprovalDecision, JsonObject, JsonValue, PreparedTool, RunIdentity, ToolCall, ToolDefinition, ToolExecutionContext, ToolPort, ToolResult } from '@cc-desk/agent-core';
import type { NativeChangeSetFileEvent, NativeChangeSetResult } from '@cc-desk/contracts/native-changes';
import { ProcessSupervisor } from '../process-supervisor.js';
import { loadProjectInstructions, projectInstructionText, type ProjectInstructions } from '../project-instructions.js';
import { assertNoModelCredential } from '../responses-model.js';
import { contentHash, isSensitivePath, normalizeProjectPath, ProjectFiles, throwIfAborted, type FilePolicyOptions, type PathSnapshot, type PreparedPatch } from './project-files.js';
import { ProjectSearch, type ProjectSearchInput } from './project-search.js';
import { ProjectChangeSet, validateChangeSetInput, type PreparedChangeSet } from './change-set.js';

const string = { type: 'string' };
const integer = { type: 'integer' };
const schema = (properties: JsonObject, required: string[]): JsonObject => ({ type: 'object', properties, required, additionalProperties: false });
const searchProperties: JsonObject = {
  path: string, glob: { type: 'string', maxLength: 512 },
  ignoreDirectories: { type: 'array', maxItems: 32, items: { type: 'string', maxLength: 512 } },
  caseSensitive: { type: 'boolean' }, pageSize: { type: 'integer', minimum: 1, maximum: 1000 }, cursor: { type: 'string', minLength: 1, maxLength: 160 },
};
export const LOCAL_TOOL_DEFINITIONS: ToolDefinition[] = [
  { name: 'list_directory', risk: 'read', description: 'List an authorized project directory. Links and protected paths are omitted; depth, count and time are bounded.', inputSchema: schema({ path: string, depth: integer, maxEntries: integer }, ['path']) },
  { name: 'read_file', risk: 'read', description: 'Read bounded UTF-8 text. hash always covers the whole file, including bytes outside a requested range. Sensitive files require individual approval.', inputSchema: schema({ path: string, startLine: integer, endLine: integer, startByte: integer, maxBytes: integer }, ['path']) },
  { name: 'search', risk: 'read', description: 'Search bounded UTF-8 project files. mode defaults to literal; regex runs with a hard time limit, one match per line, Unicode and optional case-insensitive matching. glob supports only *, ** and ? relative to the searched path; ignoreDirectories adds literal directory names or project-relative directory paths, not full gitignore rules. Sensitive files, links and generated directories stay excluded. maxMatches is the legacy pageSize alias; do not set both. Follow nextCursor with unchanged query/filter options. Check complete, scanComplete and truncationReasons before claiming no matches; an incomplete scan cannot establish absence. Matches include whole-file hashes and positions, but deeper AGENTS.md/CLAUDE.md instructions still need read_file or list_directory before editing.', inputSchema: schema({ ...searchProperties, query: { type: 'string', minLength: 1, maxLength: 512 }, mode: { type: 'string', enum: ['literal', 'regex'] }, maxMatches: { type: 'integer', minimum: 1, maximum: 1000 } }, ['path', 'query']) },
  { name: 'find_files', risk: 'read', description: 'Locate ordinary project files by literal basename fragment (name), restricted path glob (*, **, ?), or both. glob is relative to the searched path; ignoreDirectories adds literal directory names or project-relative directory paths, not full gitignore rules. Sensitive files, links and generated directories remain excluded. This reads metadata only, including binary/large file names: matches have hash:null and hashStatus:not_read. Use read_file to obtain a full content hash before editing. Check completeness and nextCursor; reuse unchanged filter options for later pages. Finding a nested file does not mean its deeper AGENTS.md/CLAUDE.md rules have been read: use read_file or list_directory for that scope before editing.', inputSchema: schema({ ...searchProperties, name: { type: 'string', minLength: 1, maxLength: 256 } }, ['path']) },
  { name: 'apply_patch', risk: 'write', description: 'Create or replace exactly one UTF-8 text file. expectedHash is the SHA-256 from read_file, or null to create without overwriting. Read applicable AGENTS.md and CLAUDE.md rules first. Always requires approval.', inputSchema: schema({ path: string, content: string, expectedHash: { type: ['string', 'null'] } }, ['path', 'content', 'expectedHash']) },
  { name: 'edit_file', risk: 'write', description: 'Replace one unique exact oldText fragment in an existing UTF-8 file with newText (empty to delete). oldText must be nonempty and match exactly once, including whitespace and line endings; include surrounding text to disambiguate. No fuzzy matching or replace-all. expectedHash must be the complete SHA-256 from read_file; read again after each edit. Preserves all other text. Read applicable AGENTS.md and CLAUDE.md rules first. Always requires approval.', inputSchema: schema({ path: string, oldText: string, newText: string, expectedHash: string }, ['path', 'oldText', 'newText', 'expectedHash']) },
  { name: 'apply_change_set', risk: 'write', description: 'Apply an explicitly approved ordered group of 1–16 UTF-8 file creates/replacements, at most 256 KiB total new content. Read every applicable AGENTS.md/CLAUDE.md and selected Skill first. expectedHash is the complete previous SHA-256, or null only for a new file. Approval shows the complete changed regions, with hashes and line-ending markers; oversized previews are rejected, never silently truncated. Sensitive paths, AGENTS.md/CLAUDE.md and selected Skills cannot be edited in a group. This is not a filesystem transaction: each file is validated and durably recorded before/after its individual write, and partial results are explicit. Never automatically retry unknown results or undo external changes. Splitting or changing a group needs a fresh approval.', inputSchema: schema({ changes: { type: 'array', minItems: 1, maxItems: 16, items: schema({ path: string, content: string, expectedHash: { type: ['string', 'null'] } }, ['path', 'content', 'expectedHash']) } }, ['changes']) },
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
  projectSkills?: readonly string[];
  /** Resolved model credentials for this run, never serialized in tool input. */
  forbiddenValues?: readonly string[];
  maxScanEntries?: number;
  maxOperationMs?: number;
  /** Trusted host-only durable progress. Required before any grouped file effect. */
  recordChangeSetEvent?: (identity: RunIdentity, call: ToolCall, event: NativeChangeSetFileEvent) => Promise<void>;
}
interface PreparedState {
  prepared: PreparedTool;
  identity: string;
  instructions: ProjectInstructions;
  target: PathSnapshot;
  patch?: PreparedPatch;
  executed: boolean;
  result?: ToolResult;
  searchExecution?: Promise<ToolResult>;
  maxOutputBytes: number;
  changeSet?: PreparedChangeSet;
  changeSetInstructions?: Array<{ path: string; instructions: ProjectInstructions }>;
  changeSetExecution?: Promise<ToolResult>;
}

export class LocalToolPort implements ToolPort {
  readonly definitions = LOCAL_TOOL_DEFINITIONS;
  private readonly files: ProjectFiles;
  private readonly searcher: ProjectSearch;
  private readonly changeSets: ProjectChangeSet;
  private readonly prepared = new Map<string, PreparedState>();
  private readonly seenInstructions = new Set<string>();
  private readonly maxScanEntries: number;
  private readonly maxOperationMs: number;
  constructor(private readonly options: LocalToolOptions) {
    this.files = new ProjectFiles(options);
    this.searcher = new ProjectSearch(options);
    this.changeSets = new ProjectChangeSet({ ...options, protectedPaths: options.projectSkills });
    this.maxScanEntries = options.maxScanEntries ?? 4000;
    this.maxOperationMs = options.maxOperationMs ?? 10000;
    if (!options.ownerId || !Number.isSafeInteger(this.maxScanEntries) || this.maxScanEntries < 1 || this.maxScanEntries > 20000 || !Number.isSafeInteger(this.maxOperationMs) || this.maxOperationMs < 1 || this.maxOperationMs > 30000) throw new Error('Invalid local tool bounds or owner.');
    this.markSeen(options.initialInstructions);
  }
  private markSeen(instructions?: ProjectInstructions) { for (const source of instructions?.sources ?? []) this.seenInstructions.add(`${source.path}:${source.hash}`); }
  private instructionOutput(instructions: ProjectInstructions): JsonValue {
    const unseen = instructions.sources.filter(source => !this.seenInstructions.has(`${source.path}:${source.hash}`));
    return asJson({
      sources: instructions.sources.map(({ path: sourcePath, scope, hash }) => ({ path: sourcePath, scope, hash })),
      digest: instructions.digest,
      text: projectInstructionText(unseen),
    });
  }
  private key(call: ToolCall, context: ToolExecutionContext) { return `${context.identity.runId}\0${context.identity.workerGeneration}\0${call.id}`; }
  private searchInput(input: JsonObject, name: string): ProjectSearchInput {
    const { maxMatches, ...fields } = input;
    return { ...fields, mode: name === 'find_files' ? 'files' : input.mode ?? 'literal', ...(maxMatches === undefined ? {} : { pageSize: maxMatches }) } as unknown as ProjectSearchInput;
  }
  private credentials(value: unknown): void { for (const secret of this.options.forbiddenValues ?? []) assertNoModelCredential(value, secret); }
  private async instructions(targetPath: string, targetKind: 'file' | 'directory', signal: AbortSignal) {
    return loadProjectInstructions({ projectRoot: this.options.projectRoot, excludedRoots: this.options.excludedRoots, projectSkills: this.options.projectSkills, targetPath, targetKind }, signal);
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
    if (call.name === 'apply_change_set') return this.prepareChangeSet(call, input, inputDigest, context, definition);
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
      targetPath = normalizeProjectPath(textField(input, 'path'), call.name === 'search' || call.name === 'find_files' || call.name === 'list_directory');
      if (call.name === 'apply_patch') {
        exactFields(input, ['path', 'content', 'expectedHash']);
        targetKind = 'file';
        const content = textField(input, 'content', this.files.maxFileBytes, true);
        if (input.expectedHash !== null && typeof input.expectedHash !== 'string') throw new Error('expectedHash must be a full SHA-256 hash or null.');
        patch = await this.files.preparePatch({ path: targetPath, content, expectedHash: input.expectedHash }, context.signal);
      } else if (call.name === 'edit_file') {
        exactFields(input, ['path', 'oldText', 'newText', 'expectedHash']);
        targetKind = 'file';
        const oldText = textField(input, 'oldText', this.files.maxFileBytes);
        const newText = textField(input, 'newText', this.files.maxFileBytes, true);
        const expectedHash = textField(input, 'expectedHash', 64);
        patch = await this.files.prepareEdit({ path: targetPath, oldText, newText, expectedHash }, context.signal);
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
        const optional = ['caseSensitive', 'glob', 'ignoreDirectories', 'pageSize', 'cursor'];
        if (call.name === 'find_files') exactFields(input, ['path'], [...optional, 'name']);
        else {
          exactFields(input, ['path', 'query'], [...optional, 'mode', 'maxMatches']); textField(input, 'query', 512);
          if (input.mode !== undefined && input.mode !== 'literal' && input.mode !== 'regex') throw new Error('Invalid content search mode.');
        }
        if (input.caseSensitive !== undefined && typeof input.caseSensitive !== 'boolean') throw new Error('Invalid caseSensitive.');
        numberField(input, 'maxMatches', 1, 1000);
        numberField(input, 'pageSize', 1, 1000);
        if (input.maxMatches !== undefined && input.pageSize !== undefined) throw new Error('Select maxMatches or pageSize, not both.');
        this.credentials(input);
        await this.searcher.validate(this.searchInput(input, call.name), context.signal);
      }
    }
    const instructions = await this.instructions(targetPath, targetKind, context.signal);
    if (definition.risk !== 'read' && instructions.sources.some(source => !this.seenInstructions.has(`${source.path}:${source.hash}`))) throw new Error('Applicable project instructions have not been shown to the model. First use read_file or list_directory for this target scope, then retry.');
    if (definition.risk === 'read' && size(this.instructionOutput(instructions)) > Math.max(0, context.maxOutputBytes - 2048)) throw new Error('Applicable project instructions exceed the tool output budget; increase the host budget before reading this scope.');
    const target = patch?.parent ?? await this.files.snapshot(targetPath, targetKind);
    const prepared: PreparedTool = {
      call: { ...call }, definition: structuredClone(definition), input, inputDigest, policyRevision: context.policyRevision,
      requiresApproval: definition.risk !== 'read' || isSensitivePath(targetPath),
      preconditions: { instructions: asJson(instructions.sources.map(({ path: instructionPath, scope, hash }) => ({ path: instructionPath, scope, hash }))), instructionDigest: instructions.digest, expectedHash: patch?.input.expectedHash ?? null, ownerId: this.options.ownerId },
    };
    // Concurrent preparation must not substitute another payload for the same
    // call while async path/instruction/regex validation is in flight.
    const concurrent = this.prepared.get(key);
    if (concurrent) {
      if (concurrent.identity !== identityKey(context.identity) || canonical(asJson(concurrent.prepared)) !== canonical(asJson(prepared))) throw new Error('Tool call identity was reused during preparation.');
      return structuredClone(concurrent.prepared);
    }
    throwIfAborted(context.signal);
    this.prepared.set(key, { prepared: structuredClone(prepared), identity: identityKey(context.identity), instructions, target, patch, executed: false, maxOutputBytes: context.maxOutputBytes });
    return structuredClone(prepared);
  }
  private state(prepared: PreparedTool, context: ToolExecutionContext): PreparedState {
    const state = this.prepared.get(this.key(prepared.call, context));
    if (!state || state.identity !== identityKey(context.identity) || canonical(asJson(state.prepared)) !== canonical(asJson(prepared)) || context.policyRevision !== prepared.policyRevision) throw new Error('Prepared tool input, policy or owner changed.');
    if (['search', 'find_files', 'apply_change_set'].includes(prepared.call.name) && context.maxOutputBytes !== state.maxOutputBytes) throw new Error('Tool output budget changed after preparation.');
    return state;
  }
  async validate(prepared: PreparedTool, context: ToolExecutionContext): Promise<void> {
    throwIfAborted(context.signal);
    await this.options.assertOwnership?.(context.identity);
    const state = this.state(prepared, context);
    if (state.result) return;
    if (state.executed) throw new Error('Tool has an unknown or active outcome; it cannot be replayed.');
    if (state.changeSet) {
      await this.assertChangeSetCurrent(prepared, state, context);
      await this.changeSets.validate(state.changeSet, context.signal);
      await this.assertChangeSetCurrent(prepared, state, context);
      return;
    }
    const targetPath = String(prepared.input[prepared.call.name === 'run_command' ? 'cwd' : 'path']);
    const targetKind = prepared.call.name === 'read_file' || prepared.call.name === 'apply_patch' || prepared.call.name === 'edit_file' ? 'file' : 'directory';
    if ((await this.instructions(targetPath, targetKind, context.signal)).digest !== state.instructions.digest) throw new Error('Project instructions changed; the approval is invalid. Read the scope again.');
    await this.files.verify(state.target, state.target.kind === 'file');
    if (state.patch) {
      if (state.patch.previous) await this.files.verify(state.patch.previous.snapshot, true);
      await this.files.preparePatch(state.patch.input, context.signal);
    }
  }
  async execute(prepared: PreparedTool, context: ToolExecutionContext, approval?: ApprovalDecision): Promise<ToolResult> {
    if (prepared.call.name === 'apply_change_set') return this.executeChangeSet(prepared, context, approval);
    if (prepared.call.name !== 'search' && prepared.call.name !== 'find_files') return this.executePrepared(prepared, context, approval);
    const state = this.state(prepared, context);
    throwIfAborted(context.signal);
    await this.options.assertOwnership?.(context.identity);
    throwIfAborted(context.signal);
    this.state(prepared, context);
    // Share the in-flight read/cache receipt, and recheck ownership even when
    // serving its cached value. Repeating a call cannot create a fresh scan.
    state.searchExecution ??= this.executePrepared(prepared, context, approval);
    return structuredClone(await state.searchExecution);
  }
  private async prepareChangeSet(call: ToolCall, input: JsonObject, inputDigest: string, context: ToolExecutionContext, definition: ToolDefinition): Promise<PreparedTool> {
    exactFields(input, ['changes']);
    this.credentials(input);
    // Reject the entire group's sensitive/rule targets, aliases, malformed text
    // and aggregate limits before any instruction lookup or previous-file read.
    const { changes } = validateChangeSetInput(input, this.options.projectSkills);
    const scopes: NonNullable<PreparedState['changeSetInstructions']> = [];
    for (const change of changes) {
      const instructions = await this.instructions(change.path, 'file', context.signal);
      if (instructions.sources.some(source => !this.seenInstructions.has(`${source.path}:${source.hash}`))) throw new Error('Applicable project instructions have not been shown to the model for every change-set target. Read each target scope first.');
      scopes.push({ path: change.path, instructions });
    }
    const changeSet = await this.changeSets.prepare({ changes }, context.signal);
    if (changeSet.resultMaxBytes + 1024 > context.maxOutputBytes) throw new Error('The complete per-file change-set receipt exceeds the output budget; split the group before requesting approval.');
    this.credentials(changeSet.preview);
    const instructions = await this.instructions('.', 'directory', context.signal), target = await this.files.snapshot('.', 'directory');
    const sources = [...new Map(scopes.flatMap(scope => scope.instructions.sources).map(source => [source.path, source])).values()];
    const prepared: PreparedTool = { call: structuredClone(call), definition: structuredClone(definition), input: structuredClone(input), inputDigest,
      policyRevision: context.policyRevision, requiresApproval: true, preconditions: {
        instructions: asJson(sources.map(({ path: instructionPath, scope, hash }) => ({ path: instructionPath, scope, hash }))),
        instructionDigest: contentHash(canonical(asJson(scopes.map(scope => ({ path: scope.path, digest: scope.instructions.digest }))))),
        changeSetScopes: asJson(scopes.map(scope => ({ path: scope.path, digest: scope.instructions.digest }))),
        ownerId: this.options.ownerId, changeSet: asJson(changeSet.preview),
      } };
    this.credentials(prepared.preconditions);
    await this.options.assertOwnership?.(context.identity); throwIfAborted(context.signal);
    const key = this.key(call, context), concurrent = this.prepared.get(key);
    if (concurrent) {
      if (concurrent.identity !== identityKey(context.identity) || canonical(asJson(concurrent.prepared)) !== canonical(asJson(prepared))) throw new Error('Tool call identity was reused during change-set preparation.');
      return structuredClone(concurrent.prepared);
    }
    this.prepared.set(key, { prepared: structuredClone(prepared), identity: identityKey(context.identity), instructions, target,
      executed: false, maxOutputBytes: context.maxOutputBytes, changeSet, changeSetInstructions: scopes });
    return structuredClone(prepared);
  }
  /** No file-version check here: earlier items in this group may already be applied. */
  private async assertChangeSetCurrent(prepared: PreparedTool, state: PreparedState, context: ToolExecutionContext, approval?: ApprovalDecision): Promise<void> {
    const check = () => {
      throwIfAborted(context.signal); this.state(prepared, context);
      if (approval) {
        const binding = { ...context.identity, toolCallId: prepared.call.id, inputDigest: prepared.inputDigest, policyRevision: prepared.policyRevision };
        if (approval.decision !== 'approved' || !Number.isFinite(approval.expiresAt) || approval.expiresAt <= Date.now() || canonical(asJson(approval.binding)) !== canonical(asJson(binding))) throw new Error('Change-set approval is no longer current.');
      }
    };
    check(); await this.options.assertOwnership?.(context.identity); check();
    for (const scope of state.changeSetInstructions ?? []) {
      const instructions = await this.instructions(scope.path, 'file', context.signal);
      if (instructions.digest !== scope.instructions.digest) throw new Error('Project instructions changed; stop the remaining change-set files and read each scope again.');
      check();
    }
    await this.files.verify(state.target); await this.options.assertOwnership?.(context.identity); check();
  }
  private async executeChangeSet(prepared: PreparedTool, context: ToolExecutionContext, approval?: ApprovalDecision): Promise<ToolResult> {
    const state = this.state(prepared, context);
    if (state.changeSetExecution) return structuredClone(await state.changeSetExecution);
    state.changeSetExecution = (async (): Promise<ToolResult> => {
      const record = this.options.recordChangeSetEvent;
      if (!record || !state.changeSet) return { status: 'not_executed', output: { error: 'change_set_durable_recorder_unavailable' } };
      if (!approval) return { status: 'not_executed', output: { error: 'change_set_approval_required' } };
      try {
        await this.validate(prepared, context);
        await this.assertChangeSetCurrent(prepared, state, context, approval);
        if (state.changeSet.resultMaxBytes + 1024 > context.maxOutputBytes) throw new Error('Change-set output budget changed.');
      } catch { return { status: 'not_executed', output: { error: 'change_set_preconditions_changed' } }; }
      state.executed = true;
      const run = structuredClone(context.identity), call = structuredClone(prepared.call);
      try {
        const applied: NativeChangeSetResult = await this.changeSets.apply(state.changeSet, { signal: context.signal,
          assertCurrent: () => this.assertChangeSetCurrent(prepared, state, context, approval),
          // After-effect receipts must still be saved if cancellation arrives.
          // This callback grants no permission to execute the next file.
          record: event => record(run, call, structuredClone(event)),
        });
        const output = asJson(applied); this.credentials(output);
        if (size(output) > context.maxOutputBytes) return { status: 'unknown', output: { error: 'change_set_receipt_exceeds_bound' } };
        const result: ToolResult = { status: applied.status === 'completed' ? 'completed' : applied.status === 'partial' ? 'failed' : applied.status === 'not_applied' ? 'not_executed' : 'unknown',
          output, effects: { changeSet: output } };
        state.result = structuredClone(result);
        return result;
      } catch {
        // Never pass through the generic lossy output fallback after grouped
        // effects. The durable per-file receipts remain the recovery source.
        const result: ToolResult = { status: 'unknown', output: { error: 'change_set_execution_unconfirmed' } };
        state.result = result; return result;
      }
    })();
    return structuredClone(await state.changeSetExecution);
  }
  private async executePrepared(prepared: PreparedTool, context: ToolExecutionContext, approval?: ApprovalDecision): Promise<ToolResult> {
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
      if (prepared.call.name === 'apply_patch' || prepared.call.name === 'edit_file') {
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
    const instructions = this.instructionOutput(state.instructions);
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
    } else if (prepared.call.name === 'search' || prepared.call.name === 'find_files') {
      const found = await this.searcher.search(this.searchInput(input, prepared.call.name), {
        identity: context.identity, policyRevision: context.policyRevision, instructionDigest: state.instructions.digest,
        signal: context.signal, maxOutputBytes: remaining,
      });
      throwIfAborted(context.signal);
      await this.options.assertOwnership?.(context.identity);
      if ((await this.instructions(String(input.path), 'directory', context.signal)).digest !== state.instructions.digest) throw new Error('Project instructions changed during search; results were not delivered. Read the scope again.');
      await this.files.verify(state.target);
      await this.options.assertOwnership?.(context.identity);
      throwIfAborted(context.signal);
      this.state(prepared, context);
      truncated = found.truncated;
      output = { ...asJson(found) as JsonObject, path: String(input.path), scannedBytes: found.scanned.bytes, instructions };
      this.credentials(output);
    } else {
      const walking = await this.walk(String(input.path), Number(input.depth ?? 1), context.signal);
      truncated = walking.truncated;
      const entries = walking.entries.slice(0, Number(input.maxEntries ?? 1000));
      truncated ||= entries.length < walking.entries.length;
      while (size(entries) > remaining && entries.length) { entries.pop(); truncated = true; }
      output = { path: String(input.path), entries: asJson(entries), truncated, instructions };
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
