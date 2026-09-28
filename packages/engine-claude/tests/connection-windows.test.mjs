import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import childProcess, { spawn, execFile } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';
import { promisify } from 'node:util';
import { windowsTreeCleanupScript, stopWindowsTree } from '../dist/connection.js';

const execFileAsync = promisify(execFile);
const psQuote = value => "'" + value.replaceAll("'", "''") + "'";
const pause = () => new Promise(resolve => setTimeout(resolve, 10));
const exists = file => fs.stat(file).then(() => true, () => false);
const live = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
async function until(condition, phase, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!await condition()) { assert.ok(Date.now() < deadline, phase); await pause(); }
}

// Use the production ownership handshake even when injecting a race checkpoint.
// The bridge is restored immediately after synchronous helper creation; all
// process handles, challenge transport and exit barriers remain production code.
function runOwnedCleanup(root, startedAt, spawnedAt, transform, onHelperClose) {
  const originalExecFile = childProcess.execFile;
  let failurePhase;
  childProcess.execFile = (executable, argv, options, callback) => originalExecFile(
    executable, [...argv.slice(0, -1), transform(argv.at(-1))], options,
    (error, stdout, stderr) => {
      failurePhase = stderr.match(/CLAUDE_TREE_CLEANUP_FAILED:([a-z_]{1,48})/)?.[1]
        ?? (error?.killed ? 'helper_timeout' : 'helper_failed');
      onHelperClose?.(error ? failurePhase : undefined);
      callback(error, stdout, stderr);
    });
  syncBuiltinESMExports();
  let cleaning;
  try { cleaning = stopWindowsTree(root, false, startedAt, spawnedAt); }
  finally { childProcess.execFile = originalExecFile; syncBuiltinESMExports(); }
  return cleaning.then(released => {
    if (!released) {
      const marker = `CLAUDE_TREE_CLEANUP_FAILED:${failurePhase ?? 'helper_failed'}`;
      throw Object.assign(new Error(marker), { stderr: marker });
    }
  });
}

async function untilCleanupCheckpoint(condition, phase, cleaning) {
  let settled = false, failure;
  void cleaning.then(() => { settled = true; }, error => { settled = true; failure = error; });
  await until(async () => {
    if (await condition()) return true;
    if (settled) throw failure ?? new Error(`${phase}: cleanup ended before the checkpoint`);
    return false;
  }, phase, 8000);
}

test('root confirmation uses the original process handle only after the helper reports its held handle', async t => {
  for (const confirm of [true, false]) await t.test(confirm ? 'confirm' : 'reject', async () => {
    const originalExecFile = childProcess.execFile;
    const originalWarning = console.warn;
    let held = false, probes = 0, reply = '', warning = '';
    childProcess.execFile = (_executable, argv, _options, callback) => {
      const nonce = argv.at(-1).match(/CLAUDE_ROOT_HELD:([a-f0-9-]{36})/)?.[1];
      assert.ok(nonce);
      const helper = { stdout: new PassThrough(), stdin: new PassThrough() };
      helper.stdin.on('data', data => { reply += data.toString(); });
      helper.stdin.on('finish', () => {
        assert.equal(reply, `${confirm ? 'confirm' : 'reject'}:${nonce}\n`);
        callback(confirm ? null : new Error('raw command must not be logged'), '', confirm ? '' : 'CLAUDE_TREE_CLEANUP_FAILED:confirm_original_root');
      });
      queueMicrotask(() => {
        held = true;
        helper.stdout.write(`CLAUDE_ROOT_HELD:${nonce.slice(0, 12)}`);
        helper.stdout.write(`${nonce.slice(12)}\r\n`);
      });
      return helper;
    };
    console.warn = value => { warning += value; };
    syncBuiltinESMExports();
    try {
      const original = { pid: 123, kill(signal) { assert.equal(held, true); assert.equal(signal, 0); probes++; return confirm; } };
      assert.equal(await stopWindowsTree(original, false, 1000, 1001), confirm);
      assert.equal(probes, 1);
      assert.equal(warning.includes('raw command'), false);
      if (!confirm) assert.match(warning, /confirm_original_root/);
    } finally { childProcess.execFile = originalExecFile; syncBuiltinESMExports(); console.warn = originalWarning; }
  });
});

