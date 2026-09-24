import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileAsync } from '../src/main/commands';
import { cleanupWorktree, createWorktree, gitChanges, gitDiff, mergeWorktree, worktreeInfo } from '../src/main/git';

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
