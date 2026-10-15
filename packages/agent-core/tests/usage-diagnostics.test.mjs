import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createModelRequestDiagnostic, validateModelRequestDiagnostic, validateDiagnosticModelLabel, validateUsage, validateProviderUsage, sumUsage } from '../dist/index.js'

const digest = value => createHash('sha256').update(value).digest('hex')
const identity = { sessionId: 'session', conversationId: 'conversation', runId: 'run', requestId: 'request', workerGeneration: 1 }
const context = { protocol: { id: 'openai-responses', version: 1 }, items: [
  { role: 'user', content: 'private-user-input' }, { type: 'reasoning', encrypted_content: 'private-opaque-block' },
  { type: 'function_call_output', call_id: 'a', output: 'private-tool-output' },
], continuation: { private: 'private-continuation' } }
const usage = { inputTokens: 20, outputTokens: 2, totalTokens: 22, cacheReadInputTokens: 7, cacheCreationInputTokens: 3, nonCachedInputTokens: 10 }

test('cache normalization accumulates subsets without inflating total input and preserves old records', () => {
  assert.deepEqual(sumUsage([usage, usage]), { inputTokens: 40, outputTokens: 4, totalTokens: 44, cacheReadInputTokens: 14, cacheCreationInputTokens: 6, nonCachedInputTokens: 20 })
  assert.deepEqual(sumUsage([{ inputTokens: 20 }, { inputTokens: 10 }]), { inputTokens: 30 })
  assert.equal(sumUsage([usage, null]), null)
  const mixed = sumUsage([usage, { inputTokens: 10, outputTokens: 2, totalTokens: 12 }])
  assert.equal(mixed.cacheReadInputTokens, null)
  assert.equal(mixed.cacheCreationInputTokens, null)
  assert.equal(mixed.nonCachedInputTokens, null)
  assert.equal(mixed.inputTokens, 30)
})

test('normalized usage and raw provider counts accept unknowns and reject invalid or unbounded telemetry', () => {
  assert.equal(validateUsage({ inputTokens: 0, cacheReadInputTokens: null }), true)
  assert.equal(validateUsage({ inputTokens: 20, outputTokens: 5, totalTokens: 1 }), true, 'older usage-only records retain their read contract')
  assert.equal(validateUsage({ inputTokens: 20, outputTokens: 5, totalTokens: 1 }, true), false)
  for (const value of [{ inputTokens: null }, { inputTokens: -1 }, { inputTokens: 1.5 }, { cacheReadInputTokens: Infinity }, { body: 'private' }]) assert.equal(validateUsage(value), false)
  assert.equal(validateProviderUsage({ raw: { input_tokens: 20, cached_tokens: 7, cache_write_tokens: 3 }, normalization: 'openai-inclusive-input' }), true)
  assert.equal(validateProviderUsage({ raw: { authorization: null }, normalization: 'openai-inclusive-input' }), false)
  assert.equal(validateProviderUsage({ raw: { input_tokens: 20 }, normalization: 'private-text' }), false)
})

test('provider model labels preserve bounded context aliases without accepting URL, controls or credential syntax', async () => {
  for (const model of ['k3[1M]', 'claude-sonnet-4-5[1m]', 'provider/model[1M]', 'provider:model']) {
    assert.equal(validateDiagnosticModelLabel(model), true)
    const diagnostic = await createModelRequestDiagnostic({ identity, requestKey: 'run:request:1', attempt: 1, purpose: 'normal', context, tools: [], model,
      estimatedInputTokens: 99, host: { digest, now: () => 100 } })
    assert.equal(validateModelRequestDiagnostic(diagnostic), true)
    assert.equal(validateModelRequestDiagnostic({ ...diagnostic, identity: { ...identity, runId: model } }), !model.includes('['), 'model syntax cannot broaden identity validation')
  }
  for (const model of ['', 'x'.repeat(257), 'https://provider/model', 'file://model', 'https:provider', 'data:private', 'key@model', 'model?api_key=secret', 'model\nsecret', 'model\0secret', '模型']) {
    assert.equal(validateDiagnosticModelLabel(model), false)
  }
})

test('diagnostics contain identities and bytes/hash but no history, reasoning or credentials', async () => {
  const diagnostic = await createModelRequestDiagnostic({ identity, requestKey: 'run:request:1', attempt: 1, purpose: 'child', parentRunId: 'parent', childId: 'child', context, tools: [], estimatedInputTokens: 99, estimateMethod: 'utf8_bytes', estimateSource: 'fallback', host: { digest, now: () => 100 } })
  assert.equal(validateModelRequestDiagnostic(diagnostic), true)
  assert.equal(diagnostic.contextBytes, Buffer.byteLength(JSON.stringify(context)))
  assert.equal(diagnostic.contextDigest, digest(JSON.stringify(context)))
  assert.equal(diagnostic.components.reasoning.count, 1)
  assert.equal(diagnostic.components.continuation.accounting, 'logical')
  for (const secret of ['private-user-input', 'private-tool-output', 'private-opaque-block', 'private-continuation']) assert.equal(JSON.stringify(diagnostic).includes(secret), false)
  for (const key of ['body', 'headers', 'apiKey', 'error', 'instructions']) assert.equal(validateModelRequestDiagnostic({ ...diagnostic, [key]: 'private' }), false)
  assert.equal(validateModelRequestDiagnostic({ ...diagnostic, components: { ...diagnostic.components, history: { ...diagnostic.components.history, text: 'private' } } }), false)
  assert.equal(validateModelRequestDiagnostic({ ...diagnostic, phase: 'finished' }), false)
  assert.equal(validateModelRequestDiagnostic({ ...diagnostic, phase: 'finished', finishedAt: 101, outcome: 'completed', usage }), true)
})
