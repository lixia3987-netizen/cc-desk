import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { StateStore } from '../src/main/store';
import { SubtaskTracker } from '../src/main/subtask-tracker';
import { isSubtaskActive, subtaskCounts, SUBTASK_LIMIT } from '../src/shared/subtasks';

function fixture() {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cc-desk-subtasks-'));
  const store=new StateStore(directory),id=randomUUID(),projectId=randomUUID(),now=new Date().toISOString();
  store.change(state=>state.sessions.push({id,projectId,title:'任务测试',kind:'claude',adapter:'structured',cwd:directory,claudeId:randomUUID(),started:false,model:'',effort:'default',permissionMode:'default',status:'idle',archived:false,createdAt:now,updatedAt:now}));
  let notifications=0;
  const tracker=new SubtaskTracker(store,()=>notifications++);
  return {directory,store,id,tracker,get activity(){return store.state.sessions[0].subtasks!;},get notifications(){return notifications;},dispose(){store.flush();fs.rmSync(directory,{recursive:true,force:true});}};
}

test('tool and task lifecycle aliases coalesce independently of arrival order and duplicate events',()=>{
  for(const reverse of [false,true]) {
    const f=fixture();try {
      f.tracker.begin(f.id,'turn');
      const tool={source:'stream' as const,toolUseId:'call',status:'pending' as const,kind:'agent' as const,description:'Review code',phase:'start' as const};
      const task={source:'stream' as const,taskId:'background',status:'running' as const,kind:'agent' as const,description:'Review code',progress:'Reading files',phase:'start' as const};
      for(const event of reverse?[task,tool]:[tool,task])f.tracker.observe(f.id,event);
      assert.equal(f.activity.tasks.length,2);
      f.tracker.observe(f.id,{source:'stream',taskId:'background',toolUseId:'call',status:'running',phase:'progress',toolUses:3});
      assert.equal(f.activity.tasks.length,1);
      assert.equal(f.activity.tasks[0].progress,'Reading files');
      assert.equal(f.activity.tasks[0].toolUses,3);
      f.tracker.observe(f.id,tool);
      assert.equal(f.activity.tasks[0].status,'running');
      const notifications=f.notifications;
      f.tracker.observe(f.id,{source:'stream',taskId:'background',toolUseId:'call',status:'running',phase:'progress',toolUses:3});
      assert.equal(f.notifications,notifications);
      assert.deepEqual(subtaskCounts(f.activity.tasks),{total:1,active:1,completed:0,failed:0,stopped:0,unknown:0});
    }finally{f.dispose();}
  }
});

test('terminal results cannot regress on delayed starts/progress; matching completion enriches reported metrics',()=>{
  const f=fixture();try {
    f.tracker.begin(f.id,'turn');
    f.tracker.observe(f.id,{source:'stream',taskId:'a',status:'completed',summary:'review finished',phase:'finish'});
    const endedAt=f.activity.tasks[0].endedAt;
    f.tracker.observe(f.id,{source:'stream',taskId:'a',status:'running',progress:'stale',phase:'start'});
    f.tracker.observe(f.id,{source:'stream',taskId:'a',status:'running',progress:'also stale',phase:'progress'});
    f.tracker.observe(f.id,{source:'stream',taskId:'a',status:'completed',totalTokens:800,toolUses:5,phase:'finish'});
    assert.equal(f.activity.tasks[0].status,'completed');
    assert.equal(f.activity.tasks[0].progress,undefined);
    assert.equal(f.activity.tasks[0].totalTokens,800);
    assert.equal(f.activity.tasks[0].endedAt,endedAt);
    f.tracker.observe(f.id,{source:'stream',taskId:'a',status:'completed',totalTokens:50,toolUses:1,phase:'finish'});
    assert.equal(f.activity.tasks[0].toolUses,5);
    f.tracker.end(f.id,'interrupted','stopped by user');
    assert.equal(f.activity.tasks[0].status,'completed');
  }finally{f.dispose();}
});

test('agent result identities match sparse task events without merging distinct resumed invocations',()=>{
  const f=fixture();try {
    f.tracker.begin(f.id,'turn');
    f.tracker.observe(f.id,{source:'stream',kind:'agent',toolUseId:'first-call',status:'pending',phase:'start'});
    f.tracker.observe(f.id,{source:'stream',kind:'agent',toolUseId:'first-call',agentId:'agent',status:'running',phase:'progress'});
    f.tracker.observe(f.id,{source:'stream',taskId:'agent',status:'running',phase:'start'});
    assert.equal(f.activity.tasks.length,1);
    f.tracker.observe(f.id,{source:'stream',taskId:'agent',status:'completed',phase:'finish'});
    f.tracker.observe(f.id,{source:'stream',kind:'agent',toolUseId:'second-call',status:'pending',phase:'start'});
    f.tracker.observe(f.id,{source:'stream',kind:'agent',toolUseId:'second-call',agentId:'agent',status:'running',phase:'progress'});
    assert.equal(f.activity.tasks.length,2);
    assert.equal(f.activity.tasks[0].status,'completed');
    assert.equal(f.activity.tasks[1].status,'running');
    f.tracker.observe(f.id,{source:'stream',taskId:'agent',status:'running',phase:'start'});
    assert.equal(f.activity.tasks.length,2);
    f.tracker.observe(f.id,{source:'stream',taskId:'agent',status:'failed',phase:'finish'});
    assert.deepEqual(f.activity.tasks.map(task=>task.status),['completed','failed']);
  }finally{f.dispose();}
});

