import test from 'node:test'
import assert from 'node:assert/strict'
import { contextBudgetUsage, estimateContextInputTokens, estimateContextInput, compareContextEstimate, contextHasUserImages } from '../dist/index.js'

test('context estimate counts UTF-8 history and instructions without claiming provider usage', () => {
  const context = { protocol: { id: 'test', version: 1 }, items: [{ role: 'user', content: '中文🙂' }], continuation: { opaque: 'saved' } }
  const instructions = '项目规则'
  const estimate = estimateContextInputTokens(context, instructions)
  assert.equal(estimate, Buffer.byteLength(JSON.stringify(context.items) + instructions))
  const budget = contextBudgetUsage(context, estimate, { maxInputTokens: estimate * 2, maxContextBytes: 10000 })
  assert.equal(budget.contextBytes, Buffer.byteLength(JSON.stringify(context)))
  assert.equal(budget.status, 'within_budget')
  assert.equal(budget.estimator, 'utf8_bytes')
  assert.equal(Object.hasOwn(budget, 'inputTokens'), false)
  assert.equal(Object.hasOwn(budget, 'contextWindow'), false)
})

test('context budget permits its exact boundary and flags either input or byte exhaustion', () => {
  const context = { protocol: { id: 'test', version: 1 }, items: [] }
  const bytes = Buffer.byteLength(JSON.stringify(context))
  assert.equal(contextBudgetUsage(context, 90, { maxInputTokens: 100, maxContextBytes: bytes * 2 }).status, 'near_limit')
  assert.equal(contextBudgetUsage(context, 100, { maxInputTokens: 100, maxContextBytes: bytes }).status, 'near_limit')
  assert.equal(contextBudgetUsage(context, 101, { maxInputTokens: 100, maxContextBytes: bytes }).status, 'exceeded')
  assert.equal(contextBudgetUsage(context, 0, { maxInputTokens: 100, maxContextBytes: bytes - 1 }).status, 'exceeded')
  for (const estimate of [NaN, Infinity, -1]) assert.throws(() => contextBudgetUsage(context, estimate, { maxInputTokens: 100, maxContextBytes: 100 }))
})

test('Anthropic base64 image history is recognized before any lossy context maintenance', () => {
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }
  const protocol = { id: 'anthropic-messages', version: 1 }
  assert.equal(contextHasUserImages({ protocol, items: [{ role: 'user', content: [{ type: 'text', text: 'describe' }, image] }] }), true)
  assert.equal(contextHasUserImages({ protocol, items: [{ role: 'user', content: [{ type: 'text', text: 'image' }] }] }), false)
  assert.equal(contextHasUserImages({ protocol, items: [{ role: 'assistant', content: [image] }] }), false)
})

test('offline estimates expose exact byte components, source and unknown-model fallback', () => {
  const context = { protocol: { id: 'openai-responses', version: 1 }, items: [
    { role: 'user', content: '中文🙂 English source / 项目路径' },
    { type: 'reasoning', encrypted_content: 'opaque-signed-state', summary: [] },
  ], continuation: { responseId: 'existing-response' } }
  const tools = [{ name: 'read_file', inputSchema: { type: 'object' } }]
  const result = estimateContextInput(context, { model: 'unknown-model', instructions: '规则', toolDefinitions: tools })
  assert.equal(result.estimatedInputTokens, Buffer.byteLength(JSON.stringify(context.items) + '规则' + JSON.stringify(tools)))
  assert.equal(result.serializedBytes, result.estimatedInputTokens)
  assert.equal(result.contextBytes, Buffer.byteLength(JSON.stringify(context)))
  assert.equal(result.components.historyBytes, Buffer.byteLength(JSON.stringify(context.items)))
  assert.equal(result.components.instructionBytes, Buffer.byteLength('规则'))
  assert.equal(result.components.toolDefinitionBytes, Buffer.byteLength(JSON.stringify(tools)))
  assert.equal(result.components.protocolStateBytes, Buffer.byteLength(JSON.stringify(context.items[1])) + Buffer.byteLength(JSON.stringify(context.continuation)))
  assert.equal(result.source, 'fallback'); assert.equal(result.fallbackReason, 'not_configured')
  assert.equal(compareContextEstimate(result, null).status, 'unknown')
  assert.deepEqual(context.items[1], { type: 'reasoning', encrypted_content: 'opaque-signed-state', summary: [] })
})

