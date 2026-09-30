import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { OpenDialogOptions, OpenDialogReturnValue } from 'electron';
import { Attachments } from '../src/main/attachments';
import type { Attachment, DesktopAPI, DraftAttachment, Session } from '../src/shared/types';
import { NATIVE_IMAGE_MAX_BYTES, NATIVE_IMAGE_MAX_COUNT, type NativePastedImage } from '../src/shared/native-images';

const require = createRequire(import.meta.url), electronPath = require.resolve('electron'), previousElectron = require.cache[electronPath];
let picker: (options: OpenDialogOptions) => Promise<OpenDialogReturnValue> = async () => ({ canceled: true, filePaths: [] });
let exposedDesktop: DesktopAPI | undefined;
const ipcInvocations: unknown[][] = [];
require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true,
  exports: {
    dialog: { showOpenDialog: (_window: unknown, options: OpenDialogOptions) => picker(options) },
    contextBridge: { exposeInMainWorld: (name: string, api: DesktopAPI) => { assert.equal(name, 'desktop'); exposedDesktop = api; } },
    ipcRenderer: { invoke: (...args: unknown[]) => { ipcInvocations.push(args); return Promise.resolve([]); } },
    webUtils: { getPathForFile: () => { throw new Error('Pasted images must not resolve disk paths.'); } },
  },
} as NodeModule;
after(() => { if (previousElectron) require.cache[electronPath] = previousElectron; else delete require.cache[electronPath]; });

async function fixture(providerId = 'native') {
  const { registerChatHandlers } = await import('../src/main/ipc/chat-handlers');
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'native-image-ipc-')));
  const id = randomUUID(), attachments = new Attachments(path.join(root, 'data'));
  const session: Session = { id, projectId: randomUUID(), title: 'Images', kind: 'agent', cwd: root,
    execution: { providerId, mode: 'structured', conversationId: randomUUID() }, engineConfig: { schemaVersion: 1, options: {} },
    status: 'idle', started: false, archived: false, createdAt: 'now', updatedAt: 'now' };
  const handlers = new Map<string, (value: unknown) => unknown>(), sent: unknown[][] = [];
  const admission = { generation: 0, deleted: false, locked: false };
  const ports = {
    structured: (value: string) => { assert.equal(value, id); if (admission.deleted) throw new Error('会话已删除。'); return session; }, attachments,
    assertUnlocked: () => { if (admission.locked) throw new Error('会话正在维护。'); },
    captureAdmission: () => { const generation = admission.generation; return () => { if (generation !== admission.generation) throw new Error('会话操作已失效。'); }; },
    getWindow: () => null,
    workflows: { isSessionBusy: () => false },
    queue: { references: () => false, removeAttachment: (_id: string, _path: string, remove: () => Promise<void>) => remove() },
    runChat: async (...args: unknown[]) => { sent.push(args); return { success: true, summary: '' }; },
  } as unknown as Parameters<typeof registerChatHandlers>[1];
  registerChatHandlers((name, schema, action) => handlers.set(name, input => action(schema.parse(input))), ports);
  const call = async <T>(name: string, input: unknown): Promise<T> => await handlers.get(name)!(input) as T;
  const source = path.join(root, '显式选择.png');
  await fs.writeFile(source, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64'));
  const pastedImage: NativePastedImage = { mimeType: 'image/png', dataUrl: `data:image/png;base64,${(await fs.readFile(source)).toString('base64')}` };
  return { root, id, session, attachments, sent, call, source, pastedImage, admission, dispose: () => fs.rm(root, { recursive: true, force: true }) };
}

test('Native picker is restricted to PNG/JPEG and stages without sending; image-only send stays explicit', async () => {
  const f = await fixture();
  try {
    picker = async options => {
      assert.deepEqual(options.filters, [{ name: 'PNG / JPEG 图片', extensions: ['png', 'jpg', 'jpeg'] }]);
      assert.match(options.title!, /4 张.*1 MiB/);
      return { canceled: false, filePaths: [f.source] };
    };
    const selected = await f.call<Attachment[]>('files:pick', f.id);
    assert.equal(selected[0].name, '显式选择.png'); assert.equal(f.sent.length, 0);
    assert.deepEqual(await f.call('files:attachments', f.id), selected);
    await f.call('chat:send', { id: f.id, text: '', attachments: [selected[0].path] });
    assert.deepEqual(f.sent, [[f.id, '', [selected[0].path], undefined, undefined]]);
  } finally { await f.dispose(); }
});

