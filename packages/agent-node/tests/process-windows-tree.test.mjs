import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildWindowsTreeCleanupScript, runWindowsTreeCleanup } from '../dist/windows-process-tree.js';
import { commandEnvironment } from '../dist/process-supervisor.js';

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
  const result = await run(`$ErrorActionPreference='Stop'; $owned=@(Get-CimInstance -Query 'SELECT ProcessId,CreationDate,CommandLine FROM Win32_Process' | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains(${quote(marker)}) } | ForEach-Object { @{ pid=[int]$_.ProcessId; created=$_.CreationDate.ToUniversalTime().ToString('yyyyMMddHHmmssffffff',[Globalization.CultureInfo]::InvariantCulture) } }); ConvertTo-Json -InputObject @($owned) -Compress; exit 0`);
  const anchors = JSON.parse(result.stdout.replace(/^\uFEFF/, ''));
  if (anchors.length) await run(buildWindowsTreeCleanupScript(anchors, 8000));
  await fs.rm(directory, { recursive: true, force: true });
}

test('Windows cleanup uses the production filtered environment and stdin identities through physical helper close', { skip: process.platform !== 'win32', timeout: 20000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-win-filtered-'));
  const ready = path.join(directory, 'ready');
  const spawnStartedAt = Date.now();
  const root = spawn(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000);`], { cwd: directory, stdio: 'ignore', windowsHide: true });
  const spawnCompletedAt = Date.now();
  let helper, helperClosed = false;
  try {
    await until(() => exists(ready), 'fixture process must start');
    const environment = commandEnvironment(process.env);
    assert.equal(Object.keys(environment).some(key => key.toUpperCase() === 'PSMODULEPATH'), false);
    const result = await runWindowsTreeCleanup({
      anchors: [{ pid: root.pid, spawnStartedAt, spawnCompletedAt }], environment, timeoutMs: 8000,
      onHelper: (child, whenClosed) => { helper = child; void whenClosed.then(() => { helperClosed = true; }); },
    });
    assert.equal(result.released, true, JSON.stringify(result.diagnostic));
    assert.equal(helperClosed, true, 'success must include the actual helper close event');
    assert.equal(live(root.pid), false);
  } finally {
    root.kill('SIGKILL');
    // Failure still fails the test; its original helper handle must not keep
    // the runner alive after the bounded production release attempt rejected.
    if (helper && !helperClosed) {
      helper.kill('SIGKILL'); helper.stdin?.destroy(); helper.stdout?.destroy(); helper.stderr?.destroy(); helper.unref();
    }
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('Windows creation identities retain Gregorian UTC under a non-Gregorian helper culture', { skip: process.platform !== 'win32', timeout: 20000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-win-culture-'));
  const ready = path.join(directory, 'ready');
  const root = spawn(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000);`], { cwd: directory, stdio: 'ignore', windowsHide: true });
  try {
    await until(() => exists(ready), 'fixture process must start');
    const observed = await run(`$ErrorActionPreference='Stop'; (Get-CimInstance -Query 'SELECT CreationDate FROM Win32_Process WHERE ProcessId=${root.pid}').CreationDate.ToUniversalTime().ToString('yyyyMMddHHmmssffffff',[Globalization.CultureInfo]::InvariantCulture)`);
    const created = observed.stdout.trim();
    assert.match(created, /^\d{20}$/);
    const script = `[Threading.Thread]::CurrentThread.CurrentCulture=[Globalization.CultureInfo]::GetCultureInfo('th-TH')
if([DateTime]::UtcNow.ToString('yyyy') -eq [DateTime]::UtcNow.ToString('yyyy',[Globalization.CultureInfo]::InvariantCulture)) { throw 'Fixture requires a non-Gregorian calendar.' }
${buildWindowsTreeCleanupScript([{ pid: root.pid, created }], 8000)}`;
    const result = await run(script);
    const events = result.stdout.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(events.findLast(item => item.type === 'result')?.released, true);
    const anchor = events.find(item => item.type === 'anchor' && item.pid === root.pid);
    assert.equal(anchor?.created, created, 'CIM and held-HANDLE identities must use the input calendar');
    assert.equal(anchor?.minimumCreated, created, 'retained ancestry must keep the same invariant format');
    assert.equal(live(root.pid), false);
  } finally {
    root.kill('SIGKILL');
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

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
if(!([IO.File]::Exists(${quote(captured)}))) {
  [IO.File]::WriteAllText(${quote(captured)},'captured')
  $handshakeDeadline=[DateTime]::UtcNow.AddSeconds(3)
  while(!([IO.File]::Exists(${quote(resume)}))) {
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

for (const [parentKind, missingBirth] of [['root', false], ['intermediate', false], ['root', true]]) {
  test(missingBirth ? 'Windows cleanup refuses a parent relationship when the candidate birth is unavailable'
    : `Windows cleanup excludes a stale parent link to its ${parentKind} while stopping actual descendants`,
    { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), `native-win-stale-${parentKind}-`));
      const olderReady = path.join(directory, 'older.pid');
      const rootReady = path.join(directory, 'root.pid');
      const childReady = path.join(directory, 'child.pid');
      const grandchildReady = path.join(directory, 'grandchild.pid');
      const forkGate = path.join(directory, 'fork');
      const record = file => `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(file)}+'.tmp',String(process.pid));fs.renameSync(${JSON.stringify(file)}+'.tmp',${JSON.stringify(file)});`;
      const grandchild = `${record(grandchildReady)}setInterval(()=>{},1000);`;
      const child = `${record(childReady)}require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore',windowsHide:true}).unref();setInterval(()=>{},1000);`;
      const startRoot = () => spawn(process.execPath, ['-e', `${record(rootReady)}const fork=setInterval(()=>{if(!fs.existsSync(${JSON.stringify(forkGate)}))return;clearInterval(fork);require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'ignore',windowsHide:true}).unref();},10);setInterval(()=>{},1000);`],
        { cwd: directory, stdio: 'ignore', windowsHide: true });
      let root, older;
      try {
        if (parentKind === 'intermediate') {
          root = startRoot();
          await until(() => exists(rootReady), 'root must precede the unrelated process');
        }
        // This is a real older process. Only its reported PPID is changed below;
        // the kernel creation times and all opened HANDLEs remain genuine.
        older = spawn(process.execPath, ['-e', `${record(olderReady)}setInterval(()=>{},1000);`],
          { cwd: directory, stdio: 'ignore', windowsHide: true });
        await until(() => exists(olderReady), 'the unrelated older process must start');
        root ??= startRoot();
        await until(() => exists(rootReady), 'root must start before releasing its child');
        await fs.writeFile(forkGate, 'fork');
        await until(() => exists(grandchildReady), 'the actual descendant tree must start');
        const childPid = Number(await fs.readFile(childReady, 'utf8'));
        const grandchildPid = Number(await fs.readFile(grandchildReady, 'utf8'));
        assert.ok(Number.isSafeInteger(childPid) && childPid > 1 && live(childPid));
        assert.ok(Number.isSafeInteger(grandchildPid) && grandchildPid > 1 && live(grandchildPid));
        const parentPid = parentKind === 'root' ? root.pid : childPid;
        const observed = await run(`$ErrorActionPreference='Stop'; (Get-CimInstance -Query 'SELECT CreationDate FROM Win32_Process WHERE ProcessId=${root.pid}').CreationDate.ToUniversalTime().ToString('yyyyMMddHHmmssffffff',[Globalization.CultureInfo]::InvariantCulture)`);
        const created = observed.stdout.trim();
        assert.match(created, /^\d{20}$/);
        const mutation = `# windows-tree:after-snapshot
if($snapshots -eq 0) {
  $olderRow=@($all | Where-Object { [int]$_.ProcessId -eq ${older.pid} })
  $parentRow=@($all | Where-Object { [int]$_.ProcessId -eq ${parentPid} })
  if($olderRow.Count -ne 1 -or $parentRow.Count -ne 1 -or !$olderRow[0].CreationDate -or !$parentRow[0].CreationDate -or
    $olderRow[0].CreationDate.ToUniversalTime() -ge $parentRow[0].CreationDate.ToUniversalTime()) { throw 'Fixture must retain genuine ordered process births.' }
  ${parentKind === 'intermediate' ? `$rootRow=@($all | Where-Object { [int]$_.ProcessId -eq ${root.pid} })
  if($rootRow.Count -ne 1 -or !$rootRow[0].CreationDate -or $rootRow[0].CreationDate.ToUniversalTime() -ge $olderRow[0].CreationDate.ToUniversalTime()) { throw 'Fixture requires root then unrelated process then intermediate parent.' }` : ''}
}
$all=@($all | ForEach-Object { if([int]$_.ProcessId -eq ${older.pid}) {
  [pscustomobject]@{ ProcessId=$_.ProcessId; ParentProcessId=${parentPid}; CreationDate=$_.CreationDate }
} else { $_ } })`;
        let script = buildWindowsTreeCleanupScript([{ pid: root.pid, created }], 8000)
          .replace('# windows-tree:after-snapshot', mutation);
        if (missingBirth) {
          // An absent time does not prove staleness and must still fail closed.
          script = script.replace('CreationDate=$_.CreationDate }', 'CreationDate=$null }');
          await assert.rejects(run(script), error => {
            const result = error.stdout.trim().split('\n').map(line => JSON.parse(line)).findLast(item => item.type === 'result');
            assert.equal(result?.released, false);
            assert.equal(result?.code, 'identity_unavailable');
            assert.equal(result?.identityFailure, 'descendant_creation_missing');
            assert.equal(result?.operation, 'discover_descendants');
            return true;
          });
          for (const pid of [older.pid, root.pid, childPid, grandchildPid]) assert.equal(live(pid), true);
          return;
        }

        let result;
        try { result = await run(script); }
        catch (error) {
          let reported;
          try { reported = error.stdout.trim().split('\n').map(line => JSON.parse(line)).findLast(item => item.type === 'result'); }
          catch { /* A launch/protocol error is not evidence for the old identity rejection. */ }
          if (reported?.released === false && reported.code === 'identity_changed') {
            throw new Error('WINDOWS_STALE_PARENT_REJECTED:identity_changed', { cause: error });
          }
          throw error;
        }
        const events = result.stdout.trim().split('\n').map(line => JSON.parse(line));
        assert.equal(events.findLast(item => item.type === 'result')?.released, true);
        assert.equal(events.some(item => item.type === 'anchor' && item.pid === older.pid), false,
          'a proven stale relation must never enter retained ownership');
        for (const pid of [root.pid, childPid, grandchildPid]) assert.equal(live(pid), false, 'every true descendant must stop');
        assert.equal(live(older.pid), true, 'the unrelated older process must remain alive');
      } finally {
        older?.kill('SIGKILL');
        if (root ?? older) await cleanupFixture(root ?? older, directory);
        else await fs.rm(directory, { recursive: true, force: true });
      }
    });
}

