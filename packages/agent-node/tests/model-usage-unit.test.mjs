import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { runAgent, validateModelRequestDiagnostic, validateProviderUsage } from '@cc-desk/agent-core';
import { normalizeOpenAIUsage, anthropicRawUsage, normalizeAnthropicUsage } from '../dist/model-usage.js';
import { ResponsesModel } from '../dist/responses-model.js';
import { ChatCompletionsModel } from '../dist/chat-completions-model.js';
import { AnthropicModel } from '../dist/anthropic-model.js';
import { responseEvents, sse } from './fixtures/responses-server.mjs';
import { chatEvents, chatSse } from './fixtures/chat-completions-server.mjs';
import { anthropicEvents, anthropicSse } from './fixtures/anthropic-server.mjs';

const identity = { sessionId: 'session', conversationId: 'conversation', runId: 'run', requestId: 'request', workerGeneration: 1 };
const definitions = [{ name: 'read_file', description: 'Read evidence.', inputSchema: { type: 'object' }, risk: 'read' }];
const request = (model, overrides = {}) => ({ identity, context: { protocol: model.protocol, items: model.userItems('private-input-中文🙂') }, tools: definitions,
  maxOutputTokens: 100, signal: new AbortController().signal, onEvent: () => {}, ...overrides });

for (const [protocol, inputName, outputName] of [['responses', 'input_tokens', 'output_tokens'], ['chat', 'prompt_tokens', 'completion_tokens']]) {
  test(`${protocol} pure normalization preserves inclusive input, explicit cache writes and unknown counters`, () => {
    const normalized = normalizeOpenAIUsage({ [inputName]: 100, [outputName]: 20, total_tokens: 120,
      [`${inputName}_details`]: { cached_tokens: 60, cache_write_tokens: 10, audio_tokens: 2 },
      [`${outputName}_details`]: { reasoning_tokens: 8, audio_tokens: 3 } }, protocol);
    assert.deepEqual(normalized.usage, { inputTokens: 100, outputTokens: 20, totalTokens: 120, cacheReadInputTokens: 60, cacheCreationInputTokens: 10, nonCachedInputTokens: 30 });
    assert.deepEqual(normalized.providerUsage.raw, { [inputName]: 100, [outputName]: 20, total_tokens: 120,
      cached_tokens: 60, cache_write_tokens: 10, input_audio_tokens: 2, output_audio_tokens: 3, reasoning_tokens: 8 });
    assert.equal(validateProviderUsage(normalized.providerUsage), true);
    for (const details of [undefined, { cached_tokens: 0 }, { cache_write_tokens: 0 }]) {
      const result = normalizeOpenAIUsage({ [inputName]: 9, ...(details ? { [`${inputName}_details`]: details } : {}) }, protocol);
      assert.equal(result.usage.nonCachedInputTokens, null);
      assert.equal(result.usage.cacheReadInputTokens, details?.cached_tokens ?? null);
      assert.equal(result.usage.cacheCreationInputTokens, details?.cache_write_tokens ?? null);
    }
    assert.equal(normalizeOpenAIUsage({ [inputName]: 9, [`${inputName}_details`]: { cached_tokens: 0, cache_write_tokens: 0 } }, protocol).usage.nonCachedInputTokens, 9);
    assert.deepEqual(normalizeOpenAIUsage(null, protocol), { usage: null, providerUsage: null });
  });
  test(`${protocol} pure normalization rejects invalid read/write counts and overlapping subsets`, () => {
    for (const details of [{ cached_tokens: -1 }, { cached_tokens: 0.5 }, { cached_tokens: '1' }, { cached_tokens: 101 },
      { cache_write_tokens: -1 }, { cache_write_tokens: 0.5 }, { cache_write_tokens: '1' }, { cached_tokens: 60, cache_write_tokens: 41 },
      { cached_tokens: Number.MAX_SAFE_INTEGER, cache_write_tokens: 1 }]) {
      assert.throws(() => normalizeOpenAIUsage({ [inputName]: 100, [`${inputName}_details`]: details }, protocol));
    }
  });
  test(`${protocol} inconsistent reported totals remain raw while matching totals normalize`, () => {
    for (const total of [1, 25, undefined]) {
      const result = normalizeOpenAIUsage({ [inputName]: 20, [outputName]: 5,
        ...(total === undefined ? {} : { total_tokens: total }), [`${inputName}_details`]: { cached_tokens: 0, cache_write_tokens: 0 } }, protocol);
      assert.equal(result.usage.totalTokens, total === 25 ? 25 : undefined);
      assert.equal(result.providerUsage.raw.total_tokens, total);
      assert.equal(result.usage.inputTokens, 20);
      assert.equal(result.usage.outputTokens, 5);
      assert.equal(result.usage.cacheReadInputTokens, 0);
      assert.equal(result.usage.cacheCreationInputTokens, 0);
      assert.equal(result.usage.nonCachedInputTokens, 20);
    }
  });
}