test('Windows cleanup retries only an observed original exit before root confirmation and preserves later failures', async t => {
  const cases = [
    { name: 'exit code zero after failed open', phase: 'open_root_handle', exitCode: 0, attempts: 2, released: true },
    { name: 'original signal after failed confirmation', phase: 'confirm_original_root', signalCode: 'SIGKILL', attempts: 2, released: true },
    { name: 'live original remains unconfirmed', phase: 'open_root_handle', attempts: 1, released: false },
    { name: 'missing original exit information is unconfirmed', phase: 'confirm_original_root', unknown: true, attempts: 1, released: false },
    { name: 'an exited original cannot excuse descendant inspection failure', phase: 'verify_known_identity', exitCode: 0, attempts: 1, released: false },
    { name: 'the tombstone scan must itself prove release', phase: 'open_root_handle', exitCode: 0, retryFailure: true, attempts: 2, released: false },
  ];
  for (const scenario of cases) await t.test(scenario.name, async () => {
    const originalExecFile = childProcess.execFile, originalWarning = console.warn;
    const original = { pid: 123, kill() { return false; }, ...(scenario.unknown ? {} : { exitCode: null, signalCode: null }) };
    let calls = 0, firstClosed = false, firstTimeout, warning = '';
    childProcess.execFile = (_executable, argv, options, callback) => {
      calls++;
      const script = argv.at(-1);
      if (calls === 1) {
        firstTimeout = options.timeout;
        assert.match(script, /CLAUDE_ROOT_HELD:/);
      } else {
        assert.equal(firstClosed, true, 'a second cleaner must wait for the first helper close callback');
        assert.equal(calls, 2, 'recovery is bounded to one tombstone scan');
        assert.match(script, /\$rootExited=\$true/);
        assert.doesNotMatch(script, /CLAUDE_ROOT_HELD:/);
        assert.ok(options.timeout > 0 && options.timeout <= firstTimeout && firstTimeout <= 8000);
      }
      queueMicrotask(() => {
        if (calls === 1) {
          if (scenario.exitCode !== undefined) original.exitCode = scenario.exitCode;
          if (scenario.signalCode !== undefined) original.signalCode = scenario.signalCode;
          firstClosed = true;
          callback(new Error('raw helper command'), '', `CLAUDE_TREE_CLEANUP_FAILED:${scenario.phase}`);
        } else callback(scenario.retryFailure ? new Error('raw retry command') : null, '', scenario.retryFailure ? 'CLAUDE_TREE_CLEANUP_FAILED:verify_known_identity' : '');
      });
      return { stdout: new PassThrough(), stdin: new PassThrough() };
    };
    console.warn = value => { warning += value; };
    syncBuiltinESMExports();
    try {
      assert.equal(await stopWindowsTree(original, false, 1000, 1001), scenario.released);
      assert.equal(calls, scenario.attempts);
      assert.equal(warning.includes('raw'), false);
      if (scenario.released) assert.equal(warning, '');
      if (scenario.retryFailure) assert.match(warning, /verify_known_identity/);
    } finally { childProcess.execFile = originalExecFile; syncBuiltinESMExports(); console.warn = originalWarning; }
  });
});

