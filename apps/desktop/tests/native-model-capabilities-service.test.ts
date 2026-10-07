import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ConnectionStore } from '../src/main/engines/native/connections';
import { NativeConnectionModelCatalog } from '../src/main/engines/native/connection-models';
import { NativeModelCapabilityService, mergeNativeModelCapabilities } from '../src/main/engines/native/model-capabilities';
// @ts-expect-error Shared test-only ESM fixture has no declarations.
import { listenOnFetchLoopback } from '../../../packages/agent-node/tests/fixtures/fetch-loopback.mjs';

const secret = 'model-capability-service-artificial-main-key';
const model = 'fixture-capability-model';
type Mode = 'partial' | 'partial-timeout' | 'missing' | 'unknown' | 'timeout' | 'held' | 'wrong-id';
async function fixture(timeoutMs = 150) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ccdesk-model-capability-service-'));
  let mode: Mode = 'partial', clock = Date.now(), cancelled = 0;
  const requests: Array<{ method?: string; url?: string; authorization?: string; apiKey?: string | string[] }> = [];
  const held: ServerResponse[] = [];
  const detail = () => ({ id: mode === 'wrong-id' ? 'another-model' : model, context_window: 48000, max_output_tokens: 2048 });
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization, apiKey: request.headers['x-api-key'] });
    const url = new URL(request.url ?? '', 'http://localhost');
    if (request.method !== 'GET' || !url.pathname.startsWith('/v1/models')) { response.writeHead(500); response.end('generation must never be requested'); return; }
    if (mode === 'missing') { response.writeHead(404); response.end(secret + 'private provider error body'); return; }
    if (mode === 'timeout' || mode === 'held' || mode === 'partial-timeout' && url.pathname === '/v1/models') {
      response.on('close', () => { cancelled++; });
      if (mode !== 'held') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.flushHeaders(); }
      else held.push(response);
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    if (url.pathname === '/v1/models/' + model) response.end(JSON.stringify(mode === 'unknown' ? { id: model, context_window: null, max_input_tokens: 0 } : detail()));
    else if (url.pathname === '/v1/models') response.end(JSON.stringify({ data: [mode === 'unknown' ? { id: model } : {
      id: model, context_window: 128000, max_input_tokens: 64000, max_output_tokens: 8192,
    }], has_more: false, last_id: model }));
    else { response.end(JSON.stringify({ id: decodeURIComponent(url.pathname.slice('/v1/models/'.length)), context_window: 32000, max_input_tokens: 30000, max_output_tokens: 1024 })); }
  });
  await listenOnFetchLoopback(server);
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const connections = new ConnectionStore(directory, { environment: { MODEL_CAPABILITY_FIXTURE_KEY: secret } });
  const connection = connections.upsert({ name: 'capability fixture', protocol: 'anthropic', authHeader: 'authorization', baseURL, model,
    enabled: true, allowLoopbackHttp: true, auth: { mode: 'env', variable: 'MODEL_CAPABILITY_FIXTURE_KEY' } });
  const catalog = new NativeConnectionModelCatalog(connections, { timeoutMs });
  const service = new NativeModelCapabilityService(connections, catalog, { timeoutMs, now: () => clock });
  return { directory, connection, connections, service, catalog, requests, held, cancelled: () => cancelled,
    setMode: (next: Mode) => { mode = next; }, advance: (duration: number) => { clock += duration; },
    resolve: () => service.resolve(connections.resolve(connection.id)),
    release: () => { for (const response of held.splice(0)) { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(detail())); } },
    async dispose() { await service.shutdown(); await catalog.shutdown(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await fs.rm(directory, { recursive: true, force: true }); },
  };
}

function assertMetadataOnly(f: Awaited<ReturnType<typeof fixture>>) {
  for (const request of f.requests) {
    const url = new URL(request.url!, 'http://localhost');
    assert.equal(request.method, 'GET'); assert.ok(url.pathname === '/v1/models' || url.pathname.startsWith('/v1/models/'));
    assert.equal(request.authorization, `Bearer ${secret}`); assert.equal(request.apiKey, undefined);
    assert.ok([...url.searchParams.entries()].every(([key, value]) => key === 'limit' && value === '100'));
  }
  assert.equal(f.catalog.isConnectionListing(f.connection.id), false, 'automatic metadata never holds the manual list lock');
}
async function waitFor(condition: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!condition()) { assert.ok(Date.now() < deadline, 'local fixture did not receive the request'); await new Promise(resolve => setTimeout(resolve, 5)); }
}