test('Anthropic pure normalization requires complete input counters and preserves duration counts', () => {
  const raw = anthropicRawUsage({ input_tokens: 4, output_tokens: 20, cache_read_input_tokens: 60, cache_creation_input_tokens: 6,
    cache_creation: { ephemeral_5m_input_tokens: 2, ephemeral_1h_input_tokens: 4 } });
  const result = normalizeAnthropicUsage(raw);
  assert.deepEqual(result.usage, { inputTokens: 70, outputTokens: 20, totalTokens: 90, nonCachedInputTokens: 4, cacheReadInputTokens: 60, cacheCreationInputTokens: 6 });
  assert.deepEqual(result.providerUsage.raw, { input_tokens: 4, output_tokens: 20, cache_read_input_tokens: 60, cache_creation_input_tokens: 6,
    cache_creation_5m_input_tokens: 2, cache_creation_1h_input_tokens: 4 });
  assert.equal(validateProviderUsage(result.providerUsage), true);
  for (const cache of [{}, { cache_read_input_tokens: 0 }, { cache_creation_input_tokens: 0 }]) {
    const partial = normalizeAnthropicUsage(anthropicRawUsage({ input_tokens: 4, output_tokens: 20, ...cache }));
    assert.equal(partial.usage.inputTokens, undefined);
    assert.equal(partial.usage.totalTokens, undefined);
    assert.equal(partial.usage.nonCachedInputTokens, 4);
  }
  assert.throws(() => anthropicRawUsage({ cache_creation: { ephemeral_5m_input_tokens: -1 } }));
  assert.throws(() => normalizeAnthropicUsage({ input_tokens: Number.MAX_SAFE_INTEGER, cache_read_input_tokens: 1, cache_creation_input_tokens: 0 }));
});

