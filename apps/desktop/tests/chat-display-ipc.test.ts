import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import type { ChatDisplayPage, ChatPage } from '../src/shared/chat';
import type { Session } from '../src/shared/types';

const require = createRequire(import.meta.url), electronPath = require.resolve('electron'), previous = require.cache[electronPath];
require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: { dialog: {} } } as NodeModule;
after(() => { if (previous) require.cache[electronPath] = previous; else delete require.cache[electronPath]; });

async function fixture() {
  const { registerChatHandlers } = await import('../src/main/ipc/chat-handlers');
  const id = randomUUID(), session = { id, execution: { providerId: 'native', mode: 'structured', conversationId: randomUUID() } } as Session;
  const page: ChatPage = { messages: [{ id: 'saved', role: 'assistant', turnId: 'turn', text: 'Saved record', createdAt: 'now' }], before: null, after: null, incomplete: false };
  let reads = 0, deleted = false;
  const requests = new Map<string, string>();
  let display: (options: unknown) => Promise<ChatPage> = async () => page;
  const handlers = new Map<string, (input: unknown) => unknown>();
  const ports = {
    structured: (value: string) => { assert.equal(value, id); if (deleted) throw new Error('Deleted'); if (session.execution.mode !== 'structured') throw new Error('Terminal'); return session; },
    chat: { hydrate: () => { throw new Error('Display must not hydrate'); }, snapshot: () => { throw new Error('Display must not read authority'); },
      readDisplay: async (_id: string, options: unknown) => { reads++; return display(options); } },
    queue: { submissionRequests: (_id: string, ids: readonly string[]) => new Map([...requests].filter(([messageId]) => ids.includes(messageId))),
      snapshot: () => { throw new Error('Display must not clone queue bodies or read running state'); } },
  } as unknown as Parameters<typeof registerChatHandlers>[1];
  registerChatHandlers((name, schema, action) => handlers.set(name, input => action(schema.parse(input))), ports);
  return { id, session, page, requests, call: async (input: unknown) => await handlers.get('chat:display')!(input) as ChatDisplayPage,
    readCount: () => reads, setRead: (action: typeof display) => { display = action; }, remove: () => { deleted = true; } };
}

test('display IPC returns scoped saved text without hydrating or reading execution state', async () => {
  const f = await fixture();
  const page = await f.call({ id: f.id });
  assert.equal(page.sessionId, f.id); assert.equal(page.conversationId, f.session.execution.conversationId);
  assert.deepEqual(page.messages, f.page.messages); assert.equal(f.readCount(), 1);
  assert.equal('pending' in page, false); assert.equal('taskState' in page, false);
});

test('display IPC annotates only exact host-held submission receipts and strips self-reported client identities', async () => {
  const f = await fixture();
  f.page.messages = [
    { id: 'user', turnId: 'turn', role: 'user', text: 'same text', createdAt: 'now', submissionId: 'accepted-message', clientRequestId: 'forged' },
    { id: 'other', turnId: 'turn', role: 'user', text: 'same text', createdAt: 'now', submissionId: 'different-message', clientRequestId: 'forged' },
  ];
  f.requests.set('accepted-message', 'actual-client-request');
  const page = await f.call({ id: f.id });
  assert.equal(page.messages[0].clientRequestId, 'actual-client-request');
  assert.equal(page.messages[1].clientRequestId, undefined);
  assert.equal(f.page.messages[0].clientRequestId, 'forged');
  assert.equal('pending' in page, false); assert.equal('queue' in page, false);
});

test('display IPC rejects stale results after conversation replacement or deletion', async () => {
  for (const change of ['context', 'deleted']) {
    const f = await fixture(); let release!: () => void;
    f.setRead(async () => { await new Promise<void>(resolve => { release = resolve; }); return f.page; });
    const read = f.call({ id: f.id });
    if (change === 'context') f.session.execution.conversationId = randomUUID(); else f.remove();
    release(); await assert.rejects(read, change === 'context' ? /上下文已改变/ : /Deleted/);
  }
});

test('display IPC validates pagination and structured mode before reaching the reader', async () => {
  const f = await fixture();
  for (const options of [{ before: 'one', after: 'two' }, { around: 'x'.repeat(4097) }, { query: 'x'.repeat(501) }]) await assert.rejects(f.call({ id: f.id, ...options }));
  assert.equal(f.readCount(), 0);
  f.session.execution.mode = 'terminal'; await assert.rejects(f.call({ id: f.id }), /Terminal/);
  assert.equal(f.readCount(), 0);
});
