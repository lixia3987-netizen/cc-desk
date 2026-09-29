import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { McpHttpClient, McpClientError, MCP_PROTOCOL_VERSION } from '../dist/mcp-client.js';

const tool = { name: 'lookup', description: 'Read an item.', inputSchema: { type: 'object' } };
const complete = { resultType: 'complete', content: [{ type: 'text', text: 'done' }] };
const discover = { resultType: 'complete', supportedVersions: [MCP_PROTOCOL_VERSION], capabilities: { tools: {} } };
const active = () => new AbortController().signal;
const rejects = (promise, code, outcome) => assert.rejects(promise, error => {
  assert.ok(error instanceof McpClientError);
  assert.equal(error.code, code);
  assert.equal(error.outcome, outcome);
  assert.equal(error.message, `MCP request failed (${code}).`);
  assert.equal(error.cause, undefined);
  return true;
});

async function fixture(t, action, options = {}) {
  const requests = [];
  const errors = [];
  const server = http.createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push({ body, headers: request.headers, method: request.method });
      const send = (result, status = 200) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
      };
      if (body.method === 'server/discover' && !options.customDiscovery) send(discover);
      else await action({ body, request, response, send, requests });
    } catch (error) { errors.push(error); response.destroy(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    assert.deepEqual(errors, []);
  });
  const endpoint = `http://127.0.0.1:${server.address().port}/mcp`;
  return { endpoint, requests, server, client: new McpHttpClient({ endpoint, allowLoopbackHttp: true, ...options.client }) };
}

test('MCP discovery paginates with per-request metadata and credentials while stripping untrusted tool authority', async t => {
  const second = { ...tool, name: 'second' };
  const { client, requests } = await fixture(t, ({ body, send }) => {
    assert.equal(body.method, 'tools/list');
    send(body.params.cursor
      ? { resultType: 'complete', tools: [second] }
      : { resultType: 'complete', tools: [{ ...tool, annotations: { readOnlyHint: true }, icons: [{ src: 'https://invalid/icon' }] }], nextCursor: 'page-2' });
  }, { client: { bearerToken: 'independent-mcp-credential' } });
  assert.deepEqual(await client.discoverTools(active()), [tool, second]);
  assert.equal(requests.length, 3);
  assert.equal(new Set(requests.map(item => item.body.id)).size, 3);
  for (const { body, headers, method } of requests) {
    assert.equal(method, 'POST');
    assert.equal(headers.authorization, 'Bearer independent-mcp-credential');
    assert.equal(headers['mcp-protocol-version'], MCP_PROTOCOL_VERSION);
    assert.equal(headers['mcp-method'], body.method);
    assert.equal(headers.accept, 'application/json, text/event-stream');
    assert.equal(headers['mcp-session-id'], undefined);
    assert.deepEqual(body.params._meta, {
      'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_VERSION,
      'io.modelcontextprotocol/clientInfo': { name: 'cc-desk-native', version: '0.0.0' },
      'io.modelcontextprotocol/clientCapabilities': {},
    });
  }
});

