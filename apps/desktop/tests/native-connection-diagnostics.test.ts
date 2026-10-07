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
import { NativeConnectionDiagnostics, nativeConnectionProbe } from '../src/main/engines/native/connection-diagnostics';
import { registerNativeHandlers } from '../src/main/ipc/native-handlers';
import type { NativeConnectionView } from '../src/shared/native-connections';
// @ts-expect-error Shared test-only ESM fixture has no declarations.
import { listenOnFetchLoopback } from '../../../packages/agent-node/tests/fixtures/fetch-loopback.mjs';

const sentinel = 'sk-diagnostic-SECRET-DO-NOT-RETURN';
const responseText = 'provider-response-DO-NOT-RETURN';
function complete(output: unknown[] = [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: responseText }] }]) {
  return `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_diagnostic', status: 'completed', output, usage: { input_tokens: 12, output_tokens: 1, total_tokens: 13 } } })}\n\n`;
}
function metadata(item: NativeConnectionView) {
  const { credentialConfigured: _credential, ready: _ready, error: _error, ...value } = item;
  return value;
}
async function fixture(timeoutMs = 2000) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-desk-connection-diagnostic-'));
  const requests: { body: Record<string, unknown>; authorization: string | undefined; url: string | undefined }[] = [];
  let active = false;
  let handler = (_request: IncomingMessage, response: ServerResponse) => { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.end(complete()); };
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({ body: JSON.parse(Buffer.concat(chunks).toString('utf8')), authorization: request.headers.authorization, url: request.url });
    handler(request, response);
    server.emit('probe-received');
  });
  await listenOnFetchLoopback(server);
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  let diagnostics: NativeConnectionDiagnostics;
  const store = new ConnectionStore(directory, { isConnectionActive: () => active, isConnectionTesting: id => diagnostics?.isConnectionTesting(id) ?? false });
  const created = store.upsert({ name: '本机诊断测试', protocol: 'responses', baseURL, model: 'fixture-model', allowLoopbackHttp: true, enabled: true, auth: { mode: 'memory' } });
  const connection = store.setCredential({ id: created.id, revision: created.revision, mode: 'memory', secret: sentinel });
  diagnostics = new NativeConnectionDiagnostics(store, { timeoutMs });
  return {
    store, diagnostics, connection, requests, baseURL, directory, server,
    input: () => ({ id: connection.id, revision: connection.revision, requestId: randomUUID() }),
    handler: (next: typeof handler) => { handler = next; },
    active: (value: boolean) => { active = value; },
    dispose: async () => {
      await diagnostics.shutdown();
      const closed = new Promise<void>(resolve => server.close(() => resolve()));
      server.closeAllConnections(); await closed;
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('connection diagnostics: local readiness never requests a model; explicit test validates actual SSE and returns only safe usage', async () => {
  const f = await fixture();
  try {
    f.store.list(); f.store.readiness(f.connection.id);
    assert.equal(f.requests.length, 0);
    const input = f.input(), result = await f.diagnostics.test(input);
    assert.equal(result.code, 'ok');
    assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 1, totalTokens: 13 });
    assert.ok(result.durationMs >= 0);
    assert.equal(f.requests.length, 1);
    const request = f.requests[0];
    assert.equal(request.url, '/v1/responses');
    assert.equal(request.authorization, `Bearer ${sentinel}`);
    assert.deepEqual(request.body.input, [{ role: 'user', content: nativeConnectionProbe.prompt }]);
    assert.deepEqual(request.body.tools, []);
    assert.equal(request.body.store, false); assert.equal(request.body.stream, true);
    assert.equal(request.body.max_output_tokens, 256);
    for (const secret of [sentinel, responseText, f.baseURL]) assert.ok(!JSON.stringify(result).includes(secret));
    const disk = fs.readFileSync(path.join(f.directory, 'native/connections.json'), 'utf8');
    assert.ok(!disk.includes(sentinel)); assert.ok(!disk.includes(responseText));
    assert.deepEqual(await f.diagnostics.test(input), result);
    assert.equal(f.requests.length, 1, 'duplicate request ID must not spend twice');
    assert.equal(f.store.readiness(f.connection.id).ready, true);
  } finally { await f.dispose(); }
});

