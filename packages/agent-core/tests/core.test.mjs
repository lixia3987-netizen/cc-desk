import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { runAgent, canonicalJson, RunAlreadyActiveError, ToolPreparationError, validateModelFailureDiagnostic } from '../dist/index.js'

const copy = (value) => JSON.parse(JSON.stringify(value))
const digest = (value) => createHash('sha256').update(value).digest('hex')
const protocol = { id: 'fixture', version: 1 }
const call = (id, name = 'read', input = { path: 'a.txt' }) => ({ id, name, arguments: JSON.stringify(input) })
const response = (calls = [], extra = {}) => ({
  outputItems: calls.length ? [{ type: 'reasoning', encrypted: 'opaque' }, ...calls.map((c) => ({ type: 'function_call', ...c }))] : [{ type: 'message', text: 'finished' }],
  toolCalls: calls, finishReason: calls.length ? 'tool_calls' : 'completed', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
  ...extra,
})

function fixture(responses = [response()]) {
  const controller = new AbortController()
  const events = [], order = [], modelInputs = [], executions = [], approvals = [], emitted = []
  let current = { protocol, items: [] }, now = 0, checkpointCount = 0, storedResult
  const hooks = {}
  const request = {
    identity: { sessionId: 'session', conversationId: 'conversation', runId: 'run', requestId: 'request', workerGeneration: 1 },
    input: 'do the task', configuration: { model: 'fixture' }, policyRevision: 'policy-1', signal: controller.signal,
  }
  const definitions = ['read', 'write', 'command'].map((name) => ({ name, description: name, inputSchema: { type: 'object' }, risk: name }))
  const ports = {
    host: {
      now: () => now,
      digest,
      deadline(_ms, parent) {
        const child = new AbortController()
        const abort = () => child.abort()
        if (parent.aborted) abort()
        parent.addEventListener('abort', abort, { once: true })
        return { signal: child.signal, dispose: () => parent.removeEventListener('abort', abort) }
      },
      emit(event) { emitted.push(copy(event)); return hooks.emit?.(event) },
      async wait(milliseconds, signal) {
        order.push(`wait:${milliseconds}`)
        await hooks.wait?.(milliseconds, signal)
        now += milliseconds
      },
    },
    store: {
      async beginRun(begin) {
        order.push('begin')
        const override = await hooks.begin?.(begin)
        if (override) return override
        current.items.push(...copy(begin.userItems))
        return { kind: 'accepted', context: copy(current) }
      },
      async ensureCapacity(_identity, bytes) { order.push('capacity'); await hooks.capacity?.(bytes) },
      async append(_identity, event) {
        order.push(event.type)
        await hooks.append?.(event)
        events.push(copy(event))
        if (event.type === 'model_response') {
          current.items.push(...copy(event.response.outputItems))
          if (event.response.continuation !== undefined) current.continuation = copy(event.response.continuation)
          else delete current.continuation
        }
        if (event.type === 'tool_completed') current.items.push(...copy(event.resultItems))
        if (event.type === 'completion_rejected') current.items.push(...copy(event.feedbackItems))
        if (event.type === 'run_finished') storedResult = copy(event.result)
        return { seq: events.length }
      },
      async checkpoint(_identity, context) {
        order.push('checkpoint')
        checkpointCount++
        await hooks.checkpoint?.(context, checkpointCount)
        assert.deepEqual(context, current, 'checkpoint must equal full journal-derived context')
      },
    },
    model: {
      protocol,
      userItems: (input) => [{ role: 'user', content: input }],
      toolResultItems: (tool, result) => [{ type: 'function_call_output', call_id: tool.id, output: JSON.stringify(result) }],
      estimateInputTokens: () => 100,
      classifyError: error => hooks.classifyError?.(error) ?? { category: 'unknown', retryable: false },
      async generate(input) {
        order.push('model')
        modelInputs.push(copy({ context: input.context, maxOutputTokens: input.maxOutputTokens }))
        const overridden = await hooks.generate?.(input)
        if (overridden) return overridden
        const next = responses.shift()
        assert.ok(next, 'unexpected extra model request')
        return next
      },
    },
    tools: {
      definitions,
      async prepare(tool, context) {
        order.push(`prepare:${tool.id}`)
        await hooks.prepare?.(tool, context)
        const input = JSON.parse(tool.arguments)
        return { call: tool, definition: definitions.find((d) => d.name === tool.name), input, inputDigest: digest(canonicalJson(input)), policyRevision: context.policyRevision, requiresApproval: false, preconditions: { hash: 'before', instructions: 'hash' } }
      },
      async validate(prepared, context) { order.push(`validate:${prepared.call.id}`); await hooks.validate?.(prepared, context) },
      async execute(prepared, context, approval) {
        order.push(`execute:${prepared.call.id}`)
        executions.push(prepared.call.id)
        return await hooks.execute?.(prepared, context, approval) ?? { status: 'completed', output: { content: 'result' } }
      },
    },
    approvals: {
      async request(input, signal) {
        order.push(`approve:${input.binding.toolCallId}`)
        approvals.push(copy(input))
        return await hooks.approve?.(input, signal) ?? { binding: input.binding, decision: 'approved', expiresAt: input.expiresAt }
      },
    },
  }
  return { request, ports, hooks, controller, events, order, modelInputs, executions, approvals, emitted,
    run: () => runAgent(request, ports), setNow: (value) => { now = value },
    replaceContext: (value) => { current = copy(value) },
    get storedResult() { return storedResult }, get context() { return copy(current) } }
}

test('completion validation retains rejected responses and continues the same run only after feedback', async () => {
  const first = response([], { continuation: { opaque: 'preserved' } })
  const f = fixture([first, response([call('material-read')]), response()])
  const seen = []
  f.ports.completionValidation = { validate: async request => {
    seen.push(copy({ identity: request.identity, attempt: request.attempt, context: request.context }))
    assert.equal(f.events.at(-1).type, 'model_response')
    assert.equal(request.signal.aborted, false)
    return f.executions.length ? { kind: 'accept' } : { kind: 'continue', code: 'declared_material_reads_missing', paths: ['review.md'] }
  } }
  const result = await f.run()
  assert.equal(result.status, 'completed'); assert.equal(result.modelRequests, 3); assert.equal(result.toolCalls, 1)
  assert.deepEqual(f.executions, ['material-read'])
  assert.deepEqual(seen.map(item => item.attempt), [1, 3])
  assert.ok(seen.every(item => JSON.stringify(item.identity) === JSON.stringify(f.request.identity)))
  const rejection = f.events.find(item => item.type === 'completion_rejected')
  assert.equal(rejection.attempt, 1); assert.match(rejection.feedbackItems[0].content, /review\.md/)
  assert.deepEqual(f.modelInputs[1].context.items.slice(0, -1), [f.context.items[0], ...first.outputItems])
  assert.deepEqual(f.modelInputs[1].context.continuation, first.continuation)
  assert.deepEqual(result.usage, { inputTokens: 30, outputTokens: 6, totalTokens: 36 })
  assert.equal(f.events.filter(item => item.type === 'model_response').length, 3)
})

test('completion correction is bounded to two continuations and original model/shared budgets remain tighter', async () => {
  const reject = async () => ({ kind: 'continue', code: 'declared_material_reads_missing', paths: ['review.md'] })
  const f = fixture([response(), response(), response(), response()])
  f.ports.completionValidation = { validate: reject }
  const result = await f.run()
  assert.equal(result.status, 'failed'); assert.equal(result.reason, 'completion_validation_limit'); assert.equal(result.modelRequests, 3)
  assert.equal(f.events.filter(item => item.type === 'completion_rejected').length, 3)
  for (const mode of ['model', 'shared']) {
    const limited = fixture([response(), response()])
    limited.ports.completionValidation = { validate: reject }
    if (mode === 'model') limited.request.budget = { maxModelRequests: 1 }
    else { let consumed = 0; limited.ports.host.consumeBudget = async kind => kind !== 'model' || ++consumed < 2 }
    const stopped = await limited.run()
    assert.equal(stopped.status, 'budget_exhausted'); assert.equal(stopped.reason, mode === 'model' ? 'model_request_budget' : 'shared_model_budget')
    assert.equal(stopped.modelRequests, 1); assert.equal(limited.executions.length, 0)
  }
})

