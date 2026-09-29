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
test('exact edit preserves UTF-8 BOM, CRLF, surrounding bytes and permissions, and supports deletion', async t => {
  const { root, files } = await fixture(t);
  const original = '\uFEFF一行\r\nconst value = "旧🙂";\r\nend\r\n';
  const target = path.join(root, 'edit.txt');
  await fs.writeFile(target, original);
  if (process.platform !== 'win32') await fs.chmod(target, 0o751);
  const read = await files.read('edit.txt');
  assert.equal(read.content, original);
  const prepared = await files.prepareEdit({ path: 'edit.txt', oldText: '"旧🙂"', newText: '"新文本🙂"', expectedHash: read.hash });
  assert.equal(await fs.readFile(target, 'utf8'), original, 'preparation has no side effects');
  const result = await files.applyPatch(prepared);
  const expected = '\uFEFF一行\r\nconst value = "新文本🙂";\r\nend\r\n';
  assert.deepEqual(await fs.readFile(target), Buffer.from(expected));
  assert.equal(result.created, false);
  assert.equal(result.previousHash, read.hash);
  assert.equal(result.hash, contentHash(expected));
  assert.equal(result.bytes, Buffer.byteLength(expected));
  if (process.platform !== 'win32') assert.equal((await fs.stat(target)).mode & 0o777, 0o751);
  await files.applyPatch(await files.prepareEdit({ path: 'edit.txt', oldText: 'end\r\n', newText: '', expectedHash: result.hash }));
  assert.equal(await fs.readFile(target, 'utf8'), expected.slice(0, -5));
  assert.deepEqual(await fs.readdir(root), ['edit.txt']);
});
test('exact edit refuses duplicate, overlapping, absent, empty and unchanged matches', async t => {
  const { root, files } = await fixture(t);
  const original = 'same\r\nsame\r\naaa';
  await fs.writeFile(path.join(root, 'edit.txt'), original);
  const input = { path: 'edit.txt', oldText: 'same', newText: 'new', expectedHash: contentHash(original) };
  await assert.rejects(files.prepareEdit(input), /exactly once/);
  await assert.rejects(files.prepareEdit({ ...input, oldText: 'aa' }), /exactly once/);
  await assert.rejects(files.prepareEdit({ ...input, oldText: 'same\nsame' }), /does not exactly match/);
  await assert.rejects(files.prepareEdit({ ...input, oldText: '' }), /nonempty/);
  await assert.rejects(files.prepareEdit({ ...input, oldText: 'aaa', newText: 'aaa' }), /must change/);
  assert.equal(await fs.readFile(path.join(root, 'edit.txt'), 'utf8'), original);
});
test('exact edit requires an existing file and a complete current hash', async t => {
  const { root, files } = await fixture(t);
  await fs.writeFile(path.join(root, 'edit.txt'), 'before\nunchanged');
  const input = { path: 'edit.txt', oldText: 'before', newText: 'after', expectedHash: contentHash('before\nunchanged') };
  for (const expectedHash of [null, '', 'abc', contentHash('other')]) {
    await assert.rejects(files.prepareEdit({ ...input, expectedHash }), /SHA-256|version conflict/);
  }
  await assert.rejects(files.prepareEdit({ ...input, path: 'missing' }), /ENOENT/);
  const prepared = await files.prepareEdit(input);
  await fs.writeFile(path.join(root, 'edit.txt'), 'before\nexternal');
  await assert.rejects(files.applyPatch(prepared), /changed|conflict/);
  assert.equal(await fs.readFile(path.join(root, 'edit.txt'), 'utf8'), 'before\nexternal');
});
test('exact edit rejects invalid UTF-8, binary, oversized input and oversized resulting files', async t => {
  const { root } = await fixture(t);
  const files = new ProjectFiles({ projectRoot: root, maxFileBytes: 16 });
  const original = 'prefix-old-tail';
  await fs.writeFile(path.join(root, 'edit.txt'), original);
  const input = { path: 'edit.txt', oldText: 'old', newText: 'new', expectedHash: contentHash(original) };
  for (const value of ['\ud800', '\udfff', '\0', '文'.repeat(6)]) {
    await assert.rejects(files.prepareEdit({ ...input, oldText: value }), /UTF-8/);
    await assert.rejects(files.prepareEdit({ ...input, newText: value }), /UTF-8/);
  }
  await assert.rejects(files.prepareEdit({ ...input, newText: 'longer' }), /UTF-8/);
  assert.equal(await fs.readFile(path.join(root, 'edit.txt'), 'utf8'), original);
  for (const bytes of [Buffer.from([0xff]), Buffer.from([0]), Buffer.from('x'.repeat(17))]) {
    await fs.writeFile(path.join(root, 'unsupported'), bytes);
    await assert.rejects(files.prepareEdit({ ...input, path: 'unsupported', oldText: 'x', expectedHash: contentHash(bytes) }), /UTF-8|Binary|byte limit/);
  }
});
test('exact edit retains file and parent identities even if replacement bytes have the same hash', async t => {
  const { root, files } = await fixture(t);
  await fs.mkdir(path.join(root, 'folder'));
  const target = path.join(root, 'folder', 'file');
  await fs.writeFile(target, 'before');
  const input = { path: 'folder/file', oldText: 'before', newText: 'after', expectedHash: contentHash('before') };
  const replacedFile = await files.prepareEdit(input);
  await fs.rename(target, path.join(root, 'saved'));
  await fs.writeFile(target, 'before');
  await assert.rejects(files.applyPatch(replacedFile), /changed/);
  const replacedParent = await files.prepareEdit(input);
  await fs.rename(path.join(root, 'folder'), path.join(root, 'moved'));
  await fs.mkdir(path.join(root, 'folder'));
  await fs.writeFile(target, 'before');
  await assert.rejects(files.applyPatch(replacedParent), /changed/);
  assert.equal(await fs.readFile(target, 'utf8'), 'before');
  assert.equal(await fs.readFile(path.join(root, 'moved', 'file'), 'utf8'), 'before');
});
test('exact edit cancellation after staging and publication failure leave the original file intact', async t => {
  const { root, files } = await fixture(t);
  const target = path.join(root, 'edit.txt');
  const original = 'before\nunchanged';
  await fs.writeFile(target, original);
  const input = { path: 'edit.txt', oldText: 'before', newText: 'after', expectedHash: contentHash(original) };
  const prepared = await files.prepareEdit(input);
  const controller = new AbortController();
  const originalOpen = fs.open;
  let staged = false;
  fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (String(args[0]).includes('.native-patch-')) {
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        await sync();
        assert.equal(await fs.readFile(target, 'utf8'), original);
        staged = true;
        controller.abort(new Error('Cancelled after staging'));
      };
    }
    return handle;
  };
  try { await assert.rejects(files.applyPatch(prepared, controller.signal), /Cancelled after staging/); } finally { fs.open = originalOpen; }
  assert.equal(staged, true);
  assert.equal(await fs.readFile(target, 'utf8'), original);
  assert.deepEqual(await fs.readdir(root), ['edit.txt']);
  const originalRename = fs.rename;
  fs.rename = async () => { throw Object.assign(new Error('Injected edit publication failure'), { code: 'EIO' }); };
  try { await assert.rejects(files.applyPatch(await files.prepareEdit(input)), /publication failure/); } finally { fs.rename = originalRename; }
  assert.equal(await fs.readFile(target, 'utf8'), original);
  assert.deepEqual(await fs.readdir(root), ['edit.txt']);
  const aborted = new AbortController(); aborted.abort(new Error('Cancelled before prepare'));
  await assert.rejects(files.prepareEdit(input, aborted.signal), /Cancelled before prepare/);
});
