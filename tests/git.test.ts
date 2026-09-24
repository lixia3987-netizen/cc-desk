import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileAsync } from '../src/main/commands';
import { cleanupWorktree, forceCleanupWorktree, createWorktree, gitChanges, gitDiff, mergeWorktree, worktreeInfo } from '../src/main/git';

async function git(cwd: string, ...args: string[]) { return (await execFileAsync('git', args, { cwd })).stdout.trim(); }
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-git-'));
  const repo = path.join(dir, 'repo'); await fs.mkdir(repo);
  await git(repo, 'init', '-b', 'main'); await git(repo, 'config', 'user.name', 'Workbench Tests'); await git(repo, 'config', 'user.email', 'tests@example.invalid');
  await fs.writeFile(path.join(repo, 'file.txt'), 'initial\n');
  await fs.writeFile(path.join(repo, '.gitignore'), 'ignored.txt\n');
  await git(repo, 'add', '.'); await git(repo, 'commit', '-m', 'Initial');
  // Windows may retain a just-exited Git process's cwd handle briefly, especially
  // after execFile terminates a diff at maxBuffer. Retry only filesystem cleanup;
  // a persistent lock still fails the test and every product assertion stays intact.
  return { dir, repo, dispose: () => fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) };
}

test('Git review separates staged, unstaged, untracked and binary changes without executing pathspecs', async () => {
  const f = await fixture(); try {
    await fs.writeFile(path.join(f.repo, 'file.txt'), 'staged\n'); await git(f.repo, 'add', 'file.txt');
    await fs.writeFile(path.join(f.repo, 'file.txt'), 'unstaged\n');
    await fs.writeFile(path.join(f.repo, 'new.txt'), 'new content\n');
    await fs.writeFile(path.join(f.repo, 'binary.dat'), Buffer.from([0, 1, 2]));
    const changes = await gitChanges(f.repo);
    assert.equal(changes.available, true);
    assert.ok(changes.changes.find(change => change.path === 'file.txt' && change.staged && change.unstaged));
    assert.ok(changes.changes.find(change => change.path === 'new.txt')?.untracked);
    assert.match((await gitDiff(f.repo, 'file.txt', true)).text, /\+staged/);
    assert.match((await gitDiff(f.repo, 'file.txt')).text, /\+unstaged/);
    assert.match((await gitDiff(f.repo, 'new.txt')).text, /\+new content/);
    assert.equal((await gitDiff(f.repo, 'binary.dat')).binary, true);
    assert.equal((await gitDiff(f.repo, ':(glob)*')).text, '');
    await assert.rejects(gitDiff(f.repo, '../outside.txt'));
    await assert.rejects(gitDiff(f.repo, '.git/config'));
  } finally { await f.dispose(); }
});

test('Git review supports deleted and renamed files and bounds large diffs', async () => {
  const f = await fixture(); try {
    await git(f.repo, 'mv', 'file.txt', 'renamed.txt');
    assert.equal((await gitChanges(f.repo)).changes.find(change => change.path === 'renamed.txt')?.originalPath, 'file.txt');
    const rename = (await gitDiff(f.repo, 'renamed.txt', true)).text;
    assert.match(rename, /rename from file.txt/);
    assert.match(rename, /rename to renamed.txt/);
    assert.doesNotMatch(rename, /new file mode/);
    await git(f.repo, 'commit', '-am', 'Rename'); await fs.unlink(path.join(f.repo, 'renamed.txt'));
    assert.match((await gitDiff(f.repo, 'renamed.txt')).text, /-initial/);
    await fs.writeFile(path.join(f.repo, 'renamed.txt'), 'changed line\n'.repeat(60000));
    const large = await gitDiff(f.repo, 'renamed.txt');
    assert.equal(large.truncated, true); assert.ok(large.text.length <= 256 * 1024);
  } finally { await f.dispose(); }
});