test('Windows cleanup discovers a new grandchild through an exited parent after its first snapshot', { skip: process.platform !== 'win32', timeout: 25000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-win-tree-'));
  const childReady = path.join(directory, 'child.pid');
  const grandchildReady = path.join(directory, 'grandchild.pid');
  const forkGate = path.join(directory, 'fork');
  const captured = path.join(directory, 'captured');
  const resume = path.join(directory, 'resume');
  const record = file => `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(file)}+'.tmp',String(process.pid));fs.renameSync(${JSON.stringify(file)}+'.tmp',${JSON.stringify(file)});`;
  const grandchild = `${record(grandchildReady)}setInterval(()=>{},1000);`;
  // Exactly two descendants. The child forks only after the first cleanup
  // snapshot, then exits before that snapshot is allowed to signal anything.
  // Windows libuv kills non-detached children when their parent exits. Detach
  // this one so the cleanup helper, rather than that job policy, must stop it.
  const child = `${record(childReady)}const poll=setInterval(()=>{if(!fs.existsSync(${JSON.stringify(forkGate)}))return;clearInterval(poll);const spawned=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore',detached:true,windowsHide:true});spawned.once('spawn',()=>process.exit(0));spawned.unref()},10);`;
  const rootScript = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'ignore'}).unref();setInterval(()=>{},1000);`;
  const startedAt = Date.now();
  const root = spawn(process.execPath, ['-e', rootScript], { cwd: directory, stdio: 'ignore', windowsHide: true });
  const spawnedAt = Date.now();
  const powershell = path.join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const run = script => execFileAsync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 8000, maxBuffer: 8192 });
  let cleaning;
  try {
    await until(() => exists(childReady), 'fixture child must start');
    const childPid = Number(await fs.readFile(childReady, 'utf8'));
    assert.ok(Number.isSafeInteger(childPid) && childPid > 1 && live(childPid));
    assert.equal(await exists(grandchildReady), false);
    cleaning = runOwnedCleanup(root, startedAt, spawnedAt, script => script.replace(
      '$all=@(Get-CimInstance Win32_Process)',
      `$all=@(Get-CimInstance Win32_Process)
  if(!(Test-Path -LiteralPath ${psQuote(captured)})) {
    [IO.File]::WriteAllText(${psQuote(captured)},'captured')
    $handshakeDeadline=[DateTime]::UtcNow.AddSeconds(3)
    while(!(Test-Path -LiteralPath ${psQuote(resume)})) {
      if([DateTime]::UtcNow -ge $handshakeDeadline) { throw 'Fixture snapshot handshake timed out.' }
      Start-Sleep -Milliseconds 10
    }
  }`));
    // Attach rejection immediately, then still require the original promise below.
    void cleaning.catch(() => {});
    await untilCleanupCheckpoint(() => exists(captured), 'cleanup must capture the original tree', cleaning);
    await fs.writeFile(forkGate, 'fork');
    await until(() => exists(grandchildReady), 'a new grandchild must be born after the snapshot');
    const grandchildPid = Number(await fs.readFile(grandchildReady, 'utf8'));
    assert.ok(Number.isSafeInteger(grandchildPid) && grandchildPid > 1 && live(grandchildPid));
    await until(() => !live(childPid), 'known parent must exit before cleanup resumes');
    await fs.writeFile(resume, 'continue');
    await cleaning;
    assert.equal(live(root.pid), false);
    assert.equal(live(childPid), false);
    assert.equal(live(grandchildPid), false, 'retained parent anchors must discover and stop the new generation');
  } finally {
    // Finish the single in-flight helper before recovery; never race two cleaners.
    await fs.writeFile(resume, 'continue');
    await cleaning?.catch(() => {});
    root.kill('SIGKILL');
    // Match this fixture's unique command-line marker, then reuse the same
    // handle-bound cleanup. This catches a child born before a failed handshake.
    const cleanup = windowsTreeCleanupScript(2147483647, true, startedAt, Date.now()).replace(
      '$known=@{}',
      `$known=@{}
