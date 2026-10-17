import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SkillRegistry, discoverSkillCatalog, loadCatalogSkill, resolveCatalogSkill, listSkillCatalog } from '../dist/skill-registry.js';
import { ProjectFiles, contentHash } from '../dist/tools/project-files.js';

const standard = (name, body = 'Use this guide.', description = `Guide for ${name}.`) => `---\nname: ${name}\ndescription: ${description}\n---\n${body}`;
const projectSource = (id = 'agents', rootPath = '.agents/skills', extra = {}) => ({ id, scope: 'project', kind: 'project-agents', rootPath, enabled: true, revision: 1, ...extra });
const userSource = (rootPath, extra = {}) => ({ id: 'user-agents', scope: 'user', kind: 'user-agents', rootPath, enabled: true, revision: 1, ...extra });
async function fixture(t) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'native-skill-registry-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'project');
  const user = path.join(parent, 'user-skills');
  await fs.mkdir(root);
  await fs.mkdir(user);
  const writeAt = async (targetRoot, relative, content) => {
    await fs.mkdir(path.dirname(path.join(targetRoot, relative)), { recursive: true });
    await fs.writeFile(path.join(targetRoot, relative), content);
  };
  return { parent, root, user, write: (relative, content) => writeAt(root, relative, content), writeAt,
    options: (sources = [projectSource()]) => ({ projectId: 'project-a', projectRoot: root, sources }) };
}

test('catalog scans only explicitly enabled roots, does not recurse and does not expose bodies or host paths', async t => {
  const { parent, root, user, write, writeAt, options } = await fixture(t);
  await write('.agents/skills/review/SKILL.md', standard('review', 'PRIVATE BODY sentinel.'));
  await write('.agents/skills/deep/nested/SKILL.md', standard('nested', 'NESTED sentinel.'));
  await write('.claude/skills/hidden/SKILL.md', standard('hidden'));
  await writeAt(user, 'personal/SKILL.md', standard('personal'));
  await writeAt(parent, '.agents/skills/ancestor/SKILL.md', standard('ancestor'));
  const catalog = await discoverSkillCatalog(options([projectSource(), userSource(user, { enabled: false })]));
  assert.deepEqual(catalog.entries.map(item => item.name), ['review']);
  assert.doesNotMatch(JSON.stringify(catalog), /PRIVATE BODY|NESTED sentinel|hidden|personal|ancestor/);
  assert.ok(!JSON.stringify(catalog).includes(root));
  assert.ok(!JSON.stringify(catalog).includes(user));
  assert.equal(catalog.truncated, false);
});

test('empty optional built-in roots are a normal empty catalog while explicitly enabled missing roots are diagnosed', async t => {
  const { parent, options } = await fixture(t);
  const managed = path.join(parent, 'store', 'native', 'skills');
  const builtin = [projectSource(), projectSource('claude', '.claude/skills', { kind: 'project-claude' }), userSource(managed, { id: 'managed', kind: 'managed' })];
  const catalog = await discoverSkillCatalog({ ...options(builtin), managedRoot: managed, excludedRoots: [path.join(parent, 'store')] });
  assert.deepEqual(catalog.entries, []);
  assert.deepEqual(catalog.issues, []);
  assert.equal(catalog.truncated, false);
  for (const source of [userSource(path.join(parent, 'missing')), projectSource('custom', 'missing', { kind: 'custom' }), projectSource('explicit', '.', { kind: 'project-explicit', explicitPaths: ['missing/SKILL.md'] })]) {
    const missing = await discoverSkillCatalog(options([source]));
    assert.ok(missing.issues.some(issue => issue.code === 'source_missing'));
  }
});