test('completion validation cancellation and active deadlines take priority before and after host checks', async () => {
  for (const mode of ['before', 'after', 'deadline']) {
    const f = fixture(); let checks = 0
    if (mode === 'before') f.hooks.append = event => { if (event.type === 'model_response') f.controller.abort() }
    f.ports.completionValidation = { validate: async () => {
      checks++
      if (mode === 'deadline') f.setNow(600001); else f.controller.abort()
      return { kind: 'continue', code: 'declared_material_reads_missing', paths: ['review.md'] }
    } }
    const result = await f.run()
    assert.equal(result.status, mode === 'deadline' ? 'budget_exhausted' : 'cancelled')
    assert.equal(checks, mode === 'before' ? 0 : 1)
    assert.equal(f.events.some(item => item.type === 'completion_rejected'), false)
  }
})

test('untrusted or failed completion validation cannot complete or leak error text', async () => {
  for (const invalid of [{ kind: 'accept', extra: 'secret' }, { kind: 'continue', code: 'declared_material_reads_missing', paths: ['../escape'] }, 'throw']) {
    const f = fixture()
    f.ports.completionValidation = { validate: async () => { if (invalid === 'throw') throw new Error('secret failure'); return invalid } }
    const result = await f.run()
    assert.equal(result.status, 'failed'); assert.equal(result.reason, 'completion_validation_failed')
    assert.equal(JSON.stringify(f.events).includes('secret'), false)
  }
})

test('completion feedback persistence failure retains recovery state and sends no extra model request', async () => {
  const f = fixture()
  f.ports.completionValidation = { validate: async () => ({ kind: 'continue', code: 'declared_material_reads_missing', paths: ['review.md'] }) }
  f.hooks.append = event => { if (event.type === 'completion_rejected') throw new Error('disk failure') }
  const result = await f.run()
  assert.equal(result.status, 'recovery_required'); assert.equal(result.committed, false); assert.equal(result.modelRequests, 1)
  assert.equal(f.events.some(item => item.type === 'model_response'), true)
  assert.equal(f.events.some(item => item.type === 'run_finished'), false)
})

test('whole response is committed before ordered tools, and full opaque context survives normal continuation', async () => {
  const first = response([call('a'), call('b', 'write')], { continuation: { encrypted_state: 'preserved' } })
  const f = fixture([first, response()])
  f.hooks.execute = async (prepared) => {
    const committed = f.events.find((event) => event.type === 'model_response')
    assert.deepEqual(committed.response, first)
    assert.equal(f.events.at(-1).type, 'tool_prepared')
    if (prepared.call.id === 'b') assert.ok(f.events.some((e) => e.type === 'tool_completed' && e.call.id === 'a'))
    return { status: 'completed', output: { value: prepared.call.id } }
  }
  const result = await f.run()
  assert.equal(result.status, 'completed')
  assert.equal(result.committed, true)
  assert.deepEqual(f.executions, ['a', 'b'])
  assert.equal(f.approvals.length, 1)
  assert.deepEqual(f.modelInputs[1].context.items.slice(1, 4), first.outputItems)
  assert.deepEqual(f.modelInputs[1].context.continuation, first.continuation)
  assert.equal(f.modelInputs[1].context.items.filter((i) => i.type === 'function_call_output').length, 2)
  assert.equal(result.context.continuation, undefined)
  assert.deepEqual(result.usage, { inputTokens: 20, outputTokens: 4, totalTokens: 24 })
  const previous = copy(result.context.items)
  f.request.identity = { ...f.request.identity, runId: 'run2', requestId: 'request2', workerGeneration: 2 }
  f.request.input = 'continue'
  f.hooks.generate = async () => response()
  const next = await f.run()
  assert.equal(next.status, 'completed')
  assert.deepEqual(f.modelInputs[2].context.items.slice(0, -1), previous)
  assert.deepEqual(f.modelInputs[2].context.items.at(-1), { role: 'user', content: 'continue' })
})

test('partial streaming arguments never execute and late streaming events are ignored', async () => {
  const f = fixture()
  let late
  f.hooks.generate = async (input) => {
    input.onEvent({ type: 'tool_arguments_delta', callId: 'a', delta: '{"pa' })
    assert.equal(f.executions.length, 0)
    late = input.onEvent
    return response()
  }
  assert.equal((await f.run()).status, 'completed')
  const count = f.emitted.length
  late({ type: 'text_delta', text: 'late' })
  assert.equal(f.emitted.length, count)
})

test('invalid JSON, non-object arguments and unknown tools get truthful failed results without execution', async () => {
  const f = fixture([response([{ ...call('a'), arguments: '{' }, call('b', 'read', []), call('c', 'missing')]), response()])
  assert.equal((await f.run()).status, 'completed')
  assert.equal(f.executions.length, 0)
  assert.equal(f.events.filter((e) => e.type === 'tool_completed' && e.result.status === 'failed').length, 3)
})

test('a multi-tool stale CAS receives safe revision feedback and succeeds only after reading the current task', async () => {
  const f = fixture()
  let revision = 1, round = 0
  const continuation = { encrypted_state: 'keep-the-opaque-provider-state' }
  f.hooks.generate = input => {
    const outputs = input.context.items.filter(item => item.type === 'function_call_output')
    const result = id => JSON.parse(outputs.find(item => item.call_id === id).output)
    if (round++ === 0) return response([
      call('first-update', 'write', { expectedRevision: 1 }),
      call('stale-update', 'write', { expectedRevision: 1 }),
    ], { continuation })
    if (round === 2) {
      assert.deepEqual(input.context.continuation, continuation)
      assert.deepEqual(result('first-update'), { status: 'completed', output: { revision: 2 } })
      assert.deepEqual(result('stale-update'), { status: 'failed', output: { error: 'task_revision_changed', currentRevision: 2, readTask: true, executed: false } })
      return response([call('read-current-task', 'read', {})])
    }
    if (round === 3) {
      const current = result('read-current-task')
      assert.equal(current.status, 'completed')
      return response([call('corrected-update', 'write', { expectedRevision: current.output.revision })])
    }
    assert.equal(round, 4, 'feedback must correct the next attempt rather than exhaust the model request budget')
    assert.deepEqual(result('corrected-update'), { status: 'completed', output: { revision: 3 } })
    return response()
  }
  f.hooks.prepare = tool => {
    if (tool.name === 'write' && JSON.parse(tool.arguments).expectedRevision !== revision) {
      throw new ToolPreparationError({ error: 'task_revision_changed', currentRevision: revision, readTask: true })
    }
  }
  f.hooks.execute = prepared => {
    if (prepared.call.name === 'write') {
      assert.equal(prepared.input.expectedRevision, revision, 'only a current CAS may execute')
      revision++
    }
    return { status: 'completed', output: { revision } }
  }
  const result = await f.run()
  assert.equal(result.status, 'completed')
  assert.equal(result.committed, true)
  assert.equal(result.modelRequests, 4)
  assert.equal(result.toolCalls, 4)
  assert.equal(revision, 3)
  assert.deepEqual(f.executions, ['first-update', 'read-current-task', 'corrected-update'])
  assert.deepEqual(f.approvals.map(item => item.binding.toolCallId), ['first-update', 'corrected-update'])
  assert.equal(f.order.includes('validate:stale-update'), false)
  assert.equal(f.events.some(event => event.type === 'tool_prepared' && event.prepared.call.id === 'stale-update'), false)
  assert.deepEqual(f.events.filter(event => event.type === 'tool_completed').map(event => event.result.status), ['completed', 'failed', 'completed', 'completed'])
})

test('trusted empty-file line feedback is returned without preparing, approving or executing the rejected tool', async () => {
  const f = fixture([response([call('outside-file', 'write')]), response()])
  f.hooks.prepare = () => { throw new ToolPreparationError({ error: 'code_location_line_range_invalid', lineCount: 0, readFile: true }) }
  assert.equal((await f.run()).status, 'completed')
  assert.deepEqual(f.events.find(event => event.type === 'tool_completed').result,
    { status: 'failed', output: { error: 'code_location_line_range_invalid', lineCount: 0, readFile: true, executed: false } })
  assert.deepEqual(f.executions, [])
  assert.deepEqual(f.approvals, [])
  assert.equal(f.events.some(event => event.type === 'tool_prepared'), false)
})

