import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import path from 'node:path';
import { readdir, readFile, readlink } from 'node:fs/promises';
import { JsonLineDecoder, object, string, type WireObject } from './chat-protocol.js';

interface ControlWaiter { resolve(value: WireObject): void; reject(error: Error): void; timer: NodeJS.Timeout }
interface ConnectionEvents {
  frame(value: WireObject): void;
  error(message: string): void;
  close(code: number | null, signal: NodeJS.Signals | null): void;
  outputLimit?(): void;
}
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);
const execFileAsync = promisify(execFile);
async function waitForGroupRelease(pid: number): Promise<boolean> {
  const deadline = Date.now() + 2000;
  do {
    try {
      if (process.platform === 'linux') {
        let live = false;
        const namespace = await readlink('/proc/self/ns/pid');
        const depth = (await readFile('/proc/self/status', 'utf8')).match(/^NSpid:\s+(.+)$/m)![1].trim().split(/\s+/).length;
        for (const name of await readdir('/proc')) {
          if (!/^\d+$/.test(name)) continue;
          try {
            const status = await readFile(`/proc/${name}/status`, 'utf8');
            if (status.match(/^NSpid:\s+(.+)$/m)?.[1].trim().split(/\s+/).length !== depth || /^State:\s+[ZX]/m.test(status)) continue;
            const namespaceGroup = status.match(/^NSpgid:\s+(.+)$/m)?.[1].trim().split(/\s+/).at(-1);
            if (!namespaceGroup) return false;
            if (Number(namespaceGroup) === pid && await readlink(`/proc/${name}/ns/pid`) === namespace) { live = true; break; }
          }
          catch (error) { if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) continue; throw error; }
        }
        if (!live) return true;
      } else {
        // CLI 选择逻辑可能刻意移除 PATH；进程检查使用操作系统的二进制文件。
        const result = await execFileAsync('/bin/ps', ['-eo', 'pgid=,stat='], { timeout: 1500, maxBuffer: 2 * 1024 * 1024 });
        if (!result.stdout.trim().split('\n').some(line => { const [group, state] = line.trim().split(/\s+/); return Number(group) === pid && state && !/^[ZX]/.test(state); })) return true;
      }
    } catch { return false; }
    await new Promise(resolve => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  return false;
}
// 内部脚本构建器仅从此模块导出，供真实 Windows 测试夹具使用。
export function windowsTreeCleanupScript(pid: number, rootExited: boolean, spawnStartedAt: number, spawnCompletedAt: number, rootChallenge?: string): string {
  if (rootChallenge !== undefined && !/^[a-f0-9-]{36}$/.test(rootChallenge)) throw new TypeError('Invalid root ownership challenge.');
  // 进程退出后仍保留父进程锚点，并在每轮检查中发现新的后代进程。
  // 检查创建时间及终止进程期间，持续持有各个 Windows 句柄。
  // 在辅助进程打开并保留数字 PID 对应的句柄后，生产逻辑通过
  // 原始 ChildProcess 句柄确认根进程仍然存活。
  // 仅根据时间戳判断的模式只供内部独立测试构建器使用。
  // 已报告退出的根进程仅作为墓碑记录，绝不能再向它发送信号。
  return `
$ErrorActionPreference='Stop'
$cleanupPhase='compile_handle_api'
$rootHandle=[IntPtr]::Zero
$handles=@{}
$nativeExited=@{}
trap {
  if($rootHandle -ne [IntPtr]::Zero) { [void][OwnedProcessHandle]::CloseHandle($rootHandle) }
  foreach($handle in @($handles.Values)) { [void][OwnedProcessHandle]::CloseHandle($handle) }
  [Console]::Error.WriteLine('CLAUDE_TREE_CLEANUP_FAILED:'+$cleanupPhase)
  exit 1
}
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OwnedProcessHandle {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetProcessTimes(IntPtr handle, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool TerminateProcess(IntPtr handle, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
}
'@
$rootPid=[int]${pid}
$rootExited=$${rootExited ? 'true' : 'false'}
$earliest=[DateTimeOffset]::FromUnixTimeMilliseconds(${spawnStartedAt}).UtcDateTime
$latest=[DateTimeOffset]::FromUnixTimeMilliseconds(${spawnCompletedAt + 1}).UtcDateTime
$anchors=New-Object 'System.Collections.Generic.HashSet[int]'
[void]$anchors.Add([int]${pid})
$anchorBirths=@{}
$known=@{}
if($rootExited) { $known[[string]$rootPid]='exited-before-inspection' }
${rootChallenge && !rootExited ? `
$cleanupPhase='open_root_handle'
$rootHandle=[OwnedProcessHandle]::OpenProcess(0x101001,$false,$rootPid)
if($rootHandle -eq [IntPtr]::Zero) { throw 'Cannot hold the root process.' }
$cleanupPhase='confirm_original_root'
[Console]::Out.WriteLine('CLAUDE_ROOT_HELD:${rootChallenge}')
[Console]::Out.Flush()
if([Console]::In.ReadLine() -ne 'confirm:${rootChallenge}') { throw 'Original root ownership is unconfirmed.' }
$cleanupPhase='capture_root_identity'
[long]$rootCreated=0; [long]$rootEnded=0; [long]$rootKernel=0; [long]$rootUser=0
if(![OwnedProcessHandle]::GetProcessTimes($rootHandle,[ref]$rootCreated,[ref]$rootEnded,[ref]$rootKernel,[ref]$rootUser)) { throw 'Cannot capture the confirmed root identity.' }
$earliest=[DateTime]::FromFileTimeUtc($rootCreated)
# CIM CreationDate has microsecond precision; compare like representations.
$earliest=$earliest.AddTicks(-($earliest.Ticks % 10))
$known[[string]$rootPid]=$earliest.ToString('yyyyMMddHHmmssffffff')
` : ''}
$anchorBirths[[string]$rootPid]=$earliest
function Read-OwnedSnapshot([ref]$failureCode,[string]$boundCode,[string]$timeoutCode) {
  # 按已观察锚点逐层补齐后代；不把整台宿主机的进程对象反复传回。
  $rowsByPid=@{}
  $queried=New-Object 'System.Collections.Generic.HashSet[int]'
  $pending=New-Object 'System.Collections.Generic.Queue[int]'
  foreach($anchor in $anchors) { $pending.Enqueue([int]$anchor) }
  while($pending.Count -gt 0) {
    if([DateTime]::UtcNow -ge $deadline) { $failureCode.Value=$timeoutCode; throw 'Owned snapshot deadline expired.' }
    $batch=@()
    while($pending.Count -gt 0 -and $batch.Count -lt 64) {
      $number=$pending.Dequeue()
      if($queried.Add($number)) { $batch+=@($number) }
    }
    if($batch.Count -eq 0) { continue }
    if($queried.Count -gt 4096) { $failureCode.Value=$boundCode; throw 'Owned snapshot exceeds its process bound.' }
    $conditions=@(foreach($number in $batch) { 'ProcessId='+$number; 'ParentProcessId='+$number })
    $query='SELECT ProcessId,ParentProcessId,CreationDate FROM Win32_Process WHERE '+($conditions -join ' OR ')
    if($query.Length -gt 8192) { $failureCode.Value=$boundCode; throw 'Owned snapshot query is too long.' }
    # windows-tree:before-query
    foreach($row in @(Get-CimInstance -Query $query)) {
      $number=[int]$row.ProcessId
      $key=[string]$number
      if($number -le 1) { $failureCode.Value=$boundCode; throw 'Owned snapshot contains an invalid process.' }
      if($rowsByPid.ContainsKey($key)) {
        $previous=$rowsByPid[$key]
        # 同一轮分批查询也不能把 PID 复用或父关系变化拼成一个合法身份。
        if(!$previous.CreationDate -or !$row.CreationDate -or
          $previous.CreationDate.ToUniversalTime() -ne $row.CreationDate.ToUniversalTime() -or
          [int]$previous.ParentProcessId -ne [int]$row.ParentProcessId) {
          $failureCode.Value=$boundCode; throw 'Process identity changed during the owned snapshot.'
        }
      } else {
        if($rowsByPid.Count -ge 4096) { $failureCode.Value=$boundCode; throw 'Owned snapshot contains too many processes.' }
        $rowsByPid[$key]=$row
      }
      if(!$queried.Contains($number)) { $pending.Enqueue($number) }
    }
  }
  return @($rowsByPid.Values)
}
$deadline=[DateTime]::UtcNow.AddSeconds(5)
do {
  # 持有所有已确认的句柄直到树释放，既证明退出，也阻止父代 PID 在扫描间被复用。
  $closedBeforeSnapshot=$true
  $anchorCountBeforeSnapshot=$anchors.Count
  foreach($anchor in $anchors) {
    $key=[string]$anchor
    if($handles.ContainsKey($key)) {
      if([OwnedProcessHandle]::WaitForSingleObject($handles[$key],0) -ne 0) { $closedBeforeSnapshot=$false }
    } elseif(!$nativeExited.ContainsKey($key)) { $closedBeforeSnapshot=$false }
  }
  $cleanupPhase='snapshot'
  $all=@(Read-OwnedSnapshot ([ref]$cleanupPhase) 'snapshot_bound' 'tree_deadline')
  # windows-tree:after-snapshot
  $current=@{}
  foreach($processItem in $all) { $current[[string]$processItem.ProcessId]=$processItem }
  foreach($key in @($known.Keys)) {
    if($current.ContainsKey($key)) {
      $cleanupPhase='verify_known_identity'
      $born=$current[$key].CreationDate
      if(!$born -or $known[$key] -ne $born.ToUniversalTime().ToString('yyyyMMddHHmmssffffff')) { throw 'Process identity changed during cleanup.' }
      $anchorBirths[$key]=$born.ToUniversalTime()
    }
  }
  do {
    $before=$anchors.Count
    foreach($processItem in $all) {
      if($anchors.Contains([int]$processItem.ProcessId) -or !$anchors.Contains([int]$processItem.ParentProcessId)) { continue }
      $cleanupPhase='read_creation_time'
      $born=$processItem.CreationDate
      if(!$born) { throw 'Process identity is unavailable.' }
      $parentKey=[string]$processItem.ParentProcessId
      if(!$anchorBirths.ContainsKey($parentKey)) { throw 'Parent process identity is unavailable.' }
      # ParentProcessId survives parent exit and can point at a reused PID.
      # An older process cannot descend from this owned parent incarnation.
      # Keep each parent's birth after exit so later scans use the same bound.
      if($born.ToUniversalTime() -lt $anchorBirths[$parentKey]) { continue }
      [void]$anchors.Add([int]$processItem.ProcessId)
      $anchorBirths[[string]$processItem.ProcessId]=$born.ToUniversalTime()
    }
  } while($anchors.Count -ne $before)
  $targets=@($all | Where-Object { $anchors.Contains([int]$_.ProcessId) })
  foreach($anchor in $anchors) {
    $key=[string]$anchor
    if(!$known.ContainsKey($key)) {
      if($current.ContainsKey($key)) {
        $born=$current[$key].CreationDate
        $cleanupPhase='read_creation_time'
        if(!$born) { throw 'Process identity is unavailable.' }
        if($born.ToUniversalTime() -lt $earliest) { $cleanupPhase='creation_before_spawn'; throw 'Process identity is outside the owned spawn window.' }
        if($anchor -eq $rootPid -and $born.ToUniversalTime() -gt $latest) { $cleanupPhase='creation_after_spawn'; throw 'Process identity is outside the owned spawn window.' }
        $known[$key]=$born.ToUniversalTime().ToString('yyyyMMddHHmmssffffff')
      } else { $known[$key]='exited-before-inspection' }
    }
  }
  if($targets.Count -eq 0 -or ($closedBeforeSnapshot -and $anchors.Count -eq $anchorCountBeforeSnapshot)) {
    $cleanupPhase='confirm_owned_release'
    foreach($handle in @($handles.Values)) {
      if([OwnedProcessHandle]::WaitForSingleObject($handle,0) -ne 0) { throw 'An owned process is still live.' }
    }
    if($rootHandle -ne [IntPtr]::Zero) {
      $cleanupPhase='confirm_root_release'
      if([OwnedProcessHandle]::WaitForSingleObject($rootHandle,0) -ne 0) { throw 'The confirmed root is still live.' }
      [void][OwnedProcessHandle]::CloseHandle($rootHandle); $rootHandle=[IntPtr]::Zero
    }
    foreach($handle in @($handles.Values)) { [void][OwnedProcessHandle]::CloseHandle($handle) }
    exit 0
  }
  foreach($processItem in $targets) {
    $cleanupPhase='open_owned_handle'
    $key=[string]$processItem.ProcessId
    $retained=$handles.ContainsKey($key)
    $handle=if($retained) { $handles[$key] } else { [OwnedProcessHandle]::OpenProcess(0x101001,$false,[int]$processItem.ProcessId) }
    if($handle -eq [IntPtr]::Zero) {
      if([Runtime.InteropServices.Marshal]::GetLastWin32Error() -eq 87) { $nativeExited[$key]=$true; continue }
      throw 'Cannot open owned process for termination.'
    }
    try {
      $cleanupPhase='read_handle_creation'
      [long]$created=0; [long]$exited=0; [long]$kernel=0; [long]$user=0
      if(![OwnedProcessHandle]::GetProcessTimes($handle,[ref]$created,[ref]$exited,[ref]$kernel,[ref]$user)) { throw 'Process creation time is unavailable.' }
      $identity=[DateTime]::FromFileTimeUtc($created).ToString('yyyyMMddHHmmssffffff')
      $cleanupPhase='verify_handle_identity'
      if($known[[string]$processItem.ProcessId] -ne $identity) { throw 'Process identity changed before termination.' }
      $handles[$key]=$handle; $retained=$true
      $cleanupPhase='terminate_owned_handle'
      if($exited -eq 0 -and ![OwnedProcessHandle]::TerminateProcess($handle,1)) {
        # A parent/job can terminate this process after GetProcessTimes. Prove
        # exit using the same handle; never treat access denied as proof itself.
        $cleanupPhase='wait_failed_termination'
        $remaining=[uint32][Math]::Max(0,[Math]::Min(250,[Math]::Ceiling(($deadline-[DateTime]::UtcNow).TotalMilliseconds)))
        if([OwnedProcessHandle]::WaitForSingleObject($handle,$remaining) -ne 0) { throw 'Owned process termination failed and exit is unconfirmed.' }
      }
      # 成功发起终止后，仍须从原句柄观察退出；等待始终受现有总期限约束。
      $remaining=[uint32][Math]::Max(0,[Math]::Min(250,[Math]::Ceiling(($deadline-[DateTime]::UtcNow).TotalMilliseconds)))
      $state=[OwnedProcessHandle]::WaitForSingleObject($handle,$remaining)
      if($state -ne 0 -and $state -ne 258) { throw 'Owned process exit cannot be queried.' }
    } finally { if(!$retained) { [void][OwnedProcessHandle]::CloseHandle($handle) } }
  }
  Start-Sleep -Milliseconds 25
} while([DateTime]::UtcNow -lt $deadline)
[Console]::Error.WriteLine('CLAUDE_TREE_CLEANUP_FAILED:tree_deadline')
if($rootHandle -ne [IntPtr]::Zero) { [void][OwnedProcessHandle]::CloseHandle($rootHandle) }
foreach($handle in @($handles.Values)) { [void][OwnedProcessHandle]::CloseHandle($handle) }
exit 1
`;
}
// 真实 Windows 进程归属回归测试也使用此内部入口。
export async function stopWindowsTree(child: Pick<ChildProcessWithoutNullStreams, 'pid' | 'kill'> & Partial<Pick<ChildProcessWithoutNullStreams, 'exitCode' | 'signalCode'>>, rootExited: boolean, spawnStartedAt: number, spawnCompletedAt: number): Promise<boolean> {
  if (!child.pid) return true;
  const executable = path.join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const deadline = performance.now() + 8000;
  const originalExited = () => child.exitCode != null || child.signalCode != null;
  let exited = rootExited || originalExited();
  for (let attempt = 0; attempt < 2; attempt++) {
    const challenge = exited ? undefined : randomUUID();
    const script = windowsTreeCleanupScript(child.pid, exited, spawnStartedAt, spawnCompletedAt, challenge);
    const timeout = Math.ceil(deadline - performance.now());
    if (timeout <= 0) {
      console.warn('Claude process cleanup could not confirm release (helper_timeout).');
      return false;
    }
    try {
      await new Promise<void>((resolve, reject) => {
        const helper = execFile(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout, maxBuffer: 1024 }, (error, _stdout, stderr) => {
          if (error) reject(Object.assign(error, { stderr })); else resolve();
        });
        let pending = '', confirmed = false;
        helper.stdin?.on('error', () => { /* 辅助进程完成仍然是资源释放屏障 */ });
        helper.stdout?.on('data', (chunk: string | Buffer) => {
          if (!challenge || confirmed) return;
          const text = chunk.toString();
          if (Buffer.byteLength(pending) + Buffer.byteLength(text) > 1024) {
            confirmed = true; pending = '';
            helper.stdin?.end(`reject:${challenge}\n`);
            return;
          }
          pending += text;
          if (!pending.split(/\r?\n/).includes(`CLAUDE_ROOT_HELD:${challenge}`)) return;
          confirmed = true;
          // libuv 的 uv_process_kill(handle, 0) 会检查原始进程 HANDLE。
          // 辅助进程捕获句柄后原始进程仍存活，证明所持有的 PID
          // 未被回收复用。不采用时钟容差或数字 PID 健康检查。
          let owned = false;
          try { owned = child.kill(0); } catch { /* 无法确认时拒绝操作 */ }
          helper.stdin?.end(`${owned ? 'confirm' : 'reject'}:${challenge}\n`);
        });
      });
      return true;
    } catch (error) {
      // execFile 的错误消息包含完整命令。仅输出受限的阶段标记，
      // 让 CI 及支持人员无需查看命令即可诊断释放失败。
      const failure = error as { stderr?: unknown; killed?: boolean };
      const phase = typeof failure.stderr === 'string' ? failure.stderr.match(/CLAUDE_TREE_CLEANUP_FAILED:([a-z_]{1,48})/)?.[1] : undefined;
      // PowerShell 启动期间，原始根进程可能退出（包括关闭时
      // 通过原始句柄执行强制升级终止）。只有观测到其退出，才允许
      // 在首个辅助进程完全关闭后重新扫描一次墓碑记录。数字 PID
      // 探测或任意检查失败绝不能授权进入此路径。
      if (attempt === 0 && !exited && originalExited() && performance.now() < deadline &&
        (phase === 'open_root_handle' || phase === 'confirm_original_root')) {
        exited = true;
        continue;
      }
      console.warn(`Claude process cleanup could not confirm release (${phase ?? (failure.killed ? 'helper_timeout' : 'helper_failed')}).`);
      return false;
    }
  }
  return false;
}

