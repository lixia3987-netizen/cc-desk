import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ProjectFiles, contentHash, isSensitivePath, normalizeProjectPath } from '../dist/tools/project-files.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-files-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, files: new ProjectFiles({ projectRoot: root }) };
}
test('secure read hashes complete UTF-8 content and rejects unsupported objects', async t => {
  const { root, files } = await fixture(t);
  await fs.writeFile(path.join(root, 'hello.txt'), '一二\nthree\n');
  const read = await files.read('hello.txt');
  assert.equal(read.content, '一二\nthree\n');
  assert.equal(read.hash, contentHash('一二\nthree\n'));
  await fs.writeFile(path.join(root, 'binary'), Buffer.from([1, 0, 2]));
  await fs.writeFile(path.join(root, 'encoding'), Buffer.from([0xff, 0xfe]));
  await assert.rejects(files.read('binary'), /Binary/);
  await assert.rejects(files.read('encoding'), /UTF-8/);
  await fs.writeFile(path.join(root, 'large'), 'a'.repeat(200));
  await assert.rejects(new ProjectFiles({ projectRoot: root, maxFileBytes: 100 }).read('large'), /byte limit/);
});
test('boundary refuses unsafe names, protected host roots, and all file/directory links', async t => {
  const { root, files } = await fixture(t);
  for (const name of ['../secret', '/absolute', 'C:/absolute', 'C:relative', 'a\\b', '.git/config', 'a/.GiT/config', 'file:stream', 'a/../b', 'NUL.txt', 'trailing.']) assert.throws(() => normalizeProjectPath(name));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'native-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, 'secret'), 'private');
  await fs.mkdir(path.join(root, 'inside'));
  await fs.writeFile(path.join(root, 'inside', 'normal'), 'normal');
  try {
    await fs.symlink(outside, path.join(root, 'outside-link'), process.platform === 'win32' ? 'junction' : 'dir');
    await fs.symlink(path.join(root, 'inside'), path.join(root, 'inside-link'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') { t.skip('Symbolic links need Windows privileges.'); return; } throw error; }
  await assert.rejects(files.read('outside-link/secret'), /links/);
  await assert.rejects(files.read('inside-link/normal'), /links/);
  const protectedFiles = new ProjectFiles({ projectRoot: root, excludedRoots: [path.join(root, 'inside')] });
  await assert.rejects(protectedFiles.read('inside/normal'), /Protected/);
});
test('single file create uses no-clobber publication and update preserves executable permissions', async t => {
  const { root, files } = await fixture(t);
  const created = await files.applyPatch(await files.preparePatch({ path: 'script', content: 'before\n', expectedHash: null }));
  assert.equal(created.created, true);
  if (process.platform !== 'win32') await fs.chmod(path.join(root, 'script'), 0o751);
  const read = await files.read('script');
  const result = await files.applyPatch(await files.preparePatch({ path: 'script', content: 'after\n', expectedHash: read.hash }));
  assert.equal(result.previousHash, read.hash);
  assert.equal(await fs.readFile(path.join(root, 'script'), 'utf8'), 'after\n');
  if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(root, 'script'))).mode & 0o777, 0o751);
  assert.deepEqual((await fs.readdir(root)).filter(name => name.startsWith('.native-patch-')), []);
});
test('approval-time target and parent changes block updates and no-clobber creation', async t => {
  const { root, files } = await fixture(t);
  await fs.mkdir(path.join(root, 'folder'));
  await fs.writeFile(path.join(root, 'folder', 'file'), 'old');
  const read = await files.read('folder/file');
  const update = await files.preparePatch({ path: 'folder/file', content: 'new', expectedHash: read.hash });
  await fs.writeFile(path.join(root, 'folder', 'file'), 'external');
  await assert.rejects(files.applyPatch(update), /changed|conflict/i);
  assert.equal(await fs.readFile(path.join(root, 'folder', 'file'), 'utf8'), 'external');
  const create = await files.preparePatch({ path: 'folder/new', content: 'mine', expectedHash: null });
  await fs.writeFile(path.join(root, 'folder', 'new'), 'theirs');
  await assert.rejects(files.applyPatch(create), /conflict|EEXIST/i);
  assert.equal(await fs.readFile(path.join(root, 'folder', 'new'), 'utf8'), 'theirs');
  const parentChange = await files.preparePatch({ path: 'folder/new2', content: 'mine', expectedHash: null });
  await fs.rename(path.join(root, 'folder'), path.join(root, 'moved'));
  await fs.mkdir(path.join(root, 'folder'));
  await assert.rejects(files.applyPatch(parentChange), /changed/i);
  await assert.rejects(fs.stat(path.join(root, 'folder', 'new2')), /ENOENT/);
});
test('simultaneous exclusive creates produce one winner and leave no temporary files', async t => {
  const { root, files } = await fixture(t);
  const first = await files.preparePatch({ path: 'race', content: 'first', expectedHash: null });
  const second = await files.preparePatch({ path: 'race', content: 'second', expectedHash: null });
  const outcomes = await Promise.allSettled([files.applyPatch(first), files.applyPatch(second)]);
  assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1);
  assert.ok(['first', 'second'].includes(await fs.readFile(path.join(root, 'race'), 'utf8')));
  assert.deepEqual(await fs.readdir(root), ['race']);
});
test('target appearing at publication cannot be overwritten and disk failure cleans only the temporary file', async t => {
  const { root, files } = await fixture(t);
  const create = await files.preparePatch({ path: 'appeared', content: 'mine', expectedHash: null });
  const originalLink = fs.link;
  fs.link = async (...args) => { await fs.writeFile(path.join(root, 'appeared'), 'external'); return originalLink(...args); };
  try { await assert.rejects(files.applyPatch(create), /EEXIST/); } finally { fs.link = originalLink; }
  assert.equal(await fs.readFile(path.join(root, 'appeared'), 'utf8'), 'external');
  const update = await files.preparePatch({ path: 'appeared', content: 'new', expectedHash: contentHash('external') });
  const originalRename = fs.rename;
  fs.rename = async () => { throw Object.assign(new Error('Injected disk failure'), { code: 'EIO' }); };
  try { await assert.rejects(files.applyPatch(update), /Injected disk failure/); } finally { fs.rename = originalRename; }
  assert.equal(await fs.readFile(path.join(root, 'appeared'), 'utf8'), 'external');
  assert.deepEqual(await fs.readdir(root), ['appeared']);
});
test('read detects a replaced parent after opening the file and never returns outside bytes', async t => {
  if (process.platform !== 'linux') { t.skip('Linux procfd race probe.'); return; }
  const { root, files } = await fixture(t);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'native-race-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'folder'));
  await fs.writeFile(path.join(root, 'folder', 'file'), 'authorized');
  await fs.writeFile(path.join(outside, 'file'), 'outside secret');
  const originalOpen = fs.open;
  let changed = false;
  fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (!changed && String(args[0]).startsWith('/proc/self/fd/') && String(args[0]).endsWith('/file')) {
      changed = true;
      await fs.rename(path.join(root, 'folder'), path.join(root, 'renamed'));
      await fs.symlink(outside, path.join(root, 'folder'), 'dir');
    }
    return handle;
  };
  try { await assert.rejects(files.read('folder/file'), /changed|links/i); } finally { fs.open = originalOpen; }
  assert.equal(changed, true);
});
test('sensitive names share the same policy for read/search/automatic context', () => {
  for (const name of ['.env', '.env.local', '.npmrc', '.ssh/id_ed25519', 'nested/private.key', '.aws/credentials', 'credentials.json', 'application_default_credentials.json']) assert.equal(isSensitivePath(name), true, name);
  for (const name of ['src/environment.ts', 'AGENTS.md', 'file.txt']) assert.equal(isSensitivePath(name), false, name);
});
