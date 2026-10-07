import test from 'node:test';
import assert from 'node:assert/strict';
import { validateModelFailureDiagnostic } from '@cc-desk/agent-core';
import { ResponsesModel } from '../dist/responses-model.js';
import { ChatCompletionsModel } from '../dist/chat-completions-model.js';
import { AnthropicModel } from '../dist/anthropic-model.js';
import { startResponsesFixture } from './fixtures/responses-server.mjs';
import { startChatCompletionsFixture, chatChunk } from './fixtures/chat-completions-server.mjs';
import { startAnthropicFixture, messageStart, blockStart, blockDelta, blockStop } from './fixtures/anthropic-server.mjs';

const protocols = [
  { id: 'openai-responses', Model: ResponsesModel, fixture: startResponsesFixture, partial: [{ type: 'response.output_text.delta', delta: 'private-response-text' }],
    toolPartial: [{ type: 'response.output_item.added', output_index: 0, item: { id: 'item', type: 'function_call', call_id: 'call' } }, { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'item', delta: '{"path":' }],
    invalidTool: [{ type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'absent', delta: 'private-tool-argument' }] },
  { id: 'openai-chat-completions', Model: ChatCompletionsModel, fixture: startChatCompletionsFixture, partial: [chatChunk({ content: 'private-response-text' })],
    toolPartial: [chatChunk({ tool_calls: [{ index: 0, id: 'call', type: 'function', function: { name: 'read_file', arguments: '{"path":' } }] })],
    invalidTool: [chatChunk({ tool_calls: [{ index: 0, type: 'function', function: { arguments: 'private-tool-argument' } }] })] },
  { id: 'anthropic-messages', Model: AnthropicModel, fixture: startAnthropicFixture,
    partial: [messageStart(), blockStart({ type: 'text', text: 'private-response-text' }), blockStop()],
    toolPartial: [messageStart(), blockStart({ type: 'tool_use', id: 'call', name: 'read_file', input: {} }), blockDelta({ type: 'input_json_delta', partial_json: '{"path":' })],
    invalidTool: [messageStart(), blockStart({ type: 'tool_use', id: 'call', name: 'read_file', input: {} }), blockDelta({ type: 'input_json_delta', partial_json: 'private-tool-argument' }), blockStop()] },
];
const identity = { sessionId: 'session', conversationId: 'conversation', runId: 'run', requestId: 'request', workerGeneration: 1 };
const request = model => ({ identity, context: { protocol: model.protocol, items: model.userItems('diagnose locally') }, tools: [], maxOutputTokens: 100,
  signal: new AbortController().signal, onEvent: () => {} });
async function setup(t, protocol, result) {
  const fixture = await protocol.fixture({ handler: () => result, assertReplay: false });
  t.after(() => fixture.close());
  return { fixture, model: new protocol.Model({ baseURL: fixture.baseURL, model: 'fixture-model', allowLoopbackHttp: true }) };
}
async function diagnose(model, overrides = {}) {
  let failure;
  try { await model.generate({ ...request(model), ...overrides }); }
  catch (error) { failure = error; }
  assert.ok(failure, 'strict validation still stops the response');
  const diagnostic = model.classifyError(failure);
  assert.equal(validateModelFailureDiagnostic(diagnostic), true);
  assert.doesNotMatch(JSON.stringify(diagnostic), /private|https?:|\/v1|fixture-model/);
  assert.equal(failure.cause, undefined);
  return diagnostic;
}
for (const protocol of protocols) {
  test(`${protocol.id} records exact safe reasons at preflight, response headers and malformed events`, async t => {
    const mismatch = await setup(t, protocol, {});
    assert.deepEqual(await diagnose(mismatch.model, { context: { protocol: { id: 'foreign', version: 1 }, items: [] } }), {
      category: 'protocol', retryable: false, protocol: protocol.id, stage: 'request', reason: 'protocol_mismatch',
    });
    assert.equal(mismatch.fixture.requests.length, 0);
    for (const [result, stage, reason] of [
      [{ headers: { 'Content-Type': 'application/json' }, raw: '{"private":"body"}' }, 'response_headers', 'unexpected_content_type'],
      [{ raw: 'data: private-invalid-json\n\n' }, 'message_start', 'invalid_json'],
      [{ raw: 'data: {"private":"truncated"}' }, 'message_start', 'truncated_event'],
    ]) {
      const { model, fixture } = await setup(t, protocol, result);
      assert.deepEqual(await diagnose(model), { category: 'protocol', retryable: false, protocol: protocol.id, stage, reason });
      assert.equal(fixture.requests.length, 1, 'diagnostic never probes, retries or changes protocol');
      assert.deepEqual(fixture.errors, []);
    }
  });
  test(`${protocol.id} distinguishes missing terminal and invalid tool continuation from a complete response`, async t => {
    for (const [events, stage, reason] of [[protocol.partial, 'content', 'missing_terminal'], [protocol.invalidTool, 'tool_call', 'invalid_tool_call']]) {
      const { model, fixture } = await setup(t, protocol, { events });
      assert.deepEqual(await diagnose(model), { category: 'protocol', retryable: false, protocol: protocol.id, stage, reason });
      assert.equal(fixture.requests.length, 1); assert.deepEqual(fixture.errors, []);
    }
  });
  test(`${protocol.id} socket loss during tool input stays a nonretryable tool-stage network failure`, async t => {
    const { model, fixture } = await setup(t, protocol, { events: protocol.toolPartial, splitBytes: 1, disconnect: true });
    assert.deepEqual(await diagnose(model), { category: 'network', retryable: false, protocol: protocol.id, stage: 'tool_call', reason: 'stream_disconnected' });
    assert.equal(fixture.requests.length, 1); assert.deepEqual(fixture.errors, []);
  });
}

test('Anthropic thinking and signature validation exposes only a bounded thinking-stage reason', async t => {
  const protocol = protocols[2];
  for (const events of [
    [messageStart(), blockStart({ type: 'thinking', thinking: 'private-thinking', signature: 42 })],
    [messageStart(), blockStart({ type: 'thinking', thinking: '' }), blockDelta({ type: 'signature_delta', signature: 'private-signature' }), blockDelta({ type: 'thinking_delta', thinking: 'private-late-thinking' })],
  ]) {
    const { model, fixture } = await setup(t, protocol, { events });
    assert.deepEqual(await diagnose(model), { category: 'protocol', retryable: false, protocol: protocol.id, stage: 'thinking', reason: 'invalid_thinking' });
    assert.equal(fixture.requests.length, 1); assert.deepEqual(fixture.errors, []);
  }
});

for (const protocol of protocols.slice(1)) test(`${protocol.id} unclosed saved tool calls are rejected before sending`, async t => {
  const { model, fixture } = await setup(t, protocol, {});
  const history = protocol.id === 'anthropic-messages'
    ? [{ role: 'assistant', content: [{ type: 'tool_use', id: 'call', name: 'read_file', input: {} }] }]
    : [{ role: 'assistant', content: null, tool_calls: [{ id: 'call', type: 'function', function: { name: 'read_file', arguments: '{}' } }] }];
  assert.deepEqual(await diagnose(model, { context: { protocol: model.protocol, items: [...model.userItems('original'), ...history] } }), {
    category: 'protocol', retryable: false, protocol: protocol.id, stage: 'request', reason: 'pending_tool_calls',
  });
  assert.equal(fixture.requests.length, 0);
});
