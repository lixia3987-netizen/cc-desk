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

// 即使注入竞态检查点，也使用生产环境的归属握手。
// 同步创建辅助进程后立即恢复桥接；所有进程句柄、
// 质询传输及退出屏障仍使用生产代码。
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
  // 恰好两个后代进程。子进程仅在首个清理快照之后派生，
  // 并在该快照获准发送任何信号之前退出。
  // Windows libuv 在父进程退出时会终止未分离的子进程。
  // 将此子进程分离，使清理辅助进程必须亲自停止它，不依赖该作业策略。
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
      '# windows-tree:after-snapshot',
      `# windows-tree:after-snapshot
  if(!(Test-Path -LiteralPath ${psQuote(captured)})) {
    [IO.File]::WriteAllText(${psQuote(captured)},'captured')
    $handshakeDeadline=[DateTime]::UtcNow.AddSeconds(3)
    while(!(Test-Path -LiteralPath ${psQuote(resume)})) {
      if([DateTime]::UtcNow -ge $handshakeDeadline) { throw 'Fixture snapshot handshake timed out.' }
      Start-Sleep -Milliseconds 10
    }
  }`));
    // 立即附加拒绝处理，随后仍须等待下面的原始 Promise。
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
    // 恢复前完成唯一的进行中辅助进程，绝不让两个清理器竞态执行。
    await fs.writeFile(resume, 'continue');
    await cleaning?.catch(() => {});
    root.kill('SIGKILL');
    // 匹配此测试夹具独有的命令行标记，再复用相同的
    // 句柄绑定清理。这可以捕获握手失败前新创建的子进程。
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
      // 中间父进程用例的创建时间晚于根进程，却早于自身父进程；
      // 单一的全局根时间下界会错误地将此哨兵进程纳入管理。
      await fs.writeFile(forkGate, 'fork');
      await until(() => exists(childReady), 'the actual descendant must start');
      const childPid = Number(await fs.readFile(childReady, 'utf8'));
      assert.ok(Number.isSafeInteger(childPid) && childPid > 1 && live(childPid));
      const staleParentPid = staleParent === 'root' ? root.pid : childPid;
      // 将真实哨兵显式加入查询，旧父 PID 注入仍必须经过完整的身份验证。
      cleaning = runOwnedCleanup(root, startedAt, spawnedAt, script => script.replace(
        '# windows-tree:before-query', `# windows-tree:before-query
    $query+=' OR ProcessId=${unrelated.pid}'`).replace(
        '# windows-tree:after-snapshot',
        `# windows-tree:after-snapshot
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
      // 将恢复限制为此测试夹具的命令行标记，并对所有分离后代
      // 保留正常的创建时间及所持句柄检查。
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
      // 与关闭时通过原始 ChildProcess HANDLE 升级终止的行为匹配，
      // 同时刻意让一个分离的后代进程在根进程退出后继续存活。
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
      // 恢复仅限此测试夹具独有的命令行标记；
      // 生产逻辑仍然决定原始清理是否通过。
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

test('Windows cleanup releases a signaled retained HANDLE when CIM keeps the exited process row', { skip: process.platform !== 'win32', timeout: 15000 }, async () => {
  const startedAt = Date.now();
  const root = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true });
  const spawnedAt = Date.now();
  try {
    await runOwnedCleanup(root, startedAt, spawnedAt, script => script.replace(
      '# windows-tree:after-snapshot',
      `# windows-tree:after-snapshot
  if(!$retainedRows) { $retainedRows=@($all | Where-Object { [int]$_.ProcessId -eq ${root.pid} }) }
  foreach($row in $retainedRows) {
    if(!(@($all | Where-Object { $_.ProcessId -eq $row.ProcessId }).Count)) { $all+=@($row) }
  }`));
    assert.equal(live(root.pid), false, 'release must be based on the original process HANDLE exit');
  } finally { root.kill('SIGKILL'); }
});

test('Windows cleanup refuses a failed termination while the held process is still live', { skip: process.platform !== 'win32', timeout: 12000 }, async () => {
  const startedAt = Date.now();
  const root = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true });
  const spawnedAt = Date.now();
  try {
    // 仅注入终止失败的结果。进程、已打开的句柄、
    // 创建检查及有界等待仍然是真实的 Windows 操作。
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
    // 刻意排除真实创建时间。扩大时间戳窗口不能用于
    // 授权操作此进程，只有原始 HANDLE 可以提供授权。
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
