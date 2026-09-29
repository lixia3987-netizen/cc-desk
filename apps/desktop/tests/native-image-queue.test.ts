import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { NativeImageAttachment, QueuedChatMessage } from '@cc-desk/contracts/chat';
import { ChatQueue } from '../src/main/chat-queue';
import { ChatQueueStorage } from '../src/main/chat-queue-storage';

const image = (hash = 'a'.repeat(64)): NativeImageAttachment => ({ name: 'screen.png', mimeType: 'image/png', bytes: 80, sha256: hash });

async function setup(t: TestContext) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'native-image-queue-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let metadata = [image()], blocked = true, accepted = 0;
  const dispatched: QueuedChatMessage[] = [];
  const options = {
    assertAvailable: () => {}, blocked: () => blocked,
    attachmentMetadata: async () => structuredClone(metadata),
    acceptAttachments: async (_id: string, _files: string[], commit: (names?: string[]) => void) => { accepted++; commit(['screen.png']); },
    run: async (_id: string, item: QueuedChatMessage) => { dispatched.push(item); return { success: true, summary: '' }; },
    interrupt: async () => {}, changed: () => {},
  };
  return { directory, queue: new ChatQueue(directory, options), options, dispatched,
    change: (value: NativeImageAttachment[]) => { metadata = value; }, unblock: () => { blocked = false; }, accepted: () => accepted };
}

test('queue acknowledgement binds image bytes even when paths and text remain unchanged', async t => {
  const f = await setup(t), files = ['/staged/screen.png'];
  const first = await f.queue.submit('session', 'Inspect this', files, 'same-request');
  assert.deepEqual(f.queue.snapshot('session').items[0].nativeImageAttachments, [image()]);
  assert.deepEqual(await f.queue.submit('session', 'Inspect this', files, 'same-request'), first);
  assert.equal(f.accepted(), 1);
  f.change([image('b'.repeat(64))]);
  await assert.rejects(f.queue.submit('session', 'Inspect this', files, 'same-request'), /不同内容/);
  assert.equal(f.accepted(), 1);
  assert.deepEqual(f.queue.snapshot('session').items[0].nativeImageAttachments, [image()]);
});

test('queue restart keeps the accepted image hashes and sends them as execution preconditions', async t => {
  const f = await setup(t);
  await f.queue.submit('session', '', ['/staged/screen.png'], 'image-only');
  // Let the old process's scheduled wake observe its blocked state before
  // simulating a replacement process; a real restart cannot keep both alive.
  await new Promise(resolve => setImmediate(resolve));
  f.change([image('b'.repeat(64))]);
  const restarted = new ChatQueue(f.directory, f.options);
  assert.equal(restarted.snapshot('session').paused, true);
  assert.deepEqual(restarted.snapshot('session').items[0].nativeImageAttachments, [image()]);
  f.unblock();
  await restarted.resume('session');
  for (let i = 0; i < 30 && !f.dispatched.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.dispatched.length, 1);
  assert.deepEqual(f.dispatched[0].nativeImageAttachments, [image()], 'dispatch must not replace accepted hashes with later file metadata');
  for (let i = 0; i < 30 && restarted.hasActive('session'); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(restarted.hasActive('session'), false);
});

test('invalid image snapshots and cancellation during capture are rejected before queue acknowledgement', async t => {
  const f = await setup(t);
  f.change([image('not-a-hash')]);
  await assert.rejects(f.queue.submit('session', '', ['/staged/screen.png']), /快照无效/);
  assert.equal(f.accepted(), 0);
  assert.deepEqual(f.queue.snapshot('session').items, []);
  let allowed = true;
  const queue = new ChatQueue(f.directory, { ...f.options,
    captureAdmission: () => () => { if (!allowed) throw new Error('admission cancelled'); },
    attachmentMetadata: async () => { allowed = false; return [image()]; },
  });
  await assert.rejects(queue.submit('other-session', '', ['/staged/screen.png']), /admission cancelled/);
  assert.deepEqual(queue.snapshot('other-session').items, []);
});

test('queue persistence rejects image metadata that does not match attachment count', async t => {
  const f = await setup(t);
  await f.queue.submit('session', '', ['/staged/screen.png']);
  const storage = new ChatQueueStorage(f.directory), saved = storage.load('session');
  saved.items[0].attachments = [];
  assert.throws(() => storage.save('session', saved));
  assert.equal(storage.load('session').items[0].attachments.length, 1);
});