test('arbitrary and tampered preparation errors cannot disclose text or smuggle extra feedback fields', async t => {
  const secret = 'sk-preparation-secret-must-not-enter-history'
  const valid = { error: 'task_revision_changed', currentRevision: 2, readTask: true }
  const tampered = new ToolPreparationError(valid)
  tampered.feedback = { ...valid, detail: secret }
  const accessor = new ToolPreparationError(valid)
  let reads = 0
  Object.defineProperty(accessor, 'feedback', { get() { reads++; throw new Error(secret) } })
  const forged = Object.assign(Object.create(ToolPreparationError.prototype), { feedback: valid, message: secret })
  for (const [name, error] of [
    ['ordinary message', new Error(secret)],
    ['lookalike object', { name: 'ToolPreparationError', feedback: valid, message: secret }],
    ['forged prototype', forged],
    ['mutated trusted feedback', tampered],
    ['hostile feedback accessor', accessor],
  ]) await t.test(name, async () => {
    const f = fixture([response([call('rejected', 'write')]), response()])
    f.hooks.prepare = () => { throw error }
    assert.equal((await f.run()).status, 'completed')
    assert.deepEqual(f.events.find(event => event.type === 'tool_completed').result,
      { status: 'failed', output: { error: 'invalid_tool_input', executed: false } })
    assert.deepEqual(f.executions, [])
    assert.deepEqual(f.approvals, [])
    assert.equal(JSON.stringify({ events: f.events, modelInputs: f.modelInputs, emitted: f.emitted }).includes(secret), false)
  })
  assert.equal(reads, 0, 'core must not invoke an exception feedback getter')
  await t.test('even a trusted exception message is ignored', async () => {
    const f = fixture([response([call('stale', 'write')]), response()])
    const trusted = new ToolPreparationError(valid)
    trusted.message = secret
    trusted.stack = secret
    f.hooks.prepare = () => { throw trusted }
    assert.equal((await f.run()).status, 'completed')
    assert.deepEqual(f.events.find(event => event.type === 'tool_completed').result.output, { ...valid, executed: false })
    assert.equal(JSON.stringify({ events: f.events, modelInputs: f.modelInputs, emitted: f.emitted }).includes(secret), false)
  })
})

test('cancellation and active-budget exhaustion take precedence over trusted preparation feedback', async t => {
  for (const stopped of ['cancelled', 'budget_exhausted']) await t.test(stopped, async () => {
    const f = fixture([response([call('stopped', 'write'), call('not-started', 'write')])])
    f.request.budget = { maxActiveMs: 10 }
    f.hooks.prepare = () => {
      if (stopped === 'cancelled') f.controller.abort()
      else f.setNow(10)
      throw new ToolPreparationError({ error: 'task_revision_changed', currentRevision: 2, readTask: true })
    }
    const result = await f.run()
    assert.equal(result.status, stopped)
    assert.equal(result.modelRequests, 1)
    assert.deepEqual(f.executions, [])
    assert.deepEqual(f.approvals, [])
    assert.equal(f.order.includes('prepare:not-started'), false)
    const completed = f.events.filter(event => event.type === 'tool_completed')
    assert.equal(completed.length, 2)
    assert.ok(completed.every(event => event.result.status === (stopped === 'cancelled' ? 'cancelled' : 'not_executed')))
    assert.equal(JSON.stringify(completed).includes('task_revision_changed'), false)
  })
})

for (const mutation of ['sessionId', 'conversationId', 'runId', 'requestId', 'workerGeneration', 'toolCallId', 'inputDigest', 'policyRevision']) {
  test(`approval rejects mismatched ${mutation}`, async () => {
    const f = fixture([response([call('a', 'write')]), response()])
    f.hooks.approve = async (input) => ({ binding: { ...input.binding, [mutation]: 'wrong' }, decision: 'approved', expiresAt: input.expiresAt })
    assert.equal((await f.run()).status, 'completed')
    assert.equal(f.executions.length, 0)
    assert.equal(f.events.find((e) => e.type === 'tool_completed').result.status, 'denied')
  })
}

test('expired approval, changed preconditions, and refusal cannot grant execution', async (t) => {
  await t.test('expired', async () => {
    const f = fixture([response([call('a', 'write')]), response()])
    f.hooks.approve = async (input) => ({ binding: input.binding, decision: 'approved', expiresAt: -1 })
    assert.equal((await f.run()).status, 'completed')
    assert.equal(f.executions.length, 0)
  })
  await t.test('preconditions changed after approval', async () => {
    const f = fixture([response([call('a', 'write')]), response()])
    f.hooks.validate = async () => { throw new Error('changed target or instructions') }
    assert.equal((await f.run()).status, 'completed')
    assert.equal(f.executions.length, 0)
    assert.equal(f.events.some((e) => e.type === 'tool_prepared'), false)
  })
  await t.test('refusal with calls', async () => {
    const f = fixture([response([call('a', 'write')], { finishReason: 'refused' })])
    assert.equal((await f.run()).reason, 'model_refused')
    assert.equal(f.executions.length, 0)
    assert.equal(f.events.find((e) => e.type === 'tool_completed').result.status, 'not_executed')
  })
})

test('denial is not repeatedly prompted for the same input in one run', async () => {
  const f = fixture([response([call('a', 'write')]), response([call('b', 'write')]), response()])
  f.hooks.approve = async (input) => ({ binding: input.binding, decision: 'denied', expiresAt: input.expiresAt })
  assert.equal((await f.run()).status, 'completed')
  assert.equal(f.approvals.length, 1)
  assert.equal(f.executions.length, 0)
})

test('cancellation after a completed tool preserves it and produces valid results for unexecuted calls', async () => {
  const f = fixture([response([call('a', 'write'), call('b', 'write'), call('c')])])
  f.hooks.execute = async () => { f.controller.abort(); return { status: 'completed', output: { changed: true } } }
  const result = await f.run()
  assert.equal(result.status, 'cancelled')
  assert.equal(result.committed, true)
  assert.deepEqual(f.executions, ['a'])
  assert.deepEqual(f.events.filter((e) => e.type === 'tool_completed').map((e) => e.result.status), ['completed', 'cancelled', 'cancelled'])
  assert.equal(result.context.items.filter((item) => item.type === 'function_call_output').length, 3)
})

test('input digest and durable admission consume the same active budget as model requests', async (t) => {
  for (const phase of ['digest', 'admission']) await t.test(phase, async () => {
    const f = fixture()
    f.request.budget = { maxActiveMs: 10 }
    if (phase === 'digest') f.ports.host.digest = async value => { f.setNow(10); return digest(value) }
    else f.hooks.begin = async () => { f.setNow(10) }
    const result = await f.run()
    assert.equal(result.status, 'budget_exhausted')
    assert.equal(result.reason, 'active_time_budget')
    assert.equal(result.committed, true)
    assert.equal(result.modelRequests, 0)
    assert.equal(f.modelInputs.length, 0)
    assert.deepEqual(f.events.map(event => event.type), ['run_finished'])
  })
  await t.test('remaining budget reaches model deadline', async () => {
    const f = fixture()
    f.request.budget = { maxActiveMs: 10 }
    let firstDigest = true
    f.ports.host.digest = async value => { if (firstDigest) { firstDigest = false; f.setNow(3) }; return digest(value) }
    f.hooks.begin = async () => { f.setNow(7) }
    const deadline = f.ports.host.deadline
    const deadlines = []
    f.ports.host.deadline = (ms, parent) => { deadlines.push(ms); return deadline(ms, parent) }
    assert.equal((await f.run()).status, 'completed')
    assert.deepEqual(deadlines, [3])
  })
})

test('cancellation during approval never executes, and approval waiting does not consume active budget', async (t) => {
  await t.test('cancel', async () => {
    const f = fixture([response([call('a', 'write'), call('b')])])
    f.hooks.approve = async () => { f.controller.abort(); throw new Error('cancelled') }
    const result = await f.run()
    assert.equal(result.status, 'cancelled')
    assert.equal(f.executions.length, 0)
    assert.equal(f.events.filter((e) => e.type === 'tool_completed').length, 2)
  })
  await t.test('pause', async () => {
    const f = fixture([response([call('a', 'write')]), response()])
    f.request.budget = { maxActiveMs: 10 }
    f.hooks.begin = async () => { f.setNow(5) }
    f.hooks.approve = async (input) => { f.setNow(1000); return { binding: input.binding, decision: 'approved', expiresAt: input.expiresAt } }
    assert.equal((await f.run()).status, 'completed')
    assert.deepEqual(f.executions, ['a'])
  })
})

test('cancellation after preparation resolves prepared call as unexecuted', async () => {
  const f = fixture([response([call('a', 'write')])])
  f.hooks.append = async (event) => { if (event.type === 'tool_prepared') f.controller.abort() }
  const result = await f.run()
  assert.equal(result.status, 'cancelled')
  assert.equal(f.executions.length, 0)
  assert.equal(f.events.find((e) => e.type === 'tool_completed').result.status, 'cancelled')
})

