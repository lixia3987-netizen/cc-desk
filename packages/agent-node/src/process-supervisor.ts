import { spawn, type ChildProcess } from 'node:child_process';
import { readdir, readFile, readlink } from 'node:fs/promises';
import path from 'node:path';
import { userInfo } from 'node:os';
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
  /** 已接收的字节数，包括超出共享输出上限后丢弃的字节。 */
  outputBytes: number;
  truncated: boolean;
  timedOut: boolean;
  cancelled: boolean;
  cleanup: 'released' | 'cleanup_failed';
  /** 仅包含固定阶段与计数器，绝不包含命令文本、路径、环境或辅助进程的标准错误输出。 */
  cleanupDiagnostic?: ProcessCleanupDiagnostic;
  error?: string;
}

export interface CommandSnapshot {
  /** 仅在守护进程报告实际可执行程序已启动后才为真。 */
  started: boolean;
  stopping: boolean;
  /** 首次进程隔离清理尝试已结束，但可能未成功。 */
  settled: boolean;
  /** 返回副本，其中包含当前保留的完整 UTF-8 前缀。 */
  result: CommandResult;
}

/** 宿主持有的有限时长命令；不暴露可用作控制凭据的 PID。 */
export interface CommandHandle {
  /** 若进程无法启动或启动前已取消，则为假。 */
  readonly started: Promise<boolean>;
  /** 首次清理尝试后固定下来的快照副本。 */
  readonly closed: Promise<CommandResult>;
  snapshot(): CommandSnapshot;
  /** 仅停止此命令；清理失败时可重试，无需撤销其所有者。 */
  stop(): Promise<CommandResult>;
}

/** 仅供主进程使用、经明确批准的双向进程输入。 */
export interface StdioProcessRequest {
  executable: string;
  argv: string[];
  cwd: string;
  /** 已解析的显式映射，绝不继承供应商凭据。 */
  environment?: Record<string, string>;
  /** 必须同步消费数据，并自行维护有大小上限的协议缓冲区。 */
  onStdout: (data: Buffer) => void;
  startupTimeoutMs?: number;
  maxInputBytes?: number;
}

/** 不返回进程输出、路径、可执行程序、argv 或环境。 */
export interface StdioProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  cancelled: boolean;
  cleanup: 'released' | 'cleanup_failed';
  cleanupDiagnostic?: ProcessCleanupDiagnostic;
  error?: string;
}

export interface StdioProcessHandle {
  /** 待写入的输入有大小上限，在管道写入回调后完成。 */
  write(data: string | Uint8Array): Promise<void>;
  endInput(): Promise<void>;
  /** 首次清理尝试后结束等待；cleanup_failed 状态仍保留所有权。 */
  readonly closed: Promise<StdioProcessResult>;
  /** 等待期间保持幂等；清理失败后可重试。 */
  close(): Promise<StdioProcessResult>;
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
  helperStage?: 'bootstrap' | 'modules' | 'input' | 'compile' | 'snapshot' | 'capture' | 'terminate';
  jobStage?: 'compile' | 'open' | 'challenge' | 'bind' | 'active' | 'terminate' | 'query' | 'closed';
  nativeCode?: number;
  helperExitCode?: number | null;
  helperExited?: boolean;
  helperStarted?: boolean;
  modulesLoaded?: boolean;
  helperOutputBytes?: number;
  osCode?: 'ENOENT' | 'EACCES' | 'EPERM' | 'ESRCH' | 'UNKNOWN';
}

function safeOsCode(error: unknown): NonNullable<ProcessCleanupDiagnostic['osCode']> {
  const code = errno(error);
  return code === 'ENOENT' || code === 'EACCES' || code === 'EPERM' || code === 'ESRCH' ? code : 'UNKNOWN';
}

