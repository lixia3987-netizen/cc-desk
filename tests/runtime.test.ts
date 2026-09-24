import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import { Runtime } from '../src/main/runtime';
import { StateStore } from '../src/main/store';
import type { Capabilities, Session } from '../src/shared/types';
import { ClaudeTerminalLauncher } from '../src/main/engines/claude/terminal-launcher';
import { ShellTerminalLauncher } from '../src/main/engines/shell/terminal-launcher';
import type { TerminalLauncher, TerminalLaunchCallbacks } from '../src/main/execution/terminal-launch';
import { createWorktree, gitInfo } from '../src/main/git';
import { environment, execFileAsync } from '../src/main/commands';
import { fileURLToPath } from 'node:url';

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
  const create=():Session=>({id:randomUUID(),projectId,title:'shell',kind:'shell',cwd,execution:{providerId:'shell',mode:'terminal'},started:false,model:'',effort:'default',permissionMode:'default',status:'idle',archived:false,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
  const a=create(),b=create();store.change(s=>{s.sessions=[a,b];s.settings.maxSessions=1;});
  const output=new Map<string,string>();const runtime=new Runtime(store,()=>{},chunk=>output.set(chunk.sessionId,(output.get(chunk.sessionId)||'')+chunk.data), new ShellTerminalLauncher(store));
  try {
    fs.writeFileSync(runtime.logPath(a.id), 'retained-before-rotation\n' + 'x'.repeat(5 * 1024 * 1024 - 25));
    await runtime.start(a.id);
    assert.throws(() => runtime.forget(a.id), /请先停止/);
    assert.equal(fs.statSync(runtime.logPath(a.id) + '.previous').size, 5 * 1024 * 1024);
    await assert.rejects(runtime.start(b.id),/并发会话上限/);
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
    await runtime.start(b.id);assert.equal(store.state.sessions[1].status,'running');
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
  const sessions: Session[] = Array.from({ length: 12 }, () => ({ id: randomUUID(), projectId: randomUUID(), title: 'stopped', kind: 'shell', cwd: root, execution: { providerId: 'shell', mode: 'terminal' }, started: false, model: '', effort: 'default', permissionMode: 'default', status: 'stopped', archived: false, createdAt: now, updatedAt: now }));
  store.change(state => { state.sessions = sessions; });
  const runtime = new Runtime(store, () => {}, () => {}, new ShellTerminalLauncher(store), { maxStoppedBuffers: 2 });
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
  store.change(state => state.sessions.push({ id, projectId: randomUUID(), title: 'guard', kind: 'agent', cwd: root, execution: { providerId: 'claude', mode: 'terminal', conversationId: randomUUID() }, started: true, model: '', effort: 'default', permissionMode: 'default', status: 'stopped', archived: false, createdAt: now, updatedAt: now, identityPending: true }));
  const runtime = new Runtime(store, () => {}, () => {}, new ClaudeTerminalLauncher(store, () => ({ available: false, executable: '', version: '', flags: [], efforts: ['default'] })));
  try {
    await assert.rejects(runtime.start(id), /新会话身份尚未确认/);
    store.change(state => { state.sessions[0].identityPending = false; state.sessions[0].observedPermissionMode = 'auto'; });
    await assert.rejects(runtime.start(id), /明确选择/);
    assert.equal(runtime.activeCount, 0);
    assert.equal(store.state.sessions[0].permissionMode, 'default');
  } finally { await runtime.shutdown(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

function lifecycleFixture(shellPath = '') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-lifecycle-'));
  const store = new StateStore(path.join(root, 'data')); const now = new Date().toISOString();
  const session: Session = { id: randomUUID(), projectId: randomUUID(), title: 'cleanup fixture', kind: 'shell', cwd: root, execution: { providerId: 'shell', mode: 'terminal' }, started: false, model: '', effort: 'default', permissionMode: 'default', status: 'idle', archived: false, createdAt: now, updatedAt: now };
  store.change(state => { state.sessions.push(session); state.settings.shellPath = shellPath; });
  const errors: Error[] = [];
  let capabilities: Capabilities = { available: false, executable: '', version: '', flags: [], efforts: ['default'] };
  const claude = new ClaudeTerminalLauncher(store, () => capabilities);
  const shell = new ShellTerminalLauncher(store);
  const launcher: TerminalLauncher = { prepare: (session, callbacks) => (session.execution.providerId === 'claude' ? claude : shell).prepare(session, callbacks) };
  const runtime = new Runtime(store, () => {}, () => {}, launcher, { onError: error => errors.push(error) });
  return { root, store, session, runtime, errors, setCapabilities: (next: Capabilities) => { capabilities = next; } };
}

test('terminal runtime accepts another provider and isolates identity observations to the current launch', { timeout: 12000 }, async () => {
  const f = lifecycleFixture();
  const callbacks: TerminalLaunchCallbacks[] = [];
  let resourcesClosed = 0;
  f.store.change(state => {
    state.sessions[0].kind = 'agent';
    state.sessions[0].execution = { providerId: 'test-agent', mode: 'terminal', conversationId: 'first-conversation' };
    state.sessions[0].titleSource = 'default';
  });
  const launcher: TerminalLauncher = {
    async prepare(session, callback) {
      assert.equal(session.execution.providerId, 'test-agent');
      callbacks.push(callback);
      return { file: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], env: environment(),
        resource: { async close() { resourcesClosed++; } }, terminalSync: 'waiting' };
    }
  };
  const runtime = new Runtime(f.store, () => {}, () => {}, launcher);
  const current = () => f.store.state.sessions[0];
  try {
    await runtime.start(f.session.id);
    callbacks[0].update({ conversationId: 'second-conversation', taskState: 'thinking', terminalSync: 'synced' });
    assert.equal(current().id, f.session.id);
    assert.deepEqual(current().execution, { providerId: 'test-agent', mode: 'terminal', conversationId: 'second-conversation' });
    runtime.stop(f.session.id);
    await until(() => !runtime.has(f.session.id), 'first provider cleanup');
    assert.equal(resourcesClosed, 1);
    await runtime.start(f.session.id);
    callbacks[0].update({ conversationId: 'stale-conversation', model: 'stale' });
    callbacks[0].prompt('stale prompt');
    callbacks[0].subtask({ type: 'begin', turnId: 'stale-turn' });
    assert.equal(current().execution.conversationId, 'second-conversation');
    assert.equal(current().model, '');
    assert.equal(current().title, 'cleanup fixture');
    assert.notEqual(current().subtasks?.turnId, 'stale-turn');
    callbacks[1].update({ conversationId: 'third-conversation' });
    callbacks[1].prompt('新的会话标题');
    assert.equal(current().execution.conversationId, 'third-conversation');
    assert.equal(current().title, '新的会话标题');
  } finally {
    await runtime.shutdown(); await f.runtime.shutdown();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
  assert.equal(resourcesClosed, 2);
});

test('a process owning silent PTYs exits after natural exit, update disconnect and shutdown', { timeout: 25000 }, async () => {
  const fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ccdesk-silent-fixture-'));
  const fixtureFile = path.join(fixtureDirectory, 'owner.mjs');
  const runtimeModule = new URL('../src/main/runtime.ts', import.meta.url).href;
  const storeModule = new URL('../src/main/store.ts', import.meta.url).href;
  const script = `
    import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
    import { randomUUID } from 'node:crypto'; import assert from 'node:assert/strict';
    const checkpoint = phase => console.error(JSON.stringify({ phase,
      resources: process.getActiveResourcesInfo(),
      handles: process._getActiveHandles().map(handle => handle.constructor?.name ?? 'unknown'),
    }));
    checkpoint('loading-runtime');
    const { Runtime } = await import(${JSON.stringify(runtimeModule)}).then(module => module.default ?? module);
    const { StateStore } = await import(${JSON.stringify(storeModule)}).then(module => module.default ?? module);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccdesk-silent-owner-'));
    const store = new StateStore(root), id = randomUUID(), now = new Date().toISOString();
    store.change(state => state.sessions.push({ id, projectId: randomUUID(), title: 'silent', kind: 'agent',
      execution: { providerId: 'silent', mode: 'terminal' }, cwd: root, started: false,
      model: '', effort: 'default', permissionMode: 'default', status: 'idle', archived: false, createdAt: now, updatedAt: now }));
    let program = 'process.exit(0)';
    const runtime = new Runtime(store, () => {}, () => {}, { prepare: async () => ({
      file: process.execPath, args: ['-e', program], env: process.env,
    }) });
    try {
      checkpoint('natural-start');
      await runtime.start(id);
      const deadline = Date.now() + 5000;
      while (runtime.activeCount) {
        assert.ok(Date.now() < deadline, 'natural exit must release its worker');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(runtime.lastError, undefined);
      checkpoint('natural-released');
      program = 'setInterval(() => {}, 1000)';
      await runtime.start(id);
      checkpoint('update-disconnecting');
      runtime.setMaintenance(true); await runtime.disconnectAll();
      assert.equal(runtime.activeCount, 0); assert.equal(runtime.pendingCleanupCount, 0);
      checkpoint('update-disconnected');
      runtime.setMaintenance(false); await runtime.start(id); await runtime.shutdown();
      assert.equal(runtime.activeCount, 0); assert.equal(runtime.pendingCleanupCount, 0);
      checkpoint('shutdown-released');
    } finally { await runtime.shutdown(); fs.rmSync(root, { recursive: true, force: true }); }
    console.log('silent PTY owner released');
  `;
  try {
    fs.writeFileSync(fixtureFile, script);
    // Worker(file) inherits execArgv; --input-type=module is invalid for its file.
    const result = await execFileAsync(process.execPath, ['--import', 'tsx', fixtureFile], {
      cwd: fileURLToPath(new URL('../', import.meta.url)), timeout: 20000, windowsHide: true, maxBuffer: 256 * 1024,
    }).catch(error => {
      assert.fail(`Silent PTY owner failed (${error.code ?? error.signal ?? 'unknown'}).\n${error.stdout ?? ''}\n${error.stderr ?? ''}`);
    });
    assert.match(result.stdout, /silent PTY owner released/);
  } finally { fs.rmSync(fixtureDirectory, { recursive: true, force: true }); }
});

test('shutdown reports launch-resource failure even when the terminal process already exited', { timeout: 12000 }, async () => {
  const f = lifecycleFixture();
  const failure = new Error('Launch resource could not close');
  const runtime = new Runtime(f.store, () => {}, () => {}, { prepare: async () => ({
    file: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'],
    env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    resource: { close: async () => { throw failure; } },
  }) });
  try {
    await runtime.start(f.session.id);
    await assert.rejects(runtime.shutdown(), error => error instanceof Error && error.cause === failure);
    assert.equal(runtime.activeCount, 0); assert.equal(runtime.pendingCleanupCount, 0);
    assert.equal(runtime.lastError, failure);
    assert.equal(f.store.state.sessions[0].status, 'error', 'failed cleanup must not advertise a successful stop');
    assert.match(f.store.state.sessions[0].error ?? '', /资源清理失败/);
    await assert.rejects(runtime.shutdown(), /资源已释放/, 'failed resource cleanup cannot be reported as successful on retry');
  } finally {
    await runtime.shutdown().catch(() => {}); await f.runtime.shutdown();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('session stop waits for asynchronous cleanup and reports only that session failure on retries', { timeout: 15000 }, async () => {
  const f = lifecycleFixture();
  const healthy = { ...f.session, id: randomUUID(), title: 'healthy cleanup' };
  f.store.change(state => state.sessions.push(healthy));
  const failure = new Error('Owned launcher resource failed to close');
  let release!: () => void, closing = false, finished = false;
  const cleanupGate = new Promise<void>(resolve => { release = resolve; });
  const runtime = new Runtime(f.store, () => {}, () => {}, { prepare: async session => ({
    file: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], env: environment(),
    resource: { close: async () => {
      if (session.id !== f.session.id) return;
      closing = true; await cleanupGate; throw failure;
    } },
  }) });
  let rejected: Promise<void> | undefined;
  try {
    await runtime.start(f.session.id); await runtime.start(healthy.id);
    rejected = assert.rejects(runtime.stopAndWait(f.session.id).finally(() => { finished = true; }), error => error instanceof Error && error.cause === failure);
    await until(() => closing, 'session cleanup awaiting resource');
    assert.equal(finished, false);
    assert.equal(runtime.has(f.session.id), true);
    await runtime.stopAndWait(healthy.id);
    assert.equal(runtime.has(healthy.id), false);
    release(); await rejected;
    assert.equal(runtime.has(f.session.id), false);
    assert.equal(runtime.pendingCleanupCount, 0);
    await assert.rejects(runtime.stopAndWait(f.session.id), error => error instanceof Error && error.cause === failure);
    await runtime.stopAndWait(healthy.id);
    assert.equal(f.store.state.sessions.find(session => session.id === healthy.id)?.status, 'stopped');
  } finally {
    release(); await rejected?.catch(() => {});
    await runtime.shutdown().catch(() => {}); await f.runtime.shutdown();
    fs.rmSync(f.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('session stop awaits a cancelled launcher and reports cleanup failure before a PTY exists', { timeout: 10000 }, async () => {
  const f = lifecycleFixture();
  const failure = new Error('Cancelled launch resource failed to close');
  let release!: () => void, stopped = false;
  const preparation = new Promise<void>(resolve => { release = resolve; });
  const runtime = new Runtime(f.store, () => {}, () => {}, { prepare: async () => {
    await preparation;
    return { file: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], env: environment(), resource: { close: async () => { throw failure; } } };
  } });
  let starting: Promise<void> | undefined, stopping: Promise<void> | undefined;
  try {
    starting = assert.rejects(runtime.start(f.session.id), /已取消启动会话/);
    stopping = assert.rejects(runtime.stopAndWait(f.session.id).finally(() => { stopped = true; }), error => error instanceof Error && error.cause === failure);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(stopped, false);
    release(); await Promise.all([starting, stopping]);
    assert.equal(runtime.has(f.session.id), false);
    assert.equal(f.store.state.sessions[0].started, false);
  } finally {
    release(); await Promise.allSettled([starting, stopping]);
    await runtime.shutdown().catch(() => {}); await f.runtime.shutdown();
    fs.rmSync(f.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('terminal exit keeps stopping status and ownership until all launch resources close', { timeout: 20000 }, async () => {
  for (const ending of ['stop', 'success', 'failure'] as const) {
    const f = lifecycleFixture();
    const ready = path.join(f.root, 'ready'), exit = path.join(f.root, 'exit');
    let release!: () => void;
    const resourceGate = new Promise<void>(resolve => { release = resolve; });
    let closing = false;
    const finalOwnership: boolean[] = [];
    const runtime = new Runtime(f.store, () => {
      if (['stopped', 'error'].includes(f.store.state.sessions[0].status)) finalOwnership.push(runtime.has(f.session.id));
    }, () => {}, { prepare: async () => ({
      file: process.execPath, args: ['-e', `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{if(fs.existsSync(${JSON.stringify(exit)}))process.exit(${ending === 'failure' ? 7 : 0});},20);`],
      env: environment(), resource: { close: async () => { closing = true; await resourceGate; } },
    }) });
    try {
      await runtime.start(f.session.id);
      await until(() => fs.existsSync(ready), `${ending} fixture ready`);
      if (ending === 'stop') runtime.stop(f.session.id); else fs.writeFileSync(exit, 'exit');
      await until(() => closing, `${ending} resource close began`);
      assert.equal(f.store.state.sessions[0].status, 'stopping', 'archive and quit must not become available during cleanup');
      assert.equal(runtime.has(f.session.id), true);
      assert.equal(runtime.activeCount, 1);
      assert.deepEqual(finalOwnership, [], 'no stopped/error event may precede cleanup');
      release();
      await until(() => !runtime.has(f.session.id), `${ending} complete cleanup`);
      assert.equal(f.store.state.sessions[0].status, ending === 'failure' ? 'error' : 'stopped');
      assert.deepEqual(finalOwnership, [false], 'final status is published only after ownership is released');
      assert.equal(runtime.activeCount, 0);
    } finally {
      release(); await runtime.shutdown(); await f.runtime.shutdown();
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  }
});

test('CLI update disconnects real terminals and cancels pending starts without permanently shutting down the runtime', { timeout: 15000 }, async () => {
  const f = lifecycleFixture();
  try {
    await f.runtime.start(f.session.id);
    f.runtime.setMaintenance(true); await f.runtime.disconnectAll();
    assert.equal(f.runtime.activeCount, 0); assert.equal(f.runtime.pendingCleanupCount, 0);
    await assert.rejects(f.runtime.start(f.session.id), /正在更新/);
    f.runtime.setMaintenance(false); await f.runtime.start(f.session.id);
    assert.equal(f.runtime.activeCount, 1);
  } finally { await f.runtime.shutdown(); fs.rmSync(f.root, { recursive: true, force: true }); }
});
test('stop and exit release a real PTY even when every state write fails', { timeout: 15000 }, async () => {
  const f = lifecycleFixture();
  try {
    await f.runtime.start(f.session.id);
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
    await assert.rejects(f.runtime.start(f.session.id));
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
    await f.runtime.start(f.session.id);
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
    f.store.change(state => { state.sessions[0].kind = 'agent'; state.sessions[0].execution = { providerId: 'claude', mode: 'terminal', conversationId: randomUUID() }; state.settings.claudePath = process.execPath; });
    f.setCapabilities({ available: true, executable: process.execPath, version: '2.1.278', flags: ['--session-id', '--permission-mode', '--settings'], efforts: ['default'] });
    const pending = f.runtime.start(f.session.id);
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

test('real hooked PTY keeps children active after Ctrl-C and settles them on confirmed stop or crash', { skip: process.platform === 'win32', timeout: 25000 }, async () => {
  for (const ending of ['stop', 'interrupt', 'crash'] as const) {
    const f = lifecycleFixture();
    try {
      const script = path.join(f.root, 'fixture-claude'); const crash = path.join(f.root, 'crash');
      fs.writeFileSync(script, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const session_id = args[args.indexOf('--session-id') + 1];
const handler = JSON.parse(args[args.indexOf('--settings') + 1]).hooks.SubagentStart[0].hooks[0];
process.on('SIGINT', () => {});
setInterval(() => { if (fs.existsSync(${JSON.stringify(crash)})) process.exit(7); }, 25);
const send = async (hook_event_name, fields = {}) => {
  const response = await fetch(handler.url, { method: 'POST', headers: { ...handler.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ hook_event_name, session_id, cwd: process.cwd(), prompt_id: 'live-prompt', ...fields }) });
  if (response.status !== 200) throw new Error('Hook failed: ' + response.status);
};
(async () => {
  await send('UserPromptSubmit', { prompt: '检查界面与接口' });
  await send('SubagentStart', { agent_id: 'finished', agent_type: '审查' });
  await send('SubagentStart', { agent_id: 'active', agent_type: '测试', permission_mode: 'bypassPermissions' });
  await send('SubagentStop', { agent_id: 'finished', last_assistant_message: '已检查', permission_mode: 'plan' });
  await send('Stop');
})().catch(error => { console.error(error); process.exit(9); });
`, { mode: 0o755 });
      f.store.change(state => { state.sessions[0].kind = 'agent'; state.sessions[0].execution = { providerId: 'claude', mode: 'terminal', conversationId: randomUUID() }; state.sessions[0].titleSource = ending === 'stop' ? 'default' : 'manual'; state.settings.claudePath = script; });
      f.setCapabilities({ available: true, executable: script, version: '2.1.278',
        flags: ['--session-id', '--permission-mode', '--settings'], efforts: ['default'] });
      await f.runtime.start(f.session.id);
      const session = () => f.store.state.sessions[0];
      await until(() => session().taskState === 'completed' && session().subtasks?.tasks.length === 2,
        `hooked children (${ending})`, () => f.runtime.exportLogs(f.session.id));
      assert.equal(session().permissionMode, 'default', 'child modes never overwrite main launch settings');
      assert.equal(session().title, ending === 'stop' ? '检查界面与接口' : 'cleanup fixture');
      assert.equal(session().titleSource, ending === 'stop' ? 'auto' : 'manual');
      assert.deepEqual(session().subtasks?.tasks.map(task => task.status), ['completed', 'running']);
      if (ending === 'crash') {
        fs.writeFileSync(crash, 'exit');
        await until(() => !f.runtime.has(f.session.id), 'crashed hooked PTY');
        assert.equal(session().status, 'error');
        assert.equal(session().subtasks?.tasks[1].status, 'failed');
      } else {
        if (ending === 'interrupt') {
          f.runtime.interrupt(f.session.id);
          assert.equal(session().taskState, 'interrupted');
          assert.equal(session().subtasks?.tasks[1].status, 'running', 'Ctrl-C does not acknowledge background child termination');
        }
        f.runtime.stop(f.session.id);
        assert.equal(session().subtasks?.tasks[1].status, 'interrupted');
      }
      assert.equal(session().subtasks?.tasks[0].status, 'completed', 'settling active tasks preserves confirmed completion');
      assert.equal(session().subtasks?.tasks[0].summary, '已检查');
    } finally { await f.runtime.shutdown(); fs.rmSync(f.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  }
});
