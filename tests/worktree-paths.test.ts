import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFileAsync } from '../src/main/commands';
import { cleanupWorktree, createWorktree, mergeWorktree, worktreeInfo } from '../src/main/git';
import { sanitizeWorktreeName, type WorktreePlacement } from '../src/main/worktree-paths';

async function git(cwd: string, ...args: string[]) { return (await execFileAsync('git', args, { cwd })).stdout.trim(); }
async function init(repo: string) {
  await fs.mkdir(repo, { recursive: true });
  await git(repo, 'init', '-b', 'main');
  await git(repo, 'config', 'user.name', 'Workbench Tests');
  await git(repo, 'config', 'user.email', 'tests@example.invalid');
  await fs.writeFile(path.join(repo, 'file.txt'), 'initial\n');
  await fs.writeFile(path.join(repo, '.gitignore'), 'ignored.txt\n');
  await git(repo, 'add', '.'); await git(repo, 'commit', '-m', 'Initial');
  return fs.realpath(repo);
}
async function fixture() {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-paths-')));
  const repo = await init(path.join(dir, 'repo'));
  const placement = (extra: Partial<WorktreePlacement> = {}): WorktreePlacement => ({ location: 'project', projectPath: repo, projectName: '项目一', name: '功能修复', ...extra });
  return { dir, repo, placement, dispose: () => fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) };
}
function suffix(id: string, name = '功能修复') { return `${sanitizeWorktreeName(name)}-${id.slice(0, 8)}`; }

test('worktree names are portable Unicode components and Windows device names are normalized', () => {
  assert.equal(sanitizeWorktreeName(' 修复 Mermaid 图表 '), '修复-Mermaid-图表');
  assert.equal(sanitizeWorktreeName('../a\\b:*?'), 'a-b');
  assert.equal(sanitizeWorktreeName('CON'), '_CON');
  assert.equal(sanitizeWorktreeName('LPT1.txt'), '_LPT1.txt');
  assert.equal(sanitizeWorktreeName('COM²'), '_COM²');
  assert.equal(sanitizeWorktreeName('...'), 'worktree');
  assert.equal(Array.from(sanitizeWorktreeName('🧰'.repeat(100))).length, 60);
});

test('custom roots group by project name and stable canonical-root hash; repeated tree names stay distinct', async () => {
  const f = await fixture(); try {
    const customRoot = path.join(f.dir, '统一目录');
    const firstId = randomUUID(), secondId = randomUUID();
    const first = await createWorktree(f.repo, f.dir, firstId, f.placement({ location: 'custom', customRoot }));
    const second = await createWorktree(f.repo, f.dir, secondId, f.placement({ location: 'custom', customRoot }));
    const hash = createHash('sha256').update(process.platform === 'win32' ? f.repo.toLowerCase() : f.repo).digest('hex').slice(0, 8);
    assert.equal(first, path.join(customRoot, `项目一-${hash}`, suffix(firstId)));
    assert.equal(path.dirname(first), path.dirname(second));
    assert.notEqual(first, second);
    const another = await init(path.join(f.dir, 'other', 'repo'));
    const third = await createWorktree(another, f.dir, randomUUID(), f.placement({ location: 'custom', customRoot, projectPath: another }));
    assert.notEqual(path.dirname(third), path.dirname(first));
    assert.equal(await git(f.repo, 'status', '--porcelain'), '');
    assert.equal((await cleanupWorktree(f.repo, first, firstId)).status, 'removed');
  } finally { await f.dispose(); }
});

test('project placement excludes only its exact directory, preserves existing bytes and leaves unrelated files visible', async () => {
  const f = await fixture(); try {
    const exclude = path.join(f.repo, '.git', 'info', 'exclude');
    const original = Buffer.from('# 自定义规则\r\nold.cache\r\nlast-rule-without-newline');
    await fs.writeFile(exclude, original);
    const ignoreBefore = await fs.readFile(path.join(f.repo, '.gitignore'));
    const id = randomUUID();
    const tree = await createWorktree(f.repo, f.dir, id, f.placement());
    assert.equal(tree, path.join(f.repo, '.claude', 'worktrees', suffix(id)));
    const bytes = await fs.readFile(exclude);
    assert.ok(bytes.subarray(0, original.length).equals(original));
    assert.equal(bytes.subarray(original.length).toString(), `\r\n/.claude/worktrees/${suffix(id)}/\r\n`);
    assert.ok((await fs.readFile(path.join(f.repo, '.gitignore'))).equals(ignoreBefore));
    assert.equal(await git(f.repo, 'status', '--porcelain'), '');
    assert.equal((await worktreeInfo(f.repo, tree, id)).baseClean, true);
    await fs.writeFile(path.join(f.repo, '.claude', 'worktrees', 'notes.txt'), 'keep visible');
    await fs.writeFile(path.join(f.repo, '.claude', 'notes.txt'), 'keep visible too');
    const status = await git(f.repo, 'status', '--porcelain', '--untracked-files=all');
    assert.match(status, /\.claude\/worktrees\/notes\.txt/);
    assert.match(status, /\.claude\/notes\.txt/);
    assert.doesNotMatch(status, new RegExp(id.slice(0, 8)));
    assert.equal((await cleanupWorktree(f.repo, tree, id)).status, 'removed');
    assert.equal(await fs.readFile(path.join(f.repo, '.claude', 'worktrees', 'notes.txt'), 'utf8'), 'keep visible');
    assert.ok((await fs.readFile(exclude)).equals(bytes));
  } finally { await f.dispose(); }
});

