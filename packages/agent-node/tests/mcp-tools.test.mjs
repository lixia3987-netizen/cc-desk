import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createMcpToolPort, composeToolPorts } from '../dist/mcp-tools.js';
import { McpHttpClient, McpClientError } from '../dist/mcp-client.js';

const identity = { sessionId: 's', conversationId: 'c', runId: 'r', requestId: 'request', workerGeneration: 1 };
const context = () => ({ identity: { ...identity }, policyRevision: 'policy-catalog-snapshot', signal: new AbortController().signal, maxOutputBytes: 32768 });
const connection = (id = 'one') => ({ connectionId: id, revision: 1, name: `Service ${id}`, endpoint: 'http://127.0.0.1:9999/mcp', allowLoopbackHttp: true, bearerToken: 'mcp-secret-credential' });
const tool = () => ({ name: 'same.remote/tool', description: 'Perform an operation.', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } });
const complete = (text = 'done') => ({ resultType: 'complete', content: [{ type: 'text', text }] });
const approve = (prepared, ctx) => ({ decision: 'approved', expiresAt: Date.now() + 60000, binding: { ...ctx.identity, toolCallId: prepared.call.id, inputDigest: prepared.inputDigest, policyRevision: ctx.policyRevision } });
const call = (port, id = 'call', input = { value: 'go' }) => ({ id, name: port.definitions[0].name, arguments: JSON.stringify(input) });
async function fixture(t, options = {}) {
  const state = { tools: [tool()], calls: [], discoveries: 0, response: complete(), discover: undefined, invoke: undefined };
  t.mock.method(McpHttpClient.prototype, 'discoverTools', async function (signal) {
    state.discoveries++;
    await state.discover?.(signal);
    return structuredClone(state.tools);
  });
  t.mock.method(McpHttpClient.prototype, 'callTool', async function (remote, input, signal) {
    state.calls.push({ remote: structuredClone(remote), input: structuredClone(input) });
    return state.invoke ? state.invoke(remote, input, signal) : structuredClone(state.response);
  });
  const ctx = context();
  const port = await createMcpToolPort({ connections: [connection()], forbiddenValues: ['model-secret-credential'], ...options }, ctx.signal);
  return { state, ctx, port };
}

test('MCP names are stable, isolated by connection, bounded, and always command-risk', async t => {
  const { ctx, port } = await fixture(t);
  const pair = await createMcpToolPort({ connections: [connection(), connection('two')] }, ctx.signal);
  assert.equal(port.definitions[0].name, pair.definitions[0].name);
  assert.notEqual(pair.definitions[0].name, pair.definitions[1].name);
  assert.ok(pair.definitions.every(item => /^mcp_[a-f0-9]{16}_[a-f0-9]{43}$/.test(item.name) && item.risk === 'command'));
  assert.match(port.definitions[0].description, /Service one.*same.remote\/tool/);
  const external = port.definitions;
  external[0].risk = 'read';
  external[0].inputSchema.type = 'array';
  const prepared = await port.prepare(call(port), ctx);
  assert.equal(prepared.definition.risk, 'command');
  assert.equal(prepared.requiresApproval, true);
  assert.equal(prepared.definition.inputSchema.type, 'object');
  assert.equal(prepared.preconditions.connectionId, 'one');
  assert.equal(prepared.preconditions.connectionRevision, 1);
  assert.match(prepared.preconditions.schemaHash, /^[a-f0-9]{64}$/);
  assert.equal(prepared.inputDigest, createHash('sha256').update('{"value":"go"}').digest('hex'));
  assert.doesNotMatch(JSON.stringify(prepared), /mcp-secret|model-secret/);
  await assert.rejects(createMcpToolPort({ connections: [connection(), connection()] }, ctx.signal), /duplicate/);
  await assert.rejects(createMcpToolPort({ connections: Array.from({ length: 5 }, (_, index) => connection(String(index))) }, ctx.signal), /budget/);
});

