import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ResponsesModel, ResponsesModelError } from '../dist/responses-model.js';
import { startResponsesFixture, assistantMessage, functionCall, reasoningItem, responseEvents, sse } from './fixtures/responses-server.mjs';

const identity = { sessionId: 'session', conversationId: 'conversation', runId: 'run', requestId: 'request', workerGeneration: 1 };
const definition = name => ({ name, description: name, inputSchema: { type: 'object', properties: {}, additionalProperties: true }, risk: 'read' });
const definitions = ['read_file', 'apply_patch', 'run_command'].map(definition);
const makeRequest = (model, input = model.userItems('测试 Unicode'), options = {}) => ({
  identity, context: { protocol: model.protocol, items: input }, tools: definitions,
  maxOutputTokens: 1000, signal: new AbortController().signal, onEvent: () => {}, ...options,
});
async function fixtureTest(t, options = {}, modelOptions = {}) {
  const fixture = await startResponsesFixture(options);
  t.after(() => fixture.close());
  const model = new ResponsesModel({ model: 'fixture-model', baseURL: fixture.baseURL, allowLoopbackHttp: true, ...modelOptions });
  return { fixture, model };
}

test('streaming handles fragmented multibyte SSE and retains all opaque items, ordered calls, phase, and usage', async t => {
  const output = [reasoningItem('opaque'), assistantMessage('note', '中文🙂', 'commentary'),
    functionCall('first', 'read_file', { path: '一.txt' }), functionCall('second', 'read_file', { path: 'two.txt' }),
    { type: 'future_passive_item', id: 'future', data: { untouched: [1, 'two'] } }];
  const events = [];
  const { fixture, model } = await fixtureTest(t, { handler: () => ({ output, splitBytes: 1 }) }, { instructions: 'Respect project rules.' });
  const response = await model.generate(makeRequest(model, undefined, { onEvent: event => events.push(event) }));
  assert.deepEqual(response.outputItems, output);
  assert.deepEqual(response.toolCalls.map(call => call.id), ['first', 'second']);
  assert.equal(response.finishReason, 'tool_calls');
  assert.deepEqual(response.usage, { inputTokens: 11, outputTokens: 7, totalTokens: 18 });
  assert.equal(events.filter(event => event.type === 'text_delta').map(event => event.text).join(''), '中文🙂');
  assert.equal(events.filter(event => event.callId === 'first').map(event => event.delta).join(''), '{"path":"一.txt"}');
  assert.equal(fixture.requests[0].instructions, 'Respect project rules.');
  assert.equal(fixture.requests[0].max_output_tokens, 1000);
  assert.deepEqual(fixture.errors, []);
});

test('manual history replays full responses and legal results across fresh adapter instances', async t => {
  const { fixture, model } = await fixtureTest(t);
  let items = model.userItems('read patch command');
  const seen = [];
  for (let index = 0; index < 4; index++) {
    const response = await model.generate(makeRequest(model, items));
    items.push(...response.outputItems);
    for (const call of response.toolCalls) {
      seen.push(call.name);
      const output = call.name === 'read_file' ? { content: 'before', hash: 'a'.repeat(64) } : { exitCode: 0 };
      items.push(...model.toolResultItems(call, { status: 'completed', output }));
    }
    if (!response.toolCalls.length) assert.equal(index, 3);
  }
  assert.deepEqual(seen, ['read_file', 'apply_patch', 'run_command']);
  const restarted = new ResponsesModel({ model: 'fixture-model', baseURL: fixture.baseURL, allowLoopbackHttp: true });
  items = JSON.parse(JSON.stringify(items));
  items.push(...restarted.userItems('continue after clean restart'));
  const response = await restarted.generate(makeRequest(restarted, items));
  assert.equal(response.finishReason, 'completed');
  assert.match(response.outputItems.at(-1).content[0].text, /完整上下文/);
  assert.deepEqual(fixture.errors, []);
  for (const status of ['denied', 'cancelled', 'not_executed', 'failed']) {
    const result = model.toolResultItems({ id: 'call', name: 'read_file', arguments: '{}' }, { status, output: 'reason' });
    assert.equal(result[0].type, 'function_call_output');
    assert.equal(JSON.parse(result[0].output).status, status);
  }
});