test('candidate tokenizer and calibration estimates measure error without relaxing the conservative boundary', () => {
  const context = { protocol: { id: 'openai-responses', version: 1 }, items: [{ role: 'user', content: 'ASCII 中文🙂 repeated evidence '.repeat(40) }] }
  const payload = JSON.stringify({ model: 'known-model', input: context.items, instructions: 'fixed policy', tools: [] })
  for (const method of ['tokenizer', 'calibrated']) {
    const estimator = { model: 'known-model', protocol: context.protocol, method, provenance: 'offline-fixture-v1', estimate: () => 50 }
    const result = estimateContextInput(context, { model: 'known-model', serializedInput: payload, estimator })
    assert.equal(result.method, method); assert.equal(result.candidateInputTokens, 50)
    assert.equal(result.estimatedInputTokens, Buffer.byteLength(payload), 'unmeasured real-model calibration cannot lower budget checks')
    assert.equal(contextBudgetUsage(context, result, { maxInputTokens: 100, maxContextBytes: 10000 }).status, 'exceeded')
    assert.deepEqual(compareContextEstimate(result, 100), { status: 'measured', estimatedInputTokens: 50, actualInputTokens: 100, difference: -50, relativeError: -0.5, underestimated: true })
    assert.equal(compareContextEstimate(result, 0).relativeError, null)
  }
})

test('unknown or invalid estimator fails closed and payload byte cap remains independent', () => {
  const context = { protocol: { id: 'openai-chat-completions', version: 1 }, items: [] }
  const configured = { model: 'known-model', protocol: context.protocol, method: 'tokenizer', provenance: 'fixture-tokenizer', estimate: () => 1 }
  for (const [estimator, reason] of [
    [{ ...configured, model: 'other-model' }, 'model_mismatch'],
    [{ ...configured, protocol: { id: 'anthropic-messages', version: 1 } }, 'protocol_mismatch'],
    [{ ...configured, estimate: () => NaN }, 'invalid_estimate'],
    [{ ...configured, estimate: () => -1 }, 'invalid_estimate'],
    [{ ...configured, estimate: () => 0 }, 'invalid_estimate'],
    [{ ...configured, provenance: '' }, 'invalid_estimate'],
    [{ ...configured, provenance: undefined }, 'invalid_estimate'],
    [{ ...configured, estimate: undefined }, 'invalid_estimate'],
    [{ ...configured, protocol: undefined }, 'protocol_mismatch'],
    [{ ...configured, estimate: () => { throw new Error('unavailable tokenizer') } }, 'estimator_failed'],
  ]) {
    const result = estimateContextInput(context, { model: 'known-model', serializedInput: 'x'.repeat(500), estimator })
    assert.equal(result.source, 'fallback'); assert.equal(result.fallbackReason, reason)
    assert.equal(result.estimatedInputTokens, 500)
  }
  const result = estimateContextInput(context, { model: 'unknown', serializedInput: 'x'.repeat(500) })
  result.estimatedInputTokens = 0
  assert.equal(contextBudgetUsage(context, result, { maxInputTokens: 10000, maxContextBytes: 499 }).status, 'exceeded')
  assert.equal(contextBudgetUsage(context, result, { maxInputTokens: 10000, maxContextBytes: 500 }).status, 'near_limit')
  for (const serializedBytes of [NaN, Infinity, -1, 1.5]) assert.throws(() => contextBudgetUsage(context, { ...result, serializedBytes }, { maxInputTokens: 10000, maxContextBytes: 500 }), /Invalid context byte/)
})

test('base64 image and signed Anthropic state remain separate byte contributions', () => {
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc'.repeat(2000) } }
  const privateBlock = { type: 'thinking', thinking: 'private state', signature: 'signature'.repeat(200) }
  const context = { protocol: { id: 'anthropic-messages', version: 1 }, items: [
    { role: 'user', content: [{ type: 'text', text: 'Describe' }, image] },
    { role: 'assistant', content: [privateBlock, { type: 'text', text: 'description' }] },
  ] }
  const result = estimateContextInput(context)
  assert.equal(result.components.imageBytes, Buffer.byteLength(JSON.stringify(image)))
  assert.equal(result.components.protocolStateBytes, Buffer.byteLength(JSON.stringify(privateBlock)))
  assert.equal(result.estimatedInputTokens, Buffer.byteLength(JSON.stringify(context.items)))
  assert.throws(() => compareContextEstimate(result, NaN), /Invalid measured/)
})
