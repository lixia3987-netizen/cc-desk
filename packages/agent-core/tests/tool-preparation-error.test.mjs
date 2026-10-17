import test from 'node:test'
import assert from 'node:assert/strict'
import { ToolPreparationError, getToolPreparationFeedback, validateToolPreparationFeedback } from '../dist/index.js'

test('preparation feedback snapshots fixed schemas and preserves the empty-file correction', () => {
  for (const value of [
    { error: 'task_revision_changed', currentRevision: Number.MAX_SAFE_INTEGER, readTask: true },
    { error: 'code_location_line_range_invalid', lineCount: 0, readFile: true },
  ]) {
    const expected = { ...value }
    const error = new ToolPreparationError(value, 'ignored-untrusted-message')
    assert.equal(error.message, 'Tool preparation requires refreshed input')
    assert.equal(validateToolPreparationFeedback(error.feedback), true)
    assert.equal(Object.isFrozen(error.feedback), true)
    assert.deepEqual(getToolPreparationFeedback(error), expected)
    assert.notEqual(getToolPreparationFeedback(error), error.feedback, 'boundary creates a fresh primitive-only projection')
    value.error = 'changed-after-construction'
    assert.deepEqual(error.feedback, expected)
  }
})

test('constructor and feedback guard reject malformed numbers, flags, schemas and every extra own field', async t => {
  const revision = { error: 'task_revision_changed', currentRevision: 2, readTask: true }
  const line = { error: 'code_location_line_range_invalid', lineCount: 0, readFile: true }
  const hidden = Object.defineProperty({ ...revision }, 'secret', { value: 'sk-secret', enumerable: false })
  const symbol = { ...revision, [Symbol('secret')]: 'sk-secret' }
  const prototype = Object.assign(Object.create({ secret: 'sk-secret' }), revision)
  for (const [name, value] of [
    ['null', null], ['array', [revision]], ['unknown error', { ...revision, error: 'sk-secret' }],
    ['message', { ...revision, message: 'sk-secret' }], ['nonenumerable field', hidden], ['symbol field', symbol], ['custom prototype', prototype],
    ['zero revision', { ...revision, currentRevision: 0 }], ['negative revision', { ...revision, currentRevision: -1 }],
    ['unsafe revision', { ...revision, currentRevision: Number.MAX_SAFE_INTEGER + 1 }], ['fractional revision', { ...revision, currentRevision: 1.5 }],
    ['nonfinite revision', { ...revision, currentRevision: Infinity }], ['NaN revision', { ...revision, currentRevision: NaN }],
    ['string revision', { ...revision, currentRevision: '2' }], ['missing read flag', { error: revision.error, currentRevision: 2 }],
    ['false read flag', { ...revision, readTask: false }], ['numeric read flag', { ...revision, readTask: 1 }],
    ['mixed schemas', { ...revision, lineCount: 1, readFile: true }], ['negative line count', { ...line, lineCount: -1 }],
    ['unsafe line count', { ...line, lineCount: Number.MAX_SAFE_INTEGER + 1 }], ['string line count', { ...line, lineCount: '0' }],
  ]) await t.test(name, () => {
    assert.equal(validateToolPreparationFeedback(value), false)
    assert.throws(() => new ToolPreparationError(value), { name: 'TypeError', message: 'Invalid tool preparation feedback' })
  })
})

test('feedback inspection never invokes accessors or leaks hostile inspection failures', () => {
  const secret = 'sk-error-feedback-secret'
  let reads = 0
  const accessor = { error: 'task_revision_changed', readTask: true,
    get currentRevision() { reads++; throw new Error(secret) } }
  const proxy = new Proxy({}, { ownKeys() { throw new Error(secret) } })
  for (const value of [accessor, proxy]) {
    assert.equal(validateToolPreparationFeedback(value), false)
    assert.throws(() => new ToolPreparationError(value), error => error instanceof TypeError && error.message === 'Invalid tool preparation feedback' && !error.stack.includes(secret))
  }
  assert.equal(reads, 0)
})

const skillActions = {
  context_unconfirmed: 'continue_model', source_changed: 'restart_turn', activation_changed: 'prepare_again',
  activation_blocked: 'settle_operations', output_limit: 'adjust_skill_limits', skill_limit: 'adjust_skill_limits',
}

test('skill preparation feedback accepts only the six exact code/action pairs', () => {
  for (const [code, action] of Object.entries(skillActions)) {
    const expected = { error: 'skill_precondition_failed', code, action }
    assert.equal(validateToolPreparationFeedback(expected), true)
    const error = new ToolPreparationError(expected)
    assert.deepEqual(getToolPreparationFeedback(error), expected)
    assert.equal(Object.isFrozen(error.feedback), true)
    for (const otherAction of new Set(Object.values(skillActions))) {
      if (otherAction === action) continue
      assert.equal(validateToolPreparationFeedback({ ...expected, action: otherAction }), false)
    }
  }
})

test('skill feedback rejects extra fields, arbitrary strings, prototypes and obsolete reload flags', () => {
  const valid = { error: 'skill_precondition_failed', code: 'source_changed', action: 'restart_turn' }
  for (const value of [
    { ...valid, code: 'secret-source-path' }, { ...valid, action: 'run-command' }, { ...valid, action: null },
    { ...valid, reloadSkill: true }, { error: valid.error, code: valid.code, reloadSkill: true },
    { ...valid, message: 'secret-path' }, { ...valid, [Symbol('secret')]: 'secret-path' },
    Object.defineProperty({ ...valid }, 'private', { value: 'secret-path' }),
    Object.assign(Object.create({ secret: 'secret-path' }), valid),
  ]) {
    assert.equal(validateToolPreparationFeedback(value), false)
    assert.throws(() => new ToolPreparationError(value), { name: 'TypeError', message: 'Invalid tool preparation feedback' })
  }
})

test('skill feedback inspection never executes code/action getters or toJSON', () => {
  let reads = 0
  for (const field of ['code', 'action']) {
    const value = { error: 'skill_precondition_failed', code: 'source_changed', action: 'restart_turn' }
    Object.defineProperty(value, field, { enumerable: true, get() { reads++; throw new Error('secret-path') } })
    assert.equal(validateToolPreparationFeedback(value), false)
    assert.throws(() => new ToolPreparationError(value), TypeError)
  }
  const value = { error: 'skill_precondition_failed', code: 'source_changed', action: 'restart_turn', toJSON() { reads++; throw new Error('secret-path') } }
  assert.equal(validateToolPreparationFeedback(value), false)
  assert.equal(getToolPreparationFeedback(Object.assign(Object.create(ToolPreparationError.prototype), { feedback: value })), null)
  assert.equal(reads, 0)
})
