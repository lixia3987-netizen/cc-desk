import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { OpenDialogOptions, OpenDialogReturnValue } from 'electron';
import { Attachments } from '../src/main/attachments';
import type { Attachment, Session } from '../src/shared/types';

const require = createRequire(import.meta.url), electronPath = require.resolve('electron'), previousElectron = require.cache[electronPath];
let picker: (options: OpenDialogOptions) => Promise<OpenDialogReturnValue> = async () => ({ canceled: true, filePaths: [] });
require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true,
  exports: { dialog: { showOpenDialog: (_window: unknown, options: OpenDialogOptions) => picker(options) } },
} as NodeModule;
after(() => { if (previousElectron) require.cache[electronPath] = previousElectron; else delete require.cache[electronPath]; });

async function fixture(providerId = 'native') {
  const { registerChatHandlers } = await import('../src/main/ipc/chat-handlers');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-image-ipc-'));
  const id = randomUUID(), attachments = new Attachments(path.join(root, 'data'));
  const session: Session = { id, projectId: randomUUID(), title: 'Images', kind: 'agent', cwd: root,
    execution: { providerId, mode: 'structured', conversationId: randomUUID() }, engineConfig: { schemaVersion: 1, options: {} },
    status: 'idle', started: false, archived: false, createdAt: 'now', updatedAt: 'now' };
  const handlers = new Map<string, (value: unknown) => unknown>(), sent: unknown[][] = [];
  const ports = {
    structured: (value: string) => { assert.equal(value, id); return session; }, attachments,
    assertUnlocked: () => {}, captureAdmission: () => () => {}, getWindow: () => null,
    workflows: { isSessionBusy: () => false },
    queue: { references: () => false, removeAttachment: (_id: string, _path: string, remove: () => Promise<void>) => remove() },
    runChat: async (...args: unknown[]) => { sent.push(args); return { success: true, summary: '' }; },
  } as unknown as Parameters<typeof registerChatHandlers>[1];
  registerChatHandlers((name, schema, action) => handlers.set(name, input => action(schema.parse(input))), ports);
  const call = async <T>(name: string, input: unknown): Promise<T> => await handlers.get(name)!(input) as T;
  const source = path.join(root, '显式选择.png');
  await fs.writeFile(source, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64'));
  return { root, id, session, attachments, sent, call, source, dispose: () => fs.rm(root, { recursive: true, force: true }) };
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
