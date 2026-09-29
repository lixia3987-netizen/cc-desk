import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { runAgent, canonicalJson, RunAlreadyActiveError, validateModelFailureDiagnostic } from '../dist/index.js'

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
    f.ports.host.digest = async value => { f.setNow(3); return digest(value) }
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
  assert.deepEqual(f.order.slice(commit + 2, commit + 5), ['capacity', 'model_request_started', 'model'])
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

test('model attempt is durable before network and failed attempts have unknown aggregate usage', async () => {
  const f = retryFixture()
  let count = 0
  f.hooks.generate = () => {
    assert.equal(f.events.at(-1).type, 'model_request_started')
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
