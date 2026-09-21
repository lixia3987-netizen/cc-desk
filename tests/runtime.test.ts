import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import { Runtime } from '../src/main/runtime';
import { StateStore } from '../src/main/store';
import type { Session } from '../src/shared/types';
import { createWorktree, gitInfo } from '../src/main/git';
import { execFileAsync } from '../src/main/commands';

async function until(check:()=>boolean, phase: string, diagnostics: () => string = () => '', timeout = 7000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for PTY ${phase}: ${diagnostics()}`);
    await new Promise(resolve => setTimeout(resolve,25));
  }
}
test('real PTY supports Unicode/spaces, isolated output, input, resize, concurrency and stopping', { timeout: 40000 }, async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'workbench-pty-'));const cwd=path.join(root,'项目 space & quote');fs.mkdirSync(cwd);
  const store=new StateStore(path.join(root,'data'));const projectId=randomUUID();
  const create=():Session=>({id:randomUUID(),projectId,title:'shell',kind:'shell',cwd,claudeId:randomUUID(),started:false,model:'',effort:'default',permissionMode:'default',status:'idle',archived:false,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
  const a=create(),b=create();store.change(s=>{s.sessions=[a,b];s.settings.maxSessions=1;});
  const output=new Map<string,string>();const runtime=new Runtime(store,()=>{},chunk=>output.set(chunk.sessionId,(output.get(chunk.sessionId)||'')+chunk.data));
  const cap={available:false,executable:'',version:'',flags:[],efforts:['default' as const]};
  try {
    fs.writeFileSync(runtime.logPath(a.id), 'retained-before-rotation\n' + 'x'.repeat(5 * 1024 * 1024 - 25));
    await runtime.start(a.id,cap);
    assert.throws(() => runtime.forget(a.id), /请先停止/);
    assert.equal(fs.statSync(runtime.logPath(a.id) + '.previous').size, 5 * 1024 * 1024);
    await assert.rejects(runtime.start(b.id,cap),/并发会话上限/);
    runtime.resize(a.id,120,40);
    // Construct the marker from separate arguments: command echo alone must never satisfy the test.
    const command=process.platform==='win32'?"Write-Output ('中文' + '输入完成'); (Get-Location).Path\r":"printf '\\n%s%s\\n' '中文' '输入完成'; pwd\r";
    runtime.write(a.id,command);
    const plain = () => stripVTControlCharacters(output.get(a.id) ?? '');
    const normalize = (text: string) => { const line = text.replace(/[\r\n]/g, ''); return process.platform === 'win32' ? line.toLowerCase() : line; };
    await until(() => [cwd, fs.realpathSync(cwd)].some(value => normalize(plain()).includes(normalize(value))) && plain().includes('中文输入完成'),
      'command output', () => JSON.stringify({ expected: cwd, canonical: fs.realpathSync(cwd), tail: plain().slice(-4000), status: store.state.sessions[0].status }), 15000);
    assert.equal(output.has(b.id),false);
    const snapshot=runtime.snapshot(a.id);assert.ok(snapshot.chunks.length>0);
    const exported=runtime.exportLogs(a.id);assert.match(exported,/retained-before-rotation/);assert.match(stripVTControlCharacters(exported),/中文输入完成/);
    runtime.stop(a.id);await until(()=>runtime.activeCount===0, 'stop', () => JSON.stringify({ status: store.state.sessions[0].status, active: runtime.activeCount }));
    assert.equal(store.state.sessions[0].status,'stopped');
    await runtime.start(b.id,cap);assert.equal(store.state.sessions[1].status,'running');
  }finally{await runtime.shutdown();fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
test('worktree creates an independent branch and preserves the original working tree', { timeout: 30000 }, async()=>{
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
  }finally{fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});

test('stopped terminal caches are bounded, evicted output reloads, and exports retain both log segments', { timeout: 10000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-cache-'));
  const store = new StateStore(root); const now = new Date().toISOString();
  const sessions: Session[] = Array.from({ length: 12 }, () => ({ id: randomUUID(), projectId: randomUUID(), title: 'stopped', kind: 'shell', cwd: root, claudeId: randomUUID(), started: false, model: '', effort: 'default', permissionMode: 'default', status: 'stopped', archived: false, createdAt: now, updatedAt: now }));
  store.change(state => { state.sessions = sessions; });
  const runtime = new Runtime(store, () => {}, () => {}, { maxStoppedBuffers: 2 });
  try {
    let firstSequence = 0;
    for (const [index, session] of sessions.entries()) {
      fs.writeFileSync(runtime.logPath(session.id), `output-${index}`);
      const snapshot = runtime.snapshot(session.id);
      if (index === 0) firstSequence = snapshot.chunks[0].seq;
      assert.ok(runtime.retainedBufferCount <= 2);
    }
    const restored = runtime.snapshot(sessions[0].id);
    assert.equal(restored.chunks[0].data, 'output-0'); assert.ok(restored.chunks[0].seq > firstSequence);
    fs.writeFileSync(runtime.logPath(sessions[0].id) + '.previous', 'earlier-output\n');
    const exported = runtime.exportLogs(sessions[0].id);
    assert.match(exported, /retained terminal output only/); assert.match(exported, /earlier-output\noutput-0/);
    runtime.forget(sessions[0].id, { deleteLogs: true });
    assert.equal(fs.existsSync(runtime.logPath(sessions[0].id)), false);
    assert.equal(fs.existsSync(runtime.logPath(sessions[0].id) + '.previous'), false);
    assert.equal(runtime.has(sessions[0].id), false);
  } finally { await runtime.shutdown(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('a pending CLI identity or unsupported observed permission cannot silently resume with stale settings', { timeout: 10000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-runtime-guard-'));
  const store = new StateStore(root); const now = new Date().toISOString(); const id = randomUUID();
  store.change(state => state.sessions.push({ id, projectId: randomUUID(), title: 'guard', kind: 'claude', cwd: root, claudeId: randomUUID(), started: true, model: '', effort: 'default', permissionMode: 'default', status: 'stopped', archived: false, createdAt: now, updatedAt: now, identityPending: true }));
  const runtime = new Runtime(store, () => {}, () => {});
  const cap = { available: false, executable: '', version: '', flags: [], efforts: ['default' as const] };
  try {
    await assert.rejects(runtime.start(id, cap), /新会话身份尚未确认/);
    store.change(state => { state.sessions[0].identityPending = false; state.sessions[0].observedPermissionMode = 'bypassPermissions'; });
    await assert.rejects(runtime.start(id, cap), /明确选择/);
    assert.equal(runtime.activeCount, 0);
    assert.equal(store.state.sessions[0].permissionMode, 'default');
  } finally { await runtime.shutdown(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