export interface ProcessSupervisorOptions {
  /** 仅复制固定的运行环境白名单，绝不复制供应商凭据。 */
  environment?: NodeJS.ProcessEnv;
  defaultTimeoutMs?: number;
  maxTimeoutMs?: number;
  defaultMaxOutputBytes?: number;
  maxOutputBytes?: number;
  cleanupTimeoutMs?: number;
  terminationGraceMs?: number;
  /** 默认使用当前运行时，包括 Electron 内置的 Node 运行时。 */
  nodeExecutable?: string;
}

const ENVIRONMENT_KEYS = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC',
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE',
]);

// Node/libuv 的 make_program_env 会在这些 Windows 环境变量缺失时从宿主恢复它们；
// 参见 nodejs/node v22.x 的 deps/uv/src/win/process.c 中的 required_vars。显式设置
// 空值可阻止该回退行为；不会复制其他宿主环境值。
const WINDOWS_BACKFILLED_KEYS = [
  'HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'PATH', 'SYSTEMDRIVE', 'SYSTEMROOT',
  'TEMP', 'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'WINDIR',
];

/** 不包含 NODE_OPTIONS、Shell 启动钩子、npm 配置或模型及供应商变量。 */
export function commandEnvironment(source: NodeJS.ProcessEnv, forbiddenValues: readonly string[] = []): NodeJS.ProcessEnv {
  // Node 的 JS 启动器也会在所有平台恢复 NODE_V8_COVERAGE，除非
  // 提供的环境自身已有该键；空值可禁用覆盖率配置继承。
  const result: NodeJS.ProcessEnv = { NODE_V8_COVERAGE: '' };
  const blocked = new Set<string>();
  const windows = process.platform === 'win32';
  for (const [key, value] of Object.entries(source)) {
    const normalized = key.toUpperCase();
    if (value === undefined || !ENVIRONMENT_KEYS.has(normalized)) continue;
    const destination = windows ? normalized : key;
    if (forbiddenValues.some(secret => secret.length > 0 && value.includes(secret))) blocked.add(destination);
    else result[destination] = value;
  }
  for (const key of blocked) delete result[key];
  if (windows && !result.USERPROFILE) {
    // Windows PowerShell 在显式空 USERPROFILE 下会在首条脚本前终止。
    // 仅从 OS 用户记录取必要目录，不能让 libuv 或 homedir() 恢复宿主环境值；
    // 派生值仍经过凭据检查，获取失败时保留空 guard 并让隔离初始化失败关闭。
    try {
      const profile = userInfo().homedir;
      if (path.win32.isAbsolute(profile) && /^[a-z]:[\\/]/i.test(profile) && !/[\0\r\n]/.test(profile) &&
        !forbiddenValues.some(secret => secret.length > 0 && profile.includes(secret))) result.USERPROFILE = profile;
    } catch { /* 不能用环境变量或猜测路径补救 OS 查询失败。 */ }
  }
  if (windows) for (const key of WINDOWS_BACKFILLED_KEYS) result[key] ??= '';
  return result;
}

const STDIO_BLOCKED_ENVIRONMENT_NAMES = new Set([
  ...ENVIRONMENT_KEYS, ...WINDOWS_BACKFILLED_KEYS,
  'BASH_ENV', 'ENV', 'SHELLOPTS', 'BASHOPTS', 'CDPATH', 'GLOBIGNORE', 'IFS',
  'PSMODULEPATH', 'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS', 'CLASSPATH',
  'PHPRC', 'PHP_INI_SCAN_DIR', '__PROTO__', 'PROTOTYPE', 'CONSTRUCTOR',
]);

/** 与连接存储共用：显式映射不能修改启动或运行时钩子。 */
export function assertStdioEnvironmentName(name: string): void {
  if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)
    || STDIO_BLOCKED_ENVIRONMENT_NAMES.has(name.toUpperCase())
    || /^(?:NODE_|NPM_|LD_|DYLD_|PYTHON|RUBY|PERL|DOTNET_|COMPLUS_|ELECTRON_|BASH_FUNC_)/.test(name.toUpperCase())) {
    throw new TypeError('Stdio environment target is invalid or reserved.');
  }
}

