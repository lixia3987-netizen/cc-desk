import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateProviderUsage } from '@cc-desk/agent-core';
import { ResponsesModel } from '../dist/responses-model.js';
import { ChatCompletionsModel } from '../dist/chat-completions-model.js';
import { AnthropicModel } from '../dist/anthropic-model.js';
import { startResponsesFixture, responseEvents } from './fixtures/responses-server.mjs';
import { startChatCompletionsFixture, chatEvents } from './fixtures/chat-completions-server.mjs';
import { startAnthropicFixture, anthropicEvents } from './fixtures/anthropic-server.mjs';

const identity = { sessionId: 'session', conversationId: 'conversation', runId: 'run', requestId: 'request', workerGeneration: 1 };
const definitions = [{ name: 'read_file', description: 'Read project evidence.', inputSchema: { type: 'object', properties: { path: { type: 'string' } } }, risk: 'read' }];
const cases = [
  { name: 'responses', Model: ResponsesModel, fixture: startResponsesFixture, input: 'input_tokens', output: 'output_tokens' },
  { name: 'chat', Model: ChatCompletionsModel, fixture: startChatCompletionsFixture, input: 'prompt_tokens', output: 'completion_tokens' },
  { name: 'anthropic', Model: AnthropicModel, fixture: startAnthropicFixture },
];
const request = (model, options = {}) => ({ identity, context: { protocol: model.protocol, items: model.userItems('prompt-sentinel-中文🙂') }, tools: definitions,
  maxOutputTokens: 1000, signal: new AbortController().signal, onEvent: () => {}, ...options });
async function fixtureTest(t, scenario, result = {}, modelOptions = {}) {
  const fixture = await scenario.fixture({ handler: typeof result === 'function' ? result : () => result });
  t.after(() => fixture.close());
  const model = new scenario.Model({ model: 'fixture-model', baseURL: fixture.baseURL, allowLoopbackHttp: true, toolDefinitions: definitions, ...modelOptions });
  return { model, fixture };
}

