import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { NativeSkillSubmission } from '@cc-desk/contracts/native-skills';
import type { QueuedChatMessage } from '@cc-desk/contracts/chat';
import { ChatQueue } from '../src/main/chat-queue';
import { ChatQueueStorage } from '../src/main/chat-queue-storage';

type QueueOptions = ConstructorParameters<typeof ChatQueue>[1];
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!check()) {
    assert.ok(Date.now() < deadline, 'timed out waiting for queue state');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
function reference(letter = 'a'): NativeSkillSubmission['explicitSkillRefs'][number] {
  const skillId = `skill:${letter.repeat(64)}`;
  return { skillId, catalogRevision: 'e'.repeat(64), version: {
    skillId, sourceRevision: 1, sourceFingerprint: 'c'.repeat(64), fullFileHash: 'f'.repeat(64), bodyHash: 'b'.repeat(64), bytes: 120, format: 'standard',
  } };
}
function submission(letter = 'a'): NativeSkillSubmission {
  return { schemaVersion: 1, explicitSkillRefs: [reference(letter)], excludedSkillIds: [`skill:${'d'.repeat(64)}`] };
}
function setup(t: TestContext, overrides: Partial<QueueOptions> = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'native-skill-queue-'));
  let blocked = true, accepted = 0;
  const preparations: NativeSkillSubmission[] = [], dispatched: QueuedChatMessage[] = [];
  const options: QueueOptions = {
    assertAvailable: () => {}, blocked: () => blocked,
    prepareNativeSkills: async (_id, value) => { preparations.push(structuredClone(value)); return structuredClone(value); },
    acceptAttachments: async (_id, _files, commit) => { accepted++; commit(); },
    run: async (_id, item) => { dispatched.push(structuredClone(item)); return { success: true, summary: '' }; },
    interrupt: async () => {}, changed: () => {}, ...overrides,
  };
  const queue = new ChatQueue(directory, options);
  t.after(async () => { blocked = true; await tick(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, queue, options, preparations, dispatched, unblock: () => { blocked = false; }, accepted: () => accepted };
}

test('canonical skill references participate in deduplication before any snapshot preparation', async t => {
  const f = setup(t), nativeSkills = submission();
  nativeSkills.explicitSkillRefs.push(reference('b'));
  const first = await f.queue.submit('session', 'review', [], 'same-request', { nativeSkills });
  const equivalent = structuredClone(nativeSkills); equivalent.explicitSkillRefs.reverse();
  assert.deepEqual(await f.queue.submit('session', 'review', [], 'same-request', { nativeSkills: equivalent }), first);
  assert.equal(f.preparations.length, 1);
  assert.equal(f.accepted(), 1);
  f.options.prepareNativeSkills = async () => { throw new Error('the accepted version must not be read again'); };
  assert.deepEqual(await f.queue.submit('session', 'review', [], 'same-request', { nativeSkills }), first);
  const changed = structuredClone(nativeSkills); changed.explicitSkillRefs[0].version.fullFileHash = 'a'.repeat(64);
  await assert.rejects(f.queue.submit('session', 'review', [], 'same-request', { nativeSkills: changed }), /不同内容/);
  await assert.rejects(f.queue.submit('session', 'review', [], 'same-request', { nativeSkills: { ...nativeSkills, excludedSkillIds: [] } }), /不同内容/);
  await assert.rejects(f.queue.submit('session', 'review', [], 'same-request'), /不同内容/);
  assert.equal(f.queue.snapshot('session').items.length, 1);
});

test('accepted skill receipts survive restart and return before unsupported-engine checks or preparation', async t => {
  const f = setup(t), nativeSkills = submission();
  const first = await f.queue.submit('session', 'review', [], 'same-request', { nativeSkills });
  await tick();
  const restarted = new ChatQueue(f.directory, { ...f.options, prepareNativeSkills: undefined });
  assert.deepEqual(await restarted.submit('session', 'review', [], 'same-request', { nativeSkills }), first);
  assert.equal(restarted.snapshot('session').paused, true);
  assert.deepEqual(restarted.snapshot('session').items[0].nativeSkills, nativeSkills);
  assert.equal(f.preparations.length, 1);
  assert.equal(f.accepted(), 1);
});

test('an unsupported engine explicitly rejects native skill fields without an accepted receipt', async t => {
  const f = setup(t, { prepareNativeSkills: undefined });
  for (const nativeSkills of [submission(), { schemaVersion: 1 as const, explicitSkillRefs: [], excludedSkillIds: [] }]) {
    await assert.rejects(f.queue.submit('session', 'review', [], randomUUID(), { nativeSkills }), /当前引擎未开放技能调用/);
  }
  assert.deepEqual(f.queue.snapshot('session').items, []);
  assert.deepEqual(f.queue.snapshot('session').receipts, []);
  assert.equal(f.accepted(), 0);
});

test('preparation cannot replace a selected version or mutate the original submission', async t => {
  const nativeSkills = submission(), original = structuredClone(nativeSkills);
  const f = setup(t, { prepareNativeSkills: async (_id, selected) => {
    selected.explicitSkillRefs[0].version.sourceFingerprint = 'a'.repeat(64);
    return selected;
  } });
  await assert.rejects(f.queue.submit('session', 'review', [], 'drift', { nativeSkills }), /技能提交版本已变化/);
  assert.deepEqual(nativeSkills, original);
  assert.deepEqual(f.queue.snapshot('session').items, []);
  assert.deepEqual(f.queue.snapshot('session').receipts, []);
  assert.equal(f.accepted(), 0);
});

test('caller edits during asynchronous preparation cannot change the accepted version or receipt identity', async t => {
  const entered = deferred<void>(), release = deferred<void>();
  const f = setup(t, { prepareNativeSkills: async (_id, selected) => { entered.resolve(); await release.promise; return selected; } });
  const nativeSkills = submission(), expected = structuredClone(nativeSkills);
  const pending = f.queue.submit('session', 'review', [], 'immutable', { nativeSkills });
  await entered.promise;
  nativeSkills.explicitSkillRefs[0].version.fullFileHash = 'a'.repeat(64);
  nativeSkills.excludedSkillIds.length = 0;
  release.resolve(); const first = await pending;
  assert.deepEqual(f.queue.snapshot('session').items[0].nativeSkills, expected);
  assert.deepEqual(await f.queue.submit('session', 'review', [], 'immutable', { nativeSkills: expected }), first);
  await assert.rejects(f.queue.submit('session', 'review', [], 'immutable', { nativeSkills }), /不同内容/);
});

test('admission is checked again after snapshot preparation and before accepting the message', async t => {
  const entered = deferred<void>(), release = deferred<void>();
  let allowed = true;
  const f = setup(t, {
    captureAdmission: () => () => { if (!allowed) throw new Error('admission cancelled'); },
    prepareNativeSkills: async (_id, selected) => { entered.resolve(); await release.promise; return selected; },
  });
  const pending = f.queue.submit('session', 'review', [], 'cancelled', { nativeSkills: submission() });
  await entered.promise; allowed = false; release.resolve();
  await assert.rejects(pending, /admission cancelled/);
  assert.deepEqual(f.queue.snapshot('session').items, []);
  assert.deepEqual(f.queue.snapshot('session').receipts, []);
  assert.equal(f.accepted(), 0);
});

test('snapshot persistence failure rejects before attachment acceptance or queue acknowledgement', async t => {
  const f = setup(t, { prepareNativeSkills: async () => { throw new Error('disk full writing skill snapshot'); } });
  await assert.rejects(f.queue.submit('session', 'review', [], 'snapshot-failed', { nativeSkills: submission() }), /disk full writing skill snapshot/);
  assert.equal(f.accepted(), 0);
  assert.deepEqual(f.queue.snapshot('session').items, []);
  assert.deepEqual(f.queue.snapshot('session').receipts, []);
  assert.equal(fs.existsSync(path.join(f.directory, 'chat-queue', 'session.json')), false);
});

test('queue persistence failure publishes no receipt after a successful immutable snapshot preparation', async t => {
  const f = setup(t), storage = (f.queue as unknown as { storage: ChatQueueStorage }).storage;
  const save = storage.save.bind(storage);
  storage.save = (id, value) => { if (value.items.length) throw new Error('disk full writing queue'); save(id, value); };
  await assert.rejects(f.queue.submit('session', 'review', [], 'queue-failed', { nativeSkills: submission() }), /disk full writing queue/);
  assert.equal(f.preparations.length, 1);
  assert.deepEqual(f.queue.snapshot('session').items, []);
  assert.deepEqual(f.queue.snapshot('session').receipts, []);
  assert.equal(fs.existsSync(path.join(f.directory, 'chat-queue', 'session.json')), false);
  storage.save = save;
});

test('priority, pause, restart and dispatch preserve the exact accepted references without repreparing', async t => {
  const f = setup(t), firstSkills = submission(), urgentSkills = submission('b');
  const first = await f.queue.submit('session', 'first', [], 'first-request', { nativeSkills: firstSkills });
  const urgent = await f.queue.submit('session', 'urgent', [], 'urgent-request', { nativeSkills: urgentSkills });
  await f.queue.sendNow('session', urgent.messageId);
  f.queue.pause('session'); await tick();
  const saved = new ChatQueueStorage(f.directory).load('session');
  assert.deepEqual(saved.items.map(item => [item.id, item.nativeSkills]), [[urgent.messageId, urgentSkills], [first.messageId, firstSkills]]);
  assert.equal(saved.version, 1);
  f.options.prepareNativeSkills = undefined;
  const restarted = new ChatQueue(f.directory, f.options);
  assert.equal(restarted.snapshot('session').paused, true);
  f.unblock(); await restarted.resume('session');
  await until(() => f.dispatched.length === 2 && !restarted.hasActive('session') && !restarted.hasPending('session'));
  assert.deepEqual(f.dispatched.map(item => [item.id, item.nativeSkills]), [[urgent.messageId, urgentSkills], [first.messageId, firstSkills]]);
  assert.equal(f.preparations.length, 2);
  assert.deepEqual(await restarted.submit('session', 'urgent', [], 'urgent-request', { nativeSkills: urgentSkills }), urgent);
  assert.equal(f.dispatched.length, 2);
});

test('interrupted execution retains selected references for explicit review and queue continuation', async t => {
  let attempts = 0;
  const f = setup(t, { run: async () => { attempts++; return { success: false, summary: '', interrupted: true }; } });
  const nativeSkills = submission(); await f.queue.submit('session', 'review', [], 'interrupted', { nativeSkills });
  f.unblock(); f.queue.wake('session');
  await until(() => attempts === 1 && !f.queue.hasActive('session'));
  assert.equal(f.queue.snapshot('session').paused, true);
  assert.deepEqual(f.queue.snapshot('session').items[0].nativeSkills, nativeSkills);
  assert.deepEqual(new ChatQueueStorage(f.directory).load('session').items[0].nativeSkills, nativeSkills);
  assert.equal(f.preparations.length, 1);
});

test('storage keeps the complete supported submission and rejects malformed skill fields on read and write', async t => {
  const f = setup(t), nativeSkills = submission();
  await f.queue.submit('session', 'review', [], 'stored', { nativeSkills });
  const storage = new ChatQueueStorage(f.directory), saved = storage.load('session');
  assert.equal(saved.version, 1);
  assert.deepEqual(saved.items[0].nativeSkills, nativeSkills);
  const file = path.join(f.directory, 'chat-queue', 'session.json'), originalBytes = fs.readFileSync(file);
  const invalid: unknown[] = [
    { ...nativeSkills, schemaVersion: 2 },
    { ...nativeSkills, hidden: 'cannot be silently stripped' },
    { ...nativeSkills, explicitSkillRefs: Array.from({ length: 17 }, () => reference()) },
    { ...nativeSkills, excludedSkillIds: [`skill:${'a'.repeat(64)}`] },
    { ...nativeSkills, explicitSkillRefs: [{ ...reference(), version: { ...reference().version, fullFileHash: 'invalid' } }] },
  ];
  for (const value of invalid) {
    const next = structuredClone(saved); next.items[0].nativeSkills = value as NativeSkillSubmission;
    assert.throws(() => storage.save('session', next));
    assert.deepEqual(fs.readFileSync(file), originalBytes);
    const raw = JSON.stringify(next); fs.writeFileSync(file, raw);
    assert.throws(() => storage.load('session'), /原文件已保留/);
    assert.equal(fs.readFileSync(file, 'utf8'), raw);
    fs.writeFileSync(file, originalBytes);
  }
  assert.deepEqual(storage.load('session').items[0].nativeSkills, nativeSkills);
});

test('the full sixteen explicit references and sixteen exclusions persist without truncation', async t => {
  const f = setup(t), nativeSkills: NativeSkillSubmission = {
    schemaVersion: 1,
    explicitSkillRefs: Array.from({ length: 16 }, (_, index) => {
      const ref = reference(), id = `skill:${index.toString(16).padStart(64, '0')}`;
      return { ...ref, skillId: id, version: { ...ref.version, skillId: id } };
    }),
    excludedSkillIds: Array.from({ length: 16 }, (_, index) => `skill:${(index + 256).toString(16).padStart(64, '0')}`),
  };
  await f.queue.submit('session', 'review', [], 'full-boundary', { nativeSkills });
  assert.deepEqual(new ChatQueueStorage(f.directory).load('session').items[0].nativeSkills, nativeSkills);
  assert.equal(f.preparations[0].explicitSkillRefs.length, 16);
  assert.equal(f.preparations[0].excludedSkillIds.length, 16);
});