test('connection diagnostics: selected Chat Completions protocol and model price use real returned usage', async () => {
  const f = await fixture();
  try {
    const connection = f.store.upsert({ ...metadata(f.connection), protocol: 'chat-completions', pricing: { model: 'fixture-model', inputUSDPerMillion: 2, outputUSDPerMillion: 8 } });
    const chunk = (choices: unknown[], usage: unknown = null) => `data: ${JSON.stringify({ id: 'chat_probe', object: 'chat.completion.chunk', choices, usage })}\n\n`;
    f.handler((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end(chunk([{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: null }]) + chunk([{ index: 0, delta: {}, finish_reason: 'stop' }]) + chunk([], { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 }) + 'data: [DONE]\n\n');
    });
    const result = await f.diagnostics.test({ id: connection.id, revision: connection.revision, requestId: randomUUID() });
    assert.equal(result.code, 'ok');
    assert.equal(result.estimatedCostUSD, 0.000032);
    assert.equal(f.requests[0].url, '/v1/chat/completions');
    assert.deepEqual(f.requests[0].body.messages, [{ role: 'user', content: nativeConnectionProbe.prompt }]);
    assert.equal(f.requests[0].body.max_completion_tokens, 256);
    f.handler((_request, response) => { response.writeHead(401); response.end(sentinel); });
    const failure = await f.diagnostics.test({ id: connection.id, revision: connection.revision, requestId: randomUUID() });
    assert.equal(failure.code, 'authentication');
    assert.ok(!JSON.stringify(failure).includes(sentinel));
  } finally { await f.dispose(); }
});

test('connection diagnostics: imported Anthropic token uses Messages without exposing provider text or errors', async () => {
  const f = await fixture();
  try {
    const connection = f.store.upsert({ ...metadata(f.connection), protocol: 'anthropic', authHeader: 'authorization' });
    const sse = (type: string, fields: object = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
    f.handler((request, response) => {
      assert.equal(request.headers['anthropic-version'], '2023-06-01');
      assert.equal(request.headers['x-api-key'], undefined);
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end(sse('message_start', { message: { id: 'msg_probe', type: 'message', role: 'assistant', model: 'fixture-model', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 0 } } })
        + sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
        + sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: responseText } })
        + sse('content_block_stop', { index: 0 })
        + sse('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } })
        + sse('message_stop'));
    });
    const result = await f.diagnostics.test({ id: connection.id, revision: connection.revision, requestId: randomUUID() });
    assert.equal(result.code, 'ok');
    assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 1, totalTokens: 13 });
    assert.equal(f.requests[0].url, '/v1/messages');
    assert.equal(f.requests[0].authorization, `Bearer ${sentinel}`);
    assert.equal(f.requests[0].body.max_tokens, 256);
    assert.equal(f.requests[0].body.stream, true);
    assert.ok(!JSON.stringify(result).includes(responseText));
    f.handler((_request, response) => { response.writeHead(401); response.end(sentinel + responseText); });
    const failed = await f.diagnostics.test({ id: connection.id, revision: connection.revision, requestId: randomUUID() });
    assert.equal(failed.code, 'authentication'); assert.equal(failed.httpStatus, 401);
    assert.ok(!JSON.stringify(failed).includes(sentinel));
  } finally { await f.dispose(); }
});

test('connection diagnostics: HTTP and redirect errors are fixed classifications without bodies or locations', async () => {
  const f = await fixture();
  try {
    for (const [status, code] of [[401, 'authentication'], [403, 'permission'], [404, 'endpoint'], [429, 'rate_limit'], [503, 'service'], [418, 'http'], [307, 'redirect']] as const) {
      f.handler((_request, response) => { response.writeHead(status, { Location: 'https://unused.example.test/' + sentinel }); response.end(sentinel + responseText); });
      const before = f.requests.length, result = await f.diagnostics.test(f.input());
      assert.equal(result.code, code);
      if (status !== 307) assert.equal(result.httpStatus, status);
      assert.equal(f.requests.length, before + 1, 'test must not retry or follow a redirect');
      assert.ok(!JSON.stringify(result).includes(sentinel)); assert.ok(!JSON.stringify(result).includes(responseText));
    }
  } finally { await f.dispose(); }
});

test('connection diagnostics: malformed, incomplete, empty, refused, credential-bearing and tool responses cannot report success', async () => {
  const f = await fixture();
  try {
    const cases: { type?: string; body: string; code: string }[] = [
      { type: 'application/json', body: complete(), code: 'protocol' },
      { body: 'data: {broken}\n\n', code: 'protocol' },
      { body: 'data: {"type":"response.output_text.delta","delta":"OK"}\n\n', code: 'incomplete' },
      { body: complete([]), code: 'protocol' },
      { body: complete([{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'No' }] }]), code: 'refused' },
      { body: complete([{ type: 'function_call', call_id: 'call_probe', name: 'run_command', arguments: '{}' }]), code: 'unexpected_tool' },
      { body: complete([{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: sentinel }] }]), code: 'credential_echo' },
      { body: complete([{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'x'.repeat(300 * 1024) }] }]), code: 'response_limit' },
    ];
    for (const entry of cases) {
      f.handler((_request, response) => { response.writeHead(200, { 'Content-Type': entry.type ?? 'text/event-stream' }); response.end(entry.body); });
      const result = await f.diagnostics.test(f.input());
      assert.equal(result.code, entry.code);
      assert.ok(!JSON.stringify(result).includes(sentinel)); assert.ok(!JSON.stringify(result).includes(responseText));
    }
  } finally { await f.dispose(); }
});

