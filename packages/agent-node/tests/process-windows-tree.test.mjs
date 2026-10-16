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
function helperFailure(error) {
  const stdout = typeof error.stdout === 'string' ? error.stdout : '';
  const stderr = typeof error.stderr === 'string' ? error.stderr : '';
  const reports = [];
  for (const line of stdout.split(/\r?\n/)) {
    let item;
    try { item = JSON.parse(line); } catch { continue; }
    if (!item || !['progress', 'result'].includes(item.type)) continue;
    const report = { type: item.type };
    for (const field of ['phase', 'code', 'helperStage', 'operation', 'identityFailure']) {
      if (typeof item[field] === 'string' && /^[a-z_]{1,64}$/.test(item[field])) report[field] = item[field];
    }
    for (const field of ['snapshots', 'terminationAttempts', 'liveProcesses', 'nativeCode']) {
      if (Number.isSafeInteger(item[field]) && item[field] >= 0) report[field] = item[field];
    }
    if (typeof item.released === 'boolean') report.released = item.released;
    reports.push(report);
  }
  const diagnostic = {
    code: Number.isSafeInteger(error.code) || typeof error.code === 'string' && /^[A-Z_0-9]{1,64}$/.test(error.code) ? error.code : null,
    signal: typeof error.signal === 'string' && /^SIG[A-Z]{1,12}$/.test(error.signal) ? error.signal : null,
    killed: error.killed === true,
    stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr),
    reports: reports.slice(-4),
  };
  // 异常消息仅保留固定字段，不让整份内联 PowerShell 命令淹没真实失败进度。
  const failure = new Error('WINDOWS_TREE_HELPER_FAILED:' + JSON.stringify(diagnostic));
  failure.diagnostic = diagnostic;
  // 现有负例仍须核对实际 stdout，不能把诊断摘要当作通过证据。
  Object.defineProperties(failure, { stdout: { value: stdout }, stderr: { value: stderr } });
  return failure;
}
const run = async script => {
  try { return await execFileAsync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 10_000, maxBuffer: 65536 }); }
  catch (error) { throw helperFailure(error); }
};
async function until(condition, phase, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!await condition()) { assert.ok(Date.now() < deadline, phase); await pause(); }
}
async function fixtureIdentity(root) {
  // 专项断言使用仍由 ChildProcess 句柄持有的真实进程，避免 JS 时钟精度
  // 与内核创建时间的差异抢先触发 spawn_window_mismatch，遮住待测分支。
  assert.equal(root.exitCode, null); assert.equal(root.signalCode, null);
  const result = await run(`$ErrorActionPreference='Stop'; $born=(Get-CimInstance -Query 'SELECT CreationDate FROM Win32_Process WHERE ProcessId=${root.pid}').CreationDate.ToUniversalTime(); @{ created=$born.ToString('yyyyMMddHHmmssffffff',[Globalization.CultureInfo]::InvariantCulture); createdAt=([DateTimeOffset]$born).ToUnixTimeMilliseconds() } | ConvertTo-Json -Compress`);
  const identity = JSON.parse(result.stdout.replace(/^\uFEFF/, ''));
  assert.match(identity.created, /^\d{20}$/);
  assert.ok(Number.isSafeInteger(identity.createdAt) && identity.createdAt > 0);
  assert.equal(root.exitCode, null); assert.equal(root.signalCode, null);
  return identity;
}
async function cleanupFixture(root, directory) {
  root.kill('SIGKILL');
  // 父进程使用自己持有的进程句柄。脱离的测试后代进程先通过
  // 唯一的命令行标记识别，再绑定到创建时间；随后生产辅助进程
  // 才会打开并核验同一进程身份。
  const marker = path.basename(directory);
  const result = await run(`$ErrorActionPreference='Stop'; $owned=@(Get-CimInstance -Query 'SELECT ProcessId,CreationDate,CommandLine FROM Win32_Process' | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains(${quote(marker)}) } | ForEach-Object { @{ pid=[int]$_.ProcessId; created=$_.CreationDate.ToUniversalTime().ToString('yyyyMMddHHmmssffffff',[Globalization.CultureInfo]::InvariantCulture) } }); ConvertTo-Json -InputObject @($owned) -Compress; exit 0`);
  const anchors = JSON.parse(result.stdout.replace(/^\uFEFF/, ''));
  if (anchors.length) await run(buildWindowsTreeCleanupScript(anchors, 8000));
  await fs.rm(directory, { recursive: true, force: true });
}

