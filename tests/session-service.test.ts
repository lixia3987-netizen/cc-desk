import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { BrowserWindow } from 'electron';
import { SessionService } from '../src/main/session-service';
import { StateStore } from '../src/main/store';
import { Attachments } from '../src/main/attachments';
import type { Runtime } from '../src/main/runtime';
import { createWorktree, worktreeInfo } from '../src/main/git';
import { execFileAsync } from '../src/main/commands';
import type { Capabilities, Session } from '../src/shared/types';
import type { WorktreeInfo } from '../src/shared/git';
import type { EnvironmentDiagnostics } from '../src/shared/diagnostics';
import { emptyGitReviewDraft, emptyWorkflowDraft } from '../src/shared/panel-drafts';

async function fixture(window:BrowserWindow|null=null) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'workbench-service-'));
  const repo=path.join(dir,'repo'); await fs.mkdir(repo);
  const git=async (...args:string[]) => execFileAsync('git',args,{cwd:repo});
  await git('init','-b','main'); await git('config','user.name','Tests'); await git('config','user.email','test@example.invalid');
  await fs.writeFile(path.join(repo,'initial.txt'),'initial\n'); await git('add','.'); await git('commit','-m','Initial');
  await fs.mkdir(path.join(repo,'src')); await fs.mkdir(path.join(repo,'other'));
  const store=new StateStore(path.join(dir,'data'));
  const projectId=randomUUID(), now=new Date().toISOString();
  store.change(s=>{s.projects.push({id:projectId,path:repo,name:'Test',createdAt:now});s.settings.claudePath=path.join(dir,'unavailable-claude');});
  const active=new Set<string>();
  const runtime={
    getSession:(id:string)=>{const session=store.state.sessions.find(s=>s.id===id);if(!session)throw new Error('Session missing');return session;},
    has:(id:string)=>active.has(id),start:async(id:string)=>{active.add(id);},stop:(id:string)=>{active.delete(id);},
    forget:(id:string)=>{active.delete(id);},shutdown:async()=>{active.clear();},get activeCount(){return active.size;}
  } as unknown as Runtime;
  const caps:Capabilities={available:false,executable:'',version:'',flags:[],efforts:[]};
  const service=new SessionService(store,runtime,()=>caps,()=>{},()=>window);
  const handlers=new Map<string,(input:unknown)=>unknown>();
  service.register(<T>(name:string,schema:z.ZodType<T>,action:(input:T)=>unknown)=>handlers.set(name,input=>action(schema.parse(input))));
  const call=async<T>(name:string,input:unknown):Promise<T> => await handlers.get(name)!(input) as T;
  const add=(cwd:string, extra:Partial<Session>={})=>{
    const session:Session={id:randomUUID(),projectId,title:'Test',cwd,kind:'shell',adapter:'terminal',claudeId:randomUUID(),started:false,
      model:'',effort:'default',permissionMode:'default',status:'idle',archived:false,createdAt:now,updatedAt:now,...extra};
    store.change(s=>s.sessions.push(session));return session;
  };
  return {dir,repo,store,service,runtime,active,add,call,dispose:async()=>{await service.shutdown();store.flush();await fs.rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});}};
}