test('JSON call returns only text and structured result without fetching embedded references or exposing metadata', async t => {
  const { client, requests } = await fixture(t, ({ send }) => send({ ...complete,
    content: [{ type: 'text', text: 'done', annotations: { audience: ['assistant'] } }],
    structuredContent: { link: 'https://do-not-fetch.invalid' }, isError: false, _meta: { private: 'server-only' } }));
  assert.deepEqual(await client.callTool(tool, { id: 7 }, active()), {
    ...complete, structuredContent: { link: 'https://do-not-fetch.invalid' }, isError: false,
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.method, 'tools/call');
  assert.equal(requests[0].headers['mcp-name'], 'lookup');
  assert.deepEqual(requests[0].body.params.arguments, { id: 7 });
});

test('structuredContent supports every JSON value in the 2026 revision', async t => {
  const values = [null, ['one', 2], 'text', 4, false];
  let index = 0;
  const { client } = await fixture(t, ({ send }) => send({ resultType: 'complete', content: [], structuredContent: values[index++] }));
  for (const value of values) {
    assert.deepEqual(await client.callTool(tool, {}, active()), { resultType: 'complete', content: [], structuredContent: value });
  }
});

test('nested header annotations encode Unicode, controls, whitespace and sentinel values without injection', async t => {
  const headerTool = { name: '查询', inputSchema: { type: 'object', properties: {
    nested: { type: 'object', properties: {
      unicode: { type: 'string', 'x-mcp-header': 'Region' },
      padded: { type: 'string', 'x-mcp-header': 'Padded' },
      control: { type: 'string', 'x-mcp-header': 'Control' },
      sentinel: { type: 'string', 'x-mcp-header': 'Sentinel' },
      plain: { type: 'string', 'x-mcp-header': 'Plain' },
      integer: { type: 'integer', 'x-mcp-header': 'Count' },
      boolean: { type: 'boolean', 'x-mcp-header': 'Flag' },
      absent: { type: 'string', 'x-mcp-header': 'Absent' },
    } },
  } } };
  const input = { nested: { unicode: '上海', padded: ' padded ', control: 'x\r\nAuthorization: forged',
    sentinel: '=?base64?literal?=', plain: 'plain', integer: -42, boolean: false } };
  const { client, requests } = await fixture(t, ({ send }) => send(complete));
  await client.callTool(headerTool, input, active());
  const headers = requests[0].headers;
  const encoded = value => `=?base64?${Buffer.from(value).toString('base64')}?=`;
  assert.equal(headers['mcp-name'], encoded('查询'));
  for (const [key, original] of [['region', input.nested.unicode], ['padded', input.nested.padded], ['control', input.nested.control], ['sentinel', input.nested.sentinel]]) {
    assert.equal(headers[`mcp-param-${key}`], encoded(original));
  }
  assert.equal(headers['mcp-param-plain'], 'plain');
  assert.equal(headers['mcp-param-count'], '-42');
  assert.equal(headers['mcp-param-flag'], 'false');
  assert.equal(headers['mcp-param-absent'], undefined);
  assert.equal(headers.authorization, undefined);
});

test('invalid header annotations are excluded without suppressing neighboring valid tools', async t => {
  const invalid = [
    { type: 'object', 'x-mcp-header': 'Root' },
    { type: 'object', properties: { x: { type: 'number', 'x-mcp-header': 'X' } } },
    { type: 'object', properties: { x: { type: ['string', 'null'], 'x-mcp-header': 'X' } } },
    { type: 'object', properties: { x: { type: 'string', 'x-mcp-header': '' } } },
    { type: 'object', properties: { x: { type: 'string', 'x-mcp-header': 'Bad\r\nHeader' } } },
    { type: 'object', properties: { x: { type: 'string', 'x-mcp-header': 'X' }, y: { type: 'string', 'x-mcp-header': 'x' } } },
    { type: 'object', properties: { list: { type: 'array', items: { type: 'string', 'x-mcp-header': 'X' } } } },
    { type: 'object', allOf: [{ properties: { x: { type: 'string', 'x-mcp-header': 'X' } } }] },
    { type: 'object', if: { properties: { x: { type: 'string', 'x-mcp-header': 'X' } } } },
    { type: 'object', $defs: { x: { type: 'string', 'x-mcp-header': 'X' } }, properties: { x: { $ref: '#/$defs/x' } } },
    { type: 'object', properties: { x: { type: 'string', $ref: '#/$defs/value', 'x-mcp-header': 'X' } } },
  ];
  const { client } = await fixture(t, ({ send }) => send({ resultType: 'complete', tools: [tool,
    ...invalid.map((inputSchema, index) => ({ name: `invalid-${index}`, inputSchema })),
    { name: 'bad-type', inputSchema: { type: 'string' } },
    { name: 'too-large', inputSchema: { type: 'object', description: 'x'.repeat(16385) } },
  ] }));
  assert.deepEqual(await client.discoverTools(active()), [tool]);
});

test('header type mismatch and unsafe integers fail before any request is sent', async t => {
  const { client, requests } = await fixture(t, ({ send }) => send(complete));
  for (const [type, value] of [['integer', 1.5], ['integer', Number.MAX_SAFE_INTEGER + 1], ['integer', '1'], ['boolean', 1], ['string', {}]]) {
    await rejects(client.callTool({ ...tool, inputSchema: { type: 'object', properties: { x: { type, 'x-mcp-header': 'X' } } } }, { x: value }, active()), 'tool_arguments', 'not_executed');
  }
  assert.equal(requests.length, 0);
});

test('unsupported schemas are excluded and supported argument constraints are checked before dispatch', async t => {
  const guarded = { name: 'update', inputSchema: { type: 'object', properties: {
    id: { type: 'integer', minimum: 1 }, mode: { type: 'string', enum: ['preview', 'apply'] },
  }, required: ['id', 'mode'], additionalProperties: false } };
  const unsupported = { name: 'unsupported', inputSchema: { type: 'object', properties: { value: { type: 'string', pattern: '.*' } } } };
  const { client, requests } = await fixture(t, ({ body, send }) => send(body.method === 'tools/list'
    ? { resultType: 'complete', tools: [guarded, unsupported] } : complete));
  assert.deepEqual(await client.discoverTools(active()), [guarded]);
  for (const input of [{ id: 1 }, { id: 0, mode: 'apply' }, { id: 1, mode: 'unknown' }, { id: 1, mode: 'preview', extra: true }]) {
    await rejects(client.callTool(guarded, input, active()), 'tool_arguments', 'not_executed');
  }
  await rejects(client.callTool(unsupported, {}, active()), 'tool_schema', 'not_executed');
  assert.equal(requests.filter(item => item.body.method === 'tools/call').length, 0);
  assert.deepEqual(await client.callTool(guarded, { id: 1, mode: 'preview' }, active()), complete);
});

test('SSE accepts comments, CRLF, CR, multiline data and request notifications then closes at its final response', async t => {
  let closed;
  const close = new Promise(resolve => { closed = resolve; });
  const { client } = await fixture(t, ({ body, response }) => {
    response.on('close', closed);
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    response.write(': keepalive\r\n\r\n');
    response.write('event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":1}}\n\n');
    const json = JSON.stringify({ jsonrpc: '2.0', id: body.id, result: complete });
    const split = json.indexOf(',');
    response.write(`data: ${json.slice(0, split + 1)}\rdata: ${json.slice(split + 1)}\r\r`);
    // Deliberately remain open: the client must close once the final response arrives.
  });
  assert.deepEqual(await client.callTool(tool, {}, active()), complete);
  await close;
});

test('SSE discovery works with a JSON second page', async t => {
  const { client } = await fixture(t, ({ body, response, send }) => {
    if (body.method === 'server/discover') {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: discover })}\n\n`);
    } else send({ resultType: 'complete', tools: [tool] });
  }, { customDiscovery: true });
  assert.deepEqual(await client.discoverTools(active()), [tool]);
});

test('RPC errors and completed tool errors are distinguishable without remote error disclosure', async t => {
  let calls = 0;
  const { client } = await fixture(t, ({ body, response, send }) => {
    if (++calls <= 2) {
      response.writeHead(calls === 1 ? 400 : 500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: calls === 1 ? -32602 : -32603, message: 'private-remote-diagnostic' } }));
    } else send({ ...complete, isError: true });
  });
  await rejects(client.callTool(tool, {}, active()), 'rpc_error', 'unknown');
  await rejects(client.callTool(tool, {}, active()), 'rpc_error', 'unknown');
  assert.deepEqual(await client.callTool(tool, {}, active()), { ...complete, isError: true });
});

test('JSON and SSE mismatched response IDs, batches and server requests leave call outcome unknown', async t => {
  const cases = [
    { jsonrpc: '2.0', id: 'wrong-id', result: complete },
    [{ jsonrpc: '2.0', id: 'wrong-id', result: complete }],
    { jsonrpc: '2.0', id: 'server-call', method: 'sampling/createMessage', params: {} },
  ];
  let index = 0;
  const { client } = await fixture(t, ({ response }) => {
    response.writeHead(200, { 'content-type': index === 2 ? 'text/event-stream' : 'application/json' });
    const message = JSON.stringify(cases[index++]);
    response.end(index === 3 ? `data: ${message}\n\n` : message);
  });
  for (const ignored of cases) await rejects(client.callTool(tool, {}, active()), 'response_schema', 'unknown');
});

test('MRTR, image, audio and resource content fail closed without additional requests', async t => {
  const results = [
    { resultType: 'input_required', inputRequests: { auth: { method: 'elicitation/create', params: { url: 'https://do-not-open.invalid' } } } },
    { resultType: 'complete', content: [{ type: 'image', data: 'base64', mimeType: 'image/png' }] },
    { resultType: 'complete', content: [{ type: 'audio', data: 'base64', mimeType: 'audio/wav' }] },
    { resultType: 'complete', content: [{ type: 'resource_link', uri: 'file:///tmp/private', name: 'private' }] },
  ];
  let index = 0;
  const { client, requests } = await fixture(t, ({ send }) => send(results[index++]));
  await rejects(client.callTool(tool, {}, active()), 'unsupported_result', 'unknown');
  for (let i = 1; i < results.length; i++) await rejects(client.callTool(tool, {}, active()), 'unsupported_content', 'unknown');
  assert.equal(requests.length, results.length);
});

test('truncated SSE events do not become completed tool results', async t => {
  const { client } = await fixture(t, ({ body, response }) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: complete })}\n`);
  });
  await rejects(client.callTool(tool, {}, active()), 'response_incomplete', 'unknown');
});

