import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { isNativeImageAttachments, type NativeImageAttachment } from '@cc-desk/contracts/chat';
import { isMessage } from '../src/main/chat-history';
import { ChatAttachmentChips, NativeImageAttachments, NativeImageNotice } from '../src/renderer/NativeImageAttachments';

const image: NativeImageAttachment = { name: '提交时的图片.png', mimeType: 'image/png', bytes: 1024, sha256: 'a'.repeat(64) };

test('selected Native images expose name, format and size without opening files or sending', () => {
  const attachments = [
    { name: '<unsafe>.PNG', path: '/private/staging/one.png', bytes: 1024 },
    { name: '截图.jpeg', path: '/private/staging/two.jpeg', bytes: 2048 },
  ];
  const html = renderToStaticMarkup(createElement(ChatAttachmentChips, { attachments, isNative: true, disabled: false,
    onRemove: () => { throw new Error('rendering is read-only'); } }));
  assert.match(html, /&lt;unsafe&gt;\.PNG/);
  assert.match(html, /PNG · 1\.0 KiB/); assert.match(html, /JPEG · 2\.0 KiB/);
  assert.match(html, /aria-label="移除附件 截图.jpeg"/);
  assert.doesNotMatch(html, /\/private\/|<img|src=|href=|disabled=""/);
  const locked = renderToStaticMarkup(createElement(ChatAttachmentChips, { attachments, isNative: true, disabled: true, onRemove: () => {} }));
  assert.equal((locked.match(/disabled=""/g) ?? []).length, 2);
});

test('Claude attachment chips retain generic file behavior and contain no Native restrictions', () => {
  const attachments = [{ name: 'notes.pdf', path: '/staging/document.pdf', bytes: 8192 }];
  const html = renderToStaticMarkup(createElement(ChatAttachmentChips, { attachments, isNative: false, disabled: false, onRemove: () => {} }));
  assert.match(html, /title="\/staging\/document.pdf"/); assert.match(html, /notes.pdf/);
  assert.doesNotMatch(html, /不支持|PNG|KiB/);
  assert.equal(renderToStaticMarkup(createElement(ChatAttachmentChips, { attachments: [], isNative: true, disabled: false, onRemove: () => {} })), '');
});

test('Native image notice explains explicit send, retention, capacity and pending compatibility without adding consent controls', () => {
  const html = renderToStaticMarkup(createElement(NativeImageNotice));
  for (const text of ['PNG / JPEG', '最多 4 张', '1 MiB', '点击发送后', '保存在本机会话及原始记录中', '图片能力尚未验证', '编码字节', '提高输入预算', '首个含图回合之前的纯文本历史', '之后的记录完整保留', '首轮就含图或保留内容超预算']) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /<input|<button|<img|src=/);
});

test('image history renders immutable version metadata with escaped text and no image or file access', () => {
  const images = [image, { ...image, name: '<img onerror=alert(1)>.jpg', mimeType: 'image/jpeg' as const, bytes: 2048 }];
  const html = renderToStaticMarkup(createElement(NativeImageAttachments, { images }));
  for (const text of ['提交时的图片.png', 'PNG', 'JPEG', '1.0 KiB', '2.0 KiB', image.sha256, '本次提交时的图片版本', '不会读取原文件', '不包含图像内容']) assert.ok(html.includes(text), text);
  assert.match(html, /&lt;img onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img|src=|href=|<button/);
});

test('history accepts bounded metadata on user messages and rejects payloads, paths, invalid types and oversized records', () => {
  const message = { id: 'one', turnId: 'turn', role: 'user', text: '', createdAt: 'now', nativeImageAttachments: [image] };
  assert.equal(isMessage(message), true);
  assert.equal(isMessage({ ...message, nativeImageAttachments: undefined }), true, 'old text history stays readable');
  assert.equal(isMessage({ ...message, role: 'assistant' }), false);
  const invalid: unknown[] = [undefined, null, {}, [], Array(5).fill(image), [{ ...image, data: 'PRIVATE-PAYLOAD' }], [{ ...image, url: 'file:///private.png' }],
    [{ ...image, name: '/private.png' }], [{ ...image, name: 'C:\\private.png' }], [{ ...image, name: 'bad\nname.png' }], [{ ...image, name: '' }],
    [{ ...image, mimeType: 'image/gif' }], [{ ...image, bytes: -1 }], [{ ...image, bytes: 1.5 }], [{ ...image, bytes: 0 }], [{ ...image, bytes: 1024 * 1024 + 1 }],
    [{ ...image, bytes: 600000 }, { ...image, bytes: 600000 }], [{ ...image, sha256: 'bad' }]];
  for (const value of invalid) assert.equal(isNativeImageAttachments(value), false, JSON.stringify(value));
  assert.equal(isNativeImageAttachments([{ ...image, bytes: 1024 * 1024 }]), true);
  assert.equal(isMessage({ ...message, nativeImageAttachments: [{ ...image, data: 'PRIVATE-PAYLOAD' }] }), false);
});