for (const scenario of cases.slice(0, 2)) {
  test(`${scenario.name} input includes cached tokens and preserves provider detail counters`, async t => {
    const usage = { [scenario.input]: 100, [scenario.output]: 20, total_tokens: 120,
      [`${scenario.input}_details`]: { cached_tokens: 60, cache_write_tokens: 10, audio_tokens: 2 },
      [`${scenario.output}_details`]: { reasoning_tokens: 8, audio_tokens: 3, accepted_prediction_tokens: 4, rejected_prediction_tokens: 1 } };
    const { model } = await fixtureTest(t, scenario, { output: [], usage });
    const response = await model.generate(request(model));
    assert.deepEqual(response.usage, { inputTokens: 100, outputTokens: 20, totalTokens: 120, cacheReadInputTokens: 60, cacheCreationInputTokens: 10, nonCachedInputTokens: 30 });
    assert.deepEqual(response.providerUsage, { normalization: 'openai-inclusive-input', raw: { [scenario.input]: 100, [scenario.output]: 20, total_tokens: 120,
      cached_tokens: 60, cache_write_tokens: 10, input_audio_tokens: 2, output_audio_tokens: 3, reasoning_tokens: 8, accepted_prediction_tokens: 4, rejected_prediction_tokens: 1 } });
    assert.equal(validateProviderUsage(response.providerUsage), true);
  });
  test(`${scenario.name} explicit cache zero differs from missing cache`, async t => {
    for (const cached of [undefined, 0]) {
      const { model } = await fixtureTest(t, scenario, { output: [], usage: { [scenario.input]: 9,
        ...(cached === undefined ? {} : { [`${scenario.input}_details`]: { cached_tokens: cached, cache_write_tokens: 0 } }) } });
      const response = await model.generate(request(model));
      assert.equal(response.usage.inputTokens, 9);
      assert.equal(response.usage.cacheReadInputTokens, cached ?? null);
      assert.equal(response.usage.nonCachedInputTokens, cached === undefined ? null : 9);
      assert.equal(response.usage.cacheCreationInputTokens, cached === undefined ? null : 0);
      assert.equal(Object.hasOwn(response.providerUsage.raw, 'cache_write_tokens'), cached !== undefined);
      assert.equal(response.usage.totalTokens, undefined);
    }
  });
  test(`${scenario.name} missing read or write count keeps ordinary input unknown`, async t => {
    for (const details of [{ cached_tokens: 5 }, { cache_write_tokens: 4 }]) {
      const { model } = await fixtureTest(t, scenario, { output: [], usage: { [scenario.input]: 9, [`${scenario.input}_details`]: details } });
      const response = await model.generate(request(model));
      assert.equal(response.usage.inputTokens, 9);
      assert.equal(response.usage.cacheReadInputTokens, details.cached_tokens ?? null);
      assert.equal(response.usage.cacheCreationInputTokens, details.cache_write_tokens ?? null);
      assert.equal(response.usage.nonCachedInputTokens, null);
    }
  });
  for (const cached_tokens of [-1, 0.5, 101, '1']) test(`${scenario.name} rejects invalid nested cache count ${cached_tokens}`, async t => {
    const { model } = await fixtureTest(t, scenario, { output: [], usage: { [scenario.input]: 100, [`${scenario.input}_details`]: { cached_tokens } } });
    await assert.rejects(model.generate(request(model)), error => error.code === 'schema' && model.classifyError(error).reason === 'invalid_usage');
  });
  for (const details of [{ cached_tokens: 60, cache_write_tokens: 41 }, { cache_write_tokens: -1 }, { cache_write_tokens: 0.5 }, { cache_write_tokens: '1' },
    { cached_tokens: Number.MAX_SAFE_INTEGER, cache_write_tokens: 1 }]) test(`${scenario.name} rejects invalid cache write or overlapping read/write subsets ${JSON.stringify(details)}`, async t => {
    const { model } = await fixtureTest(t, scenario, { output: [], usage: { [scenario.input]: 100, [`${scenario.input}_details`]: details } });
    await assert.rejects(model.generate(request(model)), error => error.code === 'schema' && model.classifyError(error).reason === 'invalid_usage');
  });
}

test('Anthropic complete input sums non-cached, read and creation once and preserves cache duration counts', async t => {
  const startUsage = { input_tokens: 4, output_tokens: 1, cache_read_input_tokens: 60, cache_creation_input_tokens: 6,
    cache_creation: { ephemeral_5m_input_tokens: 2, ephemeral_1h_input_tokens: 4 } };
  const { model } = await fixtureTest(t, cases[2], { startMessage: { usage: startUsage }, usage: { output_tokens: 20 } });
  const response = await model.generate(request(model));
  assert.deepEqual(response.usage, { inputTokens: 70, outputTokens: 20, totalTokens: 90, nonCachedInputTokens: 4, cacheReadInputTokens: 60, cacheCreationInputTokens: 6 });
  assert.deepEqual(response.providerUsage, { normalization: 'anthropic-input-plus-cache', raw: { input_tokens: 4, output_tokens: 20,
    cache_read_input_tokens: 60, cache_creation_input_tokens: 6, cache_creation_5m_input_tokens: 2, cache_creation_1h_input_tokens: 4 } });
  assert.equal(validateProviderUsage(response.providerUsage), true);
});

