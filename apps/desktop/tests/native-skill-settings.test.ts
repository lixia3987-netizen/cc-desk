import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NativeSkillSettingsError, NativeSkillSettingsStore, createDefaultNativeSkillsSettings, previewNativeSkillMigration } from '../src/main/engines/native/skill-settings';
import { parseNativeConfig } from '../src/main/engines/native/config';
import type { NativeSkillSourceSetting } from '@cc-desk/contracts/native-skills';
import type { EngineConfig } from '../src/shared/execution';

function fixture(t: { after(fn: () => void): void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-skill-settings-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'data'), home = path.join(root, 'home');
  return { root, directory, home, open: () => new NativeSkillSettingsStore(directory, { home }) };
}
function change(store: NativeSkillSettingsStore, update: (sources: NativeSkillSourceSetting[]) => void) {
  const { settings } = store.list(); update(settings.sources);
  return store.save({ expectedRevision: settings.revision, sources: settings.sources });
}
function errorCode(code: NativeSkillSettingsError['code']) {
  return (error: unknown) => error instanceof NativeSkillSettingsError && error.code === code;
}

test('defaults only describe host-derived roots and never create or scan HOME or Skills directories', t => {
  const f = fixture(t), store = f.open(), result = store.list();
  assert.equal(result.runtimeEnabled, false);
  assert.equal(result.error, undefined);
  assert.equal(result.settings.revision, 0);
  assert.deepEqual(result.settings.sources, [
    { id: 'managed', kind: 'managed', enabled: true, rootPath: path.join(f.directory, 'native', 'skills'), revision: 1 },
    { id: 'user-agents', kind: 'user-agents', enabled: false, rootPath: path.join(f.home, '.agents', 'skills'), revision: 1 },
    { id: 'user-claude', kind: 'user-claude', enabled: false, rootPath: path.join(f.home, '.claude', 'skills'), revision: 1 },
  ]);
  assert.equal(fs.existsSync(f.directory), false);
  assert.equal(fs.existsSync(f.home), false);
  const read = fs.readFileSync, paths: string[] = [];
  t.mock.method(fs, 'readFileSync', function (...args: Parameters<typeof fs.readFileSync>) { paths.push(String(args[0])); return read(...args); });
  store.refresh();
  assert.deepEqual(paths, []);
});

test('explicit source registration is independently persisted and only effective changes advance revisions', t => {
  const f = fixture(t), store = f.open(), customPath = path.join(f.root, 'external');
  const first = change(store, sources => {
    sources.find(source => source.id === 'user-agents')!.enabled = true;
    sources.push({ id: 'custom-one', kind: 'custom', rootPath: customPath, enabled: false, revision: 1 });
  });
  assert.equal(first.settings.revision, 1);
  assert.equal(first.settings.sources.find(source => source.id === 'managed')!.revision, 1);
  assert.equal(first.settings.sources.find(source => source.id === 'user-agents')!.revision, 2);
  assert.equal(first.settings.sources.find(source => source.id === 'custom-one')!.revision, 1);
  assert.deepEqual(f.open().list(), first);
  assert.equal(fs.existsSync(customPath), false);
  assert.equal(fs.existsSync(f.home), false);
  assert.equal(fs.existsSync(path.join(f.directory, 'workspace.json')), false);
  assert.equal(fs.existsSync(path.join(f.directory, 'native', 'skills')), false);
  const second = change(store, sources => {
    const custom = sources.find(source => source.id === 'custom-one')!;
    custom.rootPath = path.join(f.root, 'replacement'); custom.enabled = true;
  });
  assert.equal(second.settings.revision, 2);
  assert.equal(second.settings.sources.find(source => source.id === 'custom-one')!.revision, 2);
  assert.equal(second.settings.sources.find(source => source.id === 'user-agents')!.revision, 2);
  const bytes = fs.readFileSync(store.file);
  t.mock.method(fs, 'writeFileSync', () => { throw new Error('no-op must not write'); });
  assert.deepEqual(change(store, () => {}), second);
  assert.deepEqual(fs.readFileSync(store.file), bytes);
});

