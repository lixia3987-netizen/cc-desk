import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { ConnectionStore } from '../src/main/engines/native/connections';
import { NativeConnectionModelCatalog } from '../src/main/engines/native/connection-models';
import { NativeConnectionDiagnostics } from '../src/main/engines/native/connection-diagnostics';
import { registerNativeHandlers } from '../src/main/ipc/native-handlers';
import type { NativeConnectionModelListResult, NativeConnectionView } from '../src/shared/native-connections';
// @ts-expect-error Shared test-only ESM fixture has no declarations.
import { listenOnFetchLoopback } from '../../../packages/agent-node/tests/fixtures/fetch-loopback.mjs';

const secret = 'sk-FICTIONAL-model-list-secret-never-display';
function metadata(item: NativeConnectionView) { const { credentialConfigured: _configured, ready: _ready, error: _error, ...value } = item; return value; }
function json(response: ServerResponse, body: unknown, status = 200) { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)); }
function safe(result: NativeConnectionModelListResult): void {
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.equal(Object.hasOwn(result, 'body'), false);
  assert.ok(result.durationMs >= 0);
}
async function fixture(protocol: NativeConnectionView['protocol'] = 'responses', suffix = '/v1', timeoutMs = 2000) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-desk-model-list-'));
  const requests: { method?: string; url?: string; authorization?: string; apiKey?: string; version?: string; body: string }[] = [];
  let handler = (_request: IncomingMessage, response: ServerResponse) => json(response, { data: [{ id: 'one' }, { id: 'two', display_name: 'Second model' }], has_more: false, last_id: 'two', ignored: 'must-not-cross-ipc' });
  const server = createServer(async (request, response) => {
    const body: Buffer[] = []; for await (const chunk of request) body.push(Buffer.from(chunk));
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization, apiKey: request.headers['x-api-key'] as string | undefined, version: request.headers['anthropic-version'] as string | undefined, body: Buffer.concat(body).toString('utf8') });
    handler(request, response); server.emit('catalog-request');
  });
  await listenOnFetchLoopback(server);
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let active = false, catalog: NativeConnectionModelCatalog, diagnostics: NativeConnectionDiagnostics;
  const store = new ConnectionStore(directory, { isConnectionActive: () => active,
    isConnectionTesting: id => Boolean(catalog?.isConnectionListing(id) || diagnostics?.isConnectionTesting(id)),
  });
  const created = store.upsert({ name: 'Fixture models', protocol, baseURL: origin + suffix, model: 'current-model', allowLoopbackHttp: true, enabled: true, auth: { mode: 'memory' } });
  const connection = store.setCredential({ id: created.id, revision: created.revision, mode: 'memory', secret });
  catalog = new NativeConnectionModelCatalog(store, { timeoutMs }); diagnostics = new NativeConnectionDiagnostics(store, { timeoutMs });
  return { directory, origin, connection, store, catalog, diagnostics, requests, server,
    input: (item = connection) => ({ id: item.id, revision: item.revision, requestId: randomUUID() }),
    handler: (next: typeof handler) => { handler = next; }, active: (value: boolean) => { active = value; },
    dispose: async () => {
      await Promise.all([catalog.shutdown(), diagnostics.shutdown()]);
      const closed = new Promise<void>(resolve => server.close(() => resolve())); server.closeAllConnections(); await closed;
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

for (const protocol of ['responses', 'chat-completions'] as const) test(`model catalog ${protocol}: only explicit GET uses saved Bearer credential and revision, never generation`, async () => {
  const f = await fixture(protocol);
  try {
    const before = fs.readFileSync(path.join(f.directory, 'native/connections.json'), 'utf8');
    f.store.list(); f.store.readiness(f.connection.id); assert.equal(f.requests.length, 0);
    const input = f.input(), result = await f.catalog.list(input);
    assert.equal(result.code, 'ok'); assert.equal(result.connectionId, f.connection.id); assert.equal(result.revision, f.connection.revision); assert.equal(result.requestId, input.requestId);
    assert.deepEqual(result.models, [{ id: 'one' }, { id: 'two', name: 'Second model' }]); safe(result);
    assert.deepEqual(f.requests[0], { method: 'GET', url: '/v1/models', authorization: `Bearer ${secret}`, apiKey: undefined, version: undefined, body: '' });
    assert.equal(fs.readFileSync(path.join(f.directory, 'native/connections.json'), 'utf8'), before);
    assert.ok(!JSON.stringify(result).includes('must-not-cross-ipc'));
    assert.deepEqual(await f.catalog.list(input), result); assert.equal(f.requests.length, 1, 'same request capability cannot repeat network work');
    const switched = f.store.upsert({ ...metadata(f.connection), model: result.models![1].id });
    assert.equal(switched.model, 'two'); assert.equal(switched.revision, f.connection.revision + 1);
    assert.equal((await f.catalog.list({ ...input, revision: switched.revision })).code, 'configuration');
    assert.equal(f.requests.length, 1);
  } finally { await f.dispose(); }
});

for (const [suffix, expected] of [['', '/v1/models'], ['/gateway', '/gateway/v1/models'], ['/v1', '/v1/models'], ['/gateway/v1', '/gateway/v1/models'], ['/gateway/v1/messages', '/gateway/v1/models']] as const) test(`model catalog Anthropic endpoint ${suffix || 'root'} matches Messages base and API Key header`, async () => {
  const f = await fixture('anthropic', suffix);
  try {
    const result = await f.catalog.list(f.input()); assert.equal(result.code, 'ok'); safe(result);
    assert.equal(f.requests[0].url, expected + '?limit=100'); assert.equal(f.requests[0].method, 'GET');
    assert.equal(f.requests[0].apiKey, secret); assert.equal(f.requests[0].authorization, undefined); assert.equal(f.requests[0].version, '2023-06-01');
  } finally { await f.dispose(); }
});

test('model catalog Anthropic preserves Bearer auth and follows validated after_id pages with stable deduplication', async () => {
  const f = await fixture('anthropic');
  try {
    const connection = f.store.upsert({ ...metadata(f.connection), authHeader: 'authorization' });
    f.handler((request, response) => {
      const cursor = new URL(request.url!, f.origin).searchParams.get('after_id');
      json(response, cursor ? { data: [{ id: 'two', display_name: 'Duplicate' }, { id: 'three', display_name: 'Third' }], has_more: false, last_id: 'three' }
        : { data: [{ id: 'one' }, { id: 'two', display_name: 'Second' }], has_more: true, last_id: 'two' });
    });
    const result = await f.catalog.list(f.input(connection)); assert.equal(result.code, 'ok'); safe(result);
    assert.deepEqual(result.models, [{ id: 'one' }, { id: 'two', name: 'Second' }, { id: 'three', name: 'Third' }]);
    assert.deepEqual(f.requests.map(item => item.url), ['/v1/models?limit=100', '/v1/models?limit=100&after_id=two']);
    assert.ok(f.requests.every(item => item.authorization === `Bearer ${secret}` && item.apiKey === undefined && item.method === 'GET'));
  } finally { await f.dispose(); }
});

test('model catalog empty lists are successful and malformed model/pagination schemas return only fixed failure codes', async () => {
  const f = await fixture('anthropic');
  try {
    f.handler((_request, response) => json(response, { data: [], has_more: false, last_id: null }));
    assert.deepEqual((await f.catalog.list(f.input())).models, []);
    for (const invalid of [null, [], { data: 'bad' }, { data: [{ id: 123 }] }, { data: [{ id: 'one\nline' }] }, { data: [{ id: 'one', display_name: { private: true } }] },
      { data: [], has_more: true, last_id: 'one' }, { data: [{ id: 'one' }], has_more: 'yes', last_id: 'one' }, { data: [{ id: 'one' }], has_more: true, last_id: null }, { data: [{ id: 'one' }], last_id: { invalid: true } }]) {
      f.handler((_request, response) => json(response, invalid));
      const result = await f.catalog.list(f.input()); assert.equal(result.code, 'protocol'); assert.equal(result.models, undefined); safe(result);
    }
  } finally { await f.dispose(); }
});

test('model catalog Anthropic gateways accept data-only single-page catalogs while validating supplied pagination metadata', async () => {
  const f = await fixture('anthropic');
  try {
    for (const body of [{ data: [{ id: 'gateway-model' }] }, { data: [{ id: 'gateway-model' }], has_more: false }, { data: [{ id: 'gateway-model' }], has_more: false, last_id: null }]) {
      f.handler((_request, response) => json(response, body));
      const before = f.requests.length, result = await f.catalog.list(f.input()); assert.equal(result.code, 'ok'); assert.deepEqual(result.models, [{ id: 'gateway-model' }]);
      assert.equal(f.requests.length, before + 1); assert.equal(f.requests.at(-1)?.url, '/v1/models?limit=100'); safe(result);
    }
    f.handler((_request, response) => json(response, { data: [{ id: 'gateway-model' }], has_more: true }));
    assert.equal((await f.catalog.list(f.input())).code, 'protocol');
  } finally { await f.dispose(); }
});

test('model catalog rejects full/escaped/ignored/cross-field and cross-page credential echoes before returning model metadata', async () => {
  const f = await fixture('anthropic');
  try {
    const half = Math.floor(secret.length / 2), first = secret.slice(0, half), second = secret.slice(half);
    const thirds = [secret.slice(0, 12), secret.slice(12, 24), secret.slice(24)];
    for (const body of [{ data: [{ id: secret }], has_more: false, last_id: null }, { data: [{ id: 'one', display_name: secret }], has_more: false, last_id: null },
      { data: [{ id: 'one' }], has_more: false, last_id: null, ignored: { secret } }, { data: [{ id: first, display_name: second }], has_more: false, last_id: null },
      { data: [{ id: second, display_name: first }], has_more: false, last_id: null },
      { data: thirds.map(fragment => ({ id: fragment, display_name: fragment })), has_more: false, last_id: null }]) {
      f.handler((_request, response) => json(response, body)); const result = await f.catalog.list(f.input()); assert.equal(result.code, 'credential_echo'); assert.equal(result.models, undefined); safe(result);
    }
    f.handler((_request, response) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{"data":[{"id":"' + secret.split('').map(character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0')).join('') + '"}],"has_more":false,"last_id":null}'); });
    assert.equal((await f.catalog.list(f.input())).code, 'credential_echo');
    f.handler((request, response) => json(response, new URL(request.url!, f.origin).searchParams.has('after_id')
      ? { data: [{ id: second }], has_more: false, last_id: second } : { data: [{ id: first }], has_more: true, last_id: first }));
    const result = await f.catalog.list(f.input()); assert.equal(result.code, 'credential_echo'); assert.equal(result.models, undefined); safe(result);
  } finally { await f.dispose(); }
});

test('model catalog HTTP bodies and redirect locations never cross IPC or trigger a second request', async () => {
  const f = await fixture();
  try {
    for (const [status, code] of [[401, 'authentication'], [403, 'permission'], [404, 'endpoint'], [429, 'rate_limit'], [503, 'service'], [418, 'http'], [307, 'redirect']] as const) {
      f.handler((_request, response) => { response.writeHead(status, { 'Content-Type': 'application/json', Location: f.origin + '/credential-target/' + secret }); response.end(secret + 'private-provider-body'); });
      const before = f.requests.length, result = await f.catalog.list(f.input()); assert.equal(result.code, code); assert.equal(result.httpStatus, status);
      assert.equal(f.requests.length, before + 1); assert.equal(result.models, undefined); safe(result); assert.ok(!JSON.stringify(result).includes('private-provider-body'));
    }
  } finally { await f.dispose(); }
});

test('model catalog holds the saved connection lock across reads, cancellation and generation diagnostics', async () => {
  const f = await fixture();
  try {
    f.handler((_request, response) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.write('{"data":['); });
    const input = f.input(), pending = f.catalog.list(input); await once(f.server, 'catalog-request');
    assert.equal(f.catalog.isConnectionListing(f.connection.id), true);
    assert.equal((await f.catalog.list(f.input())).code, 'busy');
    assert.equal((await f.diagnostics.test(f.input())).code, 'configuration');
    assert.throws(() => f.store.upsert({ ...metadata(f.connection), model: 'other' }), /正在读取模型/);
    assert.throws(() => f.store.setCredential({ id: f.connection.id, revision: f.connection.revision, mode: 'memory', secret: 'replacement' }), /正在读取模型/);
    assert.throws(() => f.store.remove({ id: f.connection.id, revision: f.connection.revision }), /正在读取模型/);
    assert.throws(() => f.store.resolve(f.connection.id), /正在读取模型/);
    f.catalog.cancel({ requestId: randomUUID() }); assert.equal(f.catalog.isConnectionListing(f.connection.id), true);
    f.catalog.cancel({ requestId: input.requestId }); assert.equal(f.catalog.isConnectionListing(f.connection.id), true, 'abort does not release the lock before body cleanup');
    assert.equal((await pending).code, 'cancelled'); assert.equal(f.catalog.isConnectionListing(f.connection.id), false); assert.equal(f.store.readiness(f.connection.id).ready, true);
  } finally { await f.dispose(); }
});

test('model catalog declines stale/missing/disabled credentials and active connections before GET', async () => {
  const f = await fixture();
  try {
    f.active(true); assert.equal((await f.catalog.list(f.input())).code, 'configuration'); f.active(false);
    assert.equal((await f.catalog.list({ ...f.input(), revision: f.connection.revision - 1 })).code, 'configuration');
    assert.equal((await f.catalog.list({ ...f.input(), id: 'missing-connection' })).code, 'configuration');
    const missing = f.store.upsert({ ...metadata(f.connection), id: undefined, revision: undefined, auth: { mode: 'memory' } });
    assert.equal((await f.catalog.list(f.input(missing))).code, 'configuration');
    const disabled = f.store.upsert({ ...metadata(f.connection), enabled: false });
    assert.equal((await f.catalog.list(f.input(disabled))).code, 'configuration'); assert.equal(f.requests.length, 0);
  } finally { await f.dispose(); }
});

test('model catalog navigation/crash cancellation and shutdown keep cleanup locks, then a failed quit can resume', async () => {
  const f = await fixture();
  try {
    f.handler((_request, response) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.write('{'); });
    let pending = f.catalog.list(f.input()); await once(f.server, 'catalog-request'); f.catalog.cancelAll(); assert.equal((await pending).code, 'cancelled');
    pending = f.catalog.list(f.input()); await once(f.server, 'catalog-request'); await f.catalog.shutdown(); assert.equal((await pending).code, 'cancelled');
    const before = f.requests.length; assert.equal((await f.catalog.list(f.input())).code, 'cancelled'); assert.equal(f.requests.length, before);
    f.catalog.resumeAfterFailedShutdown(); f.handler((_request, response) => json(response, { data: [{ id: 'after-resume' }] }));
    assert.equal((await f.catalog.list(f.input())).code, 'ok'); assert.equal(f.store.readiness(f.connection.id).ready, true);
  } finally { await f.dispose(); }
});

test('model catalog times out a stalled response without returning partial models', async () => {
  const f = await fixture('responses', '/v1', 35);
  try {
    f.handler((_request, response) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.write('{"data":[{"id":"partial"}'); });
    const result = await f.catalog.list(f.input()); assert.equal(result.code, 'timeout'); assert.equal(result.models, undefined); safe(result);
    assert.equal(f.catalog.isConnectionListing(f.connection.id), false); assert.equal(f.requests.length, 1);
  } finally { await f.dispose(); }
});

