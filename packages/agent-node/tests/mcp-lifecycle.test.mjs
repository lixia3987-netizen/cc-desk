import test from 'node:test';
import assert from 'node:assert/strict';
import { McpHttpClient } from '../dist/mcp-client.js';
import { createMcpToolPort } from '../dist/mcp-tools.js';

const connection = id => ({ connectionId: id, revision: 1, name: id, endpoint: 'http://127.0.0.1:9999/mcp', allowLoopbackHttp: true, protocolVersion: '2025-11-25' });
const tool = () => ({ name: 'change', inputSchema: { type: 'object' } });
const context = () => ({ identity: { sessionId: 'session', conversationId: 'conversation', runId: 'run', requestId: 'request', workerGeneration: 1 },
  signal: new AbortController().signal, policyRevision: 'policy', maxOutputBytes: 65536 });
const call = port => ({ id: 'call', name: port.definitions[0].name, arguments: '{}' });
const approval = (prepared, ctx) => ({ decision: 'approved', expiresAt: Date.now() + 60000,
  binding: { ...ctx.identity, toolCallId: prepared.call.id, inputDigest: prepared.inputDigest, policyRevision: ctx.policyRevision } });

test('partial discovery failure closes every created client, including the one that failed initialization', async t => {
  let count = 0;
  const discovered = [], closed = [];
  t.mock.method(McpHttpClient.prototype, 'discoverTools', async function () {
    discovered.push(this);
    if (++count === 2) throw new Error('fixture discovery failure');
    return [tool()];
  });
  t.mock.method(McpHttpClient.prototype, 'close', async function () { closed.push(this); });
  await assert.rejects(createMcpToolPort({ connections: [connection('one'), connection('two')] }, context().signal), /MCP/);
  assert.equal(closed.length, 2);
  assert.deepEqual(new Set(closed), new Set(discovered));
});

test('empty catalogs still own clients and close is shared, awaited, and prohibits later work', async t => {
  let release;
  let closed = 0;
  const stopped = new Promise(resolve => { release = resolve; });
  t.mock.method(McpHttpClient.prototype, 'discoverTools', async () => []);
  t.mock.method(McpHttpClient.prototype, 'close', async () => { closed++; await stopped; });
  const port = await createMcpToolPort({ connections: [connection('empty')] }, context().signal);
  assert.deepEqual(port.definitions, []);
  const first = port.close(), second = port.close();
  assert.equal(first, second);
  let settled = false;
  void first.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  await assert.rejects(port.prepare({ id: 'late', name: 'anything', arguments: '{}' }, context()), /closed/);
  release();
  await first;
  assert.equal(closed, 1);
});

test('closing while an ownership check is waiting cannot create a late prepared tool or invocation', async t => {
  let block = false, release;
  const waiting = new Promise(resolve => { release = resolve; });
  let calls = 0;
  t.mock.method(McpHttpClient.prototype, 'discoverTools', async () => [tool()]);
  t.mock.method(McpHttpClient.prototype, 'callTool', async () => { calls++; return { resultType: 'complete', content: [] }; });
  const port = await createMcpToolPort({ connections: [connection('one')], assertOwnership: async () => { if (block) await waiting; } }, context().signal);
  block = true;
  const preparing = port.prepare(call(port), context());
  const rejected = assert.rejects(preparing, /closed/);
  await port.close();
  release();
  await rejected;
  assert.equal(calls, 0);
});

test('one local cleanup failure cannot skip the remaining clients and preserves the cleanup barrier', async t => {
  let count = 0;
  t.mock.method(McpHttpClient.prototype, 'discoverTools', async () => []);
  t.mock.method(McpHttpClient.prototype, 'close', function () { if (++count === 1) throw new Error('fixture close failure'); return Promise.resolve(); });
  const port = await createMcpToolPort({ connections: [connection('one'), connection('two')] }, context().signal);
  await assert.rejects(port.close(), error => error.cleanupUnconfirmed === true && !error.message.includes('fixture'));
  assert.equal(count, 2);
});

test('output schema is part of approval revalidation and protocol selection remains visible', async t => {
  const remote = { ...tool(), outputSchema: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'] } };
  let current = remote;
  let calls = 0;
  t.mock.method(McpHttpClient.prototype, 'discoverTools', async () => [structuredClone(current)]);
  t.mock.method(McpHttpClient.prototype, 'callTool', async () => { calls++; return { resultType: 'complete', content: [], structuredContent: { count: 1 } }; });
  const ctx = context(), port = await createMcpToolPort({ connections: [connection('one')] }, ctx.signal);
  t.after(() => port.close());
  const prepared = await port.prepare(call(port), ctx);
  assert.equal(prepared.preconditions.protocolVersion, '2025-11-25');
  current = { ...remote, outputSchema: { type: 'object', required: ['changed'] } };
  assert.equal((await port.execute(prepared, ctx, approval(prepared, ctx))).status, 'not_executed');
  assert.equal(calls, 0);
});

test('a completed call with an invalid structured result remains unknown and cannot be replayed', async t => {
  const remote = { ...tool(), outputSchema: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'] } };
  let calls = 0;
  t.mock.method(McpHttpClient.prototype, 'discoverTools', async () => [remote]);
  t.mock.method(McpHttpClient.prototype, 'callTool', async () => { calls++; return { resultType: 'complete', content: [], structuredContent: { count: 'wrong' } }; });
  const ctx = context(), port = await createMcpToolPort({ connections: [connection('one')] }, ctx.signal);
  t.after(() => port.close());
  const prepared = await port.prepare(call(port), ctx), approved = approval(prepared, ctx);
  assert.equal((await port.execute(prepared, ctx, approved)).status, 'unknown');
  assert.equal((await port.execute(prepared, ctx, approved)).status, 'unknown');
  assert.equal(calls, 1);
});

test('2026 array output schemas remain discoverable and executable through the managed port', async t => {
  const remote = { ...tool(), outputSchema: { type: 'array', items: { type: 'string' } } };
  t.mock.method(McpHttpClient.prototype, 'discoverTools', async () => [remote]);
  t.mock.method(McpHttpClient.prototype, 'callTool', async () => ({ resultType: 'complete', content: [], structuredContent: ['first', 'second'] }));
  const ctx = context(), port = await createMcpToolPort({ connections: [{ ...connection('one'), protocolVersion: '2026-07-28' }] }, ctx.signal);
  t.after(() => port.close());
  assert.equal(port.definitions.length, 1);
  const prepared = await port.prepare(call(port), ctx);
  const result = await port.execute(prepared, ctx, approval(prepared, ctx));
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.output.structuredContent, ['first', 'second']);
});