foreach($owned in @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains(${psQuote(path.basename(directory))}) })) {
  [void]$anchors.Add([int]$owned.ProcessId)
  $known[[string]$owned.ProcessId]=$owned.CreationDate.ToUniversalTime().ToString('yyyyMMddHHmmssffffff')
}`);
    await run(cleanup);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('Windows cleanup excludes stale parent PID links before following the process tree', { skip: process.platform !== 'win32', timeout: 40000 }, async t => {
  for (const staleParent of ['root', 'descendant']) await t.test(staleParent, async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-win-stale-parent-'));
    const rootReady = path.join(directory, 'root.pid'), childReady = path.join(directory, 'child.pid');
    const unrelatedReady = path.join(directory, 'unrelated.pid'), forkGate = path.join(directory, 'fork');
    const injected = path.join(directory, 'injected');
    const record = file => `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(file)}+'.tmp',String(process.pid));fs.renameSync(${JSON.stringify(file)}+'.tmp',${JSON.stringify(file)});`;
    const childScript = `${record(childReady)}setInterval(()=>{},1000);`;
    const rootScript = `${record(rootReady)}const poll=setInterval(()=>{if(!fs.existsSync(${JSON.stringify(forkGate)}))return;clearInterval(poll);require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{stdio:'ignore',detached:true,windowsHide:true}).unref()},10);setInterval(()=>{},1000);`;
    const unrelatedScript = `${record(unrelatedReady)}setInterval(()=>{},1000);`;
    const powershell = path.join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    let root, unrelated, startedAt, spawnedAt, cleaning;
    const startRoot = async () => {
      startedAt = Date.now();
      root = spawn(process.execPath, ['-e', rootScript], { cwd: directory, stdio: 'ignore', windowsHide: true });
      spawnedAt = Date.now();
      await until(() => exists(rootReady), 'the owned root must start');
    };
    const startUnrelated = async () => {
      unrelated = spawn(process.execPath, ['-e', unrelatedScript], { cwd: directory, stdio: 'ignore', windowsHide: true });
      await until(() => exists(unrelatedReady), 'the unrelated sentinel must start');
    };
    try {
      if (staleParent === 'root') { await startUnrelated(); await startRoot(); }
      else { await startRoot(); await startUnrelated(); }
      // The middle-parent case is newer than the root but older than its parent;
      // a single global root lower bound would wrongly adopt this sentinel.
      await fs.writeFile(forkGate, 'fork');
      await until(() => exists(childReady), 'the actual descendant must start');
      const childPid = Number(await fs.readFile(childReady, 'utf8'));
      assert.ok(Number.isSafeInteger(childPid) && childPid > 1 && live(childPid));
      const staleParentPid = staleParent === 'root' ? root.pid : childPid;
      cleaning = runOwnedCleanup(root, startedAt, spawnedAt, script => script.replace(
        '$all=@(Get-CimInstance Win32_Process)',
        `$all=@(Get-CimInstance Win32_Process)
  $all=@($all | ForEach-Object {
    if($_.ProcessId -eq ${unrelated.pid}) {
      [IO.File]::WriteAllText(${psQuote(injected)},'stale-parent-link')
      [pscustomobject]@{ProcessId=$_.ProcessId;ParentProcessId=${staleParentPid};CreationDate=$_.CreationDate}
    } else { $_ }
  })`));
      await cleaning;
      assert.equal(await exists(injected), true, 'the real sentinel must appear in the cleanup snapshot');
      assert.equal(live(root.pid), false);
      assert.equal(live(childPid), false, 'the actual descendant must be released');
      assert.equal(live(unrelated.pid), true, 'a stale PPID must not authorize signaling an unrelated live handle');
    } finally {
      await cleaning?.catch(() => {});
      root?.kill('SIGKILL'); unrelated?.kill('SIGKILL');
      // Restrict recovery to this fixture's command-line marker and retain the
      // normal creation-time/held-handle checks for any detached descendant.
      const cleanup = windowsTreeCleanupScript(2147483647, true, startedAt ?? Date.now(), Date.now()).replace('$known=@{}', `$known=@{}