test('returned snapshots and caller mutation objects cannot mutate the stored settings', t => {
  const f = fixture(t), store = f.open();
  const initial = store.list(); initial.settings.sources[0].enabled = false;
  assert.equal(store.list().settings.sources[0].enabled, true);
  const current = store.list().settings;
  current.sources[1].enabled = true;
  const result = store.save({ expectedRevision: current.revision, sources: current.sources });
  current.sources[1].enabled = false; result.settings.sources[1].rootPath = '/tampered';
  assert.equal(store.list().settings.sources[1].enabled, true);
  assert.equal(store.list().settings.sources[1].rootPath, path.join(f.home, '.agents', 'skills'));
});

test('stale windows and independent instances cannot overwrite a newer revision', t => {
  const f = fixture(t), first = f.open(), second = f.open();
  const stale = first.list().settings;
  change(first, sources => { sources[1].enabled = true; });
  const committed = fs.readFileSync(first.file);
  assert.throws(() => first.save({ expectedRevision: stale.revision, sources: stale.sources }), errorCode('settings_conflict'));
  assert.throws(() => second.save({ expectedRevision: stale.revision, sources: stale.sources }), errorCode('settings_conflict'));
  assert.throws(() => second.save({ expectedRevision: 1, sources: stale.sources }), errorCode('settings_conflict'));
  assert.deepEqual(fs.readFileSync(first.file), committed);
  assert.equal(second.refresh().settings.revision, 1);
  const next = change(second, sources => { sources[2].enabled = true; });
  assert.equal(next.settings.revision, 2);
  assert.equal(next.settings.sources[1].enabled, true);
});

test('source revisions are checked independently of the global revision and cannot be caller-incremented', t => {
  const f = fixture(t), store = f.open();
  change(store, sources => { sources[1].enabled = true; });
  const before = fs.readFileSync(store.file), current = store.list().settings;
  for (const revision of [1, 3]) {
    const sources = structuredClone(current.sources); sources[1].revision = revision; sources[1].enabled = false;
    assert.throws(() => store.save({ expectedRevision: current.revision, sources }), errorCode('settings_conflict'));
  }
  assert.deepEqual(fs.readFileSync(store.file), before);
});

test('equivalent custom root spellings are canonicalized without new revisions or duplicate registrations', t => {
  const f = fixture(t), store = f.open(), rootPath = path.join(f.root, 'external');
  const original = change(store, sources => { sources.push({ id: 'external', kind: 'custom', enabled: false, rootPath, revision: 1 }); });
  const unchanged = change(store, sources => { sources.find(source => source.id === 'external')!.rootPath = rootPath + path.sep; });
  assert.deepEqual(unchanged, original);
  assert.throws(() => change(store, sources => { sources.push({ id: 'other', kind: 'custom', enabled: false, rootPath: rootPath + path.sep, revision: 1 }); }), errorCode('settings_invalid'));
});

test('same-revision external content changes are conflicts instead of silently lost updates', t => {
  const f = fixture(t), store = f.open();
  change(store, sources => { sources[1].enabled = true; });
  const edited = store.list().settings; edited.sources[2].enabled = true;
  fs.writeFileSync(store.file, JSON.stringify(edited));
  const bytes = fs.readFileSync(store.file);
  assert.throws(() => change(store, sources => { sources[0].enabled = false; }), errorCode('settings_conflict'));
  assert.deepEqual(fs.readFileSync(store.file), bytes);
});

test('removed custom source identities cannot be reused after deletion or application restart', t => {
  const f = fixture(t), store = f.open(), rootPath = path.join(f.root, 'external');
  assert.equal(Object.hasOwn(store.list().settings, 'retiredSourceIds'), false);
  const registered = change(store, sources => { sources.push({ id: 'external', kind: 'custom', enabled: false, rootPath, revision: 1 }); });
  assert.equal(Object.hasOwn(registered.settings, 'retiredSourceIds'), false);
  const removed = change(store, sources => { sources.splice(sources.findIndex(source => source.id === 'external'), 1); });
  assert.deepEqual(removed.settings.retiredSourceIds, ['external']);
  assert.equal(removed.settings.revision, 2);
  for (const activeStore of [store, f.open()]) {
    for (const nextPath of [rootPath, path.join(f.root, 'different-package')]) {
      assert.throws(() => change(activeStore, sources => { sources.push({ id: 'external', kind: 'custom', enabled: false, rootPath: nextPath, revision: 1 }); }), error => error instanceof NativeSkillSettingsError && /已被移除/.test(error.message));
    }
    assert.deepEqual(activeStore.list().settings.retiredSourceIds, ['external']);
  }
  const next = change(store, sources => { sources.push({ id: 'new-identity', kind: 'custom', enabled: false, rootPath, revision: 1 }); });
  assert.equal(next.settings.revision, 3);
  assert.deepEqual(next.settings.retiredSourceIds, ['external']);
  assert.equal(next.settings.sources.find(source => source.id === 'new-identity')!.revision, 1);
});

