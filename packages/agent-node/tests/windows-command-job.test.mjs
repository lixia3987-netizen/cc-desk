import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import childProcess, { spawn } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { buildWindowsCommandJobScript, connectWindowsCommandJob, createWindowsCommandJob, WindowsCommandJobError } from '../dist/windows-command-job.js';
import { commandEnvironment } from '../dist/process-supervisor.js';

const nonce = 'a'.repeat(64);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const live = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
const exists = file => fs.stat(file).then(() => true, () => false);
const powershell = path.join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const helperClosures = new WeakMap();
async function until(predicate, message, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) { assert.ok(Date.now() < deadline, message); await delay(10); }
}
async function bounded(promise, message, timeoutMs = 5000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}
const emit = value => `process.stdout.write(${JSON.stringify(JSON.stringify(value) + '\n')});`;
function fakeHelper(body) {
  return spawn(process.execPath, ['-e', `const readline=require('node:readline');const lines=readline.createInterface({input:process.stdin});${body}`], { stdio: ['pipe', 'pipe', 'pipe'] });
}
function options(overrides = {}) { return { guardianPid: 123, challenge: async () => {}, timeoutMs: 2000, environment: {}, ...overrides }; }
const ready = emit({ type: 'ready' });
const result = emit({ type: 'result', released: true, code: 'released', stage: 'query', nativeCode: 0, activeProcesses: 0 });
const held = emit({ type: 'held', nonce });

test('missing, ambiguous, or nonlocal absolute SystemRoot never starts a helper through PATH or cwd', async () => {
  const originalSpawn = childProcess.spawn;
  let spawns = 0;
  childProcess.spawn = () => { spawns++; throw new Error('An invalid helper path must not reach spawn.'); };
  syncBuiltinESMExports();
  try {
    const environments = [
      {}, { PATH: process.cwd() }, { SystemRoot: '' }, { SystemRoot: 'Windows' },
      { SystemRoot: 'C:Windows' }, { SystemRoot: '\\Windows' }, { SystemRoot: '/Windows' },
      { SystemRoot: '\\\\server\\share\\Windows' }, { SystemRoot: '\\\\?\\C:\\Windows' },
      { SystemRoot: 'C:\\Windows\0' }, { SystemRoot: 'C:\\Windows\r\n' },
      { SystemRoot: 'C:\\Windows', SYSTEMROOT: 'D:\\Windows' },
    ];
    for (const environment of environments) await assert.rejects(
      async () => createWindowsCommandJob(options({ environment })),
      error => error instanceof WindowsCommandJobError && error.diagnostic.code === 'spawn_error' && error.diagnostic.stage === 'compile',
    );
    assert.equal(spawns, 0, 'no rejected path may resolve powershell.exe against an ambient directory');
  } finally { childProcess.spawn = originalSpawn; syncBuiltinESMExports(); }
});

