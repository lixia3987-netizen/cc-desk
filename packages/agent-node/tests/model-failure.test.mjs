import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateModelFailureDiagnostic } from '@cc-desk/agent-core';
import { ResponsesModel, ResponsesModelError } from '../dist/responses-model.js';
import { ChatCompletionsModel, ChatCompletionsModelError } from '../dist/chat-completions-model.js';
import { startResponsesFixture, assistantMessage } from './fixtures/responses-server.mjs';
import { startChatCompletionsFixture, chatChunk } from './fixtures/chat-completions-server.mjs';

const identity = { sessionId: 'session', conversationId: 'conversation', runId: 'run', requestId: 'request', workerGeneration: 1 };
const request = (model, overrides = {}) => ({ identity, context: { protocol: model.protocol, items: model.userItems('hello') }, tools: [], maxOutputTokens: 100, signal: new AbortController().signal, onEvent: () => {}, ...overrides });
const protocols = [
  { name: 'Responses', Model: ResponsesModel, ModelError: ResponsesModelError, fixture: startResponsesFixture, complete: { output: [assistantMessage('done', 'complete')] }, partial: { events: [{ type: 'response.output_text.delta', delta: 'partial' }] } },
  { name: 'ChatCompletions', Model: ChatCompletionsModel, ModelError: ChatCompletionsModelError, fixture: startChatCompletionsFixture, complete: { message: { role: 'assistant', content: 'complete' } }, partial: { events: [chatChunk({ content: 'partial' })] } },
];
const caught = async task => { try { await task; assert.fail('Expected model failure.'); } catch (error) { return error; } };
const categoryDiagnostic = (model, error) => {
  const value = model.classifyError(error);
  assert.equal(validateModelFailureDiagnostic(value), true);
  const { protocol, stage, reason, ...classification } = value;
  return classification;
};