test('changing an active custom root preserves its identity and advances its source revision', t => {
  const f = fixture(t), store = f.open();
  change(store, sources => { sources.push({ id: 'external', kind: 'custom', enabled: false, rootPath: path.join(f.root, 'original'), revision: 1 }); });
  const rebound = change(store, sources => { sources.find(source => source.id === 'external')!.rootPath = path.join(f.root, 'replacement'); });
  assert.equal(rebound.settings.sources.find(source => source.id === 'external')!.revision, 2);
  assert.equal(Object.hasOwn(rebound.settings, 'retiredSourceIds'), false);
  assert.deepEqual(f.open().list(), rebound);
});

test('tombstones are host-maintained and their capacity cannot silently discard deleted identities', t => {
  const f = fixture(t), store = f.open();
  const initial = change(store, sources => { sources.push({ id: 'external', kind: 'custom', enabled: true, rootPath: path.join(f.root, 'external'), revision: 1 }); });
  const tombstones = Array.from({ length: 1024 }, (_, index) => `retired-${index}`);
  fs.writeFileSync(store.file, JSON.stringify({ ...initial.settings, retiredSourceIds: tombstones }));
  store.refresh();
  const bytes = fs.readFileSync(store.file);
  assert.throws(() => change(store, sources => { sources.splice(sources.findIndex(source => source.id === 'external'), 1); }), error => error instanceof NativeSkillSettingsError && /1024/.test(error.message));
  assert.deepEqual(fs.readFileSync(store.file), bytes);
  assert.deepEqual(store.list().settings.retiredSourceIds, tombstones);
  const current = store.list().settings;
  assert.throws(() => store.save({ expectedRevision: current.revision, sources: current.sources, retiredSourceIds: [] } as Parameters<NativeSkillSettingsStore['save']>[0]), errorCode('settings_invalid'));
  const disabled = change(store, sources => { sources.find(source => source.id === 'external')!.enabled = false; });
  assert.equal(disabled.settings.sources.find(source => source.id === 'external')!.enabled, false);
  assert.deepEqual(disabled.settings.retiredSourceIds, tombstones);
});

test('duplicate retired identities and active/retired overlap make the settings read-only', t => {
  const f = fixture(t), initial = createDefaultNativeSkillsSettings(f.directory, f.home);
  const file = path.join(f.directory, 'native', 'skill-settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const retiredSourceIds of [['removed', 'removed'], ['managed'], Array.from({ length: 1025 }, (_, index) => `retired-${index}`)]) {
    const raw = JSON.stringify({ ...initial, retiredSourceIds }); fs.writeFileSync(file, raw);
    const store = f.open(); assert.match(store.list().error!, /保留/);
    assert.throws(() => change(store, sources => { sources[1].enabled = true; }), errorCode('settings_corrupt'));
    assert.equal(fs.readFileSync(file, 'utf8'), raw);
  }
});

test('host-derived managed and HOME roots cannot be replaced or removed through settings', t => {
  const f = fixture(t), store = f.open();
  for (const index of [0, 1, 2]) {
    const { settings } = store.list(); settings.sources[index].rootPath = path.join(f.root, 'forged');
    assert.throws(() => store.save({ expectedRevision: settings.revision, sources: settings.sources }), errorCode('settings_invalid'));
  }
  for (const index of [0, 1, 2]) {
    const { settings } = store.list(); settings.sources[index].id = `forged-${index}`;
    assert.throws(() => store.save({ expectedRevision: settings.revision, sources: settings.sources }), errorCode('settings_invalid'));
  }
  const sources = store.list().settings.sources.slice(1);
  assert.throws(() => store.save({ expectedRevision: 0, sources }), errorCode('settings_invalid'));
  assert.equal(fs.existsSync(store.file), false);
});

