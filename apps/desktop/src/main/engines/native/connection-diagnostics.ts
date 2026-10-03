import { z } from 'zod';
import { ResponsesModelError } from '@cc-desk/agent-node/responses-model';
import { ChatCompletionsModelError } from '@cc-desk/agent-node/chat-completions-model';
import { AnthropicModelError } from '@cc-desk/agent-node/anthropic-model';
import { createNativeModel, extractNativeAssistantText } from '@cc-desk/agent-node/native-model';
import { estimateNativeCost } from '../../../shared/native-cost';
import type { ModelResponse, Usage } from '@cc-desk/agent-core';
import type { NativeConnectionTestCode, NativeConnectionTestInput, NativeConnectionTestResult } from '../../../shared/native-connections';
import type { ConnectionStore, ResolvedNativeConnection } from './connections';

export const nativeConnectionTestSchema = z.object({
  id: z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  requestId: z.string().uuid(),
}).strict();
export const nativeConnectionTestCancelSchema = nativeConnectionTestSchema.pick({ requestId: true }).strict();

interface DiagnosticRequest {
  input: NativeConnectionTestInput;
  controller: AbortController;
  promise: Promise<NativeConnectionTestResult>;
}

/** Fixed low-volume request, with no project context, tools, follow-up, or retries. */
export const nativeConnectionProbe = Object.freeze({
  prompt: 'Reply with the single word OK. This is a connection test.',
  maxOutputTokens: 256,
  timeoutMs: 30_000,
});

function safeUsage(usage: Usage | null): Usage | undefined {
  if (!usage) return undefined;
  const result: Usage = {};
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens'] as const) {
    const value = usage[key];
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) result[key] = value;
  }
  return Object.keys(result).length ? result : undefined;
}

function responseCode(response: ModelResponse): NativeConnectionTestCode {
  if (response.toolCalls.length || response.finishReason === 'tool_calls') return 'unexpected_tool';
  if (response.finishReason === 'refused') return 'refused';
  if (response.finishReason !== 'completed') return 'incomplete';
  const hasText = Boolean(extractNativeAssistantText(response.outputItems).trim());
  return hasText ? 'ok' : 'protocol';
}

/** Never serialize the original error, its message/cause, or any provider data. */
function failure(error: unknown): Pick<NativeConnectionTestResult, 'code' | 'httpStatus'> {
  if (!(error instanceof ResponsesModelError) && !(error instanceof ChatCompletionsModelError) && !(error instanceof AnthropicModelError)) return { code: 'transport' };
  if (error.code === 'http') {
    const status = error.httpStatus;
    if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599) return { code: 'http' };
    const code = status === 401 ? 'authentication' : status === 403 ? 'permission' : status === 404 ? 'endpoint'
      : status === 429 ? 'rate_limit' : status >= 500 ? 'service' : 'http';
    return { code, httpStatus: status };
  }
  const codes: Record<string, NativeConnectionTestCode> = {
    configuration: 'configuration', credential: 'configuration', cancelled: 'cancelled', timeout: 'timeout',
    redirect: 'redirect', schema: 'protocol', protocol: 'protocol', unsupported: 'protocol', interrupted: 'incomplete',
    incomplete: 'incomplete', provider: 'service', credential_echo: 'credential_echo',
    request_limit: 'configuration', response_limit: 'response_limit', transport: 'transport',
  };
  return { code: Object.hasOwn(codes, error.code) ? codes[error.code] : 'transport' };
}

/** Main-only, opt-in protocol check. Calling list/readiness never creates this request. */
export class NativeConnectionDiagnostics {
  private active?: DiagnosticRequest;
  private readonly recent = new Map<string, DiagnosticRequest>();
  private closing = false;

  constructor(private readonly connections: ConnectionStore, private readonly options: {
    onChanged?: () => void;
    /** Internal test seam, not a renderer-controlled timeout. */
    timeoutMs?: number;
  } = {}) {}

  isConnectionTesting(id: string): boolean { return this.active?.input.id === id; }

