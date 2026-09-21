import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Attachments } from '../src/main/attachments';

test('attachments are copied, isolated by session, bounded and reject path substitution', async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'workbench-attachments-'));
  try {
    const source=path.join(root,'项目.txt'); await fs.writeFile(source,'approved contents');
    const manager=new Attachments(path.join(root,'data'));
    const [selected]=await manager.add('session-a',[source]);
    assert.notEqual(selected.path,source); assert.equal(selected.name,'项目.txt');
    await fs.writeFile(source,'changed elsewhere');
    assert.equal(await fs.readFile(selected.path,'utf8'),'approved contents');
    assert.deepEqual(await manager.validate('session-a',[selected.path]),[selected.path]);
    await assert.rejects(manager.validate('session-b',[selected.path]),/不属于/);
    await assert.rejects(manager.validate('session-a',[source]),/不属于/);
    const big=path.join(root,'big.txt');const handle=await fs.open(big,'w');await handle.truncate(9*1024*1024);await handle.close();
    await assert.rejects(manager.add('session-a',[big]),/8 MiB/);
    if(process.platform!=='win32') {await fs.rm(selected.path);await fs.symlink(source,selected.path);await assert.rejects(manager.validate('session-a',[selected.path]),/变更/);}
    await manager.remove('session-a');await assert.rejects(manager.validate('session-a',[selected.path]),/不属于/);
  } finally {await fs.rm(root,{recursive:true,force:true});}
});

test('draft attachments recover names after restart, removed drafts are freed and sent references survive',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'attachment-lifecycle-'));
  try {
    const source=path.join(root,'原始名字.txt');await fs.writeFile(source,'retained bytes');
    const directory=path.join(root,'data'), first=new Attachments(directory);
    const [draft,sent]=await first.add('session',[source,source]);
    await first.retain('session',[sent.path]);
    await first.markSent('session',[sent.path]);
    const restarted=new Attachments(directory);
    assert.deepEqual(await restarted.list('session'),[draft]);
    assert.deepEqual(await restarted.validate('session',[sent.path]),[sent.path]);
    await restarted.removeFile('session',sent.path);
    await restarted.removeFile('session',draft.path);
    await assert.rejects(fs.stat(draft.path),{code:'ENOENT'});
    assert.equal(await fs.readFile(sent.path,'utf8'),'retained bytes');
    assert.deepEqual(await new Attachments(directory).list('session'),[]);
  } finally {await fs.rm(root,{recursive:true,force:true});}
});

test('startup collects only unreferenced new staging files and preserves unknown legacy files',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'attachment-gc-'));
  try {
    const folder=path.join(root,'attachments','session');await fs.mkdir(folder,{recursive:true});
    const orphan=path.join(folder,'.staged-11111111-1111-1111-1111-111111111111.txt');
    const legacy=path.join(folder,'22222222-2222-2222-2222-222222222222.txt');
    await fs.writeFile(orphan,'incomplete selection');await fs.writeFile(legacy,'possibly referenced');
    assert.deepEqual(await new Attachments(root).list('session'),[]);
    await assert.rejects(fs.stat(orphan),{code:'ENOENT'});
    assert.equal(await fs.readFile(legacy,'utf8'),'possibly referenced');
    await fs.writeFile(path.join(folder,'attachments.json'),'{broken');
    await fs.writeFile(orphan,'preserve on corrupt metadata');
    await assert.rejects(new Attachments(root).list('session'),/清单/);
    assert.equal(await fs.readFile(orphan,'utf8'),'preserve on corrupt metadata');
  } finally {await fs.rm(root,{recursive:true,force:true});}
});

test('retaining and removing a draft serialize so a sent file cannot disappear',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'attachment-race-'));
  try {
    const source=path.join(root,'picked.txt');await fs.writeFile(source,'data');
    const manager=new Attachments(root), [file]=await manager.add('session',[source]);
    const result=await Promise.allSettled([manager.retain('session',[file.path]),manager.removeFile('session',file.path)]);
    assert.equal(result[0].status,'fulfilled');assert.equal(result[1].status,'fulfilled');
    assert.equal(await fs.readFile(file.path,'utf8'),'data');
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('failed dispatch keeps retained attachments visible and removable without deleting possible transcript references',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'attachment-failed-send-'));
  try {
    const source=path.join(root,'retry.txt');await fs.writeFile(source,'retry bytes');
    const manager=new Attachments(root), [file]=await manager.add('session',[source]);
    await manager.retain('session',[file.path]); // CLI startup fails before markSent.
    const restarted=new Attachments(root);assert.deepEqual(await restarted.list('session'),[file]);
    await restarted.removeFile('session',file.path);
    assert.deepEqual(await new Attachments(root).list('session'),[]);
    assert.equal(await fs.readFile(file.path,'utf8'),'retry bytes');
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
