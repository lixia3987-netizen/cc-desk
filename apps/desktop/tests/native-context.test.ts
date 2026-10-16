import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ContextMeter } from '../src/renderer/ContextMeter';
import { EngineConfigFields, parseEngineConfigNumber } from '../src/renderer/EngineConfiguration';
import { NATIVE_SUBAGENT_FIELDS, parseNativeConfig } from '../src/main/engines/native/config';
import { nativeRunError } from '../src/main/engines/native/run-errors';
import type { ContextUsage, EngineConfigField } from '../src/shared/execution';

const budget: NonNullable<ContextUsage['budget']> = { estimatedInputTokens: 950, maxInputTokens: 1000, contextBytes: 300, maxContextBytes: 10000, estimator: 'utf8_bytes', status: 'near_limit' };
const render = (context?: ContextUsage) => renderToStaticMarkup(createElement(ContextMeter, { context, native: true }));

test('request peak and cache counts are distinct from local UTF-8 estimates and cumulative usage', () => {
  const html = render({ status: 'ready', inputTokens: 40, peakInputTokens: 100, peakInputComplete: false, budget,
    requestUsage: { inputTokens: 40, nonCachedInputTokens: 10, cacheReadInputTokens: 30, cacheCreationInputTokens: null,
      provider: { raw: { input_tokens: 40, cached_tokens: 30 }, normalization: 'openai-inclusive-input' } } });
  assert.match(html, /950.*1,000 UTF-8 估算单位/);
  assert.match(html, /不是模型真实 token/);
  assert.match(html, /已报告输入峰值：100 tokens.*仍有请求用量未知/);
  assert.match(html, /非缓存 10 tokens.*缓存读取 30 tokens.*缓存创建 未知/);
  assert.match(html, /缓存折扣不减小上下文占用/);
  assert.match(html, /input_tokens=40 tokens.*归一化来源：openai-inclusive-input/);
  assert.doesNotMatch(html, /950.*估算 tokens|缓存创建 0/);
  const diagnostics = render({ status: 'unknown', requestDiagnostic: { attempt: 2, purpose: 'retry', phase: 'finished', requestSent: null,
    contextBytes: 300, estimatedInputTokens: null, estimateMethod: 'unknown', estimateSource: 'unknown',
    components: { history: { bytes: 100, accounting: 'serialized' }, images: { bytes: 120, accounting: 'logical' } } } });
  assert.match(diagnostics, /第 2 次尝试.*重试.*是否已发送未知/);
  assert.match(diagnostics, /输入估算未知.*请求序列化大小 未知/);
  assert.match(diagnostics, /历史.*100.*序列化分项.*图像.*120.*逻辑分类/);
  assert.match(diagnostics, /不能直接相加.*诊断不包含正文/);
});

test('native context UI separates local budgets, actual request input and unknown usage', () => {
  const pending = render();
  assert.match(pending, /运行预算/); assert.match(pending, /等待本回合预算数据/);
  assert.doesNotMatch(pending, /\/compact|\/context|CLI|aria-valuenow/);
  const known = render({ budget, inputTokens: 0, status: 'ready', source: 'request' });
  assert.match(known, /95\.0%/); assert.match(known, /接近预算上限/);
  assert.match(known, /最近一次请求输入：0 tokens/); assert.match(known, /非累计/);
  assert.match(known, /运行预算按所选输入预算方式计算，并受已知模型限制约束/);
  assert.match(known, /为输出预留窗口空间/);
  assert.match(known, /窗口信息未知，沿用用户预算/);
  assert.doesNotMatch(known, /\/compact|CLI/);
  const unknown = render({ budget: { ...budget, status: 'exceeded', contextBytes: 20000 }, status: 'unknown' });
  assert.match(unknown, /200\.0%/); assert.match(unknown, /已超过预算/);
  assert.match(unknown, /未提供输入 token 用量/); assert.doesNotMatch(unknown, /请求输入：0/);
});