test('custom roots require explicit absolute paths, unique identities and a bounded source count', t => {
  const f = fixture(t), store = f.open();
  for (const rootPath of ['relative/skills', '~/skills', 'file:///skills', '', '/skills\0hidden']) {
    assert.throws(() => change(store, sources => { sources.push({ id: 'external', kind: 'custom', enabled: false, rootPath, revision: 1 }); }), errorCode('settings_invalid'));
  }
  assert.throws(() => change(store, sources => { sources.push({ id: 'managed', kind: 'custom', enabled: false, rootPath: path.join(f.root, 'external'), revision: 1 }); }), errorCode('settings_invalid'));
  assert.throws(() => change(store, sources => { sources.push({ id: 'external', kind: 'custom', enabled: false, rootPath: sources[1].rootPath, revision: 1 }); }), errorCode('settings_invalid'));
  assert.throws(() => change(store, sources => {
    for (let index = 0; index < 14; index++) sources.push({ id: `external-${index}`, kind: 'custom', enabled: false, rootPath: path.join(f.root, `external-${index}`), revision: 1 });
  }), errorCode('settings_invalid'));
  assert.equal(store.list().settings.revision, 0);
  assert.equal(fs.existsSync(store.file), false);
});

test('all source roots and host defaults reject C0 and DEL characters even for disabled sources', t => {
  const f = fixture(t), store = f.open();
  const saved = change(store, sources => { sources[1].enabled = true; });
  const bytes = fs.readFileSync(store.file);
  for (const character of ['\0', '\x01', '\t', '\n', '\r', '\x1f', '\x7f']) {
    const invalidRoot = path.join(f.root, `line${character}break`);
    assert.throws(() => change(store, sources => { sources.push({ id: 'invalid-disabled', kind: 'custom', enabled: false, rootPath: invalidRoot, revision: 1 }); }), errorCode('settings_invalid'));
    assert.throws(() => createDefaultNativeSkillsSettings(invalidRoot, f.home), errorCode('settings_invalid'));
    assert.throws(() => createDefaultNativeSkillsSettings(f.directory, invalidRoot), errorCode('settings_invalid'));
  }
  assert.deepEqual(store.list(), saved);
  assert.deepEqual(fs.readFileSync(store.file), bytes);
});

test('sixteen roots may be registered while at most thirteen user sources are enabled', t => {
  const f = fixture(t), store = f.open();
  const saved = change(store, sources => {
    for (const source of sources) source.enabled = true;
    for (let index = 0; index < 13; index++) sources.push({ id: `external-${index}`, kind: 'custom', enabled: index < 10, rootPath: path.join(f.root, `external-${index}`), revision: 1 });
  });
  assert.equal(saved.settings.sources.length, 16);
  assert.equal(saved.settings.sources.filter(source => source.enabled).length, 13);
  assert.deepEqual(f.open().list(), saved);
  const before = fs.readFileSync(store.file);
  assert.throws(() => change(store, sources => { sources.find(source => source.id === 'external-10')!.enabled = true; }), error => error instanceof NativeSkillSettingsError && /13/.test(error.message));
  assert.deepEqual(fs.readFileSync(store.file), before);
  assert.deepEqual(store.list(), saved);
  const invalid = structuredClone(saved.settings); invalid.sources.find(source => source.id === 'external-10')!.enabled = true;
  const raw = JSON.stringify(invalid); fs.writeFileSync(store.file, raw);
  const rejected = f.open(); assert.match(rejected.list().error!, /保留/);
  assert.throws(() => rejected.save({ expectedRevision: invalid.revision, sources: invalid.sources }), errorCode('settings_corrupt'));
  assert.equal(fs.readFileSync(store.file, 'utf8'), raw);
});

test('corrupt, oversized and future settings stay read-only without replacing the original bytes', t => {
  const f = fixture(t), initial = createDefaultNativeSkillsSettings(f.directory, f.home);
  const invalidSources = structuredClone(initial); invalidSources.sources[1].rootPath = path.join(f.root, 'forged');
  const duplicate = structuredClone(initial); duplicate.sources[1].id = duplicate.sources[0].id;
  const candidates = [
    '{invalid',
    JSON.stringify({ ...initial, schemaVersion: 99 }),
    JSON.stringify({ ...initial, surprise: true }),
    JSON.stringify(invalidSources),
    JSON.stringify(duplicate),
    ' '.repeat(128 * 1024 + 1),
  ];
  fs.mkdirSync(path.join(f.directory, 'native'), { recursive: true });
  for (const raw of candidates) {
    const file = path.join(f.directory, 'native', 'skill-settings.json'); fs.writeFileSync(file, raw);
    const store = f.open(); assert.match(store.list().error!, /保留/);
    assert.throws(() => store.save({ expectedRevision: 0, sources: initial.sources }), NativeSkillSettingsError);
    assert.equal(fs.readFileSync(file, 'utf8'), raw);
  }
});

