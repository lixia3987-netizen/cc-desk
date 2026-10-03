import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNativeModelMetadata, readNativeModelMetadata } from '../src/main/engines/native/model-metadata';
import type { ResolvedNativeConnection } from '../src/main/engines/native/connections';
import { localNativeModelCapabilities } from '../src/main/engines/native/local-model-capabilities';
import { mergeNativeModelCapabilities } from '../src/main/engines/native/model-capabilities';

test('model metadata normalizes token fields with per-field source and keeps unsupported capabilities private', () => {
  assert.deepEqual(parseNativeModelMetadata({ id: 'concrete-id', display_name: 'Display', max_input_tokens: 200_000, max_tokens: 64_000,
    capabilities: { image_input: { supported: true }, ignored_private_field: 'private' }, extra: { arbitrary: true } }, 'anthropic', 'catalog'), {
    id: 'concrete-id', name: 'Display', capabilities: { contextWindow: { value: 200_000, source: 'catalog' }, maxInputTokens: { value: 200_000, source: 'catalog' }, maxOutputTokens: { value: 64_000, source: 'catalog' } },
  });
  assert.deepEqual(parseNativeModelMetadata({ id: 'proxy-model', context_window: 128_000, context_length: 64_000, max_input_tokens: 32_000, max_tokens: 16_384, max_output_tokens: 8192 }, 'responses', 'provider'), {
    id: 'proxy-model', capabilities: { contextWindow: { value: 64_000, source: 'provider' }, maxInputTokens: { value: 32_000, source: 'provider' }, maxOutputTokens: { value: 8192, source: 'provider' } },
  });
});

test('model metadata keeps absent/null/zero fields unknown, and rejects malformed supplied limits', () => {
  assert.deepEqual(parseNativeModelMetadata({ id: 'unknown', max_input_tokens: null, max_tokens: 0, context_window: null }, 'anthropic', 'provider'), { id: 'unknown' });
  assert.deepEqual(parseNativeModelMetadata({ id: 'openai', max_input_tokens: 32_000 }, 'responses', 'catalog'), { id: 'openai', capabilities: { maxInputTokens: { value: 32_000, source: 'catalog' } } });
  for (const field of ['context_window', 'context_length', 'max_input_tokens', 'max_output_tokens', 'max_tokens']) {
    for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 10_000_001, '128000', { value: 128_000 }, []]) {
      assert.throws(() => parseNativeModelMetadata({ id: 'model', [field]: value }, 'anthropic', 'provider'), error => error instanceof Error && error.message === 'Model metadata request failed.');
    }
  }
});

test('model capability merge preserves provider then catalog precedence per field without widening missing limits', () => {
  const merged = mergeNativeModelCapabilities({ contextWindow: { value: 32_000, source: 'provider' } }, {
    contextWindow: { value: 128_000, source: 'catalog' }, maxInputTokens: { value: 24_000, source: 'catalog' },
  }, { contextWindow: { value: 1_000_000, source: 'fallback' }, maxInputTokens: { value: 1_000_000, source: 'fallback' }, maxOutputTokens: { value: 8192, source: 'fallback' } });
  assert.deepEqual(merged, { contextWindow: { value: 32_000, source: 'provider' }, maxInputTokens: { value: 24_000, source: 'catalog' }, maxOutputTokens: { value: 8192, source: 'fallback' } });
  assert.deepEqual(mergeNativeModelCapabilities(undefined, undefined, {}), {});
});

test('local model capabilities use exact verified Claude IDs only on the official Anthropic host and path', () => {
  const known = { protocol: 'anthropic' as const, baseURL: 'https://api.anthropic.com', model: 'claude-haiku-4-5-20251001' };
  const expected = { capabilities: { contextWindow: { value: 200_000, source: 'fallback' }, maxInputTokens: { value: 200_000, source: 'fallback' }, maxOutputTokens: { value: 64_000, source: 'fallback' } } };
  for (const path of ['', '/v1', '/v1/messages', '/v1/']) assert.deepEqual(localNativeModelCapabilities({ ...known, baseURL: known.baseURL + path }), expected);
  for (const replacement of [{ model: 'claude-haiku-4-5-20251001-custom' }, { model: 'claude-haiku-4-5' }, { model: 'haiku' }, { model: 'CLAUDE-HAIKU-4-5-20251001' },
    { model: '__proto__' }, { baseURL: 'https://api.anthropic.com.gateway.test' }, { baseURL: 'https://gateway.test/anthropic' }, { baseURL: 'https://api.anthropic.com/proxy' },
    { baseURL: 'https://api.anthropic.com:8443' }, { baseURL: 'http://api.anthropic.com' }, { protocol: 'responses' as const }]) {
    assert.deepEqual(localNativeModelCapabilities({ ...known, ...replacement }), { capabilities: {} });
  }
});

