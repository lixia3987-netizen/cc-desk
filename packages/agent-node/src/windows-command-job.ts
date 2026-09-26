import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

export interface WindowsCommandJobDiagnostic {
  phase: 'windows_job';
  code: 'running' | 'released' | 'cancelled' | 'timeout' | 'spawn_error' | 'helper_exit' | 'protocol_error' | 'ownership_unconfirmed' | 'bind_failed' | 'query_failed' | 'terminate_failed';
  stage: 'compile' | 'open' | 'challenge' | 'bind' | 'active' | 'terminate' | 'query' | 'closed';
  nativeCode?: number;
  activeProcesses?: number;
  helperExitCode?: number | null;
  helperStarted?: boolean;
  modulesLoaded?: boolean;
}

export interface WindowsCommandJob {
  /** True requires an empty owned job AND the helper's physical close event. */
  stop(timeoutMs: number): Promise<boolean>;
  readonly diagnostic: WindowsCommandJobDiagnostic;
  readonly whenClosed: Promise<void>;
  readonly closed: boolean;
  /** Recheck immediately before launch: readiness can be revoked by later input or exit. */
  readonly usable: boolean;
}

export interface WindowsCommandJobOptions {
  guardianPid: number;
  /** Respond to this fresh nonce over the original guardian's Node IPC channel. */
  challenge: (nonce: string) => Promise<void>;
  timeoutMs: number;
  environment: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** The caller retains this barrier even when binding rejects. */
  onHelper?: (helper: ChildProcess, whenClosed: Promise<void>) => void;
}

export class WindowsCommandJobError extends Error {
  constructor(readonly diagnostic: WindowsCommandJobDiagnostic) {
    super(`Windows command job initialization failed (${diagnostic.code}, ${diagnostic.stage}).`);
    this.name = 'WindowsCommandJobError';
  }
}

function validTimeout(timeoutMs: number): void {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new TypeError('Invalid Windows job timeout.');
}

