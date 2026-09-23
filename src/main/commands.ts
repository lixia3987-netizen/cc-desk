import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Capabilities, Effort, Session, Settings } from '../shared/types';
export const execFileAsync = promisify(execFile);

// These errors contain only application-owned text, never child-process output or paths.
export class CLIResolutionError extends Error {}
const unquote = (value: string) => value.trim().replace(/^"(.*)"$/, '$1');
const pathKey = (env: Record<string, string>, platform: NodeJS.Platform) => platform === 'win32'
  ? Object.keys(env).sort().find(key => key.toLowerCase() === 'path') ?? 'PATH' : 'PATH';

export function environment(): Record<string,string> {
  const env: Record<string,string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  const inheritedPath = env[pathKey(env, process.platform)] ?? '';
  const extra = [path.join(os.homedir(), '.local', 'bin'), path.join(os.homedir(), '.npm-global', 'bin')];
  if (process.platform === 'win32') {
    if (env.APPDATA) extra.push(path.join(env.APPDATA, 'npm'));
    // Windows treats keys case-insensitively. Pass exactly one PATH to child processes.
    for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
  } else extra.push('/opt/homebrew/bin', '/usr/local/bin');
  env.PATH = [...inheritedPath.split(path.delimiter), ...extra].map(unquote).filter(Boolean).join(path.delimiter);
  // Electron's startup switches must not propagate to shell / CLI processes.
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.WORKBENCH_DEV_URL;
  delete env.WORKBENCH_DATA_DIR;
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  return env;
}

export function findExecutable(name: string, env = environment(), platform: NodeJS.Platform = process.platform): string | undefined {
  name = unquote(name);
  if (!name || /[\x00\r\n]/.test(name)) return;
  const dirs = path.isAbsolute(name) || /[/\\]/.test(name) ? ['']
    : (env[pathKey(env, platform)] ?? '').split(platform === 'win32' ? ';' : ':').map(unquote).filter(Boolean);
  const extensions = platform === 'win32' && !path.extname(name) ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of dirs) for (const extension of extensions) {
    const file = dir ? path.join(dir, name + extension) : name + extension;
    try {
      if (!fs.statSync(file).isFile()) continue;
      fs.accessSync(file, platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
      return path.resolve(file);
    } catch { /* Try the next PATH entry. */ }
  }
}