test('panel drafts merge independent sections, survive restart and disappear with the owning session',async()=>{
  const f=await fixture();try{
    const a=f.add(f.repo,{kind:'claude',adapter:'structured',draft:'main draft'}),b=f.add(f.repo);
    const workflow={...emptyWorkflowDraft(),goal:'next task',editing:'run:plan',instructions:{'run:plan':'unsaved instruction'},maxAttempts:3};
    const git={...emptyGitReviewDraft(),selected:'one.txt',staged:true,feedback:{'one.txt':'first review','two.txt':'second review'}};
    await f.call('session:panel-drafts',{id:a.id,patch:{workflow}});
    await f.call('session:panel-drafts',{id:a.id,patch:{git}});
    await f.call('session:panel-drafts',{id:b.id,patch:{workflow:{...emptyWorkflowDraft(),goal:'other session'}}});
    await f.call('session:panel-drafts',{id:a.id,patch:{workflow:{...workflow,goal:'newest goal'}}});
    f.store.flush();
    const restored=new StateStore(f.store.directory).state;
    assert.deepEqual(restored.sessions.find(session=>session.id===a.id)!.panelDrafts,{workflow:{...workflow,goal:'newest goal'},git});
    assert.equal(restored.sessions.find(session=>session.id===a.id)!.draft,'main draft');
    assert.equal(restored.sessions.find(session=>session.id===b.id)!.panelDrafts?.workflow?.goal,'other session');
    await f.call('session:delete',a.id);
    await assert.rejects(f.call('session:panel-drafts',{id:a.id,patch:{git}}),/Session missing/);
    assert.equal(new StateStore(f.store.directory).state.sessions.some(session=>session.id===a.id),false);
  }finally{await f.dispose();}
});

test('invalid panel drafts are rejected without replacing the last valid user input',async()=>{
  const f=await fixture();try{
    const session=f.add(f.repo),workflow={...emptyWorkflowDraft(),goal:'keep me'};
    await f.call('session:panel-drafts',{id:session.id,patch:{workflow}});
    const before=structuredClone(f.store.state);
    for(const patch of [{workflow:{...workflow,goal:'x'.repeat(20001)}},{workflow:{...workflow,maxAttempts:4}},
      {git:{...emptyGitReviewDraft(),feedback:{'one.txt':'x'.repeat(60001)}}},
      {git:{...emptyGitReviewDraft(),feedback:Object.fromEntries(Array.from({length:201},(_,i)=>[String(i),'draft']))}}]){
      await assert.rejects(f.call('session:panel-drafts',{id:session.id,patch}));
      assert.deepEqual(f.store.state,before);
    }
  }finally{await f.dispose();}
});

test('cleanup preserves a worktree referenced as another worktree source', async()=>{
  const f=await fixture();try {
    const idA=randomUUID(), treeA=await createWorktree(f.repo,f.dir,idA);
    const a=f.add(treeA,{id:idA,worktree:treeA,worktreeBase:f.repo});
    const idB=randomUUID(), treeB=await createWorktree(treeA,f.dir,idB);
    const b=f.add(treeB,{id:idB,worktree:treeB,worktreeBase:treeA});
    assert.equal((await f.call<WorktreeInfo>('worktree:info',a.id)).canCleanup,false);
    await assert.rejects(f.call('worktree:cleanup',a.id),/来源依赖/);
    assert.equal((await worktreeInfo(treeA,treeB,b.id)).owned,true);
    assert.equal((await f.call<{ok:boolean}>('worktree:cleanup',b.id)).ok,true);
    assert.equal((await f.call<{ok:boolean}>('worktree:cleanup',a.id)).ok,true);
  }finally{await f.dispose();}
});

test('busy checks cover source and target subdirectories but permit independent linked worktrees', async()=>{
  const f=await fixture();try {
    const id=randomUUID(), source=path.join(f.repo,'src'), tree=await createWorktree(source,f.dir,id);
    const target=f.add(tree,{id,worktree:tree,worktreeBase:source});
    const sourceSibling=f.add(path.join(f.repo,'other'));
    f.active.add(sourceSibling.id);
    await assert.rejects(f.call('worktree:merge',target.id),/全部会话/);
    f.active.clear();
    await fs.mkdir(path.join(tree,'child')); const nested=f.add(path.join(tree,'child'));
    f.active.add(nested.id);
    await assert.rejects(f.call('worktree:merge',target.id),/全部会话/);
    f.active.clear();
    const otherId=randomUUID(), otherTree=await createWorktree(f.repo,f.dir,otherId);
    const unrelated=f.add(otherTree,{id:otherId,worktree:otherTree,worktreeBase:f.repo});f.active.add(unrelated.id);
    assert.equal((await f.call<{ok:boolean}>('worktree:merge',target.id)).ok,true);
    await assert.rejects(f.call('worktree:cleanup',target.id),/工作目录.*依赖/);
  }finally{await f.dispose();}
});

