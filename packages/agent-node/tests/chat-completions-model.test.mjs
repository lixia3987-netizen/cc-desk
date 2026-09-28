import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChatCompletionsModel, ChatCompletionsModelError, estimateChatCompletionsInputTokens } from '../dist/chat-completions-model.js';
import { startChatCompletionsFixture, chatEvents, chatChunk, chatSse } from './fixtures/chat-completions-server.mjs';

const identity = { sessionId: 'session', conversationId: 'conversation', runId: 'run', requestId: 'request', workerGeneration: 1 };
const definitions = [{ name: 'read_file', description: 'Read a project file.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }, risk: 'read' }];
const toolCall = (id = 'call_read', name = 'read_file', args = '{"path":"测试.txt"}') => ({ id, type: 'function', function: { name, arguments: args } });
const request = (model, overrides = {}) => ({ identity, context: { protocol: model.protocol, items: model.userItems('测试 Unicode') }, tools: definitions, maxOutputTokens: 1000, signal: new AbortController().signal, onEvent: () => {}, ...overrides });
async function fixtureTest(t, result = {}, options = {}) {
  const fixture = await startChatCompletionsFixture({ handler: typeof result === 'function' ? result : () => result });
  t.after(() => fixture.close());
  const model = new ChatCompletionsModel({ model: 'fixture-model', baseURL: fixture.baseURL, allowLoopbackHttp: true, toolDefinitions: definitions, ...options });
  return { fixture, model };
}

test('fragmented UTF-8 streams retain native messages, assembled calls, usage and instructions', async t => {
  const message = { role: 'assistant', content: '中文🙂', tool_calls: [toolCall(), toolCall('second', 'read_file', '{"path":"two.txt"}')] };
  const { model, fixture } = await fixtureTest(t, { message, splitBytes: 1 }, { instructions: 'Project rules.' });
  const events = [];
  const result = await model.generate(request(model, { onEvent: event => events.push(event) }));
  assert.deepEqual(result.outputItems, [message]);
  assert.deepEqual(result.toolCalls, message.tool_calls.map(call => ({ id: call.id, name: call.function.name, arguments: call.function.arguments })));
  assert.equal(result.finishReason, 'tool_calls');
  assert.deepEqual(result.usage, { inputTokens: 11, outputTokens: 7, totalTokens: 18 });
  assert.equal(events.filter(event => event.type === 'text_delta').map(event => event.text).join(''), '中文🙂');
  assert.equal(events.filter(event => event.callId === 'call_read').map(event => event.delta).join(''), '{"path":"测试.txt"}');
  assert.deepEqual(fixture.requests[0].messages[0], { role: 'system', content: 'Project rules.' });
  assert.equal(fixture.requests[0].max_completion_tokens, 1000);
  assert.deepEqual(fixture.errors, []);
});

test('native history replays assistant calls and all result statuses after a fresh adapter', async t => {
  const seen = [];
  const { model, fixture } = await fixtureTest(t, ({ index, body }) => {
    seen.push(body.messages);
    return index === 0 ? { message: { role: 'assistant', content: null, tool_calls: [toolCall()] } } : { message: { role: 'assistant', content: 'continued' } };
  });
  let items = model.userItems('read file');
  const first = await model.generate(request(model, { context: { protocol: model.protocol, items } }));
  items.push(...first.outputItems, ...model.toolResultItems(first.toolCalls[0], { status: 'completed', output: { content: 'hello' } }));
  const restarted = new ChatCompletionsModel({ model: 'fixture-model', baseURL: fixture.baseURL, allowLoopbackHttp: true, toolDefinitions: definitions });
  items = JSON.parse(JSON.stringify(items));
  items.push(...restarted.userItems('continue'));
  const second = await restarted.generate(request(restarted, { context: { protocol: restarted.protocol, items } }));
  assert.equal(second.outputItems[0].content, 'continued');
  assert.deepEqual(seen[1], items);
  assert.equal(seen[1][1].tool_calls[0].id, 'call_read');
  for (const status of ['denied', 'cancelled', 'not_executed', 'failed']) {
    const [result] = restarted.toolResultItems(first.toolCalls[0], { status, output: 'reason' });
    assert.equal(result.role, 'tool');
    assert.equal(result.tool_call_id, 'call_read');
    assert.equal(JSON.parse(result.content).status, status);
  }
  assert.deepEqual(fixture.errors, []);
});

test('interleaved call indices preserve declared order and fragmented function names', async t => {
  const events = [
    chatChunk({ tool_calls: [{ index: 1, id: 'second', type: 'function', function: { name: 'read_', arguments: '{"path":' } }] }),
    chatChunk({ tool_calls: [{ index: 0, id: 'first', type: 'function', function: { name: 'read_file', arguments: '{}' } }] }),
    chatChunk({ tool_calls: [{ index: 1, function: { name: 'file', arguments: '"two"}' } }] }),
    chatChunk({}, 'tool_calls'), '[DONE]',
  ];
  const { model } = await fixtureTest(t, { events });
  const response = await model.generate(request(model));
  assert.deepEqual(response.toolCalls, [{ id: 'first', name: 'read_file', arguments: '{}' }, { id: 'second', name: 'read_file', arguments: '{"path":"two"}' }]);
  assert.equal(response.usage, null);
});

test('CR framing, comments, multiline JSON and passive chunk metadata are supported', async t => {
  const chunk = chatChunk({ content: 'okay' }, 'stop', { obfuscation: 'random', future_metadata: { harmless: true } });
  const raw = ': keepalive\r\n\r\nevent: message\rdata: {\rdata: ' + JSON.stringify(chunk).slice(1) + '\r\rdata: [DONE]\r\r';
  const { model } = await fixtureTest(t, { raw });
  assert.equal((await model.generate(request(model))).outputItems[0].content, 'okay');
});

test('missing or partial usage is preserved as unknown rather than estimated', async t => {
  const first = await fixtureTest(t, { usage: null });
  assert.equal((await first.model.generate(request(first.model))).usage, null);
  const second = await fixtureTest(t, { usage: { prompt_tokens: 7 } });
  assert.deepEqual((await second.model.generate(request(second.model))).usage, { inputTokens: 7 });
});

test('refusal and output limits preserve native output without enabling tool execution', async t => {
  for (const finishReason of ['content_filter', 'length']) {
    const { model } = await fixtureTest(t, { message: { role: 'assistant', content: 'partial', tool_calls: [toolCall()] }, finishReason });
    const response = await model.generate(request(model));
    assert.equal(response.finishReason, finishReason === 'length' ? 'incomplete' : 'refused');
    assert.equal(response.toolCalls.length, 1);
  }
  const { model } = await fixtureTest(t, { message: { role: 'assistant', content: '', refusal: 'cannot comply' } });
  const response = await model.generate(request(model));
  assert.equal(response.finishReason, 'refused');
  assert.equal(response.outputItems[0].refusal, 'cannot comply');
});

test('malformed argument JSON and unknown complete names are durably rejectable by core', async t => {
  const { model } = await fixtureTest(t, { message: { role: 'assistant', content: '', tool_calls: [toolCall('unknown', 'hidden_tool', '{broken')] } });
  assert.deepEqual((await model.generate(request(model))).toolCalls, [{ id: 'unknown', name: 'hidden_tool', arguments: '{broken' }]);
});

const faults = [
  ['truncated event', { raw: 'data: {"id":' }, 'interrupted'],
  ['missing DONE', { events: [chatChunk({ content: 'done' }, 'stop')] }, 'interrupted'],
  ['DONE before finish', { events: [chatChunk({ content: 'unfinished' }), '[DONE]'] }, 'interrupted'],
  ['invalid JSON', { raw: 'data: invalid\n\n' }, 'schema'],
  ['wrong event name', { raw: 'event: other\n' + chatSse(chatChunk({}, 'stop')) }, 'schema'],
  ['provider error', { events: [{ error: { message: 'secret remote error' } }] }, 'provider'],
  ['changed identity', { events: [chatChunk({}), chatChunk({}, 'stop', { id: 'changed' }), '[DONE]'] }, 'schema'],
  ['invalid object', { events: [chatChunk({}, 'stop', { object: 'chat.completion' }), '[DONE]'] }, 'schema'],
  ['wrong choice index', { events: [chatChunk({}, null, { choices: [{ index: 1, delta: {}, finish_reason: 'stop' }] }), '[DONE]'] }, 'schema'],
  ['multiple choices', { events: [chatChunk({}, null, { choices: [{ index: 0, delta: {} }, { index: 1, delta: {} }] })] }, 'schema'],
  ['nonassistant role', { events: [chatChunk({ role: 'user' }, 'stop'), '[DONE]'] }, 'schema'],
  ['nontext content', { events: [chatChunk({ content: [{ type: 'image' }] }, 'stop'), '[DONE]'] }, 'schema'],
  ['vendor reasoning extension', { events: [chatChunk({ reasoning_content: 'hidden' }, 'stop'), '[DONE]'] }, 'unsupported'],
  ['audio extension', { events: [chatChunk({ audio: { data: 'encoded' } }, 'stop'), '[DONE]'] }, 'unsupported'],
  ['legacy function call', { events: [chatChunk({ function_call: { name: 'read_file', arguments: '{}' } }, 'function_call'), '[DONE]'] }, 'unsupported'],
  ['unknown finish reason', { events: [chatChunk({}, 'future'), '[DONE]'] }, 'unsupported'],
  ['missing initial tool identity', { events: [chatChunk({ tool_calls: [{ index: 0, function: { arguments: '{}' } }] })] }, 'schema'],
  ['changed tool identity', { events: [chatChunk({ tool_calls: [{ index: 0, ...toolCall() }] }), chatChunk({ tool_calls: [{ index: 0, id: 'changed' }] })] }, 'schema'],
  ['nonfunction tool', { events: [chatChunk({ tool_calls: [{ index: 0, id: 'custom', type: 'custom', function: {} }] })] }, 'schema'],
  ['duplicate tool IDs', { message: { role: 'assistant', content: '', tool_calls: [toolCall(), toolCall()] } }, 'schema'],
  ['noncontiguous call indices', { events: [chatChunk({ tool_calls: [{ index: 1, ...toolCall() }] }, 'tool_calls'), '[DONE]'] }, 'schema'],
  ['negative call index', { events: [chatChunk({ tool_calls: [{ index: -1, ...toolCall() }] }, 'tool_calls'), '[DONE]'] }, 'schema'],
  ['too many call slots', { events: [chatChunk({ tool_calls: [{ index: 256, ...toolCall() }] }, 'tool_calls'), '[DONE]'] }, 'schema'],
  ['missing function name', { events: [chatChunk({ tool_calls: [{ index: 0, id: 'one', type: 'function', function: { arguments: '{}' } }] }, 'tool_calls'), '[DONE]'] }, 'schema'],
  ['tool calls with stop', { message: { role: 'assistant', content: '', tool_calls: [toolCall()] }, finishReason: 'stop' }, 'schema'],
  ['tool finish without calls', { finishReason: 'tool_calls' }, 'schema'],
  ['invalid usage', { usage: { prompt_tokens: -1 } }, 'schema'],
  ['premature usage', { events: [chatChunk({}, null, { choices: [], usage: { prompt_tokens: 1 } })] }, 'schema'],
  ['duplicate usage', { events: [...chatEvents().slice(0, -1), chatChunk({}, null, { choices: [], usage: { prompt_tokens: 1 } }), '[DONE]'] }, 'schema'],
  ['choice after finish', { events: [chatChunk({}, 'stop'), chatChunk({ content: 'extra' }), '[DONE]'] }, 'schema'],
  ['data after DONE', { events: [...chatEvents(), chatChunk({ content: 'extra' })] }, 'schema'],
  ['double DONE', { events: [...chatEvents(), '[DONE]'] }, 'schema'],
];
for (const [name, result, code] of faults) test(`rejects ${name} before returning executable calls`, async t => {
  const { model } = await fixtureTest(t, result);
  await assert.rejects(model.generate(request(model)), error => error instanceof ChatCompletionsModelError && error.code === code);
});

test('request and response bounds prevent oversized data and input makes no network call', async t => {
  const { model, fixture } = await fixtureTest(t, { message: { role: 'assistant', content: 'x'.repeat(1000) } }, { maxRequestBytes: 1000, maxResponseBytes: 300 });
  await assert.rejects(model.generate(request(model, { context: { protocol: model.protocol, items: model.userItems('x'.repeat(2000)) } })), { code: 'request_limit' });
  assert.equal(fixture.requests.length, 0);
  await assert.rejects(model.generate(request(model)), { code: 'response_limit' });
});

test('timeouts and cancellation abort streams without retrying', async t => {
  const { model, fixture } = await fixtureTest(t, { hang: true }, { timeoutMs: 30 });
  await assert.rejects(model.generate(request(model)), { code: 'timeout' });
  const cancellable = new ChatCompletionsModel({ baseURL: fixture.baseURL, model: 'fixture-model', allowLoopbackHttp: true, toolDefinitions: definitions });
  const controller = new AbortController();
  const task = cancellable.generate(request(cancellable, { signal: controller.signal }));
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(task, { name: 'AbortError', code: 'cancelled' });
  assert.equal(fixture.requests.length, 2);
  await assert.rejects(cancellable.generate(request(cancellable, { signal: controller.signal })), { code: 'cancelled' });
  assert.equal(fixture.requests.length, 2);
});

test('HTTP errors and redirects expose fixed status only and never follow or retry', async t => {
  for (const status of [302, 401, 429, 500]) {
    const { model, fixture } = await fixtureTest(t, { httpStatus: status, headers: { Location: '/v1/chat/completions?secret' }, raw: 'private-provider-content' });
    await assert.rejects(model.generate(request(model)), error => {
      assert.equal(error.httpStatus, status);
      assert.equal(error.code, status === 302 ? 'redirect' : 'http');
      assert.equal(error.message, `Model service returned HTTP ${status}.`);
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(fixture.requests.length, 1);
  }
});

test('non-SSE and invalid UTF-8 fail with fixed diagnostics', async t => {
  const first = await fixtureTest(t, { headers: { 'Content-Type': 'application/json' }, raw: '{}' });
  await assert.rejects(first.model.generate(request(first.model)), { code: 'schema' });
  const second = await fixtureTest(t, { raw: Buffer.from([0xff]) });
  await assert.rejects(second.model.generate(request(second.model)), { code: 'transport' });
});

test('credentials are excluded from requests, streamed text, assembled refusals and escaped arguments', async t => {
  const secret = 'sentinel-api-key';
  const { model, fixture } = await fixtureTest(t, {}, { apiKey: secret });
  await assert.rejects(model.generate(request(model, { context: { protocol: model.protocol, items: model.userItems(secret) } })), { code: 'credential_echo' });
  assert.equal(fixture.requests.length, 0);
  for (const events of [
    [chatChunk({ content: 'safe sentinel-' }), chatChunk({ content: 'api-key' }, 'stop'), '[DONE]'],
    [chatChunk({ refusal: 'sentinel-' }), chatChunk({ refusal: 'api-key' }, 'stop'), '[DONE]'],
    chatEvents({ role: 'assistant', content: '', tool_calls: [toolCall('one', 'read_file', '{"path":"sentinel-\\u0061pi-key"}')] }),
  ]) {
    const { model: unsafe } = await fixtureTest(t, { events }, { apiKey: secret });
    const visible = [];
    await assert.rejects(unsafe.generate(request(unsafe, { onEvent: event => visible.push(event) })), { code: 'credential_echo' });
    assert.ok(!JSON.stringify(visible).includes(secret));
  }
});

test('callback failures cannot expose original error text', async t => {
  const { model } = await fixtureTest(t);
  await assert.rejects(model.generate(request(model, { onEvent: () => { throw new Error('sensitive-callback'); } })), error => {
    assert.equal(error.code, 'transport');
    assert.ok(!error.message.includes('sensitive-callback'));
    assert.equal(error.cause, undefined);
    return true;
  });
});

test('protocol, version and mutable tool catalog mismatches fail before HTTP', async t => {
  const mutable = structuredClone(definitions);
  const { model, fixture } = await fixtureTest(t, {}, { toolDefinitions: mutable });
  mutable[0].description = 'mutated';
  await assert.rejects(model.generate(request(model, { tools: mutable })), { code: 'tool_catalog' });
  for (const protocol of [{ id: 'openai-responses', version: 1 }, { id: 'openai-chat-completions', version: 2 }]) {
    await assert.rejects(model.generate(request(model, { context: { protocol, items: [] } })), { code: 'protocol' });
  }
  assert.equal(fixture.requests.length, 0);
});

test('unsupported native message state and unresolved calls cannot reach the model service', async t => {
  const { model, fixture } = await fixtureTest(t);
  const invalid = [
    { items: model.userItems('hello'), continuation: { responseId: 'hidden' } },
    { items: [{ role: 'assistant', content: 'answer', reasoning_content: 'hidden' }] },
    { items: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com' } }] }] },
    { items: [{ role: 'assistant', content: null, tool_calls: [toolCall()] }] },
    { items: [{ role: 'tool', tool_call_id: 'orphan', content: '{}' }] },
    { items: [{ role: 'system', content: 'unauthorized history instruction' }] },
  ];
  for (const context of invalid) await assert.rejects(model.generate(request(model, { context: { protocol: model.protocol, ...context } })), { code: 'protocol' });
  assert.equal(fixture.requests.length, 0);
});

test('input estimate includes detached tool schemas and matches the public helper', async t => {
  const mutable = structuredClone(definitions);
  const { model } = await fixtureTest(t, {}, { toolDefinitions: mutable, instructions: 'rules' });
  const context = { protocol: model.protocol, items: model.userItems('hello') };
  const expected = estimateChatCompletionsInputTokens(context, 'rules', definitions);
  mutable[0].description = 'x'.repeat(10000);
  assert.equal(model.estimateInputTokens(context), expected);
  assert.ok(expected > estimateChatCompletionsInputTokens(context, 'rules', []));
});

test('no-tools summary requests omit tool parameters', async t => {
  const { model, fixture } = await fixtureTest(t, {}, { toolDefinitions: [] });
  await model.generate(request(model, { tools: [] }));
  assert.equal(fixture.requests[0].tools, undefined);
  assert.equal(fixture.requests[0].parallel_tool_calls, undefined);
});

test('configuration rejects insecure endpoints, embedded auth and invalid limits', () => {
  const basic = { baseURL: 'https://example.com/v1', model: 'model', apiKey: 'key' };
  for (const baseURL of ['http://example.com/v1', 'https://user:pass@example.com', 'https://example.com?key=secret', 'https://example.com/#hash', 'not-a-url']) {
    assert.throws(() => new ChatCompletionsModel({ ...basic, baseURL, allowLoopbackHttp: true }), { code: 'configuration' });
  }
  assert.throws(() => new ChatCompletionsModel({ ...basic, apiKey: undefined }), { code: 'credential' });
  assert.throws(() => new ChatCompletionsModel({ ...basic, apiKey: 'bad\r\nkey' }), { code: 'configuration' });
  for (const name of ['timeoutMs', 'maxRequestBytes', 'maxResponseBytes']) assert.throws(() => new ChatCompletionsModel({ ...basic, [name]: 0 }), { code: 'configuration' });
  assert.throws(() => new ChatCompletionsModel({ ...basic, model: '' }), { code: 'configuration' });
});