/** Internal builder for real Windows regressions; no commands, paths or secrets enter this script. */
export function buildWindowsCommandJobScript(guardianPid: number, nonce: string, timeoutMs: number): string {
  validTimeout(timeoutMs);
  if (!Number.isSafeInteger(guardianPid) || guardianPid < 2 || guardianPid > 2_147_483_647 || !/^[a-f0-9]{64}$/.test(nonce)) {
    throw new TypeError('Invalid Windows job guardian identity.');
  }
  return `
$ErrorActionPreference='Stop'
[Console]::Out.WriteLine('{"type":"progress","stage":"compile"}')
[Console]::Out.Flush()
try {
$PSModuleAutoLoadingPreference='None'
# Resolve built-in cmdlets directly, without user/project module discovery or
# restoring PSModulePath values removed from the command environment.
Import-Module -Name ([IO.Path]::Combine($PSHOME,'Modules','Microsoft.PowerShell.Utility','Microsoft.PowerShell.Utility.psd1')) -ErrorAction Stop
[Console]::Out.WriteLine('{"type":"progress","stage":"compile","modulesLoaded":true}')
[Console]::Out.Flush()
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
public static class CommandJobOwner {
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes; }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
    public BasicLimits Basic;
    public IoCounters Io;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
  }
  [StructLayout(LayoutKind.Sequential)] struct Accounting {
    public long TotalUserTime, TotalKernelTime, PeriodUserTime, PeriodKernelTime;
    public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int informationClass, ref ExtendedLimits limits, uint length);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int informationClass, out Accounting accounting, uint length, IntPtr returnedLength);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool member);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static void Emit(string text) { Console.Out.WriteLine(text); Console.Out.Flush(); }
  static Exception NativeFailure() { return new InvalidOperationException(); }
  public static int Run(int guardianPid, string nonce, int bindingTimeoutMs) {
    IntPtr job=IntPtr.Zero, guardian=IntPtr.Zero;
    string stage="open", code="bind_failed";
    int nativeCode=0;
    uint active=0;
    bool released=false;
    try {
      job=CreateJobObject(IntPtr.Zero,null);
      if(job==IntPtr.Zero) { nativeCode=Marshal.GetLastWin32Error(); throw NativeFailure(); }
      ExtendedLimits limits=new ExtendedLimits();
      // Neither BREAKAWAY_OK nor SILENT_BREAKAWAY_OK: descendants keep this
      // strict ancestor even when their own libuv jobs allow daemonization.
      limits.Basic.LimitFlags=0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
      if(!SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(ExtendedLimits)))) { nativeCode=Marshal.GetLastWin32Error(); throw NativeFailure(); }
      guardian=OpenProcess(0x101101,false,guardianPid); // synchronize, query, set quota, terminate
      if(guardian==IntPtr.Zero) { nativeCode=Marshal.GetLastWin32Error(); throw NativeFailure(); }
      if(WaitForSingleObject(guardian,0)!=258) { code="ownership_unconfirmed"; throw NativeFailure(); }
      stage="challenge";
      Emit("{\\"type\\":\\"held\\",\\"nonce\\":\\""+nonce+"\\"}");
      // Open HANDLE precedes the fresh original-IPC challenge. The original
      // guardian must still answer after this handle was opened, so a reused
      // numeric PID cannot authorize assigning an unrelated process.
      Task<string> binding=Task.Run(()=>Console.In.ReadLine());
      if(!binding.Wait(bindingTimeoutMs)) { code="timeout"; throw NativeFailure(); }
      if(binding.Result!="bind "+nonce) { code="ownership_unconfirmed"; throw NativeFailure(); }
      stage="bind";
      if(WaitForSingleObject(guardian,0)!=258) { code="ownership_unconfirmed"; throw NativeFailure(); }
      // windows-command-job:before-assign
      if(!AssignProcessToJobObject(job,guardian)) { nativeCode=Marshal.GetLastWin32Error(); throw NativeFailure(); }
      bool member=false;
      if(!IsProcessInJob(guardian,job,out member) || !member) { nativeCode=Marshal.GetLastWin32Error(); throw NativeFailure(); }
      // Retaining an exited process reference can delay ActiveProcesses=0.
      // The private job HANDLE now carries ownership; no further PID lookup.
      CloseHandle(guardian); guardian=IntPtr.Zero;
      stage="active";
      Emit("{\\"type\\":\\"ready\\"}");
      // EOF on host loss follows the same termination path. An abrupt helper
      // death closes its last, noninherited job HANDLE and triggers KILL_ON_CLOSE.
      string command=Console.In.ReadLine();
      int stopTimeoutMs=10000;
      if(command!=null) {
        if(!command.StartsWith("stop ") || !Int32.TryParse(command.Substring(5),out stopTimeoutMs) || stopTimeoutMs<1 || stopTimeoutMs>30000) {
          code="protocol_error"; throw NativeFailure();
        }
      }
      Stopwatch deadline=Stopwatch.StartNew();
      stage="terminate"; code="terminate_failed";
      if(!TerminateJobObject(job,1)) { nativeCode=Marshal.GetLastWin32Error(); throw NativeFailure(); }
      stage="query"; code="query_failed";
      while(true) {
        Accounting accounting;
        if(!QueryInformationJobObject(job,1,out accounting,(uint)Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero)) {
          nativeCode=Marshal.GetLastWin32Error(); throw NativeFailure();
        }
        active=accounting.ActiveProcesses;
        if(active==0) { released=true; code="released"; break; }
        if(deadline.ElapsedMilliseconds>=stopTimeoutMs) { code="timeout"; break; }
        Thread.Sleep(10);
      }
    } catch { }
    finally {
      if(guardian!=IntPtr.Zero) CloseHandle(guardian);
      if(job!=IntPtr.Zero) CloseHandle(job);
    }
    Emit("{\\"type\\":\\"result\\",\\"released\\":"+(released?"true":"false")+",\\"stage\\":\\""+stage+"\\",\\"code\\":\\""+code+"\\",\\"nativeCode\\":"+nativeCode+",\\"activeProcesses\\":"+active+"}");
    return released?0:1;
  }
}
'@
exit ([CommandJobOwner]::Run(${guardianPid},'${nonce}',${timeoutMs}))
} catch {
  [Console]::Out.WriteLine('{"type":"result","released":false,"stage":"compile","code":"bind_failed","nativeCode":0,"activeProcesses":0}')
  exit 1
}
`;
}

const stages = new Set<WindowsCommandJobDiagnostic['stage']>(['compile', 'open', 'challenge', 'bind', 'active', 'terminate', 'query', 'closed']);
const resultCodes = new Set<WindowsCommandJobDiagnostic['code']>(['released', 'timeout', 'protocol_error', 'ownership_unconfirmed', 'bind_failed', 'query_failed', 'terminate_failed']);

