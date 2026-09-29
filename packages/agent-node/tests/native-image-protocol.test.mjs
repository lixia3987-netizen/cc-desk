import test from 'node:test'
import assert from 'node:assert/strict'
import { estimateContextInputTokens } from '@cc-desk/agent-core'
import { ResponsesModel } from '../dist/responses-model.js'
import { ChatCompletionsModel } from '../dist/chat-completions-model.js'
import { requireCompleteContext } from '../dist/context-maintenance.js'
import { startResponsesFixture, assistantMessage } from './fixtures/responses-server.mjs'
import { startChatCompletionsFixture } from './fixtures/chat-completions-server.mjs'

const identity = { sessionId: 'session', conversationId: 'conversation', runId: 'run', requestId: 'request', workerGeneration: 1 }
const png = { mimeType: 'image/png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }
const jpeg = { mimeType: 'image/jpeg', dataUrl: 'data:image/jpeg;base64,/9j/' }
const bodyPart = (chat, image = png) => chat ? { type: 'image_url', image_url: { url: image.dataUrl, detail: 'auto' } } : { type: 'input_image', image_url: image.dataUrl, detail: 'auto' }
const textPart = (chat, text) => ({ type: chat ? 'text' : 'input_text', text })
const request = (model, items) => ({ identity, context: { protocol: model.protocol, items }, tools: [], maxOutputTokens: 1000, signal: new AbortController().signal, onEvent: () => {} })

for (const [label, Model, chat] of [['Responses', ResponsesModel, false], ['Chat Completions', ChatCompletionsModel, true]]) {
  async function setup(t, options = {}) {
    const server = chat ? await startChatCompletionsFixture() : await startResponsesFixture({ handler: () => ({ output: [assistantMessage('final', 'Image inspected')] }) })
    t.after(() => server.close())
    const modelOptions = { model: 'fixture', baseURL: server.baseURL, allowLoopbackHttp: true, ...options }
    return { server, model: new Model(modelOptions), modelOptions }
  }

  test(`${label} keeps no-image request shape and sends ordered text + bounded inline images`, async t => {
    const { model, server, modelOptions } = await setup(t)
    assert.equal(JSON.stringify(model.userItems('exact text')), '[{"role":"user","content":"exact text"}]')
    assert.deepEqual(model.userItems('exact text', []), model.userItems('exact text'))
    const items = model.userItems('Compare these images', [png, jpeg])
    assert.deepEqual(items, [{ role: 'user', content: [textPart(chat, 'Compare these images'), bodyPart(chat), bodyPart(chat, jpeg)] }])
    requireCompleteContext({ protocol: model.protocol, items })
    const response = await model.generate(request(model, items))
    assert.deepEqual(chat ? server.requests[0].messages : server.requests[0].input, items)
    assert.deepEqual(response.usage, { inputTokens: 11, outputTokens: 7, totalTokens: 18 })
    const history = JSON.parse(JSON.stringify([...items, ...response.outputItems, ...model.userItems('Continue')]))
    const restarted = new Model(modelOptions)
    await restarted.generate(request(restarted, history))
    assert.deepEqual(chat ? server.requests[1].messages : server.requests[1].input, history)
    assert.deepEqual(server.errors, [])
    const context = { protocol: model.protocol, items }
    // Empty tool catalog serializes to [] in both estimators; image bytes retain their full cost.
    assert.equal(model.estimateInputTokens(context), estimateContextInputTokens(context, '[]'))
  })

  test(`${label} rejects remote, malformed, unbounded and assistant image content before sending`, async t => {
    const { model, server } = await setup(t)
    const remote = chat ? { type: 'image_url', image_url: { url: 'https://unapproved.invalid/image.png', detail: 'auto' } } : { type: 'input_image', image_url: 'https://unapproved.invalid/image.png', detail: 'auto' }
    const extra = chat ? { type: 'image_url', image_url: { url: png.dataUrl, detail: 'auto', file_id: 'hidden' } } : { ...bodyPart(chat), file_id: 'hidden' }
    const missingDetail = chat ? { type: 'image_url', image_url: { url: png.dataUrl } } : { type: 'input_image', image_url: png.dataUrl }
    const huge = { mimeType: 'image/png', dataUrl: `data:image/png;base64,${Buffer.alloc(1024 * 1024).toString('base64')}` }
    for (const content of [[remote], [extra], [missingDetail], Array.from({ length: 5 }, () => bodyPart(chat)), [bodyPart(chat, huge), bodyPart(chat)]]) {
      const items = [{ role: 'user', content }]
      assert.throws(() => requireCompleteContext({ protocol: model.protocol, items }), { code: 'unsupported_protocol' })
      await assert.rejects(model.generate(request(model, items)), { code: 'protocol' })
    }
    const assistant = [{ role: 'assistant', content: [bodyPart(chat)] }]
    assert.throws(() => requireCompleteContext({ protocol: model.protocol, items: assistant }), { code: 'unsupported_protocol' })
    await assert.rejects(model.generate(request(model, assistant)), { code: 'protocol' })
    assert.equal(server.requests.length, 0)
  })

  test(`${label} image payloads remain covered by credential and transport-size guards`, async t => {
    const { model, server } = await setup(t, { apiKey: 'c2VjcmV0', maxRequestBytes: 600 })
    const protectedImage = { mimeType: 'image/png', dataUrl: 'data:image/png;base64,c2VjcmV0' }
    await assert.rejects(model.generate(request(model, model.userItems('', [protectedImage]))), { code: 'credential_echo' })
    const image = { mimeType: 'image/png', dataUrl: `data:image/png;base64,${Buffer.alloc(1000).toString('base64')}` }
    await assert.rejects(model.generate(request(model, model.userItems('', [image]))), { code: 'request_limit' })
    assert.equal(server.requests.length, 0)
  })
}

test('Responses rejects assistant image outputs without persisting them as passive message content', async t => {
  for (const content of [[{ type: 'output_image', image_url: png.dataUrl }], [{ type: 'input_image', image_url: png.dataUrl, detail: 'auto' }]]) {
    const server = await startResponsesFixture({ handler: () => ({ output: [{ type: 'message', role: 'assistant', content }] }) })
    t.after(() => server.close())
    const model = new ResponsesModel({ model: 'fixture', baseURL: server.baseURL, allowLoopbackHttp: true })
    await assert.rejects(model.generate(request(model, model.userItems('test'))), { code: 'schema' })
  }
})

test('Responses host validation rejects forged user attachments and assistant image output from a worker', async () => {
  const { nativeResponseCalls } = await import('../dist/context-maintenance.js')
  const protocol = { id: 'openai-responses', version: 1 }
  for (const item of [
    { type: 'message', role: 'user', content: [bodyPart(false)] },
    { role: 'user', content: [bodyPart(false)] },
    { type: 'future_passive_item', role: 'user', content: [bodyPart(false)] },
    { type: 'message', role: 'assistant', content: [bodyPart(false)] },
    { type: 'output_image', image_url: png.dataUrl },
  ]) assert.throws(() => nativeResponseCalls(protocol, [item]), { code: 'unsupported_protocol' })
  const passive = { type: 'future_passive_item', data: { opaque: 'kept' } }
  assert.deepEqual(nativeResponseCalls(protocol, [passive, assistantMessage('final', 'text')]), [])
})
