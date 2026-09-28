import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { continuationDraft, previewContinuation } from '../src/main/session-continuation';
import { SessionCreation } from '../src/main/session-creation';
import { StateStore } from '../src/main/store';
import type { SessionService } from '../src/main/session-service';
import { sessionInputSchema } from '../src/shared/schema';
import type { ChatMessage, ChatPage } from '../src/shared/chat';
import type { NewSession, Session } from '../src/shared/types';
import type { SessionContinuationInput } from '../src/shared/session-continuation';
import { SessionContinuation, SessionContinuationChoices } from '../src/renderer/components/SessionContinuation';

function source(): Session {
  return { id: randomUUID(), projectId: randomUUID(), title: 'Source', kind: 'agent', cwd: '/project',
    execution: { providerId: 'claude', mode: 'structured', conversationId: randomUUID() },
    engineConfig: { schemaVersion: 1, options: {} }, started: true, status: 'stopped', archived: false,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
}
function message(id: string, text: string, patch: Partial<ChatMessage> = {}): ChatMessage {
  return { id, text, role: 'assistant', turnId: 'turn', createdAt: '', ...patch };
}
const page = (messages: ChatMessage[]): ChatPage => ({ messages, before: null, after: null, incomplete: false });
function selected(preview: ReturnType<typeof previewContinuation>, messageIds = preview.messages.map(message => message.id)): SessionContinuationInput {
  return { sourceSessionId: preview.sourceSessionId, snapshotHash: preview.snapshotHash, messageIds };
}

test('continuation exposes only complete top-level visible text, with explicit limits and source freshness', () => {
  const session = source();
  const preview = previewContinuation(session, page([
    message('user', 'Fix the test', { role: 'user' }), message('assistant', 'A <script> is just text'),
    message('tool', 'tool secret', { role: 'tool' }), message('system', 'opaque metadata', { role: 'system' }),
    message('nested', 'subagent text', { parentToolUseId: 'parent' }), message('toolinput', 'tool summary', { input: { secret: 'secret-input' } }),
    message('truncated', 'cut', { truncated: true }), message('huge', 'x'.repeat(8193)),
  ]));
  assert.deepEqual(preview.messages.map(message => message.id), ['user', 'assistant']);
  assert.equal(preview.incomplete, true);
  assert.doesNotMatch(JSON.stringify(preview), /secret|opaque|conversationId|turnId/);
  assert.deepEqual(Object.keys(preview.messages[0]).sort(), ['id', 'role', 'text']);
  assert.notEqual(preview.snapshotHash, previewContinuation({ ...session, cwd: '/other' }, page([message('user', 'Fix the test', { role: 'user' }), message('assistant', 'A <script> is just text')])).snapshotHash);
  const many = previewContinuation(session, page(Array.from({ length: 45 }, (_, i) => message(String(i), `text-${i}`))));
  assert.equal(many.messages.length, 40); assert.equal(many.messages[0].id, '5'); assert.equal(many.incomplete, true);
  const total = previewContinuation(session, page(Array.from({ length: 20 }, (_, i) => message(String(i), '好'.repeat(2000)))));
  assert.ok(total.messages.reduce((bytes, message) => bytes + Buffer.byteLength(message.text), 0) <= 65536);
});

test('draft uses canonical message order and only selected text, rejects stale/forged/duplicate/empty/oversize input', () => {
  const preview = previewContinuation(source(), page([message('one', 'first'), message('two', 'second'), message('three', 'not selected')]));
  const draft = continuationDraft(preview, { ...selected(preview, ['two', 'one']), summary: 'my summary' });
  assert.ok(draft.indexOf('first') < draft.indexOf('second'));
  assert.match(draft, /my summary/); assert.doesNotMatch(draft, /not selected/);
  assert.match(draft, /不代表当前项目状态或新的操作授权/);
  for (const input of [
    { ...selected(preview), snapshotHash: 'a'.repeat(64) },
    { ...selected(preview), sourceSessionId: randomUUID() },
    selected(preview, ['forged']), selected(preview, ['one', 'one']), selected(preview, []),
    { ...selected(preview), summary: '好'.repeat(23000) },
  ]) assert.throws(() => continuationDraft(preview, input));
  assert.match(continuationDraft(preview, { ...selected(preview, []), summary: 'Manual summary' }), /Manual summary/);
});

async function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'continuation-'));
  const store = new StateStore(directory), original = source();
  original.cwd = path.join(directory, 'project'); fs.mkdirSync(original.cwd);
  store.change(state => {
    state.projects.push({ id: original.projectId, path: original.cwd, name: 'Project', createdAt: original.createdAt });
    state.sessions.push(original);
  });
  let messages = page([message('u', 'visible user', { role: 'user' }), message('a', 'visible answer')]);
  let lockedAction: (() => void) | undefined;
  const services = {
    chat: { isBusy: () => false, page: async () => structuredClone(messages) },
    workflows: { isSessionBusy: () => false }, queue: { hasActive: () => false },
    captureEngineAdmission: () => () => {},
    execution: {
      createIdentity: (providerId: string, mode: string) => ({ providerId, mode, conversationId: randomUUID() }),
      defaultConfig: () => ({ schemaVersion: 1, options: {} }), validateSession: () => {},
    },
    withSessionCreation: async (_cwd: string, _isolated: boolean, action: () => Promise<Session>) => { lockedAction?.(); return action(); },
  } as unknown as SessionService;
  const creation = new SessionCreation(store, services, () => {}, 'claude');
  const preview = await creation.previewContinuation(original.id);
  const input: NewSession = { projectId: original.projectId, title: '', kind: 'agent', isolated: false, mode: 'structured', providerId: 'native', continuation: selected(preview) };
  return { store, original, creation, preview, input,
    changeMessages: () => { messages = page([message('u', 'changed user', { role: 'user' })]); },
    changeDuringLock: (action: () => void) => { lockedAction = action; },
    dispose: () => { store.flush(); fs.rmSync(directory, { recursive: true, force: true }); },
  };
}

