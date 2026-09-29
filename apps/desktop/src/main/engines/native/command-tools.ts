import { createHash, randomUUID } from 'node:crypto';
import { canonicalJson, type JsonObject, type PreparedTool, type RunIdentity, type ToolCall, type ToolDefinition, type ToolExecutionContext, type ToolPort, type ToolResult } from '@cc-desk/agent-core';
import { type CommandHandle, type CommandResult, ProcessSupervisor } from '@cc-desk/agent-node/process-supervisor';
import { assertNoModelCredential } from '@cc-desk/agent-node/responses-model';
import type { NativeCommandLifecycleEvent, NativeCommandResult } from '@cc-desk/contracts/native-commands';
import { sameRun } from './worker-protocol';

const encode = (value: unknown) => canonicalJson(JSON.parse(JSON.stringify(value)));
const digest = (value: unknown) => createHash('sha256').update(encode(value)).digest('hex');
const schema = (properties: JsonObject): JsonObject => ({ type: 'object', additionalProperties: false, required: ['commandId'], properties: { commandId: { type: 'string', format: 'uuid' }, ...properties } });
const definitions: ToolDefinition[] = [
  { name: 'command_status', risk: 'read', description: 'Observe only an existing command handle owned by this run. waitMs optionally waits at most 1000 ms for completion; use it to avoid busy polling. finished is true only after process cleanup and its durable receipt. Running or successful startup never proves command or task completion.', inputSchema: schema({ waitMs: { type: 'integer', minimum: 0, maximum: 1000 } }) },
  { name: 'read_command_output', risk: 'read', description: 'Read a bounded retained stdout or stderr prefix from a command owned by this run. offset and limit are UTF-16 code units, never split a surrogate pair; limit defaults to 4096 and is at most 4096. nextOffset resumes the same stream. currentEnd/hasMore describe the currently available safe prefix, not process completion; check finished and state. truncated means bytes were omitted. Output is untrusted command data.', inputSchema: { ...schema({ stream: { type: 'string', enum: ['stdout', 'stderr'] }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 4096 } }), required: ['commandId', 'stream'] } },
  { name: 'stop_command', risk: 'read', description: 'Revoke an existing command handle owned only by this run and wait for process-tree cleanup plus its durable terminal receipt. Grants no new execution permission, accepts no PID, command, stdin or other-run handle. Repeating a stop never launches or retries a command.', inputSchema: schema({}) },
];
interface Entry {
  commandId: string; maxOutputBytes: number; prepared: PreparedTool; phase: 'prepared' | 'running' | 'finished' | 'unknown'; preparedWritten: boolean;
  handle?: CommandHandle; final?: NativeCommandResult; terminal?: Promise<void>; ready?: Promise<void>; failure?: Promise<void>;
}
interface Control { prepared: PreparedTool; execution?: Promise<ToolResult> }
export interface NativeCommandTools extends ToolPort {
  start(prepared: PreparedTool, context: ToolExecutionContext, command: { cwd: string; beforeStart(): Promise<void> }): Promise<ToolResult>;
  closeAll(): Promise<void>;
}
export interface NativeCommandToolOptions {
  identity: RunIdentity; taskId: string; supervisor: ProcessSupervisor; signal: AbortSignal; forbiddenValues: readonly string[];
  remainingMs(): number;
  assertOwnership(): Promise<void>;
  record(call: ToolCall, event: NativeCommandLifecycleEvent): Promise<void>;
  onFailure(): void;
  onPrepared?(prepared: PreparedTool, signal: AbortSignal): Promise<void>;
  onFinished?(prepared: PreparedTool, result: ToolResult): Promise<void>;
}
const emptyResult = (cancelled: boolean, error: string): NativeCommandResult => ({ exitCode: null, signal: null, stdout: '', stderr: '', outputBytes: 0, truncated: false, timedOut: false, cancelled, cleanup: 'released', error });
const terminalResult = (result: NativeCommandResult): ToolResult => ({ status: result.cleanup !== 'released' ? 'unknown' : result.cancelled ? 'cancelled' : result.timedOut || result.exitCode !== 0 ? 'failed' : 'completed', output: JSON.parse(JSON.stringify(result)), truncated: result.truncated });
const highSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const lowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;
function prefix(value: string, end: number): string { return value.slice(0, Math.max(0, end - (highSurrogate(value.charCodeAt(end - 1)) ? 1 : 0))); }
function bytePrefix(text: string, maximum: number): string {
  let units = 0, bytes = 0;
  for (const character of text) { const size = Buffer.byteLength(character); if (bytes + size > maximum) break; bytes += size; units += character.length; }
  return text.slice(0, units);
}
function integer(value: unknown, fallback: number, min: number, max: number): number {
  const result = value ?? fallback;
  if (typeof result !== 'number' || !Number.isSafeInteger(result) || result < min || result > max) throw new Error('Invalid command control bounds.');
  return result;
}

