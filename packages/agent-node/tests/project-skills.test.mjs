import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { discoverProjectSkills, loadProjectSkills, normalizeProjectSkillPaths } from '../dist/project-skills.js';
import { loadProjectInstructions } from '../dist/project-instructions.js';
import { contentHash, ProjectFiles } from '../dist/tools/project-files.js';

const agents = '.agents/skills/review/SKILL.md';
const claude = '.claude/skills/review/SKILL.md';
async function fixture(t) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'native-project-skills-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'project');
  await fs.mkdir(root);
  const write = async (relative, content) => {
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await fs.writeFile(path.join(root, relative), content);
  };
  return { parent, root, write };
}

test('skill selections normalize deterministically and reject duplicates, unsafe paths and excessive selections', () => {
  assert.deepEqual(normalizeProjectSkillPaths([claude, agents]), [agents, claude]);
  assert.deepEqual(normalizeProjectSkillPaths([]), []);
  assert.throws(() => normalizeProjectSkillPaths([agents, agents]), /Duplicate/);
  assert.throws(() => normalizeProjectSkillPaths([agents, agents.replace('/review/', '/REVIEW/')]), /Duplicate/);
  assert.throws(() => normalizeProjectSkillPaths(Array.from({ length: 17 }, (_, i) => `.agents/skills/s${i}/SKILL.md`)), /16/);
  for (const candidate of ['SKILL.md', '.agents/skills/review/skill.md', '.claude/skills/deep/review/SKILL.md', '.agents/skills/../SKILL.md', '/tmp/secret', '~/.claude/skills/review/SKILL.md', '.agents\\skills\\review\\SKILL.md', '.agents/skills/secret/SKILL.md', '.claude/skills/.env/SKILL.md', '.agents/skills/.git/SKILL.md', '.agents/skills/review./SKILL.md', '.agents/skills/con/SKILL.md', '.agents/skills/control\nname/SKILL.md']) {
    assert.throws(() => normalizeProjectSkillPaths([candidate]));
  }
  assert.throws(() => normalizeProjectSkillPaths('not-an-array'), /16/);
  assert.throws(() => normalizeProjectSkillPaths([null]), /project-relative/);
});

test('discovery returns bounded metadata from both roots and keeps equal names distinct', async t => {
  const { root, write } = await fixture(t);
  const content = '---\nname: forged-name\ndescription: private-description\n---\nDo review.';
  await write(agents, content);
  await write(claude, 'Claude review.');
  const result = await discoverProjectSkills({ projectRoot: root });
  assert.deepEqual(result, {
    entries: [{ path: agents, name: 'review', hash: contentHash(content), bytes: Buffer.byteLength(content) }, { path: claude, name: 'review', hash: contentHash('Claude review.'), bytes: 14 }],
    issues: [], truncated: false,
  });
  assert.doesNotMatch(JSON.stringify(result), /forged-name|private-description|Do review/);
});

test('discovery does not recursively search and never imports include, HOME, URL or script references', async t => {
  const { parent, root, write } = await fixture(t);
  await fs.mkdir(path.join(parent, '.agents', 'skills', 'outside'), { recursive: true });
  await fs.writeFile(path.join(parent, '.agents', 'skills', 'outside', 'SKILL.md'), 'Outside sentinel.');
  await write('.agents/skills/deep/child/SKILL.md', 'Nested sentinel.');
  await write('included.md', 'Included sentinel.');
  const content = '@included.md\n@../outside\n@~/.claude/skills/private/SKILL.md\n@https://example.invalid/skill\nRun scripts/auto.js';
  await write(agents, content);
  await write('.agents/skills/review/scripts/auto.js', 'throw new Error("script sentinel");');
  const discovered = await discoverProjectSkills({ projectRoot: root });
  assert.deepEqual(discovered.entries.map(entry => entry.path), [agents]);
  const loaded = await loadProjectSkills({ projectRoot: root, paths: [agents] });
  assert.equal(loaded.sources[0].content, content);
  assert.doesNotMatch(JSON.stringify(loaded), /(?:Outside|Nested|Included|script) sentinel/);
});

