import path from 'node:path';
import { createHash } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import { canonicalJson, DEFAULT_RUN_BUDGET, type AgentEvent, type AgentRunRequest, type ApprovalDecision, type ApprovalPort, type ApprovalRequest, type BeginRunRequest, type JsonValue, type ModelContext, type ModelResponse, type PreparedTool, type RunIdentity, type RunJournalEvent, type RunResult, type RunStore, type ToolCall, type ToolExecutionContext, type ToolPort, type ToolResult } from '@cc-desk/agent-core';
import { assertNoModelCredential, ResponsesModelError, SafeModelDeltas, type ResponsesModelOptions } from '@cc-desk/agent-node/responses-model';
import { checkedMessage, MAX_WORKER_PENDING, sameRun, WORKER_PROTOCOL } from './worker-protocol';

interface NativeWorkerStream extends NodeJS.ReadableStream { destroyed?: boolean; readableEnded?: boolean }
export interface NativeWorkerChild extends EventEmitter {
  pid?: number;
  stdout: NativeWorkerStream | null;
  stderr: NativeWorkerStream | null;
  postMessage(message: unknown): void;
  kill(): boolean;
}
export interface NativeWorkerForkOptions {
  env: NodeJS.ProcessEnv;
  stdio: 'pipe';
  serviceName: string;
  execArgv: string[];
}
export type NativeWorkerFork = (modulePath: string, args: string[], options: NativeWorkerForkOptions) => NativeWorkerChild | Promise<NativeWorkerChild>;
export interface NativeWorkerOptions {
  request: Omit<AgentRunRequest, 'signal'>;
  model: ResponsesModelOptions;
  tools: ToolPort;
  store: RunStore;
  approvals: ApprovalPort;
  onEvent(event: AgentEvent): void | Promise<void>;
  signal: AbortSignal;
  workerPath?: string;
  fork?: NativeWorkerFork;
}

export class NativeWorkerError extends Error {
  constructor(readonly code: string, message = 'Native worker execution failed.') {
    super(message);
    this.name = 'NativeWorkerError';
  }
}
/** The caller must retain directory/resource ownership when this is thrown. */
export class NativeWorkerCleanupError extends NativeWorkerError {
  readonly cleanupUnconfirmed = true;
  constructor() { super('cleanup_unconfirmed', 'Native worker or tool resource release could not be confirmed.'); this.name = 'NativeWorkerCleanupError'; }
}
class InvalidWorkerMessage extends Error {}
function invalid(): never { throw new InvalidWorkerMessage('Invalid native worker message.'); }
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const string = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const equal = (a: unknown, b: unknown): boolean => canonicalJson(a as JsonValue) === canonicalJson(b as JsonValue);

function fields(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!isObject(value) || required.some(key => !(key in value)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) return invalid();
  return value;
}
function identity(value: unknown, expected: RunIdentity): asserts value is RunIdentity {
  const item = fields(value, ['sessionId', 'conversationId', 'runId', 'requestId', 'workerGeneration']);
  if (![item.sessionId, item.conversationId, item.runId, item.requestId].every(string) || !integer(item.workerGeneration) || !sameRun(value as RunIdentity, expected)) invalid();
}
function context(value: unknown): asserts value is ModelContext {
  const item = fields(value, ['protocol', 'items'], ['continuation']);
  const protocol = fields(item.protocol, ['id', 'version']);
  if (!string(protocol.id) || !integer(protocol.version) || !Array.isArray(item.items)) invalid();
}
function call(value: unknown): asserts value is ToolCall {
  const item = fields(value, ['id', 'name', 'arguments']);
  if (!string(item.id) || !string(item.name) || typeof item.arguments !== 'string') invalid();
}
function usage(value: unknown): void {
  if (value === null) return;
  const item = fields(value, [], ['inputTokens', 'outputTokens', 'totalTokens']);
  if (!Object.values(item).every(integer)) invalid();
}
function toolResult(value: unknown): asserts value is ToolResult {
  const item = fields(value, ['status', 'output'], ['effects', 'truncated']);
  if (!['completed', 'failed', 'denied', 'cancelled', 'not_executed', 'unknown'].includes(item.status as string) || (item.truncated !== undefined && typeof item.truncated !== 'boolean')) invalid();
}
function result(value: unknown, expected: RunIdentity): asserts value is RunResult {
  const item = fields(value, ['identity', 'status', 'reason', 'modelRequests', 'toolCalls', 'usage', 'context', 'committed'], ['projectionError']);
  identity(item.identity, expected);
  if (!['completed', 'failed', 'cancelled', 'budget_exhausted', 'recovery_required'].includes(item.status as string) ||
      typeof item.reason !== 'string' || !integer(item.modelRequests) || !integer(item.toolCalls) || typeof item.committed !== 'boolean' ||
      (item.projectionError !== undefined && item.projectionError !== 'projection_failed')) invalid();
  usage(item.usage);
  context(item.context);
}