for (const operation of ['model_response', 'tool_prepared', 'tool_completed']) {
  test(`durability failure at ${operation} stops before any subsequent operation`, async () => {
    const f = fixture([response([call('a', 'write'), call('b', 'write')]), response()])
    f.hooks.append = async (event) => { if (event.type === operation) throw new Error('disk failure') }
    const result = await f.run()
    assert.equal(result.status, 'recovery_required')
    assert.equal(result.committed, false)
    assert.equal(result.reason, `store_${operation}_failed`)
    assert.deepEqual(f.executions, operation === 'tool_completed' ? ['a'] : [])
    assert.equal(f.events.some((e) => e.type === 'run_finished'), false)
    assert.equal(f.modelInputs.length, 1)
  })
}

test('checkpoint failure after completed effect retains result journal but blocks more tools/model requests', async () => {
  const f = fixture([response([call('a', 'write'), call('b', 'write')]), response()])
  f.hooks.checkpoint = async () => { if (f.events.at(-1)?.type === 'tool_completed') throw new Error('checkpoint failed') }
  const result = await f.run()
  assert.equal(result.status, 'recovery_required')
  assert.equal(result.reason, 'store_checkpoint_failed')
  assert.deepEqual(f.executions, ['a'])
  assert.equal(f.events.at(-1).type, 'tool_completed')
})

test('unknown write outcome leaves unmatched prepared marker and no fabricated tool result', async () => {
  const f = fixture([response([call('a', 'write'), call('b', 'write')])])
  f.hooks.execute = async () => { throw new Error('process disappeared after effect') }
  const result = await f.run()
  assert.equal(result.status, 'recovery_required')
  assert.equal(result.committed, true)
  assert.deepEqual(f.executions, ['a'])
  assert.equal(f.events.some((e) => e.type === 'tool_completed'), false)
})

test('known tool failure is stored and sent to next model without replay', async () => {
  const f = fixture([response([call('a', 'write')]), response()])
  f.hooks.execute = async () => ({ status: 'failed', output: { error: 'exit 1' }, effects: { exitCode: 1 } })
  assert.equal((await f.run()).status, 'completed')
  assert.deepEqual(f.executions, ['a'])
  const output = f.modelInputs[1].context.items.at(-1)
  assert.equal(JSON.parse(output.output).status, 'failed')
})

test('tool, model, active-time and input-context budgets stop explicitly', async (t) => {
  await t.test('tools', async () => {
    const f = fixture([response([call('a'), call('b')])]); f.request.budget = { maxToolCalls: 1 }
    const result = await f.run()
    assert.equal(result.reason, 'tool_call_budget')
    assert.deepEqual(f.executions, ['a'])
    assert.equal(f.events.filter((e) => e.type === 'tool_completed').at(-1).result.status, 'not_executed')
  })
  await t.test('model', async () => {
    const f = fixture([response([call('a')])]); f.request.budget = { maxModelRequests: 1 }
    assert.equal((await f.run()).reason, 'model_request_budget')
    assert.equal(f.modelInputs.length, 1)
  })
  await t.test('active time', async () => {
    const f = fixture([response([call('a'), call('b')])]); f.request.budget = { maxActiveMs: 10 }
    f.hooks.execute = async () => { f.setNow(20); return { status: 'completed', output: 'done' } }
    assert.equal((await f.run()).reason, 'active_time_budget')
    assert.deepEqual(f.executions, ['a'])
  })
  await t.test('context tokens', async () => {
    const f = fixture(); f.request.budget = { maxInputTokens: 1 }
    assert.equal((await f.run()).reason, 'context_budget')
    assert.equal(f.modelInputs.length, 0)
  })
  await t.test('context bytes', async () => {
    const f = fixture(); f.request.budget = { maxContextBytes: 1 }
    assert.equal((await f.run()).reason, 'context_budget')
    assert.equal(f.context.items.length, 1)
  })
})

test('unlimited main runs exceed model, tool and active-time caps without creating active deadline timers', async () => {
  const f = fixture([
    response([call('a', 'read', { path: 'a.txt' })]),
    response([call('b', 'read', { path: 'b.txt' })]),
    response(),
  ])
  f.request.budget = { unlimited: true, maxModelRequests: 1, maxToolCalls: 1, maxActiveMs: 1 }
  let now = 0
  f.hooks.generate = input => {
    f.setNow(now += 60_000)
    assert.equal(input.signal, f.request.signal)
    assert.equal(input.signal.aborted, false)
  }
  f.ports.host.deadline = () => { throw new Error('unlimited active operations must not create deadline timers') }
  const result = await f.run()
  assert.equal(result.status, 'completed')
  assert.equal(result.modelRequests, 3)
  assert.equal(result.toolCalls, 2)
  assert.deepEqual(f.executions, ['a', 'b'])
})

test('unlimited runs keep cancellation, context, output, approval and repeated-failure protections', async t => {
  await t.test('cancellation', async () => {
    const f = fixture([response([call('a')]), response()])
    f.request.budget = { unlimited: true }
    f.hooks.execute = () => { f.controller.abort(); return { status: 'completed', output: 'done' } }
    assert.equal((await f.run()).status, 'cancelled')
    assert.equal(f.modelInputs.length, 1)
  })
  await t.test('context', async () => {
    const f = fixture()
    f.request.budget = { unlimited: true, maxInputTokens: 1 }
    assert.equal((await f.run()).reason, 'context_budget')
  })
  await t.test('output', async () => {
    const f = fixture([response([call('a')])])
    f.request.budget = { unlimited: true, maxToolOutputBytes: 1 }
    assert.equal((await f.run()).reason, 'tool_output_limit_violated')
  })
  await t.test('approval deadline', async () => {
    const f = fixture([response([call('a', 'write')]), response()])
    f.request.budget = { unlimited: true, approvalTimeoutMs: 1234 }
    const deadline = f.ports.host.deadline
    const observed = []
    f.ports.host.deadline = (milliseconds, parent) => { observed.push(milliseconds); return deadline(milliseconds, parent) }
    assert.equal((await f.run()).status, 'completed')
    assert.deepEqual(observed, [1234])
  })
  await t.test('repeated failures', async () => {
    const f = fixture([response([call('a')]), response([call('b')]), response([call('c')])])
    f.request.budget = { unlimited: true }
    f.hooks.execute = () => ({ status: 'failed', output: { error: 'failed' } })
    assert.equal((await f.run()).reason, 'tool_failure_repeated')
  })
})

test('unlimited budget mode must be a boolean', async () => {
  for (const unlimited of [0, 1, 'true', null]) {
    const f = fixture()
    f.request.budget = { unlimited }
    await assert.rejects(f.run(), /Invalid run budget: unlimited/)
    assert.equal(f.events.length, 0)
  }
})

test('storage capacity is checked before a tool can have effects', async () => {
  const f = fixture([response([call('a', 'write')])])
  f.hooks.capacity = async () => { if (f.events.some((e) => e.type === 'model_response')) throw new Error('full') }
  const result = await f.run()
  assert.equal(result.status, 'recovery_required')
  assert.equal(f.executions.length, 0)
  assert.equal(f.events.some((e) => e.type === 'tool_prepared'), false)
})

test('model failure has no automatic retry, incomplete response never executes, missing usage stays unknown', async (t) => {
  await t.test('network failure', async () => {
    const f = fixture(); f.hooks.generate = async () => { throw new Error('network') }
    assert.equal((await f.run()).reason, 'model_unknown')
    assert.equal(f.modelInputs.length, 1)
  })
  await t.test('incomplete', async () => {
    const f = fixture([response([call('a')], { finishReason: 'incomplete' })])
    assert.equal((await f.run()).reason, 'model_incomplete')
    assert.equal(f.executions.length, 0)
  })
  await t.test('usage missing', async () => {
    const f = fixture([response([call('a')], { usage: null }), response()])
    assert.equal((await f.run()).usage, null)
  })
})

test('duplicate submission returns known durable result or busy, without accepting new work', async (t) => {
  await t.test('finished', async () => {
    const f = fixture(); const result = await f.run()
    f.hooks.begin = async () => ({ kind: 'duplicate', identity: result.identity, result })
    assert.deepEqual(await f.run(), result)
    assert.equal(f.modelInputs.length, 1)
  })
  await t.test('active', async () => {
    const f = fixture(); f.hooks.begin = async () => ({ kind: 'duplicate', identity: f.request.identity })
    await assert.rejects(f.run, RunAlreadyActiveError)
    assert.equal(f.events.length, 0)
  })
  await t.test('admission error', async () => {
    const f = fixture(); f.hooks.begin = async () => { throw new Error('payload conflict') }
    await assert.rejects(f.run, /payload conflict/)
    assert.equal(f.events.length, 0)
  })
})

