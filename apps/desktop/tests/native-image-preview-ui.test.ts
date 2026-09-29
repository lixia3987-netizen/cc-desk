import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { NativeImagePreview } from '../src/shared/native-images';
import { ChatAttachmentChips, NativeImageAttachments } from '../src/renderer/NativeImageAttachments';
import { NativeImagePreviewContent } from '../src/renderer/NativeImagePreview';
import { NativeImagePreviewController, isNativeImagePreviewCurrent, scheduleNativeImagePreview, validateNativeImagePreview,
  type NativeImagePreviewSelection, type NativeImagePreviewState } from '../src/renderer/native-image-preview-state';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
function fixture(name = '图片.png', bytes = png) {
  const image = { name, mimeType: 'image/png' as const, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  const preview: NativeImagePreview = { image, dataUrl: `data:image/png;base64,${bytes.toString('base64')}` };
  const history: NativeImagePreviewSelection = { request: { sessionId: 'session', conversationId: 'conversation', source: { kind: 'history', runId: 'run', index: 0, sha256: image.sha256 } }, expected: { ...image } };
  const draft: NativeImagePreviewSelection = { request: { sessionId: 'session', conversationId: 'conversation', source: { kind: 'draft', path: '/private/staged/image.png' } }, expected: { name, bytes: image.bytes } };
  return { image, preview, history, draft, attachment: { name, bytes: image.bytes, path: '/private/staged/image.png' } };
}
const readState = (controller: NativeImagePreviewController): NativeImagePreviewState => controller.state;
const deferred = <T>() => { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test('preview controller stays idle until explicit open, then validates the requested image without mutating the selection', async () => {
  const f = fixture(), requests: unknown[] = [], states: NativeImagePreviewState[] = [];
  const controller = new NativeImagePreviewController(async request => { requests.push(request); return f.preview; }, state => states.push(state));
  assert.equal(readState(controller).status, 'idle'); assert.deepEqual(requests, []);
  const before = structuredClone(f.history), pending = controller.open(f.history);
  assert.equal(readState(controller).status, 'loading');
  await pending;
  assert.equal(readState(controller).status, 'ready');
  assert.deepEqual(requests, [f.history.request]); assert.deepEqual(f.history, before);
  assert.deepEqual(states.map(state => state.status), ['loading', 'ready']);
  controller.close(); assert.deepEqual(readState(controller), { status: 'idle' });
});

test('late preview success after close cannot restore image bytes or a request', async () => {
  const f = fixture(), load = deferred<NativeImagePreview>(), states: NativeImagePreviewState[] = [];
  const controller = new NativeImagePreviewController(() => load.promise, state => states.push(state));
  const pending = controller.open(f.draft); controller.close(); const count = states.length;
  load.resolve(f.preview); await pending;
  assert.deepEqual(readState(controller), { status: 'idle' }); assert.equal(states.length, count);
  assert.ok(!JSON.stringify(readState(controller)).includes('data:'));
});

test('StrictMode effect setup-cleanup-setup starts exactly one preview read and does not trip host concurrency', async () => {
  const f = fixture(), load = deferred<NativeImagePreview>(), ready = deferred<void>(); let calls = 0;
  const controller = new NativeImagePreviewController(async () => { if (++calls > 1) throw new Error('BUSY'); return load.promise; }, state => { if (state.status === 'ready') ready.resolve(); });
  const firstCleanup = scheduleNativeImagePreview(controller, f.history);
  firstCleanup();
  const secondCleanup = scheduleNativeImagePreview(controller, f.history);
  assert.equal(calls, 0, 'effects never dispatch during setup');
  await Promise.resolve(); assert.equal(calls, 1);
  load.resolve(f.preview); await ready.promise;
  assert.equal(readState(controller).status, 'ready'); assert.equal(calls, 1);
  secondCleanup(); assert.deepEqual(readState(controller), { status: 'idle' });
  const removed = scheduleNativeImagePreview(controller, f.draft); removed();
  await Promise.resolve(); assert.equal(calls, 1, 'unmounted preview does not begin an IPC request');
});

test('changing image or session clears prior bytes immediately and ignores delayed results from the old source', async () => {
  const a = fixture('A.png'), b = fixture('B.png'), delayedA = deferred<NativeImagePreview>(), delayedB = deferred<NativeImagePreview>();
  const requests: unknown[] = [];
  const controller = new NativeImagePreviewController(request => { requests.push(request); return requests.length === 1 ? delayedA.promise : delayedB.promise; }, () => {});
  const first = controller.open(a.history);
  const secondSelection = structuredClone(b.history); secondSelection.request.sessionId = 'other-session'; secondSelection.request.conversationId = 'other-conversation';
  const second = controller.open(secondSelection);
  assert.equal(readState(controller).status, 'loading'); assert.ok(!('preview' in readState(controller)));
  delayedB.resolve(b.preview); await second; assert.equal(readState(controller).status, 'ready');
  const settled = readState(controller);
  delayedA.resolve(a.preview); await first;
  assert.strictEqual(readState(controller), settled);
  const current = readState(controller);
  if (current.status !== 'ready') throw new Error('ready required');
  assert.equal(current.preview.image.name, 'B.png');
  assert.equal(current.selection.request.sessionId, 'other-session');
});

test('late rejection after unmount is discarded, while explicit retries clear the error and old decoder callbacks', async () => {
  const f = fixture(), old = deferred<NativeImagePreview>(), retry = deferred<NativeImagePreview>(); let calls = 0;
  const states: NativeImagePreviewState[] = [];
  const controller = new NativeImagePreviewController(() => ++calls === 1 ? old.promise : calls === 2 ? Promise.resolve(f.preview) : retry.promise, state => states.push(state));
  const pending = controller.open(f.history); controller.close(false); const count = states.length;
  old.reject(new Error('C:\\secret\\raw-path')); await pending;
  assert.equal(states.length, count); assert.deepEqual(readState(controller), { status: 'idle' });
  await controller.open(f.history);
  const loaded = readState(controller);
  if (loaded.status !== 'ready') throw new Error('ready required');
  const version = loaded.version;
  controller.decodeFailed(version); assert.equal(readState(controller).status, 'error');
  assert.ok(!('preview' in readState(controller)), 'failed image payload is discarded');
  const pendingRetry = controller.retry(); assert.equal(readState(controller).status, 'loading');
  controller.decodeFailed(version); assert.equal(readState(controller).status, 'loading');
  retry.resolve(f.preview); await pendingRetry;
  assert.equal(readState(controller).status, 'ready');
  controller.decodeFailed(version); assert.equal(readState(controller).status, 'ready', 'old decoder cannot corrupt the retried image');
});

test('local preview failures use fixed Chinese text and never show filesystem, provider or payload errors', async () => {
  const f = fixture();
  for (const selection of [f.draft, f.history]) {
    const controller = new NativeImagePreviewController(async () => { throw new Error('PRIVATE-path C:\\credentials sk-secret data:image/png;base64,bad'); }, () => {});
    await controller.open(selection);
    assert.equal(readState(controller).status, 'error');
    assert.doesNotMatch(JSON.stringify(readState(controller)), /PRIVATE-path|credentials|sk-secret|data:image/);
    const failed = readState(controller);
    if (failed.status !== 'error') throw new Error('error required');
    assert.match(failed.message, /无法读取/);
  }
});

test('draft removal, queue acceptance, session changes and changed draft metadata invalidate an open selection', () => {
  const f = fixture();
  assert.equal(isNativeImagePreviewCurrent(f.draft, 'session', 'conversation', [f.attachment]), true);
  assert.equal(isNativeImagePreviewCurrent(f.draft, 'session', 'conversation', []), false);
  assert.equal(isNativeImagePreviewCurrent(f.draft, 'other', 'conversation', [f.attachment]), false);
  assert.equal(isNativeImagePreviewCurrent(f.draft, 'session', 'other', [f.attachment]), false);
  assert.equal(isNativeImagePreviewCurrent(f.draft, 'session', 'conversation', [{ ...f.attachment, name: 'changed.png' }]), false);
  assert.equal(isNativeImagePreviewCurrent(f.draft, 'session', 'conversation', [{ ...f.attachment, bytes: f.image.bytes + 1 }]), false);
  assert.equal(isNativeImagePreviewCurrent(f.history, 'session', 'conversation', []), true);
  assert.equal(isNativeImagePreviewCurrent(f.history, 'session', undefined, []), false);
});

test('renderer validates MIME, bounded bytes, exact names and history hashes before accepting a data URL', async () => {
  const f = fixture();
  const invalid: unknown[] = [null, { ...f.preview, extra: 'unexpected' },
    ...['https://example.invalid/picture.png', 'file:///private.png', 'blob:private', 'data:image/svg+xml;base64,PHN2Zz4=', f.preview.dataUrl + '\n'].map(dataUrl => ({ ...f.preview, dataUrl })),
    { ...f.preview, image: { ...f.image, bytes: NaN } }, { ...f.preview, image: { ...f.image, bytes: Infinity } },
    { ...f.preview, image: { ...f.image, bytes: 1024 * 1024 + 1 } }, { ...f.preview, image: { ...f.image, bytes: f.image.bytes + 1 } },
    { ...f.preview, image: { ...f.image, mimeType: 'image/jpeg' } }, { ...f.preview, image: { ...f.image, name: 'different.png' } },
    { ...f.preview, image: { ...f.image, sha256: 'b'.repeat(64) } }, { ...f.preview, image: { ...f.image, path: '/private.png' } },
    { ...f.preview, dataUrl: f.preview.dataUrl.replace(/.$/, '!') }];
  for (const value of invalid) await assert.rejects(validateNativeImagePreview(value, f.history), /图片预览数据无效/);
  const differentRequest = structuredClone(f.history); if (differentRequest.request.source.kind !== 'history') throw new Error('history required');
  differentRequest.request.source.sha256 = 'b'.repeat(64);
  await assert.rejects(validateNativeImagePreview(f.preview, differentRequest), /图片预览数据无效/);
  const corrupt = structuredClone(f.preview); corrupt.dataUrl = `data:image/png;base64,${Buffer.concat([png.subarray(0, png.length - 1), Buffer.from([png.at(-1)! ^ 1])]).toString('base64')}`;
  await assert.rejects(validateNativeImagePreview(corrupt, f.draft), /图片预览数据无效/);
  assert.deepEqual(await validateNativeImagePreview(f.preview, f.draft), f.preview);
});

test('preview validation accepts the byte ceiling and rejects larger payloads before decoding', async () => {
  const bytes = Buffer.alloc(1024 * 1024); png.subarray(0, 8).copy(bytes);
  const f = fixture('ceiling.png', bytes);
  assert.deepEqual(await validateNativeImagePreview(f.preview, f.history), f.preview);
  await assert.rejects(validateNativeImagePreview({ ...f.preview, dataUrl: f.preview.dataUrl + 'AAAA' }, f.history), /图片预览数据无效/);
});

test('preview buttons are explicit, disabled with draft actions, and absent from Claude chips', () => {
  const f = fixture(), onPreview = () => { throw new Error('render cannot request a preview'); };
  const draft = renderToStaticMarkup(createElement(ChatAttachmentChips, { attachments: [f.attachment], isNative: true, disabled: false, onRemove: () => {}, onPreview }));
  assert.match(draft, /aria-label="预览待发送图片 图片.png"/); assert.match(draft, /本地预览当前暂存版本/);
  assert.doesNotMatch(draft, /<img|src=|\/private\//);
  const locked = renderToStaticMarkup(createElement(ChatAttachmentChips, { attachments: [f.attachment], isNative: true, disabled: true, onRemove: () => {}, onPreview }));
  assert.equal((locked.match(/disabled=""/g) ?? []).length, 2);
  const claude = renderToStaticMarkup(createElement(ChatAttachmentChips, { attachments: [f.attachment], isNative: false, disabled: false, onRemove: () => {}, onPreview }));
  assert.doesNotMatch(claude, /预览待发送图片|<img|src=/);
  const history = renderToStaticMarkup(createElement(NativeImageAttachments, { images: [f.image], onPreview }));
  assert.match(history, /aria-label="预览已发送图片 图片.png"/); assert.doesNotMatch(history, /<img|src=/);
});

test('modal content renders loading, validated image, retry and version labels without showing stale source bytes', async () => {
  const f = fixture('<安全图片>.png'), controller = new NativeImagePreviewController(async () => f.preview, () => {});
  const render = (selection: NativeImagePreviewSelection, state: NativeImagePreviewState) => renderToStaticMarkup(createElement(NativeImagePreviewContent, { selection, state, onClose: () => {}, onRetry: () => {}, onDecodeError: () => {} }));
  const loading = render(f.draft, { status: 'idle' });
  assert.match(loading, /当前暂存版本/); assert.match(loading, /role="status"/); assert.match(loading, /关闭图片预览/);
  assert.doesNotMatch(loading, /<img|src=|\/private/);
  await controller.open(f.history);
  const ready = render(f.history, readState(controller));
  assert.match(ready, /发送时的图片版本/); assert.match(ready, /仅本地查看/); assert.match(ready, /<img/); assert.match(ready, /&lt;安全图片&gt;/);
  assert.match(ready, /src="data:image\/png;base64,/); assert.doesNotMatch(ready, /role="alert"|重试预览|href=/);
  const other = fixture('Other.png');
  assert.doesNotMatch(render(other.history, readState(controller)), /<img|src=/, 'new selection never renders old ready state');
  const displayed = readState(controller);
  if (displayed.status !== 'ready') throw new Error('ready required');
  controller.decodeFailed(displayed.version);
  const failed = render(f.history, readState(controller));
  assert.match(failed, /role="alert"/); assert.match(failed, /重试预览/); assert.match(failed, /图片无法显示/);
  assert.doesNotMatch(failed, /<img|src=/);
});
