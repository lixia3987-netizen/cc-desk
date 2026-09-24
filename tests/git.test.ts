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

test('explicit direct cleanup discards dirty and ignored data while retaining source branches and files', async () => {
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
    const removed = await forceCleanupWorktree(f.repo, tree);
    assert.equal(removed.status, 'removed', removed.message);
    await assert.rejects(fs.stat(tree));
    assert.equal(await git(f.repo, 'rev-parse', `refs/heads/workbench/${id.slice(0, 8)}`), feature);
    assert.equal(await git(f.repo, 'show', `${feature}:file.txt`), 'committed feature');
    assert.equal(await git(f.repo, 'rev-parse', 'HEAD'), sourceHead);
    assert.equal(await fs.readFile(path.join(f.repo, 'keep.txt'), 'utf8'), 'source working data');
    assert.doesNotMatch(await git(f.repo, 'worktree', 'list', '--porcelain'), new RegExp(id.slice(0, 8)));
  } finally { await f.dispose(); }
});

test('direct cleanup deletes locked and unowned targets and removes only their registrations', async () => {
  const f = await fixture(); try {
    const id = randomUUID(), tree = await createWorktree(f.repo, f.dir, id);
    const admin = await git(tree, 'rev-parse', '--absolute-git-dir');
    await fs.unlink(path.join(admin, 'workbench-owner.json'));
    await fs.writeFile(path.join(tree, 'discard.txt'), 'unowned data');
    await git(f.repo, 'worktree', 'lock', '--reason', 'external lock', tree);
    const foreign = path.join(f.dir, 'foreign');
    await git(f.repo, 'worktree', 'add', '-b', 'manual-force-target', foreign);
    const otherId = randomUUID(), other = await createWorktree(f.repo, f.dir, otherId);
    await fs.writeFile(path.join(other, 'keep.txt'), 'unrelated worktree data');
    assert.equal((await forceCleanupWorktree(f.repo, tree)).ok, true);
    assert.equal((await forceCleanupWorktree(f.repo, foreign)).ok, true);
    await assert.rejects(fs.stat(tree)); await assert.rejects(fs.stat(foreign));
    const listed = await git(f.repo, 'worktree', 'list', '--porcelain');
    assert.doesNotMatch(listed, new RegExp(id.slice(0, 8))); assert.doesNotMatch(listed, /manual-force-target/);
    assert.match(listed, new RegExp(otherId.slice(0, 8)));
    assert.equal(await fs.readFile(path.join(other, 'keep.txt'), 'utf8'), 'unrelated worktree data');
    assert.equal(await fs.readFile(path.join(f.repo, 'file.txt'), 'utf8'), 'initial\n');
    assert.ok(await git(f.repo, 'rev-parse', `refs/heads/workbench/${id.slice(0, 8)}`));
    assert.ok(await git(f.repo, 'rev-parse', 'refs/heads/manual-force-target'));
  } finally { await f.dispose(); }
});

test('direct cleanup removes nested repositories and worktree files without pruning other registrations', async () => {
  const f = await fixture(); try {
    const id = randomUUID(), tree = await createWorktree(f.repo, f.dir, id);
    const nested = path.join(tree, 'nested-worktree');
    await git(f.repo, 'worktree', 'add', '-b', 'nested-manual', nested);
    const independent = path.join(tree, 'independent'); await fs.mkdir(independent);
    await git(independent, 'init', '-b', 'main');
    await fs.writeFile(path.join(independent, 'discard.txt'), 'nested repository data');
    const bare = path.join(tree, 'backup.git'); await fs.mkdir(bare);
    await git(bare, 'init', '--bare');
    const otherId = randomUUID(), other = await createWorktree(f.repo, f.dir, otherId);
    const removed = await forceCleanupWorktree(f.repo, tree);
    assert.equal(removed.ok, true, removed.message);
    await assert.rejects(fs.stat(tree));
    const listed = await git(f.repo, 'worktree', 'list', '--porcelain');
    // Only the selected registration is removed: even a now-missing nested one
    // remains for Git/manual maintenance rather than invoking a global prune.
    assert.match(listed, /branch refs\/heads\/nested-manual/);
    assert.match(listed, new RegExp(otherId.slice(0, 8)));
    assert.ok(await git(f.repo, 'rev-parse', 'refs/heads/nested-manual'));
    assert.equal(await fs.readFile(path.join(other, 'file.txt'), 'utf8'), 'initial\n');
  } finally { await f.dispose(); }
});