test('corruption after load is detected before save, preserving the last valid snapshot until refresh', t => {
  const f = fixture(t), store = f.open();
  const valid = change(store, sources => { sources[1].enabled = true; });
  fs.writeFileSync(store.file, 'corrupt-external-edit');
  assert.throws(() => change(store, sources => { sources[2].enabled = true; }), errorCode('settings_corrupt'));
  assert.match(store.list().error!, /保留/);
  assert.deepEqual(store.list().settings, valid.settings);
  assert.equal(fs.readFileSync(store.file, 'utf8'), 'corrupt-external-edit');
  fs.writeFileSync(store.file, JSON.stringify(valid.settings));
  assert.equal(store.refresh().error, undefined);
  assert.equal(change(store, sources => { sources[2].enabled = true; }).settings.revision, 2);
});

test('a removed persisted configuration is a read-only error, not permission to recreate defaults', t => {
  const f = fixture(t), store = f.open();
  change(store, sources => { sources[1].enabled = true; }); fs.unlinkSync(store.file);
  assert.throws(() => change(store, sources => { sources[2].enabled = true; }), errorCode('settings_corrupt'));
  assert.equal(fs.existsSync(store.file), false);
  assert.equal(store.list().settings.revision, 1);
});

test('refresh after a persisted file disappears preserves tombstones and refuses saving until external repair', t => {
  const f = fixture(t), store = f.open(), rootPath = path.join(f.root, 'external');
  change(store, sources => { sources.push({ id: 'external', kind: 'custom', enabled: false, rootPath, revision: 1 }); });
  const saved = change(store, sources => { sources.splice(sources.findIndex(source => source.id === 'external'), 1); });
  const raw = fs.readFileSync(store.file), reopened = f.open();
  fs.unlinkSync(store.file);
  for (const current of [store, reopened]) {
    const missing = current.refresh();
    assert.match(missing.error!, /保留/);
    assert.deepEqual(missing.settings, saved.settings);
    assert.deepEqual(missing.settings.retiredSourceIds, ['external']);
    assert.throws(() => change(current, sources => { sources.push({ id: 'external', kind: 'custom', enabled: false, rootPath, revision: 1 }); }), errorCode('settings_corrupt'));
    assert.equal(fs.existsSync(current.file), false);
  }
  fs.writeFileSync(store.file, raw);
  for (const current of [store, reopened]) {
    assert.equal(current.refresh().error, undefined);
    assert.deepEqual(current.list().settings, saved.settings);
    assert.throws(() => change(current, sources => { sources.push({ id: 'external', kind: 'custom', enabled: false, rootPath, revision: 1 }); }), error => error instanceof NativeSkillSettingsError && /已被移除/.test(error.message));
  }
  const next = change(store, sources => { sources[1].enabled = true; });
  assert.equal(next.settings.revision, saved.settings.revision + 1);
  assert.deepEqual(next.settings.retiredSourceIds, ['external']);
});

test('atomic rename failure leaves disk and memory unchanged, cleans temporary files and allows retry', t => {
  const f = fixture(t), store = f.open(), saved = change(store, sources => { sources[1].enabled = true; });
  const bytes = fs.readFileSync(store.file), rename = fs.renameSync;
  const mock = t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
    if (String(to) === store.file) throw Object.assign(new Error('injected rename failure'), { code: 'EPERM' });
    return rename(from, to);
  });
  assert.throws(() => change(store, sources => { sources[2].enabled = true; }), errorCode('settings_write_failed'));
  assert.deepEqual(store.list(), saved);
  assert.deepEqual(fs.readFileSync(store.file), bytes);
  assert.deepEqual(fs.readdirSync(path.dirname(store.file)), ['skill-settings.json']);
  mock.mock.restore();
  assert.equal(change(store, sources => { sources[2].enabled = true; }).settings.revision, 2);
});

test('settings reject symlink files and leave their target untouched', { skip: process.platform === 'win32' && 'Requires Windows symlink privileges' }, t => {
  const f = fixture(t), target = path.join(f.root, 'outside.json');
  fs.writeFileSync(target, JSON.stringify(createDefaultNativeSkillsSettings(f.directory, f.home)));
  fs.mkdirSync(path.join(f.directory, 'native'), { recursive: true });
  fs.symlinkSync(target, path.join(f.directory, 'native', 'skill-settings.json'));
  const before = fs.readFileSync(target), store = f.open();
  assert.match(store.list().error!, /保留/);
  assert.throws(() => change(store, sources => { sources[1].enabled = true; }), errorCode('settings_corrupt'));
  assert.deepEqual(fs.readFileSync(target), before);
  assert.equal(fs.lstatSync(store.file).isSymbolicLink(), true);
});

