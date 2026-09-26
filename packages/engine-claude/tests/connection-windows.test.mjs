import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { windowsTreeCleanupScript } from '../dist/connection.js';

const execFileAsync = promisify(execFile);
const psQuote = value => "'" + value.replaceAll("'", "''") + "'";
const pause = () => new Promise(resolve => setTimeout(resolve, 10));
const exists = file => fs.stat(file).then(() => true, () => false);
const live = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
async function until(condition, phase, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!await condition()) { assert.ok(Date.now() < deadline, phase); await pause(); }
}

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
    const script = windowsTreeCleanupScript(root.pid, false, startedAt, spawnedAt).replace(
      '$all=@(Get-CimInstance Win32_Process)',
      `$all=@(Get-CimInstance Win32_Process)
  if(!(Test-Path -LiteralPath ${psQuote(captured)})) {
    [IO.File]::WriteAllText(${psQuote(captured)},'captured')
    $handshakeDeadline=[DateTime]::UtcNow.AddSeconds(3)
    while(!(Test-Path -LiteralPath ${psQuote(resume)})) {
      if([DateTime]::UtcNow -ge $handshakeDeadline) { throw 'Fixture snapshot handshake timed out.' }
      Start-Sleep -Milliseconds 10
    }
  }`);
    cleaning = run(script);
    // Attach rejection immediately, then still require the original promise below.
    void cleaning.catch(() => {});
    await until(() => exists(captured), 'cleanup must capture the original tree', 8000);
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

test('Windows cleanup proves exit on its held handle when the process exits between inspection and termination', { skip: process.platform !== 'win32', timeout: 20000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-win-exit-race-'));
  const captured = path.join(directory, 'captured'), resume = path.join(directory, 'resume'), checked = path.join(directory, 'exit-checked');
  const startedAt = Date.now();
  const root = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: directory, stdio: 'ignore', windowsHide: true });
  const spawnedAt = Date.now();
  const powershell = path.join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  let cleaning;
  try {
    const script = windowsTreeCleanupScript(root.pid, false, startedAt, spawnedAt)
      .replace("$cleanupPhase='terminate_owned_handle'", `$cleanupPhase='terminate_owned_handle'
      [IO.File]::WriteAllText(${psQuote(captured)},'held-live-handle')
      $handshakeDeadline=[DateTime]::UtcNow.AddSeconds(3)
      while(!(Test-Path -LiteralPath ${psQuote(resume)})) {
        if([DateTime]::UtcNow -ge $handshakeDeadline) { throw 'Fixture exit handshake timed out.' }
        Start-Sleep -Milliseconds 10
      }`)
      .replace("$cleanupPhase='wait_failed_termination'", `$cleanupPhase='wait_failed_termination'
        [IO.File]::WriteAllText(${psQuote(checked)},'termination-failed-exit-must-be-proven')`);
    cleaning = execFileAsync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 8000, maxBuffer: 8192 });
    void cleaning.catch(() => {});
    await until(() => exists(captured), 'cleanup must hold a handle that was observed live', 8000);
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
  const powershell = path.join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try {
    // Inject only the unsuccessful termination result. The process, opened
    // handle, creation check and bounded wait all remain real Windows operations.
    const script = windowsTreeCleanupScript(root.pid, false, startedAt, spawnedAt)
      .replace('![OwnedProcessHandle]::TerminateProcess($handle,1)', '$true');
    await assert.rejects(execFileAsync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true, timeout: 8000, maxBuffer: 8192,
    }), error => {
      assert.match(error.stderr, /CLAUDE_TREE_CLEANUP_FAILED:wait_failed_termination/);
      return true;
    });
    assert.equal(live(root.pid), true, 'a failed signal cannot be reported as released without observing exit');
  } finally { root.kill('SIGKILL'); }
});