test('an explicit old-turn event cannot settle a newer invocation that reused the same agent ID',()=>{
  const f=fixture();try {
    f.tracker.begin(f.id,'new-turn');
    f.tracker.observe(f.id,{source:'hooks',agentId:'agent',turnId:'new-turn',status:'running',phase:'start'});
    f.tracker.observe(f.id,{source:'hooks',agentId:'agent',turnId:'old-turn',status:'completed',phase:'finish'});
    assert.equal(f.activity.tasks.find(task=>task.turnId==='new-turn')!.status,'running');
    assert.equal(f.activity.tasks.find(task=>task.turnId==='old-turn')!.status,'completed');
  }finally{f.dispose();}
});

test('new turns preserve older live tasks and late completions keep their originating turn',()=>{
  const f=fixture();try {
    f.tracker.begin(f.id,'first');
    f.tracker.observe(f.id,{source:'stream',taskId:'old',status:'running',phase:'start'});
    f.tracker.begin(f.id,'second');
    f.tracker.observe(f.id,{source:'stream',taskId:'new',status:'paused',phase:'start'});
    f.tracker.observe(f.id,{source:'stream',taskId:'old',status:'completed',phase:'finish'});
    assert.equal(f.activity.tasks.find(task=>task.taskId==='old')!.turnId,'first');
    assert.equal(f.activity.turnId,'second');
    f.tracker.end(f.id,'unknown','No completion event');
    assert.equal(f.activity.tasks.find(task=>task.taskId==='new')!.status,'unknown');
    f.tracker.observe(f.id,{source:'stream',taskId:'new',status:'completed',phase:'finish'});
    assert.equal(f.activity.tasks.find(task=>task.taskId==='new')!.status,'completed');
    f.tracker.begin(f.id,'third');
    f.tracker.observe(f.id,{source:'stream',taskId:'new',status:'running',phase:'start'});
    assert.equal(f.activity.tasks.length,3);
    assert.equal(f.activity.tasks.at(-1)!.turnId,'third');
  }finally{f.dispose();}
});

test('task persistence keeps finished states and cold-start marks unfinished work interrupted once',()=>{
  const f=fixture();try {
    f.tracker.begin(f.id,'turn');
    for(const [taskId,status] of [['a','completed'],['b','running'],['c','waiting_approval'],['d','failed']] as const)f.tracker.observe(f.id,{source:'hooks',agentId:taskId,status,phase:status==='completed'||status==='failed'?'finish':'start'});
    f.store.flush();
    const restored=new StateStore(f.directory);
    const tasks=restored.state.sessions[0].subtasks!.tasks;
    assert.deepEqual(tasks.map(task=>task.status),['completed','interrupted','interrupted','failed']);
    assert.equal(tasks.some(task=>isSubtaskActive(task.status)),false);
    assert.deepEqual(subtaskCounts(tasks),{total:4,active:0,completed:1,failed:1,stopped:2,unknown:0});
    restored.flush();
    assert.deepEqual(new StateStore(f.directory).state.sessions[0].subtasks!.tasks,tasks);
  }finally{f.dispose();}
});

test('bounded history evicts finished records first and declares incomplete counts without losing live tasks',()=>{
  const f=fixture();try {
    f.tracker.begin(f.id,'turn');
    f.tracker.observe(f.id,{source:'stream',taskId:'live',status:'running',phase:'start'});
    for(let i=0;i<SUBTASK_LIMIT;i++)f.tracker.observe(f.id,{source:'stream',taskId:'done-'+i,status:'completed',phase:'finish'});
    assert.equal(f.activity.tasks.length,SUBTASK_LIMIT);
    assert.equal(f.activity.truncated,true);
    assert.equal(f.activity.tasks[0].taskId,'live');
    assert.equal(f.activity.tasks.some(task=>task.taskId==='done-0'),false);
    f.tracker.end(f.id,'interrupted');
    assert.equal(f.activity.tasks.some(task=>isSubtaskActive(task.status)),false);
  }finally{f.dispose();}
});

test('untrusted task metadata is bounded, invalid identities are ignored and separate sources do not merge',()=>{
  const f=fixture();try {
    f.tracker.begin(f.id,'turn');
    for(const taskId of ['', 'x'.repeat(201),'control\0'])assert.equal(f.tracker.observe(f.id,{source:'stream',taskId,status:'running'}),undefined);
    f.tracker.observe(f.id,{source:'stream',taskId:'same',status:'running',description:'d'.repeat(1000),progress:'p'.repeat(5000),durationMs:Infinity,totalTokens:-5});
    f.tracker.observe(f.id,{source:'hooks',agentId:'same',status:'running'});
    assert.equal(f.activity.tasks.length,2);
    assert.equal(f.activity.tasks[0].description.length,500);
    assert.equal(f.activity.tasks[0].progress!.length,2000);
    assert.equal(f.activity.tasks[0].durationMs,undefined);
    assert.equal(f.activity.tasks[0].totalTokens,undefined);
  }finally{f.dispose();}
});