test('connection diagnostics: pending test locks edits, credentials, deletion and runs until cancellation settles', async () => {
  const f = await fixture();
  try {
    let disconnected!: Promise<void>;
    f.handler((_request, response) => { disconnected = once(response, 'close').then(() => {}); response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write(': pending\n\n'); });
    const received = once(f.server, 'probe-received'), input = f.input();
    const pending = f.diagnostics.test(input);
    assert.equal(f.diagnostics.isConnectionTesting(f.connection.id), true);
    assert.equal(f.store.readiness(f.connection.id).ready, false);
    assert.throws(() => f.store.resolve(f.connection.id), /正在读取模型或测试/);
    assert.throws(() => f.store.upsert(metadata(f.connection)), /正在读取模型或测试/);
    assert.throws(() => f.store.remove({ id: f.connection.id, revision: f.connection.revision }), /正在读取模型或测试/);
    assert.throws(() => f.store.setCredential({ id: f.connection.id, revision: f.connection.revision, mode: 'memory', secret: sentinel }), /正在读取模型或测试/);
    assert.equal((await f.diagnostics.test(f.input())).code, 'busy');
    assert.equal(f.diagnostics.test(input), pending);
    await received;
    f.diagnostics.cancel({ requestId: randomUUID() });
    assert.equal(f.diagnostics.isConnectionTesting(f.connection.id), true);
    f.diagnostics.cancel({ requestId: input.requestId });
    assert.equal(f.diagnostics.isConnectionTesting(f.connection.id), true, 'abort does not release the lock before cleanup');
    assert.equal((await pending).code, 'cancelled');
    await disconnected;
    assert.equal(f.requests.length, 1);
    assert.equal(f.diagnostics.isConnectionTesting(f.connection.id), false);
    assert.equal(f.store.readiness(f.connection.id).ready, true);
    assert.ok(f.store.upsert(metadata(f.connection)).revision > f.connection.revision);
  } finally { await f.dispose(); }
});

test('connection diagnostics: real HTTP timeout terminates a stalled request without retry', async () => {
  const f = await fixture(100);
  try {
    f.handler((_request, response) => { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write(': pending\n\n'); });
    assert.equal((await f.diagnostics.test(f.input())).code, 'timeout');
    assert.equal(f.requests.length, 1);
    assert.equal(f.diagnostics.isConnectionTesting(f.connection.id), false);
  } finally { await f.dispose(); }
});

test('connection diagnostics: active runs, stale revisions, disabled and deleted connections make no request', async () => {
  const f = await fixture();
  try {
    f.active(true);
    assert.equal((await f.diagnostics.test(f.input())).code, 'configuration');
    f.active(false);
    assert.equal((await f.diagnostics.test({ ...f.input(), revision: f.connection.revision + 1 })).code, 'configuration');
    const disabled = f.store.upsert({ ...metadata(f.connection), enabled: false });
    assert.equal((await f.diagnostics.test({ ...f.input(), revision: disabled.revision })).code, 'configuration');
    f.store.remove({ id: disabled.id, revision: disabled.revision });
    assert.equal((await f.diagnostics.test({ ...f.input(), revision: disabled.revision })).code, 'configuration');
    assert.equal(f.requests.length, 0);
  } finally { await f.dispose(); }
});

test('connection diagnostics: renderer disposal cancels; application shutdown prevents new requests and can recover from failed quit', async () => {
  const f = await fixture();
  try {
    f.handler((_request, response) => { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write(': pending\n\n'); });
    let received = once(f.server, 'probe-received'), pending = f.diagnostics.test(f.input());
    await received; f.diagnostics.cancelAll();
    assert.equal((await pending).code, 'cancelled');
    received = once(f.server, 'probe-received'); pending = f.diagnostics.test(f.input());
    await received; const shutdown = f.diagnostics.shutdown();
    assert.equal((await f.diagnostics.test(f.input())).code, 'cancelled');
    await shutdown; assert.equal((await pending).code, 'cancelled');
    assert.equal(f.requests.length, 2);
    f.diagnostics.resumeAfterFailedShutdown();
    f.handler((_request, response) => { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.end(complete()); });
    assert.equal((await f.diagnostics.test(f.input())).code, 'ok');
    assert.equal(f.requests.length, 3);
  } finally { await f.dispose(); }
});

test('connection diagnostics IPC: private validation rejects extra fields without echo or network activity', async () => {
  const f = await fixture();
  const handlers = new Map<string, (input?: unknown) => unknown>();
  try {
    registerNativeHandlers((name, schema, action) => { handlers.set(name, input => action(schema.parse(input))); }, f.store, undefined, f.diagnostics);
    for (const name of ['native:connections-test', 'native:connections-test-cancel']) {
      assert.throws(() => handlers.get(name)!({ ...f.input(), [sentinel]: 'extra' }), error => error instanceof Error && !error.message.includes(sentinel));
    }
    assert.equal(f.requests.length, 0);
    const result = await handlers.get('native:connections-test')!(f.input());
    assert.ok(!JSON.stringify(result).includes(sentinel));
  } finally { await f.dispose(); }
});
