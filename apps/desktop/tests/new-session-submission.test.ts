import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Attachment, DraftAttachment, NewSession, Session } from '../src/shared/types';
import { NewSessionSubmission, type NativePastedDraftAttachment, type NewSessionSubmissionPorts } from '../src/renderer/workspace/new-session-submission';

const input: NewSession = { projectId: 'project', title: '', kind: 'agent', isolated: true };
const session: Session = {
  id: 'session', projectId: 'project', title: 'New session', kind: 'agent', cwd: '/worktree',
  engineConfig: { schemaVersion: 1, options: {} }, execution: { providerId: 'claude', mode: 'structured' }, started: false,
  status: 'idle', archived: false, createdAt: 'now', updatedAt: 'now', worktree: '/worktree',
};
const attachment = (path: string, selectionId = `selection:${path}`): DraftAttachment => ({ path, name: path.split('/').at(-1)!, bytes: 10, selectionId });

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function setup(overrides: Partial<NewSessionSubmissionPorts> = {}) {
  const creates: NewSession[] = [], drafts: string[] = [], stages: string[][] = [], removed: string[] = [];
  const submissions: { text: string; paths: string[]; requestId: string }[] = [];
  const ports: NewSessionSubmissionPorts = {
    async createSession(value) { creates.push(value); return session; },
    async saveDraft(id, text) { assert.equal(id, session.id); drafts.push(text); },
    async stageDraftAttachments(id, files) {
      const paths = files.map(file => file.path);
      assert.equal(id, session.id); stages.push(paths);
      return paths.map(path => attachment(`/owned/${stages.length}/${path.split('/').at(-1)}`));
    },
    async addPastedNativeImages() { throw new Error('Unexpected image staging'); },
    async removeAttachment(id, path) { assert.equal(id, session.id); removed.push(path); },
    async submitChat(id, text, paths, requestId) {
      assert.equal(id, session.id); submissions.push({ text, paths: [...paths], requestId }); return { messageId: 'message' };
    },
    ...overrides,
  };
  return { controller: new NewSessionSubmission(ports), ports, creates, drafts, stages, submissions, removed };
}

test('first send snapshots its input, gates repeated clicks synchronously and stops after durable acceptance', async () => {
  const creation = deferred<Session>(), acknowledgement = deferred<{ messageId: string }>();
  const created: Session[] = [];
  const fixture = setup({ created(value) { created.push(value); } });
  fixture.ports.createSession = async value => { fixture.creates.push(value); return creation.promise; };
  const submit = fixture.ports.submitChat;
  fixture.ports.submitChat = async (...args) => { await submit(...args); return acknowledgement.promise; };
  const draftInput: NewSession = { ...input, providerId: 'claude', mode: 'structured', engineConfig: { schemaVersion: 1, options: { model: 'selected-model' } } };
  const files = [attachment('/source/a.txt')];
  const pending = fixture.controller.submit(draftInput, '  first message\n', files);
  assert.equal(fixture.controller.pending, true);
  assert.equal(fixture.controller.submit(input, 'second click', []), pending);
  draftInput.projectId = 'changed'; draftInput.engineConfig!.options.model = 'changed'; files[0].path = '/source/changed.txt';
  await Promise.resolve();
  assert.equal(fixture.creates.length, 1);
  assert.deepEqual(fixture.creates[0], { ...input, kind: 'agent', providerId: 'claude', mode: 'structured', engineConfig: { schemaVersion: 1, options: { model: 'selected-model' } }, worktreeName: undefined, worktreeBaseRef: undefined });
  creation.resolve(session);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fixture.controller.session, session);
  assert.deepEqual(created, [session]);
  assert.equal(fixture.controller.accepted, false);
  assert.deepEqual(fixture.drafts, ['  first message\n']);
  assert.deepEqual(fixture.stages, [['/source/a.txt']]);
  assert.equal(fixture.submissions[0].text, 'first message');
  assert.deepEqual(fixture.submissions[0].paths, ['/owned/1/a.txt']);
  acknowledgement.resolve({ messageId: 'message' });
  assert.equal(await pending, session);
  assert.equal(fixture.controller.pending, false);
  assert.equal(fixture.controller.accepted, true);
  assert.equal(await fixture.controller.submit(input, 'anything else', []), session);
  assert.equal(fixture.submissions.length, 1);
});