/** 负责标准输入输出分帧、有界控制流量及整个进程树的终止。 */
export class ClaudeConnection {
  readonly child: ChildProcessWithoutNullStreams;
  readonly controls = new Map<string, ControlWaiter>();
  readonly decoder: JsonLineDecoder;
  ending = false;
  stderr = '';
  killTimer?: NodeJS.Timeout;
  termination?: Promise<boolean>;
  private rootExited = false;
  private outputDiscarded = false;
  private readonly spawnStartedAt: number;
  private readonly spawnCompletedAt: number;
  constructor(invocation: { file: string; args: string[] }, cwd: string, env: NodeJS.ProcessEnv,
    private events: ConnectionEvents, private controlTimeoutMs = 15_000,
    private signalProcessGroup: (pid: number, signal: NodeJS.Signals) => Promise<void>, outputLimitBytes?: number) {
    this.spawnStartedAt = Date.now();
    const child = this.child = spawn(invocation.file, invocation.args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32', shell: false });
    this.spawnCompletedAt = Date.now();
    this.decoder = new JsonLineDecoder(value => events.frame(value));
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    let outputBytes = 0;
    child.stdout.on('data', (chunk: string) => {
      if (this.ending || this.outputDiscarded) return;
      if (outputLimitBytes !== undefined && (outputBytes += Buffer.byteLength(chunk)) > outputLimitBytes) {
        this.outputDiscarded = true;
        events.outputLimit?.();
        return;
      }
      try { this.decoder.push(chunk); }
      catch (error) { this.outputDiscarded = true; events.error(messageOf(error)); }
    });
    child.stderr.on('data', (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-8000); });
    child.on('error', error => events.error(messageOf(error)));
    child.stdin.on('error', error => { if (!this.ending && !this.rootExited) events.error('CLI 输入连接已关闭：' + error.message); });
    // close 会等待后代继承的管道；根进程退出时就开始清理，
    // 避免孤儿工具无限占用这些管道及目录租约。
    child.once('exit', () => { this.rootExited = true; this.terminate(true); });
    child.on('close', (code, signal) => events.close(code, signal));
  }
  receiveControl(frame: WireObject) {
    const response = object(frame.response); const requestId = string(response.request_id);
    const pending = this.controls.get(requestId); if (!pending) return;
    this.controls.delete(requestId); clearTimeout(pending.timer);
    if (response.subtype === 'error') pending.reject(new Error(string(response.error) || 'CLI 拒绝了控制请求。'));
    else if (response.subtype === 'success') pending.resolve(object(response.response));
    else pending.reject(new Error('CLI 控制响应格式不兼容。'));
  }
  closeControls(error: string) {
    for (const waiter of this.controls.values()) { clearTimeout(waiter.timer); waiter.reject(new Error(error)); }
    this.controls.clear();
  }
  finish() { if (!this.ending && !this.outputDiscarded) { try { this.decoder.finish(); } catch (error) { this.events.error(messageOf(error)); } } }
  write(value: WireObject) {
    if (this.ending || this.child.stdin.destroyed || !this.child.stdin.writable) throw new Error('CLI 输入连接已关闭。');
    // 同时仅有一个用户交互轮次未完成；控制流量另行限制。
    if (this.child.stdin.writableLength > 24 * 1024 * 1024) throw new Error('CLI 输入队列已满。');
    this.child.stdin.write(JSON.stringify(value) + '\n');
  }
  control(request: WireObject, timeout = this.controlTimeoutMs ?? 15_000): Promise<WireObject> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.controls.delete(requestId); const error = new Error('CLI 控制请求超时：' + string(request.subtype)); error.name = 'ChatControlTimeoutError'; reject(error); }, timeout);
      this.controls.set(requestId, { resolve, reject, timer });
      try { this.write({ type: 'control_request', request_id: requestId, request }); }
      catch (error) { clearTimeout(timer); this.controls.delete(requestId); reject(error); }
    });
  }
  reply(requestId: string, response: WireObject, error?: string) {
    this.write({ type: 'control_response', response: error ? { subtype: 'error', request_id: requestId, error } : { subtype: 'success', request_id: requestId, response } });
  }

  terminate(preserveOutput = false) {
    if (!preserveOutput) { this.ending = true; this.closeControls('会话进程已停止。'); }
    if (this.termination) return;
    if (process.platform === 'win32') {
      // Windows Stop-Process 已是强制终止操作。在 POSIX 升级
      // 定时器上另启动 PowerShell 快照会重复昂贵的 CIM 查询，
      // 并可能使并发会话超出物理资源释放预算。
      this.termination = (this.child.pid ? stopWindowsTree(this.child, this.rootExited, this.spawnStartedAt, this.spawnCompletedAt) : Promise.resolve(true)).then(stopped => {
        this.child.stdin.destroy();
        return stopped;
      });
      return;
    }
    const signal = (value: NodeJS.Signals): Promise<boolean> => {
      if (!this.child.pid) return Promise.resolve(true);
      return this.signalProcessGroup(this.child.pid, value).then(() => true, () => {
        try { this.child.kill(value); } catch { /* 已经退出。 */ }
        return false;
      });
    };
    const first = signal('SIGTERM');
    // 先完成初次发送信号的尝试，再关闭输入端点。
    void first.then(() => this.child.stdin.destroy());
    // 即使 CLI 根进程先于忽略信号的后代退出，也保留升级终止操作。
    this.termination = new Promise(resolve => {
      this.killTimer = setTimeout(() => { void signal('SIGKILL').then(async last => resolve(last && (!this.child.pid || await waitForGroupRelease(this.child.pid)))); }, 1500);
    });
  }
}