const scenarios = [
  { name: 'responses', Model: ResponsesModel, events: () => responseEvents([], { usage: { input_tokens: 9 } }).map(sse).join('') },
  { name: 'chat', Model: ChatCompletionsModel, events: () => chatEvents(undefined, { usage: { prompt_tokens: 9 } }).map(chatSse).join('') },
  { name: 'anthropic', Model: AnthropicModel, events: () => anthropicEvents().map(anthropicSse).join('') },
];
for (const scenario of scenarios) {
  test(`${scenario.name} full run persists context model alias k3[1M] through actual adapter dispatch`, async t => {
    const previousFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = previousFetch; });
    const sent = [], records = [];
    globalThis.fetch = async (_url, init) => {
      sent.push(JSON.parse(init.body));
      return new Response(scenario.events(), { headers: { 'Content-Type': 'text/event-stream' } });
    };
    const model = new scenario.Model({ model: 'k3[1M]', baseURL: 'http://127.0.0.1:12345/v1', allowLoopbackHttp: true, toolDefinitions: [] });
    let context;
    const result = await runAgent({ identity, input: 'Preserve the configured model alias.', configuration: { model: 'k3[1M]' }, policyRevision: 'fixture', signal: new AbortController().signal }, {
      model, tools: { definitions: [], prepare: async () => assert.fail('no tool calls'), validate: async () => assert.fail('no tool calls'), execute: async () => assert.fail('no tool calls') },
      approvals: { request: async () => assert.fail('no approvals') },
      host: { now: () => Date.now(), activeNow: () => performance.now(), digest: value => createHash('sha256').update(value).digest('hex'),
        emit: () => {}, deadline: (_milliseconds, signal) => ({ signal, dispose: () => {} }) },
      store: {
        beginRun: async request => { context = { protocol: request.protocol, items: structuredClone(request.userItems) }; return { kind: 'accepted', context: structuredClone(context) }; },
        ensureCapacity: async () => {}, checkpoint: async (_identity, next) => assert.deepEqual(next, context),
        append: async (_identity, event) => {
          if (event.type === 'model_request_diagnostic') assert.equal(validateModelRequestDiagnostic(event.diagnostic), true);
          if (event.type === 'model_response') {
            context.items.push(...structuredClone(event.response.outputItems));
            if (event.response.continuation === undefined) delete context.continuation; else context.continuation = structuredClone(event.response.continuation);
          }
          records.push(structuredClone(event)); return { seq: records.length };
        },
      },
    });
    assert.equal(result.status, 'completed');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].model, 'k3[1M]');
    const diagnostics = records.filter(event => event.type === 'model_request_diagnostic').map(event => event.diagnostic);
    assert.deepEqual(diagnostics.map(diagnostic => diagnostic.phase), ['started', 'request', 'dispatched', 'finished']);
    assert.ok(diagnostics.every(diagnostic => diagnostic.model === 'k3[1M]'));
    assert.equal(diagnostics[2].requestSent, true);
  });

  test(`${scenario.name} deterministic SSE diagnostic payload accounting and persistence barriers`, async t => {
    const previousFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = previousFetch; });
    const sentBodies = [];
    let requestPersisted = false;
    globalThis.fetch = async (_url, init) => {
      assert.equal(requestPersisted, true);
      sentBodies.push(init.body);
      return new Response(scenario.events(), { headers: { 'Content-Type': 'text/event-stream' } });
    };
    const model = new scenario.Model({ model: 'fixture-model', baseURL: 'http://127.0.0.1:12345/v1', allowLoopbackHttp: true,
      toolDefinitions: definitions, instructions: 'private-instructions-规则🙂' });
    const diagnostics = [];
    const image = { mimeType: 'image/png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' };
    const input = request(model, { context: { protocol: model.protocol, items: model.userItems('private-input-中文🙂', [image]),
      ...(scenario.name === 'responses' ? { continuation: { opaque: 'private-continuation' } } : {}) },
      diagnosticInstructionSections: { systemPrompt: 'private-system', permissions: 'private-permissions', projectRules: '', skills: 'private-skills' },
      onRequestDiagnostic: async diagnostic => {
        diagnostics.push(diagnostic);
        if (diagnostic.phase === 'request') { assert.equal(sentBodies.length, 0); await new Promise(resolve => setImmediate(resolve)); requestPersisted = true; }
        if (diagnostic.phase === 'dispatched') assert.equal(sentBodies.length, 1, 'fetch is invoked before dispatch acknowledgement');
      } });
    const response = await model.generate(input);
    const [sent, dispatched, result] = diagnostics;
    assert.equal(model.requestDiagnostics, true);
    assert.deepEqual(diagnostics.map(value => value.phase), ['request', 'dispatched', 'result']);
    assert.equal(dispatched.model, 'fixture-model');
    assert.equal(sent.payloadBytes, Buffer.byteLength(sentBodies[0], 'utf8'));
    assert.equal(sent.payloadDigest, createHash('sha256').update(sentBodies[0]).digest('hex'));
    assert.equal(Object.values(sent.components).filter(value => value.accounting === 'serialized').reduce((sum, value) => sum + value.bytes, 0), sent.payloadBytes);
    for (const name of ['systemPrompt', 'permissions', 'projectRules', 'skills', 'images', 'userInput']) assert.equal(sent.components[name].accounting, 'logical');
    if (scenario.name === 'responses') assert.equal(sent.components.continuation.accounting, 'logical');
    assert.equal(sent.components.projectRules.bytes, 0);
    assert.equal(sent.model, 'fixture-model');
    assert.deepEqual(result.providerUsage, response.providerUsage);
    assert.ok(Number.isFinite(result.elapsedMs) && result.elapsedMs >= 0);
    assert.doesNotMatch(JSON.stringify(diagnostics), /private-|iVBORw0KGgo/);
    const estimate = model.estimateInputUsage(input.context, input.maxOutputTokens);
    assert.equal(estimate.serializedBytes, sent.payloadBytes);
    assert.ok(estimate.estimatedInputTokens >= model.estimateInputTokens(input.context));

    const persistenceFailure = new Error('Persistence failed');
    const before = sentBodies.length;
    await assert.rejects(model.generate(request(model, { onRequestDiagnostic: value => { if (value.phase === 'request') throw persistenceFailure; } })), error => error === persistenceFailure);
    assert.equal(sentBodies.length, before);
    await assert.rejects(model.generate(request(model, { onRequestDiagnostic: value => { if (value.phase === 'result') throw persistenceFailure; } })), error => error === persistenceFailure);
    assert.equal(sentBodies.length, before + 1);

    // 被正文凭据检查拒绝的模型名，也不能通过新诊断路径泄露。
    const credential = 'credential-sentinel-12345678', safeDiagnostics = [];
    const guarded = new scenario.Model({ model: credential, apiKey: credential, baseURL: 'http://127.0.0.1:12345/v1', allowLoopbackHttp: true, toolDefinitions: definitions });
    await assert.rejects(guarded.generate(request(guarded, { onRequestDiagnostic: value => { safeDiagnostics.push(value); } })), { code: 'credential_echo' });
    assert.deepEqual(safeDiagnostics.map(value => value.phase), ['result']);
    assert.equal(safeDiagnostics[0].model, undefined);
    assert.doesNotMatch(JSON.stringify(safeDiagnostics), /credential-sentinel/);
    assert.equal(sentBodies.length, before + 1);
  });

  test(`${scenario.name} cancellation during request persistence never invokes fetch or acknowledges dispatch`, async t => {
    const previousFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = previousFetch; });
    let fetched = false;
    globalThis.fetch = async () => { fetched = true; throw new Error('Unexpected dispatch'); };
    const model = new scenario.Model({ model: 'fixture-model', baseURL: 'http://127.0.0.1:12345/v1', allowLoopbackHttp: true, toolDefinitions: definitions });
    const controller = new AbortController(), diagnostics = [];
    await assert.rejects(model.generate(request(model, { signal: controller.signal, onRequestDiagnostic: async diagnostic => {
      diagnostics.push(diagnostic);
      if (diagnostic.phase === 'request') { await new Promise(resolve => setImmediate(resolve)); controller.abort(); }
    } })), { code: 'cancelled' });
    assert.equal(fetched, false);
    assert.deepEqual(diagnostics.map(value => value.phase), ['request', 'result']);
    assert.equal(diagnostics[1].result, 'failed');
  });

  test(`${scenario.name} dispatch persistence failure aborts and settles transport while preserving error identity`, async t => {
    const previousFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = previousFetch; });
    let fetched = false, aborted = false, settled = false;
    globalThis.fetch = (_url, init) => {
      fetched = true;
      return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => {
        aborted = true;
        queueMicrotask(() => { settled = true; reject(new Error('Aborted transport')); });
      }, { once: true }));
    };
    const model = new scenario.Model({ model: 'fixture-model', baseURL: 'http://127.0.0.1:12345/v1', allowLoopbackHttp: true, toolDefinitions: definitions });
    const persistenceFailure = new Error('Dispatch persistence failed'), phases = [];
    await assert.rejects(model.generate(request(model, { onRequestDiagnostic: diagnostic => {
      phases.push(diagnostic.phase);
      if (diagnostic.phase === 'dispatched') { assert.equal(fetched, true); throw persistenceFailure; }
    } })), error => error === persistenceFailure);
    assert.equal(aborted, true);
    assert.equal(settled, true);
    assert.deepEqual(phases, ['request', 'dispatched', 'result']);
  });
}

