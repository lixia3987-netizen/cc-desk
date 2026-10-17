import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SkillRegistry } from '@cc-desk/agent-node/skill-registry';
import type { SkillCatalogSnapshot } from '@cc-desk/contracts/native-skills';
import { StateStore } from '../src/main/store';
import { NativeSkillSettingsStore } from '../src/main/engines/native/skill-settings';
import { NativeSkillCatalogHost } from '../src/main/engines/native/skill-catalog-host';
import { registerNativeSkillHandlers } from '../src/main/ipc/native-skill-handlers';
import { prepareAgentBaseline, materializeAgentBaseline, createAgentWorktree } from '../src/main/engines/native/agent-worktrees';

const guide = (name = 'review', body = 'FULL_PRIVATE_BODY') => `---\nname: ${name}\ndescription: Review changes carefully.\n---\n${body}`;
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const execute = promisify(execFile);
async function fixture(t: TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'skill-catalog-host-')));
  const project = path.join(root, 'project'), data = path.join(root, 'data'), home = path.join(root, 'home');
  await fs.mkdir(project);
  const store = new StateStore(data), settings = new NativeSkillSettingsStore(data, { home });
  const id = randomUUID(), projectId = randomUUID(), now = new Date().toISOString();
  store.change(state => {
    state.projects.push({ id: projectId, path: project, name: 'project', createdAt: now });
    state.sessions.push({ id, projectId, title: 'Native', kind: 'agent', cwd: project,
      execution: { providerId: 'native', mode: 'structured', conversationId: randomUUID() },
      engineConfig: { schemaVersion: 1, options: {} }, started: false, status: 'idle', archived: false, createdAt: now, updatedAt: now });
  });
  const host = new NativeSkillCatalogHost(store, { settings });
  const file = path.join(project, '.agents/skills/review/SKILL.md');
  await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, guide());
  t.after(async () => { store.flush(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, project, data, home, store, settings, host, id, projectId, file };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
const mutations: Record<string, (f: Fixture) => unknown> = {
  projectId: f => f.store.change(state => { const replacement = { ...state.projects[0], id: randomUUID() }; state.projects.push(replacement); state.sessions[0].projectId = replacement.id; }),
  projectPath: f => f.store.change(state => { state.projects[0].path = path.join(f.root, 'different-project'); }),
  cwd: f => f.store.change(state => { state.sessions[0].cwd = f.root; }),
  conversation: f => f.store.change(state => { state.sessions[0].execution.conversationId = randomUUID(); }),
  config: f => f.store.change(state => { state.sessions[0].engineConfig.options.model = 'changed-model'; }),
  settings: f => { const value = f.settings.list().settings; value.sources[1].enabled = true; f.settings.save({ expectedRevision: value.revision, sources: value.sources }); },
  sameRevisionSettings: async f => {
    const persisted = JSON.parse(await fs.readFile(f.settings.file, 'utf8')); persisted.sources[1].enabled = false;
    await fs.writeFile(f.settings.file, JSON.stringify(persisted));
  },
};

for (const [name, mutate] of Object.entries(mutations)) for (const operation of ['discover', 'load'] as const) {
  test(`scope-bound registry rejects ${name} changed during ${operation}`, async t => {
    const f = await fixture(t);
    if (name === 'sameRevisionSettings') { const value = f.settings.list().settings; value.sources[1].enabled = true; f.settings.save({ expectedRevision: value.revision, sources: value.sources }); }
    const registry = f.host.registry(f.id), descriptor = (await registry.discover()).entries[0];
    const entered = deferred(), release = deferred();
    if (operation === 'discover') {
      const discover = SkillRegistry.prototype.discover;
      t.mock.method(SkillRegistry.prototype, 'discover', async function (this: SkillRegistry, ...args: Parameters<SkillRegistry['discover']>) {
        const value = await discover.apply(this, args); entered.resolve(); await release.promise; return value;
      });
    } else {
      const load = SkillRegistry.prototype.loadCatalogSkill;
      t.mock.method(SkillRegistry.prototype, 'loadCatalogSkill', async function (this: SkillRegistry, ...args: Parameters<SkillRegistry['loadCatalogSkill']>) {
        const value = await load.apply(this, args); entered.resolve(); await release.promise; return value;
      });
    }
    const pending = operation === 'discover' ? registry.discover() : registry.loadCatalogSkill(descriptor);
    const rejected = assert.rejects(pending, /会话或 Skills 来源配置已变化/);
    try { await entered.promise; await mutate(f); release.resolve(); await rejected; }
    finally { release.resolve(); }
  });
}

test('IPC and internal registry share one settings instance and exact source mapping', async t => {
  const f = await fixture(t);
  const write = async (file: string, content: string) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content); };
  await write(path.join(f.project, '.claude/skills/claude/SKILL.md'), guide('claude'));
  await write(path.join(f.project, 'custom/SKILL.md'), 'Full legacy content');
  await write(path.join(f.data, 'native/skills/managed/SKILL.md'), guide('managed'));
  await write(path.join(f.home, '.agents/skills/global/SKILL.md'), guide('global'));
  f.store.change(state => { state.sessions[0].engineConfig.options.projectSkills = ['custom/SKILL.md']; });
  const handlers = new Map<string, (value: unknown) => unknown>();
  registerNativeSkillHandlers((name, schema, action) => handlers.set(name, input => action(schema.parse(input))), f.store, { catalog: f.host, settings: f.settings });
  const hidden = await f.host.catalog(f.id);
  assert.equal(hidden.entries.some(entry => entry.name === 'global'), false);
  const view = f.settings.list().settings; view.sources[1].enabled = true;
  handlers.get('native:skills-settings-save')!({ expectedRevision: view.revision, sources: view.sources });
  const ipc = await handlers.get('native:skills-catalog')!({ sessionId: f.id }) as SkillCatalogSnapshot;
  const internal = await f.host.registry(f.id).discover();
  assert.deepEqual(internal, (({ runtimeEnabled: _runtime, ...rest }) => rest)(ipc as SkillCatalogSnapshot & { runtimeEnabled: false }));
  assert.deepEqual(new Set(internal.entries.map(entry => entry.sourceId)), new Set(['project-agents', 'project-claude', 'project-explicit', 'user-managed', 'user-user-agents']));
  assert.doesNotMatch(JSON.stringify(ipc), /FULL_PRIVATE_BODY|skill-catalog-host-/);
  assert.throws(() => registerNativeSkillHandlers(() => {}, f.store, { catalog: f.host, settings: new NativeSkillSettingsStore(f.data, { home: f.home }) }), /同一宿主实例/);
  const other = new StateStore(path.join(f.root, 'other-data'));
  assert.throws(() => registerNativeSkillHandlers(() => {}, other, { catalog: f.host }), /同一工作区宿主/);
  assert.throws(() => new NativeSkillCatalogHost(f.store, { settings: new NativeSkillSettingsStore(other.directory, { home: f.home }) }), /同一工作区数据目录/);
});

