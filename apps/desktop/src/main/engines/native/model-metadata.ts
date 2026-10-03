import { assertNoModelCredential, ResponsesModelError } from '@cc-desk/agent-node/responses-model';
import type { ModelCapabilitySource } from '@cc-desk/contracts/execution';
import type { NativeConnectionModelListCode, NativeModelCapabilities, NativeModelMetadata } from '../../../shared/native-connections';
import { validateNativeBaseURL, type ResolvedNativeConnection } from './connections';

export const nativeMetadataLimits = Object.freeze({ timeoutMs: 30_000, responseBytes: 1024 * 1024, pages: 10, models: 1000, pageSize: 100 });
export interface NativeMetadataResult { code: NativeConnectionModelListCode; models?: NativeModelMetadata[]; durationMs: number; httpStatus?: number }
class MetadataFailure extends Error {
  constructor(readonly code: NativeConnectionModelListCode, readonly httpStatus?: number) { super('Model metadata request failed.'); }
}
function fail(code: NativeConnectionModelListCode): never { throw new MetadataFailure(code); }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const safeText = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200 && value.trim() === value && !/[\x00-\x1f\x7f]/.test(value);
const tokenLimit = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= 10_000_000;

export function nativeModelEndpoint(connection: ResolvedNativeConnection): URL {
  const url = new URL(validateNativeBaseURL(connection.baseURL, connection.allowLoopbackHttp));
  const pathname = url.pathname.replace(/\/+$/, '');
  url.pathname = connection.protocol === 'anthropic'
    ? pathname.endsWith('/v1/messages') ? pathname.slice(0, -'/messages'.length) + '/models' : pathname.endsWith('/v1') ? pathname + '/models' : pathname + '/v1/models'
    : pathname + '/models';
  return url;
}

/** Null and zero in catalog schemas mean unknown. Malformed supplied limits reject the response. */
export function parseNativeModelMetadata(value: unknown, protocol: ResolvedNativeConnection['protocol'], source: ModelCapabilitySource): NativeModelMetadata {
  if (!record(value) || !safeText(value.id)) return fail('protocol');
  const name = value.display_name ?? value.name;
  if (name !== undefined && name !== null && !safeText(name)) return fail('protocol');
  const number = (keys: string[]): number | undefined => {
    let selected: number | undefined;
    for (const key of keys) {
      const candidate = value[key];
      if (candidate === undefined || candidate === null || candidate === 0) continue;
      if (!tokenLimit(candidate)) return fail('protocol');
      // Conflicting synonymous fields never widen a declared limit.
      selected = selected === undefined ? candidate : Math.min(selected, candidate);
    }
    return selected;
  };
  const input = number(['max_input_tokens']), output = number(['max_output_tokens', 'max_tokens']);
  const context = number(['context_window', 'context_length']) ?? (protocol === 'anthropic' ? input : undefined);
  const capabilities: NativeModelCapabilities = {
    ...(context === undefined ? {} : { contextWindow: { value: context, source } }),
    ...(input === undefined ? {} : { maxInputTokens: { value: input, source } }),
    ...(output === undefined ? {} : { maxOutputTokens: { value: output, source } }),
  };
  return { id: value.id, ...(typeof name === 'string' ? { name } : {}), ...(Object.keys(capabilities).length ? { capabilities } : {}) };
}

function statusFailure(status: number): MetadataFailure {
  const code = status >= 300 && status < 400 ? 'redirect' : status === 401 ? 'authentication' : status === 403 ? 'permission'
    : status === 404 ? 'endpoint' : status === 429 ? 'rate_limit' : status >= 500 ? 'service' : 'http';
  return new MetadataFailure(code, status);
}

