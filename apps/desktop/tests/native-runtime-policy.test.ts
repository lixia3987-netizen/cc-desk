import test from 'node:test';
import assert from 'node:assert/strict';
import type { EngineConfig } from '../src/shared/execution';
import { nativeRuntimePolicyKeys, resolveNativeRuntimeConfig } from '../src/shared/native-runtime-policy';
import { createNativeConfig, createNativeDefaultConfig, parseNativeConfig } from '../src/main/engines/native/config';

test('legacy Native sessions retain their custom budget and fresh descriptor defaults follow the model', () => {
  const legacy = createNativeConfig({ schemaVersion: 1, options: { maxInputTokens: 32_000, autoCompact: 'before_send' } });
  assert.equal(legacy.options.runtimePolicy, 'custom'); assert.equal(legacy.options.inputBudgetMode, 'custom');
  assert.equal(legacy.options.maxInputTokens, 32_000); assert.equal(legacy.options.autoCompact, 'before_send');
  assert.equal(createNativeDefaultConfig().options.inputBudgetMode, 'model');
  assert.equal(createNativeConfig().options.maxInputTokens, 64_000);
  assert.deepEqual(resolveNativeRuntimeConfig(legacy, createNativeDefaultConfig()), legacy);
});

test('following settings inherits only runtime policy and leaves session binding, selections and unknown data independent', () => {
  const session: EngineConfig = { schemaVersion: 1, options: {
    runtimePolicy: 'defaults', connectionId: 'session-connection', model: 'session-model',
    projectSkills: ['session-skill'], mcpConnections: ['session-mcp'], futureOption: { retained: [true, 'value'] }, maxInputTokens: 16_000,
  } };
  const defaults: EngineConfig = { schemaVersion: 1, options: {
    inputBudgetMode: 'model', maxInputTokens: 128_000, maxOutputTokens: 4096, autoCompact: 'before_send', modelRetry: 'safe_transient',
    maxModelRequests: 7, maxToolCalls: 11, maxActiveMs: 120_000, connectionId: 'global-connection', model: 'global-model',
    projectSkills: ['global-skill'], mcpConnections: ['global-mcp'], futureOption: { retained: [] }, runtimePolicy: 'custom',
  } };
  const original = structuredClone(session), resolved = resolveNativeRuntimeConfig(session, defaults);
  for (const key of nativeRuntimePolicyKeys) assert.deepEqual(resolved.options[key], defaults.options[key]);
  for (const key of ['runtimePolicy', 'connectionId', 'model', 'projectSkills', 'mcpConnections', 'futureOption']) assert.deepEqual(resolved.options[key], session.options[key]);
  (resolved.options.projectSkills as string[]).push('new-selection');
  assert.deepEqual(session, original, 'editing a resolved snapshot cannot change the saved session');
  defaults.options.maxOutputTokens = 128;
  assert.equal(resolved.options.maxOutputTokens, 4096, 'running policy snapshots do not track mutable settings');
});

test('partial defaults keep absent policy values and mismatched or unknown schema versions remain untouched', () => {
  const config: EngineConfig = { schemaVersion: 1, options: { runtimePolicy: 'defaults', maxInputTokens: 64_000, maxOutputTokens: 8192 } };
  assert.deepEqual(resolveNativeRuntimeConfig(config, { schemaVersion: 1, options: { maxOutputTokens: 512 } }).options,
    { runtimePolicy: 'defaults', maxInputTokens: 64_000, maxOutputTokens: 512 });
  assert.deepEqual(resolveNativeRuntimeConfig(config), config);
  assert.deepEqual(resolveNativeRuntimeConfig(config, { schemaVersion: 99, options: { maxInputTokens: 2_000_000 } }), config);
  const future = { ...config, schemaVersion: 99 };
  assert.deepEqual(resolveNativeRuntimeConfig(future, { schemaVersion: 99, options: { maxInputTokens: 2_000_000 } }), future);
});

test('Native policy markers validate explicitly and unrelated supplied fields are never silently dropped', () => {
  const invalidOptions: EngineConfig['options'][] = [{ runtimePolicy: 'automatic' }, { inputBudgetMode: 'unlimited' }, { unexpected: 'retain elsewhere' }];
  for (const options of invalidOptions) {
    assert.throws(() => parseNativeConfig({ schemaVersion: 1, options }));
  }
  assert.equal(parseNativeConfig({ schemaVersion: 1, options: { runtimePolicy: 'defaults', inputBudgetMode: 'model' } }).runtimePolicy, 'defaults');
});