/** Internal transport seam for deterministic lifecycle tests on every platform. */
export function connectWindowsCommandJob(options: WindowsCommandJobOptions, helper: ChildProcess, nonce: string): Promise<WindowsCommandJob> {
  validTimeout(options.timeoutMs);
  let resolveReady!: (job: WindowsCommandJob) => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<WindowsCommandJob>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  let resolveClosed!: () => void;
  const whenClosed = new Promise<void>(resolve => { resolveClosed = resolve; });
  let closed = false, exited = false, settled = false, bound = false, held = false, bindSent = false, stopSent = false;
  let resultSeen = false, released = false, fatal = false, pending = '', outputBytes = 0;
  let exitCode: number | null = null;
  let stopping: Promise<boolean> | undefined;
  let diagnostic: WindowsCommandJobDiagnostic = { phase: 'windows_job', code: 'running', stage: 'compile' };
  const killHelper = () => { try { helper.kill('SIGKILL'); } catch { /* physical close still required */ } };
  const rejectBinding = () => {
    if (settled) return;
    settled = true;
    clearTimeout(bindingTimer);
    options.signal?.removeEventListener('abort', abort);
    rejectReady(new WindowsCommandJobError({ ...diagnostic }));
  };
  const fail = (code: WindowsCommandJobDiagnostic['code']) => {
    if (fatal) return;
    fatal = true; released = false;
    diagnostic = { ...diagnostic, code };
    rejectBinding();
    killHelper();
  };
  const abort = () => fail('cancelled');
  const bindingTimer = setTimeout(() => fail('timeout'), options.timeoutMs);
  const job: WindowsCommandJob = {
    get diagnostic() { return { ...diagnostic }; },
    get whenClosed() { return whenClosed; },
    get closed() { return closed; },
    get usable() { return bound && !fatal && !closed && !exited && !stopSent && !resultSeen; },
    stop(timeoutMs) {
      validTimeout(timeoutMs);
      if (closed) return Promise.resolve(released && !fatal && exitCode === 0);
      if (stopping) return stopping;
      stopping = new Promise<boolean>(resolve => {
        const timer = setTimeout(() => {
          diagnostic = { ...diagnostic, code: 'timeout' };
          // KILL_ON_JOB_CLOSE still attempts to stop the tree; without empty-job
          // evidence this attempt cannot authorize releasing the owner.
          killHelper();
          resolve(false);
        }, timeoutMs);
        void whenClosed.then(() => { clearTimeout(timer); resolve(released && !fatal && exitCode === 0); });
        if (!stopSent && !fatal) {
          stopSent = true;
          diagnostic = { ...diagnostic, stage: 'terminate' };
          helper.stdin?.end(`stop ${timeoutMs}\n`);
        }
      }).finally(() => { stopping = undefined; });
      return stopping;
    },
  };
  function receive(line: string): void {
    if (fatal) return;
    let value: Record<string, unknown>;
    try { value = JSON.parse(line) as Record<string, unknown>; } catch { fail('protocol_error'); return; }
    if (!value || typeof value !== 'object') { fail('protocol_error'); return; }
    if (value.type === 'progress' && value.stage === 'compile' && !held && !resultSeen
      && (!diagnostic.helperStarted && value.modulesLoaded === undefined
        || diagnostic.helperStarted && !diagnostic.modulesLoaded && value.modulesLoaded === true)) {
      diagnostic = { ...diagnostic, helperStarted: true, ...(value.modulesLoaded === true ? { modulesLoaded: true } : {}) };
    } else if (value.type === 'held' && value.nonce === nonce && !held && !bound && !resultSeen) {
      held = true; diagnostic = { ...diagnostic, stage: 'challenge' };
      void Promise.resolve().then(() => options.challenge(nonce)).then(() => {
        if (fatal || closed || settled || options.signal?.aborted) return;
        bindSent = true; diagnostic = { ...diagnostic, stage: 'bind' };
        helper.stdin?.write(`bind ${nonce}\n`);
      }, () => fail('ownership_unconfirmed'));
    } else if (value.type === 'ready' && held && bindSent && !bound && !resultSeen) {
      if (options.signal?.aborted) { fail('cancelled'); return; }
      bound = true; settled = true;
      clearTimeout(bindingTimer); options.signal?.removeEventListener('abort', abort);
      diagnostic = { ...diagnostic, stage: 'active' };
      resolveReady(job);
    } else if (value.type === 'result' && !resultSeen
      && typeof value.released === 'boolean'
      && stages.has(value.stage as WindowsCommandJobDiagnostic['stage'])
      && resultCodes.has(value.code as WindowsCommandJobDiagnostic['code'])
      && Number.isSafeInteger(value.nativeCode) && Number(value.nativeCode) >= 0 && Number(value.nativeCode) <= 0xffff_ffff
      && Number.isSafeInteger(value.activeProcesses) && Number(value.activeProcesses) >= 0 && Number(value.activeProcesses) <= 0xffff_ffff) {
      resultSeen = true;
      released = bound && stopSent && value.released && value.code === 'released' && value.stage === 'query' && value.activeProcesses === 0;
      diagnostic = { ...diagnostic, code: value.code as WindowsCommandJobDiagnostic['code'], stage: value.stage as WindowsCommandJobDiagnostic['stage'], nativeCode: Number(value.nativeCode), activeProcesses: Number(value.activeProcesses) };
      if (value.released && !released || !value.released && value.code === 'released') { fail('protocol_error'); return; }
      if (!bound) { rejectBinding(); killHelper(); }
    } else fail('protocol_error');
  }
  helper.stdout?.on('data', (chunk: Buffer) => {
    outputBytes += chunk.length;
    if (outputBytes > 16_384) { fail('protocol_error'); return; }
    pending += chunk.toString('utf8');
    let split: number;
    while ((split = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, split).replace(/\r$/, ''); pending = pending.slice(split + 1);
      if (line) receive(line);
    }
  });
  // Drain diagnostic stderr without reflecting arbitrary executable output.
  helper.stderr?.on('data', () => {});
  helper.stdin?.on('error', () => fail('helper_exit'));
  helper.once('error', () => fail('spawn_error'));
  helper.once('exit', () => { exited = true; });
  helper.once('close', code => {
    exitCode = code; closed = true;
    clearTimeout(bindingTimer); options.signal?.removeEventListener('abort', abort);
    if (pending.trim() || !resultSeen || code !== 0) {
      released = false;
      if (diagnostic.code === 'running' || diagnostic.code === 'released') diagnostic = { ...diagnostic, code: 'helper_exit' };
    }
    diagnostic = { ...diagnostic, helperExitCode: code };
    rejectBinding();
    resolveClosed();
  });
  options.signal?.addEventListener('abort', abort, { once: true });
  try { options.onHelper?.(helper, whenClosed); } catch { fail('ownership_unconfirmed'); }
  if (options.signal?.aborted) abort();
  return ready;
}