test('MCP only executes with an exact current approval and privately retained prepared input', async t => {
  const { port, state, ctx } = await fixture(t);
  const prepared = await port.prepare(call(port), ctx);
  const wrong = approve(prepared, ctx); wrong.binding.workerGeneration++;
  const expired = approve(prepared, ctx); expired.expiresAt = Date.now() - 1;
  const denied = approve(prepared, ctx); denied.decision = 'denied';
  for (const decision of [undefined, wrong, expired, denied]) assert.equal((await port.execute(prepared, ctx, decision)).status, 'not_executed');
  for (const modify of [item => { item.input.value = 'changed'; }, item => { item.requiresApproval = false; }, item => { item.preconditions.connectionRevision++; }, item => { item.definition.risk = 'read'; }]) {
    const forged = structuredClone(prepared); modify(forged);
    assert.equal((await port.execute(forged, ctx, approve(prepared, ctx))).status, 'not_executed');
  }
  assert.equal((await port.execute(prepared, { ...ctx, policyRevision: 'other-policy' }, approve(prepared, ctx))).status, 'not_executed');
  assert.equal((await port.execute(prepared, { ...ctx, identity: { ...identity, sessionId: 'other' } }, approve(prepared, ctx))).status, 'not_executed');
  assert.equal(state.calls.length, 0);
  assert.equal((await port.execute(prepared, ctx, approve(prepared, ctx))).status, 'completed');
  assert.deepEqual(state.calls[0], { remote: tool(), input: { value: 'go' } });
  assert.equal((await port.execute(prepared, ctx, expired)).status, 'completed');
  assert.equal(state.calls.length, 1);
  await assert.rejects(port.prepare(call(port, 'call', { value: 'changed' }), ctx), /reused/);
});

test('MCP input bounds cover UTF-8 bytes, object shape, nested complexity and known credentials', async t => {
  const { port, ctx, state } = await fixture(t);
  const inputs = [[], null, 1, { value: '界'.repeat(23000) }, { value: 'mcp-secret-credential' }, { 'model-secret-credential': 'x' }];
  let nested = {}; for (let index = 0; index < 35; index++) nested = { value: nested }; inputs.push(nested);
  for (let index = 0; index < inputs.length; index++) await assert.rejects(port.prepare(call(port, String(index), inputs[index]), ctx));
  await assert.rejects(port.prepare({ ...call(port), arguments: '{' }, ctx));
  await assert.rejects(port.prepare(call(port), { ...ctx, maxOutputBytes: 128 }), /budget/);
  const controller = new AbortController(); controller.abort(new Error('model-secret-credential'));
  await assert.rejects(port.prepare(call(port), { ...ctx, signal: controller.signal }), /cancelled/);
  assert.equal(state.calls.length, 0);
  // JSON Schema allows extra fields unless additionalProperties constrains them.
  const valid = await port.prepare(call(port, 'valid', { extra: 2, value: 'go' }), ctx);
  assert.deepEqual(valid.input, { extra: 2, value: 'go' });
});

test('MCP prepare rejects invalid required, integer, extra and nested arguments before approval or call', async t => {
  const { state, ctx } = await fixture(t);
  state.tools = [{ ...tool(), inputSchema: { type: 'object', properties: { amount: { type: 'integer' }, nested: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } }, required: ['amount', 'nested'], additionalProperties: false } }];
  const port = await createMcpToolPort({ connections: [connection()] }, ctx.signal);
  for (const input of [{ amount: 'oops', extra: true }, { amount: 1 }, { amount: 1, nested: { ok: 'yes' } }, { amount: 1, nested: { ok: true }, extra: true }]) await assert.rejects(port.prepare(call(port, JSON.stringify(input), input), ctx), /Schema/);
  assert.equal(state.calls.length, 0);
  const prepared = await port.prepare(call(port, 'valid-schema', { amount: 1, nested: { ok: true } }), ctx);
  assert.equal((await port.execute(prepared, ctx, approve(prepared, ctx))).status, 'completed');
  assert.equal(state.calls.length, 1);
});

