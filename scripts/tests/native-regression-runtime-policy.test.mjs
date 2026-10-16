import test from 'node:test';
import assert from 'node:assert/strict';
import { hasActiveChildTransportOverlap, safeUpstreamTransportFailure } from '../native-regression-runtime-policy.mjs';

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

test('连接诊断保留实际嵌套固定错误码并区分响应前和流阶段', () => {
  const cause = Object.assign(new Error('private hostname and credential'), { code: 'ENOTFOUND' });
  assert.deepEqual(safeUpstreamTransportFailure(new TypeError('fetch failed', { cause })), { stage: 'before_headers', code: 'ENOTFOUND' });
  assert.deepEqual(safeUpstreamTransportFailure({ cause: { code: 'ECONNRESET' } }, { stage: 'response_stream' }), { stage: 'response_stream', code: 'ECONNRESET' });
  assert.deepEqual(safeUpstreamTransportFailure({ code: 'UND_ERR_CONNECT_TIMEOUT' }), { stage: 'before_headers', code: 'UND_ERR_CONNECT_TIMEOUT' });
});

test('连接诊断不会公开任意异常内容或执行属性getter', () => {
  let accessed = false;
  const error = Object.defineProperties({}, {
    code: { get() { accessed = true; return 'ENOTFOUND'; } },
    cause: { get() { accessed = true; throw new Error('secret'); } },
  });
  assert.deepEqual(safeUpstreamTransportFailure(error), { stage: 'before_headers', code: 'UNKNOWN' });
  assert.equal(accessed, false);
  assert.deepEqual(safeUpstreamTransportFailure({ code: 'private-value', message: 'secret', stack: 'private' }, { stage: 'private-host' }), { stage: 'before_headers', code: 'UNKNOWN' });
});

test('取消优先且循环或超深异常链保持有界', () => {
  const error = { code: 'ECONNRESET' }; error.cause = error;
  assert.deepEqual(safeUpstreamTransportFailure(error, { aborted: true }), { stage: 'before_headers', code: 'ABORTED' });
  const cycle = {}; cycle.cause = cycle;
  assert.equal(safeUpstreamTransportFailure(cycle).code, 'UNKNOWN');
  assert.equal(safeUpstreamTransportFailure({ cause: { cause: { cause: { code: 'ENOTFOUND' } } } }).code, 'UNKNOWN');
});