test('Anthropic explicit null updates clear previously known counters while absent fields still inherit', async t => {
  const previousFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = previousFetch; });
  for (const field of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
    const events = anthropicEvents(undefined, { startMessage: { usage: { input_tokens: 4, output_tokens: 1, cache_read_input_tokens: 5, cache_creation_input_tokens: 6 } },
      usage: { output_tokens: 20, [field]: null } });
    globalThis.fetch = async () => new Response(events.map(anthropicSse).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
    const model = new AnthropicModel({ model: 'fixture-model', baseURL: 'http://127.0.0.1:12345/v1', allowLoopbackHttp: true, toolDefinitions: definitions });
    const response = await model.generate(request(model));
    assert.equal(response.providerUsage.raw[field], null);
    assert.equal(response.usage.totalTokens, undefined);
    if (field === 'output_tokens') { assert.equal(response.usage.outputTokens, undefined); assert.equal(response.usage.inputTokens, 15); }
    else assert.equal(response.usage.inputTokens, undefined);
    if (field === 'cache_read_input_tokens') assert.equal(response.usage.cacheReadInputTokens, null);
    if (field === 'cache_creation_input_tokens') assert.equal(response.usage.cacheCreationInputTokens, null);
    if (field === 'input_tokens') assert.equal(response.usage.nonCachedInputTokens, null);
  }
});

test('deterministic failed streams retain validated provider counters and bounded failure diagnostics', async t => {
  const previousFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = previousFetch; });
  const streams = [
    [scenarios[0], [...responseEvents([], { usage: { input_tokens: 9 } }), { type: 'response.created', response: { id: 'unexpected' } }].map(sse).join(''), { input_tokens: 9 }],
    [scenarios[1], chatEvents(undefined, { usage: { prompt_tokens: 9 } }).slice(0, -1).map(chatSse).join(''), { prompt_tokens: 9 }],
    [scenarios[2], anthropicEvents().slice(0, -1).map(anthropicSse).join(''), { input_tokens: 11, output_tokens: 7 }],
  ];
  for (const [scenario, stream, raw] of streams) {
    globalThis.fetch = async () => new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
    const model = new scenario.Model({ model: 'fixture-model', baseURL: 'http://127.0.0.1:12345/v1', allowLoopbackHttp: true, toolDefinitions: definitions });
    const diagnostics = [];
    await assert.rejects(model.generate(request(model, { onRequestDiagnostic: value => { diagnostics.push(value); } })));
    assert.deepEqual(diagnostics.map(value => value.phase), ['request', 'dispatched', 'result']);
    assert.equal(diagnostics[2].result, 'failed');
    assert.deepEqual(diagnostics[2].providerUsage.raw, raw);
    assert.equal(diagnostics[2].failure.retryable, false);
    assert.ok(Number.isFinite(diagnostics[2].elapsedMs) && diagnostics[2].elapsedMs >= 0);
  }
});
