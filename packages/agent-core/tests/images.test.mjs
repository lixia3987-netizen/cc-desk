import test from 'node:test'
import assert from 'node:assert/strict'
import { MAX_USER_IMAGES, MAX_USER_IMAGE_BYTES, MAX_USER_IMAGES_BYTES, validateUserImages, contextHasUserImages, estimateContextInputTokens } from '../dist/index.js'

const image = (data = Buffer.from([137, 80, 78, 71]), mimeType = 'image/png') => ({ mimeType, dataUrl: `data:${mimeType};base64,${data.toString('base64')}` })

test('inline image transport accepts exact count/decoded size limits and leaves canonical bytes unchanged', () => {
  assert.equal(MAX_USER_IMAGES, 4)
  assert.equal(MAX_USER_IMAGE_BYTES, 1024 * 1024)
  assert.equal(MAX_USER_IMAGES_BYTES, 1024 * 1024)
  const images = Array.from({ length: 4 }, () => image(Buffer.alloc(MAX_USER_IMAGES_BYTES / 4)))
  const saved = JSON.stringify(images)
  validateUserImages(images)
  assert.equal(JSON.stringify(images), saved)
  validateUserImages([image(Buffer.alloc(MAX_USER_IMAGE_BYTES))])
  validateUserImages([image(Buffer.from([255, 216, 255]), 'image/jpeg')])
  validateUserImages([])
  assert.throws(() => validateUserImages([...images, image()]), /Invalid user images/)
  assert.throws(() => validateUserImages([image(Buffer.alloc(MAX_USER_IMAGE_BYTES + 1))]), /Invalid user images/)
  assert.throws(() => validateUserImages([image(Buffer.alloc(MAX_USER_IMAGES_BYTES)), image()]), /Invalid user images/)
})

for (const [name, value] of [
  ['not array', {}], ['null', null], ['missing element', [undefined]],
  ['extra field', [{ ...image(), url: 'https://secret.invalid/a.png' }]],
  ['MIME mismatch', [{ ...image(), mimeType: 'image/jpeg' }]],
  ['unsupported SVG', [{ mimeType: 'image/svg+xml', dataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' }]],
  ['remote URL', [{ ...image(), dataUrl: 'https://secret.invalid/a.png' }]],
  ['file URL', [{ ...image(), dataUrl: 'file:///secret.png' }]],
  ['non-base64', [{ ...image(), dataUrl: 'data:image/png,%89PNG' }]],
  ['whitespace', [{ ...image(), dataUrl: 'data:image/png;base64,Y Q==' }]],
  ['empty payload', [{ ...image(), dataUrl: 'data:image/png;base64,' }]],
  ['missing padding', [{ ...image(), dataUrl: 'data:image/png;base64,YQ' }]],
  ['padding-only', [{ ...image(), dataUrl: 'data:image/png;base64,====' }]],
  ['noncanonical two padding', [{ ...image(), dataUrl: 'data:image/png;base64,YR==' }]],
  ['noncanonical one padding', [{ ...image(), dataUrl: 'data:image/png;base64,YWL=' }]],
  ['extra parameters', [{ ...image(), dataUrl: 'data:image/png;charset=UTF-8;base64,YQ==' }]],
]) test(`inline image transport rejects ${name} without disclosing contents`, () => {
  assert.throws(() => validateUserImages(value), error => error.message === 'Invalid user images: expected bounded inline PNG or JPEG data')
})

test('image history detection retains conservative byte accounting without estimating model image tokens', () => {
  for (const part of [{ type: 'input_image', image_url: image().dataUrl, detail: 'auto' }, { type: 'image_url', image_url: { url: image().dataUrl, detail: 'auto' } }]) {
    const context = { protocol: { id: 'fixture', version: 1 }, items: [{ role: 'user', content: [part] }] }
    assert.equal(contextHasUserImages(context), true)
    assert.equal(estimateContextInputTokens(context), Buffer.byteLength(JSON.stringify(context.items)))
    assert.equal(contextHasUserImages({ ...context, items: [{ role: 'assistant', content: [part] }] }), false)
  }
  assert.equal(contextHasUserImages({ protocol: { id: 'fixture', version: 1 }, items: [{ role: 'user', content: 'input_image' }] }), false)
})
