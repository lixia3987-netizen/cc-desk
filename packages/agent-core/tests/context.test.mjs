import test from 'node:test'
import assert from 'node:assert/strict'
import { contextBudgetUsage, estimateContextInputTokens } from '../dist/index.js'

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
