import assert from 'node:assert/strict';
import test from 'node:test';
import { VirtualChatLayout } from '../src/renderer/virtual-chat-layout';

const ids = (count: number) => Array.from({ length: count }, (_, index) => `message-${index}`);

test('virtual chat estimates only missing heights and rejects invalid measurements', () => {
  const layout = new VirtualChatLayout();
  assert.equal(layout.totalHeight, 0);
  assert.equal(layout.setItems(['a', 'b', 'c']), true);
  assert.equal(layout.totalHeight, 360);
  assert.equal(layout.measure('b', 240.25), true);
  assert.equal(layout.measure('b', 240.4), false);
  assert.equal(layout.totalHeight, 480.25);
  assert.deepEqual([layout.offset(0), layout.offset(1), layout.offset(2), layout.offset(3)], [0, 120, 360.25, 480.25]);
  for (const height of [0, -1, NaN, Infinity]) assert.equal(layout.measure('a', height), false);
  assert.equal(layout.measure('missing', 500), false);
  assert.equal(layout.totalHeight, 480.25);
  assert.equal(layout.size(1), 240.25);
  assert.equal(layout.size(3), 0);
});

test('virtual chat finds rows at exact height boundaries and clamps outside positions', () => {
  const layout = new VirtualChatLayout(100);
  layout.setItems(['a', 'b', 'c']);
  layout.measure('b', 250);
  assert.deepEqual([-100, 0, 99.5, 100, 349.9, 350, 450, Infinity].map(top => layout.indexAt(top)), [0, 0, 0, 1, 1, 2, 2, 2]);
  assert.equal(layout.offset(-2), 0);
  assert.equal(layout.offset(99), 450);
  assert.equal(layout.indexOf('b'), 1);
  assert.equal(layout.indexOf('absent'), -1);
  layout.setItems([]);
  assert.equal(layout.indexAt(0), 0);
  assert.equal(layout.totalHeight, 0);
  assert.deepEqual(layout.range(0, 800), { start: 0, end: 0, before: 0, after: 0 });
});

test('virtual chat keeps measured identity through prepend, reorder, and unchanged snapshots', () => {
  const layout = new VirtualChatLayout(100);
  layout.setItems(['a', 'b', 'c']);
  layout.measure('a', 150); layout.measure('b', 300);
  const original = layout.offset(layout.indexOf('b'));
  assert.equal(layout.setItems(['a', 'b', 'c']), false);
  layout.setItems(['older-1', 'older-2', 'a', 'b', 'c']);
  assert.equal(layout.offset(layout.indexOf('b')) - original, 200);
  assert.equal(layout.size(layout.indexOf('b')), 300);
  layout.setItems(['c', 'b', 'a']);
  assert.equal(layout.offset(layout.indexOf('b')), 100);
  assert.equal(layout.size(layout.indexOf('a')), 150);
  // Removed identities are discarded, bounding the cache to the loaded page.
  layout.setItems(['c']); layout.setItems(['a', 'c']);
  assert.equal(layout.size(0), 100);
});

test('virtual chat mounts a bounded initial window at the head, tail, or a saved anchor', () => {
  const layout = new VirtualChatLayout();
  layout.setItems(ids(400));
  const head = layout.range(0, 800, 400);
  const tail = layout.range(layout.totalHeight - 800, 800, 400);
  const anchor = layout.range(layout.offset(199) - 800 / 3, 800, 400);
  assert.equal(head.start, 0);
  assert.equal(tail.end, 400);
  assert.ok(anchor.start <= 199 && anchor.end > 199);
  for (const window of [head, tail, anchor]) {
    assert.ok(window.end - window.start >= 8 && window.end - window.start <= 20);
    assert.equal(window.before + layout.offset(window.end) - layout.offset(window.start) + window.after, layout.totalHeight);
  }
  const beyond = layout.range(Infinity, 800, 400);
  assert.equal(beyond.end, 400);
  assert.equal(beyond.end - beyond.start, 8);
});

test('virtual chat expands and collapses very tall rows without mounting the entire history', () => {
  const layout = new VirtualChatLayout(100);
  layout.setItems(ids(400));
  const before = layout.totalHeight;
  layout.measure('message-180', 40_000);
  assert.equal(layout.totalHeight, before + 39_900);
  assert.equal(layout.indexAt(layout.offset(180) + 30_000), 180);
  const expanded = layout.range(layout.offset(180) + 30_000, 800, 400);
  assert.ok(expanded.start <= 180 && expanded.end > 180);
  assert.equal(expanded.end - expanded.start, 8);
  assert.ok(expanded.after > 0);
  layout.measure('message-180', 50);
  assert.equal(layout.totalHeight, before - 50);
  assert.equal(layout.indexAt(layout.offset(181)), 181);
  const collapsed = layout.range(layout.offset(180), 800, 400);
  assert.ok(collapsed.start <= 180 && collapsed.end > 180);
  assert.ok(collapsed.end - collapsed.start <= 50);
});

test('virtual chat mounts few long rows while covering the viewport and overscan', () => {
  const layout = new VirtualChatLayout();
  const messages = ids(400);
  layout.setItems(messages);
  for (const id of messages) layout.measure(id, 2_000);
  const top = layout.offset(180) + 1_500;
  const window = layout.range(top, 900, 400);
  assert.equal(window.end - window.start, 8);
  assert.ok(window.start <= 180 && window.end > 181);
  assert.ok(layout.offset(window.start) <= top - 400);
  assert.ok(layout.offset(window.end) >= top + 900 + 400);
  assert.equal(layout.range(top, 900, 400, NaN).end - layout.range(top, 900, 400, NaN).start, 8);
});

test('virtual chat can invalidate wrapping-dependent heights and handles short pages', () => {
  const layout = new VirtualChatLayout(80);
  layout.setItems(['a', 'b', 'c']); layout.measure('a', 500);
  assert.equal(layout.resetMeasurements(), true);
  assert.equal(layout.resetMeasurements(), false);
  assert.equal(layout.totalHeight, 240);
  assert.deepEqual(layout.range(-50, 900), { start: 0, end: 3, before: 0, after: 0 });
  assert.equal(new VirtualChatLayout(NaN).estimatedHeight, 120);
});
