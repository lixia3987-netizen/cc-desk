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
        // CLI selection may deliberately strip PATH; process inspection uses the OS binary.
        const result = await execFileAsync('/bin/ps', ['-eo', 'pgid=,stat='], { timeout: 1500, maxBuffer: 2 * 1024 * 1024 });
        if (!result.stdout.trim().split('\n').some(line => { const [group, state] = line.trim().split(/\s+/); return Number(group) === pid && state && !/^[ZX]/.test(state); })) return true;
      }
    } catch { return false; }
    await new Promise(resolve => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  return false;
}
// Internal script builder is exported only from this module for the real Windows fixture.
export function windowsTreeCleanupScript(pid: number, rootExited: boolean, spawnStartedAt: number, spawnCompletedAt: number, rootChallenge?: string): string {
  if (rootChallenge !== undefined && !/^[a-f0-9-]{36}$/.test(rootChallenge)) throw new TypeError('Invalid root ownership challenge.');
  // Retain parent anchors after exit and discover new descendants on every pass.
  // Hold each Windows handle while checking creation time and terminating it.
  // Production confirms a live root through its original ChildProcess handle
  // after this helper has opened and retained its own handle to the numeric PID.
  // Timestamp-only mode remains solely for the internal standalone test builder.
  // A root already reported exited is a tombstone and can never be signaled.
  return `
$ErrorActionPreference='Stop'
$cleanupPhase='compile_handle_api'
$rootHandle=[IntPtr]::Zero
trap {
  if($rootHandle -ne [IntPtr]::Zero) { [void][OwnedProcessHandle]::CloseHandle($rootHandle) }
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
$known[[string]$rootPid]=$earliest.ToString('yyyyMMddHHmmssffffff')
` : ''}
$deadline=[DateTime]::UtcNow.AddSeconds(5)
do {
  $cleanupPhase='snapshot'
  $all=@(Get-CimInstance Win32_Process)
  $current=@{}
  foreach($processItem in $all) { $current[[string]$processItem.ProcessId]=$processItem }
  foreach($key in @($known.Keys)) {
    if($current.ContainsKey($key)) {
      $cleanupPhase='verify_known_identity'
      $born=$current[$key].CreationDate
      if(!$born -or $known[$key] -ne $born.ToUniversalTime().ToString('yyyyMMddHHmmssffffff')) { throw 'Process identity changed during cleanup.' }
    }
  }
  do {
    $before=$anchors.Count
    foreach($processItem in $all) {
      if($anchors.Contains([int]$processItem.ParentProcessId)) { [void]$anchors.Add([int]$processItem.ProcessId) }
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
  if($targets.Count -eq 0) {
    if($rootHandle -ne [IntPtr]::Zero) {
      $cleanupPhase='confirm_root_release'
      if([OwnedProcessHandle]::WaitForSingleObject($rootHandle,0) -ne 0) { throw 'The confirmed root is still live.' }
      [void][OwnedProcessHandle]::CloseHandle($rootHandle); $rootHandle=[IntPtr]::Zero
    }
    exit 0
  }
  foreach($processItem in $targets) {
    $cleanupPhase='open_owned_handle'
    $handle=[OwnedProcessHandle]::OpenProcess(0x101001,$false,[int]$processItem.ProcessId)
    if($handle -eq [IntPtr]::Zero) {
      if([Runtime.InteropServices.Marshal]::GetLastWin32Error() -eq 87) { continue }
      throw 'Cannot open owned process for termination.'
    }
    try {
      $cleanupPhase='read_handle_creation'
      [long]$created=0; [long]$exited=0; [long]$kernel=0; [long]$user=0
      if(![OwnedProcessHandle]::GetProcessTimes($handle,[ref]$created,[ref]$exited,[ref]$kernel,[ref]$user)) { throw 'Process creation time is unavailable.' }
      $identity=[DateTime]::FromFileTimeUtc($created).ToString('yyyyMMddHHmmssffffff')
      $cleanupPhase='verify_handle_identity'
      if($known[[string]$processItem.ProcessId] -ne $identity) { throw 'Process identity changed before termination.' }
      $cleanupPhase='terminate_owned_handle'
      if($exited -eq 0 -and ![OwnedProcessHandle]::TerminateProcess($handle,1)) {
        # A parent/job can terminate this process after GetProcessTimes. Prove
        # exit using the same handle; never treat access denied as proof itself.
        $cleanupPhase='wait_failed_termination'
        $remaining=[uint32][Math]::Max(0,[Math]::Min(250,[Math]::Ceiling(($deadline-[DateTime]::UtcNow).TotalMilliseconds)))
        if([OwnedProcessHandle]::WaitForSingleObject($handle,$remaining) -ne 0) { throw 'Owned process termination failed and exit is unconfirmed.' }
      }
    } finally { [void][OwnedProcessHandle]::CloseHandle($handle) }
  }
  if($rootHandle -ne [IntPtr]::Zero -and [OwnedProcessHandle]::WaitForSingleObject($rootHandle,0) -eq 0) {
    [void][OwnedProcessHandle]::CloseHandle($rootHandle); $rootHandle=[IntPtr]::Zero
  }
  Start-Sleep -Milliseconds 25
} while([DateTime]::UtcNow -lt $deadline)
[Console]::Error.WriteLine('CLAUDE_TREE_CLEANUP_FAILED:tree_deadline')
exit 1
`;
}
// Internal entry point also used by real Windows ownership regressions.
export async function stopWindowsTree(child: Pick<ChildProcessWithoutNullStreams, 'pid' | 'kill'>, rootExited: boolean, spawnStartedAt: number, spawnCompletedAt: number): Promise<boolean> {
  if (!child.pid) return true;
  const executable = path.join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const challenge = rootExited ? undefined : randomUUID();
  const script = windowsTreeCleanupScript(child.pid, rootExited, spawnStartedAt, spawnCompletedAt, challenge);
  try {
    await new Promise<void>((resolve, reject) => {
      const helper = execFile(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 8000, maxBuffer: 1024 }, (error, _stdout, stderr) => {
        if (error) reject(Object.assign(error, { stderr })); else resolve();
      });
      let pending = '', confirmed = false;
      helper.stdin?.on('error', () => { /* helper completion remains the release barrier */ });
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
        // libuv's uv_process_kill(handle, 0) checks the original process HANDLE.
        // A live original process after helper capture proves this held PID was
        // not recycled. No wall-clock tolerance or numeric-PID health check.
        let owned = false;
        try { owned = child.kill(0); } catch { /* fail closed */ }
        helper.stdin?.end(`${owned ? 'confirm' : 'reject'}:${challenge}\n`);
      });
    });
    return true;
  } catch (error) {
    // execFile's message contains its complete command. Emit only our bounded
    // phase marker so CI/support can diagnose release failures without commands.
    const failure = error as { stderr?: unknown; killed?: boolean };
    const phase = typeof failure.stderr === 'string' ? failure.stderr.match(/CLAUDE_TREE_CLEANUP_FAILED:([a-z_]{1,48})/)?.[1] : undefined;
    console.warn(`Claude process cleanup could not confirm release (${phase ?? (failure.killed ? 'helper_timeout' : 'helper_failed')}).`);
    return false;
  }
}

/** Owns stdio framing, bounded control traffic and whole-process-tree termination. */
export class ClaudeConnection {
  readonly child: ChildProcessWithoutNullStreams;
  readonly controls = new Map<string, ControlWaiter>();
  readonly decoder: JsonLineDecoder;
  ending = false;
  stderr = '';
  killTimer?: NodeJS.Timeout;
  termination?: Promise<boolean>;
  private rootExited = false;
  private readonly spawnStartedAt: number;
  private readonly spawnCompletedAt: number;
  constructor(invocation: { file: string; args: string[] }, cwd: string, env: NodeJS.ProcessEnv,
    private events: ConnectionEvents, private controlTimeoutMs = 15_000,
    private signalProcessGroup: (pid: number, signal: NodeJS.Signals) => Promise<void>) {
    this.spawnStartedAt = Date.now();
    const child = this.child = spawn(invocation.file, invocation.args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32', shell: false });
    this.spawnCompletedAt = Date.now();
    this.decoder = new JsonLineDecoder(value => events.frame(value));
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { if (this.ending) return; try { this.decoder.push(chunk); } catch (error) { events.error(messageOf(error)); } });
    child.stderr.on('data', (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-8000); });
    child.on('error', error => events.error(messageOf(error)));
    child.stdin.on('error', error => { if (!this.ending && !this.rootExited) events.error('CLI 输入连接已关闭：' + error.message); });
    // close waits for inherited descendant pipes; start cleanup at root exit so
    // orphan tools cannot hold those pipes and the directory lease indefinitely.
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
  finish() { if (!this.ending) { try { this.decoder.finish(); } catch (error) { this.events.error(messageOf(error)); } } }
  write(value: WireObject) {
    if (this.ending || this.child.stdin.destroyed || !this.child.stdin.writable) throw new Error('CLI 输入连接已关闭。');
    // Only one user turn is outstanding; control traffic is bounded separately.
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
      // Windows Stop-Process is already forceful. Starting a second PowerShell
      // snapshot on the POSIX escalation timer duplicates expensive CIM work
      // and can make concurrent sessions exceed the physical release budget.
      this.termination = (this.child.pid ? stopWindowsTree(this.child, this.rootExited, this.spawnStartedAt, this.spawnCompletedAt) : Promise.resolve(true)).then(stopped => {
        this.child.stdin.destroy();
        return stopped;
      });
      return;
    }
    const signal = (value: NodeJS.Signals): Promise<boolean> => {
      if (!this.child.pid) return Promise.resolve(true);
      return this.signalProcessGroup(this.child.pid, value).then(() => true, () => {
        try { this.child.kill(value); } catch { /* Already exited. */ }
        return false;
      });
    };
    const first = signal('SIGTERM');
    // Settle the initial signal attempt before closing the input endpoint.
    void first.then(() => this.child.stdin.destroy());
    // Keep escalation even if the CLI root exits before an ignoring descendant.
    this.termination = new Promise(resolve => {
      this.killTimer = setTimeout(() => { void signal('SIGKILL').then(async last => resolve(last && (!this.child.pid || await waitForGroupRelease(this.child.pid)))); }, 1500);
    });
  }
}