foreach($owned in @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains(${psQuote(path.basename(directory))}) })) {
  [void]$anchors.Add([int]$owned.ProcessId)
  $known[[string]$owned.ProcessId]=$owned.CreationDate.ToUniversalTime().ToString('yyyyMMddHHmmssffffff')
}`);
      await execFileAsync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', cleanup], { windowsHide: true, timeout: 8000, maxBuffer: 8192 });
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});

test('Windows cleanup follows an original root exit during helper startup with a fresh descendant scan', { skip: process.platform !== 'win32', timeout: 45000 }, async t => {
  for (const phase of ['open_root_handle', 'confirm_original_root']) await t.test(phase, async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-win-startup-exit-'));
    const childReady = path.join(directory, 'child.pid'), captured = path.join(directory, 'captured'), resume = path.join(directory, 'resume');
    const childScript = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(childReady)},String(process.pid));setInterval(()=>{},1000);`;
    const rootScript = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{stdio:'ignore',detached:true,windowsHide:true}).unref();setInterval(()=>{},1000);`;
    const startedAt = Date.now();
    const root = spawn(process.execPath, ['-e', rootScript], { cwd: directory, stdio: 'ignore', windowsHide: true });
    const spawnedAt = Date.now();
    const powershell = path.join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    let cleaning, childPid, firstFailure;
    try {
      await until(() => exists(childReady), 'the detached descendant must start');
      childPid = Number(await fs.readFile(childReady, 'utf8'));
      assert.ok(Number.isSafeInteger(childPid) && childPid > 1 && live(childPid));
      cleaning = runOwnedCleanup(root, startedAt, spawnedAt, script => {
        const checkpoint = `$cleanupPhase='${phase}'`;
        assert.equal(script.split(checkpoint).length, 2, 'inject exactly the intended pre-identity checkpoint');
        return script.replace(checkpoint, `${checkpoint}
[IO.File]::WriteAllText(${psQuote(captured)},'helper-started')
$handshakeDeadline=[DateTime]::UtcNow.AddSeconds(3)
while(!(Test-Path -LiteralPath ${psQuote(resume)})) {
  if([DateTime]::UtcNow -ge $handshakeDeadline) { throw 'Fixture startup handshake timed out.' }
  Start-Sleep -Milliseconds 10
}`);
      }, failure => { firstFailure = failure; });
      void cleaning.catch(() => {});
      await untilCleanupCheckpoint(() => exists(captured), 'cleanup must reach the pre-identity checkpoint', cleaning);
      // Match shutdown's escalation through the original ChildProcess HANDLE,
      // while a detached descendant deliberately survives that root exit.
      root.kill('SIGKILL');
      await until(() => root.exitCode !== null || root.signalCode !== null, 'the original HANDLE must report exit');
      assert.equal(live(childPid), true, 'root exit alone does not release its descendant');
      await fs.writeFile(resume, 'continue');
      await cleaning;
      assert.equal(firstFailure, phase, 'the original helper must exercise the failed pre-identity path');
      assert.equal(live(root.pid), false);
      assert.equal(live(childPid), false, 'the subsequent tombstone scan must actually stop the descendant');
    } finally {
      await fs.writeFile(resume, 'continue');
      await cleaning?.catch(() => {});
      root.kill('SIGKILL');
      // Recovery is restricted to this fixture's unique command-line marker;
      // production still determines whether the original cleanup passed.
      const cleanup = windowsTreeCleanupScript(2147483647, true, startedAt, Date.now()).replace('$known=@{}', `$known=@{}