test('reused call identity across model responses is blocked rather than executing again', async () => {
  const f = fixture([response([call('a', 'write')]), response([call('a', 'write')])])
  const result = await f.run()
  assert.equal(result.status, 'recovery_required')
  assert.equal(result.reason, 'invalid_tool_call_identity')
  assert.deepEqual(f.executions, ['a'])
})

test('terminal projection failure reports separately from committed result and does not replay', async () => {
  const f = fixture(); f.hooks.emit = async (event) => { if (event.type === 'run_finished') throw new Error('display unavailable') }
  const result = await f.run()
  assert.equal(result.status, 'completed')
  assert.equal(result.committed, true)
  assert.equal(result.projectionError, 'projection_failed')
  assert.equal(f.storedResult.status, 'completed')
})

test('canonical input digest sorts nested keys and rejects non-JSON numbers', () => {
  assert.equal(canonicalJson({ z: 1, a: { y: 2, b: [3, null] } }), '{"a":{"b":[3,null],"y":2},"z":1}')
  assert.throws(() => canonicalJson({ number: Infinity }), /Non-finite/)
})

function maintenanceFixture(responses = [response([call('a')]), response()]) {
  const f = fixture(responses)
  f.request.budget = { maxInputTokens: 100 }
  const maintenance = []
  f.ports.contextMaintenance = {
    async maintain(request) {
      maintenance.push(request)
      f.order.push('maintain')
      return await f.hooks.maintain?.(request) ?? { kind: 'unchanged', modelRequests: 0, usage: null }
    },
  }
  const compact = (usage = { inputTokens: 5, outputTokens: 1, totalTokens: 6 }) => {
    const context = { protocol, items: [{ role: 'assistant', content: 'historical summary' }] }
    f.replaceContext(context)
    f.order.push('maintenance_commit')
    return { kind: 'compacted', modelRequests: 1, usage, context }
  }
  return { ...f, maintenance, compact }
}

test('context maintenance runs only after all tool results commit and adopts its durable replacement before continuation', async () => {
  const f = maintenanceFixture([response([call('a'), call('b', 'write')]), response()])
  f.hooks.maintain = (request) => {
    assert.equal(f.events.at(-1).type, 'tool_completed')
    assert.deepEqual(f.executions, ['a', 'b'])
    assert.equal(request.context.items.filter(item => item.type === 'function_call_output').length, 2)
    assert.equal(request.modelRequests, 1)
    assert.equal(request.toolCalls, 2)
    assert.equal(request.remainingActiveMs, 600_000)
    assert.equal(request.budget.maxInputTokens, 100)
    return f.compact()
  }
  const result = await f.run()
  assert.equal(result.status, 'completed')
  assert.equal(result.modelRequests, 3)
  assert.equal(result.toolCalls, 2)
  assert.deepEqual(result.usage, { inputTokens: 25, outputTokens: 5, totalTokens: 30 })
  assert.equal(f.maintenance.length, 1)
  assert.deepEqual(f.modelInputs[1].context.items, [{ role: 'assistant', content: 'historical summary' }])
  const commit = f.order.indexOf('maintenance_commit')
  assert.equal(f.order[commit + 1], 'checkpoint')
  assert.deepEqual(f.order.slice(commit + 2, commit + 6), ['capacity', 'model_request_started', 'model_request_diagnostic', 'model'])
})

test('unlimited main runs can summarize after nominal request and active limits have been exceeded', async () => {
  const f = maintenanceFixture()
  f.request.budget = { ...f.request.budget, unlimited: true, maxModelRequests: 1, maxToolCalls: 1, maxActiveMs: 1 }
  f.hooks.execute = () => { f.setNow(60_000); return { status: 'completed', output: 'done' } }
  f.hooks.maintain = request => {
    assert.equal(request.budget.unlimited, true)
    assert.equal(request.remainingActiveMs, 1)
    assert.equal(request.signal, f.request.signal)
    return f.compact()
  }
  const result = await f.run()
  assert.equal(result.status, 'completed')
  assert.equal(result.modelRequests, 3)
  assert.equal(f.maintenance.length, 1)
})

test('unchanged context checks refund the reserved request and can defer until a later complete boundary', async () => {
  const f = maintenanceFixture([response([call('a')]), response([call('b')]), response()])
  f.hooks.maintain = () => f.maintenance.length === 1 ? { kind: 'unchanged', modelRequests: 0, usage: null } : f.compact()
  const result = await f.run()
  assert.equal(result.status, 'completed')
  assert.equal(result.modelRequests, 4)
  assert.equal(f.maintenance.length, 2)
  assert.deepEqual(f.maintenance.map(request => request.modelRequests), [1, 2])
  assert.deepEqual(result.usage, { inputTokens: 35, outputTokens: 7, totalTokens: 42 })
})

test('maintenance makes at most one actual summary request even as subsequent tool batches grow context again', async () => {
  const f = maintenanceFixture([response([call('a')]), response([call('b')]), response([call('c')]), response()])
  f.hooks.execute = prepared => ({ status: 'completed', output: { value: prepared.call.id } })
  f.hooks.maintain = () => f.compact()
  const result = await f.run()
  assert.equal(result.status, 'completed')
  assert.equal(result.modelRequests, 5)
  assert.equal(f.maintenance.length, 1)
  assert.deepEqual(f.executions, ['a', 'b', 'c'])
})

test('maintenance never starts at admission, below threshold, or without an ordinary continuation slot', async (t) => {
  await t.test('admission hard limit', async () => {
    const f = maintenanceFixture()
    f.request.budget = { maxInputTokens: 99 }
    assert.equal((await f.run()).reason, 'context_budget')
    assert.equal(f.maintenance.length, 0)
    assert.equal(f.modelInputs.length, 0)
  })
  await t.test('below threshold', async () => {
    const f = maintenanceFixture()
    f.request.budget = { maxInputTokens: 1000 }
    assert.equal((await f.run()).status, 'completed')
    assert.equal(f.maintenance.length, 0)
  })
  await t.test('one slot remains', async () => {
    const f = maintenanceFixture()
    f.request.budget = { maxInputTokens: 100, maxModelRequests: 2 }
    assert.equal((await f.run()).modelRequests, 2)
    assert.equal(f.maintenance.length, 0)
  })
  await t.test('summary and continuation consume final two slots', async () => {
    const f = maintenanceFixture([response([call('a')]), response([call('b')])])
    f.request.budget = { maxInputTokens: 100, maxModelRequests: 3 }
    f.hooks.maintain = () => f.compact()
    const result = await f.run()
    assert.equal(result.reason, 'model_request_budget')
    assert.equal(result.modelRequests, 3)
    assert.equal(f.maintenance.length, 1)
    assert.deepEqual(f.executions, ['a', 'b'])
  })
})

test('post-compaction hard input guard still stops oversized context before another ordinary request', async () => {
  const f = maintenanceFixture()
  f.ports.model.estimateInputTokens = () => f.modelInputs.length ? 101 : 100
  f.hooks.maintain = () => f.compact()
  const result = await f.run()
  assert.equal(result.reason, 'context_budget')
  assert.equal(result.modelRequests, 2)
  assert.equal(f.modelInputs.length, 1)
})

test('known maintenance failures stop explicitly and account for attempted versus unattempted model work', async (t) => {
  for (const modelRequests of [0, 1]) await t.test(`requests ${modelRequests}`, async () => {
    const f = maintenanceFixture()
    f.hooks.maintain = () => ({ kind: 'failed', reason: 'context_maintenance_unhelpful', modelRequests, usage: null })
    const result = await f.run()
    assert.equal(result.status, 'failed')
    assert.equal(result.reason, 'context_maintenance_unhelpful')
    assert.equal(result.modelRequests, 1 + modelRequests)
    assert.equal(result.committed, true)
    assert.deepEqual(result.usage, modelRequests ? null : { inputTokens: 10, outputTokens: 2, totalTokens: 12 })
    assert.equal(f.modelInputs.length, 1)
    assert.deepEqual(f.executions, ['a'])
  })
})

