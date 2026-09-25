import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkflowEngine } from '../src/main/workflows';
import type { WorkflowStorage } from '../src/main/workflow-storage';
import type { WorkflowBinding, WorkflowStageDefinition, WorkflowStageResult } from '../src/shared/workflows';

const steps: WorkflowStageDefinition[] = [
  { id: 'plan', title: 'Plan', instruction: 'Read first', dependsOn: [] },
  { id: 'build', title: 'Build', instruction: 'Implement safely', dependsOn: ['plan'] },
  { id: 'review', title: 'Review', instruction: 'Review changes', dependsOn: ['build'] },
];
const makeBinding = (): WorkflowBinding => ({
  sessionId: randomUUID(), providerId: 'claude', executionMode: 'structured',
  projectId: randomUUID(), cwd: '/tmp/workflow-project',
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const temporary = () => fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-workflow-'));

test('workflow follows real result completion and topological dependencies, persisting stage artifacts', async () => {
  const directory = temporary();
  try {
    const binding = makeBinding();
    const pending = deferred<WorkflowStageResult>();
    const calls: string[] = [];
    const engine = new WorkflowEngine(directory, {
      getSession: () => binding, cancelSession: () => {},
      runStage: async (_sessionId, prompt) => {
        calls.push(prompt);
        if (calls.length === 1) return pending.promise;
        return { success: true, summary: `artifact-${calls.length}` };
      },
    });
    // Definitions need not be supplied in execution order.
    const run = engine.create({ sessionId: binding.sessionId, goal: 'Ship feature', stages: [steps[2], steps[1], steps[0]] });
    engine.start(run.id);
    await tick();
    assert.equal(calls.length, 1);
    assert.match(calls[0], /Read first/);
    assert.equal(engine.list()[0].stages.find(stage => stage.id === 'plan')!.status, 'running');
    assert.equal(engine.list()[0].stages.find(stage => stage.id === 'build')!.status, 'pending');
    pending.resolve({ success: true, summary: 'plan evidence' });
    const finished = await engine.wait(run.id);
    assert.equal(finished.status, 'completed');
    assert.equal(calls.length, 3);
    assert.match(calls[1], /plan evidence/);
    assert.match(calls[2], /artifact-2/);
    assert.ok(finished.stages.every(stage => stage.attempts === 1));
    const saved = JSON.parse(fs.readFileSync(engine.file, 'utf8'));
    assert.equal(saved.runs[0].status, 'completed');
    assert.equal(saved.runs[0].stages.find((stage: { id: string }) => stage.id === 'plan').artifacts[0].content, 'plan evidence');
    assert.equal(engine.isSessionBusy(binding.sessionId), false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('failure stops downstream stages and retries require an explicit bounded action', async () => {
  const directory = temporary();
  try {
    const binding = makeBinding();
    let calls = 0;
    const engine = new WorkflowEngine(directory, {
      getSession: () => binding, cancelSession: () => {},
      runStage: async () => { calls++; return { success: false, summary: 'partial edit already exists', error: 'command failed' }; },
    });
    const run = engine.create({ sessionId: binding.sessionId, goal: 'Fix bug', stages: steps, maxAttempts: 2 });
    engine.start(run.id);
    let finished = await engine.wait(run.id);
    assert.equal(finished.status, 'failed');
    assert.equal(calls, 1);
    assert.equal(finished.stages[1].status, 'pending');
    assert.throws(() => engine.start(run.id), /重试/);
    engine.reviseStage(run.id, 'plan', 'Inspect partial changes before retry');
    engine.retry(run.id);
    finished = await engine.wait(run.id);
    assert.equal(calls, 2);
    assert.equal(finished.stages[0].attempts, 2);
    assert.equal(finished.stages[0].artifacts.length, 2);
    assert.throws(() => engine.retry(run.id), /上限/);
    engine.reviseStage(run.id, 'plan', 'Cannot reset attempts through editing');
    assert.throws(() => engine.retry(run.id), /上限/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('cancel wins over a late successful result and session ownership lasts until the runner settles', async () => {
  const directory = temporary();
  try {
    const binding = makeBinding();
    const pending = deferred<WorkflowStageResult>();
    let calls = 0, cancellations = 0;
    const engine = new WorkflowEngine(directory, {
      getSession: () => binding,
      cancelSession: () => { cancellations++; },
      runStage: async () => { calls++; return pending.promise; },
    });
    const first = engine.create({ sessionId: binding.sessionId, goal: 'First', stages: steps });
    const second = engine.create({ sessionId: binding.sessionId, goal: 'Second', stages: [steps[0]] });
    engine.start(first.id);
    await tick();
    assert.throws(() => engine.start(second.id), /运行或停止中/);
    await engine.cancel(first.id);
    assert.equal(cancellations, 1);
    assert.equal(engine.isSessionBusy(binding.sessionId), true);
    assert.throws(() => engine.start(second.id), /运行或停止中/);
    pending.resolve({ success: true, summary: 'late result' });
    const stopped = await engine.wait(first.id);
    assert.equal(stopped.status, 'cancelled');
    assert.equal(stopped.stages[0].status, 'cancelled');
    assert.equal(stopped.stages[0].artifacts.length, 0);
    assert.equal(calls, 1);
    assert.equal(engine.isSessionBusy(binding.sessionId), false);
    engine.start(second.id);
    assert.equal((await engine.wait(second.id)).status, 'completed');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('manual stage gates continue without repeating completed work', async () => {
  const directory = temporary();
  try {
    const binding = makeBinding();
    const calls: string[] = [];
    const engine = new WorkflowEngine(directory, {
      getSession: () => binding, cancelSession: () => {},
      runStage: async (_sessionId, prompt) => { calls.push(prompt); return { success: true, summary: 'done' }; },
    });
    const run = engine.create({ sessionId: binding.sessionId, goal: 'Gated task', stages: steps, pauseAfterEachStage: true });
    engine.start(run.id);
    assert.equal((await engine.wait(run.id)).status, 'paused');
    assert.equal(calls.length, 1);
    assert.throws(() => engine.reviseStage(run.id, 'plan', 'Changed'), /尚未完成/);
    engine.continue(run.id);
    assert.equal((await engine.wait(run.id)).status, 'paused');
    engine.continue(run.id);
    const done = await engine.wait(run.id);
    assert.equal(done.status, 'completed');
    assert.equal(calls.length, 3);
    assert.deepEqual(done.stages.map(stage => stage.attempts), [1, 1, 1]);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('restart marks active work interrupted and requires manual continuation before dispatch', async () => {
  const directory = temporary();
  const recoveryDirectory = temporary();
  try {
    const binding = makeBinding();
    const pending = deferred<WorkflowStageResult>();
    const original = new WorkflowEngine(directory, {
      getSession: () => binding, cancelSession: () => {}, runStage: async () => pending.promise,
    });
    const run = original.create({ sessionId: binding.sessionId, goal: 'Recover', stages: [steps[0]] });
    original.start(run.id);
    await tick();
    fs.copyFileSync(original.file, path.join(recoveryDirectory, 'workflows.json'));
    let calls = 0;
    const restored = new WorkflowEngine(recoveryDirectory, {
      getSession: () => binding, cancelSession: () => {},
      runStage: async (_sessionId, prompt) => { calls++; assert.match(prompt, /避免重复具有副作用/); return { success: true, summary: 'recovered' }; },
    });
    assert.equal(restored.list()[0].status, 'interrupted');
    assert.equal(restored.list()[0].stages[0].status, 'interrupted');
    await tick();
    assert.equal(calls, 0);
    restored.continue(run.id);
    const done = await restored.wait(run.id);
    assert.equal(done.status, 'completed');
    assert.equal(done.stages[0].attempts, 2);
    assert.equal(calls, 1);
    await original.cancel(run.id);
    pending.resolve({ success: false, summary: '' });
    await original.wait(run.id);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
    fs.rmSync(recoveryDirectory, { recursive: true, force: true });
  }
});

test('invalid graph and tampered storage are rejected without replacing original data', () => {
  const directory = temporary();
  try {
    const binding = makeBinding();
    const options = { getSession: () => binding, cancelSession: () => {}, runStage: async () => ({ success: true, summary: '' }) };
    const engine = new WorkflowEngine(directory, options);
    assert.throws(() => engine.create({ sessionId: binding.sessionId, goal: 'Cycle', stages: [
      { ...steps[0], dependsOn: ['build'] }, steps[1],
    ] }), /成环/);
    assert.throws(() => engine.create({ sessionId: binding.sessionId, goal: 'Missing dependency', stages: [steps[1]] }), /不存在/);
    assert.throws(() => engine.create({ sessionId: binding.sessionId, goal: 'Duplicate', stages: [steps[0], steps[0]] }), /重复/);
    assert.equal(engine.list().length, 0);
    engine.create({ sessionId: binding.sessionId, goal: 'Good' });
    fs.writeFileSync(engine.file, '{bad');
    assert.throws(() => new WorkflowEngine(directory, options), /原文件已保留/);
    assert.equal(fs.readFileSync(engine.file, 'utf8'), '{bad');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('changing a bound working directory interrupts before the next stage can execute', async () => {
  const directory = temporary();
  try {
    const binding = makeBinding();
    let calls = 0;
    const engine = new WorkflowEngine(directory, {
      getSession: () => binding, cancelSession: () => {},
      runStage: async () => { calls++; binding.cwd = '/different/project'; return { success: true, summary: 'done' }; },
    });
    const run = engine.create({ sessionId: binding.sessionId, goal: 'Stay in project', stages: steps });
    engine.start(run.id);
    const interrupted = await engine.wait(run.id);
    assert.equal(interrupted.status, 'interrupted');
    assert.match(interrupted.error!, /工作目录已改变/);
    assert.equal(calls, 1);
    assert.equal(interrupted.stages[1].attempts, 0);
    assert.throws(() => engine.continue(run.id), /工作目录已改变/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('changing a bound provider blocks continuation before another executor can receive a stage', async () => {
  const directory = temporary();
  try {
    const binding = makeBinding();
    let calls = 0;
    const engine = new WorkflowEngine(directory, {
      getSession: () => binding, cancelSession: () => {},
      runStage: async () => { calls++; return { success: true, summary: 'planned' }; },
    });
    const run = engine.create({ sessionId: binding.sessionId, goal: 'Keep executor binding', stages: steps, pauseAfterEachStage: true });
    engine.start(run.id);
    assert.equal((await engine.wait(run.id)).status, 'paused');
    binding.providerId = 'another-agent';
    assert.throws(() => engine.continue(run.id), /执行后端或执行模式已改变/);
    assert.equal(calls, 1);
    assert.equal(engine.list()[0].stages[1].attempts, 0);
    assert.equal(engine.list()[0].providerId, 'claude');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('a non-Claude structured executor receives stages and cancellation through the same workflow port', async () => {
  const directory = temporary();
  try {
    const binding = { ...makeBinding(), providerId: 'fake-agent' };
    const pending = deferred<WorkflowStageResult>();
    const stageSessions: string[] = [], cancelled: string[] = [];
    const engine = new WorkflowEngine(directory, {
      getSession: () => binding,
      runStage: async id => { stageSessions.push(id); return pending.promise; },
      cancelSession: id => { cancelled.push(id); pending.resolve({ success: true, summary: 'late result' }); },
    });
    const run = engine.create({ sessionId: binding.sessionId, goal: 'Use a declared structured executor', stages: steps });
    assert.equal(run.providerId, 'fake-agent');
    assert.equal(run.executionMode, 'structured');
    engine.start(run.id);
    await tick();
    await engine.cancel(run.id);
    const cancelledRun = await engine.wait(run.id);
    assert.equal(cancelledRun.status, 'cancelled');
    assert.deepEqual(stageSessions, [binding.sessionId]);
    assert.deepEqual(cancelled, [binding.sessionId]);
    assert.equal(cancelledRun.stages[1].attempts, 0);
    const stored = JSON.parse(fs.readFileSync(engine.file, 'utf8')).runs[0];
    assert.equal(stored.providerId, 'fake-agent');
    assert.equal(stored.executionMode, 'structured');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('legacy v1 workflow records acquire the Claude structured binding on load and keep it when saved', async () => {
  const directory = temporary();
  try {
    const binding = makeBinding();
    let calls = 0;
    const options = {
      getSession: () => binding, cancelSession: () => {},
      runStage: async () => { calls++; return { success: true, summary: 'completed' }; },
    };
    const original = new WorkflowEngine(directory, options);
    const run = original.create({ sessionId: binding.sessionId, goal: 'Legacy workflow', stages: [steps[0]] });
    const legacy = JSON.parse(fs.readFileSync(original.file, 'utf8'));
    delete legacy.runs[0].providerId;
    delete legacy.runs[0].executionMode;
    fs.writeFileSync(original.file, JSON.stringify(legacy));
    const restored = new WorkflowEngine(directory, options);
    assert.equal(restored.list()[0].providerId, 'claude');
    assert.equal(restored.list()[0].executionMode, 'structured');
    assert.equal(calls, 0);
    restored.start(run.id);
    assert.equal((await restored.wait(run.id)).status, 'completed');
    const stored = JSON.parse(fs.readFileSync(restored.file, 'utf8')).runs[0];
    assert.equal(stored.providerId, 'claude');
    assert.equal(stored.executionMode, 'structured');
    assert.equal(calls, 1);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('CLI update interrupts workflows without dispatching late stages and allows manual continuation', async () => {
  const directory = temporary();
  try {
    const binding = makeBinding(), pending = deferred<WorkflowStageResult>(); let first = true;
    const engine = new WorkflowEngine(directory, { getSession: () => binding,
      cancelSession: () => { pending.resolve({ success: true, summary: 'late result after update' }); },
      runStage: async () => { if (first) { first = false; return pending.promise; } return { success: true, summary: 'manual continuation' }; },
    });
    const run = engine.create({ sessionId: binding.sessionId, goal: 'Update', stages: steps });
    engine.start(run.id); await tick(); await engine.disconnectAll();
    const interrupted = await engine.wait(run.id);
    assert.equal(interrupted.status, 'interrupted'); assert.equal(interrupted.stages[1].attempts, 0);
    engine.continue(run.id); assert.equal((await engine.wait(run.id)).status, 'completed');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
test('session maintenance drains only selected workflows while another provider advances', async () => {
  const directory = temporary(), target = makeBinding(), other = { ...makeBinding(), providerId: 'native' };
  const targetStarted = deferred<void>(), otherStarted = deferred<void>(), cancellation = deferred<void>();
  const targetResult = deferred<WorkflowStageResult>(), otherResult = deferred<WorkflowStageResult>();
  const calls = new Map<string, number>(), cancelled: string[] = [];
  const engine = new WorkflowEngine(directory, {
    getSession: id => id === target.sessionId ? target : other,
    cancelSession: id => { cancelled.push(id); cancellation.resolve(); },
    runStage: async id => {
      const count = (calls.get(id) ?? 0) + 1; calls.set(id, count);
      if (count > 1) return { success: true, summary: 'continued stage' };
      (id === target.sessionId ? targetStarted : otherStarted).resolve();
      return (id === target.sessionId ? targetResult : otherResult).promise;
    },
  });
  const runs = [target, other].map(binding => engine.create({ sessionId: binding.sessionId, goal: 'Scoped maintenance', stages: steps }));
  try {
    for (const run of runs) engine.start(run.id);
    await Promise.all([targetStarted.promise, otherStarted.promise]);
    let settled = false;
    const disconnect = engine.disconnectSessions([target.sessionId], 'target maintenance').finally(() => { settled = true; });
    await cancellation.promise;
    assert.equal(settled, false); assert.equal(engine.isSessionBusy(target.sessionId), true);
    otherResult.resolve({ success: true, summary: 'other first stage' });
    assert.equal((await engine.wait(runs[1].id)).status, 'completed');
    assert.equal(calls.get(other.sessionId), 3);
    assert.deepEqual(cancelled, [target.sessionId]); assert.equal(settled, false);
    targetResult.resolve({ success: true, summary: 'late target success' });
    await disconnect;
    const stopped = await engine.wait(runs[0].id);
    assert.equal(stopped.status, 'interrupted'); assert.equal(stopped.error, 'target maintenance');
    assert.equal(stopped.stages[0].artifacts.length, 0); assert.equal(stopped.stages[1].attempts, 0);
    assert.equal(engine.isSessionBusy(target.sessionId), false);
    engine.continue(stopped.id);
    assert.equal((await engine.wait(stopped.id)).status, 'completed');
  } finally {
    targetResult.resolve({ success: false, summary: '' }); otherResult.resolve({ success: false, summary: '' });
    await engine.shutdown(); await Promise.all(runs.map(run => engine.wait(run.id)));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('session maintenance aggregates save and cancel failures only after every selected completion settles', async () => {
  const directory = temporary(), bindings = [makeBinding(), makeBinding()];
  const started = bindings.map(() => deferred<void>()), pending = bindings.map(() => deferred<WorkflowStageResult>());
  const cancellations = bindings.map(() => deferred<void>()), cancelled: string[] = [];
  const engine = new WorkflowEngine(directory, {
    getSession: id => bindings.find(binding => binding.sessionId === id)!,
    cancelSession: id => { const index = bindings.findIndex(binding => binding.sessionId === id); cancelled.push(id); cancellations[index].resolve(); throw new Error(`cancel ${index}`); },
    runStage: async id => { const index = bindings.findIndex(binding => binding.sessionId === id); started[index].resolve(); return pending[index].promise; },
  });
  const runs = bindings.map(binding => engine.create({ sessionId: binding.sessionId, goal: 'Maintenance failure', stages: steps }));
  const storage = (engine as unknown as { storage: WorkflowStorage }).storage, save = storage.save.bind(storage);
  try {
    for (const run of runs) engine.start(run.id);
    await Promise.all(started.map(value => value.promise));
    storage.save = () => { throw new Error('disk full'); };
    let settled = false;
    const disconnect = engine.disconnectSessions(bindings.map(binding => binding.sessionId)).finally(() => { settled = true; });
    const rejected = assert.rejects(disconnect, (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, 4);
      assert.match(error.message, /disk full/); assert.match(error.message, /cancel 0/); assert.match(error.message, /cancel 1/);
      return true;
    });
    await Promise.all(cancellations.map(value => value.promise));
    assert.deepEqual(cancelled, bindings.map(binding => binding.sessionId));
    assert.equal(settled, false);
    pending[0].resolve({ success: true, summary: 'late first success' });
    await engine.wait(runs[0].id);
    assert.equal(settled, false); assert.equal(engine.isSessionBusy(bindings[1].sessionId), true);
    pending[1].resolve({ success: true, summary: 'late second success' });
    await rejected;
    assert.ok(bindings.every(binding => !engine.isSessionBusy(binding.sessionId)));
    assert.ok(engine.list().every(run => run.status === 'running' && run.stages[0].artifacts.length === 0 && run.stages[1].attempts === 0));
    storage.save = save;
    await engine.disconnectSessions([bindings[0].sessionId], 'retry first save');
    assert.equal(engine.list(bindings[0].sessionId)[0].status, 'interrupted');
    assert.equal(engine.list(bindings[1].sessionId)[0].status, 'running');
    assert.equal(cancelled.length, 2, 'stale records must be repaired without recancelling settled runners');
    await engine.disconnectSessions([bindings[1].sessionId], 'retry second save');
    assert.ok(engine.list().every(run => run.status === 'interrupted'));
  } finally {
    storage.save = save;
    for (const value of pending) value.resolve({ success: false, summary: '' });
    await Promise.all(runs.map(run => engine.wait(run.id))); await engine.shutdown();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('shutdown preserves an interrupted stage and prevents late success from advancing', async () => {
  const directory = temporary();
  try {
    const binding = makeBinding();
    const pending = deferred<WorkflowStageResult>();
    let cancellations = 0;
    const engine = new WorkflowEngine(directory, {
      getSession: () => binding, cancelSession: () => { cancellations++; }, runStage: async () => pending.promise,
    });
    const run = engine.create({ sessionId: binding.sessionId, goal: 'Shutdown', stages: steps });
    engine.start(run.id);
    await tick();
    await engine.shutdown();
    pending.resolve({ success: true, summary: 'late' });
    const interrupted = await engine.wait(run.id);
    assert.equal(interrupted.status, 'interrupted');
    assert.equal(interrupted.stages[0].status, 'interrupted');
    assert.equal(interrupted.stages[1].attempts, 0);
    assert.equal(cancellations, 1);
    assert.throws(() => engine.continue(run.id), /关闭/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('full workflow history can be exported and explicitly deleted to recover capacity', () => {
  const directory=temporary();
  try {
    const binding=makeBinding();
    const options={getSession:()=>binding,cancelSession:()=>{},runStage:async()=>({success:true,summary:''})};
    const initial=new WorkflowEngine(directory,options);
    const seed=initial.create({sessionId:binding.sessionId,goal:'Kept history',stages:[steps[0]]});
    const runs=Array.from({length:500},()=>({...seed,id:randomUUID()}));
    fs.writeFileSync(initial.file,JSON.stringify({version:1,runs}));
    const engine=new WorkflowEngine(directory,options);
    assert.throws(()=>engine.create({sessionId:binding.sessionId,goal:'One too many'}),/全部记录.*导出并删除/);
    assert.equal(engine.list().length,500);
    const exported=JSON.parse(engine.exportRun(runs[0].id));
    assert.deepEqual(exported.runs,[runs[0]]);
    engine.remove(runs[0].id);
    engine.create({sessionId:binding.sessionId,goal:'Capacity recovered',stages:[steps[0]]});
    assert.equal(new WorkflowEngine(directory,options).list().length,500);
    engine.removeSession(binding.sessionId);
    assert.equal(new WorkflowEngine(directory,options).list().length,0);
  } finally { fs.rmSync(directory,{recursive:true,force:true}); }
});

test('running and stopping workflows cannot be exported or deleted, including session deletion', async () => {
  const directory=temporary();
  try {
    const binding=makeBinding(), pending=deferred<WorkflowStageResult>();
    const engine=new WorkflowEngine(directory,{getSession:()=>binding,cancelSession:()=>{},runStage:async()=>pending.promise});
    const run=engine.create({sessionId:binding.sessionId,goal:'Slow task',stages:[steps[0]]});
    engine.start(run.id); await tick();
    for(const operation of [()=>engine.remove(run.id),()=>engine.exportRun(run.id),()=>engine.removeSession(binding.sessionId)]) assert.throws(operation,/运行或停止/);
    await engine.cancel(run.id);
    assert.throws(()=>engine.remove(run.id),/运行或停止/);
    assert.throws(()=>engine.exportRun(run.id),/运行或停止/);
    pending.resolve({success:true,summary:'Late result'}); await engine.wait(run.id);
    assert.equal(JSON.parse(engine.exportRun(run.id)).runs[0].status,'cancelled');
    engine.remove(run.id); assert.equal(engine.list().length,0);
  } finally { fs.rmSync(directory,{recursive:true,force:true}); }
});

test('shutdown cancels all runners despite disk failure and retries saving after runners have settled', async t=>{
  const directory=temporary();
  try {
    const bindings=[makeBinding(),makeBinding()], pending=deferred<WorkflowStageResult>();
    const cancelled:string[]=[];
    const engine=new WorkflowEngine(directory,{
      getSession:id=>bindings.find(binding=>binding.sessionId===id)!,
      cancelSession:id=>{cancelled.push(id);},runStage:async()=>pending.promise,
    });
    const runs=bindings.map(binding=>engine.create({sessionId:binding.sessionId,goal:'Shutdown with disk fault',stages:steps}));
    for(const run of runs)engine.start(run.id);
    await tick();
    t.mock.method(fs,'fsyncSync',()=>{throw new Error('disk full');});
    await assert.rejects(engine.shutdown(),/disk full/);
    assert.deepEqual(cancelled.sort(),bindings.map(binding=>binding.sessionId).sort());
    pending.resolve({success:true,summary:'Late success'});
    await Promise.all(runs.map(run=>engine.wait(run.id)));
    assert.ok(bindings.every(binding=>!engine.isSessionBusy(binding.sessionId)));
    t.mock.restoreAll();
    await engine.shutdown();
    const saved=JSON.parse(fs.readFileSync(engine.file,'utf8'));
    assert.ok(saved.runs.every((run:{status:string;stages:{attempts:number;status:string}[]})=>
      run.status==='interrupted'&&run.stages[0].status==='interrupted'&&run.stages[1].attempts===0));
  }finally{t.mock.restoreAll();fs.rmSync(directory,{recursive:true,force:true});}
});
