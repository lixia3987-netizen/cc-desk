import test from 'node:test';
import assert from 'node:assert/strict';
import { AnthropicModel, AnthropicModelError, estimateAnthropicInputTokens } from '../dist/anthropic-model.js';
import { createNativeModel, nativeModelProtocol, estimateNativeInputTokens, extractNativeAssistantText } from '../dist/native-model.js';
import { assertNoModelCredential } from '../dist/responses-model.js';
import { startAnthropicFixture, anthropicEvents, anthropicSse, messageStart, messageDelta, messageStop, blockStart, blockDelta, blockStop } from './fixtures/anthropic-server.mjs';

const identity = { sessionId: 'session', conversationId: 'conversation', runId: 'run', requestId: 'request', workerGeneration: 1 };
const definitions = [{ name: 'read_file', description: 'Read a project file.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }, risk: 'read' }];
const tool = (id = 'toolu_read', name = 'read_file', input = { path: '测试.txt' }) => ({ type: 'tool_use', id, name, input });
const request = (model, overrides = {}) => ({ identity, context: { protocol: model.protocol, items: model.userItems('测试 Unicode') }, tools: definitions, maxOutputTokens: 1000, signal: new AbortController().signal, onEvent: () => {}, ...overrides });
async function fixtureTest(t, result = {}, options = {}, fixtureOptions = {}) {
  const fixture = await startAnthropicFixture({ ...fixtureOptions, handler: typeof result === 'function' ? result : () => result });
  t.after(() => fixture.close());
  const model = new AnthropicModel({ model: 'fixture-model', baseURL: fixture.baseURL, allowLoopbackHttp: true, toolDefinitions: definitions, ...options });
  return { fixture, model };
}

test('fragmented UTF-8 text and complete streamed tool JSON retain native blocks and usage', async t => {
  const content = [{ type: 'text', text: '中文🙂' }, tool(), tool('toolu_second', 'read_file', { path: 'other.txt' })];
  const { model, fixture } = await fixtureTest(t, { content, splitBytes: 1 }, { apiKey: 'local-api-credential', instructions: 'Project rules.' });
  const events = [], response = await model.generate(request(model, { onEvent: event => events.push(event) }));
  assert.deepEqual(response.outputItems, [{ role: 'assistant', content }]);
  assert.deepEqual(response.toolCalls, content.slice(1).map(block => ({ id: block.id, name: block.name, arguments: JSON.stringify(block.input) })));
  assert.equal(response.finishReason, 'tool_calls');
  assert.deepEqual(response.usage, { inputTokens: 11, outputTokens: 7, totalTokens: 18 });
  assert.equal(events.filter(event => event.type === 'text_delta').map(event => event.text).join(''), '中文🙂');
  assert.equal(events.filter(event => event.callId === 'toolu_read').map(event => event.delta).join(''), '{"path":"测试.txt"}');
  assert.equal(fixture.requests[0].system, 'Project rules.');
  assert.equal(fixture.requests[0].max_tokens, 1000);
  assert.equal(fixture.requestHeaders[0]['x-api-key'], 'local-api-credential');
  assert.equal(fixture.requestHeaders[0].authorization, undefined);
  assert.deepEqual(fixture.errors, []);
});

test('bearer authentication forwards only Authorization and service endpoints retain gateway prefixes', async t => {
  for (const [basePath, expectedPath] of [['', '/v1/messages'], ['/v1/', '/v1/messages'], ['/gateway', '/gateway/v1/messages'], ['/gateway/v1', '/gateway/v1/messages'], ['/gateway/v1/messages/', '/gateway/v1/messages']]) {
    const fixture = await startAnthropicFixture({ expectedPath }); t.after(() => fixture.close());
    const model = createNativeModel({ protocol: 'anthropic', model: 'fixture-model', baseURL: fixture.origin + basePath, allowLoopbackHttp: true, apiKey: 'local-auth-token', authHeader: 'authorization', toolDefinitions: [] });
    await model.generate(request(model, { tools: [] }));
    assert.equal(fixture.requestHeaders[0].authorization, 'Bearer local-auth-token');
    assert.equal(fixture.requestHeaders[0]['x-api-key'], undefined);
    assert.deepEqual(fixture.requestPaths, [expectedPath]);
    assert.deepEqual(fixture.errors, []);
    assert.deepEqual(nativeModelProtocol('anthropic'), model.protocol);
  }
});

test('tool calls and all result statuses replay across two requests and a fresh adapter', async t => {
  const { model, fixture } = await fixtureTest(t, ({ index }) => index === 0 ? { content: [tool()] } : { content: [{ type: 'text', text: 'continued' }] });
  const items = model.userItems('read file'), first = await model.generate(request(model, { context: { protocol: model.protocol, items } }));
  const result = { status: 'completed', output: { content: 'hello' } };
  items.push(...first.outputItems, ...model.toolResultItems(first.toolCalls[0], result));
  const restarted = new AnthropicModel({ model: 'fixture-model', baseURL: fixture.baseURL, allowLoopbackHttp: true, toolDefinitions: definitions });
  const second = await restarted.generate(request(restarted, { context: { protocol: restarted.protocol, items: JSON.parse(JSON.stringify(items)) } }));
  assert.equal(extractNativeAssistantText(second.outputItems), 'continued');
  assert.deepEqual(fixture.requests[1].messages, items);
  assert.deepEqual(items.at(-1), { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_read', content: JSON.stringify(result), is_error: false }] });
  for (const status of ['denied', 'cancelled', 'not_executed', 'failed']) {
    const [item] = restarted.toolResultItems(first.toolCalls[0], { status, output: 'reason' });
    assert.equal(item.content[0].is_error, true);
    assert.equal(JSON.parse(item.content[0].content).status, status);
  }
  assert.deepEqual(fixture.errors, []);
});

for (const signature of [undefined, '', 'opaque-signature-🙂']) test(`private thinking ${signature === undefined ? 'without signature (Kimi)' : 'with streamed signature'} and redacted blocks retain native state without text events`, async t => {
  const content = [{ type: 'thinking', thinking: '先分析🙂再检查', ...(signature === undefined ? {} : { signature }) },
    { type: 'redacted_thinking', data: 'opaque-redacted-state' }, { type: 'text', text: '可见答案' }];
  const { model, fixture } = await fixtureTest(t, { content, splitBytes: 1 }, { apiKey: 'fixture-protected-credential' });
  const events = [], response = await model.generate(request(model, { onEvent: event => events.push(event) }));
  assert.deepEqual(response.outputItems, [{ role: 'assistant', content }]);
  assert.equal(extractNativeAssistantText(response.outputItems), '可见答案');
  assert.equal(events.filter(event => event.type === 'text_delta').map(event => event.text).join(''), '可见答案');
  assert.ok(events.every(event => event.type === 'text_delta'));
  assert.equal(fixture.requests[0].thinking, undefined);
  assert.equal(fixture.requests[0].output_config, undefined);
  assert.deepEqual(fixture.errors, []);
});

test('thinking and signatures before and after a tool block are preserved on a fresh adapter continuation', async t => {
  const content = [{ type: 'thinking', thinking: 'Check the original request.', signature: 'signed-original-state' },
    { type: 'text', text: 'Reading.' }, tool(), { type: 'thinking', thinking: 'Private interleaved state.' }, { type: 'redacted_thinking', data: 'encrypted-original-state' }];
  const { model, fixture } = await fixtureTest(t, ({ index }) => index === 0 ? { content } : { content: [{ type: 'thinking', thinking: 'Review the saved result.' }, { type: 'text', text: 'Done.' }] });
  const items = model.userItems('read file'), first = await model.generate(request(model, { context: { protocol: model.protocol, items } }));
  items.push(...first.outputItems, ...model.toolResultItems(first.toolCalls[0], { status: 'completed', output: 'original file' }));
  const restarted = new AnthropicModel({ model: 'fixture-model', baseURL: fixture.baseURL, allowLoopbackHttp: true, toolDefinitions: definitions });
  const second = await restarted.generate(request(restarted, { context: { protocol: restarted.protocol, items: JSON.parse(JSON.stringify(items)) } }));
  assert.deepEqual(fixture.requests[1].messages, items);
  assert.deepEqual(fixture.requests[1].messages[1].content, content);
  assert.equal(extractNativeAssistantText(second.outputItems), 'Done.');
  assert.deepEqual(fixture.errors, []);
});

test('approved user images use bounded base64 sources and reject remote or modified image inputs', async t => {
  const image = { mimeType: 'image/png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' };
  const { model, fixture } = await fixtureTest(t);
  const context = { protocol: model.protocol, items: model.userItems('image', [image]) };
  await model.generate(request(model, { context }));
  assert.deepEqual(fixture.requests[0].messages[0].content[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } });
  for (const source of [{ type: 'url', url: 'https://example.com/image.png' }, { type: 'base64', media_type: 'image/png', data: 'invalid' }, { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=', future: 'hidden' }]) {
    await assert.rejects(model.generate(request(model, { context: { protocol: model.protocol, items: [{ role: 'user', content: [{ type: 'image', source }] }] } })), { code: 'protocol' });
  }
  assert.equal(fixture.requests.length, 1);
});

test('max tokens, refusal and context limits never enable tools; cache tokens count as input usage', async t => {
  for (const [stopReason, finishReason] of [['max_tokens', 'incomplete'], ['model_context_window_exceeded', 'incomplete'], ['refusal', 'refused']]) {
    const { model } = await fixtureTest(t, { stopReason, startMessage: { usage: { input_tokens: 11, output_tokens: 1, cache_creation_input_tokens: 3, cache_read_input_tokens: 4 } } });
    const response = await model.generate(request(model));
    assert.equal(response.finishReason, finishReason);
    assert.deepEqual(response.toolCalls, []);
    assert.deepEqual(response.usage, { inputTokens: 18, outputTokens: 7, totalTokens: 25 });
  }
  const { model } = await fixtureTest(t, { startMessage: { usage: null }, usage: null });
  assert.equal((await model.generate(request(model))).usage, null);
});

const faults = [
  ['truncated event', { raw: 'event: message_start\ndata: {"type":' }, 'interrupted'],
  ['missing message stop', { events: anthropicEvents().slice(0, -1) }, 'interrupted'],
  ['partial tool JSON before end of stream', { events: [messageStart(), blockStart(tool('one', 'read_file', {})), blockDelta({ type: 'input_json_delta', partial_json: '{"path":' })] }, 'interrupted'],
  ['unterminated tool block', { events: [messageStart(), blockStart(tool()), messageDelta('tool_use'), messageStop()] }, 'schema'],
  ['invalid completed tool JSON', { events: [messageStart(), blockStart(tool('one', 'read_file', {})), blockDelta({ type: 'input_json_delta', partial_json: '{bad' }), blockStop()] }, 'schema'],
  ['array tool input JSON', { events: [messageStart(), blockStart(tool('one', 'read_file', {})), blockDelta({ type: 'input_json_delta', partial_json: '[]' }), blockStop()] }, 'schema'],
  ['non-string thinking', { content: [{ type: 'thinking', thinking: null }] }, 'schema'],
  ['non-string signature', { content: [{ type: 'thinking', thinking: '', signature: null }] }, 'schema'],
  ['unknown thinking state', { content: [{ type: 'thinking', thinking: '', future: 'continuation' }] }, 'unsupported'],
  ['missing redacted data', { content: [{ type: 'redacted_thinking' }] }, 'schema'],
  ['unknown redacted state', { content: [{ type: 'redacted_thinking', data: 'opaque', future: true }] }, 'unsupported'],
  ['thinking after signature', { events: [messageStart(), blockStart({ type: 'thinking', thinking: '' }), blockDelta({ type: 'signature_delta', signature: 'first' }), blockDelta({ type: 'thinking_delta', thinking: 'changed' })] }, 'schema'],
  ['signature on text block', { events: [messageStart(), blockStart({ type: 'text', text: '' }), blockDelta({ type: 'signature_delta', signature: 'signed' })] }, 'unsupported'],
  ['delta on redacted block', { events: [messageStart(), blockStart({ type: 'redacted_thinking', data: 'opaque' }), blockDelta({ type: 'thinking_delta', thinking: 'changed' })] }, 'unsupported'],
  ['malformed thinking delta', { events: [messageStart(), blockStart({ type: 'thinking', thinking: '' }), blockDelta({ type: 'thinking_delta', thinking: 1 })] }, 'schema'],
  ['unknown signature delta state', { events: [messageStart(), blockStart({ type: 'thinking', thinking: '' }), blockDelta({ type: 'signature_delta', signature: 'signed', future: true })] }, 'unsupported'],
  ['unfinished thinking before complete tool', { events: [...anthropicEvents([tool()]).slice(0, -2), blockStart({ type: 'thinking', thinking: '' }, 1), blockDelta({ type: 'thinking_delta', thinking: 'unfinished' }, 1)] }, 'interrupted'],
  ['server tool block', { content: [{ type: 'server_tool_use', id: 'server', name: 'web_search', input: {} }] }, 'unsupported'],
  ['unknown block', { content: [{ type: 'future_block', opaque: 'must-preserve' }] }, 'unsupported'],
  ['text citations', { events: [messageStart(), blockStart({ type: 'text', text: 'text', citations: [{ source: 'unknown' }] })] }, 'unsupported'],
  ['unknown text delta', { events: [messageStart(), blockStart({ type: 'text', text: '' }), blockDelta({ type: 'thinking_delta', thinking: 'hidden' })] }, 'unsupported'],
  ['tool without tool stop', { content: [tool()], stopReason: 'end_turn' }, 'schema'],
  ['tool with truncated stop', { content: [tool()], stopReason: 'max_tokens' }, 'schema'],
  ['tool stop without calls', { stopReason: 'tool_use' }, 'schema'],
  ['duplicate tool IDs', { content: [tool(), tool()] }, 'schema'],
  ['unknown stop reason', { stopReason: 'future_reason' }, 'unsupported'],
  ['paused server turn', { stopReason: 'pause_turn' }, 'unsupported'],
  ['duplicate message start', { events: [messageStart(), messageStart()] }, 'schema'],
  ['content before start', { events: [blockStart({ type: 'text', text: '' })] }, 'schema'],
  ['noncontiguous block indices', { events: [messageStart(), blockStart({ type: 'text', text: '' }, 1)] }, 'schema'],
  ['delta after block stop', { events: [messageStart(), blockStart({ type: 'text', text: '' }), blockStop(), blockDelta({ type: 'text_delta', text: 'extra' })] }, 'schema'],
  ['message stop before completion', { events: [messageStart(), messageStop()] }, 'interrupted'],
  ['data after completion', { events: [...anthropicEvents(), messageStop()] }, 'schema'],
  ['invalid usage count', { usage: { output_tokens: -1 } }, 'schema'],
  ['invalid event JSON', { raw: 'event: message_start\ndata: invalid\n\n' }, 'schema'],
  ['mismatched SSE event type', { raw: 'event: other\ndata: ' + JSON.stringify(messageStart()) + '\n\n' }, 'schema'],
  ['provider error', { events: [{ type: 'error', error: { type: 'overloaded_error', message: 'private-provider-content' } }] }, 'provider'],
];
for (const [name, result, code] of faults) test(`rejects ${name} before returning executable calls`, async t => {
  const { model } = await fixtureTest(t, result);
  await assert.rejects(model.generate(request(model)), error => error instanceof AnthropicModelError && error.code === code && !error.message.includes('private'));
});

test('credentials split across private fields, visible blocks and deltas never escape in a completed response', async t => {
  const credential = 'fixture-secret-never-persist', half = Math.floor(credential.length / 2), first = credential.slice(0, half), second = credential.slice(half);
  for (const content of [
    [{ type: 'thinking', thinking: credential }],
    [{ type: 'thinking', thinking: '', signature: credential }],
    [{ type: 'redacted_thinking', data: credential }],
    [{ type: 'thinking', thinking: first }, { type: 'text', text: second }],
    [{ type: 'thinking', thinking: first, signature: second }],
    [{ type: 'thinking', thinking: '', signature: first }, { type: 'redacted_thinking', data: second }],
    [{ type: 'thinking', thinking: first, signature: 'unrelated' }, { type: 'thinking', thinking: second }],
    [{ type: 'thinking', thinking: '', signature: first }, { type: 'text', text: 'unrelated' }, { type: 'thinking', thinking: '', signature: second }],
  ]) {
    const { model } = await fixtureTest(t, { content }, { apiKey: credential });
    const events = [];
    await assert.rejects(model.generate(request(model, { onEvent: event => events.push(event) })), { code: 'credential_echo' });
    assert.ok(!JSON.stringify(events).includes(credential));
    assert.throws(() => assertNoModelCredential([{ role: 'assistant', content }], credential), { code: 'credential_echo' });
  }
  const { model } = await fixtureTest(t, { content: [{ type: 'thinking', thinking: first + second }] }, { apiKey: credential });
  await assert.rejects(model.generate(request(model)), { code: 'credential_echo' });
});

test('unrelated private fields cannot hide credentials split across content field combinations', async t => {
  const credential = 'fixture-secret-never-persist', fields = ['text', 'thinking', 'signature', 'data'];
  const block = (field, value) => field === 'text' ? { type: 'text', text: value }
    : field === 'thinking' ? { type: 'thinking', thinking: value }
    : field === 'signature' ? { type: 'thinking', thinking: '', signature: value }
    : { type: 'redacted_thinking', data: value };
  for (let mask = 1; mask < 15; mask++) {
    const selected = fields.filter((_, index) => mask & (1 << index));
    if (selected.length < 2) continue;
    const content = selected.map((field, index) => block(field, credential.slice(Math.floor(index * credential.length / selected.length), Math.floor((index + 1) * credential.length / selected.length))));
    content.splice(1, 0, block(fields.find(field => !selected.includes(field)), 'unrelated-private-state'));
    const message = { role: 'assistant', content };
    assert.throws(() => assertNoModelCredential(message, credential), { code: 'credential_echo' });
    assert.throws(() => assertNoModelCredential([message], credential), { code: 'credential_echo' });
    const { model } = await fixtureTest(t, { content }, { apiKey: credential });
    await assert.rejects(model.generate(request(model)), { code: 'credential_echo' });
  }
});

test('CR framing, comments and multiline SSE JSON are accepted', async t => {
  const raw = ': keepalive\r\r' + anthropicEvents().map(event => `event: ${event.type}\rdata: {\rdata: ${JSON.stringify(event).slice(1)}\r\r`).join('');
  const { model } = await fixtureTest(t, { raw });
  assert.equal(extractNativeAssistantText((await model.generate(request(model))).outputItems), '完成🙂');
});

test('request and response limits fail safely before network or tool execution', async t => {
  const { model, fixture } = await fixtureTest(t, { content: [{ type: 'text', text: 'x'.repeat(1000) }] }, { maxRequestBytes: 1000, maxResponseBytes: 300 });
  await assert.rejects(model.generate(request(model, { context: { protocol: model.protocol, items: model.userItems('x'.repeat(2000)) } })), { code: 'request_limit' });
  assert.equal(fixture.requests.length, 0);
  await assert.rejects(model.generate(request(model)), { code: 'response_limit' });
});

test('abort and timeouts stop real loopback streams without retries', async t => {
  const { model, fixture } = await fixtureTest(t, { hang: true }, { timeoutMs: 40 });
  await assert.rejects(model.generate(request(model)), { code: 'timeout' });
  const cancellable = new AnthropicModel({ baseURL: fixture.baseURL, model: 'fixture-model', allowLoopbackHttp: true, toolDefinitions: definitions });
  const controller = new AbortController(), task = cancellable.generate(request(cancellable, { signal: controller.signal }));
  setTimeout(() => controller.abort(), 40);
  await assert.rejects(task, { code: 'cancelled', name: 'AbortError' });
  const before = fixture.requests.length;
  await assert.rejects(cancellable.generate(request(cancellable, { signal: controller.signal })), { code: 'cancelled' });
  assert.equal(fixture.requests.length, before);
});

test('socket loss while tool JSON is still streaming cannot return a tool call or a retry candidate', async t => {
  const events = [messageStart(), blockStart(tool('one', 'read_file', {})), blockDelta({ type: 'input_json_delta', partial_json: '{"path":' })];
  const { model, fixture } = await fixtureTest(t, { events, splitBytes: 1, disconnect: true });
  const visible = [];
  await assert.rejects(model.generate(request(model, { onEvent: event => visible.push(event) })), error => {
    assert.equal(error.code, 'transport');
    assert.deepEqual(model.classifyError(error), { category: 'network', retryable: false });
    return true;
  });
  assert.equal(fixture.requests.length, 1);
  assert.ok(visible.some(event => event.type === 'tool_arguments_delta'));
});

test('redirect:error never forwards credentials to a redirect target', async t => {
  const target = await startAnthropicFixture(); t.after(() => target.close());
  const { model, fixture } = await fixtureTest(t, { httpStatus: 307, headers: { Location: target.baseURL + '/v1/messages' }, raw: 'private' }, { apiKey: 'local-auth-key' });
  await assert.rejects(model.generate(request(model)), error => {
    assert.equal(error.code, 'transport');
    assert.equal(error.cause, undefined);
    assert.equal(error.message, 'Model transport failed or returned invalid UTF-8.');
    assert.deepEqual(model.classifyError(error), { category: 'network', retryable: false });
    return true;
  });
  assert.equal(fixture.requests.length, 1);
  assert.equal(target.requests.length, 0);
});

test('only actual pre-stream HTTP 429 and temporary service failures grant retry permission', async t => {
  for (const [httpStatus, category] of [[401, 'authentication'], [403, 'authentication'], [400, 'configuration'], [429, 'rate_limit'], [500, 'service_error'], [502, 'service_unavailable'], [503, 'service_unavailable'], [504, 'service_unavailable']]) {
    const { model, fixture } = await fixtureTest(t, { httpStatus, raw: 'private-error-content' });
    await assert.rejects(model.generate(request(model)), error => {
      assert.equal(error.message, `Model service returned HTTP ${httpStatus}.`);
      assert.deepEqual(model.classifyError(error), { category, httpStatus, retryable: [429, 502, 503, 504].includes(httpStatus) });
      return true;
    });
    assert.equal(fixture.requests.length, 1);
    assert.deepEqual(model.classifyError(new AnthropicModelError('http', 'forged', 429)), { category: 'rate_limit', httpStatus: 429, retryable: false });
    assert.deepEqual(model.classifyError({ code: 'http', httpStatus: 503 }), { category: 'unknown', retryable: false });
  }
});

test('non-SSE, invalid UTF-8 and callback failures expose only fixed diagnostics', async t => {
  for (const [result, code] of [[{ headers: { 'Content-Type': 'application/json' }, raw: '{}' }, 'schema'], [{ raw: Buffer.from([0xff]) }, 'transport']]) {
    const { model } = await fixtureTest(t, result);
    await assert.rejects(model.generate(request(model)), { code });
  }
  const { model } = await fixtureTest(t);
  await assert.rejects(model.generate(request(model, { onEvent: () => { throw new AnthropicModelError('http', 'private-callback', 429); } })), error => {
    assert.equal(error.code, 'transport');
    assert.deepEqual(model.classifyError(error), { category: 'network', retryable: false });
    assert.equal(error.cause, undefined);
    assert.ok(!error.message.includes('private'));
    return true;
  });
});

test('credential checks cover inputs, fragmented text, cross-block text and decoded streamed tool JSON', async t => {
  const apiKey = 'sentinel-api-key', { model, fixture } = await fixtureTest(t, {}, { apiKey });
  await assert.rejects(model.generate(request(model, { context: { protocol: model.protocol, items: model.userItems(apiKey) } })), { code: 'credential_echo' });
  assert.equal(fixture.requests.length, 0);
  await assert.rejects(model.generate(request(model, { context: { protocol: model.protocol, items: [{ role: 'user', content: [{ type: 'text', text: 'sentinel-' }, { type: 'text', text: 'api-key' }] }] } })), { code: 'credential_echo' });
  assert.equal(fixture.requests.length, 0);
  for (const content of [[{ type: 'text', text: 'safe sentinel-api-key' }], [{ type: 'text', text: 'sentinel-' }, { type: 'text', text: 'api-key' }], [tool('one', 'read_file', { path: apiKey })]]) {
    const { model: unsafe } = await fixtureTest(t, { content, splitBytes: 1 }, { apiKey });
    const visible = [];
    await assert.rejects(unsafe.generate(request(unsafe, { onEvent: event => visible.push(event) })), { code: 'credential_echo' });
    assert.ok(!JSON.stringify(visible).includes(apiKey));
  }
  const escaped = [messageStart(), blockStart(tool('one', 'read_file', {})), blockDelta({ type: 'input_json_delta', partial_json: '{"path":"sentinel-\\u0061pi-key"}' }), blockStop(), messageDelta('tool_use'), messageStop()];
  const { model: unsafe } = await fixtureTest(t, { events: escaped }, { apiKey });
  await assert.rejects(unsafe.generate(request(unsafe)), { code: 'credential_echo' });
});

test('persisted unsupported continuation, unmatched tools, incompatible protocols and changed catalogs fail before HTTP', async t => {
  const { model, fixture } = await fixtureTest(t);
  const invalid = [
    { items: model.userItems('hello'), continuation: { responseId: 'hidden' } },
    { items: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'hidden', signature: 'signed', future: 'unsupported-state' }] }] },
    { items: [{ role: 'assistant', content: [tool()] }] },
    { items: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'orphan', content: '{}' }] }] },
    { items: [{ role: 'system', content: 'unauthorized instructions' }] },
    { items: model.userItems('hello'), protocol: { id: 'anthropic-messages', version: 2 } },
  ];
  for (const context of invalid) await assert.rejects(model.generate(request(model, { context: { protocol: model.protocol, ...context } })), { code: 'protocol' });
  await assert.rejects(model.generate(request(model, { tools: [] })), { code: 'tool_catalog' });
  assert.equal(fixture.requests.length, 0);
});

