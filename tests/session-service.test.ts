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
import type { TerminalExecutor } from '../src/main/execution/ports';
import { ExecutionRegistry } from '../src/main/execution/registry';
import { ClaudeStructuredExecutor } from '../src/main/engines/claude/structured-executor';
import { claudeCapabilities } from '../src/main/engines/claude/capabilities';
import { queryHistory } from '../src/main/history';
import { diagnoseEnvironment } from '../src/main/diagnostics';
import { createWorktree, worktreeInfo } from '../src/main/git';
import { execFileAsync } from '../src/main/commands';
import type { Capabilities, Session } from '../src/shared/types';
import type { WorktreeInfo } from '../src/shared/git';
import type { EnvironmentDiagnostics } from '../src/shared/diagnostics';
import { emptyGitReviewDraft, emptyWorkflowDraft } from '../src/shared/panel-drafts';
import type { ChatSnapshot, ChatSubmission, ChatTurnResult } from '../src/shared/chat';

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
    forget:(id:string)=>{active.delete(id);},shutdown:async()=>{active.clear();},get activeCount(){return active.size;},
    setMaintenance:(_value:boolean)=>{},disconnectAll:async()=>{active.clear();}
  } as unknown as TerminalExecutor;
  const caps:Capabilities={available:false,executable:'',version:'',flags:[],efforts:[]};
  const registry=new ExecutionRegistry(id=>{const s=store.state.sessions.find(s=>s.id===id);if(!s)throw new Error('Session missing');return s;});
  const chat=new ClaudeStructuredExecutor(store,()=>caps,registry.events);
  registry.register({providerId:'claude',mode:'structured',executor:chat,capabilities:()=>claudeCapabilities(caps,'structured')});
  const terminalCapabilities=()=>({...claudeCapabilities(caps,'terminal'),available:true});
  registry.register({providerId:'claude',mode:'terminal',executor:runtime,capabilities:terminalCapabilities});
  registry.register({providerId:'shell',mode:'terminal',executor:runtime,capabilities:terminalCapabilities});
  const service=new SessionService(store,registry,()=>{},()=>window,{history:queryHistory,diagnose:cwd=>diagnoseEnvironment(cwd,store.state.settings.claudePath)});
  const handlers=new Map<string,(input:unknown)=>unknown>();
  service.register(<T>(name:string,schema:z.ZodType<T>,action:(input:T)=>unknown)=>handlers.set(name,input=>action(schema.parse(input))));
  const call=async<T>(name:string,input:unknown):Promise<T> => await handlers.get(name)!(input) as T;
  const add=(cwd:string, extra:Partial<Session>={})=>{
    const session:Session={id:randomUUID(),projectId,title:'Test',cwd,kind:'shell',execution:{providerId:'shell',mode:'terminal'},started:false,
      model:'',effort:'default',permissionMode:'default',status:'idle',archived:false,createdAt:now,updatedAt:now,...extra};
    store.change(s=>s.sessions.push(session));return session;
  };
  return {dir,repo,store,service,runtime,chat,active,add,call,dispose:async()=>{await service.shutdown();store.flush();await fs.rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});}};
}