for (const protocol of protocols) {
  const fixtureModel = async (t, result, options = {}) => {
    const fixture = await protocol.fixture({ handler: () => result, assertReplay: false });
    t.after(() => fixture.close());
    return { fixture, model: new protocol.Model({ baseURL: fixture.baseURL, model: 'fixture-model', allowLoopbackHttp: true, ...options }) };
  };

  test(`${protocol.name} diagnoses actual HTTP rejections and only marks safe statuses as retry candidates`, async t => {
    const sentinel = 'private-provider-body-key-header-url';
    const matrix = [
      [302, 'protocol'], [307, 'protocol'], [400, 'configuration'], [401, 'authentication'],
      [403, 'authentication'], [404, 'configuration'], [408, 'configuration'], [409, 'configuration'],
      [413, 'configuration'], [422, 'configuration'], [429, 'rate_limit'], [500, 'service_error'],
      [501, 'service_error'], [502, 'service_unavailable'], [503, 'service_unavailable'],
      [504, 'service_unavailable'], [505, 'service_error'],
    ];
    for (const [httpStatus, category] of matrix) {
      const { model, fixture } = await fixtureModel(t, { httpStatus, raw: sentinel, headers: { Location: `https://example.invalid/${sentinel}`, 'X-Diagnostic': sentinel, 'Retry-After': sentinel } }, { apiKey: sentinel });
      const visible = [];
      const error = await caught(model.generate(request(model, { onEvent: event => visible.push(event) })));
      const diagnosis = categoryDiagnostic(model, error);
      assert.deepEqual(diagnosis, { category, httpStatus, retryable: [429, 502, 503, 504].includes(httpStatus) });
      assert.equal(fixture.requests.length, 1, 'classification never sends a retry');
      assert.deepEqual(visible, []);
      assert.ok(!JSON.stringify(diagnosis).includes(sentinel));
      assert.equal(error.cause, undefined);
    }
  });

  test(`${protocol.name} rejects forged retry metadata and never inspects arbitrary error text`, () => {
    const model = new protocol.Model({ baseURL: 'http://127.0.0.1/v1', model: 'fixture-model', allowLoopbackHttp: true });
    const arbitrary = { code: 'http', httpStatus: 429, retryable: true, get message() { throw new Error('must not read unknown messages'); } };
    assert.deepEqual(categoryDiagnostic(model, arbitrary), { category: 'unknown', retryable: false });
    assert.deepEqual(categoryDiagnostic(model, new Error('secret-error-body')), { category: 'unknown', retryable: false });
    assert.deepEqual(categoryDiagnostic(model, new protocol.ModelError('http', 'secret-error-body', 429)), { category: 'rate_limit', httpStatus: 429, retryable: false });
    assert.deepEqual(categoryDiagnostic(model, new protocol.ModelError('http', 'secret-error-body', 999)), { category: 'unknown', retryable: false });
    const foreign = protocol.Model === ResponsesModel ? ChatCompletionsModelError : ResponsesModelError;
    assert.deepEqual(categoryDiagnostic(model, new foreign('http', 'secret-error-body', 503)), { category: 'unknown', retryable: false });
  });

  test(`${protocol.name} classifies preflight credential, configuration and protocol failures without a network request`, async t => {
    const { model, fixture } = await fixtureModel(t, protocol.complete, { apiKey: 'private-test-credential', maxRequestBytes: 1000 });
    const cases = [
      [{ maxOutputTokens: 0 }, 'configuration'],
      [{ context: { protocol: { id: 'unsupported', version: 1 }, items: [] } }, 'protocol'],
      [{ context: { protocol: model.protocol, items: model.userItems('private-test-credential') } }, 'security'],
      [{ context: { protocol: model.protocol, items: model.userItems('x'.repeat(2000)) } }, 'configuration'],
    ];
    for (const [overrides, category] of cases) {
      const error = await caught(model.generate(request(model, overrides)));
      assert.deepEqual(categoryDiagnostic(model, error), { category, retryable: false });
    }
    for (const [options, category] of [[{ baseURL: 'https://example.invalid/v1' }, 'authentication'], [{ baseURL: 'http://remote.invalid/v1' }, 'configuration']]) {
      let error;
      try { new protocol.Model({ model: 'fixture-model', ...options }); } catch (failure) { error = failure; }
      assert.deepEqual(categoryDiagnostic(model, error), { category, retryable: false });
    }
    assert.equal(fixture.requests.length, 0);
  });

  test(`${protocol.name} partial, malformed, provider and non-SSE responses cannot become retry candidates`, async t => {
    for (const result of [protocol.partial, { raw: 'data: invalid\n\n' }, { headers: { 'Content-Type': 'application/json' }, raw: '{}' }]) {
      const { model, fixture } = await fixtureModel(t, result);
      const error = await caught(model.generate(request(model)));
      assert.deepEqual(categoryDiagnostic(model, error), { category: 'protocol', retryable: false });
      assert.equal(fixture.requests.length, 1);
    }
    const { model, fixture } = await fixtureModel(t, { events: [protocol.Model === ResponsesModel ? { type: 'error', code: 503, message: 'private' } : { error: { code: 503, message: 'private' } }] });
    assert.deepEqual(categoryDiagnostic(model, await caught(model.generate(request(model)))), { category: 'service_error', retryable: false });
    assert.equal(fixture.requests.length, 1);
  });

  test(`${protocol.name} timeout, cancellation, network failure and invalid UTF-8 remain nonretryable`, async t => {
    const timeout = await fixtureModel(t, { hang: true }, { timeoutMs: 100 });
    assert.deepEqual(categoryDiagnostic(timeout.model, await caught(timeout.model.generate(request(timeout.model)))), { category: 'timeout', retryable: false });
    assert.equal(timeout.fixture.requests.length, 1);
    const controller = new AbortController();
    controller.abort('private-cancel-reason');
    assert.deepEqual(categoryDiagnostic(timeout.model, await caught(timeout.model.generate(request(timeout.model, { signal: controller.signal })))), { category: 'unknown', retryable: false });
    assert.equal(timeout.fixture.requests.length, 1);
    const malformed = await fixtureModel(t, { raw: Buffer.from([0xff]) });
    assert.deepEqual(categoryDiagnostic(malformed.model, await caught(malformed.model.generate(request(malformed.model)))), { category: 'network', retryable: false });
    assert.equal(malformed.fixture.requests.length, 1);
    const closedFixture = await protocol.fixture();
    await closedFixture.close();
    const disconnected = new protocol.Model({ baseURL: closedFixture.baseURL, model: 'fixture-model', allowLoopbackHttp: true });
    assert.deepEqual(categoryDiagnostic(disconnected, await caught(disconnected.generate(request(disconnected)))), { category: 'network', retryable: false });
    assert.equal(closedFixture.requests.length, 0);
  });

  test(`${protocol.name} callback errors cannot reuse an earlier HTTP retry permission or expose their text`, async t => {
    const rejection = await fixtureModel(t, { httpStatus: 503, raw: 'private-provider-error' });
    const previousError = await caught(rejection.model.generate(request(rejection.model)));
    assert.equal(categoryDiagnostic(rejection.model, previousError).retryable, true);
    const { model, fixture } = await fixtureModel(t, protocol.complete);
    for (const callbackError of [previousError, new protocol.ModelError('http', 'private-callback-error', 429)]) {
      const error = await caught(model.generate(request(model, { onEvent: () => { throw callbackError; } })));
      assert.deepEqual(categoryDiagnostic(model, error), { category: 'network', retryable: false });
      assert.ok(!error.message.includes('private'));
      assert.equal(error.cause, undefined);
    }
    assert.equal(fixture.requests.length, 2);
  });
}