test('coalesced events, comments, multiline data, CR framing and unknown event types remain compatible', async t => {
  const output = [assistantMessage('final', 'coalesced')];
  const complete = responseEvents(output).at(-1);
  const raw = ': keepalive\r\n\r\n' + sse({ type: 'response.future_metadata', details: 'ignored' }) +
    'event: response.completed\rdata: {\rdata: ' + JSON.stringify(complete).slice(1) + '\r\r';
  const { model } = await fixtureTest(t, { handler: () => ({ raw }) });
  assert.deepEqual((await model.generate(makeRequest(model))).outputItems, output);
});

test('usage missing is unknown and never guessed', async t => {
  const { model } = await fixtureTest(t, { handler: () => ({ output: [assistantMessage('final', 'done')], usage: null }) });
  assert.equal((await model.generate(makeRequest(model))).usage, null);
});

const faults = [
  ['truncated event', () => ({ raw: 'data: {"type":"response.completed"' }), 'interrupted'],
  ['missing terminal event', () => ({ events: [{ type: 'response.output_text.delta', delta: 'unfinished' }] }), 'interrupted'],
  ['invalid JSON', () => ({ raw: 'data: {invalid}\n\n' }), 'schema'],
  ['invalid event schema', () => ({ raw: 'data: {"type":3}\n\n' }), 'schema'],
  ['wrong event name', () => ({ raw: 'event: response.failed\ndata: {"type":"response.completed"}\n\n' }), 'schema'],
  ['incomplete terminal', () => ({ output: [], status: 'incomplete' }), 'incomplete'],
  ['failed terminal', () => ({ output: [], status: 'failed' }), 'provider'],
  ['provider error', () => ({ events: [{ type: 'error', message: 'secret-remote-error' }] }), 'provider'],
  ['truncated refusal', () => ({ events: [{ type: 'response.refusal.delta', delta: 'refused' }] }), 'interrupted'],
  ['duplicate call IDs', () => ({ output: [functionCall('same', 'read_file', {}), functionCall('same', 'read_file', {})] }), 'schema'],
  ['incomplete output', () => ({ output: [{ ...functionCall('bad', 'read_file', {}), status: 'in_progress' }] }), 'incomplete'],
  ['invalid usage', () => ({ output: [], usage: { input_tokens: -1 } }), 'schema'],
  ['mismatched response identity', () => ({ events: [
    { type: 'response.created', response: { id: 'one' } },
    { type: 'response.completed', response: { id: 'two', status: 'completed', output: [] } },
  ] }), 'schema'],
  ['orphan arguments', () => ({ events: [{ type: 'response.function_call_arguments.delta', item_id: 'fc', output_index: 0, delta: '{}' }] }), 'schema'],
  ['DONE without completion', () => ({ raw: 'data: [DONE]\n\n' }), 'interrupted'],
  ['duplicate completion', () => ({ events: [...responseEvents([]), responseEvents([]).at(-1)] }), 'schema'],
];
for (const [name, response, code] of faults) {
  test(`rejects ${name} before returning executable tool calls`, async t => {
    const { model } = await fixtureTest(t, { handler: response });
    await assert.rejects(model.generate(makeRequest(model)), error => error instanceof ResponsesModelError && error.code === code);
  });
}

test('completed refusals preserve output but have a failure finish reason even alongside tools', async t => {
  const output = [functionCall('unused', 'read_file', {}), { type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'cannot comply' }] }];
  const { model } = await fixtureTest(t, { handler: () => ({ output, events: [{ type: 'response.refusal.delta', delta: 'cannot comply' }, ...responseEvents(output)] }) });
  const response = await model.generate(makeRequest(model));
  assert.equal(response.finishReason, 'refused');
  assert.deepEqual(response.outputItems, output);
});

