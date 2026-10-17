import { after, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import type { NativeSkillSubmission } from '@cc-desk/contracts/native-skills';
import type { ExecutionSubmission, StructuredExecutor } from '../src/main/execution/ports';
import type { ChatSnapshot, ChatSubmission } from '../src/shared/chat';
import type { ExecutionCapabilities } from '../src/shared/execution';
import type { Session } from '../src/shared/types';
import { StateStore } from '../src/main/store';
import { ChatQueueStorage } from '../src/main/chat-queue-storage';
import { ExecutionRegistry } from '../src/main/execution/registry';

const require = createRequire(import.meta.url), electronPath = require.resolve('electron'), previous = require.cache[electronPath];
require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true,
  exports: { dialog: {}, Notification: { isSupported: () => false } } } as NodeModule;
after(() => { if (previous) require.cache[electronPath] = previous; else delete require.cache[electronPath]; });

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    assert.ok(Date.now() < deadline, 'timed out waiting for the executor handoff');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
function submission(): NativeSkillSubmission {
  const skillId = `skill:${'a'.repeat(64)}`;
  return { schemaVersion: 1, explicitSkillRefs: [{ skillId, catalogRevision: 'b'.repeat(64), version: {
    skillId, sourceRevision: 3, sourceFingerprint: 'c'.repeat(64), fullFileHash: 'd'.repeat(64), bodyHash: 'e'.repeat(64), bytes: 123, format: 'standard',
  } }], excludedSkillIds: [`skill:${'f'.repeat(64)}`] };
}
function session(providerId = 'native'): Session {
  const now = new Date().toISOString();
  return { id: randomUUID(), projectId: randomUUID(), title: providerId, kind: providerId === 'shell' ? 'shell' : 'agent', cwd: os.tmpdir(),
    execution: { providerId, mode: providerId === 'shell' ? 'terminal' : 'structured', conversationId: randomUUID() },
    engineConfig: { schemaVersion: 1, options: {} }, started: false, archived: false, status: 'idle', createdAt: now, updatedAt: now };
}

async function ipcFixture(providerId = 'native') {
  const { registerChatHandlers } = await import('../src/main/ipc/chat-handlers');
  const current = session(providerId), sent: unknown[][] = [], queued: unknown[][] = [];
  let validations = 0;
  const handlers = new Map<string, (input: unknown) => unknown>();
  const ports = {
    structured: (id: string) => { assert.equal(id, current.id); if (current.execution.mode !== 'structured') throw new Error('此功能需要图形化会话。'); return current; },
    captureAdmission: () => () => {},
    workflows: { isSessionBusy: () => false },
    attachments: { validate: async (_id: string, files?: string[]) => { validations++; return files ?? []; } },
    runChat: async (...args: unknown[]) => { sent.push(args); return { success: true, summary: '' }; },
    queue: { submit: async (...args: unknown[]) => { queued.push(args); return { messageId: 'accepted' }; } },
  } as unknown as Parameters<typeof registerChatHandlers>[1];
  registerChatHandlers((name, schema, action) => handlers.set(name, input => action(schema.parse(input))), ports);
  return { current, sent, queued, validations: () => validations,
    call: async (name: string, input: unknown) => await handlers.get(name)!(input) };
}

test('chat send and submit IPC forward the complete validated skill selection in their dedicated argument', async () => {
  const f = await ipcFixture(), nativeSkills = submission(), nativeTaskId = randomUUID();
  const input = { id: f.current.id, text: 'review with this exact version', attachments: [], requestId: 'explicit-skills', nativeTaskId, nativeSkills };
  await f.call('chat:send', input);
  assert.deepEqual(f.sent, [[f.current.id, input.text, [], input.requestId, nativeTaskId, nativeSkills]]);
  await f.call('chat:submit', input);
  assert.deepEqual(f.queued, [[f.current.id, input.text, [], input.requestId, { nativeTaskId, nativeSkills }]]);
  assert.equal(f.validations(), 1);
});

