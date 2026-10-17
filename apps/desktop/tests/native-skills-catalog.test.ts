import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { StateStore } from '../src/main/store';
import { registerNativeSkillHandlers } from '../src/main/ipc/native-skill-handlers';
import { NativeSkillSettingsStore } from '../src/main/engines/native/skill-settings';
import { SkillRegistry } from '@cc-desk/agent-node/skill-registry';
import type { NativeSkillsCatalogResult, NativeCatalogSkillPreview, NativeSkillMigrationPreview } from '../src/shared/native-skills';

const skill = (name: string, body = 'PRIVATE_BODY') => `---\nname: ${name}\ndescription: Review local code for ${name}.\n---\n${body}`;
async function fixture(t: { after(fn: () => unknown): void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-catalog-ipc-'));
  const data = path.join(root, 'data'), project = path.join(root, 'project'), home = path.join(root, 'home');
  await fs.mkdir(project); const store = new StateStore(data), settings = new NativeSkillSettingsStore(data, { home });
  const id = randomUUID(), projectId = randomUUID(), now = new Date().toISOString();
  store.change(state => {
    state.projects.push({ id: projectId, path: project, name: 'project', createdAt: now });
    state.sessions.push({ id, projectId, title: 'Native', kind: 'agent', cwd: project,
      execution: { providerId: 'native', mode: 'structured', conversationId: randomUUID() }, engineConfig: { schemaVersion: 1, options: {} },
      started: false, status: 'idle', archived: false, createdAt: now, updatedAt: now });
  });
  const handlers = new Map<string, (value: unknown) => unknown>();
  registerNativeSkillHandlers((name, schema, action) => { handlers.set(name, value => action(schema.parse(value))); }, store, { settings });
  const invoke = <T = unknown>(name: string, input?: unknown): Promise<T> => Promise.resolve().then(() => handlers.get(name)!(input)) as Promise<T>;
  const catalog = (refresh = false) => invoke<NativeSkillsCatalogResult>('native:skills-catalog', { sessionId: id, refresh });
  const inspect = (value: NativeSkillsCatalogResult, skillId = value.entries[0].skillId) => invoke<NativeCatalogSkillPreview>('native:skills-catalog-inspect', {
    sessionId: id, skillId, catalogRevision: value.revision });
  const write = async (base: string, relative: string, content: string) => { const file = path.join(base, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content); };
  t.after(async () => { store.flush(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, data, project, home, store, settings, id, projectId, invoke, catalog, inspect, write };
}

test('new catalog returns bounded metadata without enabling runtime or scanning disabled HOME roots', async t => {
  const f = await fixture(t);
  await f.write(f.project, '.agents/skills/review/SKILL.md', skill('review'));
  await f.write(f.home, '.agents/skills/global/SKILL.md', skill('global', 'HOME_PRIVATE'));
  const before = structuredClone(f.store.state), catalog = await f.catalog();
  assert.equal(catalog.runtimeEnabled, false); assert.equal(catalog.entries.length, 1);
  assert.equal(catalog.entries[0].name, 'review'); assert.equal(catalog.entries[0].autoMatchable, true);
  assert.doesNotMatch(JSON.stringify(catalog), /PRIVATE_BODY|HOME_PRIVATE|native-catalog-ipc-/);
  assert.match(catalog.entries[0].sourceFingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(f.store.state, before);
  assert.equal((await f.invoke<{ entries: unknown[] }>('native:skills-list', { sessionId: f.id })).entries.length, 1);
});

test('catalog inspection returns an exact version and body and cannot accept arbitrary roots', async t => {
  const f = await fixture(t), content = skill('review');
  await f.write(f.project, '.agents/skills/review/SKILL.md', content);
  const catalog = await f.catalog(), preview = await f.inspect(catalog);
  assert.equal(preview.content, content); assert.equal(preview.body, 'PRIVATE_BODY');
  assert.match(preview.version.fullFileHash, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(preview), /native-catalog-ipc-/);
  await assert.rejects(f.invoke('native:skills-catalog', { sessionId: f.id, rootPath: f.home }));
  await assert.rejects(f.invoke('native:skills-catalog-inspect', { sessionId: f.id, skillId: catalog.entries[0].skillId, catalogRevision: catalog.revision, path: '/etc/passwd' }));
  await assert.rejects(f.inspect(catalog, 'not-registered'), /当前目录/);
});

test('body-only changes invalidate a cached catalog preview until explicit refresh', async t => {
  const f = await fixture(t), relative = '.agents/skills/review/SKILL.md';
  await f.write(f.project, relative, skill('review', 'original'));
  const catalog = await f.catalog();
  await f.write(f.project, relative, skill('review', 'changed!'));
  await assert.rejects(f.inspect(catalog), /刷新/);
  const fresh = await f.catalog(true), preview = await f.inspect(fresh);
  assert.equal(fresh.entries[0].skillId, catalog.entries[0].skillId);
  assert.notEqual(fresh.revision, catalog.revision); assert.equal(preview.body, 'changed!');
  await assert.rejects(f.inspect(catalog), /刷新/);
});

test('explicit custom legacy selections stay visible, manual-only and unchanged by catalog reads', async t => {
  const f = await fixture(t), relative = 'tools/review/SKILL.md', content = 'Legacy guide without frontmatter';
  await f.write(f.project, relative, content);
  f.store.change(state => { state.sessions[0].engineConfig.options.projectSkills = [relative]; });
  const before = structuredClone(f.store.state), catalog = await f.catalog();
  assert.equal(catalog.entries.length, 1); assert.equal(catalog.entries[0].format, 'legacy');
  assert.equal(catalog.entries[0].autoMatchable, false); assert.equal((await f.inspect(catalog)).body, content);
  assert.deepEqual(f.store.state, before);
});

test('enabling a user source is explicit, source-versioned and invalidates old host catalogs', async t => {
  const f = await fixture(t);
  await f.write(f.project, '.agents/skills/review/SKILL.md', skill('review'));
  await f.write(f.home, '.agents/skills/global/SKILL.md', skill('global'));
  const old = await f.catalog(), before = f.settings.list().settings;
  before.sources.find(source => source.kind === 'user-agents')!.enabled = true;
  await f.invoke('native:skills-settings-save', { expectedRevision: before.revision, sources: before.sources });
  await assert.rejects(f.inspect(old), /刷新/);
  const current = await f.catalog(); assert.equal(current.entries.length, 2);
  assert.ok(current.entries.some(entry => entry.scope === 'user' && entry.name === 'global'));
});

test('host-managed sources are readable only at their exact registered root inside private data', async t => {
  const f = await fixture(t);
  await f.write(path.join(f.data, 'native', 'skills'), 'review/SKILL.md', skill('review'));
  const catalog = await f.catalog();
  assert.equal(catalog.entries.length, 1); assert.equal(catalog.entries[0].sourceId, 'user-managed');
  assert.equal((await f.inspect(catalog)).body, 'PRIVATE_BODY');
});

test('same-revision external source changes cannot reuse or inspect a stale enabled-source catalog', async t => {
  const f = await fixture(t);
  await f.write(f.home, '.agents/skills/global/SKILL.md', skill('global'));
  const before = f.settings.list().settings; before.sources[1].enabled = true;
  f.settings.save({ expectedRevision: before.revision, sources: before.sources });
  const catalog = await f.catalog(), onDisk = JSON.parse(await fs.readFile(f.settings.file, 'utf8'));
  onDisk.sources[1].enabled = false;
  await fs.writeFile(f.settings.file, JSON.stringify(onDisk));
  await assert.rejects(f.inspect(catalog), /刷新/);
  const current = await f.catalog(); assert.equal(current.entries.length, 0);
  assert.notEqual(current.revision, catalog.revision);
});

test('migration IPC only previews valid legacy config and never mutates persisted session', async t => {
  const f = await fixture(t), relative = 'tools/review/SKILL.md';
  f.store.change(state => { state.sessions[0].engineConfig.options.projectSkills = [relative]; });
  const before = structuredClone(f.store.state);
  const result = await f.invoke<NativeSkillMigrationPreview>('native:skills-migration-preview', { sessionId: f.id });
  assert.equal(result.runtimeEnabled, false); assert.equal(result.proposed.schemaVersion, 2);
  assert.deepEqual(result.legacyPins, [{ kind: 'legacy', path: relative }]);
  assert.deepEqual(result.original, before.sessions[0].engineConfig); assert.deepEqual(f.store.state, before);
});

test('late catalog discovery cannot publish into a replaced session or changed source configuration', async t => {
  for (const mutation of ['session', 'settings']) {
    const f = await fixture(t);
    await f.write(f.project, '.agents/skills/review/SKILL.md', skill('review'));
    // Invoke directly so discovery enters filesystem I/O before we mutate its owning scope.
    const handlers = new Map<string, (value: unknown) => unknown>();
    registerNativeSkillHandlers((name, schema, action) => { handlers.set(name, value => action(schema.parse(value))); }, f.store, { settings: f.settings });
    const pending = handlers.get('native:skills-catalog')!({ sessionId: f.id });
    if (mutation === 'session') f.store.change(state => { state.sessions[0].execution.conversationId = randomUUID(); });
    else { const value = f.settings.list().settings; value.sources[1].enabled = true; f.settings.save({ expectedRevision: value.revision, sources: value.sources }); }
    await assert.rejects(Promise.resolve(pending), /变化/);
  }
});

test('an older slow refresh cannot replace the newer catalog returned to this session', async t => {
  const f = await fixture(t), relative = '.agents/skills/review/SKILL.md';
  await f.write(f.project, relative, skill('review', 'old body'));
  let signalEntered!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { signalEntered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const discover = SkillRegistry.prototype.discover;
  let paused = false;
  t.mock.method(SkillRegistry.prototype, 'discover', async function (this: SkillRegistry, ...args: Parameters<SkillRegistry['discover']>) {
    const result = await discover.apply(this, args);
    if (!paused) { paused = true; signalEntered(); await held; }
    return result;
  });
  const older = f.catalog(true);
  try {
    await entered;
    await f.write(f.project, relative, skill('review', 'new body'));
    const newer = await f.catalog(true);
    release();
    await assert.rejects(older, /变化/);
    assert.equal((await f.inspect(newer)).body, 'new body');
  } finally { release(); }
});