test('local Kimi fallback is an explicit conservative account ceiling and never claims 1M access', () => {
  for (const host of ['api.kimi.com', 'api.kimi.ai']) for (const model of ['k3', 'k3-256k']) for (const protocol of ['anthropic', 'chat-completions'] as const) {
    assert.deepEqual(localNativeModelCapabilities({ protocol, baseURL: `https://${host}/coding/v1`, model }), {
      capabilities: { contextWindow: { value: 262_144, source: 'fallback' }, maxInputTokens: { value: 262_144, source: 'fallback' } }, conservative: true,
    });
  }
  for (const input of [{ protocol: 'anthropic' as const, baseURL: 'https://api.kimi.com/coding', model: 'k3[1m]' },
    { protocol: 'responses' as const, baseURL: 'https://api.kimi.com/coding/v1', model: 'k3' },
    { protocol: 'anthropic' as const, baseURL: 'https://api.kimi.com', model: 'k3' },
    { protocol: 'anthropic' as const, baseURL: 'https://proxy.test/coding', model: 'k3' }]) assert.deepEqual(localNativeModelCapabilities(input), { capabilities: {} });
});

test('detail metadata transport encodes one model path segment and retains GET-only authentication and validated projection', async () => {
  const original = globalThis.fetch, secret = 'sk-FICTIONAL-provider-metadata-only';
  const connection: ResolvedNativeConnection = { connectionId: 'fixture', revision: 1, protocol: 'anthropic', baseURL: 'https://fixture.invalid/proxy',
    model: 'org/model?preview#one', apiKey: secret, allowLoopbackHttp: false, redirect: 'error' };
  let calls = 0;
  globalThis.fetch = async (input, options) => {
    calls++; assert.equal(String(input), 'https://fixture.invalid/proxy/v1/models/org%2Fmodel%3Fpreview%23one');
    assert.equal(options?.method, 'GET'); assert.equal(options?.redirect, 'manual'); assert.equal(options?.body, undefined);
    const headers = new Headers(options?.headers); assert.equal(headers.get('x-api-key'), secret); assert.equal(headers.get('anthropic-version'), '2023-06-01');
    return new Response(JSON.stringify({ id: connection.model, max_input_tokens: 50_000, max_tokens: 4096, ignored_private: 'not-returned' }), { headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const result = await readNativeModelMetadata(connection, { signal: new AbortController().signal, timeoutMs: 1000, kind: 'detail' });
    assert.equal(result.code, 'ok'); assert.deepEqual(result.models, [{ id: connection.model, capabilities: {
      contextWindow: { value: 50_000, source: 'provider' }, maxInputTokens: { value: 50_000, source: 'provider' }, maxOutputTokens: { value: 4096, source: 'provider' },
    } }]); assert.equal(JSON.stringify(result).includes(secret), false); assert.equal(JSON.stringify(result).includes('not-returned'), false);
    assert.equal((await readNativeModelMetadata({ ...connection, model: '..' }, { signal: new AbortController().signal, kind: 'detail' })).code, 'configuration'); assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});

test('detail metadata rejects decoded, escaped, ignored and numeric credential echoes before returning limits', async () => {
  const original = globalThis.fetch;
  const base: ResolvedNativeConnection = { connectionId: 'fixture', revision: 1, protocol: 'responses', baseURL: 'https://fixture.invalid/v1', model: 'fixture',
    apiKey: 'sk-FICTIONAL-provider-echo', allowLoopbackHttp: false, redirect: 'error' };
  try {
    for (const [apiKey, body] of [[base.apiKey, { id: 'fixture', context_window: 128_000, ignored: base.apiKey }],
      ['50000', { id: 'fixture', max_input_tokens: 50_000 }], ['50000', { id: 'fixture', ignored: { numeric: 50_000 } }]] as const) {
      globalThis.fetch = async () => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
      const result = await readNativeModelMetadata({ ...base, apiKey }, { signal: new AbortController().signal, kind: 'detail' });
      assert.equal(result.code, 'credential_echo'); assert.equal(result.models, undefined); assert.equal(JSON.stringify(result).includes(apiKey), false);
    }
    globalThis.fetch = async () => new Response('{"id":"fixture","context_window":128000,"ignored":"' + base.apiKey.split('').map(character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0')).join('') + '"}', { headers: { 'Content-Type': 'application/json' } });
    assert.equal((await readNativeModelMetadata(base, { signal: new AbortController().signal, kind: 'detail' })).code, 'credential_echo');
  } finally { globalThis.fetch = original; }
});

test('catalog duplicate entries fill missing token fields and preserve the smallest declared per-field limits across pages', async () => {
  const original = globalThis.fetch;
  const connection: ResolvedNativeConnection = { connectionId: 'fixture', revision: 1, protocol: 'anthropic', baseURL: 'https://fixture.invalid', model: 'selected',
    apiKey: 'sk-FICTIONAL-catalog-limits', allowLoopbackHttp: false, redirect: 'error' };
  globalThis.fetch = async input => {
    const second = new URL(String(input)).searchParams.has('after_id');
    return new Response(JSON.stringify(second ? { data: [{ id: 'selected', display_name: 'Other display', max_input_tokens: 64_000, max_tokens: 4096 }], has_more: false, last_id: 'selected' }
      : { data: [{ id: 'selected', display_name: 'First display', max_tokens: 8192 }], has_more: true, last_id: 'selected' }), { headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const result = await readNativeModelMetadata(connection, { signal: new AbortController().signal, kind: 'list' });
    assert.equal(result.code, 'ok'); assert.deepEqual(result.models, [{ id: 'selected', name: 'First display', capabilities: {
      contextWindow: { value: 64_000, source: 'catalog' }, maxInputTokens: { value: 64_000, source: 'catalog' }, maxOutputTokens: { value: 4096, source: 'catalog' },
    } }]);
  } finally { globalThis.fetch = original; }
});
