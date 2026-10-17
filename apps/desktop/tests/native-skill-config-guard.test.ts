import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeConfig, normalizeNativeLegacySkillPolicy } from '../src/main/engines/native/config';
import { assertNativeDefaultSkillConfigAllowed, assertNativeSkillConfigChangeAllowed } from '../src/main/engines/native/skill-config-guard';

const original = createNativeConfig({ schemaVersion: 1, options: { projectSkills: ['.agents/skills/review/SKILL.md'] } });
const upgraded = (paths = original.options.projectSkills as string[]) => createNativeConfig({ schemaVersion: 2,
  options: { ...original.options, projectSkills: paths, skills: normalizeNativeLegacySkillPolicy(paths) } });

test('ordinary legacy editing remains available while upgrades require the backed-up Skills entry', () => {
  assert.doesNotThrow(() => assertNativeSkillConfigChangeAllowed(original,
    createNativeConfig({ schemaVersion: 1, options: { ...original.options, projectSkills: [] } })));
  assert.throws(() => assertNativeSkillConfigChangeAllowed(original, upgraded()), /Skills/);
  assert.throws(() => assertNativeSkillConfigChangeAllowed(upgraded(), original), /版本/);
});

test('an ordinary editor cannot overwrite concurrent skill choices but may change non-Skills fields', () => {
  const fresh = upgraded(['.agents/skills/other/SKILL.md']);
  const staleEditor = createNativeConfig({ ...upgraded(), options: { ...upgraded().options, maxSubagents: 8 } });
  assert.throws(() => assertNativeSkillConfigChangeAllowed(fresh, staleEditor), /技能选择/);
  assert.doesNotThrow(() => assertNativeSkillConfigChangeAllowed(fresh,
    createNativeConfig({ ...fresh, options: { ...fresh.options, maxSubagents: 8, permissionMode: 'acceptEdits' } })));
});

test('defaults cannot introduce or remove a session Skills upgrade', () => {
  assert.throws(() => assertNativeDefaultSkillConfigAllowed(undefined, upgraded()), /默认配置/);
  assert.throws(() => assertNativeDefaultSkillConfigAllowed(original, upgraded()), /升级配置/);
  assert.throws(() => assertNativeDefaultSkillConfigAllowed(upgraded(), original), /版本/);
  assert.doesNotThrow(() => assertNativeDefaultSkillConfigAllowed(undefined, original));
});
