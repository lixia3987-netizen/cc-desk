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

test('incomplete authority marks an existing display page even with no messages and ordinary complete snapshots cannot clear it', () => {
  const current = page(['saved']);
  const partial = mergeDisplaySnapshot(current, [], false, true);
  assert.equal(partial.incomplete, true); assert.equal(current.incomplete, false);
  assert.equal(partial.messages, current.messages, 'flag propagation neither deletes nor replaces the displayed records');
  assert.equal(mergeDisplaySnapshot(partial, [message('saved'), message('new')], false, false).incomplete, true);
  assert.equal(mergeDisplaySnapshot(partial, [], false, false), partial);
});

test('only a complete replacement read clears a previous incomplete display page', () => {
  const partial = page(['saved'], { incomplete: true });
  const complete = mergeDisplayPage(partial, page(['saved']));
  assert.equal(complete.incomplete, false); assert.equal(complete.messages[0], partial.messages[0]);
  assert.equal(mergeDisplayPage(partial, page(['saved'], { incomplete: true })).incomplete, true);
  for (const direction of ['before', 'after'] as const) {
    assert.equal(mergeDisplayPage(partial, page(['other']), direction).incomplete, true);
    assert.equal(mergeDisplayPage(page(['saved']), page(['other'], { incomplete: true }), direction).incomplete, true);
  }
});

test('earlier pages prepend without duplicate IDs and retain the latest cursor', () => {
  const current = page(['three', 'four'], { after: 'newer' });
  const next = mergeDisplayPage(current, page(['one', 'two', 'three'], { before: null, after: 'three' }), 'before');
  assert.deepEqual(next.messages.map(item => item.id), ['one', 'two', 'three', 'four']);
  assert.equal(next.before, null); assert.equal(next.after, 'newer');
  assert.equal(next.messages.at(-1), current.messages.at(-1));
  assert.equal(mergeDisplayPage(page(['latest']), page(['older'], { after: 'older' }), 'before').after, null, 'prepending preserves a null live-tail cursor');
});

test('reading newer pages keeps earlier messages in order and applies authoritative overlap updates', () => {
  const current = page(['m0', 'm1', 'm2'], { before: null, after: 'm2' });
  const newer = page(['m2', 'm3', 'm4'], { before: 'm2', after: 'm4', messages: [message('m2', 'finished tool output'), message('m3'), message('m4')] });
  const next = mergeDisplayPage(current, newer, 'after');
  assert.deepEqual(next.messages.map(item => item.id), ['m0', 'm1', 'm2', 'm3', 'm4']);
  assert.equal(next.before, null, 'forward pagination must not lose the already loaded start');
  assert.equal(next.after, 'm4');
  assert.equal(next.messages[0], current.messages[0], 'the visible reading anchor keeps its identity');
  assert.equal(next.messages[2].text, 'finished tool output');
  const tail = mergeDisplayPage(next, page(['m5', 'm6'], { after: null }), 'after');
  assert.deepEqual(tail.messages.map(item => item.id), ['m0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6']);
  assert.equal(tail.before, null); assert.equal(tail.after, null, 'the explicit final page reconnects the tail');
});

test('live snapshots append only after the known overlap and update changed text', () => {
  const current = page(['old-archive', 'visible', 'streaming']);
  const next = mergeDisplaySnapshot(current, [message('not-displayed'), message('visible'), message('streaming', 'updated'), message('new')]);
  assert.deepEqual(next.messages.map(item => item.id), ['old-archive', 'visible', 'streaming', 'new']);
  assert.equal(next.messages[0], current.messages[0]); assert.equal(next.messages[2].text, 'updated');
  assert.equal(mergeDisplaySnapshot(current, []), current, 'empty initial authority cannot erase saved messages');
});

test('a disjoint authority cannot overwrite a display page whose freshness it cannot prove', () => {
  const current = page(['just-read-0', 'just-read-1'], { before: null });
  const next = mergeDisplaySnapshot(current, Array.from({ length: 400 }, (_, index) => message(`other-${index}`)));
  assert.equal(next, current, 'an explicit display read must establish the gap before any unrelated window replaces visible history');
  assert.deepEqual(next.messages.map(item => item.id), ['just-read-0', 'just-read-1']);
  assert.equal(next.before, null); assert.equal(next.after, null);
});

test('detached history updates overlaps without appending a distant live tail', () => {
  const current = page(['archive'], { after: 'archive' });
  assert.equal(mergeDisplaySnapshot(current, [message('latest')]), current);
});