test('helper executable uses only the supplied case-insensitive fully qualified Windows root', async () => {
  const originalSpawn = childProcess.spawn;
  const environment = { sYsTeMrOoT: 'D:\\Windows', PATH: 'untrusted-project-directory' };
  const controller = new AbortController();
  let spawnedPath, spawnedEnvironment, closed;
  childProcess.spawn = (executable, _argv, options) => {
    spawnedPath = executable; spawnedEnvironment = options.env;
    const helper = new EventEmitter();
    helper.stdin = new PassThrough(); helper.stdout = new PassThrough(); helper.stderr = new PassThrough();
    helper.kill = () => { queueMicrotask(() => helper.emit('close', null)); return true; };
    return helper;
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(createWindowsCommandJob(options({ environment, signal: controller.signal, onHelper: (_helper, barrier) => { closed = barrier; controller.abort(); } })), error => error instanceof WindowsCommandJobError && error.diagnostic.code === 'cancelled');
    await bounded(closed, 'Mock helper must close after abort.');
    assert.equal(spawnedPath, 'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    assert.equal(spawnedEnvironment, environment);
  } finally { childProcess.spawn = originalSpawn; syncBuiltinESMExports(); }
});

test('job binding waits for the original IPC challenge and release waits for physical helper close', async () => {
  let accept;
  const challenge = new Promise(resolve => { accept = resolve; });
  let reachedChallenge = false, helperClosed = false, initialized = false;
  const bootstrap = emit({ type: 'progress', stage: 'compile' }) + emit({ type: 'progress', stage: 'compile', modulesLoaded: true });
  const helper = fakeHelper(`${bootstrap}${held}let bound=false;lines.on('line',line=>{if(!bound){if(line!==${JSON.stringify('bind ' + nonce)})process.exit(4);bound=true;${ready}}else{${result}setTimeout(()=>process.exit(0),120);}});`);
  const preparing = connectWindowsCommandJob(options({ challenge: async received => { assert.equal(received, nonce); reachedChallenge = true; await challenge; }, onHelper: (_helper, closed) => { void closed.then(() => { helperClosed = true; }); } }), helper, nonce);
  void preparing.then(() => { initialized = true; });
  try {
    await until(() => reachedChallenge, 'helper must hold the guardian before the challenge');
    assert.equal(initialized, false);
    accept();
    const job = await preparing;
    assert.equal(job.diagnostic.stage, 'active');
    assert.equal(job.diagnostic.modulesLoaded, true);
    const stopping = job.stop(1000);
    await delay(50);
    assert.equal(helperClosed, false, 'the emitted empty-job result is not a physical close');
    assert.equal(job.closed, false);
    assert.equal(await stopping, true);
    assert.equal(helperClosed, true);
    assert.equal(await job.stop(1000), true);
  } finally { helper.kill('SIGKILL'); }
});

test('binding rejection, abort, and deadline never send the bind authorization', async t => {
  for (const mode of ['rejection', 'abort', 'deadline']) await t.test(mode, async () => {
    const controller = new AbortController();
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'job-bind-'));
    const marker = path.join(directory, 'bound');
    const helper = fakeHelper(`${held}lines.on('line',()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'unauthorized'));`);
    let close;
    try {
      const preparing = connectWindowsCommandJob(options({ timeoutMs: mode === 'deadline' ? 150 : 2000, signal: controller.signal, onHelper: (_helper, closed) => { close = closed; }, challenge: async () => {
        if (mode === 'rejection') throw new Error('opaque original IPC error must not leak');
        if (mode === 'abort') controller.abort();
        await new Promise(() => {});
      } }), helper, nonce);
      await assert.rejects(preparing, error => error instanceof WindowsCommandJobError && error.diagnostic.code === ({ rejection: 'ownership_unconfirmed', abort: 'cancelled', deadline: 'timeout' })[mode] && !error.message.includes('opaque'));
      await close;
      assert.equal(await exists(marker), false);
    } finally { helper.kill('SIGKILL'); await fs.rm(directory, { recursive: true, force: true }); }
  });
});

test('helper crash after binding and forged release evidence fail closed', async t => {
  for (const mode of ['crash', 'nonzero_count', 'wrong_stage', 'unsolicited_release']) await t.test(mode, async () => {
    const invalidResult = emit({ type: 'result', released: true, code: 'released', stage: mode === 'wrong_stage' ? 'active' : 'query', nativeCode: 0, activeProcesses: mode === 'nonzero_count' ? 1 : 0 });
    const helper = fakeHelper(`${held}let bound=false;lines.on('line',()=>{if(!bound){bound=true;${ready}${mode === 'unsolicited_release' ? invalidResult + 'process.exit(0);' : ''}}else{${mode === 'crash' ? '' : invalidResult}process.exit(0);}});`);
    try {
      const job = await connectWindowsCommandJob(options(), helper, nonce);
      if (mode === 'unsolicited_release') await job.whenClosed;
      assert.equal(await job.stop(1000), false);
      assert.notEqual(job.diagnostic.code, 'released');
      await job.whenClosed;
    } finally { helper.kill('SIGKILL'); }
  });
});

test('a stop timeout stays unconfirmed and its helper remains tracked until close', async () => {
  const helper = fakeHelper(`${held}setInterval(()=>{},1000);lines.once('line',()=>{${ready}});`);
  let tracked;
  try {
    const job = await connectWindowsCommandJob(options({ onHelper: (_helper, closed) => { tracked = closed; } }), helper, nonce);
    assert.equal(await job.stop(50), false);
    await tracked;
    assert.equal(job.closed, true);
    assert.equal(await job.stop(1000), false);
    assert.equal(job.diagnostic.code, 'timeout');
  } finally { helper.kill('SIGKILL'); }
});