test('invalid first messages do not create a session, while attachment-only messages are supported', async () => {
  const fixture = setup();
  await assert.rejects(fixture.controller.submit(input, ' \n ', []), /输入消息/);
  await assert.rejects(fixture.controller.submit(input, 'a'.repeat(60001), []), /60,000/);
  await assert.rejects(fixture.controller.submit(input, 'message', [attachment('/a'), attachment('/a')]), /不同附件/);
  assert.equal(fixture.creates.length, 0);
  assert.equal(fixture.controller.pending, false);
  await fixture.controller.submit(input, ' ', [attachment('/a')]);
  assert.equal(fixture.submissions[0].text, '');
  assert.deepEqual(fixture.drafts, [' ']);
});

test('creation failures leave no session and allow a later attempt with updated creation settings', async () => {
  const fixture = setup();
  const create = fixture.ports.createSession;
  fixture.ports.createSession = async () => { throw new Error('worktree creation failed'); };
  await assert.rejects(fixture.controller.submit(input, 'hello', []), /worktree creation failed/);
  assert.equal(fixture.controller.session, undefined);
  assert.equal(fixture.controller.pending, false);
  assert.deepEqual(fixture.drafts, []);
  fixture.ports.createSession = create;
  await fixture.controller.submit({ ...input, title: '  trimmed title  ', isolated: false, worktreeName: '../invalid-hidden-name', worktreeBaseRef: 'invalid hidden ref' }, 'hello', []);
  assert.equal(fixture.creates[0].isolated, false);
  assert.equal(fixture.creates[0].title, 'trimmed title');
  assert.equal(fixture.creates[0].worktreeName, undefined);
  assert.equal(fixture.creates[0].worktreeBaseRef, undefined);
});

test('saving the draft can fail and retry without losing the created session or its worktree', async () => {
  const fixture = setup();
  fixture.ports.saveDraft = async () => { throw new Error('draft disk full'); };
  await assert.rejects(fixture.controller.submit(input, '  old text  ', []), /draft disk full/);
  assert.equal(fixture.controller.session, session);
  assert.equal(fixture.controller.accepted, false);
  assert.equal(fixture.submissions.length, 0);
  fixture.ports.saveDraft = async (_id, text) => { fixture.drafts.push(text); };
  await fixture.controller.submit({ ...input, projectId: 'changed' }, '  edited text  ', []);
  assert.equal(fixture.creates.length, 1);
  assert.deepEqual(fixture.drafts, ['  edited text  ']);
  assert.equal(fixture.submissions[0].text, 'edited text');
});

test('attachment failures preserve previously staged copies and retry only the missing sources', async () => {
  const fixture = setup();
  fixture.ports.submitChat = async () => { throw new Error('offline'); };
  await assert.rejects(fixture.controller.submit(input, 'hello', [attachment('/a')]), /offline/);
  const stage = fixture.ports.stageDraftAttachments;
  fixture.ports.stageDraftAttachments = async (_id, files) => { assert.deepEqual(files.map(file => file.path), ['/b']); throw new Error('copy failed'); };
  await assert.rejects(fixture.controller.submit(input, 'hello', [attachment('/a'), attachment('/b')]), /copy failed/);
  assert.equal(fixture.controller.session, session);
  fixture.ports.stageDraftAttachments = stage;
  fixture.ports.submitChat = async (_id, text, paths, requestId) => {
    fixture.submissions.push({ text, paths, requestId }); return { messageId: 'message' };
  };
  await fixture.controller.submit(input, 'hello', [attachment('/a'), attachment('/b')]);
  assert.equal(fixture.creates.length, 1);
  assert.deepEqual(fixture.stages, [['/a'], ['/b']]);
  assert.deepEqual(fixture.submissions[0].paths, ['/owned/1/a', '/owned/2/b']);
  assert.deepEqual(fixture.drafts, ['hello', 'hello', 'hello']);
});

