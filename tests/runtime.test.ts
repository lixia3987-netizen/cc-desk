import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { Runtime } from '../src/main/runtime';
import { StateStore } from '../src/main/store';
import type { Session } from '../src/shared/types';
import { createWorktree, gitInfo } from '../src/main/git';
import { execFileAsync } from '../src/main/commands';

async function until(check:()=>boolean) {const deadline=Date.now()+7000;while(!check()){if(Date.now()>deadline)throw new Error('Timed out waiting for PTY');await new Promise(resolve=>setTimeout(resolve,25));}}
test('real PTY supports Unicode/spaces, isolated output, input, resize, concurrency and stopping',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'workbench-pty-'));const cwd=path.join(root,'项目 space & quote');fs.mkdirSync(cwd);
  const store=new StateStore(path.join(root,'data'));const projectId=randomUUID();
  const create=():Session=>({id:randomUUID(),projectId,title:'shell',kind:'shell',cwd,claudeId:randomUUID(),started:false,model:'',effort:'default',permissionMode:'default',status:'idle',archived:false,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
  const a=create(),b=create();store.change(s=>{s.sessions=[a,b];s.settings.maxSessions=1;});
  const output=new Map<string,string>();const runtime=new Runtime(store,()=>{},chunk=>output.set(chunk.sessionId,(output.get(chunk.sessionId)||'')+chunk.data));
  const cap={available:false,executable:'',version:'',flags:[],efforts:['default' as const]};
  try {
    await runtime.start(a.id,cap);
    await assert.rejects(runtime.start(b.id,cap),/并发会话上限/);
    runtime.resize(a.id,120,40);
    const command=process.platform==='win32'?"Write-Output '中文输入完成'; (Get-Location).Path\r":"printf '\\n中文输入完成\\n'; pwd\r";
    runtime.write(a.id,command);
    await until(()=>output.get(a.id)?.includes(cwd)===true && output.get(a.id)?.includes('中文输入完成')===true);
    assert.equal(output.has(b.id),false);
    const snapshot=runtime.snapshot(a.id);assert.ok(snapshot.chunks.length>0);
    runtime.stop(a.id);await until(()=>runtime.activeCount===0);
    assert.equal(store.state.sessions[0].status,'stopped');
    await runtime.start(b.id,cap);assert.equal(store.state.sessions[1].status,'running');
  }finally{await runtime.shutdown();fs.rmSync(root,{recursive:true,force:true});}
});
test('worktree creates an independent branch and preserves the original working tree',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'workbench-git-'));const cwd=path.join(root,'repo space');fs.mkdirSync(cwd);
  const git=(args:string[])=>execFileAsync('git',args,{cwd});
  try{
    await git(['init']);await git(['config','user.name','Workbench Test']);await git(['config','user.email','test@example.invalid']);
    fs.writeFileSync(path.join(cwd,'code.txt'),'base');await git(['add','.']);await git(['commit','-m','initial']);
    fs.writeFileSync(path.join(cwd,'code.txt'),'uncommitted');
    const worktree=await createWorktree(cwd,root,randomUUID());
    assert.equal(fs.readFileSync(path.join(worktree,'code.txt'),'utf8'),'base');
    assert.equal(fs.readFileSync(path.join(cwd,'code.txt'),'utf8'),'uncommitted');
    const info=await gitInfo(worktree);assert.match(info.branch,/^workbench\//);assert.equal(info.status,'');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