test('Windows cleanup uses the production filtered environment and stdin identities through physical helper close', { skip: process.platform !== 'win32', timeout: 20000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-win-filtered-'));
  const ready = path.join(directory, 'ready');
  const root = spawn(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000);`], { cwd: directory, stdio: 'ignore', windowsHide: true });
  let helper, helperClosed = false;
  try {
    await until(() => exists(ready), 'fixture process must start');
    // 本项验证过滤环境、stdin 身份传输和辅助进程物理关闭。
    // 使用原 ChildProcess 仍持有的精确身份，避免 JS 毫秒窗遮住这些断言。
    const { created } = await fixtureIdentity(root);
    const environment = commandEnvironment(process.env);
    assert.equal(Object.keys(environment).some(key => key.toUpperCase() === 'PSMODULEPATH'), false);
    const result = await runWindowsTreeCleanup({
      anchors: [{ pid: root.pid, created }], environment, timeoutMs: 8000,
      onHelper: (child, whenClosed) => { helper = child; void whenClosed.then(() => { helperClosed = true; }); },
    });
    assert.equal(result.released, true, JSON.stringify(result.diagnostic));
    assert.equal(helperClosed, true, 'success must include the actual helper close event');
    assert.equal(live(root.pid), false);
  } finally {
    root.kill('SIGKILL');
    // 失败仍应使测试失败；生产代码的有限释放尝试被拒绝之后，
    // 原始辅助进程句柄不得继续使测试执行器保持存活。
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

test('Windows cleanup proves closure with one post-exit snapshot even when CIM retains exited rows', { skip: process.platform !== 'win32', timeout: 20000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-win-closed-snapshot-'));
  const ready = path.join(directory, 'ready');
  const exitConfirmed = path.join(directory, 'exit-confirmed');
  const root = spawn(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000);`], { cwd: directory, stdio: 'ignore', windowsHide: true });
  const rootClosed = new Promise(resolve => root.once('close', resolve));
  try {
    await until(() => exists(ready), 'fixture process must start');
    const { created } = await fixtureIdentity(root);
    const script = buildWindowsTreeCleanupScript([{ pid: root.pid, created }], 8000)
      // 恰好两轮的前提是第二轮之前已确认真实 HANDLE 退出，等待仍受原八秒期限约束。
      .replace('$closedBeforeSnapshot=$true', `if($snapshots -eq 1) {
  if($handles.Count -eq 0) { throw 'Fixture requires an owned native HANDLE.' }
  foreach($fixtureHandle in @($handles.Values)) {
    $fixtureRemaining=[uint32][Math]::Max(0,[Math]::Floor(($deadline-[DateTime]::UtcNow).TotalMilliseconds))
    if([NativeOwnedProcess]::WaitForSingleObject($fixtureHandle,$fixtureRemaining) -ne 0) { throw 'Fixture exit was not confirmed within its original deadline.' }
  }
  [IO.File]::WriteAllText(${quote(exitConfirmed)},'confirmed')
}
$closedBeforeSnapshot=$true`).replace(
      '# windows-tree:after-snapshot',
      `# windows-tree:after-snapshot
if($snapshots -ge 2) { throw 'Closure must not require another full CIM snapshot.' }
if($snapshots -eq 0) { $retainedRows=@($all | Where-Object { [int]$_.ProcessId -eq ${root.pid} }) }
foreach($row in $retainedRows) {
  if(!(@($all | Where-Object { $_.ProcessId -eq $row.ProcessId }).Count)) { $all+=@($row) }
}`);
    const result = await run(script);
    const events = result.stdout.trim().split('\n').map(line => JSON.parse(line));
    const outcome = events.findLast(item => item.type === 'result');
    assert.equal(await exists(exitConfirmed), true, 'the native HANDLE exit barrier must actually run');
    assert.equal(outcome?.released, true, JSON.stringify(outcome));
    assert.equal(outcome?.snapshots, 2, 'the second snapshot must follow native HANDLE exit confirmation');
    assert.equal(live(root.pid), false);
  } finally {
    root.kill('SIGKILL');
    await rootClosed;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

for (const failureKind of ['invalid_pid', 'snapshot_absent', 'access_denied']) test(`Windows cleanup cannot adopt a live PID after an earlier ${failureKind} result`, { skip: process.platform !== 'win32', timeout: 20000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-win-invalid-pid-'));
  const ready = path.join(directory, 'ready');
  const root = spawn(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000);`], { cwd: directory, stdio: 'ignore', windowsHide: true });
  const rootClosed = new Promise(resolve => root.once('close', resolve));
  try {
    await until(() => exists(ready), 'fixture process must start');
    // 仅注入首次缺行或原生错误；后置快照、第二次打开、创建时间和活状态都来自真实 Windows。
    // 从未绑定状态进入墓碑分支；用真实创建时间的最窄毫秒窗，不用 created 预先填充 known。
    const { createdAt } = await fixtureIdentity(root);
    let script = buildWindowsTreeCleanupScript([{ pid: root.pid, spawnStartedAt: createdAt, spawnCompletedAt: createdAt }], 8000);
    if (failureKind === 'snapshot_absent') {
      script = script.replace('# windows-tree:after-snapshot', `# windows-tree:after-snapshot
if($snapshots -eq 0) { $all=@($all | Where-Object { [int]$_.ProcessId -ne ${root.pid} }) }`);
    } else {
      script = script.replace('$handle=[NativeOwnedProcess]::OpenProcess(0x101001,$false,$number)', `$handle=[NativeOwnedProcess]::OpenProcess(0x101001,$false,$number)
      if($number -eq ${root.pid} -and !$injectedAbsent) {
        if($handle -ne [IntPtr]::Zero) { [void][NativeOwnedProcess]::CloseHandle($handle) }
        $handle=[IntPtr]::Zero; $injectedAbsent=$true; $injectNative87=$true
      }`)
      .replace('$nativeCode=[Runtime.InteropServices.Marshal]::GetLastWin32Error()\n        if($nativeCode -eq 87)', `$nativeCode=if($injectNative87) { $injectNative87=$false; ${failureKind === 'invalid_pid' ? 87 : 5} } else { [Runtime.InteropServices.Marshal]::GetLastWin32Error() }
        if($nativeCode -eq 87)`);
    }
    await assert.rejects(run(script), error => {
      const outcome = error.stdout.trim().split('\n').map(line => JSON.parse(line)).findLast(item => item.type === 'result');
      assert.equal(outcome?.released, false);
      if (failureKind === 'access_denied') {
        assert.equal(outcome?.code, 'os_error');
        assert.equal(outcome?.nativeCode, 5);
      } else {
        assert.equal(outcome?.code, 'identity_changed');
        assert.equal(outcome?.identityFailure, 'live_tombstone');
      }
      return true;
    });
    assert.equal(live(root.pid), true, 'a prior absence or native error cannot authorize a later live incarnation');
  } finally {
    root.kill('SIGKILL');
    // 负例故意保留活进程；必须等待原始进程的物理关闭，才能删除它持有的工作目录。
    await rootClosed;
    await fs.rm(directory, { recursive: true, force: true });
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
  const root = spawn(process.execPath, ['-e', rootScript], { cwd: directory, stdio: 'ignore', windowsHide: true });
  let cleaning, failure;
  try {
    await until(() => exists(childReady), 'fixture child must start');
    const childPid = Number(await fs.readFile(childReady, 'utf8'));
    assert.ok(Number.isSafeInteger(childPid) && childPid > 1 && live(childPid));
    assert.equal(await exists(grandchildReady), false);
    const { created } = await fixtureIdentity(root);
    const script = buildWindowsTreeCleanupScript([{ pid: root.pid, created }], 8000).replace(
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
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      await fs.writeFile(resume, 'continue');
      await cleaning?.catch(() => {});
      await cleanupFixture(root, directory);
    } catch (cleanup) {
      // 原始回归失败与收尾失败都必须保留，不能让后一个异常覆盖前一个。
      if (failure) throw new AggregateError([failure, cleanup], 'Windows tree fixture failed and cleanup also failed.');
      throw cleanup;
    }
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
        // 这是一个真实的较早创建的进程。下面只修改其报告的 PPID；
        // 内核创建时间及所有打开的 HANDLE 均保持真实。
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
          // 显式查询真实哨兵后再注入旧父 PID，确保限范围查询不会让该负例失效。
          .replace('# windows-tree:before-query', `# windows-tree:before-query
$query+=' OR ProcessId=${older.pid}'`)
          .replace('# windows-tree:after-snapshot', mutation);
        if (missingBirth) {
          // 缺少时间不能证明身份过期，此时仍必须默认拒绝。
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
          catch { /* 启动或协议错误不能作为拒绝旧身份的证据。 */ }
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
    // 隔离锚点校验分支。不相关进程可能将此 PID 保留为旧 PPID；
    // 把它们纳入后，读取同样缺失的父进程出生时间时会正确地更早失败，
    // 但这属于另一种诊断。
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