/** 最多复制十六个显式解析的值；不复制外部环境变量。 */
export function validateStdioEnvironment(environment: Record<string, string> = {}): Record<string, string> {
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(environment))
    || Object.keys(environment).length > 16) throw new TypeError('Invalid stdio environment mapping.');
  const result: Record<string, string> = {};
  let bytes = 0;
  const names = new Set<string>();
  for (const [name, value] of Object.entries(environment)) {
    assertStdioEnvironmentName(name);
    if (names.has(name.toUpperCase())) throw new TypeError('Duplicate stdio environment target.');
    names.add(name.toUpperCase());
    if (typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value) > 8 * 1_024) {
      throw new TypeError('Invalid stdio environment value.');
    }
    bytes += Buffer.byteLength(name) + Buffer.byteLength(value);
    if (bytes > 32 * 1_024) throw new TypeError('Stdio environment exceeds its size limit.');
    Object.defineProperty(result, name, { value, enumerable: true, configurable: true, writable: true });
  }
  return result;
}

// 守护进程会等待宿主授权后再启动命令。在 Windows 上，
// 先将其绑定到持有的 Job；在 POSIX 上则使用它的独立进程组。
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
      windowsHide: true, stdio: [message.stdio === true ? 0 : 'ignore', 1, 2],
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
  stdout: CapturedOutput;
  stderr: CapturedOutput;
  capturedBytes: number;
  outputLimit: number;
  cleanupPromise?: Promise<boolean>;
  cleanupFailed: boolean;
  done: Promise<CommandResult>;
  finish: () => void;
  timer?: NodeJS.Timeout;
  abort?: () => void;
  signal?: AbortSignal;
  stdio?: StdioProcessControl;
}

interface CapturedOutput { chunks: Buffer[]; bytes: number }
interface CommandControl {
  onRecord: (record: CommandRecord) => void;
  onStarted: () => void;
}

interface StdioProcessControl {
  environment: Record<string, string>;
  startupTimeoutMs: number;
  maxInputBytes: number;
  onStdout: (data: Buffer) => void;
  onStarted: (record: CommandRecord) => void;
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

const CAPTURE_BLOCK_BYTES = 16 * 1_024;

function appendOutput(output: CapturedOutput, data: Buffer): void {
  let offset = 0;
  while (offset < data.length) {
    const used = output.bytes % CAPTURE_BLOCK_BYTES;
    if (!used) output.chunks.push(Buffer.allocUnsafe(CAPTURE_BLOCK_BYTES));
    const bytes = Math.min(CAPTURE_BLOCK_BYTES - used, data.length - offset);
    data.copy(output.chunks[output.chunks.length - 1], used, offset, offset + bytes);
    output.bytes += bytes;
    offset += bytes;
  }
}

function boundedText(output: CapturedOutput): string {
  const buffer = Buffer.concat(output.chunks, output.bytes);
  // 不要将截断的 UTF-8 序列转换为替换字符，以免超过
  // 字节预算；任意无效字节在解码为 UTF-8 时也可能膨胀。
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
  // 容器的初始化进程未必及时回收孤儿僵尸进程。僵尸进程
  // 已无执行代码或打开的描述符，不应继续占用目录租约。
  // 任何无法读取的存活成员都保守地视为清理失败。
  return (await linuxLiveProcesses({ group: pid })).length > 0;
}

/** Node 在嵌套 PID 命名空间中运行时，procfs 可能暴露宿主的 PID。 */
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
  /** 可用时，从原始进程 HANDLE 获取格式为 yyyyMMddHHmmssffffff 的 UTC 时间。 */
  created?: string;
  spawnStartedAt?: number;
  spawnCompletedAt?: number;
}

const standaloneWindowsOwners = new Map<number, {
  anchors: Map<number, WindowsProcessAnchor>;
  helpers: Map<Promise<void>, ChildProcess>;
  attempt?: Promise<void>;
}>();

