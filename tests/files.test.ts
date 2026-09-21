import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listProjectFiles, readProjectFile, resolveProjectFile } from '../src/main/files';

test('project references find and preview bounded files while rejecting traversal and external symlinks', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-files-'));
  try {
    const project = path.join(dir, 'project'); await fs.mkdir(path.join(project, 'src'), { recursive: true });
    await fs.mkdir(path.join(project, '.git')); await fs.mkdir(path.join(project, 'node_modules'));
    await fs.writeFile(path.join(project, 'src', 'hello.ts'), 'export const hello = 1;');
    await fs.writeFile(path.join(project, 'node_modules', 'omit.js'), 'ignored');
    await fs.writeFile(path.join(dir, 'outside.txt'), 'secret');
    assert.deepEqual((await listProjectFiles(project, 'hello')).files, ['src/hello.ts']);
    assert.equal((await readProjectFile(project, 'src/hello.ts')).content, 'export const hello = 1;');
    for (const invalid of ['../outside.txt', '/etc/passwd', 'C:\\Windows\\win.ini', 'src/../../outside.txt', '.git/config', 'src/../hello.ts', 'hello\0.ts']) await assert.rejects(readProjectFile(project, invalid));
    await fs.writeFile(path.join(project, 'large.txt'), 'x'.repeat(300000));
    const large = await readProjectFile(project, 'large.txt'); assert.equal(large.truncated, true); assert.equal(large.bytes, 300000); assert.equal(large.content.length, 256 * 1024);
    await fs.writeFile(path.join(project, 'binary.dat'), Buffer.from([0, 1, 2]));
    assert.equal((await readProjectFile(project, 'binary.dat')).binary, true);
    if (process.platform !== 'win32') {
      await fs.symlink(path.join(dir, 'outside.txt'), path.join(project, 'external.txt'));
      await fs.symlink(dir, path.join(project, 'external-dir'));
      await assert.rejects(readProjectFile(project, 'external.txt'), /项目外/);
      await assert.rejects(resolveProjectFile(project, 'external-dir/missing.txt', true), /项目外/);
      assert.ok(!(await listProjectFiles(project)).files.includes('external.txt'));
      await fs.symlink(path.join(project, 'src', 'hello.ts'), path.join(project, 'internal.ts'));
      assert.equal((await readProjectFile(project, 'internal.ts')).content, 'export const hello = 1;');
      await fs.writeFile(path.join(project, '.git', 'config'), 'credentials');
      await fs.symlink(path.join(project, '.git', 'config'), path.join(project, 'git-alias.txt'));
      await assert.rejects(readProjectFile(project, 'git-alias.txt'), /Git 内部/);
    }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
