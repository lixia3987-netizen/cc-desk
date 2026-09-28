import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileAsync } from '../src/main/commands';
import { cleanupWorktree, createWorktree, forceCleanupWorktree, listWorktreeBranches, mergeWorktree, worktreeInfo } from '../src/main/git';

async function git(cwd: string, ...args: string[]) { return (await execFileAsync('git', args, { cwd })).stdout.trim(); }
async function fixture() {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ccdesk-worktree-branches-')));
  const repo = path.join(dir, 'repo'); await fs.mkdir(repo);
  await git(repo, 'init', '-b', 'main');
  await git(repo, 'config', 'user.name', 'Workbench Tests');
  await git(repo, 'config', 'user.email', 'tests@example.invalid');
  await git(repo, 'config', 'core.autocrlf', 'false');
  await fs.writeFile(path.join(repo, 'file.txt'), 'initial\n');
  await git(repo, 'add', '.'); await git(repo, 'commit', '-m', 'Initial');
  const initial = await git(repo, 'rev-parse', 'HEAD');
  const remote = path.join(dir, 'origin.git'); await git(dir, 'init', '--bare', remote);
  await git(repo, 'remote', 'add', 'origin', remote); await git(repo, 'push', 'origin', 'main');
  return { dir, repo, remote, initial, dispose: () => fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) };
}
async function feature(repo: string, branch = 'feature/example') {
  await git(repo, 'switch', '-c', branch);
  await fs.writeFile(path.join(repo, 'file.txt'), `${branch}\n`);
  await git(repo, 'commit', '-am', 'Feature');
  const head = await git(repo, 'rev-parse', 'HEAD'); await git(repo, 'switch', 'main');
  return head;
}

test('a local start branch changes only the new worktree and preserves its original merge target', async () => {
  const f = await fixture(); try {
    const head = await feature(f.repo), id = randomUUID();
    const branches = await listWorktreeBranches(f.repo);
    assert.ok(branches.some(branch => branch.ref === 'refs/heads/main' && branch.current));
    assert.ok(branches.some(branch => branch.ref === 'refs/heads/feature/example' && !branch.remote));
    const tree = await createWorktree(f.repo, f.dir, id, undefined, 'refs/heads/feature/example');
    assert.equal(await git(tree, 'rev-parse', 'HEAD'), head);
    assert.equal(await git(f.repo, 'branch', '--show-current'), 'main');
    assert.equal(await git(f.repo, 'rev-parse', 'HEAD'), f.initial);
    const info = await worktreeInfo(f.repo, tree, id);
    assert.equal(info.baseBranch, 'main'); assert.equal(info.sourceRef, 'refs/heads/feature/example');
    assert.equal(info.sourceCommit, head); assert.equal(info.canMerge, true);
    assert.equal(info.merged, false); assert.equal(info.canCleanup, true);
    await fs.writeFile(path.join(tree, 'new.txt'), 'new work\n');
    await git(tree, 'add', '.'); await git(tree, 'commit', '-m', 'Worktree work');
    assert.equal((await worktreeInfo(f.repo, tree, id)).canCleanup, false);
    assert.equal((await mergeWorktree(f.repo, tree, id)).ok, true);
    assert.equal((await cleanupWorktree(f.repo, tree, id)).ok, true);
  } finally { await f.dispose(); }
});