/** Shared GET-only transport. No provider response, errors, cursors, URL or credential crosses IPC. */
export async function readNativeModelMetadata(connection: ResolvedNativeConnection, options: { signal: AbortSignal; timeoutMs?: number; kind: 'detail' | 'list' }): Promise<NativeMetadataResult> {
  const started = performance.now(), elapsed = () => Math.max(0, Math.round(performance.now() - started));
  const timeoutMs = options.timeoutMs ?? nativeMetadataLimits.timeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > nativeMetadataLimits.timeoutMs) return { code: 'configuration', durationMs: elapsed() };
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  options.signal.addEventListener('abort', abort, { once: true });
  if (options.signal.aborted) abort();
  const timer = setTimeout(() => { if (!controller.signal.aborted) { timedOut = true; controller.abort(); } }, timeoutMs);
  let totalBytes = 0;
  try {
    const endpoint = nativeModelEndpoint(connection);
    if (options.kind === 'detail') {
      if (!safeText(connection.model) || connection.model === '.' || connection.model === '..') fail('configuration');
      endpoint.pathname += '/' + encodeURIComponent(connection.model);
    }
    assertNoModelCredential(connection.model, connection.apiKey);
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (connection.protocol === 'anthropic') {
      headers['anthropic-version'] = '2023-06-01';
      headers[connection.authHeader ?? 'x-api-key'] = connection.authHeader === 'authorization' ? `Bearer ${connection.apiKey}` : connection.apiKey;
    } else headers.Authorization = `Bearer ${connection.apiKey}`;
    const models = new Map<string, NativeModelMetadata>(), cursors = new Set<string>();
    let cursor: string | undefined;
    const completed = (): NativeMetadataResult => {
      if (timedOut || performance.now() - started >= timeoutMs) fail('timeout');
      if (controller.signal.aborted) fail('cancelled');
      const metadata = [...models.values()];
      assertNoModelCredential(JSON.stringify(metadata), connection.apiKey);
      assertNoModelCredential(metadata, connection.apiKey);
      assertNoModelCredential(metadata.flatMap(item => [item.id, item.name ?? '']).join(''), connection.apiKey);
      assertNoModelCredential(metadata.flatMap(item => [item.name ?? '', item.id]).join(''), connection.apiKey);
      assertNoModelCredential(metadata.flatMap(item => item.name && item.name !== item.id ? [item.name, item.id] : [item.id]).join(''), connection.apiKey);
      return { code: 'ok', models: metadata, durationMs: elapsed() };
    };
    for (let page = 0; page < nativeMetadataLimits.pages; page++) {
      if (controller.signal.aborted) fail(timedOut ? 'timeout' : 'cancelled');
      const url = new URL(endpoint);
      if (options.kind === 'list' && connection.protocol === 'anthropic') { url.searchParams.set('limit', String(nativeMetadataLimits.pageSize)); if (cursor) url.searchParams.set('after_id', cursor); }
      const response = await fetch(url, { method: 'GET', headers, signal: controller.signal, redirect: 'manual' });
      if (!response.ok) { try { await response.body?.cancel(); } catch { /* Keep the fixed status. */ } throw statusFailure(response.status); }
      if (!response.body || !/^(?:application\/json|application\/[\w.+-]+\+json)(?:\s*;|\s*$)/i.test(response.headers.get('content-type') ?? '')) {
        try { await response.body?.cancel(); } catch { /* Never expose rejected content. */ } fail('protocol');
      }
      const declared = response.headers.get('content-length');
      if (declared && /^\d+$/.test(declared) && Number(declared) > nativeMetadataLimits.responseBytes - totalBytes) {
        try { await response.body.cancel(); } catch { /* The limit remains authoritative. */ } fail('response_limit');
      }
      const reader = response.body.getReader();
      let text = '';
      try {
        const decoder = new TextDecoder('utf-8', { fatal: true });
        while (true) {
          const chunk = await reader.read(); if (chunk.done) break;
          totalBytes += chunk.value.byteLength; if (totalBytes > nativeMetadataLimits.responseBytes) fail('response_limit');
          try { text += decoder.decode(chunk.value, { stream: true }); } catch { fail('protocol'); }
        }
        try { text += decoder.decode(); } catch { fail('protocol'); }
      } finally { try { await reader.cancel(); } catch { /* Return only fixed failures. */ } reader.releaseLock(); }
      let body: unknown; try { body = JSON.parse(text); } catch { fail('protocol'); }
      // Raw numeric echoes are not string nodes in decoded JSON; inspect both representations.
      assertNoModelCredential(text, connection.apiKey);
      assertNoModelCredential(body, connection.apiKey);
      if (options.kind === 'detail') { const item = parseNativeModelMetadata(body, connection.protocol, 'provider'); models.set(item.id, item); return completed(); }
      if (!record(body) || !Array.isArray(body.data)) fail('protocol');
      if (body.data.length > nativeMetadataLimits.models) fail('response_limit');
      for (const raw of body.data) {
        const item = parseNativeModelMetadata(raw, connection.protocol, 'catalog');
        const previous = models.get(item.id);
        if (!previous) models.set(item.id, item);
        else if (item.capabilities) {
          const capabilities: NativeModelCapabilities = { ...previous.capabilities };
          for (const field of ['contextWindow', 'maxInputTokens', 'maxOutputTokens'] as const) {
            const next = item.capabilities[field], before = capabilities[field];
            if (next) capabilities[field] = { value: before ? Math.min(before.value, next.value) : next.value, source: 'catalog' };
          }
          // Stable display metadata, conservative per-field limits across duplicate/page entries.
          models.set(item.id, { ...previous, capabilities });
        }
        if (models.size > nativeMetadataLimits.models) fail('response_limit');
      }
      if (connection.protocol !== 'anthropic') { if (body.has_more !== undefined && body.has_more !== false) fail('protocol'); return completed(); }
      if (body.has_more !== undefined && typeof body.has_more !== 'boolean' || body.last_id !== undefined && body.last_id !== null && !safeText(body.last_id)) fail('protocol');
      if (body.has_more !== true) return completed();
      if (!body.data.length || !safeText(body.last_id) || cursors.has(body.last_id)) fail('protocol');
      if (page === nativeMetadataLimits.pages - 1) fail('response_limit');
      cursors.add(body.last_id); cursor = body.last_id;
    }
    return fail('response_limit');
  } catch (error) {
    const status = timedOut ? { code: 'timeout' as const } : controller.signal.aborted ? { code: 'cancelled' as const }
      : error instanceof MetadataFailure ? { code: error.code, ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }) }
      : error instanceof ResponsesModelError && error.code === 'credential_echo' ? { code: 'credential_echo' as const } : { code: 'transport' as const };
    return { ...status, durationMs: elapsed() };
  } finally { clearTimeout(timer); options.signal.removeEventListener('abort', abort); }
}