test('canonical containment locks prevent new admissions and dependency registration during management', async()=>{
  const f=await fixture();try {
    const child=f.add(path.join(f.repo,'other'));
    let release!:()=>void, entered!:()=>void;
    const ready=new Promise<void>(resolve=>{entered=resolve;});
    const held=f.service.withSessionCreation(path.join(f.repo,'src'),true,async()=>{entered();await new Promise<void>(resolve=>{release=resolve;});});
    await ready;
    try {
      await assert.rejects(f.service.start(child.id),/管理操作/);
      await assert.rejects(f.service.withSessionCreation(path.join(f.repo,'other'),false,async()=>{}),/管理操作/);
      if(process.platform!=='win32') {
        const alias=path.join(f.dir,'alias');await fs.symlink(f.repo,alias,'dir');
        const aliased=f.add(path.join(alias,'other'));
        await assert.rejects(f.service.start(aliased.id),/管理操作/);
      }
    }finally{release();await held;}
    await f.service.start(child.id);assert.equal(f.active.has(child.id),true);
  }finally{await f.dispose();}
});

test('session diagnostics inspect the actual worktree and session deletion purges its inactive workflows', async()=>{
  const f=await fixture();try {
    const id=randomUUID(), tree=await createWorktree(f.repo,f.dir,id);
    const session=f.add(tree,{id,kind:'claude',adapter:'structured',worktree:tree,worktreeBase:f.repo});
    await fs.writeFile(path.join(tree,'.mcp.json'),JSON.stringify({mcpServers:{'worktree-only':{command:'fixture'}}}));
    const diagnostics=await f.call<EnvironmentDiagnostics>('cli:diagnostics',session.id);
    assert.equal(diagnostics.cwd,tree);
    assert.ok(diagnostics.mcp.some(entry=>entry.name==='worktree-only'));
    assert.ok(diagnostics.configs.some(entry=>entry.path===path.join(tree,'.mcp.json')));
    const plain=f.add(f.repo,{kind:'claude',adapter:'structured'});
    f.service.workflows.create({sessionId:plain.id,goal:'Retained draft'});
    await f.call('session:delete',plain.id);
    assert.equal(f.service.workflows.list(plain.id).length,0);
    assert.equal(f.store.state.sessions.some(s=>s.id===plain.id),false);
  }finally{await f.dispose();}
});

test('failed turns keep attachment drafts and successful turns clear them without deleting referenced bytes', async t=>{
  const f=await fixture();try {
    const session=f.add(f.repo,{kind:'claude',adapter:'structured'});
    const attachments=(f.service as unknown as {attachments:Attachments}).attachments;
    const source=path.join(f.dir,'context.txt');await fs.writeFile(source,'context');
    const [attachment]=await attachments.add(session.id,[source]);
    let succeeded=false;
    t.mock.method(f.service.chat,'send',async()=>({success:succeeded,summary:'',error:succeeded?undefined:'startup failed'}));
    await f.call('chat:send',{id:session.id,text:'test',attachments:[attachment.path]});
    assert.equal((await attachments.list(session.id)).length,1);
    succeeded=true;
    await f.call('chat:send',{id:session.id,text:'test',attachments:[attachment.path]});
    assert.equal((await attachments.list(session.id)).length,0);
    assert.equal(await fs.readFile(attachment.path,'utf8'),'context');
  }finally{t.mock.restoreAll();await f.dispose();}
});

