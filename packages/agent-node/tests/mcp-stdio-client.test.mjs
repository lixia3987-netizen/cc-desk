import { test } from 'node:test';
import assert from 'node:assert/strict';
import { McpStdioClient } from '../dist/mcp-stdio-client.js';
import { McpClientError } from '../dist/mcp-client.js';
import { ProcessSupervisor } from '../dist/process-supervisor.js';

const version = '2025-11-25';
const tool = { name: 'lookup', inputSchema: { type: 'object' } };
const initialization = { protocolVersion: version, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
const result = { content: [{ type: 'text', text: 'done' }] };
const active = () => new AbortController().signal;
const deferred = () => { let resolve; return { promise: new Promise(done => { resolve = done; }), resolve }; };
const rejects = (promise, code, outcome = 'not_executed') => assert.rejects(promise, error => {
  assert.ok(error instanceof McpClientError);
  assert.equal(error.code, code);
  assert.equal(error.outcome, outcome);
  assert.equal(error.message, `MCP request failed (${code}).`);
  assert.equal(error.cause, undefined);
  return true;
});

function fixture(t, action = ({ body, send }) => send(body.method === 'tools/list' ? { tools: [tool] } : result), options = {}) {
  const requests = [];
  const closed = deferred();
  let config;
  let lifecycle;
  let starts = 0;
  let closes = 0;
  const final = { cleanup: options.cleanup ?? 'released', exitCode: 0, signal: null, cancelled: false };
  const emit = value => config.onStdout(Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : `${JSON.stringify(value)}\n`));
  const handle = {
    closed: closed.promise,
    write: async line => {
      assert.equal(line.endsWith('\n'), true);
      assert.equal(line.slice(0, -1).includes('\n'), false);
      const body = JSON.parse(line);
      requests.push(body);
      const send = value => emit({ jsonrpc: '2.0', id: body.id, result: value });
      if (body.method === 'initialize' && !options.customInitialize) send(initialization);
      else if (body.method === 'notifications/initialized' && !options.customInitialized) return;
      else if (body.method === 'notifications/cancelled' && !options.customCancelled) return;
      else await action({ body, send, emit, requests });
    },
    endInput: async () => {},
    close: async () => {
      closes++;
      if (options.closeGate) await options.closeGate.promise;
      closed.resolve(final);
      return final;
    },
  };
  const supervisor = { openStdio: async (owner, request, signal, forbidden) => {
    starts++; config = request; lifecycle = signal;
    assert.equal(owner, 'fixture-owner');
    assert.ok(Array.isArray(forbidden));
    return handle;
  } };
  const client = new McpStdioClient({ supervisor, ownerId: 'fixture-owner', executable: process.execPath, argv: [], cwd: process.cwd(), ...options.client });
  t.after(async () => { options.closeGate?.resolve(); await client.close().catch(() => {}); });
  return { client, requests, emit, closed, get starts() { return starts; }, get closes() { return closes; }, get lifecycle() { return lifecycle; } };
}

test('stdio initializes once, paginates, reuses its live process and normalizes tool results', async t => {
  const second = { ...tool, name: 'second' };
  const f = fixture(t, ({ body, send }) => send(body.method === 'tools/list'
    ? body.params.cursor ? { tools: [second] } : { tools: [tool], nextCursor: 'second' } : result));
  assert.deepEqual(await f.client.discoverTools(active()), [tool, second]);
  assert.equal(f.lifecycle.aborted, false);
  assert.deepEqual(await f.client.discoverTools(active()), [tool, second]);
  assert.deepEqual(await f.client.callTool(tool, { line: 'one\ntwo' }, active()), { resultType: 'complete', ...result });
  assert.equal(f.starts, 1);
  assert.equal(f.requests.filter(request => request.method === 'initialize').length, 1);
  assert.deepEqual(f.requests[0].params, { protocolVersion: version, capabilities: {}, clientInfo: { name: 'cc-desk-native', version: '0.0.0' } });
  assert.equal(f.requests[1].method, 'notifications/initialized');
  assert.equal(f.requests.every(request => request.params?._meta === undefined), true);
  await f.client.close();
  assert.equal(f.lifecycle.aborted, true);
  assert.equal(f.closes, 1);
});

