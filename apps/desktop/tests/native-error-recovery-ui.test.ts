import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ModelFailureDiagnostic } from '@cc-desk/agent-core';
import { createNativeConfig, NATIVE_MODEL_RETRY_FIELD, parseNativeConfig } from '../src/main/engines/native/config';
import { nativeModelFailureMessage, nativeRunError } from '../src/main/engines/native/run-errors';
import { EngineConfigFields } from '../src/renderer/EngineConfiguration';

test('existing native configurations never opt into paid model retries implicitly', () => {
  const existing = { schemaVersion: 1, options: { model: 'existing-model', autoCompact: 'before_send', maxModelRequests: 9 } };
  const snapshot = structuredClone(existing);
  assert.equal(parseNativeConfig(existing).modelRetry, 'off');
  assert.equal(createNativeConfig().options.modelRetry, 'off');
  assert.deepEqual(existing, snapshot);
  const enabled = parseNativeConfig({ ...existing, options: { ...existing.options, modelRetry: 'safe_transient' } });
  assert.equal(enabled.modelRetry, 'safe_transient');
  assert.equal(enabled.maxModelRequests, 9);
  assert.equal(enabled.autoCompact, 'before_send');
  for (const modelRetry of [true, false, 0, 2, null, '', 'on', 'all', 'safe_transient ', {}, []]) {
    assert.throws(() => parseNativeConfig({ schemaVersion: 1, options: { modelRetry } }));
  }
});

test('the actual native retry control explains consent, budget, bounded waits and locks while running', () => {
  const render = (running: boolean) => renderToStaticMarkup(createElement(EngineConfigFields, {
    value: createNativeConfig(), fields: [NATIVE_MODEL_RETRY_FIELD], running,
    onChange: () => { throw new Error('render must not change retry consent'); },
  }));
  const stopped = render(false);
  assert.match(stopped, /value="off" selected=""/);
  assert.match(stopped, /value="safe_transient"/);
  for (const text of ['默认关闭', '完整模型响应与工具结果', '部分输出', '429', '502', '503', '504', '额外请求 2 次', '500 毫秒、1500 毫秒', '可取消', '每次请求可能计费', '模型请求次数与执行时长', '摘要和本地工具不自动重试', '结果未知的操作不重放']) assert.ok(stopped.includes(text), text);
  assert.doesNotMatch(stopped, /disabled=""/);
  assert.match(render(true), /disabled=""/);
  assert.match(render(true), /停止会话后可修改此项/);
});

test('model failure categories provide distinct corrective actions without exposing transport details', () => {
  const cases: [ModelFailureDiagnostic['category'], RegExp][] = [
    ['authentication', /连接密钥、账号权限和模型权限/], ['configuration', /服务地址、协议、模型名称和请求限制/],
    ['rate_limit', /配额与限流设置/], ['service_unavailable', /服务状态/], ['service_error', /未纳入自动恢复范围/],
    ['protocol', /协议兼容性/], ['network', /服务端是否已处理请求尚未确认/], ['timeout', /请求超时/],
    ['security', /HTTPS 和重定向设置/], ['unknown', /无法确认原因/],
  ];
  for (const [category, action] of cases) {
    const failure = { category, retryable: false, secret: 'sk-private-provider-text' };
    assert.match(nativeRunError(`model_${category}`), action);
    assert.match(nativeModelFailureMessage(failure, false), action);
    assert.doesNotMatch(nativeModelFailureMessage(failure, false), /sk-private-provider-text/);
  }
  assert.equal(nativeRunError('future_stable_reason'), 'future_stable_reason');
  assert.equal(nativeRunError('__proto__'), '__proto__');
});

test('retry notices require the exact safe transient classification and never promise replay after partial output', () => {
  for (const httpStatus of [429, 502, 503, 504]) {
    const failure: ModelFailureDiagnostic = { category: httpStatus === 429 ? 'rate_limit' : 'service_unavailable', httpStatus, retryable: true };
    const notice = nativeModelFailureMessage(failure, false, 500);
    assert.match(notice, /500 毫秒/); assert.match(notice, /等待期间可取消/); assert.match(notice, /每次请求可能计费/);
    assert.match(notice, /不会重放本地工具/); assert.doesNotMatch(notice, /已停止本回合/);
    const partial = nativeModelFailureMessage(failure, true, 500);
    assert.match(partial, /未完成的模型输出已丢弃/); assert.match(partial, /不会与后续响应拼接/);
    assert.doesNotMatch(partial, /将在|等待期间可取消/);
    assert.doesNotMatch(nativeModelFailureMessage({ ...failure, retryable: false }, false, 500), /将在/);
    assert.doesNotMatch(nativeModelFailureMessage(failure, false, 501), /将在/);
  }
  assert.match(nativeModelFailureMessage({ category: 'rate_limit', httpStatus: 429, retryable: true }, false, 1500), /1500 毫秒/);
  assert.doesNotMatch(nativeModelFailureMessage({ category: 'service_error', httpStatus: 500, retryable: true }, false, 500), /将在/);
  assert.doesNotMatch(nativeModelFailureMessage({ category: 'unknown', httpStatus: 503, retryable: true }, false, 500), /将在/);
});

test('blocking summaries only include stable categories and valid durable counters', () => {
  const summary = nativeRunError('model_retry_exhausted', { modelRequests: 5, toolCalls: 0, retries: 2, modelFailure: 'rate_limit', partial: true });
  assert.match(summary, /已用完本回合允许的有限重试次数/);
  assert.match(summary, /最近一次模型错误：服务限流/);
  assert.match(summary, /模型请求 5 次、工具调用 0 次/);
  assert.match(summary, /有限重试 2 次/);
  assert.match(summary, /未完成的模型输出已丢弃/);
  for (const modelFailure of ['sk-private-provider-text', '__proto__', 'constructor']) {
    const message = nativeRunError('model_unknown', { modelFailure });
    assert.match(message, /最近一次模型错误：未知模型错误/); assert.ok(!message.includes(modelFailure));
  }
  for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const message = nativeRunError('tool_no_progress', { modelRequests: value, toolCalls: value, retries: value });
    assert.doesNotMatch(message, /已计入|已执行有限重试/);
  }
  assert.doesNotMatch(nativeRunError('model_retry_exhausted', { retries: 3 }), /已执行有限重试/);
});

test('tool and persistence blockers keep unknown effects under explicit user control', () => {
  for (const reason of ['tool_failure_repeated', 'tool_no_progress']) {
    assert.match(nativeRunError(reason), /已停止本回合/);
    assert.match(nativeRunError(reason), /任务证据/);
    assert.match(nativeRunError(reason), /不会自动重放已准备或结果未知的操作/);
  }
  assert.match(nativeRunError('store_model_request_started_failed'), /本次未发送模型请求/);
  assert.match(nativeRunError('store_model_request_failed_failed'), /请求结果和费用可能尚未确认/);
  for (const reason of ['store_model_request_started_failed', 'store_model_request_failed_failed']) assert.match(nativeRunError(reason), /恢复状态/);
  assert.match(nativeRunError('model_retry_wait_failed'), /不会自动继续请求或重放工具/);
});
