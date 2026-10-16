import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatDisplayCache, mergeDisplayPage, mergeDisplaySnapshot, sameChatMessage } from '../src/renderer/chat-display-state';
import type { ChatDisplayPage, ChatMessage } from '../src/shared/chat';

const message = (id: string, text = id): ChatMessage => ({ id, text, turnId: 'turn', role: 'assistant', createdAt: '2026-10-16T00:00:00Z' });
const page = (ids: string[], patch: Partial<ChatDisplayPage> = {}): ChatDisplayPage => ({ sessionId: 'session', conversationId: 'context', messages: ids.map(id => message(id)), before: ids[0] ?? null, after: null, incomplete: false, ...patch });

test('display reconciliation retains unchanged message references and includes all canonical fields', () => {
  const current = page(['first', 'second']);
  const next = mergeDisplayPage(current, structuredClone(current));
  assert.equal(next, current);
  assert.equal(sameChatMessage(message('a'), { ...message('a'), submissionId: 'accepted' }), false);
  const input = { ...message('tool'), role: 'tool' as const, input: { nested: [1, 2] } };
  assert.equal(sameChatMessage(input, structuredClone(input)), true);
  assert.equal(sameChatMessage(input, { ...input, input: { nested: [1, 3] } }), false);
});

test('earlier pages prepend without duplicate IDs and retain the latest cursor', () => {
  const current = page(['three', 'four'], { after: 'newer' });
  const next = mergeDisplayPage(current, page(['one', 'two', 'three'], { before: null, after: 'three' }), 'before');
  assert.deepEqual(next.messages.map(item => item.id), ['one', 'two', 'three', 'four']);
  assert.equal(next.before, null); assert.equal(next.after, 'newer');
  assert.equal(next.messages.at(-1), current.messages.at(-1));
  assert.equal(mergeDisplayPage(page(['latest']), page(['older'], { after: 'older' }), 'before').after, null, 'prepending preserves a null live-tail cursor');
});

test('live snapshots append only after the known overlap and update changed text', () => {
  const current = page(['old-archive', 'visible', 'streaming']);
  const next = mergeDisplaySnapshot(current, [message('not-displayed'), message('visible'), message('streaming', 'updated'), message('new')]);
  assert.deepEqual(next.messages.map(item => item.id), ['old-archive', 'visible', 'streaming', 'new']);
  assert.equal(next.messages[0], current.messages[0]); assert.equal(next.messages[2].text, 'updated');
  assert.equal(mergeDisplaySnapshot(current, []), current, 'empty initial authority cannot erase saved messages');
});

test('a tail beyond the host window moves to the new bounded tail without joining an unknown gap', () => {
  const next = mergeDisplaySnapshot(page(['stale']), Array.from({ length: 400 }, (_, index) => message(`new-${index}`)));
  assert.equal(next.messages.length, 50);
  assert.equal(next.messages[0].id, 'new-350'); assert.equal(next.messages.at(-1)?.id, 'new-399');
  assert.equal(next.before, 'new-350'); assert.equal(next.after, null);
});

test('detached history updates overlaps without appending a distant live tail', () => {
  const current = page(['archive'], { after: 'archive' });
  assert.equal(mergeDisplaySnapshot(current, [message('latest')]), current);
});

test('canonical completion retires the precise temporary stream ID while retaining historical canonical messages', () => {
  const current = page(['historic', 'user', 'turn:stream:1']);
  const next = mergeDisplaySnapshot(current, [message('user'), message('canonical-result')]);
  assert.deepEqual(next.messages.map(item => item.id), ['historic', 'user', 'canonical-result']);
  const ordinary = page(['user', 'other:stream:1']);
  assert.ok(mergeDisplaySnapshot(ordinary, [message('user'), message('result')]).messages.some(item => item.id === 'other:stream:1'));
});

test('normal authority updates retain a display receipt bridge only for the same canonical user submission', () => {
  const user: ChatMessage = { ...message('canonical'), role: 'user', submissionId: 'durable-item', clientRequestId: 'client-request' };
  const current = page([], { messages: [user] });
  const authoritative = { ...user, text: 'updated user content', clientRequestId: undefined };
  const next = mergeDisplaySnapshot(current, [authoritative]);
  assert.equal(next.messages[0].clientRequestId, 'client-request');
  assert.equal(authoritative.clientRequestId, undefined, 'the authoritative object is never annotated or mutated');
  assert.equal(mergeDisplayPage(current, page([], { messages: [authoritative] })).messages[0].clientRequestId, 'client-request');
  for (const replacement of [{ ...authoritative, role: 'assistant' as const }, { ...authoritative, submissionId: 'different-item' }, { ...authoritative, submissionId: undefined }]) {
    assert.equal(mergeDisplaySnapshot(current, [replacement]).messages[0].clientRequestId, undefined);
  }
});

test('active history is bounded and drops the opposite edge with a continuation cursor', () => {
  const current = page(Array.from({ length: 990 }, (_, index) => `new-${index}`));
  const next = mergeDisplayPage(current, page(Array.from({ length: 50 }, (_, index) => `old-${index}`)), 'before');
  assert.equal(next.messages.length, 1000); assert.equal(next.messages[0].id, 'old-0');
  assert.equal(next.after, next.messages.at(-1)?.id);
});

test('a full historical reading window retains its anchor when a newer tail or stream arrives', () => {
  const current = page(Array.from({ length: 1000 }, (_, index) => `m${index}`));
  const newer = Array.from({ length: 51 }, (_, index) => message(`m${950 + index}`));
  newer.push(message('turn:stream:1', 'new stream'));
  const next = mergeDisplaySnapshot(current, newer, true);
  assert.equal(next.messages.length, 1000);
  assert.equal(next.messages[0], current.messages[0], 'reading m0 cannot be evicted by m1000');
  assert.equal(next.messages.at(-1)?.id, 'm999'); assert.equal(next.after, 'm999');
  const detached = mergeDisplaySnapshot(next, [message('far-newer')], true);
  assert.equal(detached.messages[0], current.messages[0], 'even a disjoint host window preserves the detached reading identity');
  assert.equal(detached.after, 'm999');
});

test('read-only cache is isolated by context, rejects retired writes and evicts least-recently-used pages', () => {
  const cache = new ChatDisplayCache(2);
  cache.retain([{ id: 'session', conversationId: 'context' }, { id: 'other' }, { id: 'third' }]);
  const original = page(['saved']); cache.set(original);
  cache.set(page(['other'], { sessionId: 'other', conversationId: undefined }));
  assert.equal(cache.get('session', 'different'), undefined);
  assert.equal(cache.get('session', 'context'), original);
  cache.set(page(['third'], { sessionId: 'third', conversationId: undefined }));
  assert.equal(cache.get('other'), undefined); assert.equal(cache.get('session', 'context'), original);
  cache.retain([{ id: 'session', conversationId: 'rebuilt' }]);
  assert.equal(cache.get('session', 'context'), undefined);
  cache.set(original); assert.equal(cache.get('session', 'context'), undefined);
});

test('read-only cache obeys the retained-byte cap', () => {
  const cache = new ChatDisplayCache(8, 1000);
  cache.set(page(['large'], { messages: [message('large', 'x'.repeat(2000))] }));
  assert.equal(cache.get('session', 'context'), undefined);
});