test('a continuous authoritative tail reconnects detached history so subsequent replies appear', () => {
  const current = page(['m0', 'm1', 'm2'], { before: null, after: 'm2' });
  const reconnected = mergeDisplaySnapshot(current, ['m1', 'm2', 'm3', 'm4'].map(id => message(id)));
  assert.deepEqual(reconnected.messages.map(item => item.id), ['m0', 'm1', 'm2', 'm3', 'm4']);
  assert.equal(reconnected.before, null);
  assert.equal(reconnected.after, null, 'known contiguous overlap proves that the displayed page has reached the live tail');
  assert.equal(reconnected.messages[0], current.messages[0]);
  const live = mergeDisplaySnapshot(reconnected, ['m3', 'm4', 'm5'].map(id => message(id)));
  assert.deepEqual(live.messages.map(item => item.id), ['m0', 'm1', 'm2', 'm3', 'm4', 'm5']);
  assert.equal(live.after, null);
});

test('an overlap before the displayed edge does not bridge a missing newer history gap', () => {
  const current = page(['m0', 'm1', 'm2'], { after: 'm2' });
  const next = mergeDisplaySnapshot(current, [message('m1', 'corrected'), message('m4'), message('m5')]);
  assert.deepEqual(next.messages.map(item => item.id), ['m0', 'm1', 'm2']);
  assert.equal(next.messages[1].text, 'corrected', 'known messages may still receive authoritative updates');
  assert.equal(next.after, 'm2', 'm3 must be read before this history window can follow the latest messages');
});

test('a delayed overlapping authority cannot move a freshly read final page backwards', () => {
  const oldWindow = page(['m0', 'm1'], { before: null, after: 'm1' });
  const current = mergeDisplayPage(oldWindow, page(['m2', 'm3'], { after: null }), 'after');
  const next = mergeDisplaySnapshot(current, [message('m0'), message('m1', 'updated historical text')]);
  assert.deepEqual(next.messages.map(item => item.id), ['m0', 'm1', 'm2', 'm3']);
  assert.equal(next.after, null);
  assert.equal(next.messages[1].text, 'updated historical text');
  assert.equal(next.messages.at(-1), current.messages.at(-1));
});

test('canonical completion retires the precise temporary stream ID while retaining historical canonical messages', () => {
  const current = page(['historic', 'user', 'turn:stream:1']);
  const next = mergeDisplaySnapshot(current, [message('user'), message('canonical-result')]);
  assert.deepEqual(next.messages.map(item => item.id), ['historic', 'user', 'canonical-result']);
  const ordinary = page(['user', 'other:stream:1']);
  assert.ok(mergeDisplaySnapshot(ordinary, [message('user'), message('result')]).messages.some(item => item.id === 'other:stream:1'));
});

test('non-following short conversations still append canonical replies and remain attached to the live tail', () => {
  const current = page(['user']);
  const first = mergeDisplaySnapshot(current, [message('user'), message('result-1')], true);
  assert.deepEqual(first.messages.map(item => item.id), ['user', 'result-1']);
  assert.equal(first.after, null, 'scrolling or an approval jump is not a detached history page');
  const second = mergeDisplaySnapshot(first, [message('user'), message('result-1'), message('result-2')], true);
  assert.deepEqual(second.messages.map(item => item.id), ['user', 'result-1', 'result-2']);
  assert.equal(second.after, null);
});

test('non-following stream completion removes the temporary row and adds its canonical assistant result', () => {
  const current = page(['user', 'turn:stream:1']);
  const next = mergeDisplaySnapshot(current, [message('user'), message('canonical-result')], true);
  assert.deepEqual(next.messages.map(item => item.id), ['user', 'canonical-result']);
  assert.equal(next.after, null);
  assert.equal(next.messages[0], current.messages[0], 'the original reading anchor stays the same object');
});

test('detached streaming completion reconnects through its canonical user and retains earlier history', () => {
  const current = page(['historic', 'user', 'turn:stream:1'], { before: null, after: 'turn:stream:1' });
  const next = mergeDisplaySnapshot(current, [message('user'), message('canonical-result')], true);
  assert.deepEqual(next.messages.map(item => item.id), ['historic', 'user', 'canonical-result']);
  assert.equal(next.after, null, 'retiring a temporary stream row must not leave the page detached at a deleted cursor');
  assert.equal(next.before, null); assert.equal(next.messages[0], current.messages[0]);
});

test('an older snapshot containing only the canonical user cannot erase a newer streaming reply', () => {
  const current = page(['historic', 'user', 'turn:stream:1']);
  const next = mergeDisplaySnapshot(current, [message('user')]);
  assert.equal(next, current, 'absence in an older authority is not evidence that streaming completed');
  assert.deepEqual(next.messages.map(item => item.id), ['historic', 'user', 'turn:stream:1']);
  assert.equal(next.after, null);
});