test('chat IPC rejects malformed skill submissions before attachment validation or queue/executor calls', async () => {
  const nativeSkills = submission();
  const malformed: unknown[] = [
    { ...nativeSkills, schemaVersion: 2 },
    { ...nativeSkills, ignoredField: 'must not disappear' },
    { ...nativeSkills, explicitSkillRefs: Array.from({ length: 17 }, () => nativeSkills.explicitSkillRefs[0]) },
    { ...nativeSkills, excludedSkillIds: [nativeSkills.explicitSkillRefs[0].skillId] },
    { ...nativeSkills, explicitSkillRefs: [{ ...nativeSkills.explicitSkillRefs[0], version: { ...nativeSkills.explicitSkillRefs[0].version, fullFileHash: 'invalid' } }] },
    { ...nativeSkills, explicitSkillRefs: [{ ...nativeSkills.explicitSkillRefs[0], version: { ...nativeSkills.explicitSkillRefs[0].version, skillId: `skill:${'1'.repeat(64)}` } }] },
  ];
  const f = await ipcFixture();
  for (const name of ['chat:send', 'chat:submit']) for (const invalid of malformed) {
    await assert.rejects(f.call(name, { id: f.current.id, text: 'review', nativeSkills: invalid }));
  }
  assert.equal(f.validations(), 0);
  assert.deepEqual(f.sent, []); assert.deepEqual(f.queued, []);
});

test('Claude, external providers and Shell cannot silently accept Native skill fields', async () => {
  for (const providerId of ['claude', 'test.native', 'shell']) {
    const f = await ipcFixture(providerId);
    for (const name of ['chat:send', 'chat:submit']) {
      await assert.rejects(f.call(name, { id: f.current.id, text: 'review', nativeSkills: submission() }), /Native 技能引用|图形化会话/);
    }
    assert.equal(f.validations(), 0);
    assert.deepEqual(f.sent, []); assert.deepEqual(f.queued, []);
  }
});

test('legacy IPC sends retain their five-argument call and do not add empty skill configuration', async () => {
  const f = await ipcFixture('claude');
  await f.call('chat:send', { id: f.current.id, text: 'ordinary task', requestId: 'old-direct' });
  assert.deepEqual(f.sent, [[f.current.id, 'ordinary task', [], 'old-direct', undefined]]);
  await f.call('chat:submit', { id: f.current.id, text: 'ordinary queued task', requestId: 'old-queue' });
  assert.deepEqual(f.queued, [[f.current.id, 'ordinary queued task', undefined, 'old-queue', { nativeTaskId: undefined }]]);
  assert.equal(Object.hasOwn((f.queued[0][4] as object), 'nativeSkills'), false);
});

