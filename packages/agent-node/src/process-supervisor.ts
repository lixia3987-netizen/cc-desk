import { spawn, type ChildProcess } from 'node:child_process';
import { readdir, readFile, readlink } from 'node:fs/promises';
import path from 'node:path';

export interface CommandRequest {
  executable: string;
  argv: string[];
  cwd: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface CommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** Bytes received, including bytes discarded after the shared output limit. */
  outputBytes: number;
  truncated: boolean;
  timedOut: boolean;
  cancelled: boolean;
  cleanup: 'released' | 'cleanup_failed';
  /** Fixed stage/counters only: never command text, paths, environment, or helper stderr. */
  cleanupDiagnostic?: ProcessCleanupDiagnostic;
  error?: string;
}

export interface ProcessCleanupDiagnostic {
  phase: 'windows_snapshot' | 'windows_terminate' | 'windows_streams' | 'posix_terminate';
  code: 'running' | 'timeout' | 'spawn_error' | 'helper_exit' | 'invalid_snapshot' | 'identity_changed' | 'unreleased' | 'os_error';
  elapsedMs: number;
  snapshots: number;
  terminationAttempts: number;
  liveProcesses: number;
  guardianExited: boolean;
  streamsClosed: boolean;
  helperExitCode?: number | null;
  helperExited?: boolean;
  helperOutputBytes?: number;
  osCode?: 'ENOENT' | 'EACCES' | 'EPERM' | 'ESRCH' | 'UNKNOWN';
}

class CleanupError extends Error {
  constructor(readonly detail: Pick<ProcessCleanupDiagnostic, 'phase' | 'code'> & Partial<ProcessCleanupDiagnostic>) {
    super(`${detail.phase}:${detail.code}`);
  }
}

function safeOsCode(error: unknown): NonNullable<ProcessCleanupDiagnostic['osCode']> {
  const code = errno(error);
  return code === 'ENOENT' || code === 'EACCES' || code === 'EPERM' || code === 'ESRCH' ? code : 'UNKNOWN';
}

export interface ProcessSupervisorOptions {
  /** Only the fixed operational allowlist is copied; never provider credentials. */
  environment?: NodeJS.ProcessEnv;
  defaultTimeoutMs?: number;
  maxTimeoutMs?: number;
  defaultMaxOutputBytes?: number;
  maxOutputBytes?: number;
  cleanupTimeoutMs?: number;
  terminationGraceMs?: number;
  /** Defaults to the current runtime, including Electron's built-in Node runtime. */
  nodeExecutable?: string;
}

const ENVIRONMENT_KEYS = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC',
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE',
]);

/** No NODE_OPTIONS, shell startup hooks, npm config, or model/provider variables. */
export function commandEnvironment(source: NodeJS.ProcessEnv, forbiddenValues: readonly string[] = []): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && ENVIRONMENT_KEYS.has(key.toUpperCase()) && !forbiddenValues.some(secret => secret.length > 0 && value.includes(secret))) result[key] = value;
  }
  return result;
}

// The guardian stays alive after the approved command exits. In particular, Windows
// taskkill /T must still have a live tree root when an unref'ed descendant outlives
// its parent. The guardian never interprets command strings or uses a shell.
const GUARDIAN = String.raw`
const { spawn } = require('node:child_process');
let started = false;
process.on('SIGTERM', () => {});
process.on('message', message => {
  if (started || !message || message.type !== 'launch') return;
  started = true;
  try {
    const child = spawn(message.command.executable, message.command.argv, {
      cwd: message.command.cwd, env: message.environment, shell: false,
      windowsHide: true, stdio: ['ignore', 1, 2],
    });
    child.once('spawn', () => process.send?.({ type: 'command-started', pid: child.pid }));
    child.once('error', error => process.send?.({ type: 'launch-error', code: error.code }));
    child.once('exit', (code, signal) => process.send?.({ type: 'command-exit', code, signal }));
  } catch {
    process.send?.({ type: 'launch-error' });
  }
});
// Loss of the owning host cannot turn this into an intentionally persistent job.
process.on('disconnect', () => {
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/PID', String(process.pid), '/T', '/F'], {
      shell: false, windowsHide: true, stdio: 'ignore',
    });
    killer.on('error', () => process.exit(1));
  } else {
    try { process.kill(-process.pid, 'SIGKILL'); } catch { process.exit(1); }
  }
});
`;

