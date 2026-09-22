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
  const cwdProof = randomUUID(); fs.writeFileSync(path.join(cwd, 'cwd-proof.txt'), cwdProof + '\n', 'utf8');
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
    const command=process.platform==='win32'?"Write-Output ('中文' + '输入完成'); Get-Content -LiteralPath './cwd-proof.txt'; (Get-Location).Path\r":"printf '\\n%s%s\\n' '中文' '输入完成'; cat ./cwd-proof.txt; pwd\r";
    runtime.write(a.id,command);
    const plain = () => stripVTControlCharacters(output.get(a.id) ?? '');
    // A relative file read proves cwd identity across Windows 8.3 aliases without trusting prompt text.
    await until(() => plain().includes(cwdProof) && plain().includes('中文输入完成'),
      'command output', () => JSON.stringify({ expected: cwd, canonical: fs.realpathSync.native(cwd), tail: plain().slice(-4000), status: store.state.sessions[0].status }), 15000);
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
    store.change(state => { state.sessions[0].identityPending = false; state.sessions[0].observedPermissionMode = 'auto'; });
    await assert.rejects(runtime.start(id, cap), /明确选择/);
    assert.equal(runtime.activeCount, 0);
    assert.equal(store.state.sessions[0].permissionMode, 'default');
  } finally { await runtime.shutdown(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

function lifecycleFixture(shellPath = '') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-lifecycle-'));
  const store = new StateStore(path.join(root, 'data')); const now = new Date().toISOString();
  const session: Session = { id: randomUUID(), projectId: randomUUID(), title: 'cleanup fixture', kind: 'shell', cwd: root, claudeId: randomUUID(), started: false, model: '', effort: 'default', permissionMode: 'default', status: 'idle', archived: false, createdAt: now, updatedAt: now };
  store.change(state => { state.sessions.push(session); state.settings.shellPath = shellPath; });
  const errors: Error[] = [];
  const runtime = new Runtime(store, () => {}, () => {}, { onError: error => errors.push(error) });
  const capabilities = { available: false, executable: '', version: '', flags: [], efforts: ['default' as const] };
  return { root, store, session, runtime, errors, capabilities };
}

test('stop and exit release a real PTY even when every state write fails', { timeout: 15000 }, async () => {
  const f = lifecycleFixture();
  try {
    await f.runtime.start(f.session.id, f.capabilities);
    fs.mkdirSync(f.store.file + '.tmp');
    assert.throws(() => f.runtime.stop(f.session.id));
    assert.doesNotThrow(() => f.runtime.stop(f.session.id), 'repeated stop cannot strand an ending process');
    await until(() => !f.runtime.has(f.session.id), 'failed-persistence cleanup');
    assert.equal(f.runtime.activeCount, 0);
    assert.equal(f.runtime.pendingCleanupCount, 0);
    assert.ok(f.errors.length > 0, 'exit persistence errors are reported without escaping the native callback');
    assert.ok(f.runtime.lastError);
  } finally {
    fs.rmSync(f.store.file + '.tmp', { recursive: true, force: true });
    await f.runtime.shutdown(); fs.rmSync(f.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('state failure after spawn terminates the process before start rejects', { timeout: 15000 }, async () => {
  const f = lifecycleFixture();
  try {
    fs.mkdirSync(f.store.file + '.tmp');
    await assert.rejects(f.runtime.start(f.session.id, f.capabilities));
    await until(() => f.runtime.activeCount === 0, 'failed-start cleanup');
    assert.equal(f.runtime.pendingCleanupCount, 0);
  } finally {
    fs.rmSync(f.store.file + '.tmp', { recursive: true, force: true });
    await f.runtime.shutdown(); fs.rmSync(f.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('shutdown waits for an ignoring descendant after its root PTY has exited', { skip: process.platform === 'win32', timeout: 15000 }, async () => {
  const f = lifecycleFixture(); let childPid = 0; let rootPid = 0;
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const processRunning = async (pid: number) => {
    try { const result = await execFileAsync('ps', ['-o', 'stat=', '-p', String(pid)]); return result.stdout.trim().length > 0 && !result.stdout.trim().startsWith('Z'); }
    catch { return false; }
  };
  try {
    const rootFile = path.join(f.root, 'root-pid'); const childFile = path.join(f.root, 'child-pid'); const heartbeat = path.join(f.root, 'heartbeat');
    const script = path.join(f.root, 'fixture-shell');
    const childCode = `const fs = require('node:fs'); process.on('SIGTERM', () => {}); process.on('SIGHUP', () => {}); fs.writeFileSync(${JSON.stringify(childFile)}, String(process.pid)); setInterval(() => fs.writeFileSync(${JSON.stringify(heartbeat)}, String(Date.now())), 20);`;
    fs.writeFileSync(script, `#!${process.execPath}\nconst fs = require('node:fs'); const {spawn} = require('node:child_process'); process.on('SIGTERM', () => process.exit(0)); fs.writeFileSync(${JSON.stringify(rootFile)}, String(process.pid)); spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], {stdio:'ignore'}); setInterval(() => {}, 1000);\n`, { mode: 0o755 });
    f.store.change(state => { state.settings.shellPath = script; });
    await f.runtime.start(f.session.id, f.capabilities);
    await until(() => fs.existsSync(childFile) && fs.existsSync(heartbeat), 'descendant ready');
    rootPid = Number(fs.readFileSync(rootFile, 'utf8')); childPid = Number(fs.readFileSync(childFile, 'utf8'));
    let finished = false;
    const shutdown = f.runtime.shutdown().then(() => { finished = true; });
    await until(() => !alive(rootPid), 'root exit');
    assert.equal(await processRunning(childPid), true, 'descendant ignores graceful termination');
    assert.equal(finished, false, 'root exit must not resolve shutdown');
    assert.ok(f.runtime.pendingCleanupCount > 0);
    assert.equal(f.runtime.has(f.session.id), true, 'session ownership persists through descendant cleanup');
    await shutdown;
    let childRunning = await processRunning(childPid);
    for (let attempts = 0; childRunning && attempts < 40; attempts++) {
      await new Promise(resolve => setTimeout(resolve, 25)); childRunning = await processRunning(childPid);
    }
    assert.equal(childRunning, false, 'escalation terminates the descendant before shutdown completes');
    assert.equal(f.runtime.pendingCleanupCount, 0);
    assert.equal(f.runtime.activeCount, 0);
  } finally {
    for (const pid of [childPid, rootPid]) if (pid && alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* Already gone. */ } }
    await f.runtime.shutdown(); fs.rmSync(f.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('shutdown cancels and awaits a CLI start that is still resolving transcript and hook state', { timeout: 10000 }, async () => {
  const f = lifecycleFixture();
  try {
    f.store.change(state => { state.sessions[0].kind = 'claude'; state.settings.claudePath = process.execPath; });
    const pending = f.runtime.start(f.session.id, { available: true, executable: process.execPath, version: '2.1.278', flags: ['--session-id', '--permission-mode', '--settings'], efforts: ['default'] });
    const rejected = assert.rejects(pending, /已取消启动会话/);
    await f.runtime.shutdown();
    await rejected;
    assert.equal(f.runtime.activeCount, 0);
    assert.equal(f.runtime.pendingCleanupCount, 0);
    assert.equal(f.store.state.sessions[0].status, 'stopped');
    assert.equal(f.store.state.sessions[0].started, false);
  } finally { await f.runtime.shutdown(); fs.rmSync(f.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('shutdown retries deferred persistence after cleanup has completed and storage recovers', { timeout: 5000 }, async () => {
  const f = lifecycleFixture();
  try {
    f.store.change(state => { state.sessions[0].draft = 'save after repair'; }, { defer: true });
    fs.mkdirSync(f.store.file + '.tmp');
    await assert.rejects(f.runtime.shutdown());
    assert.equal(f.runtime.activeCount, 0);
    assert.equal(f.runtime.pendingCleanupCount, 0);
    fs.rmdirSync(f.store.file + '.tmp');
    await f.runtime.shutdown();
    assert.equal(f.store.persistenceError, undefined);
    assert.equal(JSON.parse(fs.readFileSync(f.store.file, 'utf8')).sessions[0].draft, 'save after repair');
  } finally {
    fs.rmSync(f.store.file + '.tmp', { recursive: true, force: true });
    await f.runtime.shutdown(); fs.rmSync(f.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