test('model catalog enforces response byte, page, model and cursor-loop bounds without partial success', async () => {
  const f = await fixture('anthropic');
  try {
    f.handler((_request, response) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ data: [], ignored: 'x'.repeat(1024 * 1024) })); });
    assert.equal((await f.catalog.list(f.input())).code, 'response_limit');
    f.handler((_request, response) => json(response, { data: Array.from({ length: 1001 }, (_, index) => ({ id: 'model-' + index })), has_more: false, last_id: null }));
    assert.equal((await f.catalog.list(f.input())).code, 'response_limit');
    f.handler((_request, response) => json(response, { data: [{ id: 'repeat' }], has_more: true, last_id: 'repeat' }));
    const beforeLoop = f.requests.length; assert.equal((await f.catalog.list(f.input())).code, 'protocol'); assert.equal(f.requests.length, beforeLoop + 2);
    let page = 0;
    f.handler((_request, response) => { page++; json(response, { data: [{ id: 'page-' + page }], has_more: true, last_id: 'page-' + page }); });
    const beforePages = f.requests.length, result = await f.catalog.list(f.input()); assert.equal(result.code, 'response_limit'); assert.equal(result.models, undefined); assert.equal(f.requests.length, beforePages + 10); safe(result);
  } finally { await f.dispose(); }
});