  test(input: NativeConnectionTestInput): Promise<NativeConnectionTestResult> {
    const parsed = nativeConnectionTestSchema.safeParse(input);
    if (!parsed.success) throw new Error('模型连接测试请求格式无效。');
    const value = parsed.data;
    const result = (code: NativeConnectionTestCode): Promise<NativeConnectionTestResult> => Promise.resolve({ requestId: value.requestId, code, durationMs: 0 });
    if (this.closing) return result('cancelled');
    const previous = this.recent.get(value.requestId);
    if (previous) return previous.input.id === value.id && previous.input.revision === value.revision ? previous.promise : result('configuration');
    if (this.active) return result('busy');
    let connection: ResolvedNativeConnection;
    try { connection = this.connections.resolveForDiagnostic({ id: value.id, revision: value.revision }); }
    catch { return result('configuration'); }
    const entry: DiagnosticRequest = { input: value, controller: new AbortController(), promise: result('busy') };
    // Acquire before scheduling network work, so mutation/start/cancel cannot race it.
    this.active = entry;
    entry.promise = Promise.resolve().then(() => this.run(entry, connection)).finally(() => {
      if (this.active === entry) this.active = undefined;
      this.options.onChanged?.();
    });
    this.recent.set(value.requestId, entry);
    // Bound completed result retention; no response bodies or secrets are cached.
    while (this.recent.size > 32) this.recent.delete(this.recent.keys().next().value!);
    this.options.onChanged?.();
    return entry.promise;
  }

  cancel(input: { requestId: string }): void {
    const parsed = nativeConnectionTestCancelSchema.safeParse(input);
    if (!parsed.success) throw new Error('模型连接测试请求格式无效。');
    if (this.active?.input.requestId === parsed.data.requestId) this.active.controller.abort();
  }

  /** Renderer navigation, crash, and destruction have no reliable unmount callback. */
  cancelAll(): void { this.active?.controller.abort(); }

  async shutdown(): Promise<void> {
    this.closing = true;
    this.cancelAll();
    await this.active?.promise;
    this.recent.clear();
  }

  /** A failed application quit leaves the settings screen available for use. */
  resumeAfterFailedShutdown(): void { this.closing = false; }

  private async run(entry: DiagnosticRequest, connection: ResolvedNativeConnection): Promise<NativeConnectionTestResult> {
    const started = performance.now();
    const elapsed = (): number => Math.max(0, Math.round(performance.now() - started));
    const common = { requestId: entry.input.requestId };
    try {
      const model = createNativeModel({
        protocol: connection.protocol, authHeader: connection.authHeader, baseURL: connection.baseURL, model: connection.model, apiKey: connection.apiKey,
        allowLoopbackHttp: connection.allowLoopbackHttp, timeoutMs: this.options.timeoutMs ?? nativeConnectionProbe.timeoutMs,
        maxRequestBytes: 4096, maxResponseBytes: 256 * 1024,
      });
      const response = await model.generate({
        identity: { sessionId: entry.input.requestId, conversationId: entry.input.requestId, runId: entry.input.requestId, requestId: entry.input.requestId, workerGeneration: 1 },
        context: { protocol: model.protocol, items: model.userItems(nativeConnectionProbe.prompt) },
        tools: [], maxOutputTokens: nativeConnectionProbe.maxOutputTokens,
        signal: entry.controller.signal, onEvent: () => {},
      });
      const usage = safeUsage(response.usage);
      const estimatedCostUSD = estimateNativeCost(usage, connection.pricing, connection.model);
      return { ...common, ...(estimatedCostUSD === undefined ? {} : { estimatedCostUSD }), code: entry.controller.signal.aborted ? 'cancelled' : responseCode(response), durationMs: elapsed(), ...(usage ? { usage } : {}) };
    } catch (error) {
      return { ...common, ...(entry.controller.signal.aborted ? { code: 'cancelled' as const } : failure(error)), durationMs: elapsed() };
    }
  }
}
