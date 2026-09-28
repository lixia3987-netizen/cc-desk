import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { McpHttpClient, McpClientError } from '../dist/mcp-client.js';

const version = '2025-11-25';
const session = 'fixture-session-id-that-must-remain-private';
const tool = { name: 'lookup', inputSchema: { type: 'object' } };
const result = { content: [{ type: 'text', text: 'done' }] };
const normalized = { resultType: 'complete', ...result };
const initialize = { protocolVersion: version, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
const active = () => new AbortController().signal;
const rejected = (promise, code, outcome = 'not_executed') => assert.rejects(promise, error => {
  assert.ok(error instanceof McpClientError);
  assert.equal(error.code, code);
  assert.equal(error.outcome, outcome);
  assert.equal(error.message, `MCP request failed (${code}).`);
  assert.equal(error.cause, undefined);
  return true;
});
const deferred = () => { let resolve; return { promise: new Promise(done => { resolve = done; }), resolve: value => resolve(value) }; };

async function fixture(t, action = () => {}, options = {}) {
  const requests = [];
  const errors = [];
  const server = http.createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
      requests.push({ body, headers: request.headers, method: request.method });
      const send = (value, status = 200, headers = {}) => {
        response.writeHead(status, { 'content-type': 'application/json', ...headers });
        response.end(JSON.stringify({ jsonrpc: '2.0', id: body?.id, result: value }));
      };
      const ack = (status = 202, headers = {}) => { response.writeHead(status, headers); response.end(); };
      if (body?.method === 'initialize' && !options.customInitialize) send(initialize, 200, options.noSession ? {} : { 'Mcp-Session-Id': session });
      else if (body?.method === 'notifications/initialized' && !options.customInitialized) ack();
      else if (body?.method === 'notifications/cancelled' && !options.customCancelled) ack();
      else if (request.method === 'DELETE' && !options.customDelete) ack(204);
      else await action({ body, request, response, send, ack, requests });
    } catch (error) { errors.push(error); response.destroy(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/mcp`;
  const client = new McpHttpClient({ endpoint, allowLoopbackHttp: true, protocolVersion: version, ...options.client });
  t.after(async () => {
    await client.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    assert.deepEqual(errors, []);
  });
  return { client, requests, endpoint, server };
}

test('legacy handshake, pagination and calls use explicit version and private session headers without 2026 metadata', async t => {
  const second = { ...tool, name: 'second' };
  const { client, requests } = await fixture(t, ({ body, send }) => {
    if (body.method === 'tools/list') send(body.params.cursor ? { tools: [second] } : { tools: [tool], nextCursor: 'page-2' });
    else send(result);
  }, { client: { bearerToken: 'legacy-private-access-token' } });
  assert.deepEqual(await client.discoverTools(active()), [tool, second]);
  assert.deepEqual(await client.callTool(tool, { id: 1 }, active()), normalized);
  assert.deepEqual(requests.map(item => item.body.method), ['initialize', 'notifications/initialized', 'tools/list', 'tools/list', 'tools/call']);
  assert.deepEqual(requests[0].body.params, { protocolVersion: version, capabilities: {}, clientInfo: { name: 'cc-desk-native', version: '0.0.0' } });
  for (const [index, { body, headers }] of requests.entries()) {
    assert.equal(headers.authorization, 'Bearer legacy-private-access-token');
    assert.equal(headers['mcp-protocol-version'], index ? version : undefined);
    assert.equal(headers['mcp-session-id'], index ? session : undefined);
    assert.equal(headers['mcp-method'], undefined);
    assert.equal(headers['mcp-name'], undefined);
    assert.equal(body.params?._meta, undefined);
  }
  await client.close();
  assert.equal(requests.at(-1).method, 'DELETE');
  assert.equal(requests.at(-1).headers['mcp-session-id'], session);
});

test('repeated and concurrent discovery reuse one initialization and relist tools', async t => {
  const { client, requests } = await fixture(t, ({ send }) => send({ tools: [tool] }));
  assert.deepEqual(await Promise.all([client.discoverTools(active()), client.discoverTools(active())]), [[tool], [tool]]);
  assert.deepEqual(await client.discoverTools(active()), [tool]);
  assert.equal(requests.filter(item => item.body?.method === 'initialize').length, 1);
  assert.equal(requests.filter(item => item.body?.method === 'notifications/initialized').length, 1);
  assert.equal(requests.filter(item => item.body?.method === 'tools/list').length, 3);
});

test('legacy stateless endpoints still initialize once and close without DELETE', async t => {
  const { client, requests } = await fixture(t, ({ send }) => send(result), { noSession: true });
  assert.deepEqual(await client.callTool(tool, {}, active()), normalized);
  await client.close();
  assert.equal(requests.some(item => item.method === 'DELETE'), false);
  assert.equal(requests.every(item => !item.headers['mcp-session-id']), true);
});

test('tools/list cannot start until initialized notification has an empty 202 acknowledgement', async t => {
  const seen = deferred();
  const proceed = deferred();
  const { client, requests } = await fixture(t, async ({ body, ack, send }) => {
    if (body.method === 'notifications/initialized') { seen.resolve(); await proceed.promise; ack(); }
    else send({ tools: [] });
  }, { customInitialized: true });
  const discovery = client.discoverTools(active());
  await seen.promise;
  assert.equal(requests.some(item => item.body?.method === 'tools/list'), false);
  proceed.resolve();
  assert.deepEqual(await discovery, []);
});

for (const [label, value, code] of [
  ['different version', { ...initialize, protocolVersion: '2024-11-05' }, 'unsupported_server'],
  ['missing server identity', { protocolVersion: version, capabilities: { tools: {} } }, 'response_schema'],
  ['missing capabilities', { protocolVersion: version, serverInfo: initialize.serverInfo }, 'response_schema'],
  ['invalid tools capability', { ...initialize, capabilities: { tools: true } }, 'response_schema'],
  ['2026 discriminator', { ...initialize, resultType: 'complete' }, 'response_schema'],
]) test(`invalid ${label} cannot silently downgrade or repeat initialize`, async t => {
  const { client, requests } = await fixture(t, ({ send }) => send(value, 200, { 'Mcp-Session-Id': session }), { customInitialize: true });
  await rejected(client.discoverTools(active()), code);
  await rejected(client.discoverTools(active()), code);
  assert.deepEqual(requests.map(item => item.body?.method), ['initialize']);
  await client.close();
  assert.equal(requests.at(-1).method, 'DELETE');
});

for (const [label, status, body] of [['wrong status', 200, ''], ['nonempty acknowledgement', 202, 'unexpected']]) {
  test(`initialized rejects ${label} before tools traffic`, async t => {
    const { client, requests } = await fixture(t, ({ response }) => { response.writeHead(status); response.end(body); }, { customInitialized: true });
    await rejected(client.discoverTools(active()), status === 200 ? 'http_error' : 'response_schema');
    assert.equal(requests.some(item => item.body?.method === 'tools/list'), false);
  });
}

test('no tools capability returns empty discovery and blocks direct tool calls', async t => {
  const { client, requests } = await fixture(t, ({ send }) => send({ ...initialize, capabilities: {} }), { customInitialize: true });
  assert.deepEqual(await client.discoverTools(active()), []);
  await rejected(client.callTool(tool, {}, active()), 'unsupported_server');
  assert.deepEqual(requests.map(item => item.body?.method), ['initialize', 'notifications/initialized']);
});

for (const invalid of ['contains space', 'x'.repeat(1025)]) {
  test(`invalid session header (${invalid.length} bytes) fails before initialized`, async t => {
    const { client, requests } = await fixture(t, ({ send }) => send(initialize, 200, { 'Mcp-Session-Id': invalid }), { customInitialize: true });
    await rejected(client.discoverTools(active()), 'session_expired');
    assert.equal(requests.length, 1);
  });
}

test('session header mutation fails closed and leaves original session available only for disposal', async t => {
  const { client, requests } = await fixture(t, ({ send }) => send({ tools: [] }, 200, { 'Mcp-Session-Id': 'mutated-private-session' }));
  await rejected(client.discoverTools(active()), 'session_expired');
  const count = requests.length;
  await rejected(client.callTool(tool, {}, active()), 'session_expired');
  assert.equal(requests.length, count);
  await client.close();
  assert.equal(requests.at(-1).headers['mcp-session-id'], session);
});

test('session IDs echoed in descriptions, text blocks or structured keys never leave the transport', async t => {
  let mode = 0;
  const { client } = await fixture(t, ({ body, send }) => {
    if (body.method === 'tools/list') send({ tools: [{ ...tool, description: session }] });
    else send(mode++ ? { content: [], structuredContent: { [session]: true } } : { content: [
      { type: 'text', text: session.slice(0, 10) }, { type: 'text', text: session.slice(10) },
    ] });
  });
  await rejected(client.discoverTools(active()), 'credential_echo');
  await rejected(client.callTool(tool, {}, active()), 'credential_echo', 'unknown');
  await rejected(client.callTool(tool, {}, active()), 'credential_echo', 'unknown');
});

test('404 expires the client with no implicit reinitialize or replay', async t => {
  const { client, requests } = await fixture(t, ({ ack }) => ack(404));
  await rejected(client.callTool(tool, {}, active()), 'session_expired', 'unknown');
  await rejected(client.discoverTools(active()), 'session_expired');
  await rejected(client.callTool(tool, {}, active()), 'session_expired');
  assert.equal(requests.filter(item => item.body?.method === 'initialize').length, 1);
  assert.equal(requests.filter(item => item.body?.method === 'tools/call').length, 1);
});

test('old structured content must be an object and legacy results cannot accept task/2026 envelopes', async t => {
  const values = [null, [], 'text', 1, false];
  const cases = [...values.map(structuredContent => ({ content: [], structuredContent })),
    { ...result, resultType: 'complete' }, { task: { taskId: 'remote-task' }, content: [] },
    { content: [{ type: 'resource_link', uri: 'https://never-follow.invalid' }] }];
  let next = 0;
  const { client } = await fixture(t, ({ send }) => send(cases[next++]));
  for (let index = 0; index < cases.length; index++) {
    await rejected(client.callTool(tool, {}, active()), index === cases.length - 1 ? 'unsupported_content' : 'unsupported_result', 'unknown');
  }
});

test('task-only tools and unsupported output schemas are hidden while optional synchronous tools remain available', async t => {
  const outputSchema = { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'], additionalProperties: false };
  const optional = { ...tool, name: 'optional', execution: { taskSupport: 'optional' }, outputSchema };
  const forbidden = { ...tool, name: 'sync', execution: { taskSupport: 'forbidden' } };
  const { client } = await fixture(t, ({ send }) => send({ tools: [
    { ...tool, name: 'tasks-only', execution: { taskSupport: 'required' } }, optional, forbidden,
    { ...tool, name: 'bad-output', outputSchema: { type: 'array' } },
    { ...tool, name: 'remote-ref', outputSchema: { type: 'object', $ref: 'https://never-fetch.invalid' } },
    { ...tool, name: 'bad-task', execution: { taskSupport: {} } },
  ] }));
  assert.deepEqual(await client.discoverTools(active()), [
    { name: 'optional', inputSchema: tool.inputSchema, outputSchema }, { name: 'sync', inputSchema: tool.inputSchema },
  ]);
});

for (const protocolVersion of [version, '2026-07-28']) test(`outputSchema validates actual structured results in ${protocolVersion}`, async t => {
  const checkedTool = { ...tool, outputSchema: { type: 'object', properties: { count: { type: 'integer', minimum: 1 } }, required: ['count'], additionalProperties: false } };
  const cases = [result, { ...result, structuredContent: { count: '1' } }, { ...result, structuredContent: { count: 1, secret: true } },
    { ...result, structuredContent: { count: 1 } }, { ...result, isError: true }, { ...result, isError: true, structuredContent: { count: 0 } }];
  let next = 0;
  const { client } = await fixture(t, ({ send }) => send({ ...(protocolVersion === version ? {} : { resultType: 'complete' }), ...cases[next++] }), { client: { protocolVersion } });
  for (let index = 0; index < 3; index++) await rejected(client.callTool(checkedTool, {}, active()), 'output_schema', 'unknown');
  assert.deepEqual(await client.callTool(checkedTool, {}, active()), { ...normalized, structuredContent: { count: 1 } });
  assert.deepEqual(await client.callTool(checkedTool, {}, active()), { ...normalized, isError: true });
  await rejected(client.callTool(checkedTool, {}, active()), 'output_schema', 'unknown');
});

test('legacy SSE ignores empty-data primers and replies to bounded ping requests without 2026 headers', async t => {
  let stream;
  let callId;
  const { client, requests } = await fixture(t, ({ body, response, ack }) => {
    if (body.method === 'tools/call') {
      stream = response; callId = body.id;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('id: primer\ndata:\n\n');
      response.write('data: {"jsonrpc":"2.0","id":"server-ping","method":"ping"}\n\n');
    } else {
      assert.deepEqual(body, { jsonrpc: '2.0', id: 'server-ping', result: {} });
      ack();
      stream.end(`data: ${JSON.stringify({ jsonrpc: '2.0', id: callId, result })}\n\n`);
    }
  });
  assert.deepEqual(await client.callTool(tool, {}, active()), normalized);
  const ping = requests.at(-1);
  assert.equal(ping.headers['mcp-session-id'], session);
  assert.equal(ping.headers['mcp-method'], undefined);
});

test('unadvertised server requests and excess pings fail closed without executing a capability', async t => {
  let next = 0;
  const requestsToSend = ['roots/list', 'sampling/createMessage', 'elicitation/create'];
  const { client, requests } = await fixture(t, ({ body, response }) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (next < requestsToSend.length) response.end(`data: ${JSON.stringify({ jsonrpc: '2.0', id: 'server-request', method: requestsToSend[next++], params: {} })}\n\n`);
    else response.end(Array.from({ length: 9 }, (_, index) => `data: ${JSON.stringify({ jsonrpc: '2.0', id: index, method: 'ping' })}\n\n`).join(''));
  });
  for (const ignored of requestsToSend) await rejected(client.callTool(tool, {}, active()), 'response_schema', 'unknown');
  await rejected(client.callTool(tool, {}, active()), 'server_request_limit', 'unknown');
  assert.equal(requests.filter(item => item.body?.method === 'tools/call').length, 4);
  assert.equal(requests.length, 6);
});

test('cancellation sends one request-bound notification but remains unknown after 202', async t => {
  const seen = deferred();
  const { client, requests } = await fixture(t, ({ response }) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write(': waiting\n\n'); seen.resolve();
  });
  const controller = new AbortController();
  const operation = client.callTool(tool, {}, controller.signal);
  const checked = rejected(operation, 'cancelled', 'unknown');
  await seen.promise;
  controller.abort();
  await checked;
  const sentCall = requests.find(item => item.body?.method === 'tools/call');
  const cancellation = requests.find(item => item.body?.method === 'notifications/cancelled');
  assert.deepEqual(cancellation.body.params, { requestId: sentCall.body.id });
  assert.equal(cancellation.body.id, undefined);
  assert.equal(cancellation.headers['mcp-session-id'], session);
  assert.equal(requests.filter(item => item.body?.method === 'tools/call').length, 1);
});

test('discovery timeout cancels the outstanding page, not initialize, and keeps not_executed', async t => {
  const { client, requests } = await fixture(t, ({ response }) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write(': waiting\n\n');
  }, { client: { timeoutMs: 60 } });
  await rejected(client.discoverTools(active()), 'timeout');
  assert.equal(requests.filter(item => item.body?.method === 'notifications/cancelled').length, 1);
  const cancellation = requests.find(item => item.body?.method === 'notifications/cancelled');
  assert.equal(cancellation.body.params.requestId, requests.find(item => item.body?.method === 'tools/list').body.id);
});

test('close joins aborted tool and cancellation acknowledgement before DELETE, is idempotent, and prohibits new requests', async t => {
  const callSeen = deferred();
  const cancellationSeen = deferred();
  const allowAcknowledgement = deferred();
  const { client, requests } = await fixture(t, async ({ body, response, ack }) => {
    if (body.method === 'tools/call') { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write(': waiting\n\n'); callSeen.resolve(); }
    else { cancellationSeen.resolve(); await allowAcknowledgement.promise; ack(); }
  }, { customCancelled: true });
  const call = rejected(client.callTool(tool, {}, active()), 'closed', 'unknown');
  await callSeen.promise;
  const closed = client.close();
  assert.equal(client.close(), closed);
  await cancellationSeen.promise;
  assert.equal(requests.some(item => item.method === 'DELETE'), false);
  await rejected(client.discoverTools(active()), 'closed');
  await rejected(client.callTool(tool, {}, active()), 'closed');
  allowAcknowledgement.resolve();
  await Promise.all([call, closed]);
  assert.equal(requests.at(-1).method, 'DELETE');
  assert.equal(requests.filter(item => item.method === 'DELETE').length, 1);
});

test('close during initialization cannot send initialized/list/call or cancellation', async t => {
  const seen = deferred();
  const { client, requests } = await fixture(t, ({ response }) => {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'Mcp-Session-Id': session });
    response.write(': handshake waiting\n\n'); seen.resolve();
  }, { customInitialize: true });
  const discovery = rejected(client.discoverTools(active()), 'closed');
  await seen.promise;
  // Ensure the headers reached the client, without relying on an arbitrary sleep.
  await new Promise(resolve => setImmediate(resolve));
  await client.close();
  await discovery;
  assert.equal(requests.some(item => item.body?.method === 'notifications/cancelled'), false);
  assert.equal(requests.some(item => ['notifications/initialized', 'tools/list', 'tools/call'].includes(item.body?.method)), false);
  // fetch may be aborted before its Response is observed, so deletion is possible
  // only when the initialization headers were already captured locally.
  assert.ok(requests.length <= 2);
});

for (const status of [404, 405, 500]) test(`DELETE ${status} is best effort and never reopens local client`, async t => {
  const { client, requests } = await fixture(t, ({ request, send, ack }) => request.method === 'DELETE' ? ack(status) : send(result), { customDelete: true });
  await client.callTool(tool, {}, active());
  await client.close();
  await rejected(client.callTool(tool, {}, active()), 'closed');
  assert.equal(requests.filter(item => item.method === 'DELETE').length, 1);
});

test('protocol revision is explicit and invalid options fail before network', () => {
  for (const protocolVersion of ['2024-11-05', '', 20251125]) {
    assert.throws(() => new McpHttpClient({ endpoint: 'https://example.invalid/mcp', protocolVersion }), error => error.code === 'configuration');
  }
});

test('unresponsive cancellation is bounded and cannot relabel an earlier user cancellation as a timeout', async t => {
  const seen = deferred();
  const { client, requests } = await fixture(t, ({ body, response }) => {
    if (body.method === 'tools/call') {
      response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write(': waiting\n\n'); seen.resolve();
    }
    // Keep notifications/cancelled open without acknowledging it.
  }, { customCancelled: true, client: { timeoutMs: 100 } });
  const controller = new AbortController();
  const call = rejected(client.callTool(tool, {}, controller.signal), 'cancelled', 'unknown');
  await seen.promise;
  const started = performance.now();
  controller.abort();
  await call;
  assert.ok(performance.now() - started < 4000, 'cancellation cleanup must remain bounded');
  assert.equal(requests.filter(item => item.body?.method === 'notifications/cancelled').length, 1);
  await client.close();
  assert.equal(requests.at(-1).method, 'DELETE');
});

test('close while initialized acknowledgement is pending disposes the captured session without starting tools', async t => {
  const seen = deferred();
  const { client, requests } = await fixture(t, ({ response }) => {
    response.writeHead(202); response.flushHeaders(); seen.resolve();
  }, { customInitialized: true });
  const discovery = rejected(client.discoverTools(active()), 'closed');
  await seen.promise;
  await client.close();
  await discovery;
  assert.deepEqual(requests.map(item => item.body?.method ?? item.method), ['initialize', 'notifications/initialized', 'DELETE']);
  assert.equal(requests.at(-1).headers['mcp-session-id'], session);
});