test('complete invalid tool requests are retained for durable core rejection without losing provider items', async t => {
  const output = [reasoningItem('invalid'), functionCall('unknown', 'hidden_tool', {}), functionCall('malformed', 'read_file', '{broken'), functionCall('array', 'read_file', '[]')];
  const { model } = await fixtureTest(t, { handler: () => ({ output }) });
  const response = await model.generate(makeRequest(model));
  assert.deepEqual(response.outputItems, output);
  assert.deepEqual(response.toolCalls.map(call => call.arguments), ['{}', '{broken', '[]']);
});

test('request and response bytes are bounded and no network occurs for oversized input', async t => {
  const { fixture, model } = await fixtureTest(t, { handler: () => ({ output: [assistantMessage('large', 'x'.repeat(500))] }) }, { maxRequestBytes: 1500, maxResponseBytes: 200 });
  await assert.rejects(model.generate(makeRequest(model, model.userItems('x'.repeat(3000)))), { code: 'request_limit' });
  assert.equal(fixture.requests.length, 0);
  await assert.rejects(model.generate(makeRequest(model)), { code: 'response_limit' });
});

test('timeout and caller cancellation abort an active HTTP stream', async t => {
  const { fixture, model } = await fixtureTest(t, { handler: () => ({ hang: true }) }, { timeoutMs: 30 });
  await assert.rejects(model.generate(makeRequest(model)), { code: 'timeout' });
  const cancellable = new ResponsesModel({ baseURL: fixture.baseURL, model: 'fixture-model', allowLoopbackHttp: true });
  const controller = new AbortController();
  const promise = cancellable.generate(makeRequest(cancellable, undefined, { signal: controller.signal }));
  setTimeout(() => controller.abort('secret-cancel-reason'), 30);
  await assert.rejects(promise, error => error.code === 'cancelled' && error.name === 'AbortError' && !error.message.includes('secret'));
  const count = fixture.requests.length;
  await assert.rejects(cancellable.generate(makeRequest(cancellable, undefined, { signal: controller.signal })), { code: 'cancelled' });
  assert.equal(fixture.requests.length, count);
});

test('HTTP failures and redirects never expose credentials, remote bodies or headers', async t => {
  const sentinel = 'secret-sentinel-credential';
  const target = await startResponsesFixture({ handler: () => ({ output: [] }) });
  t.after(() => target.close());
  const { model } = await fixtureTest(t, { handler: () => ({ httpStatus: 307, headers: { Location: `${target.baseURL}/responses`, 'X-Diagnostic': sentinel }, raw: sentinel }) }, { apiKey: sentinel });
  await assert.rejects(model.generate(makeRequest(model)), error => error.code === 'redirect' && !JSON.stringify(error).includes(sentinel));
  assert.equal(target.requests.length, 0);
  const failing = await fixtureTest(t, { handler: () => ({ httpStatus: 429, raw: sentinel }) }, { apiKey: sentinel });
  await assert.rejects(failing.model.generate(makeRequest(failing.model)), error => error.httpStatus === 429 && !error.message.includes(sentinel));
});

test('rejects malformed UTF-8 and a connection interruption', async t => {
  const bad = await fixtureTest(t, { handler: () => ({ raw: Buffer.from([0xff, 0xfe, 0xfd]) }) });
  await assert.rejects(bad.model.generate(makeRequest(bad.model)), { code: 'transport' });
  const interrupted = await fixtureTest(t, { handler: () => ({ raw: 'data: {', disconnect: true }) });
  await assert.rejects(interrupted.model.generate(makeRequest(interrupted.model)), error => ['transport', 'interrupted'].includes(error.code));
});

test('service URLs, credentials and context protocol are checked without echoing input', async t => {
  const sentinel = 'secret-sentinel-credential';
  for (const baseURL of ['http://remote.example/v1', 'http://127.0.0.1/v1', `https://user:${sentinel}@example.com/v1`, `https://example.com/v1?key=${sentinel}`, 'file:///tmp/api']) {
    assert.throws(() => new ResponsesModel({ baseURL, model: 'model', apiKey: sentinel }), error => error.code === 'configuration' && !error.message.includes(sentinel));
  }
  assert.throws(() => new ResponsesModel({ baseURL: 'https://example.com/v1', model: 'model' }), { code: 'credential' });
  const { model } = await fixtureTest(t);
  await assert.rejects(model.generate(makeRequest(model, [], { context: { protocol: { id: 'other', version: 1 }, items: [] } })), { code: 'protocol' });
});