test('direct cleanup accepts missing or corrupt gitfiles and a missing source without repairing metadata', async () => {
  const f = await fixture(); try {
    for (const state of ['missing', 'corrupt', 'foreign'] as const) {
      const id = randomUUID(), tree = await createWorktree(f.repo, f.dir, id);
      const marker = path.join(tree, '.git');
      if (state === 'missing') await fs.unlink(marker);
      if (state === 'corrupt') await fs.writeFile(marker, 'invalid gitfile');
      if (state === 'foreign') await fs.writeFile(marker, `gitdir: ${path.join(f.repo, '.git')}\n`);
      await fs.writeFile(path.join(tree, 'discard.txt'), state);
      const removed = await forceCleanupWorktree(f.repo, tree);
      assert.equal(removed.ok, true, `${state}: ${removed.message}`);
      await assert.rejects(fs.stat(tree));
      assert.ok(await git(f.repo, 'rev-parse', `refs/heads/workbench/${id.slice(0, 8)}`));
    }
    for (const base of [undefined, path.join(f.dir, 'missing-source')]) {
      const target = path.join(f.dir, randomUUID()); await fs.mkdir(target);
      await fs.writeFile(path.join(target, 'discard.txt'), 'ordinary directory without Git');
      const removed = await forceCleanupWorktree(base, target, [f.repo]);
      assert.equal(removed.ok, true, removed.message);
      assert.match(removed.message, /残留 Git/);
      await assert.rejects(fs.stat(target));
    }
    assert.equal(await fs.readFile(path.join(f.repo, 'file.txt'), 'utf8'), 'initial\n');
  } finally { await f.dispose(); }
});

test('direct cleanup removes a project-local tree with missing gitfile without touching its source', async () => {
  const f = await fixture(); try {
    const tree = path.join(f.repo, 'isolated');
    await git(f.repo, 'worktree', 'add', '-b', 'local-force-target', tree);
    await fs.unlink(path.join(tree, '.git'));
    await fs.writeFile(path.join(tree, 'discard.txt'), 'local isolated content');
    const removed = await forceCleanupWorktree(f.repo, tree, [f.repo]);
    assert.equal(removed.ok, true, removed.message);
    await assert.rejects(fs.stat(tree));
    assert.equal(await fs.readFile(path.join(f.repo, 'file.txt'), 'utf8'), 'initial\n');
    assert.ok(await git(f.repo, 'rev-parse', 'refs/heads/local-force-target'));
  } finally { await f.dispose(); }
});

test('already absent targets succeed while moved files and unrelated stale registrations remain untouched', async () => {
  const f = await fixture(); try {
    const id = randomUUID(), tree = await createWorktree(f.repo, f.dir, id);
    const otherId = randomUUID(), other = await createWorktree(f.repo, f.dir, otherId);
    await git(f.repo, 'worktree', 'lock', '--reason', 'stale lock', tree);
    await fs.rename(tree, `${tree}-moved`); await fs.rename(other, `${other}-moved`);
    const removed = await forceCleanupWorktree(f.repo, tree);
    assert.equal(removed.ok, true, removed.message);
    const listed = await git(f.repo, 'worktree', 'list', '--porcelain');
    assert.doesNotMatch(listed, new RegExp(id.slice(0, 8))); assert.match(listed, new RegExp(otherId.slice(0, 8)));
    assert.equal(await fs.readFile(path.join(`${tree}-moved`, 'file.txt'), 'utf8'), 'initial\n');
    assert.equal(await fs.readFile(path.join(`${other}-moved`, 'file.txt'), 'utf8'), 'initial\n');
    assert.equal((await forceCleanupWorktree(f.repo, tree)).ok, true);
    assert.equal((await forceCleanupWorktree(path.join(f.dir, 'absent-source'), tree)).ok, true);
    assert.equal((await forceCleanupWorktree(undefined, tree)).ok, true);
  } finally { await f.dispose(); }
});