test('attachment bookkeeping failure reports completed execution without repeating the turn', async t=>{
  const f=await fixture();try {
    const session=f.add(f.repo,{kind:'claude',adapter:'structured'});
    const attachments=(f.service as unknown as {attachments:Attachments}).attachments;
    const source=path.join(f.dir,'context.txt');await fs.writeFile(source,'context');
    const [attachment]=await attachments.add(session.id,[source]);
    let sends=0;
    t.mock.method(f.service.chat,'send',async()=>{sends++;return {success:true,summary:'done'};});
    t.mock.method(attachments,'markSent',async()=>{throw new Error('disk full');});
    await assert.rejects(f.call('chat:send',{id:session.id,text:'test',attachments:[attachment.path]}),/本轮任务已完成.*请勿重复执行/);
    assert.equal(sends,1);
    assert.equal(await fs.readFile(attachment.path,'utf8'),'context');
    assert.equal((await attachments.list(session.id)).length,1);
  }finally{t.mock.restoreAll();await f.dispose();}
});

test('shutdown attempts both runtimes after persistence failures and permits a successful retry', async t=>{
  const f=await fixture();try {
    const workflowsShutdown=f.service.workflows.shutdown.bind(f.service.workflows);
    const chatShutdown=f.service.chat.shutdown.bind(f.service.chat);
    const runtimeShutdown=f.runtime.shutdown.bind(f.runtime);
    let workflowCalls=0,chatCalls=0,runtimeCalls=0;
    t.mock.method(f.service.workflows,'shutdown',async()=>{if(++workflowCalls===1)throw new Error('workflow disk error');await workflowsShutdown();});
    t.mock.method(f.service.chat,'shutdown',async()=>{if(++chatCalls===1)throw new Error('chat disk error');await chatShutdown();});
    t.mock.method(f.runtime,'shutdown',async()=>{runtimeCalls++;await runtimeShutdown();});
    await assert.rejects(f.service.shutdown(),/workflow disk error\nchat disk error/);
    assert.deepEqual([workflowCalls,chatCalls,runtimeCalls],[1,1,1]);
    await f.service.shutdown();
    assert.deepEqual([workflowCalls,chatCalls,runtimeCalls],[2,2,2]);
  }finally{t.mock.restoreAll();await f.dispose();}
});

test('notification navigation emits intent even for the selected session and ignores destroyed windows', async()=>{
  const events:[string,string][]=[];
  let destroyed=false,minimized=true,shown=0,focused=0,restored=0;
  const window={
    isDestroyed:()=>destroyed,isMinimized:()=>minimized,
    restore:()=>{restored++;minimized=false;},show:()=>{shown++;},focus:()=>{focused++;},
    webContents:{isDestroyed:()=>destroyed,send:(channel:string,id:string)=>events.push([channel,id])},
  } as unknown as BrowserWindow;
  const f=await fixture(window);try {
    const session=f.add(f.repo);
    f.service.select(session.id);
    const navigate=(id:string)=>(f.service as unknown as {navigateFromNotification(id:string):void}).navigateFromNotification(id);
    navigate(session.id);navigate(session.id);
    assert.deepEqual(events,[['session:navigate',session.id],['session:navigate',session.id]]);
    assert.deepEqual([shown,focused,restored],[2,2,1]);
    destroyed=true;
    assert.doesNotThrow(()=>navigate(session.id));
    assert.equal(events.length,2);
    destroyed=false;
    navigate(randomUUID());
    assert.equal(events.length,2);
  }finally{await f.dispose();}
});

test('conversation history IPC validates message cursors and restricts reads to structured sessions',async()=>{
  const f=await fixture();try{
    const structured=f.add(f.repo,{kind:'claude',adapter:'structured'}),terminal=f.add(f.repo);
    await assert.rejects(f.call('chat:page',{id:terminal.id}),/图形化/);
    await assert.rejects(f.call('chat:search',{id:terminal.id,query:'test'}),/图形化/);
    for(const options of [{before:'one',after:'two'},{around:'x'.repeat(4097)},{query:'x'.repeat(501)}])await assert.rejects(f.call('chat:page',{id:structured.id,...options}));
    await assert.rejects(f.call('chat:search',{id:structured.id,query:' '}));
    const page=await f.call<{messages:unknown[]}>('chat:page',{id:structured.id});assert.deepEqual(page.messages,[]);
    assert.deepEqual(await f.call('chat:attention',undefined),[]);
  }finally{await f.dispose();}
});
