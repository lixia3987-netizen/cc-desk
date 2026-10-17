import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeConfig, createNativeDefaultConfig, nativeConfigDigest, normalizeNativeLegacySkillPolicy, parseNativeConfig, readNativeRunConfig } from '../src/main/engines/native/config';
import { ExecutionRegistry } from '../src/main/execution/registry';
import type { StructuredExecutor } from '../src/main/execution/ports';
import { configurationSupported, engineDefaults, newSessionEngineDefaults } from '../src/renderer/EngineConfiguration';
import { resolveNativeRuntimeConfig } from '../src/shared/native-runtime-policy';
import type { EngineConfig, ExecutionDescriptor } from '../src/shared/execution';

const paths = ['tools/review/SKILL.md', '.agents/skills/missing/SKILL.md'];
const v2 = (): EngineConfig => ({ schemaVersion: 2, options: { projectSkills: [...paths], skills: normalizeNativeLegacySkillPolicy(paths) } });

test('v1 remains unchanged and v2 legacy normalizes matching mirrors without changing the original configuration', () => {
  const old = { schemaVersion: 1, options: { projectSkills: [...paths], maxToolCalls: 37 } };
  const input = v2(), before = structuredClone(input);
  assert.equal(createNativeConfig(old).schemaVersion, 1);
  assert.equal(Object.hasOwn(parseNativeConfig(old), 'skills'), false);
  assert.equal(createNativeDefaultConfig().schemaVersion, 1);
  const parsed = parseNativeConfig(input);
  assert.deepEqual(parsed.projectSkills, [...paths].sort());
  assert.deepEqual(parsed.skills, normalizeNativeLegacySkillPolicy(paths));
  assert.deepEqual(input, before);
  assert.equal(createNativeConfig(input).schemaVersion, 2);
  assert.deepEqual(createNativeConfig(createNativeConfig(input)), createNativeConfig(input));
  assert.equal(parseNativeConfig(old).maxToolCalls, 37);
  assert.throws(() => parseNativeConfig({ ...old, options: { ...old.options, skills: normalizeNativeLegacySkillPolicy(paths) } }));
});

test('v2 rejects catalog, broadened policies, malformed pins and mismatched mirrors without discarding values', () => {
  const base = normalizeNativeLegacySkillPolicy(paths);
  const values: EngineConfig[] = [
    { schemaVersion: 2, options: {} },
    { schemaVersion: 3, options: v2().options },
    ...[
      { ...base, mode: 'catalog' }, { ...base, autoActivation: true }, { ...base, disabledIds: ['skill:disabled'] },
      { ...base, pins: [{ kind: 'skill', skillId: 'skill:other' }] },
      { ...base, pins: [{ kind: 'legacy', path: '../escape/SKILL.md' }] },
      { ...base, pins: [{ kind: 'legacy', path: paths[0] }, { kind: 'legacy', path: paths[0] }] },
      { ...base, pins: [] }, { ...base, future: true },
    ].map(skills => ({ schemaVersion: 2, options: { projectSkills: [...paths], skills } })),
  ];
  for (const config of values) {
    const before = structuredClone(config);
    assert.throws(() => parseNativeConfig(config));
    assert.deepEqual(config, before);
  }
  assert.throws(() => parseNativeConfig(values[2]), /catalog 模式尚未开放/);
  assert.throws(() => normalizeNativeLegacySkillPolicy([paths[0], paths[0].toUpperCase()]));
});

test('config CAS digest compares the original bounded configuration and ignores object key order only', () => {
  const original: EngineConfig = { schemaVersion: 1, options: { model: 'saved', maxInputTokens: 32000 } };
  assert.equal(nativeConfigDigest(original), nativeConfigDigest({ options: { maxInputTokens: 32000, model: 'saved' }, schemaVersion: 1 }));
  assert.notEqual(nativeConfigDigest(original), nativeConfigDigest(createNativeConfig(original)), 'default completion is a different saved representation');
  assert.notEqual(nativeConfigDigest(original), nativeConfigDigest({ ...original, schemaVersion: 2 }));
  const changed = v2(); changed.options.projectSkills = [];
  assert.notEqual(nativeConfigDigest(v2()), nativeConfigDigest(changed));
});