foreach($owned in @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains(${psQuote(path.basename(directory))}) })) {
  [void]$anchors.Add([int]$owned.ProcessId)
  $known[[string]$owned.ProcessId]=$owned.CreationDate.ToUniversalTime().ToString('yyyyMMddHHmmssffffff')
}`);
      await execFileAsync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', cleanup], { windowsHide: true, timeout: 8000, maxBuffer: 8192 });
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});

test('Windows cleanup proves exit on its held handle when the process exits between inspection and termination', { skip: process.platform !== 'win32', timeout: 20000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-win-exit-race-'));
  const captured = path.join(directory, 'captured'), resume = path.join(directory, 'resume'), checked = path.join(directory, 'exit-checked');
  const startedAt = Date.now();
  const root = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: directory, stdio: 'ignore', windowsHide: true });
  const spawnedAt = Date.now();
  let cleaning;
  try {
    cleaning = runOwnedCleanup(root, startedAt, spawnedAt, script => script
      .replace("$cleanupPhase='terminate_owned_handle'", `$cleanupPhase='terminate_owned_handle'
      [IO.File]::WriteAllText(${psQuote(captured)},'held-live-handle')
      $handshakeDeadline=[DateTime]::UtcNow.AddSeconds(3)
      while(!(Test-Path -LiteralPath ${psQuote(resume)})) {
        if([DateTime]::UtcNow -ge $handshakeDeadline) { throw 'Fixture exit handshake timed out.' }
        Start-Sleep -Milliseconds 10
      }`)
      .replace("$cleanupPhase='wait_failed_termination'", `$cleanupPhase='wait_failed_termination'
        [IO.File]::WriteAllText(${psQuote(checked)},'termination-failed-exit-must-be-proven')`));
    void cleaning.catch(() => {});
    await untilCleanupCheckpoint(() => exists(captured), 'cleanup must hold a handle that was observed live', cleaning);
    root.kill('SIGKILL');
    await until(() => root.exitCode !== null || root.signalCode !== null, 'the original process must exit before termination resumes');
    await fs.writeFile(resume, 'continue');
    await cleaning;
    assert.equal(await exists(checked), true, 'the test must exercise a failed TerminateProcess, not skip termination');
    assert.equal(live(root.pid), false);
  } finally {
    await fs.writeFile(resume, 'continue');
    root.kill('SIGKILL');
    await cleaning?.catch(() => {});
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('Windows cleanup refuses a failed termination while the held process is still live', { skip: process.platform !== 'win32', timeout: 12000 }, async () => {
  const startedAt = Date.now();
  const root = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true });
  const spawnedAt = Date.now();
  try {
    // Inject only the unsuccessful termination result. The process, opened
    // handle, creation check and bounded wait all remain real Windows operations.
    const cleaning = runOwnedCleanup(root, startedAt, spawnedAt, script => script
      .replace('![OwnedProcessHandle]::TerminateProcess($handle,1)', '$true'));
    await assert.rejects(cleaning, error => {
      assert.match(error.stderr, /CLAUDE_TREE_CLEANUP_FAILED:wait_failed_termination/);
      return true;
    });
    assert.equal(live(root.pid), true, 'a failed signal cannot be reported as released without observing exit');
  } finally { root.kill('SIGKILL'); }
});

test('Windows cleanup binds the original live handle despite an incompatible wall-clock spawn window', { skip: process.platform !== 'win32', timeout: 15000 }, async () => {
  const root = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true });
  try {
    // Deliberately excludes the actual creation time. A widened timestamp window
    // must not be what authorizes this process: only the original HANDLE can.
    assert.equal(await stopWindowsTree(root, false, Date.now() - 60000, Date.now() - 59999), true);
    await until(() => !live(root.pid), 'confirmed original root must be stopped');
  } finally { root.kill('SIGKILL'); }
});

test('Windows cleanup refuses a held PID when the original process handle does not confirm it', { skip: process.platform !== 'win32', timeout: 15000 }, async () => {
  const startedAt = Date.now();
  const root = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true });
  let probes = 0;
  try {
    const original = { pid: root.pid, kill(signal) { assert.equal(signal, 0); probes++; return false; } };
    assert.equal(await stopWindowsTree(original, false, startedAt, Date.now()), false);
    assert.equal(probes, 1);
    assert.equal(live(root.pid), true, 'a numeric PID held by the helper cannot substitute for original ownership');
  } finally { root.kill('SIGKILL'); }
});