test('explicit project registrations read only selected directory/SKILL.md paths', async t => {
  const { write, options } = await fixture(t);
  await write('tools/review/SKILL.md', standard('review'));
  await write('tools/hidden/SKILL.md', standard('hidden'));
  const config = options([projectSource('explicit', '.', { kind: 'project-explicit', explicitPaths: ['tools/review/SKILL.md'] })]);
  const catalog = await discoverSkillCatalog(config);
  assert.deepEqual(catalog.entries.map(item => item.relativePath), ['tools/review/SKILL.md']);
  assert.equal((await loadCatalogSkill(config, catalog.entries[0])).content, standard('review'));
  for (const unsafe of ['SKILL.md', '../private/SKILL.md', '/tmp/private/SKILL.md', 'tools/review/skill.md', 'tools/.env/SKILL.md']) {
    await assert.rejects(discoverSkillCatalog(options([projectSource('explicit', '.', { kind: 'project-explicit', explicitPaths: [unsafe] })])));
  }
});

test('stable IDs keep equal names distinct, prefer project scope and require same-scope disambiguation', async t => {
  const { user, write, writeAt, options } = await fixture(t);
  await write('.agents/skills/review/SKILL.md', standard('review', 'Project.'));
  await writeAt(user, 'review/SKILL.md', standard('review', 'User.'));
  const config = options([projectSource(), userSource(user)]);
  const first = await discoverSkillCatalog(config);
  assert.equal(first.entries.length, 2);
  const project = first.entries.find(item => item.scope === 'project');
  const personal = first.entries.find(item => item.scope === 'user');
  assert.notEqual(project.skillId, personal.skillId);
  assert.equal(resolveCatalogSkill(first, 'review').descriptor.skillId, project.skillId);
  assert.equal(resolveCatalogSkill(first, personal.skillId).descriptor.skillId, personal.skillId);
  await write('.claude/skills/review/SKILL.md', standard('review', 'Claude.'));
  const ambiguous = await discoverSkillCatalog(options([...config.sources, projectSource('claude', '.claude/skills', { kind: 'project-claude' })]));
  assert.equal(resolveCatalogSkill(ambiguous, 'review').status, 'ambiguous');
  assert.equal(resolveCatalogSkill(ambiguous, 'review').candidates.length, 2);
  assert.equal(resolveCatalogSkill(ambiguous, 'absent').status, 'missing');
  await write('.agents/skills/review/SKILL.md', standard('review', 'Changed project body.'));
  const updated = await discoverSkillCatalog(config);
  assert.equal(updated.entries.find(item => item.scope === 'project').skillId, project.skillId);
  const differentProject = await discoverSkillCatalog({ ...config, projectId: 'project-b' });
  assert.notEqual(differentProject.entries.find(item => item.scope === 'project').skillId, project.skillId);
  assert.equal(differentProject.entries.find(item => item.scope === 'user').skillId, personal.skillId);
  assert.equal(differentProject.entries.find(item => item.scope === 'user').sourceFingerprint, personal.sourceFingerprint);
});

test('catalog reads only bounded metadata prefixes and caches only after verifying the actual file fingerprint', async t => {
  const { write, options } = await fixture(t);
  await write('.agents/skills/review/SKILL.md', standard('review', 'BODY sentinel.'.repeat(1400)));
  const originalRead = ProjectFiles.prototype.read;
  const originalPrefix = ProjectFiles.prototype.readPrefix;
  let prefixes = 0;
  let bytes = 0;
  ProjectFiles.prototype.read = async () => { throw new Error('Discovery must not read full bodies.'); };
  ProjectFiles.prototype.readPrefix = async function (...args) { const result = await originalPrefix.apply(this, args); prefixes++; bytes += result.bytes; return result; };
  t.after(() => { ProjectFiles.prototype.read = originalRead; ProjectFiles.prototype.readPrefix = originalPrefix; });
  const registry = new SkillRegistry(options());
  const first = await registry.discover();
  const second = await registry.discover();
  assert.equal(prefixes, 1);
  assert.ok(bytes <= 8192);
  assert.deepEqual(second, first);
  await write('.agents/skills/review/SKILL.md', standard('review', 'NEW BODY sentinel.'.repeat(1100)));
  const third = await registry.discover();
  assert.equal(prefixes, 2);
  assert.equal(third.entries[0].metadataHash, first.entries[0].metadataHash);
  assert.notEqual(third.entries[0].sourceFingerprint, first.entries[0].sourceFingerprint);
  assert.notEqual(third.revision, first.revision);
  assert.doesNotMatch(JSON.stringify(third), /BODY sentinel/);
});