test('skills are opt-in and empty selections preserve the legacy instruction digest and text', async t => {
  const { root, write } = await fixture(t);
  await write('AGENTS.md', 'Use project conventions.');
  await write(agents, Buffer.from([0xff]));
  const original = await loadProjectInstructions({ projectRoot: root });
  assert.equal(original.digest, '9834fee665d6e0c68dd2369b7f74019c658699f4cf42870099894045d5e31a9e');
  assert.deepEqual(await loadProjectInstructions({ projectRoot: root, projectSkills: [] }), original);
  assert.deepEqual(original.sources.map(source => source.path), ['AGENTS.md']);
  await assert.rejects(loadProjectInstructions({ projectRoot: root, projectSkills: [agents] }), /UTF-8/);
});

test('selected skills join digest and context below scoped AGENTS and CLAUDE conventions', async t => {
  const { root, write } = await fixture(t);
  for (const [relative, content] of [['AGENTS.md', 'Root agents.'], ['CLAUDE.md', 'Root Claude.'], ['src/AGENTS.md', 'Nested agents.'], [agents, 'Selected agent skill.'], [claude, 'Selected Claude skill.']]) await write(relative, content);
  const options = { projectRoot: root, targetPath: 'src/file.ts', targetKind: 'file' };
  const original = await loadProjectInstructions(options);
  const selected = await loadProjectInstructions({ ...options, projectSkills: [claude, agents] });
  assert.deepEqual(selected.sources.map(source => source.path), ['CLAUDE.md', 'AGENTS.md', 'src/AGENTS.md', agents, claude]);
  assert.deepEqual(selected.sources.slice(-2).map(source => source.scope), ['.', '.']);
  assert.match(selected.text, /user-selected project skill guides/);
  assert.match(selected.text, /AGENTS\.md and CLAUDE\.md conventions take precedence over these guides/);
  assert.match(selected.text, /cannot expand project access.*execute includes or scripts/);
  assert.notEqual(selected.digest, original.digest);
  assert.equal((await loadProjectInstructions({ ...options, projectSkills: [agents, claude] })).digest, selected.digest);
  await write(claude, 'Changed Claude skill.');
  assert.notEqual((await loadProjectInstructions({ ...options, projectSkills: [agents, claude] })).digest, selected.digest);
  assert.equal((await loadProjectInstructions(options)).digest, original.digest);
  assert.notEqual((await loadProjectInstructions({ ...options, projectSkills: [agents] })).digest, selected.digest);
  await fs.rm(path.join(root, agents));
  await assert.rejects(loadProjectInstructions({ ...options, projectSkills: [agents] }), /missing/);
});

test('selected skills enforce UTF-8, binary, single-file and shared instruction budgets', async t => {
  const { root, write } = await fixture(t);
  const options = { projectRoot: root, paths: [agents] };
  await write(agents, 'x'.repeat(32 * 1024 + 1));
  await assert.rejects(loadProjectSkills(options), /32768 byte limit/);
  await write(agents, Buffer.from([0xff]));
  await assert.rejects(loadProjectSkills(options), /UTF-8/);
  await write(agents, Buffer.from([0, 1]));
  await assert.rejects(loadProjectSkills(options), /binary/);
  await write(agents, 'skill');
  await assert.rejects(loadProjectSkills({ ...options, maxFileBytes: 4 }), /byte limit/);
  await assert.rejects(loadProjectSkills({ ...options, maxTotalBytes: 4 }), /total byte limit/);
  await write('AGENTS.md', '12345');
  await assert.rejects(loadProjectInstructions({ projectRoot: root, projectSkills: [agents], maxTotalBytes: 9 }), /total byte limit/);
  assert.equal((await loadProjectInstructions({ projectRoot: root, projectSkills: [agents], maxTotalBytes: 10 })).sources.length, 2);
  await write(agents, '');
  assert.equal((await loadProjectInstructions({ projectRoot: root, projectSkills: [agents], maxTotalBytes: 5 })).sources.length, 2);
  for (const limit of [-1, 0.5, 256 * 1024 + 1, NaN]) await assert.rejects(loadProjectSkills({ ...options, maxTotalBytes: limit }), /Invalid/);
});