test('model catalog malformed JSON/content type/UTF-8 and broken transport stay sanitized', async () => {
  const f = await fixture();
  try {
    for (const malformed of ['{private-' + secret, '<html>' + secret]) {
      f.handler((_request, response) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(malformed); });
      const result = await f.catalog.list(f.input()); assert.equal(result.code, 'protocol'); safe(result);
    }
    f.handler((_request, response) => { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end(secret); });
    assert.equal((await f.catalog.list(f.input())).code, 'protocol');
    f.handler((_request, response) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(Buffer.from([0xff, 0xfe])); });
    assert.equal((await f.catalog.list(f.input())).code, 'protocol');
    f.handler(request => request.socket.destroy()); const result = await f.catalog.list(f.input()); assert.equal(result.code, 'transport'); safe(result);
  } finally { await f.dispose(); }
});

test('model catalog IPC accepts only saved id/revision/request references and never renderer endpoints or keys', async () => {
  const f = await fixture(), handlers = new Map<string, (input: unknown) => unknown>();
  try {
    registerNativeHandlers((name, schema, action) => handlers.set(name, input => action(schema.parse(input))), f.store, () => {}, f.diagnostics, f.catalog);
    for (const input of [{ ...f.input(), baseURL: f.origin + '/' + secret }, { ...f.input(), apiKey: secret }, { ...f.input(), [secret]: 'extra' }, { ...f.input(), revision: 0 }]) {
      assert.throws(() => handlers.get('native:connections-models')!(input), error => error instanceof Error && !error.message.includes(secret));
    }
    for (const input of [{ id: f.connection.id, revision: f.connection.revision, baseURL: f.origin + '/' + secret },
      { id: f.connection.id, revision: f.connection.revision, apiKey: secret }, { id: f.connection.id, revision: f.connection.revision, [secret]: 'extra' },
      { id: f.connection.id, revision: 0 }, { id: f.connection.id, revision: f.connection.revision, model: { secret } }]) {
      assert.throws(() => handlers.get('native:connections-model-capabilities')!(input), error => error instanceof Error && !error.message.includes(secret));
    }
    assert.equal(f.requests.length, 0);
    const result = await handlers.get('native:connections-models')!(f.input()) as NativeConnectionModelListResult; assert.equal(result.code, 'ok'); safe(result);
    assert.throws(() => handlers.get('native:connections-models-cancel')!({ requestId: secret }), error => error instanceof Error && !error.message.includes(secret));
  } finally { await f.dispose(); }
});