test('credential echoes are blocked before projection across text and tool delta boundaries', async t => {
  const key = 'secret-api-key-sentinel';
  for (const kind of ['text', 'tool']) {
    const events = kind === 'tool' ? [{ type: 'response.output_item.added', output_index: 0, item: { id: 'fc', call_id: 'call', type: 'function_call' } }] : [];
    const parts = ['Safe message prefix that is allowed. ', key.slice(0, 8), key.slice(8)];
    for (const delta of parts) events.push(kind === 'text' ? { type: 'response.output_text.delta', delta } : { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc', delta });
    const seen = [];
    const { model } = await fixtureTest(t, { handler: () => ({ events }) }, { apiKey: key });
    await assert.rejects(model.generate(makeRequest(model, undefined, { onEvent: event => seen.push(event.text ?? event.delta) })), { code: 'credential_echo' });
    assert.ok(!seen.join('').includes(key));
    assert.ok(!seen.join('').includes(key.slice(0, 8)), 'the pending credential prefix must be withheld');
  }
});

test('credential echoes in opaque output and decoded tool arguments cannot enter saved context or approvals', async t => {
  const key = 'secret-api-key-sentinel';
  const escaped = key.split('').map(character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
  for (const output of [
    [{ ...reasoningItem('echo'), encrypted_content: key }],
    [functionCall('echo', 'read_file', `{"path":"${escaped}"}`)],
    [{ ...assistantMessage('echo', ''), content: [{ type: 'output_text', text: key.slice(0, 8) }, { type: 'output_text', text: key.slice(8) }] }],
  ]) {
    const { model } = await fixtureTest(t, { handler: () => ({ events: [responseEvents(output).at(-1)] }) }, { apiKey: key });
    await assert.rejects(model.generate(makeRequest(model)), { code: 'credential_echo' });
  }
});

test('safe credential-buffered deltas are released without modifying their contents', async t => {
  const text = '正常输出不包含凭据，仍然完整显示。';
  const { model } = await fixtureTest(t, { handler: () => ({ output: [assistantMessage('safe', text)] }) }, { apiKey: 'sentinel-longer-than-message-output-here' });
  const seen = [];
  await model.generate(makeRequest(model, undefined, { onEvent: event => seen.push(event.text ?? event.delta) }));
  assert.equal(seen.join(''), text);
});

test('interleaved text and different tool channels cannot flush credential prefixes', async t => {
  const key = 'secret-api-key-sentinel';
  const filler = 'innocuous '.repeat(10);
  for (const target of ['text', 'tool']) {
    const events = [
      { type: 'response.output_item.added', output_index: 0, item: { id: 'fc_a', call_id: 'a', type: 'function_call' } },
      { type: 'response.output_item.added', output_index: 1, item: { id: 'fc_b', call_id: 'b', type: 'function_call' } },
    ];
    const targetDelta = delta => target === 'text' ? { type: 'response.output_text.delta', delta } : { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_a', delta };
    const otherDelta = delta => ({ type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'fc_b', delta });
    events.push(targetDelta(key.slice(0, 8)), otherDelta(filler), targetDelta(key.slice(8)), otherDelta(filler));
    const projected = [];
    const { model } = await fixtureTest(t, { handler: () => ({ events }) }, { apiKey: key });
    await assert.rejects(model.generate(makeRequest(model, undefined, { onEvent: event => projected.push(event) })), { code: 'credential_echo' });
    assert.ok(!projected.filter(event => target === 'text' ? event.type === 'text_delta' : event.callId === 'a').map(event => event.text ?? event.delta).join('').includes(key));
  }
});