test('unsupported MCP validation schemas are omitted from exposed tools', async t => {
  const { state, ctx } = await fixture(t);
  for (const inputSchema of [{ type: 'object', properties: { x: { pattern: 'unsafe.*' } } }, { type: 'object', $ref: 'https://example.test/schema' }, { type: 'object', additionalProperties: 'wrong' }]) {
    state.tools = [{ ...tool(), inputSchema }];
    const port = await createMcpToolPort({ connections: [connection()] }, ctx.signal);
    assert.deepEqual(port.definitions, []);
  }
  assert.equal(state.calls.length, 0);
});

for (const change of ['schema', 'description', 'remove', 'duplicate']) test(`MCP ${change} change invalidates approval and the post-journal recheck prevents calls`, async t => {
  const { port, state, ctx } = await fixture(t);
  const prepared = await port.prepare(call(port), ctx);
  await port.validate(prepared, ctx);
  if (change === 'schema') state.tools[0].inputSchema.required = [];
  if (change === 'description') state.tools[0].description = 'Different operation';
  if (change === 'remove') state.tools = [];
  if (change === 'duplicate') state.tools.push(tool());
  await assert.rejects(port.validate(prepared, ctx), /changed/);
  const result = await port.execute(prepared, ctx, approve(prepared, ctx));
  assert.equal(result.status, 'not_executed');
  assert.equal(state.calls.length, 0);
});

test('connection revisions, ownership and cancellation are rechecked after discovery', async t => {
  let revision = 1; let owned = true;
  const { port, state, ctx } = await fixture(t, {
    assertConnectionCurrent(_id, expected) { if (revision !== expected) throw new Error('model-secret-credential'); },
    async assertOwnership() { if (!owned) throw new Error('mcp-secret-credential'); },
  });
  const prepared = await port.prepare(call(port), ctx);
  state.discover = () => { revision++; };
  assert.equal((await port.execute(prepared, ctx, approve(prepared, ctx))).status, 'not_executed');
  revision = 1;
  state.discover = () => { owned = false; };
  assert.equal((await port.execute(prepared, ctx, approve(prepared, ctx))).status, 'not_executed');
  owned = true;
  const controller = new AbortController();
  state.discover = () => { controller.abort(new Error('mcp-secret-credential')); };
  assert.equal((await port.execute(prepared, { ...ctx, signal: controller.signal }, approve(prepared, ctx))).status, 'not_executed');
  assert.equal(state.calls.length, 0);
});

test('mutating a prepared object during discovery cannot change what gets executed', async t => {
  const { port, state, ctx } = await fixture(t);
  const prepared = await port.prepare(call(port), ctx);
  state.discover = () => { prepared.input.value = 'raced'; };
  assert.equal((await port.execute(prepared, ctx, approve(prepared, ctx))).status, 'not_executed');
  assert.equal(state.calls.length, 0);
});

test('MCP remote failure, uncertain outcome, and oversized or unsupported output do not replay or expose secrets', async t => {
  const { port, state, ctx } = await fixture(t);
  const cases = [
    { response: { ...complete('operation failed'), isError: true }, status: 'failed' },
    { response: complete('mcp-secret-credential'), status: 'unknown' },
    { response: { ...complete(), structuredContent: { private: 'model-secret-credential' } }, status: 'unknown' },
    { response: complete('x'.repeat(ctx.maxOutputBytes)), status: 'unknown' },
    { response: { resultType: 'complete', content: [{ type: 'resource_link', uri: 'https://example.test/secret' }] }, status: 'unknown' },
    { response: { resultType: 'accepted', task: { id: 'task' } }, status: 'unknown' },
    { error: new Error('mcp-secret-credential'), status: 'unknown' },
    { error: new McpClientError('disconnected', 'unknown'), status: 'unknown' },
    { error: new McpClientError('rpc_error', 'unknown'), status: 'unknown' },
    { error: new McpClientError('configuration', 'not_executed'), status: 'not_executed' },
  ];
  for (let index = 0; index < cases.length; index++) {
    const item = cases[index]; state.response = item.response;
    state.invoke = item.error ? () => { throw item.error; } : undefined;
    const prepared = await port.prepare(call(port, String(index)), ctx);
    const result = await port.execute(prepared, ctx, approve(prepared, ctx));
    assert.equal(result.status, item.status);
    assert.doesNotMatch(JSON.stringify(result), /mcp-secret|model-secret|example.test/);
    assert.deepEqual(await port.execute(prepared, ctx, approve(prepared, ctx)), result);
    assert.equal(state.calls.length, index + 1);
  }
});

