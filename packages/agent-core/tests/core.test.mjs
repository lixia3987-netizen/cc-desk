import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { runAgent, canonicalJson, RunAlreadyActiveError } from '../dist/index.js'

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
    run: () => runAgent(request, ports), setNow: (value) => { now = value }, get storedResult() { return storedResult }, get context() { return copy(current) } }
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
    assert.equal((await f.run()).reason, 'model_request_failed')
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