test('partial provider metadata wins per field, catalog fills missing input, immutable snapshots deduplicate and expire', async () => {
  const f = await fixture();
  try {
    const before = await fs.readFile(path.join(f.directory, 'native', 'connections.json'), 'utf8');
    const first = f.resolve(), duplicate = f.resolve(); assert.equal(first, duplicate);
    const result = await first;
    assert.equal(result.code, 'ok'); assert.equal(result.model, model);
    assert.deepEqual(result.capabilities, { contextWindow: { value: 48000, source: 'provider' },
      maxInputTokens: { value: 64000, source: 'catalog' }, maxOutputTokens: { value: 2048, source: 'provider' } });
    assert.equal(f.requests.length, 2); assert.equal(Object.isFrozen(result.capabilities.contextWindow), true);
    assert.equal(await f.resolve(), result); assert.equal(f.requests.length, 2);
    f.advance(300001); const refreshed = await f.resolve(); assert.notEqual(refreshed.resolvedAt, result.resolvedAt);
    assert.equal(f.requests.length, 3, 'a fresh detail read may reuse the safe catalog cache');
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.equal(await fs.readFile(path.join(f.directory, 'native', 'connections.json'), 'utf8'), before);
    assertMetadataOnly(f);
    assert.deepEqual(mergeNativeModelCapabilities({ contextWindow: { value: 48000, source: 'provider' } },
      { maxOutputTokens: { value: 2048, source: 'catalog' } }, { contextWindow: { value: 200000, source: 'fallback' }, maxInputTokens: { value: 180000, source: 'fallback' }, maxOutputTokens: { value: 8192, source: 'fallback' } }),
    { contextWindow: { value: 48000, source: 'provider' }, maxInputTokens: { value: 180000, source: 'fallback' }, maxOutputTokens: { value: 2048, source: 'catalog' } });
  } finally { await f.dispose(); }
});

test('404 and unknown metadata stay unknown with bounded GET reads and short failure caching', async () => {
  const f = await fixture();
  try {
    f.setMode('missing'); const missing = await f.resolve();
    assert.equal(missing.code, 'endpoint'); assert.deepEqual(missing.capabilities, {}); assert.equal(f.requests.length, 2);
    assert.equal(await f.resolve(), missing); assert.equal(f.requests.length, 2);
    assert.equal(JSON.stringify(missing).includes(secret), false); assert.equal(JSON.stringify(missing).includes('private provider'), false);
    f.advance(30001); f.setMode('unknown'); const unknown = await f.resolve();
    assert.equal(unknown.code, 'ok'); assert.deepEqual(unknown.capabilities, {}); assert.equal(f.requests.length, 4);
    assertMetadataOnly(f);
  } finally { await f.dispose(); }
});

test('metadata timeout cancels one GET without generation, retries or a longer fallback request', async () => {
  const f = await fixture(40);
  try {
    f.setMode('timeout'); const started = performance.now(), result = await f.resolve();
    assert.equal(result.code, 'timeout'); assert.deepEqual(result.capabilities, {});
    assert.equal(f.requests.length, 1); assert.ok(performance.now() - started < 1500);
    await waitFor(() => f.cancelled() === 1);
    assert.equal(await f.resolve(), result); assert.equal(f.requests.length, 1); assertMetadataOnly(f);
  } finally { await f.dispose(); }
});

test('a catalog timeout retains already verified provider limits and leaves missing fields unknown', async () => {
  const f = await fixture(60);
  try {
    f.setMode('partial-timeout'); const result = await f.resolve();
    assert.equal(result.code, 'timeout'); assert.equal(f.requests.length, 2);
    assert.deepEqual(result.capabilities, { contextWindow: { value: 48000, source: 'provider' }, maxOutputTokens: { value: 2048, source: 'provider' } });
    await waitFor(() => f.cancelled() === 1); assertMetadataOnly(f);
  } finally { await f.dispose(); }
});

test('revision changes invalidate in-flight metadata, and a detail for another model cannot set the selected window', async () => {
  const f = await fixture(1000);
  try {
    f.setMode('held'); const pending = f.resolve(); await waitFor(() => f.held.length === 1);
    const { credentialConfigured: _configured, ready: _ready, error: _error, ...metadata } = f.connection;
    const changed = f.connections.upsert({ ...metadata, name: 'changed while metadata was reading' }); f.setMode('partial'); f.release();
    const stale = await pending; assert.equal(stale.code, 'configuration'); assert.deepEqual(stale.capabilities, {});
    assert.equal(f.service.peek({ connectionId: changed.id, revision: f.connection.revision, model }), undefined);
    f.setMode('wrong-id'); const current = await f.service.resolveReference({ id: changed.id, revision: changed.revision });
    assert.equal(current.code, 'ok'); assert.deepEqual(current.capabilities, { contextWindow: { value: 128000, source: 'catalog' },
      maxInputTokens: { value: 64000, source: 'catalog' }, maxOutputTokens: { value: 8192, source: 'catalog' } });
    assertMetadataOnly(f);
  } finally { await f.dispose(); }
});