test('cancellation before dispatch sends nothing and cancellation in flight reports unknown without retry', async t => {
  let seen;
  const received = new Promise(resolve => { seen = resolve; });
  const { client, requests } = await fixture(t, ({ response }) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(': waiting\n\n');
    seen();
  });
  const before = new AbortController();
  before.abort();
  await rejects(client.callTool(tool, {}, before.signal), 'cancelled', 'not_executed');
  assert.equal(requests.length, 0);
  const during = new AbortController();
  const call = client.callTool(tool, {}, during.signal);
  await received;
  during.abort();
  await rejects(call, 'cancelled', 'unknown');
  assert.equal(requests.length, 1);
});

test('one total discovery timeout covers every page instead of resetting per HTTP request', async t => {
  const { client, requests } = await fixture(t, async ({ body, send }) => {
    await new Promise(resolve => setTimeout(resolve, 45));
    if (body.method === 'server/discover') send(discover);
    else send({ resultType: 'complete', tools: [], nextCursor: 'another' });
  }, { customDiscovery: true, client: { timeoutMs: 70 } });
  await rejects(client.discoverTools(active()), 'timeout', 'not_executed');
  assert.ok(requests.length <= 2);
});

test('call timeout and connection loss both report unknown without replay', async t => {
  let index = 0;
  const { client, requests } = await fixture(t, ({ request, response }) => {
    if (index++ === 0) request.socket.destroy();
    else { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write(': waiting\n\n'); }
  }, { client: { timeoutMs: 80 } });
  await rejects(client.callTool(tool, {}, active()), 'transport', 'unknown');
  await rejects(client.callTool(tool, {}, active()), 'timeout', 'unknown');
  assert.equal(requests.length, 2);
});