async function serviceFixture(t: TestContext) {
  const { SessionService } = await import('../src/main/session-service');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'native-skill-service-'))), cwd = path.join(root, 'project');
  fs.mkdirSync(cwd);
  const store = new StateStore(path.join(root, 'data'));
  const registry = new ExecutionRegistry(id => { const found = store.state.sessions.find(item => item.id === id); if (!found) throw new Error('Session missing'); return found; });
  const requests: { id: string; text: string; attachments?: string[]; titlePrompt?: string; submission?: ExecutionSubmission }[] = [];
  const snapshot = (id: string): ChatSnapshot => ({ sessionId: id, taskState: 'idle', messages: [], pending: [] });
  const executor: StructuredExecutor = {
    activeCount: 0, has: () => false, isBusy: () => false, taskState: () => 'idle', hydrate: async () => {}, snapshot,
    page: async () => ({ messages: [], before: null, after: null, incomplete: false }),
    search: async () => ({ hits: [], nextBefore: null, incomplete: false }), attention: () => [], prepareCommands: async id => snapshot(id),
    send: async (id, text, attachments, titlePrompt, selected) => { requests.push({ id, text, attachments, titlePrompt, submission: structuredClone(selected) }); return { success: true, summary: text }; },
    respond: () => {}, updateConfig: async () => {}, exports: async () => [], interrupt: () => {}, stop: () => {}, stopIdle: async () => {},
    whenReleased: async () => {}, forget: () => {}, setMaintenance: () => {}, disconnectAll: async () => {}, shutdown: async () => {},
  };
  const capabilities: ExecutionCapabilities = { available: true, structured: true, terminal: false, approvals: true, resume: false, fork: false,
    commands: false, contextUsage: false, liveConfig: false, attachments: false };
  for (const providerId of ['native', 'claude']) registry.register({ providerId, mode: 'structured', executor, capabilities: () => capabilities });
  const service = new SessionService(store, registry, () => {}, () => null, {
    history: async () => ({ entries: [], total: 0, nextOffset: null }), diagnose: async () => { throw new Error('Not used'); },
  });
  const handlers = new Map<string, (input: unknown) => unknown>();
  service.register((name, schema, action) => handlers.set(name, input => action(schema.parse(input))));
  const add = (providerId = 'native') => {
    const current = { ...session(providerId), cwd };
    store.change(state => { state.projects.push({ id: current.projectId, name: providerId, path: cwd, createdAt: current.createdAt }); state.sessions.push(current); });
    return current;
  };
  t.after(async () => { await service.shutdown(); store.flush(); await tick(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, store, service, requests, add, call: async <T>(name: string, input: unknown) => await handlers.get(name)!(input) as T };
}

test('SessionService forwards exact direct skill versions and preserves legacy direct submissions', async t => {
  const f = await serviceFixture(t), current = f.add(), nativeSkills = submission(), nativeTaskId = randomUUID();
  await f.call('chat:send', { id: current.id, text: 'direct selected skill', requestId: 'direct-skills', nativeTaskId, nativeSkills });
  assert.deepEqual(f.requests[0], { id: current.id, text: 'direct selected skill', attachments: [], titlePrompt: undefined,
    submission: { requestId: 'direct-skills', source: 'direct', nativeTaskId, nativeSkills } });
  await f.call('chat:send', { id: current.id, text: 'ordinary direct task', requestId: 'legacy-direct' });
  assert.deepEqual(f.requests[1].submission, { requestId: 'legacy-direct', source: 'direct' });
  assert.equal(Object.hasOwn(f.requests[1].submission!, 'nativeSkills'), false);
});

test('SessionService keeps new skill queue submission closed while ordinary messages remain usable', async t => {
  const f = await serviceFixture(t), current = f.add();
  await assert.rejects(f.call('chat:submit', { id: current.id, text: 'not enabled', requestId: 'closed', nativeSkills: submission() }), /当前引擎未开放技能调用/);
  assert.equal(f.requests.length, 0);
  assert.deepEqual(f.service.queue.snapshot(current.id).items, []);
  const accepted = await f.call<ChatSubmission>('chat:submit', { id: current.id, text: 'ordinary queued task', requestId: 'ordinary' });
  await until(() => f.requests.length === 1 && !f.service.queue.hasActive(current.id));
  assert.equal(f.requests[0].submission!.requestId, accepted.messageId);
  assert.equal(f.requests[0].submission!.source, 'queue');
  assert.equal(Object.hasOwn(f.requests[0].submission!, 'nativeSkills'), false);
});

test('SessionService restored queue handoff keeps the accepted skill version and queue identity', async t => {
  const f = await serviceFixture(t), current = f.add(), nativeSkills = submission(), messageId = randomUUID();
  new ChatQueueStorage(f.store.directory).save(current.id, { version: 1, paused: true, receipts: [], items: [
    { id: messageId, clientRequestId: 'accepted-before-restart', text: 'restored selected skill', attachments: [], createdAt: new Date().toISOString(), status: 'queued', nativeSkills },
  ] });
  await f.call('chat:queue-resume', current.id);
  await until(() => f.requests.length === 1 && !f.service.queue.hasActive(current.id));
  assert.deepEqual(f.requests[0].submission, { requestId: messageId, source: 'queue', nativeSkills });
  assert.equal(f.service.queue.snapshot(current.id).items.length, 0);
});

test('SessionService rejects persisted non-Native skill references before reaching its executor', async t => {
  const f = await serviceFixture(t), current = f.add('claude'), nativeSkills = submission(), messageId = randomUUID();
  new ChatQueueStorage(f.store.directory).save(current.id, { version: 1, paused: true, receipts: [], items: [
    { id: messageId, text: 'cannot lose skill constraints', attachments: [], createdAt: new Date().toISOString(), status: 'queued', nativeSkills },
  ] });
  await f.call('chat:queue-resume', current.id);
  await until(() => !!f.service.queue.snapshot(current.id).error && !f.service.queue.hasActive(current.id));
  const snapshot = f.service.queue.snapshot(current.id);
  assert.match(snapshot.error!, /此引擎不支持 Native 技能引用/);
  assert.equal(snapshot.paused, true);
  assert.equal(f.requests.length, 0);
  assert.deepEqual(snapshot.items[0].nativeSkills, nativeSkills);
});
