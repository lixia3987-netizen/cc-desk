import test from 'node:test';
import assert from 'node:assert/strict';
import { hasActiveChildTransportOverlap } from '../native-regression-runtime-policy.mjs';

test('取消由两个不同 child 的真实活跃上游请求触发，本地接收或父请求不足以触发', () => {
  const first = { role: 'child', runId: 'a', upstreamBeginMs: 37439, endMs: null };
  const second = { role: 'child', runId: 'b', upstreamBeginMs: 37441, endMs: null };
  assert.equal(hasActiveChildTransportOverlap([first, second]), true);
  assert.equal(hasActiveChildTransportOverlap([first, { ...second, upstreamBeginMs: null }]), false);
  assert.equal(hasActiveChildTransportOverlap([first, { ...second, role: 'parent' }]), false);
  assert.equal(hasActiveChildTransportOverlap([first, { ...second, runId: 'a' }]), false);
  assert.equal(hasActiveChildTransportOverlap([{ ...first, endMs: 37440 }, second]), false);
  assert.equal(hasActiveChildTransportOverlap([]), false);
});
