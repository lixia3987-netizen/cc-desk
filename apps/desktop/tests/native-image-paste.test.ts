import assert from 'node:assert/strict';
import test from 'node:test';
import type { Attachment, Session } from '../src/shared/types';
import type { ExecutionDescriptor } from '../src/shared/execution';
import { NATIVE_IMAGE_MAX_BYTES } from '../src/shared/native-images';
import { capturePastedFiles, importNativePastedImages, nativePasteTargetAvailable, readNativePastedImages, withAttachmentImport } from '../src/renderer/native-image-paste';

const file = (size = 3, type = 'image/png', read?: () => Promise<ArrayBuffer>): File => ({ size, type, arrayBuffer: read ?? (async () => new Uint8Array(size).fill(7).buffer) }) as File;
const transfer = (files: File[]) => ({ files, getData: () => { throw new Error('Text, HTML and URLs must stay browser-owned'); } }) as unknown as DataTransfer;
const session = (patch: Partial<Session> = {}): Session => ({ id: 'origin', archived: false, execution: { providerId: 'native', mode: 'structured', conversationId: 'conversation-a' }, engineConfig: { schemaVersion: 1, options: {} }, ...patch }) as Session;
const descriptor = (patch: Partial<ExecutionDescriptor> = {}): ExecutionDescriptor => ({ providerId: 'native', mode: 'structured', capabilities: { available: true, attachments: true }, ...patch }) as ExecutionDescriptor;
const staged: Attachment[] = [{ path: '/owned/image.png', name: '粘贴图片.png', bytes: 3 }];

test('plain text paste does nothing; mixed text/image only snapshots supplied files and leaves default text editing untouched', () => {
  let received: File[] | undefined;
  capturePastedFiles(transfer([]), value => { received = value; });
  assert.equal(received, undefined);
  const original = [file()];
  capturePastedFiles(transfer(original), value => { received = value; });
  assert.deepEqual(received, original);
  assert.notEqual(received, original);
  original.length = 0;
  assert.equal((received as File[] | undefined)?.length, 1);
});

test('disabled/non-Native editors do not inspect clipboard data when their optional paste handler is absent', () => {
  const untouched = { get files(): FileList { throw new Error('clipboard access while disabled'); } };
  capturePastedFiles(untouched);
  const claude = session({ execution: { providerId: 'claude', mode: 'structured' } });
  assert.equal(nativePasteTargetAvailable(claude, claude, descriptor({ providerId: 'claude' }), false), false);
});

test('PNG and JPEG encode exact supplied bytes without file paths, filenames or text', async () => {
  const images = await readNativePastedImages([file(3), file(4, 'image/jpeg')], []);
  assert.deepEqual(images, [{ mimeType: 'image/png', dataUrl: 'data:image/png;base64,BwcH' }, { mimeType: 'image/jpeg', dataUrl: 'data:image/jpeg;base64,BwcHBw==' }]);
});

test('empty, unsupported, zero-sized, oversized and excess-count batches fail before reading any file', async () => {
  let reads = 0;
  const counting = (size = 3, type = 'image/png') => file(size, type, async () => { reads++; return new Uint8Array(size).buffer; });
  const rejected: Array<[File[], Pick<Attachment, 'bytes'>[], RegExp]> = [
    [[], [], /没有/],
    [[counting(), counting(3, 'image/gif')], [], /PNG \/ JPEG/],
    [[counting(), counting(3, 'image/webp')], [], /PNG \/ JPEG/],
    [[counting(), counting(0)], [], /为空/],
    [[counting(NATIVE_IMAGE_MAX_BYTES + 1)], [], /1 MiB/],
    [[counting(NATIVE_IMAGE_MAX_BYTES)], [{ bytes: 1 }], /1 MiB/],
    [Array.from({ length: 5 }, () => counting()), [], /最多 4 张/],
    [[counting()], Array.from({ length: 4 }, () => ({ bytes: 1 })), /最多 4 张/],
  ];
  for (const [files, existing, pattern] of rejected) await assert.rejects(readNativePastedImages(files, existing), pattern);
  assert.equal(reads, 0);
});

