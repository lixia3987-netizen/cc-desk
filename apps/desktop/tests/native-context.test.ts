import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ContextMeter } from '../src/renderer/ContextMeter';
import { EngineConfigFields, parseEngineConfigNumber } from '../src/renderer/EngineConfiguration';
import { parseNativeConfig } from '../src/main/engines/native/config';
import { nativeRunError } from '../src/main/engines/native/run-errors';
import type { ContextUsage, EngineConfigField } from '../src/shared/execution';

const budget: NonNullable<ContextUsage['budget']> = { estimatedInputTokens: 950, maxInputTokens: 1000, contextBytes: 300, maxContextBytes: 10000, estimator: 'utf8_bytes', status: 'near_limit' };
const render = (context?: ContextUsage) => renderToStaticMarkup(createElement(ContextMeter, { context, native: true }));

test('native context UI separates local budgets, actual request input and unknown usage', () => {
  const pending = render();
  assert.match(pending, /运行预算/); assert.match(pending, /等待本回合预算数据/);
  assert.doesNotMatch(pending, /\/compact|\/context|CLI|aria-valuenow/);
  const known = render({ budget, inputTokens: 0, status: 'ready', source: 'request' });
  assert.match(known, /95\.0%/); assert.match(known, /接近预算上限/);
  assert.match(known, /最近一次请求输入：0 tokens/); assert.match(known, /非累计/);
  assert.match(known, /不是模型的真实上下文窗口或计费用量/);
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

test('native auto compaction stays off for existing configurations and requires an explicit supported opt-in', () => {
  const existing = { schemaVersion: 1, options: { model: 'existing-model', maxInputTokens: 32000 } };
  assert.equal(parseNativeConfig(existing).autoCompact, 'off');
  assert.deepEqual(existing.options, { model: 'existing-model', maxInputTokens: 32000 });
  const enabled = parseNativeConfig({ ...existing, options: { ...existing.options, autoCompact: 'before_send' } });
  assert.equal(enabled.autoCompact, 'before_send');
  assert.equal(enabled.model, 'existing-model');
  assert.equal(enabled.maxInputTokens, 32000);
  assert.equal(parseNativeConfig({ schemaVersion: 1, options: { autoCompact: 'off' } }).autoCompact, 'off');
  for (const autoCompact of [true, false, 90, null, '', 'on', 'automatic', ' before_send ']) {
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