test('CLI update waits for disconnection, blocks new work and keeps every workspace available afterward', async t => {
  const f = await fixture();
  let release!: () => void, finish!: () => void;
  const stopped = new Promise<void>(resolve => { release = resolve; });
  const installing = new Promise<void>(resolve => { finish = resolve; });
  let invoked = false;
  try {
    const shell = f.add(f.repo), other = f.add(f.repo, { kind:'agent',execution:{providerId:'claude',mode:'structured',conversationId:randomUUID()} });
    await f.service.start(shell.id);
    t.mock.method(f.runtime, 'disconnectAll', async () => { await stopped; f.active.clear(); });
    const update = f.service.withDisconnectedWorkspaces(async () => { invoked = true; assert.equal(f.active.size, 0); await installing; });
    await assert.rejects(f.service.start(shell.id), /正在更新/);
    await assert.rejects(f.call('chat:commands', other.id), /正在更新/);
    await assert.rejects(f.call('chat:send', { id: other.id, text: 'new work' }), /正在更新/);
    assert.throws(() => f.service.workflows.create({ sessionId: other.id, goal: 'new workflow', pauseAfterEachStage: false, maxAttempts: 2 }), /正在更新/);
    assert.equal(invoked, false); release();
    while (!invoked) await new Promise(resolve => setTimeout(resolve, 5));
    await assert.rejects(f.service.start(shell.id), /正在更新/); finish(); await update;
    assert.equal(f.store.state.sessions.length, 2); assert.equal(f.store.state.projects.length, 1);
    await f.service.start(shell.id); assert.equal(f.active.size, 1);
  } finally { release?.(); finish?.(); await f.dispose(); }
});
test('disconnection and persistence failures abort the update but still stop independent runners', async t => {
  const f = await fixture();
  try {
    let terminals = 0, chats = 0, installed = 0;
    t.mock.method(f.service.workflows, 'disconnectAll', async () => { throw new Error('disk fault'); });
    t.mock.method(f.chat, 'disconnectAll', async () => { chats++; });
    t.mock.method(f.runtime, 'disconnectAll', async () => { terminals++; });
    await assert.rejects(f.service.withDisconnectedWorkspaces(async () => { installed++; }), /已取消更新/);
    assert.equal(terminals, 1); assert.equal(chats, 1); assert.equal(installed, 0);
    const session = f.add(f.repo); await f.service.start(session.id); assert.equal(f.active.size, 1);
  } finally { await f.dispose(); }
});
test('worktree creation releases completed structured CLIs under directory locks before invoking Git',async t=>{
  const f=await fixture();try{
    const session=f.add(f.repo,{kind:'agent',execution:{providerId:'claude',mode:'structured',conversationId:randomUUID()},status:'running',taskState:'completed'});
    const physical=new Set([session.id]);let release!:()=>void,entered!:()=>void,created=false;
    const ready=new Promise<void>(resolve=>{entered=resolve;});
    t.mock.method(f.service.chat,'has',(id:string)=>physical.has(id));
    t.mock.method(f.service.chat,'isBusy',()=>false);
    t.mock.method(f.service.chat,'stopIdle',async(id:string)=>{entered();await new Promise<void>(resolve=>{release=resolve;});physical.delete(id);});
    const creation=f.service.withSessionCreation(f.repo,true,async()=>{assert.equal(physical.size,0);created=true;});
    await Promise.race([ready,creation]);
    assert.equal(created,false);
    await assert.rejects(f.call('chat:send',{id:session.id,text:'cannot race directory mutation'}),/管理操作/);
    await assert.rejects(f.service.withSessionCreation(f.repo,false,async()=>{}),/管理操作/);
    release();await creation;
    assert.equal(created,true);assert.equal(f.store.state.sessions[0].taskState,'completed');
  }finally{t.mock.restoreAll();await f.dispose();}
});

test('worktree operations refuse real structured tasks, workflows, and terminal ownership',async t=>{
  const f=await fixture();try{
    const session=f.add(f.repo,{kind:'agent',execution:{providerId:'claude',mode:'structured',conversationId:randomUUID()},status:'running',taskState:'completed'});
    let busy=true,workflow=false,stops=0,created=false;
    t.mock.method(f.service.chat,'has',()=>true);
    t.mock.method(f.service.chat,'isBusy',()=>busy);
    t.mock.method(f.service.chat,'stopIdle',async()=>{stops++;});
    t.mock.method(f.service.workflows,'isSessionBusy',()=>workflow);
    const attempt=()=>f.service.withSessionCreation(f.repo,true,async()=>{created=true;});
    await assert.rejects(attempt(),/全部会话/);
    busy=false;workflow=true;await assert.rejects(attempt(),/全部会话/);
    workflow=false;f.active.add(session.id);await assert.rejects(attempt(),/全部会话/);
    assert.equal(created,false);assert.equal(stops,0);
    // A synced native terminal can be idle while still holding cwd and having
    // unreported background shell commands, so give a precise close-terminal hint.
    f.store.change(state=>{state.sessions[0].execution.mode='terminal';state.sessions[0].terminalSync='synced';});
    await assert.rejects(attempt(),/原生 Claude 终端仍打开.*关闭终端/);
    assert.equal(stops,0);
  }finally{t.mock.restoreAll();await f.dispose();}
});