test('full loading binds metadata and full body hashes and refuses content, parent, root and source-revision changes', async t => {
  const { root, parent, write, options } = await fixture(t);
  const relative = '.agents/skills/review/SKILL.md';
  const original = standard('review', 'Original body.');
  await write(relative, original);
  const config = options();
  const catalog = await discoverSkillCatalog(config);
  const descriptor = catalog.entries[0];
  const loaded = await loadCatalogSkill(config, descriptor);
  assert.equal(loaded.content, original);
  assert.equal(loaded.version.fullFileHash, contentHash(original));
  assert.equal(loaded.version.bytes, Buffer.byteLength(original));
  assert.equal(loaded.version.skillId, descriptor.skillId);
  await write(relative, standard('review', 'Different body.'));
  await assert.rejects(loadCatalogSkill(config, descriptor), /changed|refresh|version/i);
  await write(relative, original);
  const refreshed = (await discoverSkillCatalog(config)).entries[0];
  await assert.rejects(loadCatalogSkill(options([projectSource('agents', '.agents/skills', { revision: 2 })]), refreshed), /changed|refresh|revision/i);
  await fs.rename(path.join(root, '.agents/skills/review'), path.join(root, '.agents/skills/old-review'));
  await write(relative, original);
  await assert.rejects(loadCatalogSkill(config, refreshed), /changed|refresh|version/i);
  const newest = (await discoverSkillCatalog(config)).entries.find(item => item.relativePath === 'review/SKILL.md');
  await fs.rename(root, path.join(parent, 'old-project'));
  await fs.mkdir(root);
  await write(relative, original);
  await assert.rejects(loadCatalogSkill(config, newest), /changed|refresh|version/i);
});

test('unrelated project writes do not stale directory identities or change body versions', async t => {
  const { write, options } = await fixture(t);
  await write('.agents/skills/review/SKILL.md', standard('review'));
  const config = options();
  const descriptor = (await discoverSkillCatalog(config)).entries[0];
  await write('unrelated.txt', 'Project output.');
  await write('.agents/skills/other/SKILL.md', standard('other'));
  const result = await loadCatalogSkill(config, descriptor);
  assert.equal(result.version.sourceFingerprint, descriptor.sourceFingerprint);
  assert.equal(result.body, 'Use this guide.');
});

test('discovery isolates malformed metadata, keeps legacy guides and rejects invalid full activation', async t => {
  const { write, options } = await fixture(t);
  await write('.agents/skills/review/SKILL.md', 'A legacy guide.\r\nKeep original text.');
  await write('.agents/skills/broken/SKILL.md', '---\nname: broken\nname: broken\ndescription: Duplicate keys.\n---\nNever activate.');
  await write('.agents/skills/valid/SKILL.md', standard('valid'));
  const config = options();
  const catalog = await discoverSkillCatalog(config);
  assert.equal(catalog.entries.length, 3);
  const legacy = catalog.entries.find(item => item.name === 'review');
  const invalid = catalog.entries.find(item => item.relativePath === 'broken/SKILL.md');
  assert.equal(legacy.format, 'legacy');
  assert.equal(legacy.autoMatchable, false);
  assert.equal(invalid.format, 'invalid');
  assert.equal(invalid.autoMatchable, false);
  assert.equal((await loadCatalogSkill(config, legacy)).body, 'A legacy guide.\r\nKeep original text.');
  await assert.rejects(loadCatalogSkill(config, invalid), /metadata is invalid/);
  assert.equal((await loadCatalogSkill(config, catalog.entries.find(item => item.name === 'valid'))).body, 'Use this guide.');
});