test('a lost acknowledgement retries the exact durable request without copying or queuing twice', async () => {
  const accepted = new Map<string, string>();
  const fixture = setup();
  const submit = fixture.ports.submitChat;
  fixture.ports.submitChat = async (...args) => {
    await submit(...args);
    const [, text, paths, requestId] = args, payload = JSON.stringify({ text, paths });
    if (!accepted.has(requestId)) { accepted.set(requestId, payload); throw new Error('acknowledgement lost'); }
    assert.equal(accepted.get(requestId), payload);
    return { messageId: 'durable-message' };
  };
  await assert.rejects(fixture.controller.submit(input, '  hello  ', [attachment('/a')]), /acknowledgement lost/);
  assert.equal(fixture.controller.accepted, false);
  await fixture.controller.submit(input, 'hello\n', [attachment('/a')]);
  assert.equal(fixture.creates.length, 1);
  assert.equal(fixture.stages.length, 1);
  assert.equal(accepted.size, 1);
  assert.equal(fixture.submissions[0].requestId, fixture.submissions[1].requestId);
  assert.deepEqual(fixture.drafts, ['  hello  ', 'hello\n']);
});

test('edited payloads get distinct request IDs and returning to a prior payload retains its retry ID', async () => {
  const fixture = setup(), submit = fixture.ports.submitChat;
  fixture.ports.submitChat = async (...args) => { await submit(...args); throw new Error('offline'); };
  for (const text of ['first', 'edited', 'first']) await assert.rejects(fixture.controller.submit(input, text, []), /offline/);
  assert.notEqual(fixture.submissions[0].requestId, fixture.submissions[1].requestId);
  assert.equal(fixture.submissions[0].requestId, fixture.submissions[2].requestId);
  assert.equal(fixture.creates.length, 1);
});

test('pending sends protect their captured attachments, and removal blocks a concurrent submission', async () => {
  const fixture = setup(), copy = deferred<Attachment[]>(), stagingStarted = deferred<void>();
  fixture.ports.stageDraftAttachments = async () => { stagingStarted.resolve(); return copy.promise; };
  const submit = fixture.ports.submitChat;
  fixture.ports.submitChat = async (...args) => { await submit(...args); throw new Error('offline'); };
  const first = fixture.controller.submit(input, 'hello', [attachment('/a')]);
  await stagingStarted.promise;
  await assert.rejects(fixture.controller.invalidateAttachment('/a'), /正在发送/);
  copy.resolve([attachment('/owned/old-a')]);
  await assert.rejects(first, /offline/);
  const removal = deferred<void>();
  fixture.ports.removeAttachment = async () => removal.promise;
  const removing = fixture.controller.invalidateAttachment('/a');
  await assert.rejects(fixture.controller.submit(input, 'hello', []), /正在移除附件/);
  removal.resolve(); await removing;
  let copies = 0;
  fixture.ports.stageDraftAttachments = async (_id, files) => { copies++; assert.deepEqual(files.map(file => file.path), ['/a']); return [attachment('/owned/new-a')]; };
  await assert.rejects(fixture.controller.submit(input, 'hello', [attachment('/a')]), /offline/);
  await assert.rejects(fixture.controller.submit(input, 'hello', [attachment('/a')]), /offline/);
  assert.equal(copies, 1);
  assert.deepEqual(fixture.submissions.map(value => value.paths), [['/owned/old-a'], ['/owned/new-a'], ['/owned/new-a']]);
  assert.notEqual(fixture.submissions[0].requestId, fixture.submissions[1].requestId);
  assert.equal(fixture.submissions[1].requestId, fixture.submissions[2].requestId);
});