test('idle-release failures keep Git unmodified and release management locks for a retry',async t=>{
  const f=await fixture();try{
    f.add(f.repo,{kind:'agent',execution:{providerId:'claude',mode:'structured',conversationId:randomUUID()},status:'running',taskState:'completed'});
    let physical=true,fail=true,created=false;
    t.mock.method(f.service.chat,'has',()=>physical);
    t.mock.method(f.service.chat,'isBusy',()=>false);
    t.mock.method(f.service.chat,'stopIdle',async()=>{if(fail)throw new Error('CLI 尚未停止');physical=false;});
    await assert.rejects(f.service.withSessionCreation(f.repo,true,async()=>{created=true;}),/CLI 尚未停止/);
    assert.equal(created,false);fail=false;
    await f.service.withSessionCreation(f.repo,true,async()=>{created=true;});assert.equal(created,true);
  }finally{t.mock.restoreAll();await f.dispose();}
});

test('idle structured sessions can archive and delete while active tasks retain their records',async t=>{
  const f=await fixture();try{
    const archived=f.add(f.repo,{kind:'agent',execution:{providerId:'claude',mode:'structured',conversationId:randomUUID()},status:'running',taskState:'completed'});
    const deleted=f.add(f.repo,{kind:'agent',execution:{providerId:'claude',mode:'structured',conversationId:randomUUID()},status:'running',taskState:'completed'});
    const physical=new Set([archived.id,deleted.id]);let busy=false;
    t.mock.method(f.service.chat,'has',(id:string)=>physical.has(id));
    t.mock.method(f.service.chat,'isBusy',()=>busy);
    t.mock.method(f.service.chat,'stopIdle',async(id:string)=>{physical.delete(id);});
    await f.call('session:update',{id:archived.id,archived:true,title:'手动归档标题'});
    assert.equal(f.store.state.sessions.find(s=>s.id===archived.id)?.archived,true);
    assert.equal(f.store.state.sessions.find(s=>s.id===archived.id)?.titleSource,'manual');
    assert.equal(f.store.state.sessions.find(s=>s.id===archived.id)?.taskState,'completed');
    assert.equal(physical.has(archived.id),false);
    busy=true;await assert.rejects(f.call('session:delete',deleted.id),/停止会话/);
    assert.equal(physical.has(deleted.id),true);
    busy=false;await f.call('session:delete',deleted.id);
    assert.equal(physical.size,0);assert.equal(f.store.state.sessions.some(s=>s.id===deleted.id),false);
    await f.call('session:update',{id:archived.id,archived:false,title:'配置时手动标题',model:'selected-model'});
    assert.equal(f.store.state.sessions[0].titleSource,'manual');assert.equal(f.store.state.sessions[0].model,'selected-model');
  }finally{t.mock.restoreAll();await f.dispose();}
});

test('concurrency limits reclaim idle structured processes and never evict live tasks',async t=>{
  const f=await fixture();try{
    const idle=f.add(f.repo,{kind:'agent',execution:{providerId:'claude',mode:'structured',conversationId:randomUUID()},status:'running',taskState:'completed'}),next=f.add(f.repo);
    f.store.change(state=>{state.settings.maxSessions=1;});
    const physical=new Set([idle.id]);let busy=true;
    t.mock.method(f.service.chat,'has',(id:string)=>physical.has(id));
    t.mock.method(f.service.chat,'isBusy',(id:string)=>physical.has(id)&&busy);
    t.mock.method(f.service.chat,'stopIdle',async(id:string)=>{physical.delete(id);});
    await assert.rejects(f.service.start(next.id),/最大并发/);
    assert.equal(physical.has(idle.id),true);
    busy=false;await f.service.start(next.id);
    assert.equal(physical.has(idle.id),false);assert.equal(f.active.has(next.id),true);
    assert.equal(f.store.state.sessions.find(s=>s.id===idle.id)?.taskState,'completed');
  }finally{t.mock.restoreAll();await f.dispose();}
});