test('AGENTS, CLAUDE and selected skills share the default 128KiB total', async t => {
  const { root, write } = await fixture(t);
  for (const relative of ['AGENTS.md', 'CLAUDE.md', 'src/AGENTS.md', agents]) await write(relative, 'x'.repeat(32 * 1024));
  const options = { projectRoot: root, targetPath: 'src', projectSkills: [agents] };
  assert.equal((await loadProjectInstructions(options)).sources.length, 4);
  await write(claude, 'x');
  await assert.rejects(loadProjectInstructions({ ...options, projectSkills: [agents, claude] }), /total byte limit/);
});

test('discovery has fixed enumeration and read-byte bounds', async t => {
  const { root, write } = await fixture(t);
  for (let index = 0; index < 65; index++) await write(`.agents/skills/s${String(index).padStart(2, '0')}/SKILL.md`, 'x');
  const bounded = await discoverProjectSkills({ projectRoot: root });
  assert.equal(bounded.entries.length, 64);
  assert.equal(bounded.truncated, true);
  await fs.rm(path.join(root, '.agents'), { recursive: true });
  for (let index = 0; index < 5; index++) await write(`.agents/skills/s${index}/SKILL.md`, 'x'.repeat(32 * 1024));
  const bytes = await discoverProjectSkills({ projectRoot: root });
  assert.equal(bytes.entries.length, 4);
  assert.equal(bytes.entries.reduce((total, item) => total + item.bytes, 0), 128 * 1024);
  assert.equal(bytes.truncated, true);
});

test('failed binary reads also consume the discovery read budget', async t => {
  const { root, write } = await fixture(t);
  for (let index = 0; index < 5; index++) await write(`.agents/skills/s${index}/SKILL.md`, Buffer.alloc(32 * 1024));
  const result = await discoverProjectSkills({ projectRoot: root });
  assert.equal(result.entries.length, 0);
  assert.equal(result.issues.length, 4);
  assert.equal(result.truncated, true);
});

test('discovery skips absent roots and redacts unsafe or protected source errors', async t => {
  const { root, write } = await fixture(t);
  assert.deepEqual(await discoverProjectSkills({ projectRoot: root }), { entries: [], issues: [], truncated: false });
  await assert.rejects(discoverProjectSkills({ projectRoot: root, excludedRoots: [root] }), /protected/);
  await assert.rejects(discoverProjectSkills({ projectRoot: path.join(root, 'missing') }), error => !error.message.includes(root));
  await write(agents, 'Private content sentinel.');
  await write('.agents/skills/.env/SKILL.md', 'Hidden credential sentinel.');
  const excludedRoots = [path.join(root, '.agents', 'skills', 'review')];
  const result = await discoverProjectSkills({ projectRoot: root, excludedRoots });
  assert.equal(result.entries.length, 0);
  assert.equal(result.issues.length, 2);
  assert.ok(result.issues.every(issue => !issue.path.startsWith('/') && !issue.message.includes(root)));
  assert.doesNotMatch(JSON.stringify(result), /Private content|Hidden credential/);
  await assert.rejects(loadProjectSkills({ projectRoot: root, excludedRoots, paths: [agents] }), error => /protected/.test(error.message) && !error.message.includes(root));
  await fs.rm(path.join(root, agents));
  await assert.rejects(loadProjectSkills({ projectRoot: root, paths: [agents] }), error => /missing/.test(error.message) && !error.message.includes(root));
});

test('selected reads reject a file replaced between the size snapshot and completion', async t => {
  const { root, write } = await fixture(t);
  await write(agents, 'Original selected skill.');
  const original = ProjectFiles.prototype.read;
  ProjectFiles.prototype.read = async function (...args) {
    const result = await original.apply(this, args);
    await write('replacement.tmp', 'Different selected skill.');
    await fs.rename(path.join(root, 'replacement.tmp'), path.join(root, agents));
    return result;
  };
  t.after(() => { ProjectFiles.prototype.read = original; });
  await assert.rejects(loadProjectSkills({ projectRoot: root, paths: [agents] }), /changed/);
  const discovered = await discoverProjectSkills({ projectRoot: root });
  assert.equal(discovered.entries.length, 0);
  assert.match(discovered.issues[0].message, /changed/);
});