test('ready followed by malformed or failed result in the same chunk revokes launch authorization', async t => {
  for (const suffix of ['invalid-json', JSON.stringify({ type: 'result', released: false, code: 'bind_failed', stage: 'bind', nativeCode: 5, activeProcesses: 0 })]) await t.test(suffix.startsWith('{') ? 'failed result' : 'malformed', async () => {
    const combined = `${JSON.stringify({ type: 'ready' })}\n${suffix}\n`;
    const helper = fakeHelper(`${held}lines.once('line',()=>{process.stdout.write(${JSON.stringify(combined)});});`);
    try {
      const job = await connectWindowsCommandJob(options(), helper, nonce);
      assert.equal(job.usable, false, 'awaiting the earlier ready must not authorize launching after a same-chunk failure');
      assert.equal(await job.stop(1000), false);
      await bounded(job.whenClosed, 'Invalid helper must close.');
    } finally { helper.kill('SIGKILL'); }
  });
});

test('an observed helper exit revokes authorization before its inherited streams close', async () => {
  const helper = new EventEmitter();
  helper.stdout = new PassThrough(); helper.stderr = new PassThrough(); helper.stdin = new PassThrough(); helper.kill = () => true;
  const preparing = connectWindowsCommandJob(options(), helper, nonce);
  helper.stdout.write(JSON.stringify({ type: 'held', nonce }) + '\n');
  await until(() => helper.stdin.readableLength > 0, 'challenge must authorize binding');
  helper.stdout.write(JSON.stringify({ type: 'ready' }) + '\n');
  const job = await preparing;
  assert.equal(job.usable, true);
  helper.emit('exit', 0);
  assert.equal(job.closed, false);
  assert.equal(job.usable, false);
  helper.emit('close', 0);
  assert.equal(await job.stop(1000), false);
});

const guardianSource = `
const {spawn}=require('node:child_process');
process.on('message',message=>{
 if(message.type==='challenge'){process.send({type:'challenge',nonce:message.nonce});return;}
 if(message.type==='launch'){
  const child=spawn(process.execPath,['-e',message.script],{stdio:'ignore',windowsHide:true});
  child.once('spawn',()=>process.send({type:'command',pid:child.pid}));
  child.once('exit',()=>process.send({type:'command-exit'}));
 }
});
process.on('disconnect',()=>process.exit(0));
`;
function guardian(directory) {
  const child = spawn(process.execPath, ['-e', guardianSource], { cwd: directory, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  let closed = false, spawnError;
  child.on('error', error => { spawnError = error; });
  const whenClosed = new Promise(resolve => child.once('close', () => { closed = true; resolve(); }));
  const challenge = nonce => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error('Original guardian did not answer.')), 3000);
    const listener = value => { if (value.type === 'challenge' && value.nonce === nonce) finish(); };
    function finish(error) { clearTimeout(timeout); child.off('message', listener); error ? reject(error) : resolve(); }
    child.on('message', listener);
    child.send({ type: 'challenge', nonce }, error => { if (error) finish(error); });
  });
  return { child, challenge, whenClosed, get closed() { return closed; }, get spawnError() { return spawnError; } };
}
async function startJob(root, options = {}) {
  return createWindowsCommandJob({ guardianPid: root.child.pid, challenge: root.challenge, timeoutMs: 10_000, environment: process.env, ...options,
    onHelper: (helper, closed) => { helperClosures.set(helper, closed); options.onHelper?.(helper, closed); },
  });
}
function commandExit(root) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Fixture command did not exit within its deadline.')), 5000);
    const listener = message => { if (message.type === 'command-exit') finish(); };
    const exited = () => finish(new Error('Fixture guardian exited before the command result.'));
    const failed = () => finish(new Error('Fixture guardian failed before the command result.'));
    function finish(error) {
      clearTimeout(timer);
      root.child.off('message', listener); root.child.off('exit', exited); root.child.off('error', failed);
      error ? reject(error) : resolve();
    }
    root.child.on('message', listener); root.child.once('exit', exited); root.child.once('error', failed);
    if (root.closed || root.child.exitCode !== null || root.child.signalCode !== null) exited();
    else if (root.spawnError) failed();
  });
}
async function stopFixture(root, job, helper) {
  const failures = [];
  try { if (job) await bounded(job.stop(5000), 'Fixture job stop did not settle.', 6000); }
  catch (error) { failures.push(error); }
  finally {
    // These are the original owned ChildProcess handles, never cached-PID kills.
    try { helper?.kill('SIGKILL'); } catch (error) { failures.push(error); }
    try { root.child.kill('SIGKILL'); } catch (error) { failures.push(error); }
    try { await bounded(root.whenClosed, 'Fixture guardian did not physically close.'); } catch (error) { failures.push(error); }
    try {
      const helperClosed = job?.whenClosed ?? (helper && helperClosures.get(helper));
      if (helperClosed) await bounded(helperClosed, 'Fixture helper did not physically close.');
    } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, 'Windows job fixture cleanup failed.');
}
async function finishFixtures(directory, fixtures, originalFailure) {
  const results = await Promise.allSettled(fixtures.map(fixture => stopFixture(...fixture)));
  const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
  try { await fs.rm(directory, { recursive: true, force: true }); } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(originalFailure ? [originalFailure, ...failures] : failures, 'Windows job fixture failed; original and cleanup errors are retained.');
}