test('Anthropic missing cache remains unknown and cannot masquerade as complete input', async t => {
  for (const cache of [{}, { cache_read_input_tokens: 0 }, { cache_creation_input_tokens: 0 }]) {
    const { model } = await fixtureTest(t, cases[2], { startMessage: { usage: { input_tokens: 4, output_tokens: 1, ...cache } }, usage: { output_tokens: 20 } });
    const response = await model.generate(request(model));
    assert.equal(response.usage.inputTokens, undefined);
    assert.equal(response.usage.totalTokens, undefined);
    assert.equal(response.usage.nonCachedInputTokens, 4);
    assert.equal(response.usage.cacheReadInputTokens, cache.cache_read_input_tokens ?? null);
    assert.equal(response.usage.cacheCreationInputTokens, cache.cache_creation_input_tokens ?? null);
    assert.equal(response.usage.outputTokens, 20);
  }
});

for (const scenario of cases) {
  test(`${scenario.name} actual HTTP fixture keeps context alias k3[1M] in wire and diagnostic metadata`, async t => {
    const { model, fixture } = await fixtureTest(t, scenario, { output: [] }, { model: 'k3[1M]' });
    const diagnostics = [];
    await model.generate(request(model, { onRequestDiagnostic: value => { diagnostics.push(value); } }));
    assert.equal(fixture.requests.length, 1);
    assert.equal(fixture.requests[0].model, 'k3[1M]');
    assert.deepEqual(diagnostics.map(value => value.phase), ['request', 'dispatched', 'result']);
    assert.ok(diagnostics.every(value => value.model === 'k3[1M]'));
  });

  test(`${scenario.name} diagnostics match sent UTF-8 payload and wait for persistence without exposing content`, async t => {
    let persisted = false;
    const { model, fixture } = await fixtureTest(t, scenario, () => {
      assert.equal(persisted, true);
      return { output: [] };
    }, { instructions: 'instruction-sentinel-规则🙂', apiKey: 'credential-sentinel-12345678' });
    const image = { mimeType: 'image/png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' };
    const diagnostics = [];
    const context = { protocol: model.protocol, items: model.userItems('prompt-sentinel-中文🙂', [image]),
      ...(scenario.name === 'responses' ? { continuation: { opaque: 'continuation-sentinel' } } : {}) };
    const response = await model.generate(request(model, { context,
      diagnosticInstructionSections: { systemPrompt: 'system-sentinel-基础规则🙂', permissions: 'permissions-sentinel-只读', projectRules: '', skills: 'skills-sentinel' },
      onRequestDiagnostic: async diagnostic => {
        diagnostics.push(diagnostic);
        if (diagnostic.phase === 'request') {
          assert.equal(fixture.requests.length, 0);
          await new Promise(resolve => setImmediate(resolve));
          persisted = true;
        }
      } }));
    assert.deepEqual(diagnostics.map(value => value.phase), ['request', 'dispatched', 'result']);
    const [sent, dispatched, result] = diagnostics, body = JSON.stringify(fixture.requests[0]);
    assert.equal(dispatched.model, 'fixture-model');
    assert.equal(sent.payloadBytes, Buffer.byteLength(body, 'utf8'));
    assert.equal(sent.payloadDigest, createHash('sha256').update(body).digest('hex'));
    assert.equal(Object.values(sent.components).filter(value => value.accounting === 'serialized').reduce((sum, value) => sum + value.bytes, 0), sent.payloadBytes);
    assert.equal(sent.components.history.accounting, 'serialized');
    assert.equal(sent.components.instructions.accounting, 'serialized');
    assert.equal(sent.components.images.accounting, 'logical');
    if (scenario.name === 'responses') assert.equal(sent.components.continuation.accounting, 'logical');
    assert.equal(sent.components.systemPrompt.accounting, 'logical');
    assert.equal(sent.components.permissions.bytes, Buffer.byteLength('permissions-sentinel-只读', 'utf8'));
    assert.equal(sent.components.projectRules.bytes, 0);
    assert.equal(sent.components.skills.accounting, 'logical');
    assert.equal(sent.components.userInput.count, 1);
    assert.equal(sent.model, 'fixture-model');
    assert.equal(result.model, 'fixture-model');
    assert.equal(result.result, 'completed');
    assert.deepEqual(result.providerUsage, response.providerUsage);
    assert.ok(result.elapsedMs >= 0 && Number.isFinite(result.elapsedMs));
    assert.ok(result.finishedAt >= result.startedAt);
    assert.doesNotMatch(JSON.stringify(diagnostics), /prompt-sentinel|instruction-sentinel|credential-sentinel|continuation-sentinel|system-sentinel|permissions-sentinel|skills-sentinel|iVBORw0KGgo/);
    assert.deepEqual(fixture.errors, []);
    const estimate = model.estimateInputUsage(context, 1000);
    assert.equal(estimate.serializedBytes, sent.payloadBytes);
    assert.ok(estimate.estimatedInputTokens >= model.estimateInputTokens(context));
    assert.equal(estimate.method, 'utf8_bytes');
    assert.equal(estimate.source, 'fallback');
    assert.equal(estimate.model, 'fixture-model');
  });

  test(`${scenario.name} request persistence rejection prevents network and preserves the original error`, async t => {
    const { model, fixture } = await fixtureTest(t, scenario, { output: [] });
    const persistenceFailure = new Error('persistence failed'), phases = [];
    await assert.rejects(model.generate(request(model, { onRequestDiagnostic: diagnostic => {
      phases.push(diagnostic.phase);
      if (diagnostic.phase === 'request') throw persistenceFailure;
    } })), error => error === persistenceFailure);
    assert.equal(fixture.requests.length, 0);
    assert.deepEqual(phases, ['request', 'result']);
  });

  test(`${scenario.name} result persistence rejection is never rewritten as a transport error`, async t => {
    const { model, fixture } = await fixtureTest(t, scenario, { output: [] });
    const persistenceFailure = new Error('persistence failed');
    await assert.rejects(model.generate(request(model, { onRequestDiagnostic: diagnostic => {
      if (diagnostic.phase === 'result') throw persistenceFailure;
    } })), error => error === persistenceFailure);
    assert.equal(fixture.requests.length, 1);
  });

  test(`${scenario.name} rejected HTTP attempts still emit finite failure and elapsed diagnostics`, async t => {
    const { model } = await fixtureTest(t, scenario, { httpStatus: 429, raw: 'provider-body-sentinel' });
    const diagnostics = [];
    await assert.rejects(model.generate(request(model, { onRequestDiagnostic: value => { diagnostics.push(value); } })), { httpStatus: 429 });
    assert.deepEqual(diagnostics.map(value => value.phase), ['request', 'dispatched', 'result']);
    assert.equal(diagnostics[2].result, 'failed');
    assert.equal(diagnostics[2].failure.category, 'rate_limit');
    assert.equal(diagnostics[2].failure.retryable, true);
    assert.equal(diagnostics[2].providerUsage, null);
    assert.ok(diagnostics[2].elapsedMs >= 0);
    assert.doesNotMatch(JSON.stringify(diagnostics), /provider-body-sentinel/);
  });
}

test('failed streams retain already validated raw usage counters in the result diagnostic', async t => {
  const scenarios = [
    [cases[0], { events: [...responseEvents([], { usage: { input_tokens: 9 } }), { type: 'response.created', response: { id: 'unexpected' } }] }, { input_tokens: 9 }],
    [cases[1], { events: chatEvents(undefined, { usage: { prompt_tokens: 9 } }).slice(0, -1) }, { prompt_tokens: 9 }],
    [cases[2], { events: anthropicEvents().slice(0, -1) }, { input_tokens: 11, output_tokens: 7 }],
  ];
  for (const [scenario, result, raw] of scenarios) {
    const { model } = await fixtureTest(t, scenario, result), diagnostics = [];
    await assert.rejects(model.generate(request(model, { onRequestDiagnostic: value => { diagnostics.push(value); } })));
    assert.deepEqual(diagnostics.at(-1).providerUsage.raw, raw);
    assert.equal(diagnostics.at(-1).result, 'failed');
  }
});
