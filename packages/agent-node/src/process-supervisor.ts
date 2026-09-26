import { spawn, type ChildProcess } from 'node:child_process';
import { readdir, readFile, readlink } from 'node:fs/promises';
import path from 'node:path';
import { runWindowsTreeCleanup, type WindowsProcessAnchor } from './windows-process-tree.js';
import { createWindowsCommandJob, WindowsCommandJobError, type WindowsCommandJob, type WindowsCommandJobDiagnostic } from './windows-command-job.js';

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
  phase: 'windows_snapshot' | 'windows_terminate' | 'windows_streams' | 'windows_helper_release' | 'windows_job' | 'posix_terminate';
  code: 'running' | 'timeout' | 'spawn_error' | 'helper_exit' | 'invalid_snapshot' | 'identity_changed' | 'identity_unavailable' | 'unreleased' | 'os_error'
    | 'released' | 'cancelled' | 'protocol_error' | 'ownership_unconfirmed' | 'bind_failed' | 'query_failed' | 'terminate_failed';
  elapsedMs: number;
  snapshots: number;
  terminationAttempts: number;
  liveProcesses: number;
  guardianExited: boolean;
  streamsClosed: boolean;
  helperStage?: 'bootstrap' | 'compile' | 'snapshot' | 'capture' | 'terminate';
  jobStage?: 'compile' | 'open' | 'challenge' | 'bind' | 'active' | 'terminate' | 'query' | 'closed';
  nativeCode?: number;
  helperExitCode?: number | null;
  helperExited?: boolean;
  helperStarted?: boolean;
  helperOutputBytes?: number;
  osCode?: 'ENOENT' | 'EACCES' | 'EPERM' | 'ESRCH' | 'UNKNOWN';
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