test('direct deletion retains only filesystem root, source, project and metadata boundaries', async t => {
  const f = await fixture();
  const remove = t.mock.method(fs, 'rm', async () => { throw new Error('deletion should not be reached'); });
  try {
    const protectedProject = path.join(f.dir, 'other-project'); await fs.mkdir(protectedProject);
    for (const target of ['relative-directory', path.parse(f.dir).root, f.repo, f.dir, path.join(f.repo, '.git'), path.join(f.repo, '.git', 'worktrees'), protectedProject]) {
      const result = await forceCleanupWorktree(f.repo, target, [protectedProject]);
      assert.equal(result.ok, false, target);
      assert.doesNotMatch(result.message, /deletion should not be reached/);
    }
    assert.equal(remove.mock.callCount(), 0);
    assert.equal(await fs.readFile(path.join(f.repo, 'file.txt'), 'utf8'), 'initial\n');
  } finally { remove.mock.restore(); await f.dispose(); }
});

test('direct deletion unlinks final symlinks and never traverses links inside the selected directory', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture(); try {
    const alias = path.join(f.dir, 'source-alias'); await fs.symlink(f.repo, alias, 'dir');
    assert.equal((await forceCleanupWorktree(f.repo, alias)).ok, true);
    await assert.rejects(fs.lstat(alias));
    const dangling = path.join(f.dir, 'dangling-alias'); await fs.symlink(path.join(f.dir, 'absent'), dangling, 'dir');
    assert.equal((await forceCleanupWorktree(undefined, dangling)).ok, true);
    await assert.rejects(fs.lstat(dangling));
    const id = randomUUID(), tree = await createWorktree(f.repo, f.dir, id);
    await fs.symlink(f.repo, path.join(tree, 'source-link'), 'dir');
    assert.equal((await forceCleanupWorktree(f.repo, tree)).ok, true);
    await assert.rejects(fs.stat(tree));
    assert.equal(await fs.readFile(path.join(f.repo, 'file.txt'), 'utf8'), 'initial\n');
    assert.ok(await git(f.repo, 'rev-parse', 'HEAD'));
  } finally { await f.dispose(); }
});

test('filesystem deletion failure reports possible partial deletion and leaves Git registration untouched', async t => {
  const f = await fixture(); let remove: ReturnType<typeof t.mock.method> | undefined;
  try {
    const id = randomUUID(), tree = await createWorktree(f.repo, f.dir, id);
    await fs.writeFile(path.join(tree, 'keep.txt'), 'still present');
    const originalRemove = fs.rm;
    remove = t.mock.method(fs, 'rm', async (...args: Parameters<typeof fs.rm>) => {
      if (String(args[0]) === tree) {
        await originalRemove(path.join(tree, 'file.txt'));
        throw Object.assign(new Error('access denied'), { code: 'EACCES' });
      }
      return originalRemove(...args);
    });
    const result = await forceCleanupWorktree(f.repo, tree);
    assert.equal(result.ok, false);
    assert.match(result.message, /删除未完成/); assert.match(result.message, /部分文件可能已被删除/);
    assert.equal(await fs.readFile(path.join(tree, 'keep.txt'), 'utf8'), 'still present');
    await assert.rejects(fs.stat(path.join(tree, 'file.txt')));
    assert.match(await git(f.repo, 'worktree', 'list', '--porcelain'), new RegExp(id.slice(0, 8)));
  } finally { remove?.mock.restore(); await f.dispose(); }
});