test('forks keep source HEAD and owner base while project placement uses the registered project root', async () => {
  const f = await fixture(); try {
    await fs.mkdir(path.join(f.repo, 'subproject'));
    await fs.writeFile(path.join(f.repo, 'subproject', 'readme.txt'), 'subproject');
    await git(f.repo, 'add', '.'); await git(f.repo, 'commit', '-m', 'Subproject');
    const parentId = randomUUID();
    const parent = await createWorktree(f.repo, f.dir, parentId);
    await fs.writeFile(path.join(parent, 'file.txt'), 'parent worktree commit\n');
    await git(parent, 'commit', '-am', 'Parent feature');
    const head = await git(parent, 'rev-parse', 'HEAD');
    const id = randomUUID();
    const tree = await createWorktree(parent, f.dir, id, f.placement({ projectPath: path.join(f.repo, 'subproject') }));
    assert.equal(tree, path.join(f.repo, '.claude', 'worktrees', suffix(id)));
    assert.equal(await git(tree, 'rev-parse', 'HEAD'), head);
    assert.equal(await fs.readFile(path.join(tree, 'file.txt'), 'utf8'), 'parent worktree commit\n');
    assert.equal((await worktreeInfo(parent, tree, id)).owned, true);
    assert.equal((await worktreeInfo(f.repo, tree, id)).owned, false);
    assert.equal((await cleanupWorktree(parent, tree, id)).status, 'removed');
    assert.ok(await fs.stat(parent));
  } finally { await f.dispose(); }
});

test('exact local exclusions escape pattern characters without hiding neighboring paths', async () => {
  const f = await fixture(); try {
    const id = randomUUID(), name = '[case]#!';
    const tree = await createWorktree(f.repo, f.dir, id, f.placement({ name }));
    assert.equal(await git(f.repo, 'status', '--porcelain'), '');
    const unrelated = path.join(path.dirname(tree), `case-${id.slice(0, 8)}`);
    await fs.mkdir(unrelated); await fs.writeFile(path.join(unrelated, 'note.txt'), 'keep visible');
    assert.match(await git(f.repo, 'status', '--porcelain', '--untracked-files=all'), /note\.txt/);
    assert.equal((await cleanupWorktree(f.repo, tree, id)).status, 'removed');
  } finally { await f.dispose(); }
});

test('project creation checks reserved files in the source branch even when launched from its subdirectory', async () => {
  const f = await fixture(); try {
    const parent = await createWorktree(f.repo, f.dir, randomUUID());
    await fs.mkdir(path.join(parent, '.claude', 'worktrees'), { recursive: true });
    await fs.mkdir(path.join(parent, 'subproject'));
    await fs.writeFile(path.join(parent, '.claude', 'worktrees', 'tracked.txt'), 'source-only tracked data');
    await fs.writeFile(path.join(parent, 'subproject', 'readme.txt'), 'subproject');
    await git(parent, 'add', '.'); await git(parent, 'commit', '-m', 'Source-only reserved data');
    await assert.rejects(createWorktree(path.join(parent, 'subproject'), f.dir, randomUUID(), f.placement()), /跟踪/);
    assert.equal(await fs.readFile(path.join(parent, '.claude', 'worktrees', 'tracked.txt'), 'utf8'), 'source-only tracked data');
    assert.equal(await git(f.repo, 'status', '--porcelain'), '');
  } finally { await f.dispose(); }
});