test('exact total boundary encodes safely without argument overflow', async () => {
  const images = await readNativePastedImages([file(NATIVE_IMAGE_MAX_BYTES - 7)], [{ bytes: 7 }]);
  assert.equal(atob(images[0].dataUrl.split(',')[1]).length, NATIVE_IMAGE_MAX_BYTES - 7);
});

test('failed or changed clipboard reads never stage and never expose native error text', async () => {
  let writes = 0;
  const stage = async () => { writes++; return staged; };
  await assert.rejects(importNativePastedImages([file(3, 'image/png', async () => { throw new Error('secret C:\\Users\\private\\image.png'); })], [], () => true, stage), error => {
    assert.match(String(error), /读取剪贴板图片失败/);
    assert.doesNotMatch(String(error), /private|Users|secret/);
    return true;
  });
  await assert.rejects(importNativePastedImages([file(3, 'image/png', async () => new ArrayBuffer(4))], [], () => true, stage), /内容已变化/);
  assert.equal(writes, 0);
});

test('submission guard is reserved synchronously before first read and repeated imports wait for settlement', async () => {
  const pending = new Set<string>();
  const states: boolean[] = [];
  let release!: (data: ArrayBuffer) => void;
  let readStarted = false, writes = 0, duplicates = 0;
  const bytes = new Promise<ArrayBuffer>(resolve => { release = resolve; });
  const reading = withAttachmentImport(pending, 'origin', value => states.push(value.has('origin')), async () => {
    await importNativePastedImages([file(3, 'image/png', () => {
      readStarted = true;
      assert.equal(pending.has('origin'), true);
      return bytes;
    })], [], () => true, async () => { writes++; return staged; });
  });
  assert.equal(readStarted, true);
  // App supplies this predicate to useChatSubmission; actual DOM Enter remains
  // part of the pending Windows/Electron acceptance check.
  assert.equal(pending.has('origin'), true);
  await withAttachmentImport(pending, 'origin', () => {}, async () => { duplicates++; });
  assert.equal(duplicates, 0); assert.equal(writes, 0);
  release(new ArrayBuffer(3)); await reading;
  assert.equal(writes, 1); assert.deepEqual(states, [true, false]);
  assert.equal(pending.has('origin'), false);
});

test('failure always releases the synchronous reservation for a later retry', async () => {
  const pending = new Set<string>();
  await assert.rejects(withAttachmentImport(pending, 'origin', () => {}, async () => { throw new Error('rejected'); }), /rejected/);
  assert.equal(pending.has('origin'), false);
  let retried = false;
  await withAttachmentImport(pending, 'origin', () => {}, async () => { retried = true; });
  assert.equal(retried, true);
});

for (const change of ['deleted', 'archived', 'maintenance', 'conversation', 'busy', 'unmounted'] as const) test(`late ${change} during file read cancels before IPC, retaining the captured origin`, async () => {
  const origin = session();
  let current: Session | undefined = origin;
  let engine = descriptor(), busy = false, mounted = true, writes = 0;
  let release!: (data: ArrayBuffer) => void;
  const bytes = new Promise<ArrayBuffer>(resolve => { release = resolve; });
  const reading = importNativePastedImages([file(3, 'image/png', () => bytes)], [], () => mounted && nativePasteTargetAvailable(origin, current, engine, busy), async () => { writes++; return staged; });
  if (change === 'deleted') current = undefined;
  if (change === 'archived') current = { ...origin, archived: true };
  if (change === 'maintenance') engine = { ...engine, maintenance: true };
  if (change === 'conversation') current = { ...origin, execution: { ...origin.execution, conversationId: 'conversation-b' } };
  if (change === 'busy') busy = true;
  if (change === 'unmounted') mounted = false;
  release(new ArrayBuffer(3));
  await assert.rejects(reading, /原会话已切换或当前无法添加图片/);
  assert.equal(writes, 0);
});

test('another selected session can never become the destination; a running original session still accepts a queued draft', async () => {
  const origin = session({ status: 'running', taskState: 'thinking' });
  assert.equal(nativePasteTargetAvailable(origin, session({ id: 'other' }), descriptor(), false), false);
  let importedId = '';
  const result = await importNativePastedImages([file()], [], () => nativePasteTargetAvailable(origin, origin, descriptor(), false), async () => { importedId = origin.id; return staged; });
  assert.equal(importedId, 'origin'); assert.equal(result, staged);
});