test('tool budgets include detached schemas and no-tools summary requests omit tool parameters', async t => {
  const mutable = structuredClone(definitions), { model } = await fixtureTest(t, {}, { toolDefinitions: mutable, instructions: 'rules' });
  const context = { protocol: model.protocol, items: model.userItems('hello') }, estimate = estimateAnthropicInputTokens(context, 'rules', definitions);
  mutable[0].description = 'x'.repeat(10000);
  assert.equal(model.estimateInputTokens(context), estimate);
  assert.equal(estimateNativeInputTokens(context, 'rules', definitions), estimate);
  assert.ok(estimate > estimateAnthropicInputTokens(context, 'rules', []));
  const { model: summary, fixture } = await fixtureTest(t, {}, { toolDefinitions: [] });
  await summary.generate(request(summary, { tools: [] }));
  assert.equal(fixture.requests[0].tools, undefined);
  assert.equal(fixture.requests[0].tool_choice, undefined);
});

test('configuration rejects insecure endpoints, URL credentials and invalid transport limits', () => {
  const basic = { baseURL: 'https://example.com', model: 'model', apiKey: 'key' };
  for (const baseURL of ['http://example.com', 'http://127.0.0.1', 'https://user:pass@example.com', 'https://example.com?key=secret', 'https://example.com/#hash', 'not-a-url']) assert.throws(() => new AnthropicModel({ ...basic, baseURL }), { code: 'configuration' });
  assert.throws(() => new AnthropicModel({ ...basic, apiKey: undefined }), { code: 'credential' });
  assert.throws(() => new AnthropicModel({ ...basic, apiKey: 'bad\r\nkey' }), { code: 'configuration' });
  assert.throws(() => new AnthropicModel({ ...basic, authHeader: 'other' }), { code: 'configuration' });
  for (const name of ['timeoutMs', 'maxRequestBytes', 'maxResponseBytes']) assert.throws(() => new AnthropicModel({ ...basic, [name]: 0 }), { code: 'configuration' });
});