test('redirects are rejected without forwarding bearer credentials or replaying tool calls', async t => {
  let targetCount = 0;
  const target = await fixture(t, ({ send }) => { targetCount++; send(complete); });
  const { client, requests } = await fixture(t, ({ response }) => {
    response.writeHead(307, { location: target.endpoint }); response.end();
  }, { client: { bearerToken: 'mcp-private-token' } });
  await rejects(client.callTool(tool, {}, active()), 'transport', 'unknown');
  assert.equal(targetCount, 0);
  assert.equal(target.requests.length, 0);
  assert.equal(requests.length, 1);
});

test('legacy and unsupported discovery versions fail with no handshake or automatic fallback', async t => {
  const { client, requests } = await fixture(t, ({ send }) => send({ ...discover, supportedVersions: ['2025-11-25'] }), { customDiscovery: true });
  await rejects(client.discoverTools(active()), 'unsupported_server', 'not_executed');
  assert.deepEqual(requests.map(item => item.body.method), ['server/discover']);
});

test('server without tools capability returns an empty catalog', async t => {
  const { client, requests } = await fixture(t, ({ send }) => send({ ...discover, capabilities: {} }), { customDiscovery: true });
  assert.deepEqual(await client.discoverTools(active()), []);
  assert.equal(requests.length, 1);
});