test('removing a staged but unsubmitted chip leaves no draft copy to reappear after a text-only send', async () => {
  const drafts = new Set<string>(), fixture = setup();
  const stage = fixture.ports.stageDraftAttachments, submit = fixture.ports.submitChat;
  fixture.ports.stageDraftAttachments = async (...args) => {
    const copies = await stage(...args); copies.forEach(file => drafts.add(file.path)); return copies;
  };
  fixture.ports.removeAttachment = async (_id, path) => { drafts.delete(path); };
  fixture.ports.submitChat = async () => { throw new Error('not accepted'); };
  await assert.rejects(fixture.controller.submit(input, 'hello', [attachment('/a')]), /not accepted/);
  assert.deepEqual([...drafts], ['/owned/1/a']);
  await fixture.controller.invalidateAttachment('/a');
  fixture.ports.submitChat = submit;
  await fixture.controller.submit(input, 'hello', []);
  assert.deepEqual([...drafts], []);
  assert.deepEqual(fixture.submissions[0].paths, []);
  assert.equal(fixture.creates.length, 1);
});

test('a queue-owned attachment cannot be removed after a lost acknowledgement and keeps its cached retry', async () => {
  const fixture = setup(), submit = fixture.ports.submitChat;
  fixture.ports.submitChat = async (...args) => { await submit(...args); throw new Error('ack lost'); };
  fixture.ports.removeAttachment = async (_id, path) => {
    assert.equal(path, '/owned/1/a'); throw new Error('attachment referenced by queue');
  };
  await assert.rejects(fixture.controller.submit(input, 'hello', [attachment('/a')]), /ack lost/);
  await assert.rejects(fixture.controller.invalidateAttachment('/a'), /referenced by queue/);
  fixture.ports.submitChat = submit;
  await fixture.controller.submit(input, 'hello', [attachment('/a')]);
  assert.equal(fixture.stages.length, 1);
  assert.equal(fixture.submissions[0].requestId, fixture.submissions[1].requestId);
  assert.deepEqual(fixture.submissions[1].paths, ['/owned/1/a']);
});

test('a new selection of the same source path never reuses the earlier selection copy', async () => {
  const fixture = setup(), stage = fixture.ports.stageDraftAttachments, submit = fixture.ports.submitChat;
  const selections: string[] = [];
  fixture.ports.stageDraftAttachments = async (id, files) => {
    selections.push(...files.map(file => file.selectionId)); return stage(id, files);
  };
  fixture.ports.submitChat = async (...args) => { await submit(...args); throw new Error('offline'); };
  await assert.rejects(fixture.controller.submit(input, 'hello', [attachment('/a', 'selection-one')]), /offline/);
  await assert.rejects(fixture.controller.submit(input, 'hello', [attachment('/a', 'selection-two')]), /offline/);
  assert.deepEqual(selections, ['selection-one', 'selection-two']);
  assert.deepEqual(fixture.submissions.map(value => value.paths), [['/owned/1/a'], ['/owned/2/a']]);
  assert.notEqual(fixture.submissions[0].requestId, fixture.submissions[1].requestId);
  await fixture.controller.invalidateAttachment('/a');
  assert.deepEqual(fixture.removed, ['/owned/1/a', '/owned/2/a']);
});

const pasted = (id: string): NativePastedDraftAttachment => ({
  kind: 'native-paste', selectionId: id, path: `paste:${id}`, name: 'paste.png', bytes: 4,
  image: { mimeType: 'image/png', dataUrl: 'data:image/png;base64,AQIDBA==' },
});
const nativeSession: Session = { ...session, execution: { providerId: 'native', mode: 'structured' }, engineConfig: { schemaVersion: 1, options: { connectionId: 'connection' } } };
const nativeInput: NewSession = { ...input, providerId: 'native', mode: 'structured', engineConfig: nativeSession.engineConfig };