test('uncertain maintenance commit stops without stale checkpoints, fabricated terminal events or another request', async () => {
  const f = maintenanceFixture()
  f.hooks.maintain = () => { f.compact(); throw new Error('durable replacement acknowledgement lost') }
  const result = await f.run()
  assert.equal(result.status, 'recovery_required')
  assert.equal(result.reason, 'store_context_maintenance_failed')
  assert.equal(result.committed, false)
  assert.equal(result.modelRequests, 2)
  assert.equal(result.usage, null)
  assert.equal(f.order.at(-1), 'maintenance_commit')
  assert.equal(f.events.some(event => event.type === 'run_finished'), false)
  assert.equal(f.modelInputs.length, 1)
  assert.deepEqual(f.executions, ['a'])
})

test('maintenance replacement is adopted before cancellation or active-time exhaustion is finalized', async (t) => {
  for (const reason of ['cancelled', 'active_time_budget']) await t.test(reason, async () => {
    const f = maintenanceFixture()
    f.request.budget = { maxInputTokens: 100, maxActiveMs: 50 }
    f.hooks.maintain = (request) => {
      assert.equal(request.remainingActiveMs, 50)
      if (reason === 'cancelled') {
        f.controller.abort()
        assert.equal(request.signal.aborted, true)
      } else f.setNow(50)
      return f.compact()
    }
    const result = await f.run()
    assert.equal(result.reason, reason)
    assert.equal(result.committed, true)
    assert.deepEqual(result.context.items, [{ role: 'assistant', content: 'historical summary' }])
    assert.equal(result.modelRequests, 2)
    assert.equal(f.modelInputs.length, 1)
    assert.ok(f.order.lastIndexOf('checkpoint') > f.order.indexOf('maintenance_commit'))
  })
})

test('failed replacement checkpoint cannot resume tools or model execution', async () => {
  const f = maintenanceFixture()
  f.hooks.maintain = () => f.compact()
  f.hooks.checkpoint = () => { if (f.order.includes('maintenance_commit')) throw new Error('checkpoint unavailable') }
  const result = await f.run()
  assert.equal(result.reason, 'store_checkpoint_failed')
  assert.equal(result.committed, false)
  assert.equal(f.modelInputs.length, 1)
  assert.deepEqual(f.executions, ['a'])
})

test('malformed maintenance results conservatively retain the reserved request and recovery barrier', async (t) => {
  for (const [label, returned] of [
    ['wrong protocol', { kind: 'compacted', modelRequests: 1, usage: null, context: { protocol: { id: 'other', version: 1 }, items: [] } }],
    ['free compaction', { kind: 'compacted', modelRequests: 0, usage: null, context: { protocol, items: [] } }],
    ['unchanged after request', { kind: 'unchanged', modelRequests: 1, usage: null }],
    ['unbounded requests', { kind: 'failed', reason: 'context_maintenance_failed', modelRequests: 2, usage: null }],
    ['invented usage', { kind: 'unchanged', modelRequests: 0, usage: { inputTokens: 1 } }],
    ['invalid usage', { kind: 'failed', reason: 'context_maintenance_failed', modelRequests: 1, usage: { inputTokens: -1 } }],
    ['untrusted error', { kind: 'failed', reason: 'raw error content', modelRequests: 1, usage: null }],
  ]) await t.test(label, async () => {
    const f = maintenanceFixture()
    f.hooks.maintain = () => returned
    const result = await f.run()
    assert.equal(result.reason, 'store_context_maintenance_failed')
    assert.equal(result.committed, false)
    assert.equal(result.modelRequests, 2)
    assert.equal(f.modelInputs.length, 1)
  })
  await t.test('replacement does not shrink', async () => {
    const f = maintenanceFixture()
    f.hooks.maintain = request => ({ kind: 'compacted', modelRequests: 1, usage: null, context: request.context })
    assert.equal((await f.run()).reason, 'store_context_maintenance_failed')
  })
})

test('compaction preserves duplicate tool identity and denied-input guards', async (t) => {
  await t.test('duplicate call identity', async () => {
    const f = maintenanceFixture([response([call('same', 'write')]), response([call('same', 'write')])])
    f.hooks.maintain = () => f.compact()
    assert.equal((await f.run()).reason, 'invalid_tool_call_identity')
    assert.deepEqual(f.executions, ['same'])
    assert.equal(f.approvals.length, 1)
  })
  await t.test('denied input is not approved again', async () => {
    const f = maintenanceFixture([response([call('first', 'write')]), response([call('again', 'write')]), response()])
    f.hooks.approve = input => ({ binding: input.binding, decision: 'denied', expiresAt: input.expiresAt })
    f.hooks.maintain = () => f.compact()
    assert.equal((await f.run()).status, 'completed')
    assert.deepEqual(f.executions, [])
    assert.equal(f.approvals.length, 1)
    assert.equal(f.events.filter(event => event.type === 'tool_completed').at(-1).result.output.error, 'approval_previously_denied')
  })
})

const transient = { category: 'rate_limit', httpStatus: 429, retryable: true }
const attempts = f => f.events.filter(event => event.type === 'model_request_started')
const failures = f => f.events.filter(event => event.type === 'model_request_failed')

test('diagnostics identify real retries separately, preserve child linkage, cache fields, and omit private text', async () => {
  const cached = { inputTokens: 20, outputTokens: 2, totalTokens: 22, cacheReadInputTokens: 8, cacheCreationInputTokens: 4, nonCachedInputTokens: 8 }
  const f = retryFixture([response([call('after-retry')], { usage: cached }), response([], { usage: cached })])
  f.request.diagnosticPurpose = 'child'
  f.request.diagnosticIdentity = { parentRunId: 'parent', childId: 'child' }
  f.ports.model.requestDiagnostics = true
  let generated = 0
  f.hooks.generate = async input => {
    await input.onRequestDiagnostic({ phase: 'request', protocol: 'fixture', payloadBytes: 100, payloadDigest: digest('private-wire-payload'), startedAt: generated === 0 ? 0 : 500 })
    await input.onRequestDiagnostic({ phase: 'dispatched', protocol: 'fixture', startedAt: generated === 0 ? 0 : 500 })
    if (++generated === 1) throw new Error('transient')
  }
  const result = await f.run()
  assert.equal(result.status, 'completed')
  assert.equal(result.usage, null, 'failed paid retry keeps aggregate usage incomplete')
  const finished = f.events.filter(event => event.type === 'model_request_diagnostic' && event.diagnostic.phase === 'finished').map(event => event.diagnostic)
  assert.deepEqual(finished.map(diagnostic => diagnostic.purpose), ['child', 'retry', 'child'])
  assert.equal(new Set(finished.map(diagnostic => diagnostic.requestKey)).size, 3)
  assert.ok(finished.every(diagnostic => diagnostic.parentRunId === 'parent' && diagnostic.childId === 'child' && diagnostic.requestSent === true))
  assert.deepEqual(finished[1].usage, cached)
  assert.equal(JSON.stringify(finished).includes('do the task'), false)
  assert.equal(JSON.stringify(finished).includes('private-wire-payload'), false)
})

test('failed diagnostic persistence prevents network and leaves recovery barrier without retry', async () => {
  const f = retryFixture()
  f.hooks.append = event => { if (event.type === 'model_request_diagnostic') throw new Error('disk unavailable') }
  const result = await f.run()
  assert.equal(result.status, 'recovery_required')
  assert.equal(result.reason, 'store_model_request_diagnostic_failed')
  assert.equal(result.committed, false)
  assert.equal(f.modelInputs.length, 0)
  assert.equal(failures(f).length, 0)
})

test('detailed input estimate and exact outgoing payload cannot bypass the independent byte budget', async t => {
  await t.test('detailed preflight', async () => {
    const f = fixture()
    f.request.budget = { maxContextBytes: 200, maxInputTokens: 10_000 }
    f.ports.model.estimateInputUsage = () => ({ estimatedInputTokens: 100, serializedBytes: 201, contextBytes: 20, method: 'tokenizer', source: 'tokenizer' })
    const result = await f.run()
    assert.equal(result.reason, 'context_budget')
    assert.equal(result.modelRequests, 0)
    assert.equal(f.modelInputs.length, 0)
  })
  await t.test('actual serialization verification', async () => {
    const f = fixture()
    f.request.budget = { maxContextBytes: 200, maxInputTokens: 10_000 }
    f.ports.model.requestDiagnostics = true
    let sent = false
    f.hooks.generate = async input => {
      await input.onRequestDiagnostic({ phase: 'request', protocol: 'fixture', payloadBytes: 201, payloadDigest: digest('oversized') })
      sent = true
    }
    const result = await f.run()
    assert.equal(result.status, 'budget_exhausted')
    assert.equal(result.reason, 'context_budget')
    assert.equal(sent, false)
    const last = f.events.filter(event => event.type === 'model_request_diagnostic').at(-1).diagnostic
    assert.equal(last.requestSent, false)
    assert.equal(last.outcome, 'failed')
  })
})