test('migration preview preserves old fields and missing legacy paths without reading or writing files', t => {
  const f = fixture(t);
  const config: EngineConfig = { schemaVersion: 1, options: {
    projectSkills: ['tools/review/SKILL.md', '.agents/skills/missing/SKILL.md'],
    runtimePolicy: 'defaults', model: 'model', maxToolCalls: 120,
  } };
  const original = structuredClone(config), preview = previewNativeSkillMigration(config);
  assert.equal(preview.runtimeEnabled, false);
  assert.deepEqual(config, original);
  assert.deepEqual(preview.original, original);
  assert.equal(preview.proposed.schemaVersion, 2);
  assert.deepEqual(preview.proposed.options.projectSkills, original.options.projectSkills);
  assert.equal(preview.proposed.options.maxToolCalls, original.options.maxToolCalls);
  assert.equal(preview.proposed.options.runtimePolicy, original.options.runtimePolicy);
  assert.equal(Object.hasOwn(preview.proposed.options, 'maxInputTokens'), false);
  assert.deepEqual(preview.proposed.options.skills, {
    mode: 'legacy', autoActivation: false,
    pins: [{ kind: 'legacy', path: '.agents/skills/missing/SKILL.md' }, { kind: 'legacy', path: 'tools/review/SKILL.md' }], disabledIds: [],
  });
  assert.deepEqual(preview.legacyPins, (preview.proposed.options.skills as { pins: unknown }).pins);
  assert.equal(fs.existsSync(f.directory), false);
  assert.equal(fs.existsSync(f.home), false);
  (preview.proposed.options.projectSkills as string[]).push('change/SKILL.md');
  preview.legacyPins[0].path = 'elsewhere/SKILL.md';
  assert.deepEqual(config, original);
  assert.notEqual((preview.proposed.options.skills as { pins: { path: string }[] }).pins[0].path, 'elsewhere/SKILL.md');
});

test('migration accepts absent and empty selections while preserving their exact stored representation', () => {
  const absent: EngineConfig = { schemaVersion: 1, options: {} };
  const empty: EngineConfig = { schemaVersion: 1, options: { projectSkills: [] } };
  assert.deepEqual(previewNativeSkillMigration(absent).legacyPins, []);
  assert.equal(Object.hasOwn(previewNativeSkillMigration(absent).proposed.options, 'projectSkills'), false);
  assert.deepEqual(previewNativeSkillMigration(empty).proposed.options.projectSkills, []);
});

test('migration refuses unsupported or malformed config without rewriting or discarding original values', () => {
  const values: EngineConfig[] = [
    { schemaVersion: 2, options: { projectSkills: [] } },
    { schemaVersion: 1, options: { projectSkills: { future: ['keep'] } } },
    { schemaVersion: 1, options: { projectSkills: ['../escape/SKILL.md'] } },
    { schemaVersion: 1, options: { projectSkills: ['one/SKILL.md', 'one/SKILL.md'] } },
    { schemaVersion: 1, options: { projectSkills: [], skills: { future: true } } },
    { schemaVersion: 1, options: { projectSkills: [], unknownFutureField: { keep: true } } },
    { schemaVersion: 1, options: { projectSkills: [], maxToolCalls: 401 } },
  ];
  for (const config of values) {
    const before = structuredClone(config);
    assert.throws(() => previewNativeSkillMigration(config), errorCode('migration_invalid'));
    assert.deepEqual(config, before);
  }
});

test('migration preview can be validated as legacy v2 without enabling catalog or mutating the source session', () => {
  const config: EngineConfig = { schemaVersion: 1, options: { projectSkills: ['tools/review/SKILL.md'] } };
  assert.doesNotThrow(() => parseNativeConfig(config));
  const preview = previewNativeSkillMigration(config);
  assert.equal(preview.runtimeEnabled, false);
  assert.deepEqual(parseNativeConfig(preview.proposed).skills, preview.proposed.options.skills);
  assert.equal(config.schemaVersion, 1);
});