test('integer budget controls preserve invalid drafts and enforce renderer/host bounds', () => {
  const field: EngineConfigField = { key: 'maxInputTokens', type: 'number', label: '输入预算', min: 1024, max: 2_000_000, apply: 'stopped' };
  for (const value of ['', ' ', 'NaN', 'Infinity', '1.5', '1023', '2000001', '-1024']) assert.equal(parseEngineConfigNumber(value, field), undefined, value);
  assert.equal(parseEngineConfigNumber('1024', field), 1024);
  assert.equal(parseEngineConfigNumber('2000000', field), 2_000_000);
  const config = { schemaVersion: 1, options: { maxInputTokens: 64000 } };
  const markup = (running: boolean) => renderToStaticMarkup(createElement(EngineConfigFields, { value: config, fields: [field], running, onChange: () => { throw new Error('render must not mutate'); } }));
  assert.match(markup(false), /type="number"/); assert.match(markup(false), /min="1024"/); assert.match(markup(false), /max="2000000"/); assert.match(markup(false), /step="1"/);
  assert.doesNotMatch(markup(false), /disabled=""/); assert.match(markup(true), /disabled=""/);
  for (const value of [NaN, Infinity, 1.5, 1023, 2_000_001, '64000']) assert.throws(() => parseNativeConfig({ schemaVersion: 1, options: { maxInputTokens: value } }));
  assert.equal(parseNativeConfig(config).maxInputTokens, 64000);
  const preserved = renderToStaticMarkup(createElement(EngineConfigFields, { value: { schemaVersion: 1, options: { maxInputTokens: 'future-value' } }, fields: [field], onChange: () => { throw new Error('must preserve unknown value'); } }));
  assert.match(preserved, /disabled=""/); assert.match(preserved, /原始配置已保留/);
});

test('subagent duration edits use minutes and round-trip existing millisecond values without truncation', () => {
  const field = NATIVE_SUBAGENT_FIELDS.find(item => item.key === 'maxActiveMs')!;
  assert.equal(parseEngineConfigNumber('30', field), 30 * 60_000);
  assert.equal(parseEngineConfigNumber('300', field), 300 * 60_000);
  assert.equal(parseEngineConfigNumber('0.5', field), 30_000);
  for (const milliseconds of [1000, 12345, 5 * 60_000]) {
    assert.equal(parseEngineConfigNumber(String(milliseconds / 60_000), field), milliseconds);
  }
  for (const invalid of ['', ' ', 'NaN', 'Infinity', '301', '0', '0.00001']) assert.equal(parseEngineConfigNumber(invalid, field), undefined, invalid);
  const config = { schemaVersion: 1, options: { maxActiveMs: 30 * 60_000 } };
  const markup = renderToStaticMarkup(createElement(EngineConfigFields, { value: config, fields: [field], onChange: () => { throw new Error('render must not mutate stored milliseconds'); } }));
  assert.match(markup, /运行时长上限（分钟）/);
  assert.match(markup, /max="300"/);
  assert.match(markup, /value="30"/);
  assert.equal(config.options.maxActiveMs, 30 * 60_000);
});

test('native auto compaction stays off for existing configurations and requires an explicit supported opt-in', () => {
  const existing = { schemaVersion: 1, options: { model: 'existing-model', maxInputTokens: 32000 } };
  assert.equal(parseNativeConfig(existing).autoCompact, 'off');
  assert.deepEqual(existing.options, { model: 'existing-model', maxInputTokens: 32000 });
  const enabled = parseNativeConfig({ ...existing, options: { ...existing.options, autoCompact: 'before_send' } });
  assert.equal(enabled.autoCompact, 'before_send');
  assert.equal(enabled.model, 'existing-model');
  assert.equal(enabled.maxInputTokens, 32000);
  const inTurn = parseNativeConfig({ ...existing, options: { ...existing.options, autoCompact: 'before_send_and_during_run' } });
  assert.equal(inTurn.autoCompact, 'before_send_and_during_run');
  assert.equal(inTurn.maxModelRequests, enabled.maxModelRequests);
  assert.equal(inTurn.maxActiveMs, enabled.maxActiveMs);
  assert.equal(parseNativeConfig({ schemaVersion: 1, options: { autoCompact: 'off' } }).autoCompact, 'off');
  for (const autoCompact of [true, false, 90, null, '', 'on', 'automatic', ' before_send ', 'during_run', ' before_send_and_during_run ']) {
    assert.throws(() => parseNativeConfig({ schemaVersion: 1, options: { autoCompact } }));
  }
});

test('budget failure explanations remain distinct and keep unknown runtime reasons intact', () => {
  assert.match(nativeRunError('context_budget'), /下一次模型请求/);
  assert.match(nativeRunError('model_request_budget'), /模型请求次数上限/);
  assert.match(nativeRunError('tool_call_budget'), /工具调用次数上限/);
  assert.match(nativeRunError('active_time_budget'), /执行时长上限/);
  assert.equal(nativeRunError('store_capacity_failed'), 'store_capacity_failed');
});