test('existing empty and nonempty destinations are never adopted, and branch failures roll back only our empty folders', async () => {
  const f = await fixture(); try {
    const id = randomUUID();
    const target = path.join(f.repo, '.claude', 'worktrees', suffix(id));
    await fs.mkdir(target, { recursive: true });
    await assert.rejects(createWorktree(f.repo, f.dir, id, f.placement()), /已经存在/);
    assert.ok(await fs.stat(target));
    await fs.writeFile(path.join(target, 'keep.txt'), 'user data');
    await assert.rejects(createWorktree(f.repo, f.dir, id, f.placement()), /已经存在/);
    assert.equal(await fs.readFile(path.join(target, 'keep.txt'), 'utf8'), 'user data');
    const failingId = randomUUID();
    await git(f.repo, 'branch', `workbench/${failingId.slice(0, 8)}`);
    const exclude = path.join(f.repo, '.git', 'info', 'exclude');
    const original = await fs.readFile(exclude);
    await assert.rejects(createWorktree(f.repo, f.dir, failingId, f.placement()));
    assert.ok((await fs.readFile(exclude)).equals(original));
    await assert.rejects(fs.stat(path.join(f.repo, '.claude', 'worktrees', suffix(failingId))), { code: 'ENOENT' });
    assert.equal(await fs.readFile(path.join(target, 'keep.txt'), 'utf8'), 'user data');
  } finally { await f.dispose(); }
});

test('project placement refuses tracked reserved content and file parents without modifying them', async () => {
  const f = await fixture(); try {
    const reserved = path.join(f.repo, '.claude', 'worktrees');
    await fs.mkdir(reserved, { recursive: true });
    await fs.writeFile(path.join(reserved, 'tracked.txt'), 'tracked data');
    await git(f.repo, 'add', '.'); await git(f.repo, 'commit', '-m', 'Existing reserved content');
    await assert.rejects(createWorktree(f.repo, f.dir, randomUUID(), f.placement()), /跟踪/);
    assert.equal(await fs.readFile(path.join(reserved, 'tracked.txt'), 'utf8'), 'tracked data');
    await git(f.repo, 'rm', '-r', '.claude/worktrees'); await git(f.repo, 'commit', '-m', 'Remove reserved content');
    await fs.mkdir(path.join(f.repo, '.claude'), { recursive: true });
    await fs.writeFile(reserved, 'not a directory');
    await assert.rejects(createWorktree(f.repo, f.dir, randomUUID(), f.placement()), /父路径/);
    assert.equal(await fs.readFile(reserved, 'utf8'), 'not a directory');
  } finally { await f.dispose(); }
});

test('traversal names, relative roots, project-contained roots and Git metadata roots are rejected', async () => {
  const f = await fixture(); try {
    for (const name of ['../escape', 'foo/bar', 'foo\\bar', '..', 'part..name', '']) {
      await assert.rejects(createWorktree(f.repo, f.dir, randomUUID(), f.placement({ name })), /名称/);
    }
    for (const customRoot of ['', 'relative', f.repo, path.join(f.repo, 'child', 'missing'), path.join(f.repo, '.git', 'worktrees'), path.join(f.dir, '.git', 'new')]) {
      await assert.rejects(createWorktree(f.repo, f.dir, randomUUID(), f.placement({ location: 'custom', customRoot })), /统一工作区目录/);
    }
    const tree = await createWorktree(f.repo, f.dir, randomUUID(), f.placement({ name: 'NUL' }));
    assert.match(path.basename(tree), /^_NUL-/);
  } finally { await f.dispose(); }
});