test('full loading refuses oversized, binary and malformed UTF-8 bodies without returning partial versions', async t => {
  const { root, write, options } = await fixture(t);
  const relative = '.agents/skills/review/SKILL.md';
  const header = standard('review', '');
  await write(relative, header + 'x'.repeat(32 * 1024));
  const oversized = await discoverSkillCatalog(options());
  assert.equal(oversized.entries.length, 0);
  assert.ok(oversized.issues.some(issue => issue.code === 'file_limit'));
  for (const content of [Buffer.concat([Buffer.from(header + 'x'.repeat(8192)), Buffer.from([0])]), Buffer.concat([Buffer.from(header + 'x'.repeat(8192)), Buffer.from([0xff])])]) {
    await write(relative, content);
    const catalog = await discoverSkillCatalog(options());
    assert.equal(catalog.entries.length, 1);
    await assert.rejects(loadCatalogSkill(options(), catalog.entries[0]), /byte limit|binary|UTF-8/i);
  }
  assert.ok(await fs.stat(path.join(root, relative)));
});

test('pagination preserves whole descriptors with bounded cursors and query filtering', async t => {
  const { write, options } = await fixture(t);
  for (let i = 0; i < 8; i++) await write(`.agents/skills/item-${i}/SKILL.md`, standard(`item-${i}`));
  const catalog = await discoverSkillCatalog(options());
  const first = listSkillCatalog(catalog, { limit: 3 });
  const second = listSkillCatalog(catalog, { limit: 3, cursor: first.nextCursor });
  const last = listSkillCatalog(catalog, { limit: 3, cursor: second.nextCursor });
  assert.deepEqual([...first.entries, ...second.entries, ...last.entries], catalog.entries);
  assert.equal(last.nextCursor, null);
  assert.equal(listSkillCatalog(catalog, { query: 'item-4' }).entries.length, 1);
  for (const input of [{ limit: 0 }, { limit: 65 }, { cursor: '-1' }, { cursor: 'garbage' }, { query: 'x'.repeat(257) }]) assert.throws(() => listSkillCatalog(catalog, input));
  assert.throws(() => listSkillCatalog({ ...catalog, revision: 'changed' }, { cursor: first.nextCursor }), /cursor|revision/i);
});

test('registry enforces root and enumeration bounds without recursively following entries', async t => {
  const { write, options } = await fixture(t);
  await assert.rejects(discoverSkillCatalog(options(Array.from({ length: 17 }, (_, i) => projectSource(`source-${i}`, `roots/${i}`)))), /16/);
  for (let source = 0; source < 3; source++) for (let i = 0; i < 257; i++) await write(`root-${source}/item-${String(i).padStart(3, '0')}/SKILL.md`, standard(`item-${i}`));
  const catalog = await discoverSkillCatalog(options(Array.from({ length: 3 }, (_, i) => projectSource(`source-${i}`, `root-${i}`, { kind: 'custom' }))));
  assert.equal(catalog.entries.length, 512);
  assert.equal(catalog.truncated, true);
  assert.ok(catalog.issues.length > 0);
  assert.ok(catalog.entries.filter(item => item.sourceId === 'source-0').length <= 256);
  assert.ok(catalog.entries.filter(item => item.sourceId === 'source-1').length <= 256);
});

test('unsafe and protected roots fail in isolation without leaking host paths or file contents', async t => {
  const { root, user, write, options } = await fixture(t);
  await write('.agents/skills/review/SKILL.md', standard('review'));
  for (const rootPath of ['../escape', '/tmp/outside', '~/.agents/skills']) await assert.rejects(discoverSkillCatalog(options([projectSource('bad', rootPath)])));
  await assert.rejects(discoverSkillCatalog(options([userSource('relative-root')])));
  const catalog = await discoverSkillCatalog({ ...options([projectSource(), userSource(path.join(user, 'absent'))]), excludedRoots: [path.join(root, '.agents/skills/review')] });
  assert.equal(catalog.entries.length, 0);
  assert.ok(catalog.issues.length >= 1);
  assert.ok(!JSON.stringify(catalog).includes(root));
  assert.ok(!JSON.stringify(catalog).includes(user));
});