test('stdio handles split UTF-8 and several newline-delimited messages in one chunk', async t => {
  const f = fixture(t, ({ body, emit }) => {
    const frame = Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: {} })}\n${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [{ ...tool, description: '中文' }] } })}\r\n`);
    const at = frame.indexOf(Buffer.from('中')) + 1;
    emit(frame.subarray(0, at)); emit(frame.subarray(at, at + 1)); emit(frame.subarray(at + 1));
  });
  assert.deepEqual(await f.client.discoverTools(active()), [{ ...tool, description: '中文' }]);
});

test('concurrent discoveries share initialization without sharing response ids', async t => {
  const f = fixture(t);
  assert.deepEqual(await Promise.all([f.client.discoverTools(active()), f.client.discoverTools(active())]), [[tool], [tool]]);
  assert.equal(f.requests.filter(request => request.method === 'initialize').length, 1);
  assert.equal(new Set(f.requests.filter(request => request.id).map(request => request.id)).size, 3);
});

test('initialized notification must finish writing before tools are listed', async t => {
  const entered = deferred(); const gate = deferred();
  const f = fixture(t, async ({ body, send }) => {
    if (body.method === 'notifications/initialized') { entered.resolve(); await gate.promise; }
    else send({ tools: [tool] });
  }, { customInitialized: true });
  const discovery = f.client.discoverTools(active());
  await entered.promise;
  assert.equal(f.requests.some(request => request.method === 'tools/list'), false);
  gate.resolve();
  assert.deepEqual(await discovery, [tool]);
});

for (const [label, value, code] of [
  ['different protocol', { ...initialization, protocolVersion: '2026-07-28' }, 'unsupported_server'],
  ['missing server identity', { protocolVersion: version, capabilities: {} }, 'response_schema'],
  ['invalid tools capability', { ...initialization, capabilities: { tools: true } }, 'response_schema'],
  ['2026 result discriminator', { ...initialization, resultType: 'complete' }, 'response_schema'],
]) test(`stdio rejects ${label} and never restarts or falls back`, async t => {
  const f = fixture(t, ({ send }) => send(value), { customInitialize: true });
  await rejects(f.client.discoverTools(active()), code);
  await rejects(f.client.discoverTools(active()), code);
  assert.equal(f.starts, 1);
  assert.equal(f.closes, 1);
  assert.deepEqual(f.requests.map(request => request.method), ['initialize']);
});

test('server without tools completes initialization without listing', async t => {
  const f = fixture(t, ({ send }) => send({ ...initialization, capabilities: {} }), { customInitialize: true });
  assert.deepEqual(await f.client.discoverTools(active()), []);
  assert.deepEqual(f.requests.map(request => request.method), ['initialize', 'notifications/initialized']);
});

test('ping receives an empty result and unsupported server requests receive bounded fixed errors', async t => {
  const f = fixture(t, ({ body, send, emit }) => {
    if (body.method === 'tools/list') {
      emit({ jsonrpc: '2.0', id: 'server-ping', method: 'ping' });
      emit({ jsonrpc: '2.0', id: 7, method: 'sampling/createMessage', params: {} });
      send({ tools: [tool] });
    }
  });
  assert.deepEqual(await f.client.discoverTools(active()), [tool]);
  assert.deepEqual(f.requests.find(request => request.id === 'server-ping'), { jsonrpc: '2.0', id: 'server-ping', result: {} });
  assert.deepEqual(f.requests.find(request => request.id === 7), { jsonrpc: '2.0', id: 7, error: { code: -32601, message: 'Method not supported.' } });
});

test('server request floods terminate the process', async t => {
  const f = fixture(t, ({ body, emit }) => {
    if (body.method === 'tools/list') for (let index = 0; index < 9; index++) emit({ jsonrpc: '2.0', id: index, method: 'ping' });
  });
  await rejects(f.client.discoverTools(active()), 'server_request_limit');
  assert.equal(f.closes, 1);
});

for (const [label, frame, code] of [
  ['plain stdout log', 'server ready\n', 'response_json'],
  ['JSON batch', '[]\n', 'response_schema'],
  ['blank line', '\n', 'response_json'],
  ['oversized line', Buffer.alloc(1024 * 1024 + 1, 65), 'response_limit'],
  ['unknown response id', JSON.stringify({ jsonrpc: '2.0', id: 'unknown-id', result: {} }) + '\n', 'response_schema'],
]) test(`stdout ${label} is rejected without exposing its contents`, async t => {
  const f = fixture(t, ({ emit }) => emit(frame));
  await rejects(f.client.discoverTools(active()), code);
  assert.equal(f.closes, 1);
});

test('invalid UTF-8 is never decoded as replacement text', async t => {
  const f = fixture(t, ({ emit }) => emit(Buffer.from([0xff, 10])));
  await rejects(f.client.discoverTools(active()), 'transport');
});

test('catalog filters unsupported schemas and required tasks while retaining output schemas', async t => {
  const valid = { ...tool, outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } };
  const f = fixture(t, ({ send }) => send({ tools: [valid,
    { name: 'task', inputSchema: { type: 'object' }, execution: { taskSupport: 'required' } },
    { name: 'bad', inputSchema: { type: 'array' } }] }));
  assert.deepEqual(await f.client.discoverTools(active()), [valid]);
});

test('repeated catalog cursors and duplicate names cannot loop or overwrite definitions', async t => {
  const f = fixture(t, ({ send }) => send({ tools: [], nextCursor: 'repeat' }));
  await rejects(f.client.discoverTools(active()), 'catalog_cursor');
  assert.equal(f.requests.filter(request => request.method === 'tools/list').length, 2);
  const other = fixture(t, ({ send }) => send({ tools: [tool, tool] }));
  await rejects(other.client.discoverTools(active()), 'duplicate_tool');
});

test('invalid tool arguments are rejected before process startup', async t => {
  const f = fixture(t);
  await rejects(f.client.callTool({ ...tool, inputSchema: { type: 'object', required: ['required'] } }, {}, active()), 'tool_arguments');
  assert.equal(f.starts, 0);
});

for (const [label, value, code] of [
  ['binary content', { content: [{ type: 'image', data: 'binary' }] }, 'unsupported_content'],
  ['array structured content', { content: [], structuredContent: [] }, 'unsupported_result'],
  ['task result', { content: [], task: {} }, 'unsupported_result'],
  ['2026 discriminator', { ...result, resultType: 'complete' }, 'unsupported_result'],
]) test(`issued stdio call with ${label} is unknown and is not replayed`, async t => {
  const f = fixture(t, ({ send }) => send(value));
  await rejects(f.client.callTool(tool, {}, active()), code, 'unknown');
  assert.equal(f.requests.filter(request => request.method === 'tools/call').length, 1);
  assert.equal(f.closes, 1);
});

test('output schemas validate successful structured results and allow an error result without structured content', async t => {
  const typed = { ...tool, outputSchema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } } };
  const good = fixture(t, ({ send }) => send({ content: [], structuredContent: { ok: true } }));
  assert.deepEqual(await good.client.callTool(typed, {}, active()), { resultType: 'complete', content: [], structuredContent: { ok: true } });
  const invalid = fixture(t, ({ send }) => send({ content: [], structuredContent: { ok: 'yes' } }));
  await rejects(invalid.client.callTool(typed, {}, active()), 'output_schema', 'unknown');
  const failed = fixture(t, ({ send }) => send({ content: [], isError: true }));
  assert.deepEqual(await failed.client.callTool(typed, {}, active()), { resultType: 'complete', content: [], isError: true });
});

test('RPC errors after dispatch preserve unknown outcome and discard private diagnostics', async t => {
  const f = fixture(t, ({ body, emit }) => emit({ jsonrpc: '2.0', id: body.id, error: { code: -32603, message: 'private path from server' } }));
  await rejects(f.client.callTool(tool, {}, active()), 'rpc_error', 'unknown');
});

test('environment and configured credentials are blocked in split result content and decoded JSON text', async t => {
  const secret = 'stdio-private-credential';
  const f = fixture(t, ({ send }) => send({ content: [{ type: 'text', text: secret.slice(0, 8) }, { type: 'text', text: secret.slice(8) }] }), { client: { environment: { MCP_API_KEY: secret } } });
  await rejects(f.client.callTool(tool, {}, active()), 'credential_echo', 'unknown');
  const nested = fixture(t, ({ send }) => send({ ...tool, tools: [{ ...tool, description: JSON.stringify({ key: secret }).replaceAll('s', '\\u0073') }] }), { client: { forbiddenValues: [secret] } });
  await rejects(nested.client.discoverTools(active()), 'credential_echo');
});

test('timeout cancels only non-initialize requests and confirms process cleanup', async t => {
  const f = fixture(t, () => {}, { client: { timeoutMs: 25 } });
  await rejects(f.client.callTool(tool, {}, active()), 'timeout', 'unknown');
  const call = f.requests.find(request => request.method === 'tools/call');
  assert.deepEqual(f.requests.find(request => request.method === 'notifications/cancelled')?.params, { requestId: call.id });
  assert.equal(f.closes, 1);
  const init = fixture(t, () => {}, { customInitialize: true, client: { timeoutMs: 25 } });
  await rejects(init.client.discoverTools(active()), 'timeout');
  assert.deepEqual(init.requests.map(request => request.method), ['initialize']);
  assert.equal(init.closes, 1);
});

test('cancellation after dispatch remains unknown despite late completion and successful process cleanup', async t => {
  const entered = deferred(); let answer;
  const f = fixture(t, ({ body, send }) => { if (body.method === 'tools/call') { answer = send; entered.resolve(); } });
  const controller = new AbortController();
  const call = f.client.callTool(tool, {}, controller.signal);
  const check = rejects(call, 'cancelled', 'unknown');
  await entered.promise; controller.abort(); answer(result); await check;
  assert.equal(f.closes, 1);
  assert.equal(f.requests.filter(request => request.method === 'tools/call').length, 1);
});

test('close is idempotent and does not release ownership before process cleanup confirmation', async t => {
  const entered = deferred(); const closeGate = deferred();
  const f = fixture(t, () => entered.resolve(), { closeGate });
  const call = f.client.callTool(tool, {}, active());
  const check = rejects(call, 'closed', 'unknown');
  await entered.promise;
  const close = f.client.close();
  assert.equal(f.client.close(), close);
  let released = false; close.then(() => { released = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(released, false);
  closeGate.resolve(); await check; await close;
  assert.equal(f.closes, 1);
  await rejects(f.client.discoverTools(active()), 'closed');
});

test('cleanup failure is explicitly retained for the host ownership barrier', async t => {
  const f = fixture(t, undefined, { cleanup: 'cleanup_failed' });
  assert.deepEqual(await f.client.discoverTools(active()), [tool]);
  await assert.rejects(f.client.close(), error => error.cleanupUnconfirmed === true && !error.message.includes('fixture'));
});

test('truncated stdout followed by process exit cannot be treated as a completed call', async t => {
  const f = fixture(t, ({ emit }) => { emit('{"jsonrpc":"2.0"'); f.closed.resolve({ cleanup: 'released', exitCode: 0, signal: null, cancelled: false }); });
  await rejects(f.client.callTool(tool, {}, active()), 'response_incomplete', 'unknown');
});

test('real local stdio fixture stays alive between discovery and call, then releases its supervised process tree', async t => {
  const supervisor = new ProcessSupervisor({ terminationGraceMs: 50, cleanupTimeoutMs: 1000 });
  const script = `const readline=require('node:readline');readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(!m.id)return;const result=m.method==='initialize'?${JSON.stringify(initialization)}:m.method==='tools/list'?{tools:[${JSON.stringify(tool)}]}:${JSON.stringify(result)};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n')});`;
  const client = new McpStdioClient({ supervisor, ownerId: 'stdio-real-fixture', executable: process.execPath, argv: ['-e', script], cwd: process.cwd() });
  t.after(async () => { await client.close(); await supervisor.stopOwner('stdio-real-fixture'); });
  assert.deepEqual(await client.discoverTools(active()), [tool]);
  assert.deepEqual(await client.callTool(tool, {}, active()), { resultType: 'complete', ...result });
  await client.close();
  assert.equal(supervisor.has('stdio-real-fixture'), false);
});