test('symlinked project parents and custom-root aliases into the project cannot redirect creation', async () => {
  const f = await fixture(); try {
    const outside = path.join(f.dir, 'outside'); await fs.mkdir(outside);
    await fs.symlink(outside, path.join(f.repo, '.claude'), process.platform === 'win32' ? 'junction' : 'dir');
    await fs.mkdir(path.join(outside, 'worktrees'));
    await assert.rejects(createWorktree(f.repo, f.dir, randomUUID(), f.placement()), /符号链接/);
    assert.deepEqual(await fs.readdir(path.join(outside, 'worktrees')), []);
    const alias = path.join(f.dir, 'alias');
    await fs.symlink(f.repo, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(createWorktree(f.repo, f.dir, randomUUID(), f.placement({ location: 'custom', customRoot: path.join(alias, 'not-created') })), /统一工作区目录/);
    assert.equal(await fs.readFile(path.join(f.repo, 'file.txt'), 'utf8'), 'initial\n');
  } finally { await f.dispose(); }
});

test('a custom project-folder symlink and a foreign registered repository are refused', async () => {
  const f = await fixture(); try {
    const customRoot = path.join(f.dir, 'custom');
    const id = randomUUID();
    const placement = f.placement({ location: 'custom', customRoot });
    const tree = await createWorktree(f.repo, f.dir, id, placement);
    assert.equal((await cleanupWorktree(f.repo, tree, id)).status, 'removed');
    const folder = path.dirname(tree);
    await fs.rmdir(folder);
    const outside = path.join(f.dir, 'outside'); await fs.mkdir(outside);
    await fs.symlink(outside, folder, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(createWorktree(f.repo, f.dir, randomUUID(), placement), /符号链接/);
    assert.deepEqual(await fs.readdir(outside), []);
    const foreign = await init(path.join(f.dir, 'foreign'));
    await assert.rejects(createWorktree(f.repo, f.dir, randomUUID(), f.placement({ projectPath: foreign })), /同一个 Git 仓库/);
  } finally { await f.dispose(); }
});

test('project worktree cleanup retains the existing ignored-file guard and legacy ownership remains compatible', async () => {
  const f = await fixture(); try {
    const id = randomUUID();
    const tree = await createWorktree(f.repo, f.dir, id, f.placement());
    await fs.writeFile(path.join(tree, 'ignored.txt'), 'must survive');
    assert.equal((await cleanupWorktree(f.repo, tree, id)).ok, false);
    assert.equal(await fs.readFile(path.join(tree, 'ignored.txt'), 'utf8'), 'must survive');
    await fs.unlink(path.join(tree, 'ignored.txt'));
    assert.equal((await cleanupWorktree(f.repo, tree, id)).status, 'removed');
    const legacyId = randomUUID();
    const legacy = await createWorktree(f.repo, f.dir, legacyId);
    assert.equal(legacy, path.join(f.dir, 'worktrees', legacyId.slice(0, 8)));
    assert.equal((await worktreeInfo(f.repo, legacy, legacyId)).owned, true);
    assert.equal((await cleanupWorktree(f.repo, legacy, legacyId)).status, 'removed');
  } finally { await f.dispose(); }
});

test('project-local worktree commits fast-forward into the main project while the child remains present', async () => {
  const f = await fixture(); try {
    const id = randomUUID();
    const tree = await createWorktree(f.repo, f.dir, id, f.placement());
    await fs.writeFile(path.join(tree, 'file.txt'), 'feature from project worktree\n');
    await fs.writeFile(path.join(tree, 'feature.txt'), 'new feature\n');
    await git(tree, 'add', '.'); await git(tree, 'commit', '-m', 'Project worktree feature');
    const featureHead = await git(tree, 'rev-parse', 'HEAD');
    const before = await worktreeInfo(f.repo, tree, id);
    assert.equal(before.baseClean, true);
    assert.equal(before.clean, true);
    assert.equal(before.canMerge, true);
    assert.equal(before.canCleanup, false);
    assert.equal((await mergeWorktree(f.repo, tree, id)).status, 'merged');
    assert.equal(await git(f.repo, 'rev-parse', 'HEAD'), featureHead);
    assert.equal(await fs.readFile(path.join(f.repo, 'file.txt'), 'utf8'), 'feature from project worktree\n');
    assert.equal(await fs.readFile(path.join(f.repo, 'feature.txt'), 'utf8'), 'new feature\n');
    assert.ok(await fs.stat(tree));
    assert.equal(await git(f.repo, 'status', '--porcelain'), '');
    assert.equal((await worktreeInfo(f.repo, tree, id)).canCleanup, true);
    assert.equal((await cleanupWorktree(f.repo, tree, id)).status, 'removed');
  } finally { await f.dispose(); }
});

test('failed owner creation preserves ignored hook output and reports the retained worktree path', async () => {
  const f = await fixture(); try {
    const hook = path.join(f.repo, '.git', 'hooks', 'post-checkout');
    await fs.writeFile(hook, '#!/bin/sh\nprintf "existing marker" > "$(git rev-parse --absolute-git-dir)/workbench-owner.json"\nprintf "must survive" > ignored.txt\n', { mode: 0o755 });
    const id = randomUUID();
    const tree = path.join(f.repo, '.claude', 'worktrees', suffix(id));
    await assert.rejects(createWorktree(f.repo, f.dir, id, f.placement()), error => {
      assert.match((error as Error).message, /已保留目录/);
      assert.ok((error as Error).message.includes(tree));
      return true;
    });
    assert.equal(await fs.readFile(path.join(tree, 'ignored.txt'), 'utf8'), 'must survive');
    assert.ok((await git(f.repo, 'worktree', 'list', '--porcelain')).includes(tree.replaceAll('\\', '/')));
    assert.equal(await git(f.repo, 'status', '--porcelain'), '');
    assert.equal((await cleanupWorktree(f.repo, tree, id)).ok, false);
  } finally { await f.dispose(); }
});
