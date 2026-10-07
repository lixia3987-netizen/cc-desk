import { test } from 'node:test';
import assert from 'node:assert/strict';
import { McpHttpClient, McpClientError } from '../dist/mcp-client.js';

const version = '2025-11-25';
const tool = { name: 'lookup', inputSchema: { type: 'object' } };
const deferred = () => { let resolve; return { promise: new Promise(done => { resolve = done; }), resolve: () => resolve() }; };
const rejected = (promise, code, outcome) => assert.rejects(promise, error =>
  error instanceof McpClientError && error.code === code && error.outcome === outcome);

/** The response intentionally never observes fetch's signal, as in the raced native stream. */
function transport(t, action, timeoutMs = 1000) {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (_endpoint, options) => {
    const body = options.body ? JSON.parse(options.body) : undefined;
    const method = body?.method ?? options.method;
    requests.push(method);
    if (method === 'initialize') return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {
      protocolVersion: version, capabilities: { tools: {} }, serverInfo: { name: 'abort fixture', version: '1' },
    } }), { headers: { 'content-type': 'application/json', 'Mcp-Session-Id': 'abort-fixture-session' } });
    const response = await action({ method, body, signal: options.signal });
    return response ?? new Response(null, { status: method === 'DELETE' ? 204 : 202 });
  });
  const client = new McpHttpClient({ endpoint: 'http://127.0.0.1:9999/mcp', allowLoopbackHttp: true, protocolVersion: version, timeoutMs });
  return { client, requests };
}

function openResponse(status = 200, cancel = () => {}) {
  const started = deferred();
  let cancellations = 0;
  const stream = new ReadableStream({
    pull() { started.resolve(); },
    async cancel() { cancellations++; await cancel(); },
  }, { highWaterMark: 0 });
  const response = new Response(stream, { status, headers: { 'content-type': 'text/event-stream' } });
  return { response, started: started.promise, cancellations: () => cancellations };
}

test('discovery timeout cancels its reader even when fetch does not propagate abort to the body', { timeout: 5000 }, async t => {
  const stream = openResponse();
  const { client, requests } = transport(t, ({ method }) => method === 'tools/list' ? stream.response : undefined, 20);
  try {
    await rejected(client.discoverTools(new AbortController().signal), 'timeout', 'not_executed');
    assert.equal(stream.cancellations(), 1);
    assert.equal(stream.response.body.locked, false);
    assert.deepEqual(requests, ['initialize', 'notifications/initialized', 'tools/list', 'notifications/cancelled']);
  } finally { await client.close(); }
  assert.equal(requests.at(-1), 'DELETE');
});

test('an abort before the returned response acquires its reader remains an unknown tool result', { timeout: 5000 }, async t => {
  const controller = new AbortController(), stream = openResponse();
  const { client, requests } = transport(t, ({ method }) => {
    if (method === 'tools/call') { controller.abort(); return stream.response; }
  });
  try {
    await rejected(client.callTool(tool, {}, controller.signal), 'cancelled', 'unknown');
    assert.equal(stream.cancellations(), 1);
    assert.equal(stream.response.body.locked, false);
    assert.equal(requests.filter(method => method === 'notifications/cancelled').length, 1);
  } finally { await client.close(); }
});

test('close joins the original upstream body cancellation before completing or deleting the session', { timeout: 5000 }, async t => {
  const cleanupStarted = deferred(), finishCleanup = deferred();
  const stream = openResponse(200, async () => { cleanupStarted.resolve(); await finishCleanup.promise; });
  const { client, requests } = transport(t, ({ method }) => method === 'tools/call' ? stream.response : undefined);
  let settled = false, closed = false;
  const call = rejected(client.callTool(tool, {}, new AbortController().signal), 'closed', 'unknown').then(() => { settled = true; });
  try {
    await stream.started;
    const close = client.close().then(() => { closed = true; });
    await cleanupStarted.promise;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    assert.equal(closed, false);
    assert.equal(requests.includes('DELETE'), false);
    assert.equal(stream.cancellations(), 1);
    finishCleanup.resolve();
    await Promise.all([call, close]);
    assert.equal(stream.response.body.locked, false);
    assert.deepEqual(requests.slice(-2), ['notifications/cancelled', 'DELETE']);
  } finally { finishCleanup.resolve(); await client.close(); await call; }
});

test('closing a pending initialized acknowledgement cancels and joins its reader without starting tools', { timeout: 5000 }, async t => {
  const stream = openResponse(202);
  const { client, requests } = transport(t, ({ method }) => method === 'notifications/initialized' ? stream.response : undefined);
  const discovery = rejected(client.discoverTools(new AbortController().signal), 'closed', 'not_executed');
  try {
    await stream.started;
    await client.close();
    await discovery;
    assert.equal(stream.cancellations(), 1);
    assert.equal(stream.response.body.locked, false);
    assert.deepEqual(requests, ['initialize', 'notifications/initialized', 'DELETE']);
  } finally { await client.close(); await discovery; }
});

test('the cancellation acknowledgement cleanup deadline also cancels a body that ignores fetch abort', { timeout: 5000 }, async t => {
  const controller = new AbortController(), callStream = openResponse(), acknowledgement = openResponse(202);
  const { client, requests } = transport(t, ({ method }) => method === 'tools/call' ? callStream.response
    : method === 'notifications/cancelled' ? acknowledgement.response : undefined);
  const call = rejected(client.callTool(tool, {}, controller.signal), 'cancelled', 'unknown');
  try {
    await callStream.started;
    const started = performance.now(); controller.abort();
    await call;
    assert.ok(performance.now() - started < 4000);
    assert.equal(callStream.cancellations(), 1);
    assert.equal(acknowledgement.cancellations(), 1);
    assert.equal(acknowledgement.response.body.locked, false);
    assert.equal(requests.filter(method => method === 'notifications/cancelled').length, 1);
  } finally { await client.close(); await call; }
});