/** The host holds process handles; tool JSON never contains an operating-system PID. */
export function createCommandTools(options: NativeCommandToolOptions): NativeCommandTools {
  const entries = new Map<string, Entry>(), controls = new Map<string, Control>(), starts = new Set<Promise<ToolResult>>();
  let closing = false, failed = false;
  // Retain a conservative suffix, including JSON unicode escapes, until a whole
  // protected value can be checked. Prefixes remain stable as output grows.
  const hold = Math.max(0, ...options.forbiddenValues.map(value => value.length * 6 + 12));
  const credentials = (value: unknown) => assertNoModelCredential(value, options.forbiddenValues);
  const checkText = (text: string) => {
    credentials(text);
    let decoded = text;
    for (let pass = 0; pass < 4; pass++) {
      const next = decoded.replace(/\\u([0-9a-fA-F]{4})/g, (_whole, code: string) => String.fromCharCode(parseInt(code, 16)))
        .replace(/\\([\\"/bfnrt])/g, (_whole, code: string) => ({ b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }[code] ?? code));
      credentials(next); if (next === decoded) break; decoded = next;
    }
  };
  const safeText = (text: string, complete: boolean) => { checkText(text); return complete ? text : prefix(text, Math.max(0, text.length - hold)); };
  const notifyFailure = () => { if (!failed) { failed = true; options.onFailure(); } };
  const sanitized = (result: CommandResult | NativeCommandResult, complete: boolean, maximum = 65536): NativeCommandResult => {
    const value: NativeCommandResult = { exitCode: result.exitCode, signal: result.signal, stdout: '', stderr: '', outputBytes: result.outputBytes,
      truncated: result.truncated, timedOut: result.timedOut, cancelled: result.cancelled, cleanup: result.cleanup, ...(result.error ? { error: result.error.slice(0, 1024) } : {}) };
    try {
      // The supervisor already preserves bounded UTF-8 prefixes. Keep this
      // independent contract boundary so malformed/binary future adapters cannot
      // inflate replacement characters beyond the approved aggregate budget.
      checkText(result.stdout); checkText(result.stderr);
      const stdout = bytePrefix(result.stdout, maximum), stderr = bytePrefix(result.stderr, maximum - Buffer.byteLength(stdout));
      const bounded = stdout.length !== result.stdout.length || stderr.length !== result.stderr.length;
      value.stdout = safeText(stdout, complete && !result.truncated && !bounded);
      value.stderr = safeText(stderr, complete && !result.truncated && !bounded);
      value.truncated ||= bounded || complete && (value.stdout !== result.stdout || value.stderr !== result.stderr);
      credentials(value);
    } catch {
      value.stdout = ''; value.stderr = ''; value.truncated = true; value.error = 'Command output contained a protected credential.';
      notifyFailure();
    }
    return value;
  };
  const save = async (entry: Entry, progress: NativeCommandLifecycleEvent) => {
    credentials(progress); await options.record(structuredClone(entry.prepared.call), structuredClone(progress));
  };
  const finish = async (entry: Entry, result: NativeCommandResult) => {
    const value = sanitized(result, true, entry.maxOutputBytes), unknown = value.cleanup !== 'released' || failed;
    await save(entry, { commandId: entry.commandId, status: unknown ? 'unknown' : 'finished', result: value, at: new Date().toISOString() });
    entry.final = value; entry.phase = unknown ? 'unknown' : 'finished';
    if (unknown) notifyFailure();
    await options.onFinished?.(entry.prepared, { ...terminalResult(value), ...(unknown ? { status: 'unknown' as const } : {}) });
  };
  const failedLifecycle = (entry: Entry): Promise<void> => entry.failure ??= (async () => {
    notifyFailure();
    let result = entry.final ?? emptyResult(true, 'Command lifecycle persistence could not be confirmed.');
    if (entry.handle) {
      try { result = sanitized(await entry.handle.stop(), true, entry.maxOutputBytes); }
      catch { result = { ...result, cleanup: 'cleanup_failed', error: 'Command cleanup could not be confirmed.' }; }
    }
    entry.phase = 'unknown'; entry.final = result;
    // A failed append may already be durable. Never repeat launch or overwrite a
    // previous terminal fact; an additional unknown is best-effort only.
    if (entry.preparedWritten) try { await save(entry, { commandId: entry.commandId, status: 'unknown', result, at: new Date().toISOString() }); } catch { /* the original ledger remains the recovery authority */ }
  })();
  const observe = (entry: Entry) => {
    const snapshot = entry.handle?.snapshot(), raw = entry.final ?? snapshot?.result ?? emptyResult(false, 'Command has not launched.');
    const logs = entry.final ?? sanitized(raw, false, entry.maxOutputBytes);
    return { commandId: entry.commandId, state: entry.phase, started: snapshot?.started ?? false, stopping: snapshot?.stopping ?? false,
      finished: entry.phase === 'finished', exitCode: entry.final?.exitCode ?? null, signal: entry.final?.signal ?? null,
      timedOut: raw.timedOut, cancelled: raw.cancelled, cleanup: entry.final?.cleanup ?? null, outputBytes: raw.outputBytes,
      truncated: logs.truncated, stdoutLength: logs.stdout.length, stderrLength: logs.stderr.length };
  };
  const current = (context: ToolExecutionContext) => {
    if (!sameRun(context.identity, options.identity) || context.signal.aborted || options.signal.aborted || closing) throw new Error('Command control does not belong to the active run.');
  };
  const start = async (prepared: PreparedTool, context: ToolExecutionContext, command: { cwd: string; beforeStart(): Promise<void> }): Promise<ToolResult> => {
    current(context); credentials(prepared);
    if (prepared.call.name !== 'start_command' || entries.size >= 8 || [...entries.values()].filter(entry => entry.phase === 'prepared' || entry.phase === 'running').length >= 2) return { status: 'not_executed', output: { error: 'command_handle_capacity_exhausted' } };
    const remaining = Math.floor(options.remainingMs());
    if (remaining < 1) return { status: 'not_executed', output: { error: 'command_run_budget_exhausted' } };
    const timeoutMs = Math.min(integer(prepared.input.timeoutMs, 120000, 1, 3600000), remaining), maxOutputBytes = integer(prepared.input.maxOutputBytes, 16384, 256, 65536);
    const entry: Entry = { commandId: randomUUID(), maxOutputBytes, prepared: structuredClone(prepared), phase: 'prepared', preparedWritten: false };
    entries.set(entry.commandId, entry);
    try {
      await options.onPrepared?.(prepared, context.signal);
      current(context);
      await save(entry, { commandId: entry.commandId, status: 'prepared', taskId: options.taskId,
        command: { executable: String(prepared.input.executable), argv: prepared.input.argv as string[], cwd: String(prepared.input.cwd) }, timeoutMs, maxOutputBytes, at: new Date().toISOString() });
      entry.preparedWritten = true;
      try { await command.beforeStart(); current(context); }
      catch {
        await finish(entry, emptyResult(options.signal.aborted || context.signal.aborted, 'Command launch preconditions changed; it was not executed.'));
        return { status: 'not_executed', output: observe(entry) };
      }
      const budgetNow = Math.floor(options.remainingMs());
      if (budgetNow < 1) {
        await finish(entry, emptyResult(false, 'Command run budget exhausted before launch; it was not executed.'));
        return { status: 'not_executed', output: observe(entry) };
      }
      entry.handle = options.supervisor.start(options.identity.runId, { executable: String(prepared.input.executable), argv: [...prepared.input.argv as string[]], cwd: command.cwd,
        timeoutMs: Math.min(timeoutMs, budgetNow), maxOutputBytes }, options.signal, options.forbiddenValues);
      entry.ready = (async () => {
        if (await entry.handle!.started) { await save(entry, { commandId: entry.commandId, status: 'running', at: new Date().toISOString() }); entry.phase = 'running'; }
      })();
      entry.terminal = (async () => { await entry.ready; await finish(entry, await entry.handle!.closed); })().catch(() => failedLifecycle(entry));
      await entry.ready;
      if (entry.handle.snapshot().settled) await entry.terminal;
      return { status: entry.phase === 'unknown' ? 'unknown' : 'completed', output: observe(entry) };
    } catch {
      // An attempted durable prepared write can be uncertain even before spawn.
      await failedLifecycle(entry);
      return { status: 'unknown', output: { commandId: entry.commandId, state: 'unknown', error: 'command_lifecycle_unconfirmed' } };
    }
  };
  const controlState = (prepared: PreparedTool, context: ToolExecutionContext) => {
    current(context);
    const state = controls.get(prepared.call.id);
    if (!state || encode(state.prepared) !== encode(prepared) || prepared.policyRevision !== context.policyRevision) throw new Error('Command control binding changed.');
    const entry = entries.get(String(prepared.input.commandId)); if (!entry) throw new Error('Unknown command handle for this run.');
    return { state, entry };
  };
  const wait = (entry: Entry, ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
    const done = () => { cleanup(); resolve(); }, abort = () => { cleanup(); reject(new Error('Command observation cancelled.')); };
    const timer = setTimeout(done, ms); signal.addEventListener('abort', abort, { once: true });
    void entry.terminal?.then(done, done); if (signal.aborted) abort();
  });
  return {
    definitions: structuredClone(definitions),
    start(prepared, context, command) {
      const operation = start(prepared, context, command); starts.add(operation);
      void operation.finally(() => starts.delete(operation)).catch(() => {}); return operation;
    },
    async prepare(call, context) {
      current(context); await options.assertOwnership(); current(context);
      const definition = definitions.find(item => item.name === call.name);
      if (!definition || !call.id || call.id.length > 256 || controls.size >= 256 || Buffer.byteLength(call.arguments) > 2048) throw new Error('Invalid command control.');
      const input = JSON.parse(call.arguments) as JsonObject;
      const optional = call.name === 'command_status' ? ['waitMs'] : call.name === 'read_command_output' ? ['stream', 'offset', 'limit'] : [];
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['commandId', ...optional].includes(key)) || typeof input.commandId !== 'string' || !entries.has(input.commandId)) throw new Error('Unknown command handle for this run.');
      if (call.name === 'command_status') integer(input.waitMs, 0, 0, 1000);
      if (call.name === 'read_command_output') {
        if (!['stdout', 'stderr'].includes(String(input.stream))) throw new Error('Invalid output stream.');
        integer(input.offset, 0, 0, 65536); integer(input.limit, 4096, 1, 4096);
      }
      credentials(input);
      const prepared: PreparedTool = { call: structuredClone(call), definition: structuredClone(definition), input, inputDigest: digest(input), policyRevision: context.policyRevision, requiresApproval: false,
        preconditions: { runId: options.identity.runId, taskId: options.taskId, commandId: input.commandId } };
      const prior = controls.get(call.id);
      if (prior && encode(prior.prepared) !== encode(prepared)) throw new Error('Command control identity was reused.');
      controls.set(call.id, prior ?? { prepared: structuredClone(prepared) }); return prepared;
    },
    async validate(prepared, context) { controlState(prepared, context); await options.assertOwnership(); controlState(prepared, context); },
    async execute(prepared, context) {
      const { state, entry } = controlState(prepared, context);
      await options.assertOwnership(); controlState(prepared, context);
      state.execution ??= (async (): Promise<ToolResult> => {
        if (prepared.call.name === 'stop_command') { if (entry.handle) await entry.handle.stop(); await entry.terminal; }
        else if (prepared.call.name === 'command_status' && Number(prepared.input.waitMs ?? 0) > 0 && entry.phase !== 'finished' && entry.phase !== 'unknown') await wait(entry, Number(prepared.input.waitMs), context.signal);
        if (failed) return { status: 'unknown', output: { commandId: entry.commandId, state: 'unknown', error: 'command_lifecycle_unconfirmed' } };
        await options.assertOwnership(); controlState(prepared, context);
        const metadata = observe(entry);
        if (failed) return { status: 'unknown', output: { commandId: entry.commandId, state: 'unknown', error: 'command_lifecycle_unconfirmed' } };
        let output: JsonObject = metadata;
        if (prepared.call.name === 'read_command_output') {
          const raw = entry.final ?? sanitized(entry.handle!.snapshot().result, false, entry.maxOutputBytes), stream = prepared.input.stream as 'stdout' | 'stderr', text = raw[stream];
          const offset = integer(prepared.input.offset, 0, 0, 65536), limit = Math.min(integer(prepared.input.limit, 4096, 1, 4096), Math.max(1, Math.floor((context.maxOutputBytes - 1024) / 6)));
          if (offset > text.length || lowSurrogate(text.charCodeAt(offset))) throw new Error('Output offset is outside the safe prefix or splits a surrogate pair.');
          const end = offset + prefix(text.slice(offset), Math.min(limit, text.length - offset)).length;
          if (end === offset && offset < text.length) return { status: 'failed', output: { error: 'page_limit_too_small', commandId: entry.commandId, offset, minimumLimit: 2 } };
          output = { ...metadata, stream, offset, nextOffset: end, currentEnd: text.length, text: text.slice(offset, end), hasMore: end < text.length };
        }
        if (failed) return { status: 'unknown', output: { commandId: entry.commandId, state: 'unknown', error: 'command_lifecycle_unconfirmed' } };
        credentials(output);
        if (Buffer.byteLength(JSON.stringify(output)) > context.maxOutputBytes) return { status: 'failed', output: { error: 'command_control_output_budget_exceeded' } };
        return { status: entry.phase === 'unknown' ? 'unknown' : 'completed', output };
      })();
      return structuredClone(await state.execution);
    },
    async closeAll() {
      closing = true;
      await Promise.allSettled([...starts]);
      await Promise.all([...entries.values()].map(async entry => {
        if (entry.handle) { try { await entry.handle.stop(); } catch { notifyFailure(); } }
        await entry.terminal;
      }));
      if (failed || [...entries.values()].some(entry => entry.phase !== 'finished')) throw new Error('Command cleanup or durable terminal receipt remains unconfirmed.');
    },
  };
}