test('only the exact trusted managed root may read inside the protected application store', async t => {
  const { parent, writeAt, options } = await fixture(t);
  const store = path.join(parent, 'host-store');
  const managed = path.join(store, 'native', 'skills');
  await writeAt(managed, 'review/SKILL.md', standard('review'));
  const base = { ...options([userSource(managed, { id: 'managed', kind: 'managed' })]), excludedRoots: [store] };
  assert.equal((await discoverSkillCatalog(base)).entries.length, 0);
  assert.equal((await discoverSkillCatalog({ ...base, managedRoot: managed })).entries.length, 1);
  assert.equal((await discoverSkillCatalog({ ...base, managedRoot: path.join(store, 'other') })).entries.length, 0);
  assert.equal((await discoverSkillCatalog({ ...base, managedRoot: managed, sources: [userSource(managed, { kind: 'custom' })] })).entries.length, 0);
  const childExcluded = await discoverSkillCatalog({ ...base, managedRoot: managed, excludedRoots: [store, path.join(managed, 'review')] });
  assert.equal(childExcluded.entries.length, 0);
});

test('managed exceptions and ordinary user sources cannot bypass protected paths through a symlink parent', async t => {
  const { parent, writeAt, options } = await fixture(t);
  const store = path.join(parent, 'host-store');
  const outside = path.join(parent, 'outside');
  await fs.mkdir(store);
  await writeAt(outside, 'skills/review/SKILL.md', standard('review', 'OUTSIDE sentinel.'));
  await fs.symlink(outside, path.join(store, 'native'), process.platform === 'win32' ? 'junction' : 'dir');
  const managed = path.join(store, 'native', 'skills');
  for (const kind of ['managed', 'custom', 'user-agents']) {
    const catalog = await discoverSkillCatalog({ ...options([userSource(managed, { kind })]), excludedRoots: [store], managedRoot: managed });
    assert.equal(catalog.entries.length, 0);
    assert.ok(catalog.issues.some(issue => issue.code === 'source_links' || issue.code === 'source_protected'));
    assert.doesNotMatch(JSON.stringify(catalog), /OUTSIDE sentinel/);
  }
});

for (const scope of ['source', 'skill']) test(`registry refuses ${scope} directory links`, async t => {
  const { parent, root, writeAt, options } = await fixture(t);
  const outside = path.join(parent, 'outside');
  await fs.mkdir(outside);
  await writeAt(outside, 'review/SKILL.md', standard('review', 'OUTSIDE sentinel.'));
  const relative = scope === 'source' ? '.agents/skills' : '.agents/skills/review';
  await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await fs.symlink(scope === 'source' ? outside : path.join(outside, 'review'), path.join(root, relative), process.platform === 'win32' ? 'junction' : 'dir');
  const catalog = await discoverSkillCatalog(options());
  assert.equal(catalog.entries.length, 0);
  assert.match(JSON.stringify(catalog.issues), /links|ordinary/i);
  assert.doesNotMatch(JSON.stringify(catalog), /OUTSIDE sentinel/);
});