function workerEnvironment(secret: string | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  // No inherited authentication, Node options, preload hooks, proxy credentials,
  // or diagnostic settings. Tools receive a separate environment in ToolPort.
  for (const name of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'TZ']) {
    const value = process.env[name];
    if (value !== undefined && (!secret || !value.includes(secret))) env[name] = value;
  }
  return env;
}
const defaultFork: NativeWorkerFork = async (file, args, options) => {
  const { app, utilityProcess } = await import('electron');
  await app.whenReady();
  return utilityProcess.fork(file, args, options);
};

interface ToolState {
  prepared: PreparedTool;
  approval?: ApprovalDecision;
  validated: boolean;
  recorded: boolean;
  executing: boolean;
  executed: boolean;
  result?: ToolResult;
}

/** Host-owned stores, approvals and tools remain authoritative across worker loss. */
export async function runNativeWorker(options: NativeWorkerOptions): Promise<RunResult> {
  if (options.signal.aborted) throw new NativeWorkerError('cancelled', 'Native worker start cancelled.');
  const run = clone(options.request);
  const runIdentity = run.identity;
  const budget = { ...DEFAULT_RUN_BUDGET, ...run.budget };
  let child: NativeWorkerChild;
  try {
    child = await (options.fork ?? defaultFork)(options.workerPath ?? path.join(__dirname, '../native/worker.cjs'), [], {
      env: workerEnvironment(options.model.apiKey), stdio: 'pipe', serviceName: 'cc-desk native agent', execArgv: [],
    });
  } catch { throw new NativeWorkerError('spawn', 'Native worker could not start.'); }

  return await new Promise<RunResult>((resolve, reject) => {
    const abort = new AbortController();
    const inFlight = new Map<string, { controller: AbortController; work: Promise<void> }>();
    const toolStates = new Map<string, ToolState>();
    const completedTools = new Map<string, ToolResult>();
    const calls = new Map<string, ToolCall>();
    const pendingCalls: string[] = [];
    const streams = new Set<NativeWorkerStream>();
    const projectionQueue: AgentEvent[] = [];
    const safeDeltas = new SafeModelDeltas(options.model.apiKey, event => { projectionQueue.push({ ...event, identity: runIdentity }); });
    let projectionChain: Promise<void> = Promise.resolve();
    let requestSequence = 0, replySequence = 0, started = false, exited = false, exitCode: number | undefined;
    let done: RunResult | undefined, committedResult: RunResult | undefined, savedContext: ModelContext | undefined;
    let duplicateResult: RunResult | undefined, begun = false, startingRun = false;
    let activeTool: string | undefined;
    let failure: NativeWorkerError | undefined;
    let settled = false, outputBytes = 0;
    let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
    let hardTimer: ReturnType<typeof setTimeout> | undefined;
    const startupTimer = setTimeout(() => stop(new NativeWorkerError('startup', 'Native worker did not become ready.')), 10_000);

    function post(message: unknown): boolean {
      if (exited || settled) return false;
      try { checkedMessage(message); child.postMessage(message); return true; }
      catch { stop(new NativeWorkerError('transport')); return false; }
    }
    function checkFinished(): void {
      if (settled || !exited || inFlight.size || streams.size) return;
      settled = true;
      cleanup();
      if (failure) reject(failure);
      else if (!done || exitCode !== 0) reject(new NativeWorkerError('crash'));
      else resolve(done);
    }
    function cleanup(): void {
      clearTimeout(startupTimer);
      clearTimeout(shutdownTimer);
      clearTimeout(hardTimer);
      options.signal.removeEventListener('abort', cancel);
      child.off('message', onMessage);
      child.off('exit', onExit);
      // Keep a no-op error listener: a delayed diagnostic must never be logged as
      // an unhandled EventEmitter error after ownership has been handed back.
      child.off('error', onError);
      child.on('error', () => {});
    }
    function armShutdown(): void {
      if (shutdownTimer || hardTimer || settled) return;
      shutdownTimer = setTimeout(() => {
        shutdownTimer = undefined;
        if (!exited) {
          try { child.kill(); } catch { /* confirmed exit is still required */ }
        }
        hardTimer = setTimeout(() => {
          if (settled) return;
          if (exited && !inFlight.size && !streams.size) { checkFinished(); return; }
          settled = true;
          cleanup();
          reject(new NativeWorkerCleanupError());
          // Keep consuming output and observing in-flight operations; the caller
          // retains the recovery barrier until a separate reconciliation.
        }, 10_000);
        checkFinished();
      }, 10_000);
    }
    function cancelControllers(): void {
      abort.abort();
      for (const item of inFlight.values()) item.controller.abort();
    }
    function stop(error: NativeWorkerError): void {
      if (!failure) failure = error;
      cancelControllers();
      if (!exited) {
        // Avoid recursively calling post() if the worker channel itself failed.
        try { child.postMessage({ type: 'cancel', version: WORKER_PROTOCOL, identity: runIdentity }); } catch { /* kill fallback */ }
      }
      armShutdown();
      checkFinished();
    }
    function cancel(): void {
      cancelControllers();
      if (started) post({ type: 'cancel', version: WORKER_PROTOCOL, identity: runIdentity });
      armShutdown();
    }
    function onError(): void { stop(new NativeWorkerError('crash')); }
    function onExit(code: number): void {
      exited = true;
      exitCode = code;
      if (!done || code !== 0) stop(new NativeWorkerError('crash'));
      else { cancelControllers(); armShutdown(); }
      checkFinished();
    }
    function execution(value: unknown, signal: AbortSignal): ToolExecutionContext {
      const item = fields(value, ['identity', 'policyRevision', 'maxOutputBytes']);
      identity(item.identity, runIdentity);
      if (item.policyRevision !== run.policyRevision || item.maxOutputBytes !== budget.maxToolOutputBytes) invalid();
      return { identity: runIdentity, policyRevision: run.policyRevision, maxOutputBytes: budget.maxToolOutputBytes, signal };
    }
    function requireContext(value: unknown): ModelContext {
      context(value);
      if (!savedContext || !equal(value, savedContext)) invalid();
      return clone(savedContext);
    }
    function requireCall(value: unknown): ToolCall {
      call(value);
      const actual = calls.get(value.id);
      if (!actual || !equal(actual, value) || pendingCalls[0] !== value.id) return invalid();
      return actual;
    }
    function requirePrepared(value: unknown): ToolState {
      if (!isObject(value) || !isObject(value.call) || typeof value.call.id !== 'string') return invalid();
      const state = toolStates.get(value.call.id);
      if (!state || !equal(value, state.prepared) || pendingCalls[0] !== state.prepared.call.id) return invalid();
      return state;
    }
    function requireApproval(state: ToolState, value: unknown): void {
      if (state.prepared.requiresApproval || state.prepared.definition.risk !== 'read') {
        if (!state.approval || !equal(value, state.approval) || state.approval.decision !== 'approved' || state.approval.expiresAt <= Date.now()) invalid();
      } else if (value !== undefined && (!state.approval || !equal(value, state.approval))) invalid();
    }
    function validResponse(value: unknown): ModelResponse {
      const item = fields(value, ['outputItems', 'toolCalls', 'finishReason', 'usage'], ['continuation']);
      if (!Array.isArray(item.outputItems) || !Array.isArray(item.toolCalls) || !['completed', 'tool_calls', 'refused', 'incomplete'].includes(item.finishReason as string)) invalid();
      usage(item.usage);
      const response = value as ModelResponse;
      for (const requested of response.toolCalls) {
        call(requested);
        if (calls.has(requested.id)) invalid();
      }
      const providerCalls = response.outputItems.filter(item => isObject(item) && item.type === 'function_call').map(item => {
        const provider = item as Record<string, JsonValue>;
        return { id: provider.call_id, name: provider.name, arguments: provider.arguments };
      });
      if (!equal(providerCalls, response.toolCalls) || new Set(response.toolCalls.map(item => item.id)).size !== response.toolCalls.length) invalid();
      return response;
    }

    async function dispatch(method: string, args: unknown, signal: AbortSignal): Promise<unknown> {
      if (method === 'store.beginRun') {
        const item = fields(args, ['identity', 'input', 'inputDigest', 'userItems', 'protocol', 'configuration', 'policyRevision']);
        identity(item.identity, runIdentity);
        if (begun || startingRun || item.input !== run.input || !equal(item.configuration, run.configuration) || item.policyRevision !== run.policyRevision ||
            !equal(item.protocol, { id: 'openai-responses', version: 1 }) || !equal(item.userItems, [{ role: 'user', content: run.input }])) invalid();
        const digest = createHash('sha256').update(canonicalJson({ input: run.input, userItems: item.userItems as JsonValue, protocol: item.protocol as JsonValue, configuration: run.configuration, policyRevision: run.policyRevision })).digest('hex');
        if (item.inputDigest !== digest) invalid();
        startingRun = true;
        try {
          const admission = await options.store.beginRun(clone(args as BeginRunRequest));
          begun = true;
          if (admission.kind === 'accepted') savedContext = clone(admission.context);
          else if (admission.result) duplicateResult = clone(admission.result);
          return admission;
        } finally { startingRun = false; }
      }
      if (!begun || done) invalid();
      if (method === 'store.ensureCapacity') {
        const item = fields(args, ['identity', 'bytes']);
        identity(item.identity, runIdentity);
        if (!integer(item.bytes) || item.bytes > 64 * 1024 * 1024) invalid();
        await options.store.ensureCapacity(runIdentity, item.bytes as number);
        return;
      }
      if (method === 'store.checkpoint') {
        const item = fields(args, ['identity', 'context']);
        identity(item.identity, runIdentity);
        await options.store.checkpoint(runIdentity, requireContext(item.context));
        return;
      }
      if (method === 'store.append') {
        const item = fields(args, ['identity', 'event']);
        identity(item.identity, runIdentity);
        if (!isObject(item.event) || typeof item.event.type !== 'string' || !savedContext || committedResult) invalid();
        const event = item.event as unknown as RunJournalEvent;
        let response: ModelResponse | undefined, state: ToolState | undefined;
        if (event.type === 'model_response') {
          fields(event, ['type', 'response']);
          if (pendingCalls.length) invalid();
          response = validResponse(event.response);
          // The completed response replaces streamed text in the projection.
          // Release the credential guard's withheld suffix before that durable
          // replacement, so it cannot appear as a new partial response later.
          const flushing = projectionChain.then(async () => {
            safeDeltas.finish();
            while (projectionQueue.length) await options.onEvent(projectionQueue.shift()!);
          });
          projectionChain = flushing.catch(() => {});
          await flushing;
        } else if (event.type === 'tool_prepared') {
          fields(event, ['type', 'prepared'], ['approval']);
          state = requirePrepared(event.prepared);
          if (!state.validated || state.recorded || state.executing || state.executed) invalid();
          requireApproval(state, event.approval);
        } else if (event.type === 'tool_completed') {
          fields(event, ['type', 'call', 'result', 'resultItems']);
          requireCall(event.call);
          toolResult(event.result);
          state = toolStates.get(event.call.id);
          if (state?.executing || event.result.status === 'unknown') invalid();
          // A thrown command/write after invocation has an unknown effect. The
          // worker cannot manufacture a cancellation/failure and close its ledger.
          if (state?.executed && !state.result && state.prepared.definition.risk !== 'read') invalid();
          if (state?.result ? !equal(state.result, event.result) : event.result.status === 'completed') invalid();
          if (!equal(event.resultItems, [{ type: 'function_call_output', call_id: event.call.id, output: JSON.stringify(event.result) }])) invalid();
        } else if (event.type === 'run_finished') {
          fields(event, ['type', 'result']);
          result(event.result, runIdentity);
          if (!event.result.committed || !equal(event.result.context, savedContext) || (pendingCalls.length && event.result.status !== 'recovery_required')) invalid();
        } else invalid();
        const receipt = await options.store.append(runIdentity, clone(event));
        if (event.type === 'model_response' && response) {
          savedContext!.items.push(...clone(response.outputItems));
          if (response.continuation !== undefined) savedContext!.continuation = clone(response.continuation);
          else delete savedContext!.continuation;
          for (const requested of response.toolCalls) { calls.set(requested.id, clone(requested)); pendingCalls.push(requested.id); }
        } else if (event.type === 'tool_prepared') state!.recorded = true;
        else if (event.type === 'tool_completed') { savedContext!.items.push(...clone(event.resultItems)); completedTools.set(event.call.id, clone(event.result)); pendingCalls.shift(); }
        else if (event.type === 'run_finished') committedResult = clone(event.result);
        return receipt;
      }
      if (method === 'tools.prepare') {
        const item = fields(args, ['call', 'context']);
        const requested = requireCall(item.call);
        if (!options.tools.definitions.some(definition => definition.name === requested.name)) invalid();
        const bound = execution(item.context, signal);
        if (signal.aborted || toolStates.has(requested.id)) throw new NativeWorkerError('cancelled');
        const prepared = await options.tools.prepare(clone(requested), bound);
        if (!equal(prepared.call, requested) || prepared.policyRevision !== run.policyRevision || !equal(prepared.definition, options.tools.definitions.find(definition => definition.name === requested.name))) invalid();
        toolStates.set(requested.id, { prepared: clone(prepared), validated: false, recorded: false, executing: false, executed: false });
        return prepared;
      }
      if (method === 'tools.validate') {
        const item = fields(args, ['prepared', 'context']);
        const state = requirePrepared(item.prepared);
        const bound = execution(item.context, signal);
        if (signal.aborted || state.recorded || state.executing || state.executed) throw new NativeWorkerError('cancelled');
        await options.tools.validate(clone(state.prepared), bound);
        state.validated = true;
        return;
      }
      if (method === 'tools.execute') {
        const item = fields(args, ['prepared', 'context'], ['approval']);
        const state = requirePrepared(item.prepared);
        const bound = execution(item.context, signal);
        requireApproval(state, item.approval);
        if (!state.recorded || !state.validated || state.executing || state.executed || activeTool) invalid();
        if (signal.aborted) throw new NativeWorkerError('cancelled');
        state.executing = true;
        state.executed = true;
        activeTool = state.prepared.call.id;
        try {
          const actual = await options.tools.execute(clone(state.prepared), bound, state.approval && clone(state.approval));
          toolResult(actual);
          state.result = clone(actual);
          return actual;
        } finally { state.executing = false; activeTool = undefined; }
      }
      if (method === 'approval') {
        const item = fields(args, ['binding', 'tool', 'input', 'preconditions', 'expiresAt']);
        const binding = fields(item.binding, ['sessionId', 'conversationId', 'runId', 'requestId', 'workerGeneration', 'toolCallId', 'inputDigest', 'policyRevision']);
        const state = typeof binding.toolCallId === 'string' ? toolStates.get(binding.toolCallId) : undefined;
        if (!state || state.approval || state.recorded || pendingCalls[0] !== state.prepared.call.id ||
            !equal(item.binding, { ...runIdentity, toolCallId: state.prepared.call.id, inputDigest: state.prepared.inputDigest, policyRevision: state.prepared.policyRevision }) ||
            !equal(item.tool, state.prepared.definition) || !equal(item.input, state.prepared.input) || !equal(item.preconditions, state.prepared.preconditions) ||
            typeof item.expiresAt !== 'number' || !Number.isFinite(item.expiresAt) || item.expiresAt <= Date.now() || item.expiresAt > Date.now() + budget.approvalTimeoutMs + 1000) invalid();
        if (signal.aborted) throw new NativeWorkerError('cancelled');
        const decision = await options.approvals.request(clone(args as ApprovalRequest), signal);
        fields(decision, ['binding', 'decision', 'expiresAt']);
        if (!equal(decision.binding, item.binding) || !['approved', 'denied', 'expired'].includes(decision.decision) ||
            !Number.isFinite(decision.expiresAt) || decision.expiresAt > item.expiresAt ||
            (decision.decision === 'approved' && (decision.expiresAt <= Date.now() || signal.aborted))) throw new NativeWorkerError('approval', 'Native approval was invalid or expired.');
        state.approval = clone(decision);
        return decision;
      }
      if (method === 'event') {
        if (!isObject(args) || typeof args.type !== 'string') invalid();
        identity(args.identity, runIdentity);
        if (committedResult && (args.type === 'text_delta' || args.type === 'tool_arguments_delta')) invalid();
        if (args.type === 'text_delta') {
          fields(args, ['type', 'identity', 'text']);
          if (typeof args.text !== 'string') invalid();
        } else if (args.type === 'tool_arguments_delta') {
          fields(args, ['type', 'identity', 'callId', 'delta']);
          if (!string(args.callId) || typeof args.delta !== 'string') invalid();
        } else if (args.type === 'tool_result') {
          fields(args, ['type', 'identity', 'call', 'result']);
          call(args.call);
          toolResult(args.result);
          if (!calls.has(args.call.id) || !equal(calls.get(args.call.id), args.call) || !completedTools.has(args.call.id) || !equal(completedTools.get(args.call.id), args.result)) invalid();
        } else if (args.type === 'run_finished') {
          fields(args, ['type', 'identity', 'result']);
          if (!committedResult || !equal(args.result, committedResult)) invalid();
        } else invalid();
        const event = clone(args as unknown as AgentEvent);
        const projecting = projectionChain.then(async () => {
          if (event.type === 'text_delta' || event.type === 'tool_arguments_delta') safeDeltas.push(event);
          else { safeDeltas.finish(); projectionQueue.push(event); }
          while (projectionQueue.length) await options.onEvent(projectionQueue.shift()!);
        });
        projectionChain = projecting.catch(() => {});
        await projecting;
        return;
      }
      return invalid();
    }

    function onMessage(value: unknown): void {
      if (settled) return;
      try {
        const message = checkedMessage(value);
        assertNoModelCredential(message, options.model.apiKey);
        if (message.version !== WORKER_PROTOCOL) invalid();
        if (message.type === 'ready') {
          fields(message, ['type', 'version', 'pid']);
          if (started || !integer(message.pid) || message.pid <= 0 || (child.pid !== undefined && child.pid !== message.pid)) invalid();
          started = true;
          clearTimeout(startupTimer);
          post({ type: 'start', version: WORKER_PROTOCOL, request: run, model: options.model, definitions: clone(options.tools.definitions) });
          if (abort.signal.aborted) post({ type: 'cancel', version: WORKER_PROTOCOL, identity: runIdentity });
          return;
        }
        if (!started) invalid();
        identity(message.identity, runIdentity);
        if (!integer(message.seq) || message.seq !== requestSequence + 1) invalid();
        requestSequence = message.seq;
        if (message.type === 'fatal') {
          fields(message, ['type', 'version', 'identity', 'seq', 'message']);
          stop(new NativeWorkerError('crash'));
          return;
        }
        if (message.type === 'rpc_cancel') {
          fields(message, ['type', 'version', 'identity', 'seq', 'requestId']);
          if (typeof message.requestId !== 'string') invalid();
          // A cancellation can race the reply. Unknown IDs are allowed only for
          // older requests belonging to this run; they never cancel another run.
          const prefix = `${runIdentity.runId}:`;
          const requestedSeq = message.requestId.startsWith(prefix) ? Number(message.requestId.slice(prefix.length)) : NaN;
          if (!Number.isSafeInteger(requestedSeq) || requestedSeq < 1 || requestedSeq >= message.seq) invalid();
          inFlight.get(message.requestId)?.controller.abort();
          return;
        }
        if (message.type === 'done') {
          fields(message, ['type', 'version', 'identity', 'seq', 'result']);
          if (done || inFlight.size) invalid();
          const expected = duplicateResult?.identity ?? runIdentity;
          result(message.result, expected);
          const final = message.result as RunResult;
          const durable = duplicateResult ?? committedResult;
          if (final.committed) {
            const comparable = { ...final };
            delete comparable.projectionError;
            if (!durable || !equal(comparable, durable)) invalid();
          } else if (final.status !== 'recovery_required' || (savedContext && !equal(final.context, savedContext))) invalid();
          done = clone(final);
          post({ type: 'finish', version: WORKER_PROTOCOL, identity: runIdentity });
          armShutdown();
          return;
        }
        fields(message, ['type', 'version', 'identity', 'seq', 'requestId', 'method', 'args']);
        if (message.type !== 'request' || message.requestId !== `${runIdentity.runId}:${message.seq}` || typeof message.method !== 'string' || done || inFlight.size >= MAX_WORKER_PENDING || failure) invalid();
        const controller = new AbortController();
        if (abort.signal.aborted) controller.abort();
        const requestId = message.requestId as string;
        const entry = { controller, work: Promise.resolve() };
        inFlight.set(requestId, entry);
        entry.work = Promise.resolve().then(async () => {
          const value = await dispatch(message.method as string, message.args, controller.signal);
          assertNoModelCredential(value, options.model.apiKey);
          return value;
        }).then(value => {
          if (!exited && !failure) post({ type: 'reply', version: WORKER_PROTOCOL, identity: runIdentity, seq: ++replySequence, requestId, ...(value === undefined ? {} : { value }) });
        }, error => {
          if (error instanceof InvalidWorkerMessage || (error instanceof ResponsesModelError && error.code === 'credential_echo')) stop(new NativeWorkerError('protocol', 'Native worker protocol validation failed.'));
          else if (!exited && !failure) post({ type: 'reply', version: WORKER_PROTOCOL, identity: runIdentity, seq: ++replySequence, requestId, error: 'Native host operation failed.' });
        }).finally(() => { inFlight.delete(requestId); checkFinished(); });
      } catch { stop(new NativeWorkerError('protocol', 'Native worker protocol validation failed.')); }
    }
    child.on('message', onMessage);
    child.on('exit', onExit);
    child.on('error', onError);
    for (const stream of [child.stdout, child.stderr]) {
      if (!stream || stream.destroyed || stream.readableEnded) continue;
      streams.add(stream);
      const ended = (): void => { streams.delete(stream); checkFinished(); };
      stream.once('end', ended);
      stream.once('close', ended);
      stream.on('error', () => stop(new NativeWorkerError('stdio')));
      stream.on('data', chunk => {
        outputBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
        if (outputBytes > 1024 * 1024 && !failure) stop(new NativeWorkerError('stdio_limit', 'Native worker output exceeded its limit.'));
      });
      stream.resume();
    }
    options.signal.addEventListener('abort', cancel, { once: true });
    if (options.signal.aborted) cancel();
  });
}