/** Bind a private non-breakaway job before the caller authorizes guardian launch. */
export function createWindowsCommandJob(options: WindowsCommandJobOptions): Promise<WindowsCommandJob> {
  const nonce = randomBytes(32).toString('hex');
  const script = buildWindowsCommandJobScript(options.guardianPid, nonce, options.timeoutMs);
  if (options.signal?.aborted) return Promise.reject(new WindowsCommandJobError({ phase: 'windows_job', code: 'cancelled', stage: 'compile' }));
  const systemRoots = Object.entries(options.environment).filter(([key]) => key.toUpperCase() === 'SYSTEMROOT');
  const systemRoot = systemRoots.length === 1 ? systemRoots[0][1] : undefined;
  // Credential filtering may remove even operational environment values. Never
  // replace that absence with a PATH/cwd lookup or values from process.env.
  // win32.isAbsolute alone also accepts \Windows, which depends on the current
  // drive. SystemRoot must be the supplied, fully qualified local Windows root.
  if (typeof systemRoot !== 'string' || !path.win32.isAbsolute(systemRoot)
    || !/^[a-z]:[\\/]/i.test(systemRoot) || /[\0\r\n]/.test(systemRoot)) {
    return Promise.reject(new WindowsCommandJobError({ phase: 'windows_job', code: 'spawn_error', stage: 'compile' }));
  }
  const executable = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const helper = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    env: options.environment, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  return connectWindowsCommandJob(options, helper, nonce);
}
