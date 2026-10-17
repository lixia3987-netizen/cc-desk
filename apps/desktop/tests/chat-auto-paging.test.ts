import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChatDisplayPage } from '../src/shared/chat';
import { ChatPagingGuard, chatPagingDirection } from '../src/renderer/chat-auto-paging';

const page = (first = 'm1', last = 'm2', patch: Partial<ChatDisplayPage> = {}): ChatDisplayPage => ({ sessionId: 'session', before: first, after: null, incomplete: false,
  messages: [first, last].map(id => ({ id, role: 'assistant', text: id, turnId: 'run', createdAt: '2026-10-17' })), ...patch });
const short = { top: 0, height: 800, scrollHeight: 800 };

test('a nonoverflowing first page fills older records even without a scroll event', () => {
  assert.equal(chatPagingDirection(page(), short), 'before');
  assert.equal(chatPagingDirection(page(), { ...short, height: 0 }), undefined);
  assert.equal(chatPagingDirection(page(), { ...short, scrollHeight: 1200 }), undefined, 'ordinary live tails do not fetch old records on every render');
  assert.equal(chatPagingDirection(page('m1', 'm2', { before: null }), short), undefined);
});

test('wheel and scroll intent use the correct edge and newer navigation is symmetric', () => {
  const detached = page('m1', 'm2', { after: 'm2' });
  assert.equal(chatPagingDirection(detached, short, 'before'), 'before');
  assert.equal(chatPagingDirection(detached, short, 'after'), 'after', 'a downward wheel works when no scroll event is possible');
  assert.equal(chatPagingDirection(detached, { top: 5, height: 800, scrollHeight: 2000 }, 'before'), 'before');
  assert.equal(chatPagingDirection(detached, { top: 1190, height: 800, scrollHeight: 2000 }, 'after'), 'after');
  assert.equal(chatPagingDirection(detached, { top: 500, height: 800, scrollHeight: 2000 }, 'after'), undefined);
  assert.equal(chatPagingDirection(detached, short, undefined, 'after'), 'after', 'automatic filling keeps the gesture direction');
});

test('an empty or unchanged page cannot cause an unbounded automatic request loop', () => {
  const guard = new ChatPagingGuard(), initial = page();
  assert.equal(guard.claim(initial, 'before'), true);
  assert.equal(guard.claim(initial, 'before'), false, 'the same boundary is claimed once');
  guard.complete(initial, initial, 'before');
  assert.equal(guard.claim(page('m0'), 'before'), false, 'a no-progress response pauses background work');
  assert.equal(guard.claim(initial, 'before', true), true, 'an explicit new gesture can retry');
});

test('reaching the cap cannot alternate older and newer requests without another reading gesture', () => {
  const guard = new ChatPagingGuard(), initial = page(), capped = page('m0', 'm1', { after: 'm1' });
  assert.equal(guard.claim(initial, 'before'), true); guard.complete(initial, capped, 'before');
  assert.equal(guard.claim(capped, 'before'), false, 'capacity trimming pauses autofill');
  assert.equal(guard.claim(capped, 'after'), false, 'anchor restoration cannot pull the other direction');
  assert.equal(guard.claim(capped, 'after', true), true, 'reading toward newer messages resumes that direction');
  assert.equal(chatPagingDirection(capped, short, undefined, guard.direction), 'after');
});

test('collapsed records can trigger at most eight consecutive automatic reads per fill pass', () => {
  const guard = new ChatPagingGuard();
  for (let index = 0; index < 8; index++) assert.equal(guard.claim(page(`m${index}`), 'before'), true);
  assert.equal(guard.claim(page('m8'), 'before'), false);
  assert.equal(guard.claim(page('m8'), 'before', true), true);
});

test('a failed or canceled read stops autofill until the user explicitly resumes', () => {
  const guard = new ChatPagingGuard(), initial = page();
  assert.equal(guard.claim(initial, 'before'), true); guard.complete(initial, undefined, 'before');
  assert.equal(guard.claim(initial, 'before'), false);
  assert.equal(guard.claim(initial, 'before', true), true);
});