test('Windows job releases a detached double-fork whose intermediate parent exited before cleanup', { skip: process.platform !== 'win32', timeout: 35_000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-win-job-fork-'));
  const root = guardian(directory);
  const middlePidFile = path.join(directory, 'middle.pid');
  const grandchildPidFile = path.join(directory, 'grandchild.pid');
  const heartbeat = path.join(directory, 'heartbeat');
  const grandchild = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(grandchildPidFile)},String(process.pid));setInterval(()=>fs.writeFileSync(${JSON.stringify(heartbeat)},String(Date.now())),20);`;
  const middle = `require('node:fs').writeFileSync(${JSON.stringify(middlePidFile)},String(process.pid));const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{detached:true,stdio:'ignore',windowsHide:true});child.once('spawn',()=>process.exit(0));child.unref();`;
  const command = `const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(middle)}],{stdio:'ignore',windowsHide:true});child.once('close',()=>{const timer=setInterval(()=>{if(require('node:fs').existsSync(${JSON.stringify(heartbeat)})){clearInterval(timer);process.exit(0)}},10)});`;
  let job, helper, originalFailure;
  try {
    job = await startJob(root, { onHelper: child => { helper = child; } });
    const exited = commandExit(root);
    root.child.send({ type: 'launch', script: command });
    await exited;
    const middlePid = Number(await fs.readFile(middlePidFile, 'utf8'));
    const grandchildPid = Number(await fs.readFile(grandchildPidFile, 'utf8'));
    assert.equal(live(middlePid), false, 'the missing ancestor must already be gone before cleanup starts');
    assert.equal(live(grandchildPid), true, 'libuv detached descendant must survive its immediate parent');
    assert.equal(await job.stop(10_000), true, JSON.stringify(job.diagnostic));
    await bounded(root.whenClosed, 'Released guardian must physically close.');
    assert.equal(live(grandchildPid), false);
    const lastBeat = await fs.readFile(heartbeat, 'utf8');
    await delay(100);
    assert.equal(await fs.readFile(heartbeat, 'utf8'), lastBeat);
    assert.equal(job.diagnostic.activeProcesses, 0);
    assert.equal(job.closed, true);
  } catch (error) { originalFailure = error; throw error; }
  finally { await finishFixtures(directory, [[root, job, helper]], originalFailure); }
});

test('Windows job helper crash stops its descendants but cannot release or terminate another owner', { skip: process.platform !== 'win32', timeout: 35_000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-win-job-owners-'));
  const a = guardian(directory), b = guardian(directory);
  const marker = path.join(directory, 'owned.pid');
  let jobA, jobB, helperA, helperB, originalFailure;
  try {
    [jobA, jobB] = await Promise.all([
      startJob(a, { onHelper: child => { helperA = child; } }),
      startJob(b, { onHelper: child => { helperB = child; } }),
    ]);
    a.child.send({ type: 'launch', script: `require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000);` });
    await until(() => exists(marker), 'owned process must start');
    const pid = Number(await fs.readFile(marker, 'utf8'));
    helperA.kill('SIGKILL');
    await bounded(jobA.whenClosed, 'Killed helper must physically close.');
    assert.equal(await jobA.stop(1000), false, 'a crashed helper supplied no empty-job proof');
    await until(() => !live(pid) && a.closed, 'KILL_ON_JOB_CLOSE must still stop the crashed owner');
    assert.equal(live(b.child.pid), true);
    assert.equal(await jobB.stop(10_000), true, JSON.stringify(jobB.diagnostic));
    await bounded(b.whenClosed, 'Other released guardian must physically close.');
  } catch (error) { originalFailure = error; throw error; }
  finally { await finishFixtures(directory, [[a, jobA, helperA], [b, jobB, helperB]], originalFailure); }
});

test('Windows assignment failure keeps the command unlaunched and returns bounded diagnostics', { skip: process.platform !== 'win32', timeout: 20_000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-win-job-bind-'));
  const root = guardian(directory);
  const marker = path.join(directory, 'launched');
  let helper, helperClosed, originalFailure;
  try {
    const script = buildWindowsCommandJobScript(root.child.pid, nonce, 10_000).replace('// windows-command-job:before-assign', 'if(guardian!=IntPtr.Zero){throw new InvalidOperationException();} // forced assignment failure');
    helper = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { env: process.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const preparing = connectWindowsCommandJob({ guardianPid: root.child.pid, challenge: root.challenge, timeoutMs: 10_000, environment: process.env, onHelper: (child, closed) => { helperClosed = closed; helperClosures.set(child, closed); } }, helper, nonce);
    await assert.rejects(async () => {
      await preparing;
      root.child.send({ type: 'launch', script: `require('node:fs').writeFileSync(${JSON.stringify(marker)},'must not execute');` });
    }, error => error instanceof WindowsCommandJobError && error.diagnostic.code === 'bind_failed' && error.diagnostic.stage === 'bind');
    await bounded(helperClosed, 'Rejected helper must physically close.');
    assert.equal(await exists(marker), false);
    assert.equal(live(root.child.pid), true, 'an unassigned guardian stays owned by its original Node process handle');
  } catch (error) { originalFailure = error; throw error; }
  finally { await finishFixtures(directory, [[root, undefined, helper]], originalFailure); }
});

test('Windows abort during held-handle challenge leaves the unlaunched guardian outside the job', { skip: process.platform !== 'win32', timeout: 20_000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-win-job-abort-'));
  const root = guardian(directory);
  const controller = new AbortController();
  let helper, helperClosed, originalFailure, challengeReached = false;
  try {
    await assert.rejects(startJob(root, {
      signal: controller.signal,
      onHelper: (child, closed) => { helper = child; helperClosed = closed; },
      challenge: async value => {
        await root.challenge(value);
        challengeReached = true;
        controller.abort();
      },
    }), error => error instanceof WindowsCommandJobError && error.diagnostic.code === 'cancelled');
    await bounded(helperClosed, 'Cancelled helper must physically close.');
    assert.equal(challengeReached, true, 'cancel must exercise the real held guardian HANDLE');
    assert.equal(live(root.child.pid), true, 'cancellation must occur before Assign can authorize launch');
  } catch (error) { originalFailure = error; throw error; }
  finally { await finishFixtures(directory, [[root, undefined, helper]], originalFailure); }
});

test('Windows job loads its built-in compiler with the production filtered environment', { skip: process.platform !== 'win32', timeout: 30_000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-win-job-env-'));
  const root = guardian(directory);
  let job, helper, originalFailure;
  try {
    const environment = commandEnvironment({ ...process.env, PSModulePath: directory });
    assert.equal(Object.keys(environment).some(key => key.toUpperCase() === 'PSMODULEPATH'), false);
    job = await startJob(root, { environment, onHelper: child => { helper = child; } });
    assert.equal(job.diagnostic.modulesLoaded, true, 'explicit system module load must finish before binding');
    assert.equal(job.usable, true);
    assert.equal(await job.stop(10_000), true, JSON.stringify(job.diagnostic));
    await bounded(root.whenClosed, 'Filtered-environment guardian must physically close.');
  } catch (error) { originalFailure = error; throw error; }
  finally { await finishFixtures(directory, [[root, job, helper]], originalFailure); }
});