interface CommandRecord {
  owner: string;
  environment: NodeJS.ProcessEnv;
  child: ChildProcess;
  pid?: number;
  commandPid?: number;
  windowsProcesses: Map<number, string>;
  closed: boolean;
  guardianExited: boolean;
  exitSeen: boolean;
  result: CommandResult;
  stdout: Buffer[];
  stderr: Buffer[];
  capturedBytes: number;
  outputLimit: number;
  cleanupPromise?: Promise<boolean>;
  cleanupFailed: boolean;
  done: Promise<CommandResult>;
  finish: () => void;
  timer?: NodeJS.Timeout;
  abort?: () => void;
  signal?: AbortSignal;
}

function positiveInteger(value: number, name: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} must be a positive integer no greater than ${maximum}.`);
  }
  return value;
}

function validateCommand(command: CommandRequest): void {
  if (!command || typeof command.executable !== 'string' || !command.executable.trim()
      || command.executable.includes('\0') || !Array.isArray(command.argv)
      || command.argv.length > 4_096
      || command.argv.some(arg => typeof arg !== 'string' || arg.includes('\0'))
      || typeof command.cwd !== 'string' || !path.isAbsolute(command.cwd) || command.cwd.includes('\0')) {
    throw new TypeError('A command requires an executable, string argv, and an absolute cwd.');
  }
  if (Buffer.byteLength(JSON.stringify(command)) > 128 * 1_024) {
    throw new TypeError('Command input exceeds 128 KiB.');
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function boundedText(chunks: Buffer[]): string {
  const buffer = Buffer.concat(chunks);
  // Do not turn a cut UTF-8 sequence into a replacement character beyond the
  // byte budget. Arbitrary invalid bytes can also expand when decoded to UTF-8.
  const text = new TextDecoder('utf-8').decode(buffer, { stream: true });
  if (Buffer.byteLength(text) <= buffer.length) return text;
  let bytes = 0;
  let characters = 0;
  for (const character of text) {
    bytes += Buffer.byteLength(character);
    if (bytes > buffer.length) break;
    characters += character.length;
  }
  return text.slice(0, characters);
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pid, signal); }
  catch (error) { if (errno(error) !== 'ESRCH') throw error; }
}

async function groupIsLive(pid: number): Promise<boolean> {
  try { process.kill(-pid, 0); }
  catch (error) {
    if (errno(error) === 'ESRCH') return false;
    throw error;
  }
  if (process.platform !== 'linux') return true;
  // Container init processes do not always reap orphan zombies promptly. A zombie
  // has no executing code or open descriptors and must not retain a directory lease.
  // Any unreadable live member is conservatively treated as a cleanup failure.
  return (await linuxLiveProcesses({ group: pid })).length > 0;
}

/** procfs may expose host PIDs while Node runs in a nested PID namespace. */
export async function linuxLiveProcesses(filter?: { pid?: number; group?: number }): Promise<{ pid: number; group: number }[]> {
  if (process.platform !== 'linux') throw new Error('Linux process inspection is unavailable.');
  const namespace = await readlink('/proc/self/ns/pid');
  const depth = (await readFile('/proc/self/status', 'utf8')).match(/^NSpid:\s+(.+)$/m)![1].trim().split(/\s+/).length;
  const result: { pid: number; group: number }[] = [];
  for (const name of await readdir('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const status = await readFile(`/proc/${name}/status`, 'utf8');
      const pids = status.match(/^NSpid:\s+(.+)$/m)?.[1].trim().split(/\s+/);
      if (pids?.length !== depth || /^State:\s+[ZX]/m.test(status)) continue;
      const namespacePid = pids.at(-1);
      const namespaceGroup = status.match(/^NSpgid:\s+(.+)$/m)?.[1].trim().split(/\s+/).at(-1);
      if (!namespacePid || !namespaceGroup) throw new Error('Cannot resolve Linux process namespace identities.');
      if (filter && !((filter.pid !== undefined && Number(namespacePid) === filter.pid) || (filter.group !== undefined && Number(namespaceGroup) === filter.group))) continue;
      if (await readlink(`/proc/${name}/ns/pid`) !== namespace) continue;
      result.push({ pid: Number(namespacePid), group: Number(namespaceGroup) });
    } catch (error) { if (errno(error) !== 'ENOENT' && errno(error) !== 'ESRCH') throw error; }
  }
  return result;
}

function taskkill(pid: number, environment: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ stopped: boolean; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const systemRoot = environment.SystemRoot ?? environment.SYSTEMROOT ?? environment.WINDIR;
    const executable = systemRoot ? path.join(systemRoot, 'System32', 'taskkill.exe') : 'taskkill.exe';
    const killer = spawn(executable, ['/PID', String(pid), '/T', '/F'], {
      shell: false, windowsHide: true, env: environment, stdio: 'ignore',
    });
    const timer = setTimeout(() => { killer.kill(); reject(new CleanupError({ phase: 'windows_terminate', code: 'timeout' })); }, timeoutMs);
    killer.once('error', error => { clearTimeout(timer); reject(new CleanupError({ phase: 'windows_terminate', code: 'spawn_error', osCode: safeOsCode(error) })); });
    killer.once('close', code => { clearTimeout(timer); resolve({ stopped: code === 0, exitCode: code }); });
  });
}

interface WindowsProcess {
  pid: number;
  parent: number;
  created: string;
}

function windowsProcessSnapshot(environment: NodeJS.ProcessEnv, timeoutMs: number): Promise<WindowsProcess[]> {
  const systemRoot = Object.entries(environment).find(([key]) => key.toUpperCase() === 'SYSTEMROOT')?.[1];
  const executable = systemRoot
    ? path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe';
  // Only process identities and parent links are returned, never command lines.
  // An exited intermediate parent can disappear from taskkill's tree traversal;
  // CIM still exposes its PID as the surviving child's ParentProcessId.
  const script = "$ErrorActionPreference='Stop'; @(Get-CimInstance -Query 'SELECT ProcessId,ParentProcessId,CreationDate FROM Win32_Process' | ForEach-Object { @{ pid=[int]$_.ProcessId; parent=[int]$_.ParentProcessId; created=$(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().Ticks.ToString() } else { 'unknown' }) } }) | ConvertTo-Json -Compress; exit 0";
  return new Promise((resolve, reject) => {
    const reader = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      shell: false, windowsHide: true, env: environment, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let exited = false;
    let exitCode: number | null = null;
    reader.once('exit', code => { exited = true; exitCode = code; });
    const timer = setTimeout(() => {
      reader.kill();
      reject(new CleanupError({ phase: 'windows_snapshot', code: 'timeout', helperExited: exited, helperExitCode: exitCode, helperOutputBytes: bytes }));
    }, timeoutMs);
    reader.stdout.on('data', (data: Buffer) => {
      bytes += data.length;
      if (bytes > 1_048_576) {
        reader.kill();
        reject(new CleanupError({ phase: 'windows_snapshot', code: 'invalid_snapshot', helperOutputBytes: bytes }));
      } else chunks.push(data);
    });
    reader.once('error', error => { clearTimeout(timer); reject(new CleanupError({ phase: 'windows_snapshot', code: 'spawn_error', osCode: safeOsCode(error) })); });
    reader.once('close', code => {
      clearTimeout(timer);
      try {
        if (code !== 0) throw new CleanupError({ phase: 'windows_snapshot', code: 'helper_exit', helperExitCode: code, helperOutputBytes: bytes });
        if (bytes > 1_048_576) throw new CleanupError({ phase: 'windows_snapshot', code: 'invalid_snapshot', helperOutputBytes: bytes });
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, ''));
        if (!Array.isArray(value) || !value.every(item => item && typeof item === 'object'
          && Number.isSafeInteger(item.pid) && Number.isSafeInteger(item.parent) && typeof item.created === 'string')) {
          throw new Error('Invalid process enumeration.');
        }
        resolve(value as WindowsProcess[]);
      } catch (error) { reject(error instanceof CleanupError ? error : new CleanupError({ phase: 'windows_snapshot', code: 'invalid_snapshot', helperExitCode: code, helperOutputBytes: bytes })); }
    });
  });
}

function windowsTree(record: Pick<CommandRecord, 'pid' | 'commandPid' | 'windowsProcesses'>, snapshot: WindowsProcess[]): WindowsProcess[] {
  const current = new Map(snapshot.map(item => [item.pid, item]));
  const anchors = new Set<number>();
  for (const pid of [record.pid, record.commandPid, ...record.windowsProcesses.keys()]) {
    if (!pid) continue;
    const knownCreation = record.windowsProcesses.get(pid);
    // Do not signal a PID that has been reused since an earlier cleanup attempt.
    if (knownCreation && current.has(pid) && current.get(pid)!.created !== knownCreation) {
      throw new CleanupError({ phase: 'windows_snapshot', code: 'identity_changed' });
    }
    anchors.add(pid);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of snapshot) {
      if (anchors.has(item.parent) && !anchors.has(item.pid)) {
        anchors.add(item.pid);
        changed = true;
      }
    }
  }
  const tree = snapshot.filter(item => anchors.has(item.pid));
  for (const item of tree) record.windowsProcesses.set(item.pid, item.created);
  return tree;
}

/** Release a host-owned Windows tree even if its root exited before cleanup began. */
export async function stopWindowsProcessTree(pid: number, timeoutMs = 10000): Promise<void> {
  if (process.platform !== 'win32' || !Number.isSafeInteger(pid) || pid <= 1) throw new Error('Invalid Windows process tree.');
  const environment = commandEnvironment(process.env);
  const record = { pid, windowsProcesses: new Map<number, string>() };
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(1, deadline - Date.now());
  let tree = windowsTree(record, await windowsProcessSnapshot(environment, remaining()));
  while (tree.length && Date.now() < deadline) {
    for (const process of [...tree].reverse()) await taskkill(process.pid, environment, remaining());
    tree = windowsTree(record, await windowsProcessSnapshot(environment, remaining()));
  }
  if (tree.length) throw new Error('Windows process descendants have not released.');
}

/**
 * Host-owned finite command execution. stopOwner is a release barrier and revokes
 * that owner permanently; use a fresh run/generation identity for later work.
 * Failed cleanup remains visible in has()/activeCount until a successful retry.
 * This supervises ordinary process groups/trees, not a system sandbox: a hostile
 * program can escape a POSIX group, so approved commands must be trusted.
 */
export class ProcessSupervisor {
  private readonly environment: NodeJS.ProcessEnv;
  private readonly records = new Set<CommandRecord>();
  private readonly revokedOwners = new Set<string>();
  private readonly timeoutMs: number;
  private readonly maxTimeoutMs: number;
  private readonly outputLimit: number;
  private readonly maxOutputBytes: number;
  private readonly cleanupTimeoutMs: number;
  private readonly terminationGraceMs: number;
  private readonly nodeExecutable: string;
  private disposed = false;

  constructor(options: ProcessSupervisorOptions = {}) {
    this.environment = commandEnvironment(options.environment ?? process.env);
    this.maxTimeoutMs = positiveInteger(options.maxTimeoutMs ?? 120_000, 'maxTimeoutMs', 3_600_000);
    this.timeoutMs = positiveInteger(options.defaultTimeoutMs ?? Math.min(120_000, this.maxTimeoutMs), 'defaultTimeoutMs', this.maxTimeoutMs);
    this.maxOutputBytes = positiveInteger(options.maxOutputBytes ?? 1_048_576, 'maxOutputBytes', 16_777_216);
    this.outputLimit = positiveInteger(options.defaultMaxOutputBytes ?? Math.min(65_536, this.maxOutputBytes), 'defaultMaxOutputBytes', this.maxOutputBytes);
    this.cleanupTimeoutMs = positiveInteger(options.cleanupTimeoutMs ?? (process.platform === 'win32' ? 10_000 : 3_000), 'cleanupTimeoutMs', 30_000);
    this.terminationGraceMs = positiveInteger(options.terminationGraceMs ?? Math.min(100, this.cleanupTimeoutMs), 'terminationGraceMs', this.cleanupTimeoutMs);
    this.nodeExecutable = options.nodeExecutable ?? process.execPath;
  }

  get activeCount(): number { return this.records.size; }

  has(ownerId: string): boolean { return [...this.records].some(record => record.owner === ownerId); }

  async run(ownerId: string, command: CommandRequest, signal?: AbortSignal, forbiddenValues: readonly string[] = []): Promise<CommandResult> {
    if (typeof ownerId !== 'string' || !ownerId || ownerId.length > 1_024) throw new TypeError('An owner ID is required.');
    if (this.disposed || this.revokedOwners.has(ownerId)) throw new Error('Command owner has been released.');
    validateCommand(command);
    const launchCommand: CommandRequest = {
      executable: command.executable, argv: [...command.argv], cwd: command.cwd,
    };
    const timeoutMs = positiveInteger(command.timeoutMs ?? this.timeoutMs, 'timeoutMs', this.maxTimeoutMs);
    const outputLimit = positiveInteger(command.maxOutputBytes ?? this.outputLimit, 'maxOutputBytes', this.maxOutputBytes);
    const result: CommandResult = {
      exitCode: null, signal: null, stdout: '', stderr: '', outputBytes: 0,
      truncated: false, timedOut: false, cancelled: signal?.aborted ?? false, cleanup: 'released',
    };
    if (signal?.aborted) return result;

    // Credentials resolved for this run may be stored in an otherwise operational
    // variable (for example LANG). Scrub values in both guardian and tool envs,
    // without changing another concurrent run's launch environment.
    const launchEnvironment = commandEnvironment(this.environment, forbiddenValues);
    if (!path.isAbsolute(command.executable) && !/[\\/]/.test(command.executable)
      && !Object.keys(launchEnvironment).some(key => key.toUpperCase() === 'PATH')) {
      result.error = 'Executable lookup requires PATH; select an absolute executable when PATH is unavailable or filtered.';
      return result;
    }
    const guardianEnvironment = { ...launchEnvironment };
    if (process.versions.electron) guardianEnvironment.ELECTRON_RUN_AS_NODE = '1';
    const child = spawn(this.nodeExecutable, ['-e', GUARDIAN], {
      cwd: command.cwd, env: guardianEnvironment, shell: false,
      detached: process.platform !== 'win32', windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let finish!: () => void;
    const done = new Promise<CommandResult>(resolve => {
      finish = () => resolve(result);
    });
    const record: CommandRecord = {
      owner: ownerId, environment: launchEnvironment, child, pid: child.pid, closed: false, guardianExited: false, exitSeen: false,
      windowsProcesses: new Map(),
      result, stdout: [], stderr: [], capturedBytes: 0, outputLimit,
      cleanupFailed: false, done, finish, signal,
    };
    this.records.add(record);
    const capture = (chunks: Buffer[], data: Buffer) => {
      result.outputBytes = Math.min(Number.MAX_SAFE_INTEGER, result.outputBytes + data.length);
      const available = Math.max(0, outputLimit - record.capturedBytes);
      if (data.length > available) result.truncated = true;
      if (available) {
        const retained = Buffer.from(data.subarray(0, available));
        chunks.push(retained);
        record.capturedBytes += retained.length;
      }
    };
    child.stdout!.on('data', (data: Buffer) => capture(record.stdout, data));
    child.stderr!.on('data', (data: Buffer) => capture(record.stderr, data));
    child.once('error', () => {
      result.error = 'Unable to start the command runtime.';
      void this.stopRecord(record);
    });
    child.once('exit', () => { record.guardianExited = true; });
    child.once('close', () => {
      record.closed = true;
      if (!record.exitSeen && !record.cleanupPromise) result.error ??= 'Command runtime exited before reporting a result.';
      void this.stopRecord(record);
    });
    child.on('message', (message: unknown) => {
      if (!message || typeof message !== 'object') return;
      const value = message as Record<string, unknown>;
      if (value.type === 'command-started' && Number.isSafeInteger(value.pid) && Number(value.pid) > 0) {
        record.commandPid = Number(value.pid);
        return;
      }
      if (record.cleanupPromise) return;
      if (value.type === 'command-exit') {
        record.exitSeen = true;
        result.exitCode = typeof value.code === 'number' ? value.code : null;
        result.signal = typeof value.signal === 'string' ? value.signal as NodeJS.Signals : null;
        void this.stopRecord(record);
      } else if (value.type === 'launch-error') {
        result.error = value.code === 'ENOENT' ? 'Executable or working directory was not found.' : 'Unable to launch the command.';
        void this.stopRecord(record);
      }
    });
    child.once('spawn', () => {
      if (record.cleanupPromise) return;
      child.send({ type: 'launch', command: launchCommand, environment: launchEnvironment }, error => {
        if (error && !record.cleanupPromise) {
          result.error = 'Unable to initialize the command runtime.';
          void this.stopRecord(record);
        }
      });
    });
    record.timer = setTimeout(() => {
      result.timedOut = true;
      void this.stopRecord(record);
    }, timeoutMs);
    record.abort = () => { result.cancelled = true; void this.stopRecord(record); };
    signal?.addEventListener('abort', record.abort, { once: true });
    if (signal?.aborted) record.abort();
    return done;
  }

  async stopOwner(ownerId: string): Promise<void> {
    this.revokedOwners.add(ownerId);
    const results = await Promise.all([...this.records].filter(record => record.owner === ownerId).map(record => {
      record.result.cancelled = true;
      return this.stopRecord(record);
    }));
    if (results.some(released => !released)) throw new Error('Command process cleanup failed; the owner remains occupied.');
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const results = await Promise.all([...this.records].map(record => {
      record.result.cancelled = true;
      return this.stopRecord(record);
    }));
    if (results.some(released => !released)) throw new Error('Command process cleanup failed; resources remain occupied.');
  }

  private stopRecord(record: CommandRecord): Promise<boolean> {
    if (record.cleanupPromise) return record.cleanupPromise;
    if (record.timer) clearTimeout(record.timer);
    if (record.abort) record.signal?.removeEventListener('abort', record.abort);
    const startedAt = Date.now();
    record.result.cleanupDiagnostic = {
      phase: process.platform === 'win32' ? 'windows_snapshot' : 'posix_terminate', code: 'running',
      elapsedMs: 0, snapshots: 0, terminationAttempts: 0, liveProcesses: 0,
      guardianExited: record.guardianExited, streamsClosed: record.closed,
    };
    record.cleanupPromise = this.releaseTree(record).catch(error => {
      Object.assign(record.result.cleanupDiagnostic!, error instanceof CleanupError ? error.detail : { code: 'os_error', osCode: safeOsCode(error) });
      return false;
    }).then(released => {
      record.cleanupFailed = !released;
      record.result.cleanup = released ? 'released' : 'cleanup_failed';
      if (!released) {
        const diagnostic = record.result.cleanupDiagnostic!;
        if (diagnostic.code === 'running') diagnostic.code = 'unreleased';
        diagnostic.elapsedMs = Date.now() - startedAt;
        diagnostic.guardianExited = record.guardianExited;
        diagnostic.streamsClosed = record.closed;
        record.result.error = 'Command process cleanup failed; the owner remains occupied. ' + JSON.stringify(diagnostic);
      } else delete record.result.cleanupDiagnostic;
      if (released) this.records.delete(record);
      // Always keep draining until the bounded release attempt finishes. Failed
      // cleanup is retained as occupied even though host stream handles are closed.
      if (!released) { record.child.stdout?.destroy(); record.child.stderr?.destroy(); }
      record.result.stdout = boundedText(record.stdout);
      record.result.stderr = boundedText(record.stderr);
      record.finish();
      if (!released) record.cleanupPromise = undefined;
      return released;
    });
    return record.cleanupPromise;
  }

  private async releaseTree(record: CommandRecord): Promise<boolean> {
    if (!record.pid) return true; // spawn failure: no OS process was created.
    const deadline = Date.now() + this.cleanupTimeoutMs;
    if (process.platform === 'win32') {
      // Verify identities and surviving descendants independently of taskkill's
      // return code, including an already-exited command parent. If this platform
      // cannot enumerate processes, fail closed and retain owner occupancy.
      while (Date.now() < deadline) {
        const diagnostic = record.result.cleanupDiagnostic!;
        diagnostic.phase = 'windows_snapshot';
        const snapshot = await windowsProcessSnapshot(record.environment, Math.max(1, deadline - Date.now()));
        diagnostic.snapshots++;
        const tree = windowsTree(record, snapshot);
        diagnostic.liveProcesses = tree.length;
        if (tree.length === 0 && record.closed) return true;
        diagnostic.phase = tree.length ? 'windows_terminate' : 'windows_streams';
        for (const item of tree) {
          if (Date.now() >= deadline) return false;
          diagnostic.terminationAttempts++;
          const killed = await taskkill(item.pid, record.environment, Math.max(1, deadline - Date.now()));
          diagnostic.helperExitCode = killed.exitCode;
        }
        await delay(10);
      }
      return false;
    }
    killGroup(record.pid, 'SIGTERM');
    await delay(Math.min(this.terminationGraceMs, Math.max(0, deadline - Date.now())));
    killGroup(record.pid, 'SIGKILL');
    while (Date.now() < deadline) {
      if (record.closed && !(await groupIsLive(record.pid))) return true;
      await delay(10);
    }
    return record.closed && !(await groupIsLive(record.pid));
  }
}
