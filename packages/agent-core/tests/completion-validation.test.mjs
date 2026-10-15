import test from 'node:test'
import assert from 'node:assert/strict'
import { completionFeedbackText, validateCompletionDecision } from '../dist/index.js'

test('completion feedback accepts only fixed code and bounded canonical relative path data', () => {
  const decision = { kind: 'continue', code: 'declared_material_reads_missing', paths: ['review.md', 'docs/README'] }
  assert.equal(validateCompletionDecision(decision), true)
  assert.match(completionFeedbackText(decision), /\["review.md","docs\/README"\]$/u)
  assert.equal(validateCompletionDecision({ kind: 'accept' }), true)
  for (const path of ['', '../escape', '/absolute', './relative', 'a//b', 'a/../b', 'C:/file', 'a\\b', 'trailing ', 'a\0b']) {
    assert.equal(validateCompletionDecision({ ...decision, paths: [path] }), false, JSON.stringify(path))
  }
  for (const invalid of [{ kind: 'accept', extra: true }, { ...decision, paths: [] }, { ...decision, paths: ['a', 'a'] },
    { ...decision, code: 'arbitrary text' }, { ...decision, message: 'secret' }, { ...decision, paths: Array(33).fill('a') }]) {
    assert.equal(validateCompletionDecision(invalid), false)
  }
})

test('completion validation never invokes getters or toJSON while checking trust boundaries', () => {
  let invoked = 0
  for (const candidate of [Object.defineProperty({}, 'kind', { enumerable: true, get() { invoked++; return 'accept' } }),
    { kind: 'accept', toJSON() { invoked++; return { kind: 'accept' } } },
    Object.assign(Object.create({}), { kind: 'accept' }),
    { kind: 'continue', code: 'declared_material_reads_missing', paths: Object.defineProperty(['review.md'], '0', { enumerable: true, get() { invoked++; return 'review.md' } }) }]) {
    assert.equal(validateCompletionDecision(candidate), false)
  }
  assert.equal(invoked, 0)
})