// The guardian waits for host authorization before launching the command. Windows
// first binds it to an owned Job; POSIX uses its detached process group.
const GUARDIAN = String.raw`
const { spawn } = require('node:child_process');
let started = false;
process.on('SIGTERM', () => {});
process.on('message', message => {
  if (!started && message && message.type === 'challenge' && typeof message.nonce === 'string') {
    process.send?.({ type: 'challenge-response', nonce: message.nonce });
    return;
  }
  if (started || !message || message.type !== 'launch') return;
  started = true;
  try {
    const spawnStartedAt = Date.now();
    const child = spawn(message.command.executable, message.command.argv, {
      cwd: message.command.cwd, env: message.environment, shell: false,
      windowsHide: true, stdio: ['ignore', 1, 2],
    });
    const spawnCompletedAt = Date.now();
    child.once('spawn', () => process.send?.({ type: 'command-started', pid: child.pid, spawnStartedAt, spawnCompletedAt }));
    child.once('error', error => process.send?.({ type: 'launch-error', code: error.code }));
    child.once('exit', (code, signal) => process.send?.({ type: 'command-exit', code, signal }));
  } catch {
    process.send?.({ type: 'launch-error' });
  }
});
// Loss of the owning host cannot turn this into an intentionally persistent job.
process.on('disconnect', () => {
  if (process.platform === 'win32') {
    // The host-owned Job helper loses its input pipe too and closes the Job.
    // No executable lookup or recycled PID can authorize a second tree killer.
    process.exit(1);
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
  windowsHelpers: Map<Promise<void>, ChildProcess>;
  windowsJob?: WindowsCommandJob;
  windowsPreparation?: Promise<void>;
  windowsPreparationAbort?: AbortController;
  windowsPreparationDiagnostic?: WindowsCommandJobDiagnostic;
  cleanupRequested: boolean;
  commandLaunched: boolean;
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

export interface WindowsRootIdentity {
  rootExited: boolean;
  spawnStartedAt?: number;
  spawnCompletedAt?: number;
}

const standaloneWindowsOwners = new Map<number, {
  anchors: Map<number, WindowsProcessAnchor>;
  helpers: Map<Promise<void>, ChildProcess>;
  attempt?: Promise<void>;
}>();

/**
 * An unqualified PID is an exited-parent anchor, never authority to kill a live
 * process. Following descendants requires the original parent's birth lower
 * bound (spawnStartedAt), including when the root already exited. A live root
 * additionally needs spawnCompletedAt. Node does not
 * expose the original Windows HANDLE, so initial capture is not an absolute
 * identity guarantee against PID reuse inside that same millisecond window.
 */
export async function stopWindowsProcessTree(pid: number, timeoutMs = 10000, identity?: WindowsRootIdentity): Promise<void> {
  if (process.platform !== 'win32' || !Number.isSafeInteger(pid) || pid <= 1) throw new Error('Invalid Windows process tree.');
  positiveInteger(timeoutMs, 'timeoutMs', 30_000);
  let owner = standaloneWindowsOwners.get(pid);
  if (!owner) {
    owner = { anchors: new Map([[pid, { pid, exited: identity?.rootExited ?? true,
      spawnStartedAt: identity?.spawnStartedAt, spawnCompletedAt: identity?.spawnCompletedAt }]]), helpers: new Map() };
    standaloneWindowsOwners.set(pid, owner);
  }
  if (owner.attempt) return owner.attempt;
  const current = owner;
  current.attempt = (async () => {
    const deadline = Date.now() + timeoutMs;
    while (current.helpers.size && Date.now() < deadline) await delay(10);
    if (current.helpers.size || Date.now() >= deadline) throw new Error('Windows cleanup helper has not released: windows_helper_release:timeout.');
    const result = await runWindowsTreeCleanup({
      anchors: [...current.anchors.values()], environment: commandEnvironment(process.env), timeoutMs: Math.max(1, deadline - Date.now()),
      onAnchor: anchor => current.anchors.set(anchor.pid, { ...current.anchors.get(anchor.pid), ...anchor }),
      onHelper: (helper, whenClosed) => {
        current.helpers.set(whenClosed, helper);
        void whenClosed.then(() => current.helpers.delete(whenClosed));
      },
    });
    if (!result.released || current.helpers.size) throw new Error('Windows process descendants have not released. ' + JSON.stringify(result.diagnostic));
    standaloneWindowsOwners.delete(pid);
  })().finally(() => { current.attempt = undefined; });
  return current.attempt;
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
      windowsHelpers: new Map(), cleanupRequested: false, commandLaunched: false,
      windowsPreparationAbort: process.platform === 'win32' ? new AbortController() : undefined,
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
      if (value.type === 'command-exit') {
        record.exitSeen = true;
        if (record.cleanupPromise) return;
        result.exitCode = typeof value.code === 'number' ? value.code : null;
        result.signal = typeof value.signal === 'string' ? value.signal as NodeJS.Signals : null;
        void this.stopRecord(record);
      } else if (value.type === 'launch-error') {
        if (record.cleanupPromise) return;
        result.error = value.code === 'ENOENT' ? 'Executable or working directory was not found.' : 'Unable to launch the command.';
        void this.stopRecord(record);
      }
    });
    const launch = () => {
      if (record.cleanupRequested || this.disposed || this.revokedOwners.has(ownerId) || signal?.aborted) return;
      if (record.guardianExited || record.closed || (process.platform === 'win32' && !record.windowsJob?.usable)) {
        result.error = 'Command containment was lost before launch; the command was not executed.';
        void this.stopRecord(record);
        return;
      }
      // Windows preparation has its own bounded budget. The command's execution
      // budget starts only after containment is ready and launch is authorized.
      if (process.platform === 'win32') startTimer();
      record.commandLaunched = true;
      child.send({ type: 'launch', command: launchCommand, environment: launchEnvironment }, error => {
        if (error && !record.cleanupPromise) {
          result.error = 'Unable to initialize the command runtime.';
          void this.stopRecord(record);
        }
      });
    };
    child.once('spawn', () => {
      if (record.cleanupRequested) return;
      if (process.platform !== 'win32') { launch(); return; }
      record.windowsPreparation = (async () => {
        try {
          record.windowsJob = await createWindowsCommandJob({
            guardianPid: record.pid!, environment: record.environment, timeoutMs: this.cleanupTimeoutMs,
            signal: record.windowsPreparationAbort!.signal,
            challenge: nonce => this.challengeGuardian(record, nonce),
            onHelper: (helper, whenClosed) => {
              record.windowsHelpers.set(whenClosed, helper);
              void whenClosed.then(() => record.windowsHelpers.delete(whenClosed));
            },
          });
          launch();
        } catch (error) {
          // Preparation never authorizes command execution on failure. Its helper
          // and the empty guardian still have to reach their physical barriers.
          record.windowsPreparationAbort!.abort();
          if (error instanceof WindowsCommandJobError) record.windowsPreparationDiagnostic = error.diagnostic;
          if (!result.cancelled) result.error = 'Unable to contain the command runtime; the command was not executed.'
            + (record.windowsPreparationDiagnostic ? ' ' + JSON.stringify(record.windowsPreparationDiagnostic) : '');
        }
      })();
      void record.windowsPreparation.then(() => {
        if (!record.commandLaunched && !record.cleanupRequested) void this.stopRecord(record);
      });
    });
    const startTimer = () => {
      record.timer = setTimeout(() => {
        result.timedOut = true;
        void this.stopRecord(record);
      }, timeoutMs);
    };
    if (process.platform !== 'win32') startTimer();
    record.abort = () => { result.cancelled = true; void this.stopRecord(record); };
    signal?.addEventListener('abort', record.abort, { once: true });
    if (signal?.aborted) record.abort();
    return done;
  }

  private challengeGuardian(record: CommandRecord, nonce: string): Promise<void> {
    const signal = record.windowsPreparationAbort!.signal;
    return new Promise((resolve, reject) => {
      const finish = (confirmed: boolean) => {
        clearTimeout(timer);
        record.child.off('message', onMessage);
        record.child.off('exit', failed);
        record.child.off('close', failed);
        signal.removeEventListener('abort', failed);
        if (confirmed) resolve(); else reject(new Error('Command runtime ownership was not confirmed.'));
      };
      const failed = () => finish(false);
      const onMessage = (message: unknown) => {
        if (message && typeof message === 'object'
          && (message as Record<string, unknown>).type === 'challenge-response'
          && (message as Record<string, unknown>).nonce === nonce) finish(true);
      };
      const timer = setTimeout(failed, this.cleanupTimeoutMs);
      record.child.on('message', onMessage);
      record.child.once('exit', failed);
      record.child.once('close', failed);
      signal.addEventListener('abort', failed, { once: true });
      if (signal.aborted || record.guardianExited || record.closed || !record.child.connected) { failed(); return; }
      record.child.send({ type: 'challenge', nonce }, error => { if (error) failed(); });
    });
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
    record.cleanupRequested = true;
    record.windowsPreparationAbort?.abort();
    if (record.timer) clearTimeout(record.timer);
    if (record.abort) record.signal?.removeEventListener('abort', record.abort);
    const startedAt = Date.now();
    record.result.cleanupDiagnostic = {
      phase: process.platform === 'win32' ? 'windows_job' : 'posix_terminate', code: 'running',
      elapsedMs: 0, snapshots: 0, terminationAttempts: 0, liveProcesses: 0,
      guardianExited: record.guardianExited, streamsClosed: record.closed,
    };
    record.cleanupPromise = this.releaseTree(record).catch(error => {
      Object.assign(record.result.cleanupDiagnostic!, { code: 'os_error', osCode: safeOsCode(error) });
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
    const deadline = Date.now() + this.cleanupTimeoutMs;
    if (!record.pid) {
      // A failed spawn has no process to signal and emits no exit event, but its
      // Node stdio/IPC handles still have to reach the close barrier.
      while (!record.closed && Date.now() < deadline) await delay(10);
      if (!record.closed) record.result.cleanupDiagnostic!.code = 'timeout';
      return record.closed;
    }
    if (process.platform === 'win32') {
      // Cancelling preparation cannot launch a command later. The original Node
      // ChildProcess handle is authority to stop this still-empty guardian.
      if (!record.commandLaunched && !record.guardianExited) record.child.kill('SIGKILL');
      let preparing = !!record.windowsPreparation;
      void record.windowsPreparation?.then(() => { preparing = false; });
      while (preparing && Date.now() < deadline) await delay(10);
      if (preparing || Date.now() >= deadline) {
        record.result.cleanupDiagnostic!.code = 'timeout';
        return false;
      }
      if (record.windowsPreparationDiagnostic) {
        const progress = record.windowsPreparationDiagnostic;
        Object.assign(record.result.cleanupDiagnostic!, {
          phase: 'windows_job', code: progress.code, jobStage: progress.stage,
          nativeCode: progress.nativeCode, liveProcesses: progress.activeProcesses ?? 0,
          helperExitCode: progress.helperExitCode, helperStarted: progress.helperStarted,
        });
      }
      if (record.windowsJob) {
        const released = await record.windowsJob.stop(Math.max(1, deadline - Date.now()));
        const progress = record.windowsJob.diagnostic;
        Object.assign(record.result.cleanupDiagnostic!, {
          phase: 'windows_job', code: progress.code, jobStage: progress.stage,
          nativeCode: progress.nativeCode, liveProcesses: progress.activeProcesses ?? 0,
          helperExitCode: progress.helperExitCode, helperExited: record.windowsJob.closed, helperStarted: progress.helperStarted,
        });
        if (!released) return false;
      } else if (record.commandLaunched) {
        // An authorized launch always has a bound Job. There is no snapshot
        // fallback that could mistake a missing ancestry chain for release.
        record.result.cleanupDiagnostic!.code = 'ownership_unconfirmed';
        return false;
      }
      record.result.cleanupDiagnostic!.phase = 'windows_helper_release';
      while (record.windowsHelpers.size && Date.now() < deadline) await delay(10);
      if (record.windowsHelpers.size) {
        record.result.cleanupDiagnostic!.code = 'timeout';
        return false;
      }
      // Zero Job members, helper close, and the guardian's process/IPC/stdio close
      // are separate required barriers. Root exit alone never proves release.
      record.result.cleanupDiagnostic!.phase = 'windows_streams';
      while (!record.closed && Date.now() < deadline) await delay(10);
      if (!record.closed || !record.guardianExited) record.result.cleanupDiagnostic!.code = 'timeout';
      return record.closed && record.guardianExited && record.windowsHelpers.size === 0;
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