test('Windows exited-unbound anchors cannot adopt a live process and unknown creation cannot authorize termination', { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-win-tombstone-'));
  const ready = path.join(directory, 'ready');
  const root = spawn(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000);`], { cwd: directory, stdio: 'ignore', windowsHide: true });
  try {
    await until(() => exists(ready), 'fixture process must start');
    const observed = await run(`$ErrorActionPreference='Stop'; (Get-CimInstance -Query 'SELECT CreationDate FROM Win32_Process WHERE ProcessId=${root.pid}').CreationDate.ToUniversalTime().ToString('yyyyMMddHHmmssffffff',[Globalization.CultureInfo]::InvariantCulture)`);
    const created = observed.stdout.trim();
    assert.match(created, /^\d{20}$/);
    await assert.rejects(run(buildWindowsTreeCleanupScript([{ pid: root.pid, exited: true, minimumCreated: created }], 8000)), error => {
      const result = error.stdout.trim().split('\n').map(line => JSON.parse(line)).findLast(item => item.type === 'result');
      assert.equal(result?.code, 'identity_changed');
      assert.equal(result?.identityFailure, 'live_tombstone');
      assert.equal(result?.operation, 'validate_handle'); return true;
    });
    assert.equal(live(root.pid), true, 'a current live PID cannot be adopted by an unbound exited identity');
    // Isolate the anchor validation branch. Unrelated processes can retain this
    // PID as an old PPID; including them correctly fails earlier while reading
    // the same missing birth as a parent, which is a different diagnostic.
    const unknown = buildWindowsTreeCleanupScript([{ pid: root.pid, created }], 8000).replace(
      '# windows-tree:after-snapshot',
      `# windows-tree:after-snapshot
$all=@($all | Where-Object { [int]$_.ProcessId -eq ${root.pid} })
if($all.Count -ne 1) { throw 'Fixture requires the live target root in the actual snapshot.' }
$all=@($all | ForEach-Object { [pscustomobject]@{ ProcessId=$_.ProcessId; ParentProcessId=$_.ParentProcessId; CreationDate=$null } })`);
    await assert.rejects(run(unknown), error => {
      const result = error.stdout.trim().split('\n').map(line => JSON.parse(line)).findLast(item => item.type === 'result');
      assert.equal(result?.code, 'identity_unavailable');
      assert.equal(result?.identityFailure, 'anchor_creation_missing');
      assert.equal(result?.operation, 'validate_snapshot'); return true;
    });
    assert.equal(live(root.pid), true, 'a missing creation identity must fail before termination');
    await assert.rejects(run(buildWindowsTreeCleanupScript([{ pid: root.pid, created: '20000101000000000000' }], 8000)), error => {
      const result = error.stdout.trim().split('\n').map(line => JSON.parse(line)).findLast(item => item.type === 'result');
      assert.equal(result?.code, 'identity_changed');
      assert.equal(result?.identityFailure, 'snapshot_mismatch');
      assert.equal(result?.operation, 'validate_snapshot'); return true;
    });
    assert.equal(live(root.pid), true, 'a known creation identity mismatch must never be ignored as a stale parent link');
  } finally { await cleanupFixture(root, directory); }
});