test('registry refuses links for explicitly registered user roots', async t => {
  const { parent, user, writeAt, options } = await fixture(t);
  await writeAt(user, 'review/SKILL.md', standard('review'));
  const alias = path.join(parent, 'user-link');
  await fs.symlink(user, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const catalog = await discoverSkillCatalog(options([userSource(alias)]));
  assert.equal(catalog.entries.length, 0);
  assert.match(JSON.stringify(catalog.issues), /links|ordinary/i);
});

test('full loading rejects file and directory replacement after the actual read completes', async t => {
  const { root, write, options } = await fixture(t);
  const relative = '.agents/skills/review/SKILL.md';
  const content = standard('review', 'Original.');
  await write(relative, content);
  const config = options();
  const descriptor = (await discoverSkillCatalog(config)).entries[0];
  const original = ProjectFiles.prototype.read;
  ProjectFiles.prototype.read = async function (...args) {
    const result = await original.apply(this, args);
    await write('replacement.tmp', content);
    await fs.rename(path.join(root, 'replacement.tmp'), path.join(root, relative));
    return result;
  };
  t.after(() => { ProjectFiles.prototype.read = original; });
  await assert.rejects(loadCatalogSkill(config, descriptor), /changed|refresh/i);
});

test('the registered project alias cannot be rebound while metadata or a full body is being read', async t => {
  const { parent, root, write, writeAt, options } = await fixture(t);
  const relative = '.agents/skills/review/SKILL.md';
  await write(relative, standard('review', 'Authorized body.'));
  const outside = path.join(parent, 'outside');
  await writeAt(outside, relative, standard('review', 'OUTSIDE sentinel.'));
  const alias = path.join(parent, 'project-alias');
  const reset = async target => { await fs.rm(alias, { force: true }); await fs.symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir'); };
  await reset(root);
  const config = { ...options(), projectRoot: alias };
  const descriptor = (await discoverSkillCatalog(config)).entries[0];
  const originalPrefix = ProjectFiles.prototype.readPrefix;
  const originalRead = ProjectFiles.prototype.read;
  ProjectFiles.prototype.readPrefix = async function (...args) { const result = await originalPrefix.apply(this, args); await reset(outside); return result; };
  t.after(() => { ProjectFiles.prototype.readPrefix = originalPrefix; ProjectFiles.prototype.read = originalRead; });
  const catalog = await discoverSkillCatalog(config);
  assert.equal(catalog.entries.length, 0);
  assert.match(JSON.stringify(catalog.issues), /changed/);
  assert.doesNotMatch(JSON.stringify(catalog), /OUTSIDE sentinel/);
  ProjectFiles.prototype.readPrefix = originalPrefix;
  await reset(root);
  ProjectFiles.prototype.read = async function (...args) { const result = await originalRead.apply(this, args); await reset(outside); return result; };
  await assert.rejects(loadCatalogSkill(config, descriptor), /changed|refresh/i);
});

test('root authorization and its registered alias bind before the initial source snapshot', async t => {
  const { parent, root, write, writeAt, options } = await fixture(t);
  const relative = '.agents/skills/review/SKILL.md';
  await write(relative, standard('review', 'Authorized.'));
  const outside = path.join(parent, 'outside');
  await writeAt(outside, relative, standard('review', 'OUTSIDE sentinel.'));
  const alias = path.join(parent, 'alias');
  await fs.symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const original = ProjectFiles.prototype.snapshot;
  let changed = false;
  ProjectFiles.prototype.snapshot = async function (...args) {
    const result = await original.apply(this, args);
    if (!changed && args[0] === '.agents/skills' && args[1] === 'directory') {
      changed = true;
      await fs.rm(alias);
      await fs.symlink(outside, alias, process.platform === 'win32' ? 'junction' : 'dir');
    }
    return result;
  };
  t.after(() => { ProjectFiles.prototype.snapshot = original; });
  const catalog = await discoverSkillCatalog({ ...options(), projectRoot: alias });
  assert.equal(catalog.entries.length, 0);
  assert.match(JSON.stringify(catalog.issues), /changed/);
  assert.doesNotMatch(JSON.stringify(catalog), /OUTSIDE sentinel/);
});

test('discovery honors cancellation before and during metadata reads with bounded parallelism', async t => {
  const { write, options } = await fixture(t);
  for (let i = 0; i < 8; i++) await write(`.agents/skills/item-${i}/SKILL.md`, standard(`item-${i}`));
  await assert.rejects(discoverSkillCatalog(options(), AbortSignal.abort(new Error('Cancelled before scan.'))), /Cancelled/);
  const original = ProjectFiles.prototype.readPrefix;
  let active = 0;
  let maximum = 0;
  let calls = 0;
  const controller = new AbortController();
  ProjectFiles.prototype.readPrefix = async function (...args) {
    active++;
    maximum = Math.max(maximum, active);
    try { const result = await original.apply(this, args); if (++calls === 1) controller.abort(new Error('Cancelled during scan.')); return result; }
    finally { active--; }
  };
  t.after(() => { ProjectFiles.prototype.readPrefix = original; });
  await assert.rejects(discoverSkillCatalog(options(), controller.signal), /Cancelled during/);
  assert.ok(maximum <= 4);
  assert.ok(calls <= 4);
  assert.equal(active, 0, 'all launched reads settle before cancellation is returned');
});