test('valid text and structured output survives while isError remains a failed tool result', async t => {
  const { port, state, ctx } = await fixture(t);
  for (const [index, structuredContent] of [{ list: [1, true, null], nested: { value: 'json' } }, ['array', 1], null, 'text', 42, true].entries()) {
    state.response = { ...complete('ok'), structuredContent };
    const prepared = await port.prepare(call(port, `json-${index}`), ctx);
    const result = await port.execute(prepared, ctx, approve(prepared, ctx));
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.output, state.response);
  }
});

test('concurrent attempts for one prepared call execute at most once', async t => {
  const { port, state, ctx } = await fixture(t);
  let release; let started;
  const startedPromise = new Promise(resolve => { started = resolve; });
  state.invoke = () => { started(); return new Promise(resolve => { release = () => resolve(complete()); }); };
  const prepared = await port.prepare(call(port), ctx);
  const pending = port.execute(prepared, ctx, approve(prepared, ctx));
  await startedPromise;
  assert.equal((await port.execute(prepared, ctx, approve(prepared, ctx))).status, 'unknown');
  assert.equal(state.calls.length, 1);
  release();
  assert.equal((await pending).status, 'completed');
});

test('catalog limits and secret-bearing metadata stop before any tool exposure', async t => {
  const { state, ctx } = await fixture(t);
  for (const change of [
    () => { state.tools = [{ ...tool(), description: 'mcp-secret-credential' }]; },
    () => { state.tools = [{ ...tool(), inputSchema: { type: 'object', description: 'model-secret-credential' } }]; },
    () => { state.tools = Array.from({ length: 65 }, (_, index) => ({ ...tool(), name: String(index) })); },
    () => { state.tools = [{ ...tool(), description: 'x'.repeat(128 * 1024) }]; },
    () => { state.tools = [tool(), tool()]; },
  ]) {
    change();
    await assert.rejects(createMcpToolPort({ connections: [connection()], forbiddenValues: ['model-secret-credential'] }, ctx.signal));
  }
  assert.equal(state.calls.length, 0);
});

test('composed ports preserve local routing, reject namespace collision and isolate definition mutation', async t => {
  const { port, ctx, state } = await fixture(t);
  let localExecutions = 0;
  const localDefinition = { name: 'read_file', risk: 'read', description: 'local', inputSchema: { type: 'object' } };
  const local = {
    definitions: [localDefinition],
    async prepare(localCall, localContext) { return { call: localCall, definition: structuredClone(localDefinition), input: {}, inputDigest: 'local', policyRevision: localContext.policyRevision, requiresApproval: false, preconditions: {} }; },
    async validate() {},
    async execute() { localExecutions++; return { status: 'completed', output: { local: true } }; },
  };
  const composed = composeToolPorts([local, port]);
  assert.equal(composed.definitions.length, 2);
  const definitions = composed.definitions; definitions[0].name = 'mutated';
  const localPrepared = await composed.prepare({ id: 'local', name: 'read_file', arguments: '{}' }, ctx);
  await composed.validate(localPrepared, ctx);
  assert.deepEqual(await composed.execute(localPrepared, ctx), { status: 'completed', output: { local: true } });
  assert.equal(localExecutions, 1); assert.equal(state.calls.length, 0);
  const remote = await composed.prepare(call(port), ctx);
  assert.equal((await composed.execute(remote, ctx, approve(remote, ctx))).status, 'completed');
  assert.equal(state.calls.length, 1);
  assert.throws(() => composeToolPorts([port, port]), /unique/);
  await assert.rejects(composed.prepare({ id: 'unknown', name: 'unknown', arguments: '{}' }, ctx), /Unknown/);
  localPrepared.definition.risk = 'command';
  assert.throws(() => composed.validate(localPrepared, ctx), /changed/);
});