test('saved-run config reads legacy absent versions and exact new versions, rejecting invalid explicit versions', () => {
  assert.deepEqual(readNativeRunConfig({ sessionOptions: { maxToolCalls: 37 } }), createNativeConfig({ schemaVersion: 1, options: { maxToolCalls: 37 } }));
  assert.deepEqual(readNativeRunConfig({ sessionOptions: v2().options, sessionOptionsSchemaVersion: 2 }), createNativeConfig(v2()));
  for (const version of [null, undefined, '2', 0, 3]) assert.throws(() => readNativeRunConfig({ sessionOptions: v2().options, sessionOptionsSchemaVersion: version }));
  assert.throws(() => readNativeRunConfig({ sessionOptions: v2().options }), 'a missing field cannot relabel v2 options as legacy v1');
  assert.throws(() => readNativeRunConfig({ sessionOptions: null }));
});

const capabilities = { available: true, structured: true, terminal: false, approvals: true, resume: false, fork: false, commands: false, contextUsage: true, liveConfig: false, attachments: true };
const descriptor: ExecutionDescriptor = { providerId: 'native', mode: 'structured', capabilities,
  configuration: { schemaVersion: 1, supportedSchemaVersions: [1, 2], defaults: createNativeDefaultConfig(), fields: [] } };

test('descriptor accepted versions allow legacy v2 in host and renderer while keeping fresh sessions v1', () => {
  const registry = new ExecutionRegistry(() => { throw new Error('No session lookup expected'); });
  registry.register({ providerId: 'native', mode: 'structured', executor: {} as StructuredExecutor,
    capabilities: () => capabilities, configuration: () => descriptor.configuration!, validateConfig: createNativeConfig });
  assert.equal(registry.defaultConfig('native', 'structured').schemaVersion, 1);
  assert.equal(registry.defaultConfig('native', 'structured', v2()).schemaVersion, 2);
  assert.throws(() => registry.defaultConfig('native', 'structured', { ...v2(), schemaVersion: 3 }));
  assert.equal(configurationSupported(descriptor, v2()), true);
  assert.equal(configurationSupported({ ...descriptor, configuration: { ...descriptor.configuration!, supportedSchemaVersions: undefined } }, v2()), false);
  assert.equal(configurationSupported(descriptor, { schemaVersion: 3, options: {} }), false);
  assert.equal(engineDefaults(descriptor, undefined).schemaVersion, 1);
  assert.equal(newSessionEngineDefaults(descriptor, undefined).schemaVersion, 1);
  registry.register({ providerId: 'other', mode: 'structured', executor: {} as StructuredExecutor,
    capabilities: () => capabilities, configuration: () => ({ schemaVersion: 1, defaults: { schemaVersion: 1, options: {} }, fields: [] }) });
  assert.throws(() => registry.defaultConfig('other', 'structured', { schemaVersion: 2, options: {} }));
});

test('v2 legacy can follow v1 runtime defaults without inheriting global selections or permissions', () => {
  const session = createNativeConfig(v2()); session.options.runtimePolicy = 'defaults';
  const before = structuredClone(session), defaults = createNativeConfig({ schemaVersion: 1, options: {
    maxInputTokens: 128000, maxOutputTokens: 4096, permissionMode: 'bypassPermissions', projectSkills: ['global/SKILL.md'], model: 'global-model',
  } });
  const resolved = resolveNativeRuntimeConfig(session, defaults);
  assert.equal(resolved.schemaVersion, 2);
  assert.equal(resolved.options.maxInputTokens, 128000);
  assert.equal(resolved.options.maxOutputTokens, 4096);
  for (const key of ['skills', 'projectSkills', 'permissionMode', 'model']) assert.deepEqual(resolved.options[key], session.options[key]);
  assert.doesNotThrow(() => parseNativeConfig(resolved));
  (resolved.options.projectSkills as string[]).push('extra/SKILL.md');
  assert.deepEqual(session, before);
});
