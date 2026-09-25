import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { environment } from './platform-commands';

interface IdeInvocation { file: string; args: string[]; application: string; cwd: string; appBundle: boolean }
type Launcher = (file: string, args: string[], options: SpawnOptions) => ChildProcess;
interface IdeOptions { platform?: NodeJS.Platform; spawn?: Launcher; env?: Record<string, string> }

function normalizePath(value: string): string {
  const trimmed = value.trim();
  const quote = trimmed[0];
  return trimmed.length >= 2 && (quote === '"' || quote === "'") && trimmed.at(-1) === quote ? trimmed.slice(1, -1) : trimmed;
}

function isAbsolute(value: string, platform: NodeJS.Platform): boolean {
  if (platform !== 'win32') return path.posix.isAbsolute(value);
  // A leading backslash alone is relative to the current drive on Windows.
  return path.win32.isAbsolute(value) && /^(?:[a-z]:[/\\]|[/\\]{2}[^/\\]+[/\\][^/\\]+)/i.test(value);
}

/** Build an argument vector; the configured path is never parsed as a command. */
export function ideInvocation(configuredPath: string | undefined, cwd: string, platform: NodeJS.Platform = process.platform): IdeInvocation {
  const application = normalizePath(configuredPath ?? '');
  if (!application) throw new Error('请先在设置中选择用于打开项目的 IDE 应用。');
  if (application.length > 4096 || /[\x00-\x1f\x7f]/.test(application) || !isAbsolute(application, platform)) {
    throw new Error('IDE 应用必须是完整的绝对路径；请通过“选择 IDE 应用”指定文件，不要填写命令或启动参数。');
  }
  if (/[\x00-\x1f\x7f]/.test(cwd) || !isAbsolute(cwd, platform)) throw new Error('项目目录无效，请重新添加项目。');
  if (/\.(?:cmd|bat|lnk)$/i.test(application)) throw new Error('请选择 IDE 的 .exe 应用，例如 Code.exe 或 webstorm64.exe；不支持 CMD、BAT 或快捷方式。');
  if (platform === 'win32' && !/\.exe$/i.test(application)) throw new Error('Windows 请指定 IDE 的 .exe 应用，例如 Code.exe 或 webstorm64.exe。');
  const appBundle = platform === 'darwin' && /\.app\/?$/i.test(application);
  return { file: appBundle ? '/usr/bin/open' : application, args: appBundle ? ['-a', application, cwd] : [cwd], application, cwd, appBundle };
}

function filesystemError(error: unknown, subject: 'application' | 'project'): Error {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === 'EACCES' || code === 'EPERM') return new Error(subject === 'application'
    ? '没有读取或执行 IDE 应用的权限，请检查应用权限后重试。'
    : '没有访问项目目录的权限，请检查目录权限后重试。');
  return new Error(subject === 'application'
    ? '找不到 IDE 应用，路径可能已失效；请在设置中重新选择应用。'
    : '找不到项目目录，目录可能已移动或工作树已清理；请检查项目路径。');
}

async function validateInvocation(invocation: IdeInvocation, platform: NodeJS.Platform): Promise<void> {
  let project;
  try { project = await fs.stat(invocation.cwd); await fs.access(invocation.cwd, constants.R_OK | (platform === 'win32' ? 0 : constants.X_OK)); }
  catch (error) { throw filesystemError(error, 'project'); }
  if (!project.isDirectory()) throw new Error('项目路径不是文件夹，请重新选择项目目录。');
  let application;
  try { application = await fs.stat(invocation.application); }
  catch (error) { throw filesystemError(error, 'application'); }
  if (invocation.appBundle) {
    if (!application.isDirectory()) throw new Error('所选 .app 不是有效的应用，请在设置中重新选择。');
    try {
      const contents = path.join(invocation.application, 'Contents');
      if (!(await fs.stat(path.join(contents, 'Info.plist'))).isFile() || !(await fs.stat(path.join(contents, 'MacOS'))).isDirectory()) throw new Error();
      await fs.access(invocation.application, constants.R_OK | constants.X_OK);
    } catch (error) {
      if (['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException)?.code ?? '')) throw filesystemError(error, 'application');
      throw new Error('所选 .app 缺少应用文件，请选择完整的 VS Code、WebStorm 或其他 IDE 应用。');
    }
  } else {
    if (!application.isFile()) throw new Error('请选择 IDE 的可执行文件；macOS 也可以选择 .app 应用。');
    try { await fs.access(invocation.application, platform === 'win32' ? constants.R_OK : constants.R_OK | constants.X_OK); }
    catch (error) { throw filesystemError(error, 'application'); }
  }
}

function launchError(error?: unknown, code?: number | null, signal?: NodeJS.Signals | null): Error {
  const reason = (error as NodeJS.ErrnoException)?.code;
  if (reason === 'EACCES' || reason === 'EPERM') return new Error('IDE 启动被系统拒绝，请检查应用的执行权限或系统安全设置。');
  if (reason === 'ENOENT') return new Error('IDE 无法启动：应用或启动脚本所需的解释器不存在，请重新选择应用或检查安装。');
  if (reason === 'ENOEXEC') return new Error('所选文件无法执行，请选择 IDE 应用或带有有效启动声明的可执行脚本。');
  const detail = code !== undefined && code !== null ? `（退出码 ${code}）` : signal ? `（${signal}）` : '';
  return new Error(`IDE 启动失败${detail}，请确认该应用可以手动打开，并检查设置中的应用路径。`);
}

const ignoreLateError = () => {};

/** Opening a GUI must not keep the workbench alive or wait for the editor to close. */
export async function openIde(configuredPath: string | undefined, cwd: string, options: IdeOptions = {}): Promise<void> {
  const platform = options.platform ?? process.platform;
  const invocation = ideInvocation(configuredPath, cwd, platform);
  await validateInvocation(invocation, platform);
  const env = { ...(options.env ?? environment()) };
  for (const key of Object.keys(env)) if (/^(?:ELECTRON_|WORKBENCH_)/i.test(key)) delete env[key];
  await new Promise<void>((resolve, reject) => {
    let child: ChildProcess;
    try { child = (options.spawn ?? spawn)(invocation.file, invocation.args, { cwd, env, shell: false, detached: true, stdio: 'ignore', windowsHide: true }); }
    catch (error) { reject(launchError(error)); return; }
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.removeListener('spawn', onSpawn);
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
      // A late child-process error must not crash the desktop after handoff.
      child.once('error', ignoreLateError);
      child.unref();
      if (error) reject(error); else resolve();
    };
    const onError = (error: Error) => finish(launchError(error));
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => finish(code === 0 ? undefined : launchError(undefined, code, signal));
    const onSpawn = () => {
      // `open` exits after LaunchServices hands off the request. Direct executables
      // may stay alive indefinitely, so only observe their initial startup failure.
      timer = setTimeout(() => finish(invocation.appBundle ? new Error('IDE 启动请求超时，请检查该应用能否手动打开后重试。') : undefined), invocation.appBundle ? 15_000 : 500);
    };
    child.once('error', onError);
    child.once('exit', onExit);
    child.once('spawn', onSpawn);
  });
}