test('catalog rejects duplicate names and repeated cursors', async t => {
  let mode = 'duplicate';
  const { client } = await fixture(t, ({ send }) => send(mode === 'duplicate'
    ? { resultType: 'complete', tools: [tool, tool] }
    : { resultType: 'complete', tools: [], nextCursor: 'same' }));
  await rejects(client.discoverTools(active()), 'duplicate_tool', 'not_executed');
  mode = 'cursor';
  await rejects(client.discoverTools(active()), 'catalog_cursor', 'not_executed');
});

test('catalog bounds include invalid tools and cap directory pages', async t => {
  let mode = 'count';
  let page = 0;
  const { client, requests } = await fixture(t, ({ send }) => send(mode === 'count'
    ? { resultType: 'complete', tools: Array.from({ length: 65 }, () => ({})) }
    : { resultType: 'complete', tools: [], nextCursor: `page-${page++}` }));
  await rejects(client.discoverTools(active()), 'catalog_limit', 'not_executed');
  mode = 'pages';
  await rejects(client.discoverTools(active()), 'catalog_limit', 'not_executed');
  assert.equal(requests.filter(item => item.body.method === 'tools/list').length, 9);
});

test('oversized response and request bounds fail before unsafe accumulation or request dispatch', async t => {
  const { client, requests } = await fixture(t, ({ send }) => send({ resultType: 'complete', content: [{ type: 'text', text: 'x'.repeat(1024 * 1024) }] }));
  // The 64 KiB schema-input budget rejects this before the transport's 128 KiB request limit.
  await rejects(client.callTool(tool, { large: 'x'.repeat(128 * 1024) }, active()), 'tool_arguments', 'not_executed');
  assert.equal(requests.length, 0);
  await rejects(client.callTool(tool, {}, active()), 'response_limit', 'unknown');
});

test('aggregate discovery response bytes are bounded across catalog pages', async t => {
  let count = 0;
  const { client } = await fixture(t, ({ send }) => send({ resultType: 'complete', tools: [], nextCursor: `next-${count++}`, extra: 'x'.repeat(800 * 1024) }));
  await rejects(client.discoverTools(active()), 'response_limit', 'not_executed');
  assert.equal(count, 3);
});