test('staged rename review includes real modifications and preserves session path boundaries', async () => {
  const f = await fixture(); try {
    const lines = Array.from({length:30},(_,i)=>`line ${i}`).join('\n')+'\n';
    await fs.writeFile(path.join(f.repo,'file.txt'),lines);
    await git(f.repo,'commit','-am','Long source');
    await git(f.repo,'mv','file.txt','renamed.txt');
    await fs.writeFile(path.join(f.repo,'renamed.txt'),lines.replace('line 15\n','modified 15\n'));
    await git(f.repo,'add','renamed.txt');
    const diff = (await gitDiff(f.repo,'renamed.txt',true)).text;
    assert.match(diff,/rename from file.txt/);
    assert.match(diff,/-line 15\n\+modified 15/);
    await git(f.repo,'commit','-am','Rename with edit');
    await fs.mkdir(path.join(f.repo,'scoped'));
    await git(f.repo,'mv','renamed.txt','scoped/renamed.txt');
    const scoped=path.join(f.repo,'scoped');
    assert.doesNotMatch((await gitDiff(scoped,'renamed.txt',true)).text,/rename from \.\.\//);
    await assert.rejects(gitDiff(scoped,'../renamed.txt',true),/项目外/);
  } finally { await f.dispose(); }
});

test('worktree lifecycle refuses running, dirty, unmerged and ignored-data removal then merges safely', async () => {
  const f = await fixture(); try {
    const id = randomUUID(); const tree = await createWorktree(f.repo, f.dir, id);
    assert.equal((await worktreeInfo(f.repo, tree, id)).owned, true);
    assert.equal((await cleanupWorktree(f.repo, tree, randomUUID())).ok, false);
    assert.equal((await cleanupWorktree(f.repo, tree, id, true)).ok, false);
    await fs.writeFile(path.join(tree, 'new.txt'), 'worktree data');
    assert.equal((await cleanupWorktree(f.repo, tree, id)).ok, false);
    assert.equal((await mergeWorktree(f.repo, tree, id)).ok, false);
    await git(tree, 'add', '.'); await git(tree, 'commit', '-m', 'Feature');
    const unmerged = await worktreeInfo(f.repo, tree, id);
    assert.equal(unmerged.canMerge, true);
    assert.match(unmerged.cleanupReasons.join('\n'), /尚未合入 main/);
    assert.equal((await cleanupWorktree(f.repo, tree, id)).ok, false);
    await fs.writeFile(path.join(f.repo, 'dirty.txt'), 'keep');
    assert.equal((await mergeWorktree(f.repo, tree, id)).ok, false);
    await fs.unlink(path.join(f.repo, 'dirty.txt'));
    assert.equal((await mergeWorktree(f.repo, tree, id)).status, 'merged');
    assert.equal(await fs.readFile(path.join(f.repo, 'new.txt'), 'utf8'), 'worktree data');
    await fs.writeFile(path.join(tree, 'ignored.txt'), 'must survive');
    assert.match((await worktreeInfo(f.repo, tree, id)).cleanupReasons.join('\n'), /被 Git 忽略.*ignored\.txt/);
    assert.equal((await cleanupWorktree(f.repo, tree, id)).ok, false);
    assert.equal(await fs.readFile(path.join(tree, 'ignored.txt'), 'utf8'), 'must survive');
    await fs.unlink(path.join(tree, 'ignored.txt'));
    assert.equal((await cleanupWorktree(f.repo, tree, id)).status, 'removed');
    await assert.rejects(fs.stat(tree));
    assert.ok(await git(f.repo, 'rev-parse', '--verify', `refs/heads/workbench/${id.slice(0, 8)}`));
  } finally { await f.dispose(); }
});

test('a dirty source prevents merge but does not invent a cleanup blocker for a safe child', async () => {
  const f = await fixture(); try {
    const id = randomUUID(), tree = await createWorktree(f.repo, f.dir, id);
    await fs.writeFile(path.join(f.repo, 'local.txt'), 'source changes stay');
    const info = await worktreeInfo(f.repo, tree, id);
    assert.equal(info.canMerge, false);
    assert.equal(info.canCleanup, true);
    assert.deepEqual(info.cleanupReasons, []);
    assert.match(info.reasons.join('\n'), /主项目存在未提交/);
    assert.equal((await cleanupWorktree(f.repo, tree, id)).status, 'removed');
    assert.equal(await fs.readFile(path.join(f.repo, 'local.txt'), 'utf8'), 'source changes stay');
  } finally { await f.dispose(); }
});

test('diverged and foreign worktrees are preserved without automatic reset or merge', async () => {
  const f = await fixture(); try {
    const id = randomUUID(); const tree = await createWorktree(f.repo, f.dir, id);
    await fs.writeFile(path.join(tree, 'file.txt'), 'feature\n'); await git(tree, 'commit', '-am', 'Feature');
    await fs.writeFile(path.join(f.repo, 'file.txt'), 'main branch\n'); await git(f.repo, 'commit', '-am', 'Main');
    const head = await git(f.repo, 'rev-parse', 'HEAD');
    const result = await mergeWorktree(f.repo, tree, id);
    assert.equal(result.status, 'blocked'); assert.match(result.message, /分叉/);
    assert.equal(await git(f.repo, 'rev-parse', 'HEAD'), head);
    assert.equal(await fs.readFile(path.join(tree, 'file.txt'), 'utf8'), 'feature\n');
    const foreign = path.join(f.dir, 'foreign'); await git(f.repo, 'worktree', 'add', '-b', 'manual', foreign);
    assert.equal((await cleanupWorktree(f.repo, foreign, id)).ok, false);
    assert.ok(await fs.stat(foreign));
  } finally { await f.dispose(); }
});

test('explicit force cleanup discards dirty and ignored data but preserves unmerged commits and the source project', async () => {
  const f = await fixture(); try {
    const id = randomUUID(), tree = await createWorktree(f.repo, f.dir, id);
    await fs.writeFile(path.join(tree, 'file.txt'), 'committed feature\n');
    await git(tree, 'commit', '-am', 'Feature');
    const feature = await git(tree, 'rev-parse', 'HEAD');
    await fs.writeFile(path.join(tree, 'file.txt'), 'uncommitted edit\n');
    await fs.writeFile(path.join(tree, 'untracked.txt'), 'discard this untracked file');
    await fs.writeFile(path.join(tree, 'ignored.txt'), 'discard this ignored file');
    await fs.writeFile(path.join(f.repo, 'file.txt'), 'separate source commit\n');
    await git(f.repo, 'commit', '-am', 'Source');
    await fs.writeFile(path.join(f.repo, 'keep.txt'), 'source working data');
    const sourceHead = await git(f.repo, 'rev-parse', 'HEAD');
    assert.equal((await cleanupWorktree(f.repo, tree, id)).ok, false);
    const removed = await forceCleanupWorktree(f.repo, tree, id);
    assert.equal(removed.status, 'removed', removed.message);
    await assert.rejects(fs.stat(tree));
    assert.equal(await git(f.repo, 'rev-parse', `refs/heads/workbench/${id.slice(0, 8)}`), feature);
    assert.equal(await git(f.repo, 'show', `${feature}:file.txt`), 'committed feature');
    assert.equal(await git(f.repo, 'rev-parse', 'HEAD'), sourceHead);
    assert.equal(await fs.readFile(path.join(f.repo, 'keep.txt'), 'utf8'), 'source working data');
    assert.doesNotMatch(await git(f.repo, 'worktree', 'list', '--porcelain'), new RegExp(id));
  } finally { await f.dispose(); }
});

test('force cleanup refuses active, foreign, main, subdirectory and Git-locked worktrees without changing files', async () => {
  const f = await fixture(); try {
    const id = randomUUID(), tree = await createWorktree(f.repo, f.dir, id);
    await fs.writeFile(path.join(tree, 'keep.txt'), 'keep unsafe target');
    assert.equal((await forceCleanupWorktree(f.repo, tree, id, true)).ok, false);
    assert.equal((await forceCleanupWorktree(f.repo, tree, randomUUID())).ok, false);
    assert.equal((await forceCleanupWorktree(f.repo, f.repo, id)).ok, false);
    const child = path.join(tree, 'child'); await fs.mkdir(child);
    assert.equal((await forceCleanupWorktree(f.repo, child, id)).ok, false);
    const foreign = path.join(f.dir, 'foreign');
    await git(f.repo, 'worktree', 'add', '-b', 'manual-force-target', foreign);
    assert.equal((await forceCleanupWorktree(f.repo, foreign, id)).ok, false);
    await git(f.repo, 'worktree', 'lock', '--reason', 'External process owns this worktree', tree);
    const locked = await forceCleanupWorktree(f.repo, tree, id);
    assert.equal(locked.ok, false);
    assert.match(locked.message, /locked/i);
    assert.match(await git(f.repo, 'worktree', 'list', '--porcelain'), /locked External process/);
    assert.equal(await fs.readFile(path.join(tree, 'keep.txt'), 'utf8'), 'keep unsafe target');
    assert.equal(await fs.readFile(path.join(f.repo, 'file.txt'), 'utf8'), 'initial\n');
    assert.ok(await fs.stat(foreign));
  } finally { await f.dispose(); }
});

test('force cleanup protects registered nested worktrees and nested independent or bare repositories', async () => {
  const f = await fixture(); try {
    const id = randomUUID(), tree = await createWorktree(f.repo, f.dir, id);
    const nested = path.join(tree, 'nested-worktree');
    await git(f.repo, 'worktree', 'add', '-b', 'nested-manual', nested);
    const registered = await forceCleanupWorktree(f.repo, tree, id);
    assert.equal(registered.ok, false); assert.match(registered.message, /其他 worktree/);
    assert.equal(await fs.readFile(path.join(nested, 'file.txt'), 'utf8'), 'initial\n');
    await git(f.repo, 'worktree', 'remove', nested);
    const independent = path.join(tree, 'independent'); await fs.mkdir(independent);
    await git(independent, 'init', '-b', 'main');
    await fs.writeFile(path.join(independent, 'keep.txt'), 'nested repository data');
    const repository = await forceCleanupWorktree(f.repo, tree, id);
    assert.equal(repository.ok, false); assert.match(repository.message, /独立 Git 仓库/);
    assert.equal(await fs.readFile(path.join(independent, 'keep.txt'), 'utf8'), 'nested repository data');
    // Move the preserved repo outside, then inspect a bare repo whose metadata
    // lacks a .git name (common for local mirrors and backups).
    await fs.rename(independent, path.join(f.dir, 'preserved-independent'));
    const bare = path.join(tree, 'backup.git'); await fs.mkdir(bare);
    await git(bare, 'init', '--bare');
    const bareHead = await fs.readFile(path.join(bare, 'HEAD'), 'utf8');
    const backup = await forceCleanupWorktree(f.repo, tree, id);
    assert.equal(backup.ok, false); assert.match(backup.message, /独立 Git 仓库/);
    assert.equal(await fs.readFile(path.join(bare, 'HEAD'), 'utf8'), bareHead);
  } finally { await f.dispose(); }
});

test('force cleanup refuses a symlink target and leaves external symlink contents untouched', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture(); try {
    const id = randomUUID(), tree = await createWorktree(f.repo, f.dir, id);
    const alias = path.join(f.dir, 'tree-link'); await fs.symlink(tree, alias, 'dir');
    assert.equal((await forceCleanupWorktree(f.repo, alias, id)).ok, false);
    await fs.symlink(f.repo, path.join(tree, 'external-link'), 'dir');
    const removed = await forceCleanupWorktree(f.repo, tree, id);
    assert.equal(removed.ok, true, removed.message);
    assert.equal(await fs.readFile(path.join(f.repo, 'file.txt'), 'utf8'), 'initial\n');
  } finally { await f.dispose(); }
});
