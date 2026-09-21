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