test('slot reclamation rechecks native conversation ownership after asynchronous release',async t=>{
  const f=await fixture();try{
    const first=f.add(f.repo,{kind:'agent',execution:{providerId:'claude',mode:'structured',conversationId:randomUUID()},updatedAt:'2020-01-01T00:00:00.000Z'});
    const second=f.add(f.repo,{kind:'agent',execution:{providerId:'claude',mode:'structured',conversationId:randomUUID()},updatedAt:'2021-01-01T00:00:00.000Z'});
    const a=f.add(f.repo,{kind:'agent',execution:{providerId:'claude',mode:'terminal',conversationId:randomUUID()}}),b=f.add(f.repo,{kind:'agent',execution:{providerId:'claude',mode:'terminal',conversationId:a.execution.conversationId}});
    f.store.change(state=>{state.settings.maxSessions=2;});
    const physical=new Set([first.id,second.id]);let entered!:()=>void,release!:()=>void;
    const ready=new Promise<void>(resolve=>{entered=resolve;});
    t.mock.method(f.service.chat,'has',(id:string)=>physical.has(id));
    t.mock.method(f.service.chat,'isBusy',()=>false);
    t.mock.method(f.service.chat,'stopIdle',async(id:string)=>{physical.delete(id);entered();await new Promise<void>(resolve=>{release=resolve;});});
    const pending=f.service.start(a.id);
    await Promise.race([ready,pending]);
    // Another caller claims the native transcript while A is waiting on a slot.
    await f.service.start(b.id);
    release();await assert.rejects(pending,/同一提供方的对话/);
    assert.equal(f.active.has(a.id),false);assert.equal(f.active.has(b.id),true);
    assert.equal(physical.has(second.id),true,'identity conflicts must not evict another idle session');
  }finally{t.mock.restoreAll();await f.dispose();}
});

test('archiving a queued session during idle eviction prevents its pending prompt from starting',async t=>{
  const f=await fixture();try{
    const idle=f.add(f.repo,{kind:'agent',execution:{providerId:'claude',mode:'structured',conversationId:randomUUID()},status:'running',taskState:'completed'});
    const target=f.add(f.repo,{kind:'agent',execution:{providerId:'claude',mode:'structured',conversationId:randomUUID()}});
    f.store.change(state=>{state.settings.maxSessions=1;});
    const physical=new Set([idle.id]);let entered!:()=>void,release!:()=>void,sent=0;
    const ready=new Promise<void>(resolve=>{entered=resolve;});
    t.mock.method(f.service.chat,'has',(id:string)=>physical.has(id));
    t.mock.method(f.service.chat,'isBusy',()=>false);
    t.mock.method(f.service.chat,'stopIdle',async(id:string)=>{
      if(id!==idle.id)return;
      entered();await new Promise<void>(resolve=>{release=resolve;});physical.delete(id);
    });
    t.mock.method(f.service.chat,'send',async()=>{sent++;return {success:true,summary:'done'};});
    const pending=f.call('chat:send',{id:target.id,text:'queued task'});
    await Promise.race([ready,pending]);
    await f.call('session:update',{id:target.id,archived:true});
    release();await assert.rejects(pending,/取消会话归档/);assert.equal(sent,0);
    await f.call('session:update',{id:target.id,archived:false});
    await f.call('chat:send',{id:target.id,text:'explicitly resumed'});assert.equal(sent,1);
  }finally{t.mock.restoreAll();await f.dispose();}
});

test('workflow turns explicitly pass their user goal for naming without modifying stage instructions',async t=>{
  const f=await fixture();try{
    const session=f.add(f.repo,{kind:'agent',execution:{providerId:'claude',mode:'structured',conversationId:randomUUID()},titleSource:'default'});
    const requests:{text:string;titlePrompt?:string}[]=[];
    t.mock.method(f.service.chat,'send',async(_id:string,text:string,_attachments?:string[],titlePrompt?:string)=>{
      requests.push({text,titlePrompt});return {success:true,summary:'done'};
    });
    const run=f.service.workflows.create({sessionId:session.id,goal:'修复登录状态恢复',stages:[{id:'inspect',title:'检查',instruction:'仅检查实现',dependsOn:[]}]});
    f.service.workflows.start(run.id);assert.equal((await f.service.workflows.wait(run.id)).status,'completed');
    assert.equal(requests.length,1);assert.equal(requests[0].titlePrompt,'修复登录状态恢复');
    assert.match(requests[0].text,/仅检查实现/);assert.notEqual(requests[0].text,requests[0].titlePrompt);
  }finally{t.mock.restoreAll();await f.dispose();}
});