/** Resolve npm package metadata, never execute or interpret a CMD/BAT script. */
export function resolveNpmLauncher(file: string, env = environment(), platform: NodeJS.Platform = process.platform): { file: string; prefix: string[] } {
  const directory = path.dirname(file);
  const roots = [path.join(directory, 'node_modules', '@anthropic-ai', 'claude-code')];
  if (path.basename(directory).toLowerCase() === '.bin') roots.push(path.join(directory, '..', '@anthropic-ai', 'claude-code'));
  const root = roots.find(candidate => fs.existsSync(path.join(candidate, 'package.json')));
  if (!root) throw new CLIResolutionError('未找到此 CMD/BAT 启动器对应的 Claude Code npm 包。请选择 npm 安装生成的 claude.cmd，或 claude.exe 的完整路径。');
  let metadata: { name?: unknown; bin?: unknown };
  try {
    const manifest = path.join(root, 'package.json');
    if (fs.statSync(manifest).size > 128 * 1024) throw new Error();
    metadata = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    if (!metadata || metadata.name !== '@anthropic-ai/claude-code') throw new Error();
  } catch { throw new CLIResolutionError('Claude Code npm 包信息无效，请重新安装 @anthropic-ai/claude-code。'); }
  const bin = typeof metadata.bin === 'string' ? metadata.bin
    : metadata.bin && typeof metadata.bin === 'object' && 'claude' in metadata.bin ? metadata.bin.claude : undefined;
  if (typeof bin !== 'string' || !bin || bin.length > 4096 || /[\x00-\x1f]/.test(bin)
      || path.posix.isAbsolute(bin) || path.win32.isAbsolute(bin) || bin.includes(':') || bin.split(/[/\\]/).includes('..')) {
    throw new CLIResolutionError('Claude Code npm 包声明了不支持的启动入口，请检查或重新安装该包。');
  }
  const target = path.resolve(root, ...bin.split(/[/\\]/));
  const relative = path.relative(path.resolve(root), target);
  if (!relative || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new CLIResolutionError('Claude Code npm 启动入口必须位于安装包内。');
  try { if (!fs.statSync(target).isFile()) throw new Error(); }
  catch { throw new CLIResolutionError('Claude Code npm 启动文件缺失，安装可能未完成。请重新安装并允许 npm 安装脚本执行。'); }
  // New npm releases install a native binary and need no Node.js at runtime.
  if (/\.exe$/i.test(target)) return { file: target, prefix: [] };
  if (!/\.(?:c|m)?js$/i.test(target)) throw new CLIResolutionError('Claude Code npm 启动入口类型不受支持；请选择 claude.exe 或标准 npm 安装生成的 claude.cmd。');
  // Match npm's preference for a Node executable beside the shim; never select node.cmd.
  const nodeName = platform === 'win32' ? 'node.exe' : 'node';
  const node = findExecutable(path.join(directory, nodeName), env, platform) ?? findExecutable(nodeName, env, platform);
  if (!node) throw new CLIResolutionError('此旧版 Claude Code npm 包需要 Node.js。请将 node.exe 加入 PATH 并完全退出后重开客户端，或更新 Claude Code npm 包。');
  return { file: node, prefix: [target] };
}

/** Recognize npm's plain env-node shebang without interpreting arbitrary launcher scripts. */
function usesEnvNode(file: string): boolean {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(file, 'r');
    const header = Buffer.alloc(512);
    const length = fs.readSync(descriptor, header, 0, header.length, 0);
    const text = header.toString('utf8', 0, length);
    const newline = text.indexOf('\n');
    if (newline < 0 && length === header.length) return false;
    return /^#![\t ]*\/usr\/bin\/env[\t ]+node[\t ]*\r?$/.test(newline < 0 ? text : text.slice(0, newline));
  } catch { return false; }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

/** The supplied environment is enriched with the selected POSIX Node's directory.
 * Pass this same object to the child process so CLI tools inherit the resolved Node.
 */
export function cliInvocation(settings: Settings, env = environment()): { file: string; prefix: string[] } {
  // cc-desk owns update confirmation for the CLI processes it starts.
  // Explicit `claude update` still works with the background updater disabled.
  env.DISABLE_AUTOUPDATER = '1';
  const file = findExecutable(settings.claudePath || 'claude', env);
  if (!file) throw new CLIResolutionError('找不到 Claude Code。请先安装 CLI，或在设置中填写 claude 可执行文件的完整路径。');
  if (/\.(cmd|bat)$/i.test(file)) return resolveNpmLauncher(file, env);
  if (process.platform !== 'win32' && usesEnvNode(file)) {
    // Keep the selected bin directory: npm/nvm's claude is usually a symlink into
    // lib/node_modules, while the matching Node remains beside that symlink.
    const node = findExecutable(path.join(path.dirname(file), 'node'), env) ?? findExecutable('node', env);
    if (!node) throw new CLIResolutionError('此 Claude Code 启动文件需要 Node.js。请在 claude 所在目录安装 node，或将 Node.js 加入 PATH 并完全退出后重开客户端。');
    const directory = path.dirname(node);
    env.PATH = [directory, ...(env.PATH ?? '').split(path.delimiter).filter(entry => entry && unquote(entry) !== directory)].join(path.delimiter);
    return { file: node, prefix: [file] };
  }
  return { file, prefix: [] };
}

export function parseCapabilities(help: string, executable: string, version: string): Capabilities {
  const flags = [...new Set(help.match(/--[a-zA-Z][a-zA-Z-]+/g) ?? [])];
  const effortLine = help.match(/--effort\b[^]*?(?=\n\s*(?:-[a-zA-Z],?\s+)?--[a-zA-Z]|$)/)?.[0] ?? '';
  const efforts: Effort[] = ['default'];
  if (flags.includes('--effort')) {
    for (const effort of ['low','medium','high','xhigh','max','ultracode'] as Effort[]) {
      if (new RegExp(`\\b${effort}\\b`).test(effortLine)) efforts.push(effort);
    }
  }
  return { available: true, executable, version: version.trim().slice(0, 200), flags, efforts };
}

export async function detectCLI(settings: Settings): Promise<Capabilities> {
  try {
    const env = environment();
    const { file, prefix } = cliInvocation(settings, env);
    const options = { env, timeout: 12000, maxBuffer: 2 * 1024 * 1024, windowsHide: true };
    const [version, help] = await Promise.all([
      execFileAsync(file, [...prefix, '--version'], options), execFileAsync(file, [...prefix, '--help'], options)
    ]);
    return parseCapabilities(help.stdout, file, version.stdout);
  } catch (error) {
    // A failed process can echo configuration/credentials through stderr. Do not forward it over IPC.
    return { available: false, executable: '', version: '', flags: [], efforts: ['default'], error: error instanceof CLIResolutionError ? error.message : 'Claude Code 检测失败。请检查 CLI 安装、可执行路径和权限，然后重新检测。' };
  }
}

export function claudeArguments(session: Session, capabilities: Capabilities, hasTranscript: boolean): string[] {
  if (session.started && !hasTranscript) throw new Error('无法恢复会话：未找到原会话记录。请检查 Claude 配置目录或从历史记录重新导入；不会自动创建空白会话。');
  const args: string[] = [];
  const add = (flag: string, ...values: string[]) => {
    if (!capabilities.flags.includes(flag)) throw new Error(`当前 CLI 不支持 ${flag}，请更新 Claude Code 后重新检测。`);
    args.push(flag, ...values);
  };
  if (hasTranscript || session.imported) add('--resume', session.claudeId);
  else if (session.resumeFrom) { add('--resume', session.resumeFrom); add('--fork-session'); add('--session-id', session.claudeId); }
  else add('--session-id', session.claudeId);
  add('--permission-mode', session.permissionMode);
  if (session.model) add('--model', session.model);
  if (session.effort !== 'default') {
    if (!capabilities.efforts.includes(session.effort)) throw new Error(`本机 CLI 的帮助信息未声明支持 ${session.effort}。请使用默认强度或升级 CLI。`);
    add('--effort', session.effort);
  }
  return args;
}

export function shellInvocation(settings: Settings): { file: string; args: string[] } {
  const file = settings.shellPath ? findExecutable(settings.shellPath) : process.platform === 'win32'
    ? findExecutable('pwsh') ?? findExecutable('powershell') : findExecutable(process.env.SHELL || 'bash') ?? findExecutable('bash');
  if (!file || /\.(cmd|bat)$/i.test(file)) throw new Error('找不到 Shell 可执行文件，请在设置中填写 Bash、Zsh 或 PowerShell 的完整路径。');
  return { file, args: /(?:pwsh|powershell)(?:\.exe)?$/i.test(file) ? ['-NoLogo'] : ['-l'] };
}