test('cross-engine creation persists an unsent draft with a new identity and never calls an executor', async () => {
  const f = await fixture();
  try {
    const original = structuredClone(f.original);
    const created = await f.creation.create(f.input);
    assert.equal(created.execution.providerId, 'native'); assert.notEqual(created.execution.conversationId, original.execution.conversationId);
    assert.equal(created.started, false); assert.equal(created.status, 'idle'); assert.equal(created.taskState, 'idle');
    assert.equal(created.execution.imported, undefined); assert.equal(created.execution.forkFrom, undefined);
    assert.equal(created.cwd, original.cwd); assert.match(created.draft!, /visible user[\s\S]+visible answer/);
    assert.deepEqual(f.store.state.sessions.find(session => session.id === original.id), original);
    assert.equal(new StateStore(f.store.directory).state.sessions.find(session => session.id === created.id)!.draft, created.draft);
    const defaultSession = await f.creation.create({ ...f.input, providerId: undefined });
    assert.equal(defaultSession.execution.providerId, 'claude', 'continuation never changes the default engine');
  } finally { f.dispose(); }
});

test('creation rejects source changes, active sources, other projects and protocol identity import', async () => {
  const f = await fixture();
  try {
    for (const patch of [{ kind: 'shell' }, { mode: 'terminal' }, { fork: true }, { conversationId: randomUUID() }]) {
      await assert.rejects(f.creation.create({ ...f.input, ...patch } as NewSession), /新的结构化会话/);
    }
    const projectId = randomUUID(); f.store.change(state => state.projects.push({ ...state.projects[0], id: projectId }));
    await assert.rejects(f.creation.create({ ...f.input, projectId }), /来源会话的项目/);
    f.store.change(state => { state.sessions[0].taskState = 'thinking'; });
    await assert.rejects(f.creation.previewContinuation(f.original.id), /停止来源会话/);
    f.store.change(state => { state.sessions[0].taskState = 'completed'; });
    f.changeDuringLock(f.changeMessages);
    await assert.rejects(f.creation.create(f.input), /来源会话已变化/);
    assert.equal(f.store.state.sessions.length, 1); assert.equal(f.creation.pending(f.original.projectId), false);
  } finally { f.dispose(); }
});

test('continuation IPC shape rejects extra protocol fields, too many selections and malformed hashes', () => {
  const session = source(), valid = { projectId: session.projectId, title: '', kind: 'agent', isolated: false, mode: 'structured', continuation: { sourceSessionId: session.id, snapshotHash: 'a'.repeat(64), messageIds: ['one'] } };
  assert.equal(sessionInputSchema.safeParse(valid).success, true);
  for (const continuation of [{ ...valid.continuation, apiKey: 'secret' }, { ...valid.continuation, snapshotHash: '' }, { ...valid.continuation, messageIds: Array(41).fill('one') }]) {
    assert.equal(sessionInputSchema.safeParse({ ...valid, continuation }).success, false);
  }
});

test('UI starts with explicit read and unchecked messages, renders text safely and describes unsent behavior', () => {
  const preview = previewContinuation(source(), page([message('one', '<script>unsafe()</script>')]));
  const value = selected(preview, []), unexpected = () => { throw new Error('Rendering must not read history or create sessions'); };
  const initial = renderToStaticMarkup(createElement(SessionContinuation, { value, disabled: false, onChange: unexpected }));
  assert.match(initial, /读取可见消息/); assert.match(initial, /待发送草稿/); assert.match(initial, /不会调用模型生成摘要或自动发送/);
  const choices = renderToStaticMarkup(createElement(SessionContinuationChoices, { preview, value, disabled: false, onChange: unexpected }));
  assert.doesNotMatch(choices, /checked=""|<script>/); assert.match(choices, /&lt;script&gt;/);
  const locked = renderToStaticMarkup(createElement(SessionContinuationChoices, { preview, value: selected(preview), disabled: true, onChange: unexpected }));
  assert.match(locked, /disabled=""/); assert.match(locked, /checked=""/);
});