test('ninth cached session evicts previews without revoking a scope-bound runtime registry', async t => {
  const f = await fixture(t), first = await f.host.catalog(f.id), registry = f.host.registry(f.id), descriptor = first.entries[0];
  for (let index = 0; index < 8; index++) {
    const id = randomUUID();
    f.store.change(state => { state.sessions.push({ ...state.sessions[0], id, execution: { ...state.sessions[0].execution, conversationId: randomUUID() } }); });
    await f.host.catalog(id);
  }
  await assert.rejects(f.host.inspect(f.id, descriptor.skillId, first.revision), /刷新目录/);
  assert.equal((await registry.loadCatalogSkill(descriptor)).body, 'FULL_PRIVATE_BODY');
  assert.equal((await f.host.catalog(f.id)).runtimeEnabled, false);
});

test('retained catalog metadata is limited by total bytes in addition to session count', async t => {
  const f = await fixture(t), realDiscover = SkillRegistry.prototype.discover;
  t.mock.method(SkillRegistry.prototype, 'discover', async function (this: SkillRegistry, ...args: Parameters<SkillRegistry['discover']>) {
    const value = await realDiscover.apply(this, args);
    // Simulate a valid large metadata set without reading megabytes of irrelevant fixture files.
    value.entries = Array.from({ length: 512 }, (_, index) => ({ ...value.entries[0], skillId: `skill:${index.toString(16).padStart(64, '0')}`, description: 'm'.repeat(1000) }));
    return value;
  });
  const first = await f.host.catalog(f.id);
  for (let index = 0; index < 7; index++) {
    const id = randomUUID(); f.store.change(state => { state.sessions.push({ ...state.sessions[0], id, execution: { ...state.sessions[0].execution, conversationId: randomUUID() } }); });
    await f.host.catalog(id);
  }
  await assert.rejects(f.host.inspect(f.id, first.entries[0].skillId, first.revision), /刷新目录/);
});