/**
 * 未经身份验证的 PID 只用于标识已退出的父进程，绝不能作为终止存活
 * 进程的依据。优先使用从原始 HANDLE 获取的创建标识作为精确锚点。
 * 否则，跟踪后代必须保留原始父进程的创建时间下界
 * （spawnStartedAt），即使根进程已退出也如此。存活的根进程
 * 还需要 spawnCompletedAt。Node 不会
 * 暴露原始 Windows HANDLE，因此初始采集无法绝对保证
 * 在同一个毫秒时间窗口内发生 PID 重用时仍能正确识别进程。
 */
export async function stopWindowsProcessTree(pid: number, timeoutMs = 10000, identity?: WindowsRootIdentity): Promise<void> {
  if (process.platform !== 'win32' || !Number.isSafeInteger(pid) || pid <= 1) throw new Error('Invalid Windows process tree.');
  positiveInteger(timeoutMs, 'timeoutMs', 30_000);
  let owner = standaloneWindowsOwners.get(pid);
  if (!owner) {
    owner = { anchors: new Map([[pid, { pid, exited: identity?.rootExited ?? true,
      created: identity?.created,
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
 * 宿主持有的有限时长命令执行。stopOwner 作为资源释放屏障，会永久撤销
 * 该所有者；后续任务应使用新的运行或代次标识。
 * 清理失败会持续反映在 has()/activeCount 中，直到重试成功。
 * 此处监管普通进程组或进程树，而非系统沙箱：恶意
 * 程序可逃离 POSIX 进程组，因此批准的命令必须可信。
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
    return this.runOwned(ownerId, command, signal, forbiddenValues);
  }

  start(ownerId: string, command: CommandRequest, signal?: AbortSignal, forbiddenValues: readonly string[] = []): CommandHandle {
    let record: CommandRecord | undefined;
    let started = false;
    let settled = false;
    let terminal: CommandResult | undefined;
    let notifyStarted!: (value: boolean) => void;
    const whenStarted = new Promise<boolean>(resolve => { notifyStarted = resolve; });
    const copy = (result: CommandResult): CommandResult => ({
      ...result, ...(result.cleanupDiagnostic ? { cleanupDiagnostic: { ...result.cleanupDiagnostic } } : {}),
    });
    const snapshot = (): CommandSnapshot => ({
      started, stopping: record?.cleanupRequested ?? false, settled,
      result: record ? {
        ...copy(record.result), stdout: boundedText(record.stdout), stderr: boundedText(record.stderr),
      } : copy(terminal ?? {
        exitCode: null, signal: null, stdout: '', stderr: '', outputBytes: 0,
        truncated: false, timedOut: false, cancelled: signal?.aborted ?? false, cleanup: 'released',
      }),
    });
    const closed = this.runOwned(ownerId, command, signal, forbiddenValues, undefined, {
      onRecord: value => { record = value; },
      onStarted: () => { started = true; notifyStarted(true); },
    }).then(result => {
      settled = true;
      terminal = copy(result);
      notifyStarted(started);
      return copy(result);
    }, error => {
      settled = true;
      terminal = {
        exitCode: null, signal: null, stdout: '', stderr: '', outputBytes: 0,
        truncated: false, timedOut: false, cancelled: signal?.aborted ?? false, cleanup: 'released',
        error: 'The command request was rejected before execution.',
      };
      notifyStarted(false);
      throw error;
    });
    // 调用方通常会先等待启动完成，再观察关闭 Promise。
    // 保留可观察的校验拒绝结果，同时避免期间出现未处理的拒绝。
    void closed.catch(() => {});
    return {
      started: whenStarted, closed, snapshot,
      stop: async () => {
        if (!record) return closed;
        // 保留已经开始清理的自然退出原因。后续停止操作
        // 仍会重试失败的进程隔离清理，但不改写退出原因。
        if (!record.cleanupRequested) record.result.cancelled = true;
        await this.stopRecord(record);
        await closed;
        return snapshot().result;
      },
    };
  }

  async openStdio(ownerId: string, request: StdioProcessRequest, signal?: AbortSignal, forbiddenValues: readonly string[] = []): Promise<StdioProcessHandle> {
    if (!request || typeof request.onStdout !== 'function') throw new TypeError('Stdio requires an output consumer.');
    validateCommand(request);
    if (!path.isAbsolute(request.executable) || /\.(?:cmd|bat)$/i.test(request.executable)
      || request.argv.length > 128
      || Buffer.byteLength(JSON.stringify(request.argv)) > 32 * 1_024) {
      throw new TypeError('Stdio requires an absolute executable and bounded explicit argv without batch scripts.');
    }
    const environment = validateStdioEnvironment(request.environment);
    const startupTimeoutMs = positiveInteger(request.startupTimeoutMs ?? 30_000, 'startupTimeoutMs', 30_000);
    const maxInputBytes = positiveInteger(request.maxInputBytes ?? 128 * 1_024, 'maxInputBytes', 1_048_576);
    let ready!: (handle: StdioProcessHandle) => void;
    let failed!: (error: unknown) => void;
    const opened = new Promise<StdioProcessHandle>((resolve, reject) => { ready = resolve; failed = reject; });
    const control: StdioProcessControl = {
      environment, startupTimeoutMs, maxInputBytes, onStdout: request.onStdout,
      onStarted: record => ready(this.stdioHandle(record)),
    };
    void this.runOwned(ownerId, request, signal, forbiddenValues, control).then(result => {
      const error = new Error(result.cancelled ? 'Stdio process was cancelled.' : 'Unable to start or retain the stdio process.');
      if (result.cleanup !== 'released') Object.assign(error, { cleanupUnconfirmed: true });
      failed(error);
    }, failed);
    return opened;
  }

  private stdioHandle(record: CommandRecord): StdioProcessHandle {
    const result = (): StdioProcessResult => ({
      exitCode: record.result.exitCode, signal: record.result.signal, cancelled: record.result.cancelled,
      cleanup: record.result.cleanup, ...(record.result.error ? { error: record.result.error } : {}),
      ...(record.result.cleanupDiagnostic ? { cleanupDiagnostic: { ...record.result.cleanupDiagnostic } } : {}),
    });
    const input = record.child.stdin!;
    let pendingBytes = 0;
    let ended = false;
    let endPromise: Promise<void> | undefined;
    let closing: Promise<StdioProcessResult> | undefined;
    const write = (data: string | Uint8Array): Promise<void> => {
      if (ended || record.cleanupRequested || record.closed || input.destroyed || !input.writable) {
        return Promise.reject(new Error('Stdio process input is closed.'));
      }
      if (typeof data !== 'string' && !(data instanceof Uint8Array)) return Promise.reject(new TypeError('Invalid stdio input.'));
      const bytes = typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength;
      if (bytes > record.stdio!.maxInputBytes || pendingBytes + bytes > record.stdio!.maxInputBytes) {
        return Promise.reject(new Error('Stdio process input exceeds its pending byte limit.'));
      }
      pendingBytes += bytes;
      return new Promise<void>((resolve, reject) => {
        input.write(data, error => {
          pendingBytes -= bytes;
          if (error || record.cleanupRequested) reject(new Error('Stdio process input could not be written.'));
          else resolve();
        });
      });
    };
    const endInput = (): Promise<void> => {
      if (endPromise) return endPromise;
      ended = true;
      endPromise = new Promise<void>((resolve, reject) => {
        if (input.destroyed || !input.writable) { resolve(); return; }
        input.end(() => resolve());
        const failed = () => reject(new Error('Stdio process input could not be closed.'));
        input.once('error', failed);
        input.once('close', () => { input.off('error', failed); resolve(); });
      });
      return endPromise;
    };
    return {
      write, endInput, closed: record.done.then(result),
      close: () => {
        if (closing) return closing;
        ended = true;
        input.end();
        closing = (async () => {
          // 正常关闭会给服务器一个有时限的机会，以便观察到 EOF。
          // 自然退出会启动相同的进程隔离清理；取消和
          // 撤销所有者仍会立即启动 stopRecord 屏障。
          const deadline = Date.now() + Math.min(250, this.cleanupTimeoutMs);
          while (!record.cleanupRequested && !record.closed && Date.now() < deadline) await delay(10);
          await this.stopRecord(record);
          const value = result();
          if (value.cleanup !== 'released') closing = undefined;
          return value;
        })();
        return closing;
      },
    };
  }

  private async runOwned(ownerId: string, command: CommandRequest, signal?: AbortSignal, forbiddenValues: readonly string[] = [], stdio?: StdioProcessControl, control?: CommandControl): Promise<CommandResult> {
    if (typeof ownerId !== 'string' || !ownerId || ownerId.length > 1_024) throw new TypeError('An owner ID is required.');
    if (this.disposed || this.revokedOwners.has(ownerId)) throw new Error('Command owner has been released.');
    validateCommand(command);
    const launchCommand: CommandRequest = {
      executable: command.executable, argv: [...command.argv], cwd: command.cwd,
    };
    const timeoutMs = stdio?.startupTimeoutMs ?? positiveInteger(command.timeoutMs ?? this.timeoutMs, 'timeoutMs', this.maxTimeoutMs);
    const outputLimit = positiveInteger(command.maxOutputBytes ?? this.outputLimit, 'maxOutputBytes', this.maxOutputBytes);
    const result: CommandResult = {
      exitCode: null, signal: null, stdout: '', stderr: '', outputBytes: 0,
      truncated: false, timedOut: false, cancelled: signal?.aborted ?? false, cleanup: 'released',
    };
    if (signal?.aborted) return result;

    // 为本次运行解析的凭据可能存储在通常用于运行配置的
    // 变量中（例如 LANG）。应清除守护进程和工具环境中的这些值，
    // 同时不改变其他并发运行的启动环境。
    const launchEnvironment = commandEnvironment(this.environment, stdio ? [...forbiddenValues, ...Object.values(stdio.environment)] : forbiddenValues);
    if (!path.isAbsolute(command.executable) && !/[\\/]/.test(command.executable)
      && !Object.entries(launchEnvironment).some(([key, value]) => key.toUpperCase() === 'PATH' && Boolean(value))) {
      result.error = 'Executable lookup requires PATH; select an absolute executable when PATH is unavailable or filtered.';
      return result;
    }
    const guardianEnvironment = { ...launchEnvironment };
    if (process.versions.electron) guardianEnvironment.ELECTRON_RUN_AS_NODE = '1';
    const child = spawn(this.nodeExecutable, ['-e', GUARDIAN], {
      cwd: command.cwd, env: guardianEnvironment, shell: false,
      detached: process.platform !== 'win32', windowsHide: true,
      stdio: [stdio ? 'pipe' : 'ignore', 'pipe', 'pipe', 'ipc'],
    });
    let finish!: () => void;
    const done = new Promise<CommandResult>(resolve => {
      finish = () => resolve(result);
    });
    const record: CommandRecord = {
      owner: ownerId, environment: launchEnvironment, child, pid: child.pid, closed: false, guardianExited: false, exitSeen: false,
      windowsHelpers: new Map(), cleanupRequested: false, commandLaunched: false,
      windowsPreparationAbort: process.platform === 'win32' ? new AbortController() : undefined,
      result, stdout: { chunks: [], bytes: 0 }, stderr: { chunks: [], bytes: 0 }, capturedBytes: 0, outputLimit,
      cleanupFailed: false, done, finish, signal, stdio,
    };
    this.records.add(record);
    control?.onRecord(record);
    const capture = (output: CapturedOutput, data: Buffer) => {
      result.outputBytes = Math.min(Number.MAX_SAFE_INTEGER, result.outputBytes + data.length);
      const available = Math.max(0, outputLimit - record.capturedBytes);
      if (data.length > available) result.truncated = true;
      if (available) {
        const retained = data.subarray(0, available);
        appendOutput(output, retained);
        record.capturedBytes += retained.length;
      }
    };
    child.stdout!.on('data', (data: Buffer) => {
      if (!stdio) { capture(record.stdout, data); return; }
      if (record.cleanupRequested) return;
      try { stdio.onStdout(data); }
      catch {
        result.error = 'Stdio process output could not be consumed.';
        void this.stopRecord(record);
      }
    });
    // 持续读取并丢弃长连接协议的标准错误输出，绝不保留或返回。
    child.stderr!.on('data', (data: Buffer) => { if (!stdio) capture(record.stderr, data); });
    child.stdin?.on('error', () => {
      if (record.cleanupRequested) return;
      result.error = 'Stdio process input failed.';
      void this.stopRecord(record);
    });
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
        control?.onStarted();
        if (stdio && !record.cleanupRequested) {
          if (record.timer) clearTimeout(record.timer);
          stdio.onStarted(record);
        }
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
      // Windows 准备阶段有独立的时限。命令执行的
      // 时限仅在进程隔离就绪并获得启动授权后才开始计时。
      if (process.platform === 'win32') startTimer();
      record.commandLaunched = true;
      child.send({ type: 'launch', command: launchCommand, environment: stdio ? { ...launchEnvironment, ...stdio.environment } : launchEnvironment, stdio: Boolean(stdio) }, error => {
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
          // 准备阶段失败时绝不授权执行命令；辅助进程
          // 和尚未启动命令的守护进程仍须到达各自实际关闭的屏障。
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
      // 始终持续读取输出，直到有时限的释放尝试结束。清理失败时，
      // 即使宿主流句柄已关闭，仍保留资源占用状态。
      if (!released) { record.child.stdin?.destroy(); record.child.stdout?.destroy(); record.child.stderr?.destroy(); }
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
      // 启动失败时没有可发送信号的进程，也不会触发 exit 事件，但其
      // Node 标准输入输出及 IPC 句柄仍须到达关闭屏障。
      while (!record.closed && Date.now() < deadline) await delay(10);
      if (!record.closed) record.result.cleanupDiagnostic!.code = 'timeout';
      return record.closed;
    }
    if (process.platform === 'win32') {
      // 取消准备后不得再启动命令。原始 Node
      // ChildProcess 句柄是停止这个尚未启动命令的守护进程的控制依据。
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
          helperExitCode: progress.helperExitCode, helperStarted: progress.helperStarted, modulesLoaded: progress.modulesLoaded,
        });
      }
      if (record.windowsJob) {
        const released = await record.windowsJob.stop(Math.max(1, deadline - Date.now()));
        const progress = record.windowsJob.diagnostic;
        Object.assign(record.result.cleanupDiagnostic!, {
          phase: 'windows_job', code: progress.code, jobStage: progress.stage,
          nativeCode: progress.nativeCode, liveProcesses: progress.activeProcesses ?? 0,
          helperExitCode: progress.helperExitCode, helperExited: record.windowsJob.closed, helperStarted: progress.helperStarted, modulesLoaded: progress.modulesLoaded,
        });
        if (!released) return false;
      } else if (record.commandLaunched) {
        // 获得授权的启动始终已绑定 Job；不采用可能将缺失祖先链
        // 误认为资源已释放的快照回退方式。
        record.result.cleanupDiagnostic!.code = 'ownership_unconfirmed';
        return false;
      }
      record.result.cleanupDiagnostic!.phase = 'windows_helper_release';
      while (record.windowsHelpers.size && Date.now() < deadline) await delay(10);
      if (record.windowsHelpers.size) {
        record.result.cleanupDiagnostic!.code = 'timeout';
        return false;
      }
      // Job 成员数归零、辅助进程关闭，以及守护进程的进程、IPC 和标准输入输出关闭，
      // 是分别必需满足的屏障；仅根进程退出绝不能证明资源已释放。
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
