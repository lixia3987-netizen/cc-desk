import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildWindowsTreeCleanupScript } from '../dist/windows-process-tree.js';

const execFileAsync = promisify(execFile);
const quote = value => "'" + value.replaceAll("'", "''") + "'";
const pause = () => new Promise(resolve => setTimeout(resolve, 10));
const exists = file => fs.stat(file).then(() => true, () => false);
const live = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
const powershell = path.join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const run = script => execFileAsync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 10_000, maxBuffer: 65536 });
async function until(condition, phase, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!await condition()) { assert.ok(Date.now() < deadline, phase); await pause(); }
}
async function cleanupFixture(root, directory) {
  root.kill('SIGKILL');
  // The parent uses its owned process handle. A detached fixture descendant is
  // identified by a unique command-line marker, then bound to its creation time
  // before the production helper opens and verifies the same process identity.
  const marker = path.basename(directory);
  const result = await run(`$ErrorActionPreference='Stop'; $owned=@(Get-CimInstance -Query 'SELECT ProcessId,CreationDate,CommandLine FROM Win32_Process' | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains(${quote(marker)}) } | ForEach-Object { @{ pid=[int]$_.ProcessId; created=$_.CreationDate.ToUniversalTime().ToString('yyyyMMddHHmmssffffff') } }); ConvertTo-Json -InputObject @($owned) -Compress; exit 0`);
  const anchors = JSON.parse(result.stdout.replace(/^\uFEFF/, ''));
  if (anchors.length) await run(buildWindowsTreeCleanupScript(anchors, 8000));
  await fs.rm(directory, { recursive: true, force: true });
}

test('Windows handle cleanup retains an exited parent anchor and finds the later detached grandchild', { skip: process.platform !== 'win32', timeout: 35000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-win-identity-'));
  const childReady = path.join(directory, 'child.pid');
  const grandchildReady = path.join(directory, 'grandchild.pid');
  const forkGate = path.join(directory, 'fork');
  const captured = path.join(directory, 'captured');
  const resume = path.join(directory, 'resume');
  const record = file => `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(file)}+'.tmp',String(process.pid));fs.renameSync(${JSON.stringify(file)}+'.tmp',${JSON.stringify(file)});`;
  const grandchild = `${record(grandchildReady)}setInterval(()=>{},1000);`;
  const child = `${record(childReady)}const poll=setInterval(()=>{if(!fs.existsSync(${JSON.stringify(forkGate)}))return;clearInterval(poll);const next=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore',detached:true,windowsHide:true});next.once('spawn',()=>process.exit(0));next.unref()},10);`;
  const rootScript = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'ignore'}).unref();setInterval(()=>{},1000);`;
  const spawnStartedAt = Date.now();
  const root = spawn(process.execPath, ['-e', rootScript], { cwd: directory, stdio: 'ignore', windowsHide: true });
  const spawnCompletedAt = Date.now();
  let cleaning;
  try {
    await until(() => exists(childReady), 'fixture child must start');
    const childPid = Number(await fs.readFile(childReady, 'utf8'));
    assert.ok(Number.isSafeInteger(childPid) && childPid > 1 && live(childPid));
    assert.equal(await exists(grandchildReady), false);
    const script = buildWindowsTreeCleanupScript([{ pid: root.pid, spawnStartedAt, spawnCompletedAt }], 8000).replace(
      '# windows-tree:after-snapshot',
      `# windows-tree:after-snapshot
if(!(Test-Path -LiteralPath ${quote(captured)})) {
  [IO.File]::WriteAllText(${quote(captured)},'captured')
  $handshakeDeadline=[DateTime]::UtcNow.AddSeconds(3)
  while(!(Test-Path -LiteralPath ${quote(resume)})) {
    if([DateTime]::UtcNow -ge $handshakeDeadline) { throw 'Fixture handshake timeout.' }
    Start-Sleep -Milliseconds 10
  }
}`);
    cleaning = run(script); void cleaning.catch(() => {});
    await until(() => exists(captured), 'cleanup must capture the original tree', 10_000);
    await fs.writeFile(forkGate, 'fork');
    await until(() => exists(grandchildReady), 'a detached grandchild must start after the first snapshot');
    const grandchildPid = Number(await fs.readFile(grandchildReady, 'utf8'));
    assert.ok(Number.isSafeInteger(grandchildPid) && grandchildPid > 1 && live(grandchildPid));
    await until(() => !live(childPid), 'known parent must exit before cleanup resumes');
    await fs.writeFile(resume, 'continue');
    await cleaning;
    assert.equal(live(root.pid), false);
    assert.equal(live(childPid), false);
    assert.equal(live(grandchildPid), false, 'fresh enumeration must discover the new descendant through the retained anchor');
  } finally {
    await fs.writeFile(resume, 'continue');
    await cleaning?.catch(() => {});
    await cleanupFixture(root, directory);
  }
});

test('Windows exited-unbound anchors cannot adopt a live process and unknown creation cannot authorize termination', { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-win-tombstone-'));
  const ready = path.join(directory, 'ready');
  const spawnStartedAt = Date.now();
  const root = spawn(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000);`], { cwd: directory, stdio: 'ignore', windowsHide: true });
  const spawnCompletedAt = Date.now();
  try {
    await until(() => exists(ready), 'fixture process must start');
    await assert.rejects(run(buildWindowsTreeCleanupScript([{ pid: root.pid, exited: true }], 8000)), error => {
      const result = error.stdout.trim().split('\n').map(line => JSON.parse(line)).findLast(item => item.type === 'result');
      assert.equal(result?.code, 'identity_changed'); return true;
    });
    assert.equal(live(root.pid), true, 'a current live PID cannot be adopted by an unbound exited identity');
    const unknown = buildWindowsTreeCleanupScript([{ pid: root.pid, spawnStartedAt, spawnCompletedAt }], 8000).replace(
      '# windows-tree:after-snapshot',
      `# windows-tree:after-snapshot
$all=@($all | ForEach-Object { if([int]$_.ProcessId -eq ${root.pid}) { [pscustomobject]@{ ProcessId=$_.ProcessId; ParentProcessId=$_.ParentProcessId; CreationDate=$null } } else { $_ } })`);
    await assert.rejects(run(unknown), error => {
      const result = error.stdout.trim().split('\n').map(line => JSON.parse(line)).findLast(item => item.type === 'result');
      assert.equal(result?.code, 'identity_unavailable'); return true;
    });
    assert.equal(live(root.pid), true, 'a missing creation identity must fail before termination');
  } finally { await cleanupFixture(root, directory); }
});