test('protected credentials echoed directly, JSON-escaped, across text blocks or in RPC errors never leave the client', async t => {
  const secret = 'super-private-mcp-key';
  const results = [
    { ...complete, content: [{ type: 'text', text: secret }] },
    { ...complete, content: [{ type: 'text', text: JSON.stringify({ nested: secret }).replace(secret,
      [...secret].map(character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`).join('')) }] },
    { ...complete, content: [{ type: 'text', text: secret.slice(0, 8) }, { type: 'text', text: secret.slice(8) }] },
    { ...complete, structuredContent: { [secret]: true } },
  ];
  let index = 0;
  const { client } = await fixture(t, ({ body, response, send }) => {
    if (index < results.length) send(results[index++]);
    else {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32603, message: secret } }));
    }
  }, { client: { bearerToken: secret, forbiddenValues: ['separate-model-credential'] } });
  for (let i = 0; i < results.length + 1; i++) await rejects(client.callTool(tool, {}, active()), 'credential_echo', 'unknown');
});

test('catalog credential echo fails closed and protected input never reaches HTTP', async t => {
  const secret = 'model-private-key';
  const { client, requests } = await fixture(t, ({ send }) => send({ resultType: 'complete', tools: [{ ...tool, description: secret }] }),
    { client: { forbiddenValues: [secret] } });
  await rejects(client.callTool(tool, { secret }, active()), 'credential_echo', 'not_executed');
  assert.equal(requests.length, 0);
  await rejects(client.discoverTools(active()), 'credential_echo', 'not_executed');
});

test('endpoint validation allows explicit loopback HTTP and HTTPS only without ambiguous or credentialed URLs', () => {
  for (const endpoint of ['http://127.0.0.1/mcp', 'http://localhost/mcp', 'http://[::1]/mcp']) {
    assert.throws(() => new McpHttpClient({ endpoint }), error => error.code === 'configuration');
    assert.ok(new McpHttpClient({ endpoint, allowLoopbackHttp: true }));
  }
  for (const endpoint of ['http://example.com/mcp', 'file:///tmp/mcp', 'https://user:password@example.com/mcp',
    'https://example.com/mcp?key=secret', 'https://example.com/mcp#secret', 'https://example.com/\npath', 'https://example.com\\mcp']) {
    assert.throws(() => new McpHttpClient({ endpoint, allowLoopbackHttp: true }), error => error.code === 'configuration');
  }
  assert.ok(new McpHttpClient({ endpoint: 'https://example.com/mcp' }));
  assert.throws(() => new McpHttpClient({ endpoint: 'https://example.com/mcp', bearerToken: 'token\r\nForged: yes' }));
  assert.throws(() => new McpHttpClient({ endpoint: 'https://example.com/mcp', timeoutMs: 120001 }));
});


test('2026 output schemas preserve array, scalar and null structured results and reject mismatches', async t => {
  const cases = [
    [{ type: 'array', items: { type: 'integer' }, minItems: 1 }, [1, 2], [1, 'wrong']],
    [{ type: 'string', minLength: 2 }, 'ok', 'x'],
    [{ type: 'number', minimum: 1 }, 1.5, 0],
    [{ type: 'boolean' }, false, 'false'],
    [{ type: 'null' }, null, {}],
  ];
  let output;
  const tools = cases.map(([outputSchema], index) => ({ ...tool, name: `output-${index}`, outputSchema }));
  const { client } = await fixture(t, ({ body, send }) => send(body.method === 'tools/list'
    ? { resultType: 'complete', tools }
    : { resultType: 'complete', content: [], structuredContent: output }));
  assert.deepEqual(await client.discoverTools(active()), tools);
  for (const [index, [, valid, invalid]] of cases.entries()) {
    output = valid;
    assert.deepEqual(await client.callTool(tools[index], {}, active()), { resultType: 'complete', content: [], structuredContent: valid });
    output = invalid;
    await rejects(client.callTool(tools[index], {}, active()), 'output_schema', 'unknown');
  }
});

test('2026 never responds to server ping requests but accepts empty SSE data primers', async t => {
  let ping = false;
  const { client, requests } = await fixture(t, ({ body, response }) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('id: primer\ndata:\n\n');
    response.end(`data: ${JSON.stringify(ping
      ? { jsonrpc: '2.0', id: 'server-ping', method: 'ping' }
      : { jsonrpc: '2.0', id: body.id, result: complete })}\n\n`);
  });
  assert.deepEqual(await client.callTool(tool, {}, active()), complete);
  ping = true;
  await rejects(client.callTool(tool, {}, active()), 'response_schema', 'unknown');
  assert.equal(requests.length, 2);
});