test('a single oversized metadata catalog is rejected rather than retained', async t => {
  const f = await fixture(t), discover = SkillRegistry.prototype.discover;
  t.mock.method(SkillRegistry.prototype, 'discover', async function (this: SkillRegistry, ...args: Parameters<SkillRegistry['discover']>) {
    const value = await discover.apply(this, args);
    value.entries[0].description = 'm'.repeat(4 * 1024 * 1024);
    return value;
  });
  await assert.rejects(f.host.catalog(f.id), /内存上限/);
});

test('cached reads do not replace a pending newer refresh generation', async t => {
  const f = await fixture(t), first = await f.host.catalog(f.id);
  const entered = deferred(), release = deferred(), discover = SkillRegistry.prototype.discover;
  t.mock.method(SkillRegistry.prototype, 'discover', async function (this: SkillRegistry, ...args: Parameters<SkillRegistry['discover']>) {
    const value = await discover.apply(this, args); entered.resolve(); await release.promise; return value;
  });
  const fresh = f.host.catalog(f.id, true);
  try {
    await entered.promise; assert.deepEqual(await f.host.catalog(f.id), first);
    release.resolve(); assert.deepEqual(await fresh, first);
  } finally { release.resolve(); }
});

test('child registry rebinding retains host exclusions and the original parent scope', async t => {
  const f = await fixture(t), registry = f.host.registry(f.id), child = path.join(f.root, 'child');
  await fs.mkdir(path.join(child, '.agents/skills/review'), { recursive: true }); await fs.writeFile(path.join(child, '.agents/skills/review/SKILL.md'), guide());
  const rebound = registry.rebindProject(child, []);
  assert.equal((await rebound.discover()).entries.length, 1);
  const excludedGuide = path.join(f.data, '.agents/skills/excluded/SKILL.md');
  await fs.mkdir(path.dirname(excludedGuide), { recursive: true });
  await fs.writeFile(excludedGuide, guide('excluded', 'HOST_DATA_MUST_NOT_ENTER_CHILD_CATALOG'));
  const protectedRoot = registry.rebindProject(f.data, []);
  assert.equal((await protectedRoot.discover()).entries.length, 0);
  f.store.change(state => { state.projects[0].path = f.root; });
  await assert.rejects(rebound.discover(), /会话或 Skills 来源配置已变化/);
});

async function privateChild(t: TestContext, nested = false) {
  const f = await fixture(t), cwd = nested ? path.join(f.project, 'src') : f.project;
  if (nested) {
    await fs.mkdir(path.join(cwd, '.agents/skills/review'), { recursive: true });
    await fs.writeFile(path.join(cwd, '.agents/skills/review/SKILL.md'), guide());
    f.store.change(state => { state.sessions[0].cwd = cwd; });
  }
  await fs.writeFile(path.join(f.project, '.gitattributes'), '**/SKILL.md -text\n');
  for (const args of [['init'], ['config', 'user.name', 'Local child fixture'], ['config', 'user.email', 'fixture@example.invalid'], ['add', '.'], ['commit', '-m', 'child baseline']]) {
    await execute('git', args, { cwd: f.project });
  }
  const baseline = await prepareAgentBaseline(cwd, 'head'), worktrees = path.join(f.data, 'native', 'agent-worktrees');
  const commit = await materializeAgentBaseline(baseline, worktrees), child = await createAgentWorktree(baseline, worktrees, commit, randomUUID());
  return { ...f, worktrees, child, registry: f.host.registry(f.id).rebindProject(child.cwd, []) };
}

test('host authorizes the exact real private worktree cwd, including a repository subdirectory', async t => {
  const f = await privateChild(t, true), catalog = await f.registry.discover();
  assert.equal(f.child.cwd, path.join(f.child.path, 'src'));
  assert.equal(catalog.entries.length, 1);
  assert.equal((await f.registry.loadCatalogSkill(catalog.entries[0])).body, 'FULL_PRIVATE_BODY');
  assert.equal((await f.host.catalog(f.id)).runtimeEnabled, false);
});