test('cache fields in normal responses and in-run summaries accumulate once with unknowns retained', async () => {
  const f = maintenanceFixture()
  const cached = { inputTokens: 10, outputTokens: 2, totalTokens: 12, cacheReadInputTokens: 3, cacheCreationInputTokens: 1, nonCachedInputTokens: 6 }
  f.hooks.generate = () => response(f.modelInputs.length === 1 ? [call('cache-read')] : [], { usage: cached })
  f.hooks.maintain = () => ({ ...f.compact(), usage: cached })
  const result = await f.run()
  assert.equal(result.status, 'completed')
  assert.equal(result.modelRequests, 3)
  assert.deepEqual(result.usage, { inputTokens: 30, outputTokens: 6, totalTokens: 36, cacheReadInputTokens: 9, cacheCreationInputTokens: 3, nonCachedInputTokens: 18 })
})
function retryFixture(responses) {
  const f = fixture(responses)
  f.request.modelRetry = 'safe_transient'
  f.hooks.classifyError = () => transient
  return f
}

test('model diagnostics reject raw fields, inconsistent HTTP classes and unsafe retries', () => {
  for (const value of [null, {}, [], { ...transient, message: 'secret' }, { ...transient, retryable: 'yes' },
    { ...transient, httpStatus: 401 }, { category: 'network', retryable: true },
    { category: 'service_error', httpStatus: 500, retryable: true }, { category: 'authentication', httpStatus: 403, retryable: true },
    { category: 'protocol', httpStatus: 200, retryable: false }, { category: 'other', retryable: false }]) {
    assert.equal(validateModelFailureDiagnostic(value), false, JSON.stringify(value))
  }
  for (const value of [transient, { category: 'service_unavailable', httpStatus: 503, retryable: true },
    { category: 'configuration', httpStatus: 422, retryable: false }, { category: 'authentication', httpStatus: 401, retryable: false },
    { category: 'service_error', httpStatus: 500, retryable: false }, { category: 'protocol', httpStatus: 302, retryable: false },
    { category: 'network', retryable: false }, { category: 'unknown', retryable: false }]) assert.equal(validateModelFailureDiagnostic(value), true)
})

test('diagnostic details accept bounded adapter enums and reject remote content in every new field', () => {
  const diagnostic = { category: 'protocol', retryable: false, protocol: 'anthropic-messages', stage: 'thinking', reason: 'invalid_thinking' }
  assert.equal(validateModelFailureDiagnostic(diagnostic), true)
  assert.equal(validateModelFailureDiagnostic({ category: 'network', retryable: false, protocol: 'openai-responses', stage: 'tool_call', reason: 'stream_disconnected' }), true)
  for (const key of ['protocol', 'stage', 'reason']) {
    for (const value of ['https://private.invalid/key', 'sk-private-body', '', '__proto__', 1, null, {}, []]) {
      assert.equal(validateModelFailureDiagnostic({ ...diagnostic, [key]: value }), false)
    }
  }
  for (const key of ['message', 'url', 'body', 'headers', 'credential']) assert.equal(validateModelFailureDiagnostic({ ...diagnostic, [key]: 'private' }), false)
  assert.equal(validateModelFailureDiagnostic({ ...diagnostic, retryable: true }), false, 'details cannot authorize protocol retries')
})

test('model attempt is durable before network and failed attempts have unknown aggregate usage', async () => {
  const f = retryFixture()
  let count = 0
  f.hooks.generate = () => {
    assert.equal(f.events.at(-1).type, 'model_request_diagnostic')
    assert.equal(f.events.at(-1).diagnostic.phase, 'started')
    if (++count === 1) throw new Error('transient')
  }
  const result = await f.run()
  assert.equal(result.status, 'completed')
  assert.equal(result.modelRequests, 2)
  assert.equal(result.usage, null)
  assert.deepEqual(attempts(f).map(event => event.attempt), [1, 2])
  assert.deepEqual(failures(f), [{ type: 'model_request_failed', attempt: 1, failure: transient, partial: false, retryDelayMs: 500 }])
  assert.ok(f.order.indexOf('model_request_failed') < f.order.indexOf('wait:500'))
  assert.deepEqual(f.modelInputs[0], f.modelInputs[1])
})

test('retry opt-in never retries without the host wait capability or the default policy', async (t) => {
  for (const kind of ['off', 'missing wait']) await t.test(kind, async () => {
    const f = retryFixture()
    if (kind === 'off') delete f.request.modelRetry
    else delete f.ports.host.wait
    f.hooks.generate = () => { throw new Error('retryable') }
    const result = await f.run()
    assert.equal(result.reason, 'model_rate_limit')
    assert.equal(result.modelRequests, 1)
    assert.equal(failures(f)[0].retryDelayMs, undefined)
  })
})

test('safe HTTP recovery has two extra requests per whole run and bounded backoff', async () => {
  const f = retryFixture()
  f.hooks.generate = () => { throw new Error('transient') }
  const result = await f.run()
  assert.equal(result.reason, 'model_retry_exhausted')
  assert.equal(result.modelRequests, 3)
  assert.deepEqual(failures(f).map(event => event.retryDelayMs), [500, 1500, undefined])
  assert.deepEqual(attempts(f).map(event => event.attempt), [1, 2, 3])
})

test('unlimited main retry eligibility ignores finite call and active limits while retaining two retries', async () => {
  const f = retryFixture()
  f.request.budget = { unlimited: true, maxModelRequests: 1, maxActiveMs: 1 }
  let count = 0
  f.hooks.generate = () => {
    f.setNow(++count * 60_000)
    if (count < 3) throw new Error('transient')
    return response()
  }
  const result = await f.run()
  assert.equal(result.status, 'completed')
  assert.equal(result.modelRequests, 3)
  assert.deepEqual(failures(f).map(event => event.retryDelayMs), [500, 1500])
})

test('successful tool batches do not reset the whole-run retry allowance or replay tools', async () => {
  const f = retryFixture()
  let count = 0
  f.hooks.generate = () => {
    count++
    if ([1, 3, 5].includes(count)) throw new Error('transient')
    return response([call(`tool-${count}`, 'write')])
  }
  const result = await f.run()
  assert.equal(result.reason, 'model_retry_exhausted')
  assert.equal(result.modelRequests, 5)
  assert.deepEqual(f.executions, ['tool-2', 'tool-4'])
  assert.equal(f.approvals.length, 2)
})

test('any accepted stream delta forbids retry and cannot be concatenated with another attempt', async (t) => {
  for (const event of [{ type: 'text_delta', text: 'partial' }, { type: 'tool_arguments_delta', callId: 'a', delta: '{' }]) {
    await t.test(event.type, async () => {
      const f = retryFixture()
      let late
      f.hooks.generate = input => { late = input.onEvent; input.onEvent(event); throw new Error('interrupted') }
      const result = await f.run()
      assert.equal(result.reason, 'model_rate_limit')
      assert.equal(result.modelRequests, 1)
      assert.equal(failures(f)[0].partial, true)
      assert.equal(failures(f)[0].retryDelayMs, undefined)
      const prior = f.emitted.length
      late(event)
      assert.equal(f.emitted.length, prior)
      assert.equal(f.executions.length, 0)
    })
  }
})

test('only sanitized adapter diagnostics are retained and unsafe errors never retry', async (t) => {
  for (const category of ['authentication', 'configuration', 'network', 'timeout', 'protocol', 'security', 'service_error', 'unknown']) {
    await t.test(category, async () => {
      const f = retryFixture()
      f.hooks.classifyError = () => ({ category, retryable: false })
      f.hooks.generate = () => { throw new Error('secret model response') }
      const result = await f.run()
      assert.equal(result.reason, `model_${category}`)
      assert.equal(result.modelRequests, 1)
      assert.equal(JSON.stringify(f.events).includes('secret model response'), false)
    })
  }
  for (const classifier of [() => ({ ...transient, raw: 'secret' }), () => { throw new Error('classifier failure') }]) {
    const f = retryFixture()
    f.hooks.classifyError = classifier
    f.hooks.generate = () => { throw new Error('secret') }
    assert.equal((await f.run()).reason, 'model_unknown')
    assert.equal(f.modelInputs.length, 1)
  }
})

