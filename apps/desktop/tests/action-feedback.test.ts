import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { paintActionFeedback } from '../src/renderer/action-feedback';

function frames(t: TestContext) {
  const request = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame');
  const cancel = Object.getOwnPropertyDescriptor(globalThis, 'cancelAnimationFrame');
  let callback: FrameRequestCallback | undefined;
  const cancelled: number[] = [];
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: (next: FrameRequestCallback) => { callback = next; return 7; } });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: (id: number) => { cancelled.push(id); } });
  t.after(() => {
    if (request) Object.defineProperty(globalThis, 'requestAnimationFrame', request); else Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
    if (cancel) Object.defineProperty(globalThis, 'cancelAnimationFrame', cancel); else Reflect.deleteProperty(globalThis, 'cancelAnimationFrame');
  });
  return { paint: () => callback!(0), cancelled };
}

test('action dispatch waits for a task after the feedback animation frame', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const frame = frames(t);
  let dispatched = false;
  const pending = paintActionFeedback().then(() => { dispatched = true; });
  await Promise.resolve();
  assert.equal(dispatched, false);
  frame.paint();
  await Promise.resolve();
  assert.equal(dispatched, false, 'animation frame callback precedes the actual paint');
  t.mock.timers.tick(0);
  await pending;
  assert.equal(dispatched, true);
  assert.deepEqual(frame.cancelled, []);
});

test('a hidden window with no animation frames does not block an operation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const frame = frames(t);
  let dispatched = false;
  const pending = paintActionFeedback().then(() => { dispatched = true; });
  t.mock.timers.tick(99);
  await Promise.resolve();
  assert.equal(dispatched, false);
  t.mock.timers.tick(1);
  await pending;
  assert.equal(dispatched, true);
  assert.deepEqual(frame.cancelled, [7]);
});