test('panel drafts merge independent sections, survive restart and disappear with the owning session',async()=>{
  const f=await fixture();try{
    const a=f.add(f.repo,{kind:'agent',execution:{providerId:'claude',mode:'structured',conversationId:randomUUID()},draft:'main draft'}),b=f.add(f.repo);
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
    // The active Git panel refreshes after cleanup, when both source and target may be gone.
    const removed=await f.call<WorktreeInfo>('worktree:info',b.id);
    assert.equal(removed.owned,false);
    assert.equal(removed.canMerge,false);
    assert.equal(removed.canCleanup,false);
    const changes=await f.call<{available:boolean;error:string}>('git:changes',b.id);
    assert.equal(changes.available,false);
    assert.match(changes.error,/工作目录已清理/);
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

test('fork creation reserves source and destination project roots until the dependent session is saved',async()=>{
  const f=await fixture();try{
    const sourceId=randomUUID(),sourceTree=await createWorktree(f.repo,f.dir,sourceId);
    const source=f.add(sourceTree,{id:sourceId,worktree:sourceTree,worktreeBase:f.repo});
    const projectSession=f.add(path.join(f.repo,'other'));
    const otherId=randomUUID(),otherTree=await createWorktree(f.repo,f.dir,otherId);
    const other=f.add(otherTree,{id:otherId,worktree:otherTree,worktreeBase:f.repo});
    const childId=randomUUID();
    let entered!:()=>void,release!:()=>void;
    const ready=new Promise<void>(resolve=>{entered=resolve;});
    const pendingSave=new Promise<void>(resolve=>{release=resolve;});
    const held=f.service.withSessionCreation(sourceTree,true,async()=>{
      const childTree=await createWorktree(sourceTree,f.dir,childId);
      entered();await pendingSave;
      return f.add(childTree,{id:childId,worktree:childTree,worktreeBase:sourceTree});
    },path.join(f.repo,'src'));
    // If creation rejects before entering the callback, fail instead of waiting forever.
    await Promise.race([ready,held]);
    try{
      assert.equal(f.store.state.sessions.some(session=>session.id===childId),false);
      await assert.rejects(f.service.start(source.id),/管理操作/);
      await assert.rejects(f.service.start(projectSession.id),/管理操作/);
      await assert.rejects(f.call('worktree:cleanup',other.id),/管理操作/);
      await assert.rejects(f.service.withSessionCreation(path.join(f.repo,'other'),false,async()=>{}),/管理操作/);
    }finally{release();await held;}
    assert.equal(f.store.state.sessions.find(session=>session.id===childId)?.worktreeBase,sourceTree);
    await assert.rejects(f.call('worktree:cleanup',source.id),/来源依赖/);
    await f.service.start(projectSession.id);
    assert.equal(f.active.has(projectSession.id),true);
  }finally{await f.dispose();}
});

test('fork creation refuses a busy destination project before running the creation action',async()=>{
  const f=await fixture();try{
    const sourceId=randomUUID(),sourceTree=await createWorktree(f.repo,f.dir,sourceId);
    const source=f.add(sourceTree,{id:sourceId,worktree:sourceTree,worktreeBase:f.repo});
    const projectSession=f.add(path.join(f.repo,'other'));
    await f.service.start(projectSession.id);
    let entered=false;
    await assert.rejects(f.service.withSessionCreation(sourceTree,true,async()=>{entered=true;},path.join(f.repo,'src')),/全部会话/);
    assert.equal(entered,false);
    // A rejected reservation must not retain the otherwise idle source lock.
    await f.service.start(source.id);
    assert.equal(f.active.has(source.id),true);
    await f.service.stop(source.id);await f.service.stop(projectSession.id);
    await f.service.withSessionCreation(sourceTree,true,async()=>{entered=true;},f.repo);
    assert.equal(entered,true);
  }finally{await f.dispose();}
});

test('failed fork registration releases both source and destination project reservations',async()=>{
  const f=await fixture();try{
    const sourceId=randomUUID(),sourceTree=await createWorktree(f.repo,f.dir,sourceId);
    const source=f.add(sourceTree,{id:sourceId,worktree:sourceTree,worktreeBase:f.repo});
    const projectSession=f.add(path.join(f.repo,'other'));
    const failedSave=new Error('session save failed');
    await assert.rejects(f.service.withSessionCreation(sourceTree,true,async()=>{throw failedSave;},f.repo),error=>error===failedSave);
    await f.service.start(source.id);await f.service.start(projectSession.id);
    assert.equal(f.active.has(source.id),true);assert.equal(f.active.has(projectSession.id),true);
    await f.service.stop(source.id);await f.service.stop(projectSession.id);
    let retried=false;
    await f.service.withSessionCreation(sourceTree,true,async()=>{retried=true;},f.repo);
    assert.equal(retried,true);
  }finally{await f.dispose();}
});

test('session diagnostics inspect the actual worktree and session deletion purges its inactive workflows', async()=>{
  const f=await fixture();try {
    const id=randomUUID(), tree=await createWorktree(f.repo,f.dir,id);
    const session=f.add(tree,{id,kind:'agent',execution:{providerId:'claude',mode:'structured',conversationId:randomUUID()},worktree:tree,worktreeBase:f.repo});
    await fs.writeFile(path.join(tree,'.mcp.json'),JSON.stringify({mcpServers:{'worktree-only':{command:'fixture'}}}));
    const diagnostics=await f.call<EnvironmentDiagnostics>('cli:diagnostics',session.id);
    assert.equal(diagnostics.cwd,tree);
    assert.ok(diagnostics.mcp.some(entry=>entry.name==='worktree-only'));
    assert.ok(diagnostics.configs.some(entry=>entry.path===path.join(tree,'.mcp.json')));
    const plain=f.add(f.repo,{kind:'agent',execution:{providerId:'claude',mode:'structured',conversationId:randomUUID()}});
    f.service.workflows.create({sessionId:plain.id,goal:'Retained draft'});
    await f.call('session:delete',plain.id);
    assert.equal(f.service.workflows.list(plain.id).length,0);
    assert.equal(f.store.state.sessions.some(s=>s.id===plain.id),false);
  }finally{await f.dispose();}
});

test('failed turns keep attachment drafts and successful turns clear them without deleting referenced bytes', async t=>{
  const f=await fixture();try {
    const session=f.add(f.repo,{kind:'agent',execution:{providerId:'claude',mode:'structured',conversationId:randomUUID()}});
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
    const session=f.add(f.repo,{kind:'agent',execution:{providerId:'claude',mode:'structured',conversationId:randomUUID()}});
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
    const chatShutdown=f.chat.shutdown.bind(f.chat);
    const runtimeShutdown=f.runtime.shutdown.bind(f.runtime);
    let workflowCalls=0,chatCalls=0,runtimeCalls=0;
    t.mock.method(f.service.workflows,'shutdown',async()=>{if(++workflowCalls===1)throw new Error('workflow disk error');await workflowsShutdown();});
    t.mock.method(f.chat,'shutdown',async()=>{if(++chatCalls===1)throw new Error('chat disk error');await chatShutdown();});
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
    const structured=f.add(f.repo,{kind:'agent',execution:{providerId:'claude',mode:'structured',conversationId:randomUUID()}}),terminal=f.add(f.repo);
    await assert.rejects(f.call('chat:page',{id:terminal.id}),/图形化/);
    await assert.rejects(f.call('chat:search',{id:terminal.id,query:'test'}),/图形化/);
    for(const options of [{before:'one',after:'two'},{around:'x'.repeat(4097)},{query:'x'.repeat(501)}])await assert.rejects(f.call('chat:page',{id:structured.id,...options}));
    await assert.rejects(f.call('chat:search',{id:structured.id,query:' '}));
    const page=await f.call<{messages:unknown[]}>('chat:page',{id:structured.id});assert.deepEqual(page.messages,[]);
    assert.deepEqual(await f.call('chat:attention',undefined),[]);
  }finally{await f.dispose();}
});

async function until(predicate:()=>boolean) {
  const deadline=Date.now()+3000;
  while(!predicate()&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(predicate(),true,'condition did not become true');
}

test('submission IPC acknowledges durable ownership and detaches attachment drafts before a turn finishes',async t=>{
  const f=await fixture();let finish!: (result:ChatTurnResult)=>void;
  try {
    const session=f.add(f.repo,{kind:'agent',execution:{providerId:'claude',mode:'structured',conversationId:randomUUID()}});
    const attachments=(f.service as unknown as {attachments:Attachments}).attachments;
    const source=path.join(f.dir,'queue-context.txt');await fs.writeFile(source,'queued context');
    const [attachment]=await attachments.add(session.id,[source]);
    let sends=0;
    t.mock.method(f.service.chat,'send',async()=>{sends++;return new Promise<ChatTurnResult>(resolve=>{finish=resolve;});});
    const requestId=randomUUID();
    const accepted=await f.call<ChatSubmission>('chat:submit',{id:session.id,text:'first',attachments:[attachment.path],requestId});
    assert.equal(typeof accepted.messageId,'string');
    assert.deepEqual(await f.call('files:attachments',session.id),[]);
    assert.equal(await fs.readFile(attachment.path,'utf8'),'queued context');
    await assert.rejects(f.call('files:remove-attachment',{id:session.id,path:attachment.path}),/正在被排队或执行/);
    assert.deepEqual(await f.call('chat:submit',{id:session.id,text:'first',attachments:[attachment.path],requestId}),accepted);
    await until(()=>sends===1);
    const snapshot=await f.call<ChatSnapshot>('chat:snapshot',session.id);
    assert.equal(snapshot.queue?.items[0].status,'sending');
    assert.deepEqual(snapshot.queue?.items[0].attachmentNames,['queue-context.txt']);
    finish({success:true,summary:'done'});await until(()=>!f.service.queue.hasActive(session.id));
    assert.equal(sends,1);assert.equal(f.service.queue.snapshot(session.id).items.length,0);
  } finally {finish?.({success:true,summary:''});t.mock.restoreAll();await f.dispose();}
});

test('stop cancels a queue admission awaiting attachment IO without dispatching the accepted prompt later',async t=>{
  const f=await fixture();let release!:()=>void;
  try {
    const session=f.add(f.repo,{kind:'agent',execution:{providerId:'claude',mode:'structured',conversationId:randomUUID()}});
    const attachments=(f.service as unknown as {attachments:Attachments}).attachments;
    let pending=false,sends=0;
    t.mock.method(attachments,'retain',async()=>{pending=true;await new Promise<void>(resolve=>{release=resolve;});});
    t.mock.method(f.service.chat,'send',async()=>{sends++;return {success:true,summary:''};});
    await f.call('chat:submit',{id:session.id,text:'must remain queued'});
    await until(()=>pending);await f.service.stop(session.id);release();
    await until(()=>!f.service.queue.hasActive(session.id));
    assert.equal(sends,0);
    const queue=f.service.queue.snapshot(session.id);assert.equal(queue.paused,true);assert.equal(queue.items[0].status,'queued');
  } finally {release?.();t.mock.restoreAll();await f.dispose();}
});

test('a queue persistence error does not prevent explicit runtime stop or interruption',async t=>{
  const f=await fixture();try {
    const session=f.add(f.repo,{kind:'agent',execution:{providerId:'claude',mode:'structured',conversationId:randomUUID()}});
    let stopped=0,interrupted=0;
    t.mock.method(f.service.queue,'pause',()=>{throw new Error('queue disk error');});
    t.mock.method(f.service.chat,'stop',async()=>{stopped++;});
    t.mock.method(f.service.chat,'interrupt',async()=>{interrupted++;});
    await assert.rejects(f.service.stop(session.id),/queue disk error/);
    await assert.rejects(f.service.interrupt(session.id),/queue disk error/);
    assert.deepEqual([stopped,interrupted],[1,1]);
  } finally {t.mock.restoreAll();await f.dispose();}
});

test('workflow cancellation invalidates a stage admission before it can become a model request',async t=>{
  const f=await fixture();let release!:()=>void;
  try {
    const session=f.add(f.repo,{kind:'agent',execution:{providerId:'claude',mode:'structured',conversationId:randomUUID()}});
    const attachments=(f.service as unknown as {attachments:Attachments}).attachments;
    let pending=false,sends=0;
    t.mock.method(attachments,'retain',async()=>{pending=true;await new Promise<void>(resolve=>{release=resolve;});});
    t.mock.method(f.service.chat,'send',async()=>{sends++;return {success:true,summary:''};});
    const run=f.service.workflows.create({sessionId:session.id,goal:'cancel pending stage',stages:[{id:'one',title:'one',instruction:'one',dependsOn:[]}]});
    f.service.workflows.start(run.id);await until(()=>pending);
    await f.call('workflow:cancel',run.id);release();await f.service.workflows.wait(run.id);
    assert.equal(sends,0);assert.equal(f.service.workflows.isSessionBusy(session.id),false);
  } finally {release?.();t.mock.restoreAll();await f.dispose();}
});
