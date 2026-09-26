import { after, afterEach, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { inspect, stripVTControlCharacters } from 'node:util';
import { Runtime } from '../src/main/runtime';
import { StateStore } from '../src/main/store';
import type { Capabilities, Session } from '../src/shared/types';
import { ClaudeTerminalLauncher } from '../src/main/engines/claude/terminal-launcher';
import { ShellTerminalLauncher } from '../src/main/engines/shell/terminal-launcher';
import type { TerminalLauncher, TerminalLaunchCallbacks } from '../src/main/execution/terminal-launch';
import { createWorktree, gitInfo } from '../src/main/git';
import { environment, execFileAsync } from '../src/main/commands';
import { fileURLToPath } from 'node:url';
import { linuxLiveProcesses } from '@cc-desk/agent-node/process-supervisor';

// Windows CI has completed every assertion in this file without the owning test
// process exiting. Record only fixed resource types/counts, never report paths,
// commands or environments from the full diagnostic report.
if (process.platform === 'win32') {
  const counts = (types: readonly string[]) => Object.fromEntries([...new Set(types)].sort()
    .map(type => [type, types.filter(value => value === type).length]));
  const snapshot = (phase: string) => {
    const report = process.report.getReport() as { libuv?: { type?: string; is_active?: boolean; is_referenced?: boolean }[] };
    console.error(JSON.stringify({ phase: `runtime.test.${phase}`,
      resources: counts(process.getActiveResourcesInfo()),
      referencedActiveHandles: counts((report.libuv ?? []).filter(handle => handle.is_active && handle.is_referenced)
        .map(handle => typeof handle.type === 'string' ? handle.type : 'unknown')),
    }));
  };
  let completedTests = 0;
  before(() => snapshot('before'));
  afterEach(() => snapshot(`after-test-${++completedTests}`));
  after(() => {
    snapshot('after');
    // An unref timer observes an existing leak without extending file lifetime.
    for (const delay of [1000, 6000]) setTimeout(() => snapshot(`after-${delay}ms`), delay).unref();
  });
}

async function until(check:()=>boolean, phase: string, diagnostics: () => string = () => '', timeout = 7000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for PTY ${phase}: ${diagnostics()}`);
    await new Promise(resolve => setTimeout(resolve,25));
  }
}
async function processIsRunning(pid: number): Promise<boolean> {
  try {
    if (process.platform === 'linux') {
      return (await linuxLiveProcesses({ pid })).some(item => item.pid === pid);
    }
    const result = await execFileAsync('ps', ['-o', 'stat=', '-p', String(pid)]);
    return Boolean(result.stdout.trim()) && !result.stdout.trim().startsWith('Z');
  } catch { return false; }
}
test('real PTY supports Unicode/spaces, isolated output, input, resize, concurrency and stopping', { timeout: 40000 }, async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'workbench-pty-'));const cwd=path.join(root,'项目 space & quote');fs.mkdirSync(cwd);
  const cwdProof = randomUUID(); fs.writeFileSync(path.join(cwd, 'cwd-proof.txt'), cwdProof + '\n', 'utf8');
  const store=new StateStore(path.join(root,'data'));const projectId=randomUUID();
  const create=():Session=>({id:randomUUID(),projectId,title:'shell',kind:'shell',cwd,execution:{providerId:'shell',mode:'terminal'},started:false,engineConfig: { schemaVersion: 1, options: {} },status:'idle',archived:false,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
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
    runtime.stop(a.id);await runtime.whenReleased(a.id);
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
  const sessions: Session[] = Array.from({ length: 12 }, () => ({ id: randomUUID(), projectId: randomUUID(), title: 'stopped', kind: 'shell', cwd: root, execution: { providerId: 'shell', mode: 'terminal' }, started: false, engineConfig: { schemaVersion: 1, options: {} }, status: 'stopped', archived: false, createdAt: now, updatedAt: now }));
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
  store.change(state => state.sessions.push({ id, projectId: randomUUID(), title: 'guard', kind: 'agent', cwd: root, execution: { providerId: 'claude', mode: 'terminal', conversationId: randomUUID() }, started: true, engineConfig: { schemaVersion: 1, options: { model: '', effort: 'default', permissionMode: 'default' } }, status: 'stopped', archived: false, createdAt: now, updatedAt: now, identityPending: true }));
  const runtime = new Runtime(store, () => {}, () => {}, new ClaudeTerminalLauncher(store, () => ({ available: false, executable: '', version: '', flags: [], efforts: ['default'] })));
  try {
    await assert.rejects(runtime.start(id), /新会话身份尚未确认/);
    store.change(state => { state.sessions[0].identityPending = false; state.sessions[0].observedPermissionMode = 'auto'; });
    await assert.rejects(runtime.start(id), /明确选择/);
    assert.equal(runtime.activeCount, 0);
    assert.equal(store.state.sessions[0].engineConfig.options.permissionMode, 'default');
  } finally { await runtime.shutdown(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

function lifecycleFixture(shellPath = '') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-lifecycle-'));
  const store = new StateStore(path.join(root, 'data')); const now = new Date().toISOString();
  const session: Session = { id: randomUUID(), projectId: randomUUID(), title: 'cleanup fixture', kind: 'shell', cwd: root, execution: { providerId: 'shell', mode: 'terminal' }, started: false, engineConfig: { schemaVersion: 1, options: {} }, status: 'idle', archived: false, createdAt: now, updatedAt: now };
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
    await runtime.whenReleased(f.session.id);
    assert.equal(resourcesClosed, 1);
    await runtime.start(f.session.id);
    callbacks[0].update({ conversationId: 'stale-conversation', engineConfig: { schemaVersion: 1, options: { variant: 'stale' } } });
    callbacks[0].prompt('stale prompt');
    callbacks[0].subtask({ type: 'begin', turnId: 'stale-turn' });
    assert.equal(current().execution.conversationId, 'second-conversation');
    assert.deepEqual(current().engineConfig, { schemaVersion: 1, options: {} });
    assert.equal(current().title, 'cleanup fixture');
    assert.notEqual(current().subtasks?.turnId, 'stale-turn');
    callbacks[1].update({ conversationId: 'third-conversation', engineConfig: { schemaVersion: 1, options: { variant: 'confirmed-current-run' } } });
    callbacks[1].prompt('新的会话标题');
    assert.equal(current().execution.conversationId, 'third-conversation');
    assert.deepEqual(current().engineConfig, { schemaVersion: 1, options: { variant: 'confirmed-current-run' } });
    f.store.flush();
    assert.deepEqual(new StateStore(f.store.directory).state.sessions[0].engineConfig, current().engineConfig);
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
      engineConfig: { schemaVersion: 1, options: {} }, status: 'idle', archived: false, createdAt: now, updatedAt: now }));
    let program = 'process.exit(0)';
    const runtime = new Runtime(store, () => {}, () => {}, { prepare: async () => ({
      file: process.execPath, args: ['-e', program], env: process.env,
    }) });
    try {
      checkpoint('natural-start');
      await runtime.start(id);
      await runtime.whenReleased(id);
      assert.equal(runtime.activeCount, 0, 'natural exit must release its worker');
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
    await assert.rejects(runtime.whenReleased(f.session.id), /资源已释放|清理失败/);
    assert.match(f.store.state.sessions[0].error ?? '', /资源清理失败/);
    await assert.rejects(runtime.shutdown(), /资源已释放/, 'failed resource cleanup cannot be reported as successful on retry');
  } finally {
    await runtime.shutdown().catch(() => {}); await f.runtime.shutdown();
    fs.rmSync(f.root, { recursive: true, force: true });
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
      let released = false;
      const releaseBarrier = runtime.whenReleased(f.session.id).then(() => { released = true; });
      await until(() => fs.existsSync(ready), `${ending} fixture ready`);
      if (ending === 'stop') runtime.stop(f.session.id); else fs.writeFileSync(exit, 'exit');
      await until(() => closing, `${ending} resource close began`);
      assert.equal(f.store.state.sessions[0].status, 'stopping', 'archive and quit must not become available during cleanup');
      assert.equal(runtime.has(f.session.id), true);
      assert.equal(runtime.activeCount, 1);
      assert.deepEqual(finalOwnership, [], 'no stopped/error event may precede cleanup');
      assert.equal(released, false, 'physical release waits for process and launch resources');
      release();
      await releaseBarrier;
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

test('CLI update disconnects real terminals and cancels pending starts without permanently shutting down the runtime', { timeout: 15000 }, async t => {
  const f = lifecycleFixture();
  let phase = 'initial start';
  const failures: { phase: string; error: unknown }[] = [];
  try {
    await f.runtime.start(f.session.id);
    phase = 'maintenance disconnect';
    f.runtime.setMaintenance(true); await f.runtime.disconnectAll();
    phase = 'maintenance release assertions';
    assert.equal(f.runtime.activeCount, 0); assert.equal(f.runtime.pendingCleanupCount, 0);
    await assert.rejects(f.runtime.start(f.session.id), /正在更新/);
    phase = 'restart after maintenance';
    f.runtime.setMaintenance(false); await f.runtime.start(f.session.id);
    assert.equal(f.runtime.activeCount, 1);
  } catch (error) { failures.push({ phase, error }); }
  finally {
    phase = 'final shutdown';
    try {
      await f.runtime.shutdown();
      phase = 'fixture removal';
      fs.rmSync(f.root, { recursive: true, force: true });
    } catch (error) { failures.push({ phase, error }); }
  }
  if (failures.length) {
    // A failed disconnect is retained by Runtime and shutdown reports it again. Preserve both
    // phases and onError causes: the test runner does not print nested Error causes by default.
    t.diagnostic(inspect({ failures, reportedErrors: f.errors, activeCount: f.runtime.activeCount,
      pendingCleanupCount: f.runtime.pendingCleanupCount, sessionStatus: f.store.state.sessions[0].status },
    { depth: 8, maxArrayLength: 20, maxStringLength: 6000, breakLength: 100 }));
    throw new AggregateError(failures.map(failure => failure.error), `CLI update lifecycle failed during ${failures[0].phase}`, { cause: failures[0].error });
  }
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test('session maintenance disconnects Claude while Shell stays interactive and normal capacity still applies', { timeout: 15000 }, async t => {
  const f = lifecycleFixture();
  const claude: Session = { ...f.session, id: randomUUID(), kind: 'agent', execution: { providerId: 'claude', mode: 'terminal' } };
  const spare: Session = { ...f.session, id: randomUUID() };
  f.store.change(state => { state.sessions.push(claude, spare); state.settings.maxSessions = 2; });
  const shell = new ShellTerminalLauncher(f.store);
  const output = new Map<string, string>();
  let claudeClosed = 0;
  let phase = 'starting';
  const failures: unknown[] = [];
  const runtime = new Runtime(f.store, () => {}, chunk => output.set(chunk.sessionId, (output.get(chunk.sessionId) ?? '') + chunk.data), {
    prepare: async session => session.execution.providerId === 'shell' ? shell.prepare(session) : {
      // A resident CLI cancels the current turn on Ctrl-C and keeps its process.
      // Announce readiness after installing the handler; no platform timing guess.
      file: process.execPath, args: ['-e', `
        process.on('SIGINT', () => process.stdout.write('claude-interrupted\\n'));
        process.stdout.write('claude-ready\\n');
        setInterval(() => {}, 1000);
      `], env: environment(),
      resource: { close: async () => { claudeClosed++; } },
    },
  }, { onError: error => t.diagnostic(`PTY maintenance ${phase}: ${inspect(error, { depth: 6 })}`) });
  try {
    await runtime.start(f.session.id); await runtime.start(claude.id);
    const claudeOutput = () => stripVTControlCharacters(output.get(claude.id) ?? '');
    await until(() => claudeOutput().includes('claude-ready'), 'Claude fixture readiness', claudeOutput);
    await assert.rejects(runtime.disconnectSessions([claude.id]), /必须暂停目标会话/);
    runtime.setSessionMaintenance([claude.id], true);
    await assert.rejects(runtime.start(claude.id), /正在更新/);
    assert.throws(() => runtime.write(claude.id, 'input'), /正在更新/);
    assert.throws(() => runtime.resize(claude.id, 120, 40), /正在更新/);
    await assert.rejects(runtime.start(spare.id), /并发会话上限/);
    phase = 'Claude interrupt';
    assert.doesNotThrow(() => runtime.interrupt(claude.id), 'cancellation remains available during maintenance');
    await until(() => claudeOutput().includes('claude-interrupted'), 'Claude interrupt acknowledgement', claudeOutput);
    assert.equal(runtime.has(claude.id), true, 'interrupt cancels the turn while the resident CLI stays connected');
    phase = 'Claude disconnect';
    await runtime.disconnectSessions([claude.id]);
    assert.equal(claudeClosed, 1);
    assert.equal(runtime.has(claude.id), false);
    assert.equal(runtime.has(f.session.id), true);
    assert.equal(f.store.state.sessions.find(session => session.id === f.session.id)?.status, 'running');
    phase = 'Shell interaction';
    runtime.resize(f.session.id, 120, 40);
    runtime.write(f.session.id, process.platform === 'win32' ? "Write-Output ('shell-' + 'survived')\r" : "printf '\\n%s%s\\n' 'shell-' 'survived'\r");
    await until(() => stripVTControlCharacters(output.get(f.session.id) ?? '').includes('shell-survived'), 'Shell input during Claude maintenance');
    phase = 'spare Shell start';
    await runtime.start(spare.id);
    runtime.setSessionMaintenance([claude.id], false);
    await assert.rejects(runtime.start(claude.id), /并发会话上限/);
    phase = 'global shutdown';
    await runtime.shutdown();
    assert.equal(runtime.activeCount, 0); assert.equal(runtime.pendingCleanupCount, 0);
    assert.equal(runtime.lastError, undefined);
    runtime.setSessionMaintenance([claude.id], false); runtime.setMaintenance(false);
    await assert.rejects(runtime.start(claude.id), /正在退出/, 'maintenance release cannot reopen a shutting down runtime');
  } catch (error) { failures.push(error); }
  finally {
    const cleanups = await Promise.allSettled([runtime.shutdown(), f.runtime.shutdown()]);
    for (const result of cleanups) if (result.status === 'rejected') failures.push(result.reason);
    if (failures.length) throw new AggregateError(failures,
      `PTY maintenance failed during ${phase}: ${inspect(failures, { depth: 8 })}`);
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('session maintenance cancels deferred prepare and awaits its resource without waiting for another provider prepare', { timeout: 12000 }, async () => {
  const f = lifecycleFixture();
  const target: Session = { ...f.session, id: randomUUID(), kind: 'agent', execution: { providerId: 'claude', mode: 'terminal' } };
  f.store.change(state => { state.sessions.push(target); state.settings.maxSessions = 2; });
  const targetPrepare = deferred<void>(), shellPrepare = deferred<void>();
  const resourceClosing = deferred<void>(), resourceRelease = deferred<void>();
  let targetClosed = 0;
  const runtime = new Runtime(f.store, () => {}, () => {}, { prepare: async session => {
    await (session.id === target.id ? targetPrepare.promise : shellPrepare.promise);
    return { file: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], env: environment(),
      ...(session.id === target.id ? { resource: { close: async () => {
        resourceClosing.resolve(); await resourceRelease.promise; targetClosed++;
      } } } : {}),
    };
  } });
  const targetStart = assert.rejects(runtime.start(target.id), /已取消启动会话/);
  const shellStart = runtime.start(f.session.id);
  let disconnected = false;
  try {
    runtime.setSessionMaintenance([target.id], true);
    const disconnect = runtime.disconnectSessions([target.id]).then(() => { disconnected = true; });
    // Even a short barrier permanently cancels prepares that crossed it.
    runtime.setSessionMaintenance([target.id], false);
    targetPrepare.resolve(); await resourceClosing.promise;
    assert.equal(disconnected, false, 'cancelled prepare still owns its launch resources');
    assert.equal(runtime.has(target.id), true);
    assert.equal(f.store.state.sessions.find(session => session.id === target.id)?.started, false);
    resourceRelease.resolve();
    await until(() => disconnected, 'target disconnect while Shell prepare remains deferred');
    await disconnect; await targetStart;
    assert.equal(targetClosed, 1); assert.equal(runtime.has(target.id), false);
    assert.equal(runtime.has(f.session.id), true, 'unrelated pending prepare remains admitted');
    shellPrepare.resolve(); await shellStart;
    assert.equal(f.store.state.sessions[0].status, 'running');
  } finally {
    targetPrepare.resolve(); shellPrepare.resolve(); resourceRelease.resolve();
    await Promise.allSettled([targetStart, shellStart]);
    await runtime.shutdown(); await f.runtime.shutdown(); fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('session disconnect awaits selected launcher cleanup and leaves unrelated stopping cleanup owned', { timeout: 16000 }, async () => {
  const f = lifecycleFixture();
  const target: Session = { ...f.session, id: randomUUID(), kind: 'agent', execution: { providerId: 'claude', mode: 'terminal' } };
  f.store.change(state => { state.sessions.push(target); state.settings.maxSessions = 2; });
  const targetClosing = deferred<void>(), targetRelease = deferred<void>();
  const shellClosing = deferred<void>(), shellRelease = deferred<void>();
  const runtime = new Runtime(f.store, () => {}, () => {}, { prepare: async session => ({
    file: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], env: environment(),
    resource: { close: async () => {
      if (session.id === target.id) { targetClosing.resolve(); await targetRelease.promise; }
      else { shellClosing.resolve(); await shellRelease.promise; }
    } },
  }) });
  try {
    await runtime.start(f.session.id); await runtime.start(target.id);
    runtime.stop(f.session.id); await shellClosing.promise;
    runtime.setSessionMaintenance([target.id], true);
    let disconnected = false;
    const disconnect = runtime.disconnectSessions([target.id]).then(() => { disconnected = true; });
    await targetClosing.promise;
    assert.equal(disconnected, false); assert.equal(runtime.has(target.id), true);
    targetRelease.resolve();
    await until(() => disconnected, 'target disconnect while Shell cleanup remains deferred');
    await disconnect;
    assert.equal(runtime.has(target.id), false); assert.equal(runtime.has(f.session.id), true);
    assert.ok(runtime.pendingCleanupCount > 0, 'unrelated launch cleanup remains tracked');
    assert.equal(f.store.state.sessions[0].status, 'stopping');
  } finally {
    targetRelease.resolve(); shellRelease.resolve();
    await runtime.shutdown(); await f.runtime.shutdown(); fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('session disconnect isolates old cleanup faults and drains every selected resource before reporting failures', { timeout: 20000 }, async () => {
  const f = lifecycleFixture();
  const createTarget = (): Session => ({ ...f.session, id: randomUUID(), kind: 'agent', execution: { providerId: 'claude', mode: 'terminal' } });
  const healthy = createTarget(), failed = createTarget(), delayed = createTarget();
  f.store.change(state => { state.sessions.push(healthy, failed, delayed); state.settings.maxSessions = 4; });
  const shellFailure = new Error('Shell cleanup failed'), targetFailure = new Error('Claude cleanup failed');
  const delayedClosing = deferred<void>(), delayedRelease = deferred<void>();
  const closed = new Set<string>();
  const runtime = new Runtime(f.store, () => {}, () => {}, { prepare: async session => ({
    file: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], env: environment(),
    resource: { close: async () => {
      closed.add(session.id);
      if (session.id === f.session.id) throw shellFailure;
      if (session.id === failed.id) throw targetFailure;
      if (session.id === delayed.id) { delayedClosing.resolve(); await delayedRelease.promise; }
    } },
  }) });
  try {
    await runtime.start(f.session.id); await runtime.start(healthy.id);
    runtime.stop(f.session.id);
    await until(() => !runtime.has(f.session.id) && runtime.pendingCleanupCount === 0, 'old Shell cleanup failure');
    assert.equal(runtime.lastError, shellFailure);
    runtime.setSessionMaintenance([healthy.id], true);
    await runtime.disconnectSessions([healthy.id]);
    assert.equal(runtime.has(healthy.id), false, 'a Shell cleanup fault must not reject Claude maintenance');
    await runtime.start(failed.id); await runtime.start(delayed.id);
    runtime.setSessionMaintenance([failed.id, delayed.id], true);
    let settled = false;
    const rejected = assert.rejects(runtime.disconnectSessions([failed.id, delayed.id]), error => {
      assert.ok(error instanceof Error && error.cause instanceof AggregateError);
      assert.ok(error.cause.errors.includes(targetFailure));
      assert.equal(error.cause.errors.includes(shellFailure), false);
      return true;
    }).then(() => { settled = true; });
    await delayedClosing.promise;
    assert.equal(settled, false, 'one failed resource cannot skip another selected resource');
    delayedRelease.resolve(); await rejected;
    assert.ok(closed.has(failed.id) && closed.has(delayed.id));
    assert.equal(runtime.has(failed.id), false); assert.equal(runtime.has(delayed.id), false);
    await assert.rejects(runtime.disconnectSessions([failed.id]), /目标终端进程和资源已释放/, 'a completed target cleanup fault remains fail closed');
    await assert.rejects(runtime.shutdown(), /全部终端进程和资源已释放/, 'global shutdown still sees every provider cleanup fault');
  } finally {
    delayedRelease.resolve(); await runtime.shutdown().catch(() => {}); await f.runtime.shutdown();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('session disconnect reports a launch-resource failure from a cancelled prepare before any PTY spawned', { timeout: 8000 }, async () => {
  const f = lifecycleFixture();
  const prepared = deferred<void>();
  const failure = new Error('Cancelled prepare resource failed');
  const runtime = new Runtime(f.store, () => {}, () => {}, { prepare: async () => {
    await prepared.promise;
    return { file: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], env: environment(),
      resource: { close: async () => { throw failure; } } };
  } });
  const start = assert.rejects(runtime.start(f.session.id), /已取消启动会话/);
  try {
    runtime.setSessionMaintenance([f.session.id], true);
    const disconnected = assert.rejects(runtime.disconnectSessions([f.session.id]), error =>
      error instanceof Error && error.cause instanceof AggregateError && error.cause.errors.includes(failure));
    prepared.resolve(); await Promise.all([start, disconnected]);
    assert.equal(runtime.has(f.session.id), false); assert.equal(runtime.pendingCleanupCount, 0);
    assert.equal(f.store.state.sessions[0].started, false); assert.equal(f.store.state.sessions[0].status, 'error');
    await assert.rejects(runtime.disconnectSessions([f.session.id]), /目标终端进程和资源已释放/);
  } finally {
    prepared.resolve(); await start; await runtime.shutdown().catch(() => {}); await f.runtime.shutdown();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('session disconnect drains all selected PTYs after a state write fails even if storage recovers during cleanup', { timeout: 12000 }, async () => {
  const f = lifecycleFixture();
  const other: Session = { ...f.session, id: randomUUID() };
  f.store.change(state => { state.sessions.push(other); state.settings.maxSessions = 2; });
  const closed = new Set<string>();
  const runtime = new Runtime(f.store, () => {}, () => {}, { prepare: async session => ({
    file: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], env: environment(),
    resource: { close: async () => { closed.add(session.id); } },
  }) });
  try {
    await runtime.start(f.session.id); await runtime.start(other.id);
    runtime.setSessionMaintenance([f.session.id, other.id], true);
    fs.mkdirSync(f.store.file + '.tmp');
    const rejected = assert.rejects(runtime.disconnectSessions([f.session.id, other.id]), /目标终端进程和资源已释放/);
    // Recover before async process cleanup finishes; the failed stop record must
    // still reject this maintenance attempt after every target has drained.
    fs.rmSync(f.store.file + '.tmp', { recursive: true, force: true });
    await rejected;
    assert.deepEqual(closed, new Set([f.session.id, other.id]));
    assert.equal(runtime.activeCount, 0); assert.equal(runtime.pendingCleanupCount, 0);
    await runtime.disconnectSessions([f.session.id, other.id]);
  } finally {
    fs.rmSync(f.store.file + '.tmp', { recursive: true, force: true });
    await runtime.shutdown(); await f.runtime.shutdown(); fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('session disconnect waits for a target descendant after its PTY root exits while Shell remains active', { skip: process.platform === 'win32', timeout: 15000 }, async () => {
  const f = lifecycleFixture();
  const target: Session = { ...f.session, id: randomUUID(), kind: 'agent', execution: { providerId: 'claude', mode: 'terminal' } };
  f.store.change(state => { state.sessions.push(target); state.settings.maxSessions = 2; });
  const rootFile = path.join(f.root, 'target-root'), childFile = path.join(f.root, 'target-child');
  const childCode = `const fs=require('node:fs');process.on('SIGTERM',()=>{});process.on('SIGHUP',()=>{});fs.writeFileSync(${JSON.stringify(childFile)},String(process.pid));setInterval(()=>{},1000);`;
  const rootCode = `const fs=require('node:fs');process.on('SIGTERM',()=>process.exit(0));fs.writeFileSync(${JSON.stringify(rootFile)},String(process.pid));require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'ignore'});setInterval(()=>{},1000);`;
  const runtime = new Runtime(f.store, () => {}, () => {}, { prepare: async session => ({
    file: process.execPath, args: ['-e', session.id === target.id ? rootCode : 'setInterval(()=>{},1000)'], env: environment(),
  }) });
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const processRunning = processIsRunning;
  let rootPid = 0, childPid = 0;
  try {
    await runtime.start(f.session.id); await runtime.start(target.id);
    await until(() => fs.existsSync(rootFile) && fs.existsSync(childFile), 'target descendant ready');
    rootPid = Number(fs.readFileSync(rootFile, 'utf8')); childPid = Number(fs.readFileSync(childFile, 'utf8'));
    runtime.setSessionMaintenance([target.id], true);
    let disconnected = false;
    const disconnect = runtime.disconnectSessions([target.id]).then(() => { disconnected = true; });
    await until(() => !alive(rootPid), 'target PTY root exit');
    assert.equal(await processRunning(childPid), true);
    assert.equal(disconnected, false, 'root exit does not release target descendant ownership');
    assert.equal(runtime.has(target.id), true); assert.equal(runtime.has(f.session.id), true);
    await disconnect;
    let childRunning = await processRunning(childPid);
    for (let attempts = 0; childRunning && attempts < 40; attempts++) {
      await new Promise(resolve => setTimeout(resolve, 25)); childRunning = await processRunning(childPid);
    }
    assert.equal(childRunning, false);
    assert.equal(runtime.has(target.id), false); assert.equal(runtime.has(f.session.id), true);
  } finally {
    for (const pid of [childPid, rootPid]) if (pid && alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* Already gone. */ } }
    await runtime.shutdown(); await f.runtime.shutdown(); fs.rmSync(f.root, { recursive: true, force: true });
  }
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
  const processRunning = processIsRunning;
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

test('natural PTY root exit kills surviving descendants before whenReleased resolves', { skip: process.platform === 'win32', timeout: 12000 }, async () => {
  const f = lifecycleFixture();
  const childFile = path.join(f.root, 'natural-child'), exitFile = path.join(f.root, 'natural-exit');
  const childCode = `require('node:fs').writeFileSync(${JSON.stringify(childFile)},String(process.pid));process.on('SIGTERM',()=>{});process.on('SIGHUP',()=>{});setInterval(()=>{},1000);`;
  const rootCode = `const fs=require('node:fs');require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'ignore'});setInterval(()=>{if(fs.existsSync(${JSON.stringify(exitFile)}))process.exit(0)},10);`;
  const runtime = new Runtime(f.store, () => {}, () => {}, { prepare: async () => ({ file: process.execPath, args: ['-e', rootCode], env: environment() }) });
  let childPid = 0;
  try {
    await runtime.start(f.session.id);
    await until(() => fs.existsSync(childFile), 'natural descendant ready');
    childPid = Number(fs.readFileSync(childFile, 'utf8'));
    let released = false;
    const barrier = runtime.whenReleased(f.session.id).then(() => { released = true; });
    fs.writeFileSync(exitFile, 'exit');
    await until(() => f.store.state.sessions[0].status === 'stopping', 'natural root exit');
    assert.equal(await processIsRunning(childPid), true);
    assert.equal(runtime.has(f.session.id), true);
    assert.equal(released, false);
    await barrier;
    assert.equal(await processIsRunning(childPid), false);
    assert.equal(runtime.has(f.session.id), false);
    await runtime.stopAndWait(f.session.id);
  } finally {
    if (childPid && await processIsRunning(childPid)) process.kill(childPid, 'SIGKILL');
    await runtime.shutdown(); await f.runtime.shutdown();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('shutdown cancels and awaits a CLI start that is still resolving transcript and hook state', { timeout: 10000 }, async () => {
  const f = lifecycleFixture();
  try {
    f.store.change(state => { state.sessions[0].kind = 'agent'; state.sessions[0].execution = { providerId: 'claude', mode: 'terminal', conversationId: randomUUID() }; state.sessions[0].engineConfig = { schemaVersion: 1, options: { model: '', effort: 'default', permissionMode: 'default' } }; state.settings.claudePath = process.execPath; });
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
      f.store.change(state => { state.sessions[0].kind = 'agent'; state.sessions[0].execution = { providerId: 'claude', mode: 'terminal', conversationId: randomUUID() }; state.sessions[0].engineConfig = { schemaVersion: 1, options: { model: '', effort: 'default', permissionMode: 'default' } }; state.sessions[0].titleSource = ending === 'stop' ? 'default' : 'manual'; state.settings.claudePath = script; });
      f.setCapabilities({ available: true, executable: script, version: '2.1.278',
        flags: ['--session-id', '--permission-mode', '--settings'], efforts: ['default'] });
      await f.runtime.start(f.session.id);
      const session = () => f.store.state.sessions[0];
      await until(() => session().taskState === 'completed' && session().subtasks?.tasks.length === 2,
        `hooked children (${ending})`, () => f.runtime.exportLogs(f.session.id));
      assert.equal(session().engineConfig.options.permissionMode, 'default', 'child modes never overwrite main launch settings');
      assert.equal(session().title, ending === 'stop' ? '检查界面与接口' : 'cleanup fixture');
      assert.equal(session().titleSource, ending === 'stop' ? 'auto' : 'manual');
      assert.deepEqual(session().subtasks?.tasks.map(task => task.status), ['completed', 'running']);
      if (ending === 'crash') {
        fs.writeFileSync(crash, 'exit');
        await f.runtime.whenReleased(f.session.id);
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