test('retry respects request and active-time budgets without waiting for an impossible attempt', async (t) => {
  for (const [budget, reason] of [[{ maxModelRequests: 1 }, 'model_request_budget'], [{ maxActiveMs: 500 }, 'active_time_budget']]) {
    await t.test(reason, async () => {
      const f = retryFixture()
      f.request.budget = budget
      f.hooks.generate = () => { throw new Error('transient') }
      const result = await f.run()
      assert.equal(result.status, 'budget_exhausted')
      assert.equal(result.reason, reason)
      assert.equal(result.modelRequests, 1)
      assert.equal(failures(f)[0].retryDelayMs, undefined)
      assert.equal(f.order.some(item => item.startsWith('wait:')), false)
    })
  }
})

test('cancellation during backoff is durable and prevents a second model request', async () => {
  const f = retryFixture()
  f.hooks.generate = () => { throw new Error('transient') }
  f.hooks.wait = (_delay, signal) => { f.controller.abort(); assert.equal(signal.aborted, true); throw new Error('cancelled') }
  const result = await f.run()
  assert.equal(result.status, 'cancelled')
  assert.equal(result.modelRequests, 1)
  assert.equal(failures(f).length, 1)
  assert.equal(f.events.at(-1).type, 'run_finished')
})

test('cancellation during a model request closes its attempt without scheduling recovery', async () => {
  const f = retryFixture()
  f.hooks.generate = () => { f.controller.abort(); throw new Error('cancelled') }
  const result = await f.run()
  assert.equal(result.status, 'cancelled')
  assert.equal(result.modelRequests, 1)
  assert.equal(failures(f)[0].retryDelayMs, undefined)
})

test('attempt and failure append uncertainty leave a recovery barrier and never retry', async (t) => {
  for (const operation of ['model_request_started', 'model_request_failed']) await t.test(operation, async () => {
    const f = retryFixture()
    f.hooks.generate = () => { throw new Error('transient') }
    f.hooks.append = event => { if (event.type === operation) throw new Error('acknowledgement lost') }
    const result = await f.run()
    assert.equal(result.reason, `store_${operation}_failed`)
    assert.equal(result.committed, false)
    assert.equal(result.modelRequests, 1)
    assert.equal(f.modelInputs.length, operation === 'model_request_started' ? 0 : 1)
    assert.equal(f.events.some(event => event.type === 'run_finished'), false)
    assert.equal(f.order.some(item => item.startsWith('wait:')), false)
  })
})

test('request capacity failure consumes no attempt and sends no model request', async () => {
  const f = retryFixture()
  f.hooks.capacity = () => { throw new Error('full') }
  const result = await f.run()
  assert.equal(result.reason, 'store_capacity_failed')
  assert.equal(result.modelRequests, 0)
  assert.equal(f.modelInputs.length, 0)
})

test('three identical complete failure batches stop with all results durable', async (t) => {
  for (const status of ['failed', 'denied']) await t.test(status, async () => {
    const f = fixture([response([call('a')]), response([call('b')]), response([call('c')]), response()])
    f.hooks.execute = () => ({ status, output: { error: 'unchanged failure' } })
    const result = await f.run()
    assert.equal(result.reason, 'tool_failure_repeated')
    assert.equal(result.modelRequests, 3)
    assert.equal(f.events.filter(event => event.type === 'tool_completed').length, 3)
    assert.equal(result.committed, true)
  })
})

test('three identical read batches detect no progress, independent of call IDs and JSON key order', async () => {
  const f = fixture([response([call('a', 'read', { a: 1, b: 2 })]), response([call('b', 'read', { b: 2, a: 1 })]),
    response([call('c', 'read', { a: 1, b: 2 })]), response()])
  const result = await f.run()
  assert.equal(result.reason, 'tool_no_progress')
  assert.equal(result.modelRequests, 3)
  assert.deepEqual(f.executions, ['a', 'b', 'c'])
})

test('changed observations or successful side effects reset the stalled batch streak', async (t) => {
  await t.test('changed output', async () => {
    const f = fixture([response([call('a')]), response([call('b')]), response([call('c')]), response()])
    f.hooks.execute = prepared => ({ status: 'completed', output: prepared.call.id })
    assert.equal((await f.run()).status, 'completed')
  })
  await t.test('successful write', async () => {
    const f = fixture([response([call('a')]), response([call('b')]), response([call('c', 'write')]),
      response([call('d')]), response([call('e')]), response()])
    assert.equal((await f.run()).status, 'completed')
    assert.equal(f.executions.length, 5)
  })
})

test('host command polling remains useful with unchanged observations and is excluded from no-progress detection', async (t) => {
  for (const name of ['command_status', 'read_command_output']) await t.test(name, async () => {
    const f = fixture([response([call('a', name)]), response([call('b', name)]), response([call('c', name)]),
      response([call('d', name)]), response()])
    f.ports.tools.definitions.push({ name, description: name, inputSchema: { type: 'object' }, risk: 'read' })
    assert.equal((await f.run()).status, 'completed')
    assert.equal(f.executions.length, 4)
  })
})

test('cancellation after durable attempt start prevents network and records conservative unknown usage', async () => {
  const f = retryFixture()
  f.hooks.append = event => { if (event.type === 'model_request_started') f.controller.abort() }
  const result = await f.run()
  assert.equal(result.status, 'cancelled')
  assert.equal(result.modelRequests, 1)
  assert.equal(result.usage, null)
  assert.equal(f.modelInputs.length, 0)
  assert.deepEqual(failures(f), [{ type: 'model_request_failed', attempt: 1,
    failure: { category: 'unknown', retryable: false }, partial: false }])
})

test('retry and compaction both consume the run budget while ordinary attempts keep consecutive IDs', async () => {
  const f = maintenanceFixture()
  f.request.modelRetry = 'safe_transient'
  f.hooks.classifyError = () => transient
  let requests = 0
  f.hooks.generate = () => { if (++requests === 1) throw new Error('transient') }
  f.hooks.maintain = request => {
    assert.equal(request.modelRequests, 2)
    return f.compact()
  }
  const result = await f.run()
  assert.equal(result.status, 'completed')
  assert.equal(result.modelRequests, 4)
  assert.equal(result.usage, null)
  assert.deepEqual(attempts(f).map(event => event.attempt), [1, 2, 3])
  assert.equal(f.maintenance.length, 1)
})

test('image bytes enter the existing exact-input digest while text-only submissions stay byte compatible', async () => {
  const submissions = []
  for (const dataUrl of [undefined, 'data:image/png;base64,YQ==', 'data:image/png;base64,Yg==']) {
    const f = fixture()
    if (dataUrl) f.request.images = [{ mimeType: 'image/png', dataUrl }]
    f.ports.model.userItems = (input, images) => {
      if (!images?.length) return [{ role: 'user', content: input }]
      const items = [{ role: 'user', content: [{ type: 'input_text', text: input }, { type: 'input_image', image_url: images[0].dataUrl, detail: 'auto' }] }]
      images[0].dataUrl = 'data:image/png;base64,ZA==' // 适配器不能修改调用方持有的附件数据。
      return items
    }
    f.hooks.begin = begin => { submissions.push(copy(begin)) }
    assert.equal((await f.run()).status, 'completed')
    if (dataUrl) assert.equal(f.request.images[0].dataUrl, dataUrl)
  }
  assert.equal(new Set(submissions.map(begin => begin.inputDigest)).size, 3)
  for (const begin of submissions) assert.equal(begin.inputDigest, digest(canonicalJson({ input: begin.input, userItems: begin.userItems, protocol: begin.protocol, configuration: begin.configuration, policyRevision: begin.policyRevision })))
  assert.deepEqual(submissions[0].userItems, [{ role: 'user', content: 'do the task' }])
})

test('invalid image submissions fail before admission or any model work', async () => {
  for (const images of [null, [{ mimeType: 'image/png', dataUrl: 'https://unapproved.invalid/image.png' }]]) {
    const f = fixture()
    f.request.images = images
    await assert.rejects(f.run(), /Invalid user images/)
    assert.deepEqual(f.order, [])
  }
})

test('image maintenance refusal stops without an extra model request or a persistence recovery barrier', async () => {
  const f = maintenanceFixture()
  f.hooks.maintain = () => ({ kind: 'failed', reason: 'context_maintenance_images_unsupported', modelRequests: 0, usage: null })
  const result = await f.run()
  assert.equal(result.status, 'failed')
  assert.equal(result.reason, 'context_maintenance_images_unsupported')
  assert.equal(result.modelRequests, 1)
  assert.equal(result.committed, true)
})
