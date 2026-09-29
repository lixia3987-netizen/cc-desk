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

test('preview rejects an ancestor replaced by an outside symlink exactly before open', {skip:process.platform==='win32'}, async t => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'workbench-file-race-'));
  const project=path.join(dir,'project'), source=path.join(project,'src'), outside=path.join(dir,'outside');
  try {
    await fs.mkdir(source,{recursive:true}); await fs.mkdir(outside);
    await fs.writeFile(path.join(source,'file.txt'),'project data');
    await fs.writeFile(path.join(outside,'file.txt'),'OUTSIDE PRIVATE MARKER');
    const open=fs.open.bind(fs); let swapped=false;
    t.mock.method(fs,'open',async (...args:Parameters<typeof fs.open>)=>{
      if(!swapped) {
        swapped=true;
        await fs.rename(source,path.join(project,'original-src'));
        await fs.symlink(outside,source,'dir');
      }
      return open(...args);
    });
    await assert.rejects(readProjectFile(project,'src/file.txt'));
    assert.equal(swapped,true);
  } finally { t.mock.restoreAll(); await fs.rm(dir,{recursive:true,force:true}); }
});

test('preview verifies opened-file identity when a regular ancestor is replaced before open', async t => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'workbench-file-identity-'));
  const project=path.join(dir,'project'), source=path.join(project,'src'), replacement=path.join(dir,'replacement');
  try {
    await fs.mkdir(source,{recursive:true}); await fs.mkdir(replacement);
    await fs.writeFile(path.join(source,'file.txt'),'project data');
    await fs.writeFile(path.join(replacement,'file.txt'),'OUTSIDE PRIVATE MARKER');
    const open=fs.open.bind(fs); let swapped=false;
    t.mock.method(fs,'open',async (...args:Parameters<typeof fs.open>)=>{
      if(!swapped) {
        swapped=true;
        await fs.rename(source,path.join(project,'original-src'));
        await fs.rename(replacement,source);
      }
      return open(...args);
    });
    await assert.rejects(readProjectFile(project,'src/file.txt'),/发生变化/);
    assert.equal(swapped,true);
  } finally { t.mock.restoreAll(); await fs.rm(dir,{recursive:true,force:true}); }
});

test('preview withholds bytes when the opened ancestor moves outside the project during the read', {skip:process.platform==='win32'}, async t => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'workbench-file-after-read-'));
  const project=path.join(dir,'project'), source=path.join(project,'src');
  try {
    await fs.mkdir(source,{recursive:true}); await fs.writeFile(path.join(source,'file.txt'),'must be withheld after relocation');
    const open=fs.open.bind(fs); let moved=false;
    t.mock.method(fs,'open',async (...args:Parameters<typeof fs.open>)=>{
      const handle=await open(...args);
      if(String(args[0]).endsWith('/file.txt')) {
        const read=handle.read.bind(handle);
        t.mock.method(handle,'read',async (...readArgs:Parameters<typeof handle.read>)=>{
          const result=await read(...readArgs);
          await fs.rename(source,path.join(dir,'moved-outside'));
          await fs.symlink(path.join(dir,'moved-outside'),source,'dir');
          moved=true; return result;
        });
      }
      return handle;
    });
    await assert.rejects(readProjectFile(project,'src/file.txt'),/发生变化/);
    assert.equal(moved,true);
  } finally { t.mock.restoreAll(); await fs.rm(dir,{recursive:true,force:true}); }
});
