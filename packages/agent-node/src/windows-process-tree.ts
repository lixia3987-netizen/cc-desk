import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

export interface WindowsProcessAnchor {
  pid: number;
  /** UTC yyyyMMddHHmmssffffff, captured from a previously opened process handle. */
  created?: string;
  /** Without a creation identity, this PID may only identify an exited parent. */
  exited?: boolean;
  spawnStartedAt?: number;
  spawnCompletedAt?: number;
  /** Inherited owner/parent birth lower bound, retained even for tombstones. */
  minimumCreated?: string;
}

export interface WindowsCleanupProgress {
  phase: 'windows_snapshot' | 'windows_terminate';
  code: 'running' | 'timeout' | 'spawn_error' | 'helper_exit' | 'invalid_snapshot' | 'identity_changed' | 'identity_unavailable' | 'unreleased' | 'os_error';
  snapshots: number;
  terminationAttempts: number;
  liveProcesses: number;
  helperStage?: 'bootstrap' | 'compile' | 'snapshot' | 'capture' | 'terminate';
  nativeCode?: number;
  helperExitCode?: number | null;
  helperExited?: boolean;
  helperOutputBytes?: number;
  osCode?: 'ENOENT' | 'EACCES' | 'EPERM' | 'ESRCH' | 'UNKNOWN';
}

const identityPattern = /^\d{20}$/;

function validAnchor(anchor: WindowsProcessAnchor): boolean {
  return Number.isSafeInteger(anchor.pid) && anchor.pid > 1 && anchor.pid <= 2_147_483_647
    && (anchor.exited === undefined || typeof anchor.exited === 'boolean')
    && (anchor.created === undefined || identityPattern.test(anchor.created))
    && (anchor.minimumCreated === undefined || identityPattern.test(anchor.minimumCreated))
    && (anchor.spawnStartedAt === undefined || Number.isSafeInteger(anchor.spawnStartedAt) && anchor.spawnStartedAt >= 0)
    && (anchor.spawnCompletedAt === undefined || Number.isSafeInteger(anchor.spawnCompletedAt) && anchor.spawnCompletedAt >= 0);
}