test('private project access never authorizes data roots, ancestors or the child as a user source', async t => {
  const f = await privateChild(t);
  await fs.writeFile(path.join(f.data, 'SKILL.md'), guide('private-data', 'PRIVATE_HOST_METADATA'));
  await fs.mkdir(path.join(f.data, 'native/skills/managed'), { recursive: true });
  await fs.writeFile(path.join(f.data, 'native/skills/managed/SKILL.md'), guide('managed', 'EXACT_MANAGED_GUIDE'));
  const view = f.settings.list().settings;
  const roots = [f.data, path.join(f.data, 'native'), f.child.cwd, f.root];
  f.settings.save({ expectedRevision: view.revision, sources: [...view.sources,
    ...roots.map((rootPath, index) => ({ id: `protected-${index}`, kind: 'custom' as const, rootPath, enabled: true, revision: 1 }))] });
  const registry = f.host.registry(f.id).rebindProject(f.child.cwd, []), catalog = await registry.discover();
  assert.deepEqual(catalog.entries.map(entry => [entry.scope, entry.name]).sort(), [['project', 'review'], ['user', 'managed']]);
  assert.doesNotMatch(JSON.stringify(catalog), /PRIVATE_HOST_METADATA/);
  for (let index = 0; index < 3; index++) assert.ok(catalog.issues.some(issue => issue.sourceId === `user-protected-${index}` && issue.code === 'source_protected'));
  assert.ok(!catalog.entries.some(entry => entry.sourceId === 'user-protected-3'));
  assert.equal((await registry.loadCatalogSkill(catalog.entries.find(entry => entry.name === 'managed')!)).body, 'EXACT_MANAGED_GUIDE');
});

test('a private child exception preserves additional explicit exclusions', async t => {
  const f = await privateChild(t);
  const registry = f.host.registry(f.id).rebindProject(f.child.cwd, [path.join(f.child.cwd, '.agents/skills')]);
  assert.equal((await registry.discover()).entries.length, 0);
});

test('private ancestors, indices and non-UUID directories cannot acquire the project exception', async t => {
  const f = await privateChild(t);
  for (const root of [f.data, path.join(f.data, 'native'), f.worktrees, path.join(f.worktrees, '.indices'), path.join(f.worktrees, 'not-a-child')]) {
    const file = path.join(root, '.agents/skills/forbidden/SKILL.md');
    await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, guide('forbidden', 'HOST_METADATA_MUST_STAY_PRIVATE'));
    const registry = f.host.registry(f.id).rebindProject(root, []);
    assert.equal((await registry.discover()).entries.length, 0, root);
  }
});

for (const level of ['child', 'worktrees', 'native'] as const) test(`private child access rejects ${level} directory replacement after authorization`, async t => {
  const f = await privateChild(t), catalog = await f.registry.discover();
  const directory = level === 'child' ? f.child.path : level === 'worktrees' ? f.worktrees : path.join(f.data, 'native');
  const retained = `${directory}.retained`;
  await fs.rename(directory, retained); await fs.cp(retained, directory, { recursive: true });
  await assert.rejects(f.registry.discover(), /changed|变化/);
  await assert.rejects(f.registry.loadCatalogSkill(catalog.entries[0]), /changed|变化/);
});

for (const level of ['child', 'worktrees', 'native'] as const) test(`private child access refuses a ${level} link before its first discovery`, async t => {
  const f = await privateChild(t);
  const directory = level === 'child' ? f.child.path : level === 'worktrees' ? f.worktrees : path.join(f.data, 'native');
  const retained = path.join(f.root, `retained-${level}`);
  await fs.rename(directory, retained);
  await fs.symlink(retained, directory, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.registry.discover(), /changed|变化|links|ordinary/);
});

test('private child access rejects source drift and later parent scope changes', async t => {
  const f = await privateChild(t), catalog = await f.registry.discover();
  await fs.writeFile(path.join(f.child.cwd, '.agents/skills/review/SKILL.md'), guide('review', 'CHANGED_SOURCE'));
  await assert.rejects(f.registry.loadCatalogSkill(catalog.entries[0]), /changed|变化|Refresh/);
  f.store.change(state => { state.sessions[0].engineConfig.options.model = 'changed-parent-model'; });
  await assert.rejects(f.registry.discover(), /会话或 Skills 来源配置已变化/);
});