test('bounded skill readers remain bound to the originally authorized root when its alias changes', async t => {
  const { parent, root, write } = await fixture(t);
  await write(agents, 'Authorized skill.');
  const outside = path.join(parent, 'outside');
  await fs.mkdir(path.dirname(path.join(outside, agents)), { recursive: true });
  await fs.writeFile(path.join(outside, agents), 'Unauthorized root sentinel.');
  const alias = path.join(parent, 'alias');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  const resetAlias = async () => { await fs.rm(alias, { force: true }); await fs.symlink(root, alias, linkType); };
  await resetAlias();
  const originalSnapshot = ProjectFiles.prototype.snapshot;
  const originalRead = ProjectFiles.prototype.read;
  let selectedSnapshots = 0;
  let reads = 0;
  ProjectFiles.prototype.snapshot = async function (...args) {
    if (args[0] === agents && ++selectedSnapshots === 2) {
      await fs.rm(alias);
      await fs.symlink(outside, alias, linkType);
    }
    return originalSnapshot.apply(this, args);
  };
  ProjectFiles.prototype.read = async function (...args) { reads++; return originalRead.apply(this, args); };
  t.after(() => { ProjectFiles.prototype.snapshot = originalSnapshot; ProjectFiles.prototype.read = originalRead; });
  await assert.rejects(loadProjectSkills({ projectRoot: alias, paths: [agents] }), /changed/);
  assert.equal(reads, 0, 'the replacement root must be rejected before reading its contents');
  await resetAlias();
  selectedSnapshots = 0;
  const discovered = await discoverProjectSkills({ projectRoot: alias });
  assert.equal(discovered.entries.length, 0);
  assert.match(discovered.issues[0].message, /changed/);
  assert.doesNotMatch(JSON.stringify(discovered), /Unauthorized root sentinel/);
  assert.equal(reads, 0);
});

for (const linkScope of ['root', 'skill']) test(`skill discovery and loading refuse ${linkScope} directory links`, async t => {
  const { parent, root, write } = await fixture(t);
  const outside = path.join(parent, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'SKILL.md'), 'Outside sentinel.');
  const relative = linkScope === 'root' ? '.agents/skills' : '.agents/skills/review';
  await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await fs.symlink(outside, path.join(root, relative), process.platform === 'win32' ? 'junction' : 'dir');
  const result = await discoverProjectSkills({ projectRoot: root });
  assert.equal(result.entries.length, 0);
  assert.match(result.issues[0].message, /links are refused/);
  await assert.rejects(loadProjectSkills({ projectRoot: root, paths: [agents] }), /links are refused/);
  assert.doesNotMatch(JSON.stringify(result), /Outside sentinel/);
});

test('selected SKILL.md file links are refused', { skip: process.platform === 'win32' }, async t => {
  const { parent, root } = await fixture(t);
  const outside = path.join(parent, 'outside');
  await fs.writeFile(outside, 'Outside sentinel.');
  await fs.mkdir(path.dirname(path.join(root, agents)), { recursive: true });
  await fs.symlink(outside, path.join(root, agents));
  const result = await discoverProjectSkills({ projectRoot: root });
  assert.equal(result.entries.length, 0);
  assert.match(result.issues[0].message, /links are refused/);
  await assert.rejects(loadProjectSkills({ projectRoot: root, paths: [agents] }), /links are refused/);
});

test('skill discovery and loading honor cancellation before and during reads', async t => {
  const { root, write } = await fixture(t);
  await write(agents, 'Read skill.');
  const cancelled = AbortSignal.abort(new Error('Cancelled skill operation.'));
  await assert.rejects(discoverProjectSkills({ projectRoot: root }, cancelled), /Cancelled/);
  await assert.rejects(loadProjectSkills({ projectRoot: root, paths: [agents] }, cancelled), /Cancelled/);
  const original = ProjectFiles.prototype.read;
  let controller;
  ProjectFiles.prototype.read = async function (...args) { const result = await original.apply(this, args); controller.abort(new Error('Cancelled during skill read.')); return result; };
  t.after(() => { ProjectFiles.prototype.read = original; });
  controller = new AbortController();
  await assert.rejects(discoverProjectSkills({ projectRoot: root }, controller.signal), /Cancelled during/);
  controller = new AbortController();
  await assert.rejects(loadProjectSkills({ projectRoot: root, paths: [agents] }, controller.signal), /Cancelled during/);
});