test('Native dropped invalid images roll back their batch and preserve existing drafts', async () => {
  const f = await fixture();
  try {
    const before = await f.call<Attachment[]>('files:add-dropped', { id: f.id, paths: [f.source] });
    const invalid = path.join(f.root, 'text.txt'); await fs.writeFile(invalid, 'not an image');
    await assert.rejects(f.call('files:add-dropped', { id: f.id, paths: [f.source, invalid] }), /PNG|JPEG/);
    assert.deepEqual(await f.call('files:attachments', f.id), before); assert.equal(f.sent.length, 0);
    assert.equal((await fs.readdir(path.dirname(before[0].path))).filter(name => name.startsWith('.staged-')).length, 1);
  } finally { await f.dispose(); }
});

test('picker cancellation and archiving during picker wait do not stage or send images', async () => {
  const f = await fixture();
  try {
    picker = async () => ({ canceled: true, filePaths: [f.source] });
    assert.deepEqual(await f.call('files:pick', f.id), []);
    picker = async () => { f.session.archived = true; return { canceled: false, filePaths: [f.source] }; };
    await assert.rejects(f.call('files:pick', f.id), /归档/);
    assert.deepEqual(await f.attachments.list(f.id), []); assert.equal(f.sent.length, 0);
  } finally { await f.dispose(); }
});

test('Claude picker and drop keep their existing text/PDF/generic image behavior', async () => {
  const f = await fixture('claude');
  try {
    const source = path.join(f.root, '说明.txt'); await fs.writeFile(source, 'Existing Claude text attachment.');
    picker = async options => {
      assert.equal(options.title, '添加上下文附件');
      for (const ext of ['png', 'gif', 'webp', 'pdf', 'txt']) assert.ok(options.filters?.[0].extensions.includes(ext));
      return { canceled: false, filePaths: [source] };
    };
    assert.equal((await f.call<Attachment[]>('files:pick', f.id))[0].name, '说明.txt');
    assert.equal((await f.call<Attachment[]>('files:add-dropped', { id: f.id, paths: [source] }))[0].name, '说明.txt');
    assert.equal((await f.attachments.list(f.id)).length, 2); assert.equal(f.sent.length, 0);
  } finally { await f.dispose(); }
});

test('Native pasted PNG bytes become private draft files without starting a send', async () => {
  const f = await fixture();
  try {
    const pasted = await f.call<Attachment[]>('files:add-pasted-native-images', { id: f.id, images: [f.pastedImage] });
    assert.equal(pasted.length, 1);
    assert.notEqual(pasted[0].path, f.source);
    assert.match(path.basename(pasted[0].path), /^\.staged-[\da-f-]+\.png$/);
    assert.deepEqual(await fs.readFile(pasted[0].path), await fs.readFile(f.source));
    assert.deepEqual(await f.call('files:attachments', f.id), pasted);
    assert.deepEqual(f.sent, []);
    await f.call('chat:send', { id: f.id, text: '', attachments: [pasted[0].path] });
    assert.deepEqual(f.sent, [[f.id, '', [pasted[0].path], undefined, undefined]]);
  } finally { await f.dispose(); }
});