test('a previous assistant result cannot retire a later stream whose tool predecessor is not in that snapshot', () => {
  const tool: ChatMessage = { ...message('tool'), role: 'tool', toolName: 'read_file' };
  const current = page([], { messages: [message('user'), message('earlier-result'), tool, message('turn:stream:1')] });
  const next = mergeDisplaySnapshot(current, [message('user'), message('earlier-result')]);
  assert.equal(next, current);
  assert.deepEqual(next.messages.map(item => item.id), ['user', 'earlier-result', 'tool', 'turn:stream:1']);
});

test('a stream-only bounded page is not erased by an unrelated canonical authority', () => {
  const current = page(['turn:stream:1']);
  const next = mergeDisplaySnapshot(current, [{ ...message('older-result'), turnId: 'older-turn' }]);
  assert.equal(next, current, 'without a retained stable predecessor an unrelated canonical result cannot prove retirement');
  assert.equal(next.messages[0], current.messages[0]);
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

test('a count-capped history window can page forwards, reconnect and continue receiving new messages', () => {
  const original = page(Array.from({ length: 1000 }, (_, index) => `m${index}`), { before: null });
  const current = mergeDisplaySnapshot(original, Array.from({ length: 100 }, (_, index) => message(`m${950 + index}`)), true);
  assert.equal(current.after, 'm999'); assert.equal(current.messages[0], original.messages[0]);
  const catchUp = mergeDisplayPage(current, page(Array.from({ length: 50 }, (_, index) => `m${1000 + index}`), { after: null }), 'after');
  assert.equal(catchUp.messages.length, 1000);
  assert.equal(catchUp.messages[0].id, 'm50'); assert.equal(catchUp.before, 'm50');
  assert.equal(catchUp.messages.at(-1)?.id, 'm1049'); assert.equal(catchUp.after, null);
  const continued = mergeDisplaySnapshot(catchUp, [message('m1049'), message('m1050')]);
  assert.equal(continued.messages.length, 1000); assert.equal(continued.messages[0].id, 'm51');
  assert.equal(continued.messages.at(-1)?.id, 'm1050'); assert.equal(continued.after, null);
  const earlier = mergeDisplayPage(continued, page(['m48', 'm49', 'm50'], { before: 'm48', after: 'm50' }), 'before');
  assert.equal(earlier.messages[0].id, 'm48', 'evicted history remains recoverable through its cursor');
  assert.equal(earlier.after, earlier.messages.at(-1)?.id, 'returning to historical reading leaves an explicit forward cursor');
});

test('leaving protected reading reconnects a count-capped window only through its actual displayed edge', () => {
  const original = page(Array.from({ length: 1000 }, (_, index) => `m${index}`), { before: null });
  const capped = mergeDisplaySnapshot(original, [message('m999'), message('m1000')], true);
  assert.equal(capped.after, 'm999'); assert.equal(capped.messages[0], original.messages[0]);
  const missingEdge = mergeDisplaySnapshot(capped, [message('m998'), message('m1000'), message('m1001')]);
  assert.equal(missingEdge.after, 'm999');
  assert.equal(missingEdge.messages.at(-1)?.id, 'm999', 'following must not silently skip an unverified edge');
  const reconnected = mergeDisplaySnapshot(missingEdge, [message('m999'), message('m1000'), message('m1001')]);
  assert.equal(reconnected.after, null);
  assert.equal(reconnected.messages.length, 1000); assert.equal(reconnected.messages[0].id, 'm2');
  assert.equal(reconnected.messages.at(-1)?.id, 'm1001');
  const live = mergeDisplaySnapshot(reconnected, [message('m1001'), message('m1002')]);
  assert.equal(live.messages.at(-1)?.id, 'm1002'); assert.equal(live.after, null);
});

test('a byte-capped reading window preserves its anchor and reconnects through an overlapping small tail', () => {
  const original = page(['anchor', 'heavy'], { before: null, messages: [message('anchor', 'a'.repeat(2_100_000)), message('heavy', 'b'.repeat(2_100_000))] });
  const bounded = mergeDisplayPage(undefined, original, 'replace', true);
  assert.deepEqual(bounded.messages.map(item => item.id), ['anchor']);
  assert.equal(bounded.after, 'anchor'); assert.equal(bounded.messages[0], original.messages[0]);
  const caughtUp = mergeDisplayPage(bounded, page(['heavy', 'tail'], { after: null, messages: [original.messages[1], message('tail')] }), 'after');
  assert.deepEqual(caughtUp.messages.map(item => item.id), ['heavy', 'tail']);
  assert.equal(caughtUp.before, 'heavy'); assert.equal(caughtUp.after, null);
  const next = mergeDisplaySnapshot(caughtUp, [message('tail'), message('reply')]);
  assert.deepEqual(next.messages.map(item => item.id), ['heavy', 'tail', 'reply']);
  assert.equal(next.after, null);
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
