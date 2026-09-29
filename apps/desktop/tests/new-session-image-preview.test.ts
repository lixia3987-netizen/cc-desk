import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NativeImagePreviewBody } from '../src/renderer/NativeImagePreview';
import { ChatAttachmentChips } from '../src/renderer/NativeImageAttachments';
import { isNewSessionImagePreviewCurrent, NewSessionImagePreviewController, scheduleNewSessionImagePreview, validateUnsavedPastedImage, type NewSessionImagePreviewSelection, type NewSessionImagePreviewState } from '../src/renderer/workspace/new-session-image-preview-state';
import type { NativePastedDraftAttachment } from '../src/renderer/workspace/new-session-submission';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAADAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDi6KKK+ZP3E//Z','base64');
const file = { selectionId: 'selection', path: '/selected.png', name: 'selected.png', bytes: png.length };
const disk: NewSessionImagePreviewSelection = { owner: 'blank-one', file };
const preview = { image: { name: file.name, mimeType: 'image/png', bytes: png.length, sha256: createHash('sha256').update(png).digest('hex') }, dataUrl: `data:image/png;base64,${png.toString('base64')}` };
const memory: NativePastedDraftAttachment = { ...file, kind: 'native-paste', selectionId: 'paste-one', path: 'paste:one', image: { mimeType: 'image/png', dataUrl: preview.dataUrl } };
const stateOf = (controller: NewSessionImagePreviewController): NewSessionImagePreviewState => controller.state;
const deferred = <T>() => { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test('unsaved preview is explicit: disk sends only token/path and memory performs no IPC or invents no receipt', async () => {
  const requests: unknown[] = [];
  const controller = new NewSessionImagePreviewController(async request => { requests.push(request); return preview; }, () => {});
  assert.equal(stateOf(controller).status, 'idle'); assert.deepEqual(requests, []);
  await controller.open(disk);
  assert.deepEqual(requests, [{ selectionId: file.selectionId, path: file.path }]);
  assert.equal(stateOf(controller).status, 'ready'); controller.close();
  await controller.open({ owner: disk.owner, file: memory });
  assert.equal(stateOf(controller).status, 'ready'); assert.equal(requests.length, 1);
  assert.ok(!JSON.stringify(stateOf(controller)).includes('sha256'));
});

test('close, replacement and unmount discard late unsaved-preview bytes and errors', async () => {
  const late = deferred<unknown>(), controller = new NewSessionImagePreviewController(() => late.promise, () => {});
  const pending = controller.open(disk); controller.close(); late.resolve(preview); await pending;
  assert.deepEqual(stateOf(controller), { status: 'idle' });
  const old = deferred<unknown>(), changed = new NewSessionImagePreviewController(() => old.promise, () => {});
  const prior = changed.open(disk); await changed.open({ owner: 'blank-two', file: memory });
  const current = changed.state; old.reject(new Error('/private/path')); await prior;
  assert.strictEqual(changed.state, current);
  const delayed = deferred<unknown>(), unmounted = new NewSessionImagePreviewController(() => delayed.promise, () => {});
  const reading = unmounted.open(disk); unmounted.close(false); delayed.resolve(preview); await reading;
  assert.deepEqual(unmounted.state, { status: 'idle' });
});

test('StrictMode and removal before effect setup never create duplicate or hidden reads', async () => {
  let reads = 0;
  const controller = new NewSessionImagePreviewController(async () => { reads++; return preview; }, () => {});
  const first = scheduleNewSessionImagePreview(controller, disk); first();
  const live = scheduleNewSessionImagePreview(controller, disk);
  assert.equal(reads, 0); await Promise.resolve(); assert.equal(reads, 1); live();
  const removed = scheduleNewSessionImagePreview(controller, disk); removed();
  await Promise.resolve(); assert.equal(reads, 1);
});

test('blank, provider, removed attachment and changed paste identities invalidate visibility', () => {
  assert.equal(isNewSessionImagePreviewCurrent(disk, disk.owner, 'native', [file]), true);
  assert.equal(isNewSessionImagePreviewCurrent(disk, 'other', 'native', [file]), false);
  assert.equal(isNewSessionImagePreviewCurrent(disk, disk.owner, 'claude', [file]), false);
  assert.equal(isNewSessionImagePreviewCurrent(disk, disk.owner, 'native', []), false);
  assert.equal(isNewSessionImagePreviewCurrent(disk, disk.owner, 'native', [{ ...file, selectionId: 'new' }]), false);
  assert.equal(isNewSessionImagePreviewCurrent({ owner: disk.owner, file: memory }, disk.owner, 'native', [{ ...memory, image: { ...memory.image, dataUrl: 'changed' } }]), false);
});

test('unsaved paste rejects URLs, noncanonical bytes, wrong MIME, excess bytes and decoded dimensions', () => {
  assert.equal(validateUnsavedPastedImage(memory), preview.dataUrl);
  const jpegUrl = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
  assert.equal(validateUnsavedPastedImage({ ...memory, bytes: jpeg.length, image: { mimeType: 'image/jpeg', dataUrl: jpegUrl } }), jpegUrl);
  const largeJpeg = Buffer.from(jpeg);
  const frame = largeJpeg.indexOf(Buffer.from([255, 192])); largeJpeg.writeUInt16BE(4097, frame + 7);
  assert.throws(() => validateUnsavedPastedImage({ ...memory, bytes: largeJpeg.length, image: { mimeType: 'image/jpeg', dataUrl: `data:image/jpeg;base64,${largeJpeg.toString('base64')}` } }));
  for (const dataUrl of ['https://example.test/image.png', 'file:///private/image.png', 'data:image/svg+xml;base64,AAAA', preview.dataUrl + '=']) assert.throws(() => validateUnsavedPastedImage({ ...memory, image: { ...memory.image, dataUrl } }));
  assert.throws(() => validateUnsavedPastedImage({ ...memory, bytes: 1024 * 1024 + 1 }));
  const large = Buffer.from(png); large.writeUInt32BE(4097, 16);
  assert.throws(() => validateUnsavedPastedImage({ ...memory, image: { ...memory.image, dataUrl: `data:image/png;base64,${large.toString('base64')}` } }));
  assert.throws(() => validateUnsavedPastedImage({ ...memory, image: { mimeType: 'image/jpeg', dataUrl: preview.dataUrl.replace('image/png', 'image/jpeg') } }));
});

test('disk receipt mismatch and decoding failure discard image bytes and permit an explicit retry', async () => {
  let load = { ...preview, image: { ...preview.image, name: 'wrong.png' } };
  const controller = new NewSessionImagePreviewController(async () => load, () => {});
  await controller.open(disk); assert.equal(stateOf(controller).status, 'error'); load = preview;
  await controller.retry();
  const state = stateOf(controller);
  if (state.status !== 'ready') assert.fail('retry should succeed');
  controller.decodeFailed(state.version); assert.equal(stateOf(controller).status, 'error');
  assert.ok(!JSON.stringify(stateOf(controller)).includes('dataUrl'));
});

test('unsaved labels remain distinct and attachment chips never decode images before the explicit action', () => {
  const html = renderToStaticMarkup(createElement(NativeImagePreviewBody, { name: file.name, bytes: file.bytes, versionLabel: '当前选择版本（尚未保存）', state: { status: 'ready', version: 1, dataUrl: preview.dataUrl }, onClose() {}, onRetry() {}, onDecodeError() {} }));
  assert.match(html, /当前选择版本（尚未保存）/); assert.doesNotMatch(html, /发送时的图片版本|当前暂存版本|SHA-256/);
  const chips = renderToStaticMarkup(createElement(ChatAttachmentChips, { attachments: [file], isNative: true, disabled: false, onRemove() {}, onPreview() {}, previewTitle: '本地预览当前选择版本（尚未保存）' }));
  assert.match(chips, /预览待发送图片/); assert.doesNotMatch(chips, /data:image|<img/);
});