test('paste IPC rejects unknown fields, unsupported images, count and encoded size overflows before storage', async () => {
  const f = await fixture();
  try {
    let imports = 0;
    const original = f.attachments.addNativePastedImages.bind(f.attachments);
    f.attachments.addNativePastedImages = (...args) => { imports++; return original(...args); };
    const encodedLimit = 4 * Math.ceil(NATIVE_IMAGE_MAX_BYTES / 3);
    const payloads = [
      { id: f.id, images: [] },
      { id: f.id, images: Array.from({ length: NATIVE_IMAGE_MAX_COUNT + 1 }, () => f.pastedImage) },
      { id: f.id, images: [{ mimeType: 'image/gif', dataUrl: f.pastedImage.dataUrl }] },
      { id: f.id, images: [{ ...f.pastedImage, path: f.source }] },
      { id: f.id, images: [{ ...f.pastedImage, name: 'remote.png' }] },
      { id: f.id, images: [f.pastedImage], paths: [f.source] },
      { id: f.id, images: [{ ...f.pastedImage, dataUrl: new Uint8Array([1, 2, 3]) }] },
      { id: f.id, images: [{ ...f.pastedImage, dataUrl: 'A'.repeat(encodedLimit + 24) }] },
      { id: f.id, images: Array.from({ length: 2 }, () => ({ ...f.pastedImage, dataUrl: 'A'.repeat(encodedLimit) })) },
    ];
    for (const payload of payloads) await assert.rejects(f.call('files:add-pasted-native-images', payload));
    assert.equal(imports, 0);
    assert.deepEqual(await f.attachments.list(f.id), []);
    assert.deepEqual(f.sent, []);
  } finally { await f.dispose(); }
});

test('paste IPC delegates actual image validation to storage and preserves prior drafts on rejection', async () => {
  const f = await fixture();
  try {
    const before = await f.call<Attachment[]>('files:add-dropped', { id: f.id, paths: [f.source] });
    await assert.rejects(f.call('files:add-pasted-native-images', { id: f.id, images: [
      f.pastedImage, { mimeType: 'image/png', dataUrl: 'data:image/png;base64,bm90IGFuIGltYWdl' },
    ] }), /PNG|JPEG|图片/);
    assert.deepEqual(await f.attachments.list(f.id), before);
    assert.equal((await fs.readdir(path.dirname(before[0].path))).filter(name => name.startsWith('.staged-')).length, 1);
    assert.deepEqual(f.sent, []);
  } finally { await f.dispose(); }
});

test('paste IPC refuses Claude and Native terminal sessions', async () => {
  const f = await fixture('claude');
  try {
    const payload = { id: f.id, images: [f.pastedImage] };
    await assert.rejects(f.call('files:add-pasted-native-images', payload), /只有自研 Agent/);
    f.session.execution = { ...f.session.execution, providerId: 'native', mode: 'terminal' };
    await assert.rejects(f.call('files:add-pasted-native-images', payload), /只有自研 Agent/);
    assert.deepEqual(await f.attachments.list(f.id), []);
    assert.deepEqual(f.sent, []);
  } finally { await f.dispose(); }
});

test('paste IPC checks archived, maintenance and deletion state before attempting storage', async () => {
  const f = await fixture();
  try {
    let imports = 0;
    f.attachments.addNativePastedImages = async () => { imports++; return []; };
    const payload = { id: f.id, images: [f.pastedImage] };
    f.session.archived = true;
    await assert.rejects(f.call('files:add-pasted-native-images', payload), /归档/);
    f.session.archived = false; f.admission.locked = true;
    await assert.rejects(f.call('files:add-pasted-native-images', payload), /维护/);
    f.admission.locked = false; f.admission.deleted = true;
    await assert.rejects(f.call('files:add-pasted-native-images', payload), /删除/);
    assert.equal(imports, 0); assert.deepEqual(f.sent, []);
  } finally { await f.dispose(); }
});

test('paste admission is checked again after waiting for an earlier attachment operation', async t => {
  for (const reason of ['generation', 'archived', 'maintenance', 'deleted', 'provider'] as const) {
    await t.test(reason, async () => {
      const f = await fixture();
      try {
        const before = await f.call<Attachment[]>('files:add-dropped', { id: f.id, paths: [f.source] });
        const earlier = f.attachments.list(f.id);
        const pending = f.call('files:add-pasted-native-images', { id: f.id, images: [f.pastedImage] });
        if (reason === 'generation') f.admission.generation++;
        if (reason === 'archived') f.session.archived = true;
        if (reason === 'maintenance') f.admission.locked = true;
        if (reason === 'deleted') f.admission.deleted = true;
        if (reason === 'provider') f.session.execution.providerId = 'claude';
        await earlier;
        await assert.rejects(pending, /失效|归档|维护|删除|只有自研 Agent/);
        assert.deepEqual(await f.attachments.list(f.id), before);
        assert.equal((await fs.readdir(path.dirname(before[0].path))).filter(name => name.startsWith('.staged-')).length, 1);
        assert.deepEqual(f.sent, []);
      } finally { await f.dispose(); }
    });
  }
});