/** Internal builder exported for Windows process/handshake regressions, not a package entry point. */
export function buildWindowsTreeCleanupScript(anchors: readonly WindowsProcessAnchor[], timeoutMs: number, input: 'inline' | 'stdin' = 'inline'): string {
  if (!anchors.length || anchors.length > 4096 || !anchors.every(validAnchor)
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error('Invalid Windows cleanup identity or budget.');
  // These values contain only validated numbers, booleans and numeric identities.
  const serialized = JSON.stringify(anchors.map(anchor => ({ ...anchor, exited: anchor.exited === true })));
  return `
[Console]::Out.WriteLine('{"type":"progress","phase":"windows_snapshot","code":"running","snapshots":0,"terminationAttempts":0,"liveProcesses":0,"nativeCode":0,"helperStage":"bootstrap"}')
$ErrorActionPreference='Stop'
$specifications=@(ConvertFrom-Json -InputObject ${input === 'stdin' ? '([Console]::In.ReadToEnd())' : `'${serialized}'`})
$anchors=New-Object 'System.Collections.Generic.HashSet[int]'
$specs=@{}; $known=@{}; $handles=@{}; $bound=@{}; $minimum=@{}
$phase='windows_snapshot'; $failure='running'; $nativeCode=0
$helperStage='compile'
$snapshots=0; $attempts=0; $live=0; $quiet=0; $released=$false
$deadline=[DateTime]::UtcNow.AddMilliseconds(${timeoutMs})
function Report-Progress {
  [Console]::Out.WriteLine((@{type='progress';phase=$phase;code=$failure;snapshots=$snapshots;terminationAttempts=$attempts;liveProcesses=$live;nativeCode=$nativeCode;helperStage=$helperStage} | ConvertTo-Json -Compress))
}
function Report-Anchor([int]$number,[string]$identity) {
  $lower=$null
  if($minimum.ContainsKey([string]$number)) { $lower=$minimum[[string]$number].ToString('yyyyMMddHHmmssffffff') }
  [Console]::Out.WriteLine((@{type='anchor';pid=$number;created=$identity;exited=($identity -eq 'tombstone');minimumCreated=$lower} | ConvertTo-Json -Compress))
}
function Parse-Identity([string]$identity) {
  return [DateTime]::SpecifyKind([DateTime]::ParseExact($identity,'yyyyMMddHHmmssffffff',[Globalization.CultureInfo]::InvariantCulture),[DateTimeKind]::Utc)
}
try {
  Report-Progress
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NativeOwnedProcess {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetProcessTimes(IntPtr handle, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool TerminateProcess(IntPtr handle, uint code);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
}
'@
  foreach($spec in $specifications) {
    $key=[string]$spec.pid
    if($specs.ContainsKey($key)) { $failure='invalid_snapshot'; throw 'Duplicate anchor.' }
    [void]$anchors.Add([int]$spec.pid); $specs[$key]=$spec
    if($spec.created) { $known[$key]=[string]$spec.created }
    elseif($spec.exited) { $known[$key]='tombstone' }
    if($spec.created) { $minimum[$key]=Parse-Identity $spec.created }
    elseif($spec.minimumCreated) { $minimum[$key]=Parse-Identity $spec.minimumCreated }
    elseif($null -ne $spec.spawnStartedAt) { $minimum[$key]=[DateTimeOffset]::FromUnixTimeMilliseconds([long]$spec.spawnStartedAt).UtcDateTime }
  }
  do {
    $phase='windows_snapshot'; $helperStage='snapshot'; Report-Progress
    $all=@(Get-CimInstance -Query 'SELECT ProcessId,ParentProcessId,CreationDate FROM Win32_Process')
    # windows-tree:after-snapshot
    $snapshots++
    $helperStage='capture'
    $current=@{}
    foreach($item in $all) { $current[[string]$item.ProcessId]=$item }
    do {
      $before=$anchors.Count
      foreach($item in $all) {
        if($anchors.Contains([int]$item.ParentProcessId) -and !$anchors.Contains([int]$item.ProcessId)) {
          $parentKey=[string]$item.ParentProcessId
          if(!$minimum.ContainsKey($parentKey)) { $failure='identity_unavailable'; throw 'Parent birth lower bound is unavailable.' }
          $lower=$minimum[$parentKey]
          if($current.ContainsKey($parentKey)) {
            $parentBorn=$current[$parentKey].CreationDate
            if(!$parentBorn) { $failure='identity_unavailable'; throw 'Parent creation identity unavailable.' }
            if($parentBorn.ToUniversalTime() -gt $lower) { $lower=$parentBorn.ToUniversalTime() }
          }
          if(!$item.CreationDate) { $failure='identity_unavailable'; throw 'Descendant creation identity unavailable.' }
          if($item.CreationDate.ToUniversalTime() -lt $lower) { $failure='identity_changed'; throw 'Descendant predates its owned parent.' }
          [void]$anchors.Add([int]$item.ProcessId)
          $minimum[[string]$item.ProcessId]=$item.CreationDate.ToUniversalTime()
        }
      }
      if($anchors.Count -gt 4096) { $failure='invalid_snapshot'; throw 'Too many anchors.' }
    } while($anchors.Count -ne $before)
    foreach($number in $anchors) {
      $key=[string]$number
      if(!$current.ContainsKey($key)) {
        if(!$known.ContainsKey($key)) { $known[$key]='tombstone'; Report-Anchor $number 'tombstone' }
        continue
      }
      $born=$current[$key].CreationDate
      if(!$born) { $failure='identity_unavailable'; throw 'Creation identity unavailable.' }
      $snapshotIdentity=$born.ToUniversalTime().ToString('yyyyMMddHHmmssffffff')
      if($known.ContainsKey($key) -and $known[$key] -ne 'tombstone' -and $known[$key] -ne $snapshotIdentity) {
        $failure='identity_changed'; throw 'Snapshot identity changed.'
      }
      if($bound.ContainsKey($key) -and $bound[$key] -ne $snapshotIdentity) { $failure='identity_changed'; throw 'Bound identity changed.' }
      if($handles.ContainsKey($key)) { continue }
      $handle=[NativeOwnedProcess]::OpenProcess(0x101001,$false,$number)
      if($handle -eq [IntPtr]::Zero) {
        $nativeCode=[Runtime.InteropServices.Marshal]::GetLastWin32Error()
        if($nativeCode -eq 87) {
          if(!$known.ContainsKey($key)) { $known[$key]='tombstone'; Report-Anchor $number 'tombstone' }
          continue
        }
        $failure='os_error'; throw 'Cannot open process.'
      }
      $retained=$false
      try {
        [long]$created=0; [long]$exited=0; [long]$kernel=0; [long]$user=0
        if(![NativeOwnedProcess]::GetProcessTimes($handle,[ref]$created,[ref]$exited,[ref]$kernel,[ref]$user)) {
          $nativeCode=[Runtime.InteropServices.Marshal]::GetLastWin32Error(); $failure='os_error'; throw 'Cannot query process times.'
        }
        $identity=[DateTime]::FromFileTimeUtc($created).ToString('yyyyMMddHHmmssffffff')
        if($identity -ne $snapshotIdentity) { $failure='identity_changed'; throw 'Handle identity changed.' }
        if($minimum.ContainsKey($key) -and [DateTime]::FromFileTimeUtc($created) -lt $minimum[$key]) { $failure='identity_changed'; throw 'Handle predates its owner.' }
        if($specs.ContainsKey($key) -and !$specs[$key].created -and $null -ne $specs[$key].spawnStartedAt -and $null -ne $specs[$key].spawnCompletedAt) {
          $earliest=[DateTimeOffset]::FromUnixTimeMilliseconds([long]$specs[$key].spawnStartedAt).UtcDateTime
          $latest=[DateTimeOffset]::FromUnixTimeMilliseconds(([long]$specs[$key].spawnCompletedAt + 1)).UtcDateTime
          if([DateTime]::FromFileTimeUtc($created) -lt $earliest -or [DateTime]::FromFileTimeUtc($created) -gt $latest) { $failure='identity_changed'; throw 'Observed root identity changed.' }
        }
        $state=[NativeOwnedProcess]::WaitForSingleObject($handle,0)
        if($state -ne 0 -and $state -ne 258) { $failure='os_error'; throw 'Cannot query process state.' }
        if($known.ContainsKey($key) -and $known[$key] -eq 'tombstone') {
          # CIM can still list an exited object. Only a signaled HANDLE proves
          # that it is harmless; a live process at this tombstone is never adopted.
          if($state -ne 0) { $failure='identity_changed'; throw 'Live process replaced an exited anchor.' }
        } elseif($known.ContainsKey($key)) {
          if($known[$key] -ne $identity) { $failure='identity_changed'; throw 'Owned identity changed.' }
        } else {
          if($specs.ContainsKey($key)) {
            $spec=$specs[$key]
            if($null -eq $spec.spawnStartedAt -or $null -eq $spec.spawnCompletedAt) {
              $failure='identity_unavailable'; throw 'Initial live identity is unbounded.'
            }
            $earliest=[DateTimeOffset]::FromUnixTimeMilliseconds([long]$spec.spawnStartedAt).UtcDateTime
            $latest=[DateTimeOffset]::FromUnixTimeMilliseconds(([long]$spec.spawnCompletedAt + 1)).UtcDateTime
            if($born.ToUniversalTime() -lt $earliest -or $born.ToUniversalTime() -gt $latest) {
              $failure='identity_changed'; throw 'Initial identity is outside the owned spawn window.'
            }
          }
          $known[$key]=$identity
        }
        # Keep each handle, including exited parent handles, until the entire
        # cleanup finishes. Windows cannot recycle these owned process IDs meanwhile.
        $handles[$key]=$handle; $bound[$key]=$identity; $minimum[$key]=[DateTime]::FromFileTimeUtc($created); $retained=$true
        Report-Anchor $number $known[$key]
      } finally { if(!$retained) { [void][NativeOwnedProcess]::CloseHandle($handle) } }
    }
    $live=0; $phase='windows_terminate'; $helperStage='terminate'
    foreach($key in @($handles.Keys)) {
      $handle=$handles[$key]
      $state=[NativeOwnedProcess]::WaitForSingleObject($handle,0)
      if($state -eq 0) { continue }
      if($state -ne 258) { $failure='os_error'; throw 'Cannot verify process release.' }
      if($known[$key] -eq 'tombstone') { $failure='identity_changed'; throw 'An exited anchor became live.' }
      $live++; $attempts++
      if(![NativeOwnedProcess]::TerminateProcess($handle,1)) {
        $nativeCode=[Runtime.InteropServices.Marshal]::GetLastWin32Error()
        $wait=[uint32][Math]::Max(0,[Math]::Min(250,[Math]::Floor(($deadline-[DateTime]::UtcNow).TotalMilliseconds)))
        if([NativeOwnedProcess]::WaitForSingleObject($handle,$wait) -ne 0) { $failure='os_error'; throw 'Cannot terminate owned handle.' }
      }
    }
    Report-Progress
    if($live -eq 0) { $quiet++ } else { $quiet=0 }
    if($quiet -ge 2) { $released=$true; break }
    Start-Sleep -Milliseconds 25
  } while([DateTime]::UtcNow -lt $deadline)
  if(!$released) { $failure='timeout' }
} catch { if($failure -eq 'running') { $failure='helper_exit' } }
finally { foreach($handle in @($handles.Values)) { [void][NativeOwnedProcess]::CloseHandle($handle) } }
[Console]::Out.WriteLine((@{type='result';released=$released;phase=$phase;code=$failure;snapshots=$snapshots;terminationAttempts=$attempts;liveProcesses=$live;nativeCode=$nativeCode;helperStage=$helperStage} | ConvertTo-Json -Compress))
if($released) { exit 0 } else { exit 1 }
`;
}

const phases = new Set(['windows_snapshot', 'windows_terminate']);
const codes = new Set(['running', 'timeout', 'spawn_error', 'helper_exit', 'invalid_snapshot', 'identity_changed', 'identity_unavailable', 'unreleased', 'os_error']);

/** One helper owns discovery, identity checks and termination, without PID re-lookups at kill time. */
export function runWindowsTreeCleanup(options: {
  anchors: readonly WindowsProcessAnchor[];
  environment: NodeJS.ProcessEnv;
  timeoutMs: number;
  onAnchor?: (anchor: WindowsProcessAnchor) => void;
  onProgress?: (progress: WindowsCleanupProgress) => void;
  onHelper?: (helper: ChildProcess, whenClosed: Promise<void>) => void;
}): Promise<{ released: boolean; diagnostic: WindowsCleanupProgress }> {
  // Keep a large retained ancestry out of Windows' 32,767-character command line.
  const script = buildWindowsTreeCleanupScript(options.anchors, options.timeoutMs, 'stdin');
  const systemRoots = Object.entries(options.environment).filter(([key]) => key.toUpperCase() === 'SYSTEMROOT');
  const systemRoot = systemRoots[0]?.[1];
  // Missing or filtered SystemRoot cannot authorize resolving a helper from
  // the approved command's cwd/PATH. Only a local drive-qualified OS root is accepted.
  if (systemRoots.length !== 1 || !systemRoot || /[\0\r\n]/.test(systemRoot) || !path.win32.isAbsolute(systemRoot)
    || !/^[A-Za-z]:[\\/]/.test(systemRoot)) {
    return Promise.resolve({ released: false, diagnostic: { phase: 'windows_snapshot', code: 'spawn_error', snapshots: 0, terminationAttempts: 0, liveProcesses: 0 } });
  }
  const executable = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise(resolve => {
    const helper = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      shell: false, windowsHide: true, env: options.environment, stdio: ['pipe', 'pipe', 'pipe'],
    });
    // An explicit EOF pipe follows the normal execFile bootstrap path; avoid a
    // Windows NUL console handle. Neither input nor stderr carries tool content.
    helper.stdin!.on('error', () => {});
    helper.stdin!.end(JSON.stringify(options.anchors));
    helper.stderr!.on('data', () => {});
    let closed!: () => void;
    const whenClosed = new Promise<void>(resolveClosed => { closed = resolveClosed; });
    options.onHelper?.(helper, whenClosed);
    let diagnostic: WindowsCleanupProgress = { phase: 'windows_snapshot', code: 'running', snapshots: 0, terminationAttempts: 0, liveProcesses: 0 };
    let finished = false;
    let output = '';
    let bytes = 0;
    let exited = false;
    let exitCode: number | null = null;
    let released = false;
    let stopping: WindowsCleanupProgress['code'] | undefined;
    const deadline = Date.now() + options.timeoutMs;
    const finish = (success: boolean, patch: Partial<WindowsCleanupProgress> = {}) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      diagnostic = { ...diagnostic, ...patch, helperExited: exited, helperExitCode: exitCode, helperOutputBytes: bytes };
      resolve({ released: success, diagnostic });
    };
    const stop = (code: WindowsCleanupProgress['code'], deadlineExpired = false) => {
      stopping = code;
      helper.kill();
      // A failed attempt may return at its deadline, but its owner keeps the
      // whenClosed barrier and must not start another cleaner until it settles.
      if (deadlineExpired || Date.now() >= deadline) finish(false, { code });
    };
    const timer = setTimeout(() => stop('timeout', true), options.timeoutMs);
    helper.once('exit', code => { exited = true; exitCode = code; });
    helper.once('error', error => {
      const code = (error as NodeJS.ErrnoException).code;
      const osCode = code === 'ENOENT' || code === 'EACCES' || code === 'EPERM' || code === 'ESRCH' ? code : 'UNKNOWN';
      finish(false, { code: 'spawn_error', osCode });
    });
    const readLine = (line: string) => {
      if (!line.trim()) return;
      const item = JSON.parse(line) as Record<string, unknown>;
      if (item.type === 'anchor') {
        if (!Number.isSafeInteger(item.pid) || Number(item.pid) <= 1 || Number(item.pid) > 2_147_483_647
          || typeof item.created !== 'string' || !(identityPattern.test(item.created) || item.created === 'tombstone')) throw new Error('Invalid anchor.');
        if (item.minimumCreated !== null && item.minimumCreated !== undefined && (typeof item.minimumCreated !== 'string' || !identityPattern.test(item.minimumCreated))) throw new Error('Invalid anchor lower bound.');
        const anchor: WindowsProcessAnchor = item.created === 'tombstone' ? { pid: Number(item.pid), exited: true } : { pid: Number(item.pid), created: item.created };
        if (typeof item.minimumCreated === 'string') anchor.minimumCreated = item.minimumCreated;
        options.onAnchor?.(anchor);
      } else {
        if ((item.type !== 'progress' && item.type !== 'result') || !phases.has(String(item.phase)) || !codes.has(String(item.code))
          || !['snapshots', 'terminationAttempts', 'liveProcesses', 'nativeCode'].every(key => Number.isSafeInteger(item[key]) && Number(item[key]) >= 0)) throw new Error('Invalid cleanup status.');
        // A failed attempt is immutable. Only ownership identities may arrive
        // after its deadline; old progress must not overwrite a retry's status.
        if (finished) return;
        diagnostic = { phase: item.phase as WindowsCleanupProgress['phase'], code: item.code as WindowsCleanupProgress['code'],
          snapshots: Number(item.snapshots), terminationAttempts: Number(item.terminationAttempts), liveProcesses: Number(item.liveProcesses), nativeCode: Number(item.nativeCode) };
        if (typeof item.helperStage === 'string' && ['bootstrap', 'compile', 'snapshot', 'capture', 'terminate'].includes(item.helperStage)) {
          diagnostic.helperStage = item.helperStage as WindowsCleanupProgress['helperStage'];
        }
        options.onProgress?.(diagnostic);
        if (item.type === 'result') {
          if (typeof item.released !== 'boolean') throw new Error('Invalid cleanup result.');
          released = item.released;
        }
      }
    };
    helper.stdout!.on('data', (chunk: Buffer) => {
      // Termination is asynchronous: retain already-written ancestor identities
      // until the helper's actual close, even after returning a failed result.
      bytes = Math.min(1_048_577, bytes + chunk.length);
      if (bytes > 1_048_576) { stop('invalid_snapshot'); return; }
      output += chunk.toString('utf8');
      try {
        let newline: number;
        while ((newline = output.indexOf('\n')) >= 0) { readLine(output.slice(0, newline)); output = output.slice(newline + 1); }
      } catch { stop('invalid_snapshot'); }
    });
    helper.once('close', code => {
      let malformed = false;
      try { readLine(output); }
      catch { malformed = true; }
      // Publish the physical barrier only after consuming the final anchor line.
      closed();
      if (finished) return;
      if (stopping) { finish(false, { code: stopping }); return; }
      if (malformed) { finish(false, { code: 'invalid_snapshot' }); return; }
      finish(code === 0 && released, code === 0 && released ? {} : diagnostic.code === 'running' ? { code: 'helper_exit' } : {});
    });
  });
}