test('explicit engines and continuation boundaries cannot silently become a Claude first send', async () => {
  const fixture = setup();
  for (const patch of [{ kind: 'shell' as const }, { mode: 'terminal' as const }, { providerId: 'shell' }, { continuation: { sourceSessionId: 'source', snapshotHash: 'hash', messageIds: ['one'] } }]) {
    await assert.rejects(fixture.controller.submit({ ...input, ...patch }, 'hello', []), /结构化|续接/);
  }
  await assert.rejects(fixture.controller.submit({ ...input, providerId: 'claude' }, 'hello', [pasted('image')]), /Native/);
  assert.equal(fixture.creates.length, 0);
  assert.equal(fixture.drafts.length, 0);
  fixture.ports.createSession = async value => { fixture.creates.push(value); return nativeSession; };
  await fixture.controller.submit(nativeInput, 'hello', []);
  assert.equal(fixture.creates[0].providerId, 'native');
  assert.deepEqual(fixture.creates[0].engineConfig, nativeSession.engineConfig);
});

test('mixed Native first-send files and paste retain partial staging and original order across retry', async () => {
  const fixture = setup({ async createSession() { return nativeSession; } });
  const images: string[][] = [], source = [pasted('paste-first'), attachment('/disk.png')];
  fixture.ports.addPastedNativeImages = async (_id, values) => { images.push(values.map(value => value.dataUrl)); throw new Error('paste rejected'); };
  await assert.rejects(fixture.controller.submit(nativeInput, 'describe', source), /paste rejected/);
  assert.deepEqual(fixture.stages, [['/disk.png']]);
  assert.equal(fixture.submissions.length, 0);
  fixture.ports.addPastedNativeImages = async (_id, values) => { images.push(values.map(value => value.dataUrl)); return [attachment('/owned/paste.png')]; };
  const submit = fixture.ports.submitChat;
  fixture.ports.submitChat = async (...args) => { await submit(...args); throw new Error('lost acknowledgement'); };
  await assert.rejects(fixture.controller.submit(nativeInput, 'describe', source), /lost acknowledgement/);
  assert.deepEqual(fixture.submissions[0].paths, ['/owned/paste.png', '/owned/1/disk.png']);
  fixture.ports.submitChat = submit;
  await fixture.controller.submit(nativeInput, 'describe', source);
  assert.equal(fixture.stages.length, 1);
  assert.equal(images.length, 2);
  assert.equal(fixture.submissions[0].requestId, fixture.submissions[1].requestId);
});

test('Native first paste snapshots its in-memory bytes and removing it invalidates only its owned copy', async () => {
  const creation = deferred<Session>(), fixture = setup({ async createSession() { return creation.promise; } });
  const file = pasted('one'); let copied = '';
  fixture.ports.addPastedNativeImages = async (_id, images) => { copied = images[0].dataUrl; return [attachment('/owned/paste')]; };
  fixture.ports.submitChat = async () => { throw new Error('offline'); };
  const pending = fixture.controller.submit(nativeInput, '', [file]);
  file.image.dataUrl = 'changed after send';
  creation.resolve(nativeSession);
  await assert.rejects(pending, /offline/);
  assert.equal(copied, 'data:image/png;base64,AQIDBA==');
  await fixture.controller.invalidateAttachment(file.path);
  assert.deepEqual(fixture.removed, ['/owned/paste']);
  assert.deepEqual(fixture.stages, []);
});

test('Native mixed attachments obey the aggregate limit before creating a session', async () => {
  const fixture = setup();
  await assert.rejects(fixture.controller.submit(nativeInput, 'hello', [pasted('one'), { ...attachment('/disk.png'), bytes: 1024 * 1024 }]), /1 MiB/);
  await assert.rejects(fixture.controller.submit(nativeInput, 'hello', Array.from({ length: 5 }, (_, index) => pasted(String(index)))), /4 张/);
  assert.equal(fixture.creates.length, 0);
});