test('preload forwards only explicit paste bytes through the dedicated IPC channel', async () => {
  await import('../src/preload/index');
  assert.ok(exposedDesktop);
  const images: NativePastedImage[] = [{ mimeType: 'image/png', dataUrl: 'data:image/png;base64,AA==' }];
  assert.deepEqual(ipcInvocations, []);
  await exposedDesktop.addPastedNativeImages('explicit-session', images);
  assert.deepEqual(ipcInvocations, [['files:add-pasted-native-images', { id: 'explicit-session', images }]]);
});


test('first-send draft staging uses Native image validation and keeps Claude generic attachments', async () => {
  for (const provider of ['native', 'claude']) {
    const f = await fixture(provider);
    try {
      const selected = await f.call<DraftAttachment[]>('files:add-dropped-draft', [f.source]);
      const staged = await f.call<Attachment[]>('files:stage-draft', { id: f.id, files: selected });
      assert.equal(staged.length, 1);
      assert.notEqual(staged[0].path, f.source);
      const text = path.join(f.root, 'first-message.txt'); await fs.writeFile(text, 'Text attachment');
      const textSelection = await f.call<DraftAttachment[]>('files:add-dropped-draft', [text]);
      if (provider === 'native') {
        await assert.rejects(f.call('files:stage-draft', { id: f.id, files: textSelection }), /PNG|JPEG/);
        assert.deepEqual(await f.attachments.list(f.id), staged);
        await f.call('files:stage-draft', { id: f.id, files: [...selected, ...selected, ...selected] });
        const before = await f.attachments.list(f.id);
        await assert.rejects(f.call('files:stage-draft', { id: f.id, files: selected }), /Native 图片附件/);
        assert.deepEqual(await f.attachments.list(f.id), before);
      } else {
        const textCopy = await f.call<Attachment[]>('files:stage-draft', { id: f.id, files: textSelection });
        assert.equal(await fs.readFile(textCopy[0].path, 'utf8'), 'Text attachment');
      }
      assert.deepEqual(f.sent, [], 'staging never starts a model turn');
    } finally { await f.dispose(); }
  }
});

test('first-send draft staging rechecks captured admission after asynchronous source verification', async () => {
  const f = await fixture();
  try {
    const selected = await f.call<DraftAttachment[]>('files:add-dropped-draft', [f.source]);
    const pending = f.call('files:stage-draft', { id: f.id, files: selected });
    f.admission.generation++;
    await assert.rejects(pending, /操作已失效/);
    assert.deepEqual(await f.attachments.list(f.id), []);
    assert.deepEqual(f.sent, []);
  } finally { await f.dispose(); }
});


test('pre-session preview IPC requires an inspected selection and never stages or sends', async () => {
  const f = await fixture();
  try {
    const [selected] = await f.call<DraftAttachment[]>('files:add-dropped-draft', [f.source]);
    const selection = { selectionId: selected.selectionId, path: selected.path };
    const preview = await f.call<import('../src/shared/native-images').NativeImagePreview>('files:preview-draft-native-image', selection);
    assert.equal(preview.image.name, selected.name);
    assert.equal(preview.dataUrl, f.pastedImage.dataUrl);
    for (const input of [{ ...selection, selectionId: randomUUID() }, { ...selection, path: path.join(f.root, 'other.png') },
      { ...selection, sessionId: f.id }, { ...selection, url: 'https://example.invalid/image.png' }]) {
      await assert.rejects(f.call('files:preview-draft-native-image', input));
    }
    assert.deepEqual(f.sent, []);
    await assert.rejects(fs.stat(path.join(f.root, 'data')), { code: 'ENOENT' });
  } finally { await f.dispose(); }
});

test('preload exposes selected pre-session image preview only through its narrow read-only IPC', async () => {
  await import('../src/preload/index');
  const before = ipcInvocations.length, selection = { selectionId: randomUUID(), path: '/selected/image.png' };
  await exposedDesktop!.previewDraftNativeImage(selection);
  assert.deepEqual(ipcInvocations.slice(before), [['files:preview-draft-native-image', selection]]);
});