test('refresh discovers remote-only branches and selected remote refs fetch their latest exact commit', async () => {
  const f = await fixture(); try {
    const head = await feature(f.repo);
    await git(f.repo, 'push', 'origin', 'feature/example'); await git(f.repo, 'branch', '-D', 'feature/example');
    await git(f.repo, 'update-ref', '-d', 'refs/remotes/origin/feature/example');
    assert.equal((await listWorktreeBranches(f.repo)).some(branch => branch.ref === 'refs/remotes/origin/feature/example'), false);
    // A configured fetch refspec aimed at a local branch must never be used.
    await git(f.repo, 'config', '--replace-all', 'remote.origin.fetch', '+refs/heads/feature/example:refs/heads/main');
    const branches = await listWorktreeBranches(f.repo, true);
    assert.ok(branches.some(branch => branch.ref === 'refs/remotes/origin/feature/example' && branch.remote === 'origin'));
    await git(f.repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    assert.equal((await listWorktreeBranches(f.repo)).some(branch => branch.ref === 'refs/remotes/origin/HEAD'), false);
    const writer = path.join(f.dir, 'writer'); await git(f.repo, 'clone', f.remote, writer);
    await git(writer, 'config', 'user.name', 'Writer'); await git(writer, 'config', 'user.email', 'writer@example.invalid');
    await git(writer, 'switch', 'feature/example');
    await fs.writeFile(path.join(writer, 'remote.txt'), 'latest remote commit\n');
    await git(writer, 'add', '.'); await git(writer, 'commit', '-m', 'Remote update'); await git(writer, 'push');
    const latest = await git(writer, 'rev-parse', 'HEAD'); assert.notEqual(latest, head);
    const id = randomUUID(), tree = await createWorktree(f.repo, f.dir, id, undefined, 'refs/remotes/origin/feature/example');
    assert.equal(await git(tree, 'rev-parse', 'HEAD'), latest);
    assert.equal(await git(f.repo, 'rev-parse', 'HEAD'), f.initial);
    assert.equal(await git(f.repo, 'branch', '--show-current'), 'main');
    await assert.rejects(git(f.repo, 'show-ref', '--verify', 'refs/heads/feature/example'));
    assert.equal((await worktreeInfo(f.repo, tree, id)).sourceRef, 'refs/remotes/origin/feature/example');
    assert.equal((await cleanupWorktree(f.repo, tree, id)).ok, true);
  } finally { await f.dispose(); }
});

test('deleted remote branches and unsafe revision expressions fail without a stale checkout', async () => {
  const f = await fixture(); try {
    await feature(f.repo); await git(f.repo, 'push', 'origin', 'feature/example');
    // Delete directly in the bare remote to leave the local tracking ref stale.
    await git(f.remote, 'update-ref', '-d', 'refs/heads/feature/example');
    const before = await git(f.repo, 'worktree', 'list', '--porcelain');
    await assert.rejects(createWorktree(f.repo, f.dir, randomUUID(), undefined, 'refs/remotes/origin/feature/example'));
    for (const ref of ['main', 'HEAD~1', '--upload-pack=bad', 'refs/heads/main~1', 'refs/heads/main^{commit}', 'refs/heads/main:README.md', 'refs/remotes/missing/topic']) {
      await assert.rejects(createWorktree(f.repo, f.dir, randomUUID(), undefined, ref));
    }
    await git(f.repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    await assert.rejects(createWorktree(f.repo, f.dir, randomUUID(), undefined, 'refs/remotes/origin/HEAD'), /符号引用/);
    assert.equal(await git(f.repo, 'worktree', 'list', '--porcelain'), before);
    assert.equal(await git(f.repo, 'rev-parse', 'HEAD'), f.initial);
  } finally { await f.dispose(); }
});

test('remote tracking aliases cannot redirect refresh into local branches', async () => {
  const f = await fixture(); try {
    await git(f.repo, 'branch', 'guard');
    const head = await feature(f.repo);
    await git(f.repo, 'push', 'origin', 'feature/example:main');
    await git(f.repo, 'symbolic-ref', 'refs/remotes/origin/main', 'refs/heads/guard');
    await assert.rejects(listWorktreeBranches(f.repo, true), /异常符号引用/);
    assert.equal(await git(f.repo, 'rev-parse', 'refs/heads/guard'), f.initial);
    assert.notEqual(await git(f.repo, 'rev-parse', 'refs/heads/guard'), head);
    assert.equal(await git(f.repo, 'rev-parse', 'HEAD'), f.initial);
  } finally { await f.dispose(); }
});

test('detached sources retain ownership and allow safe cleanup without an automatic merge target', async () => {
  const f = await fixture(); try {
    await git(f.repo, 'checkout', '--detach');
    const id = randomUUID(), tree = await createWorktree(f.repo, f.dir, id, undefined, 'refs/heads/main');
    const info = await worktreeInfo(f.repo, tree, id);
    assert.equal(info.owned, true); assert.equal(info.baseBranch, undefined); assert.equal(info.canMerge, false);
    assert.equal(info.canCleanup, true); assert.match(info.reasons.join('\n'), /detached HEAD/);
    assert.equal((await cleanupWorktree(f.repo, tree, id)).ok, true);
    const forceId = randomUUID(), forceTree = await createWorktree(f.repo, f.dir, forceId);
    await fs.unlink(path.join(forceTree, '.git'));
    assert.equal((await forceCleanupWorktree(f.repo, forceTree, forceId)).ok, true);
  } finally { await f.dispose(); }
});

test('unborn repositories require a committed start ref and can create from a remote branch', async () => {
  const f = await fixture(); try {
    const empty = path.join(f.dir, 'empty'); await fs.mkdir(empty); await git(empty, 'init', '-b', 'main');
    assert.deepEqual(await listWorktreeBranches(empty), []);
    await assert.rejects(createWorktree(empty, f.dir, randomUUID()), /尚无提交/);
    await git(empty, 'remote', 'add', 'origin', f.remote);
    const id = randomUUID(), tree = await createWorktree(empty, f.dir, id, undefined, 'refs/remotes/origin/main');
    assert.equal(await git(tree, 'rev-parse', 'HEAD'), f.initial);
    await assert.rejects(git(empty, 'rev-parse', '--verify', 'HEAD'));
    const info = await worktreeInfo(empty, tree, id);
    assert.equal(info.owned, true); assert.equal(info.canMerge, false); assert.equal(info.canCleanup, true);
    assert.equal((await cleanupWorktree(empty, tree, id)).ok, true);
  } finally { await f.dispose(); }
});

test('reserved project-local files are checked in the selected start branch', async () => {
  const f = await fixture(); try {
    await git(f.repo, 'switch', '-c', 'reserved');
    await fs.mkdir(path.join(f.repo, '.claude', 'worktrees'), { recursive: true });
    await fs.writeFile(path.join(f.repo, '.claude', 'worktrees', 'tracked.txt'), 'keep\n');
    await git(f.repo, 'add', '.'); await git(f.repo, 'commit', '-m', 'Reserved content'); await git(f.repo, 'switch', 'main');
    await assert.rejects(createWorktree(f.repo, f.dir, randomUUID(), {
      location: 'project', projectPath: f.repo, projectName: 'Project', name: '',
    }, 'refs/heads/reserved'), /跟踪/);
    assert.equal(await git(f.repo, 'status', '--porcelain'), '');
  } finally { await f.dispose(); }
});
