import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Capabilities, Effort, Session, Settings } from '../shared/types';
export const execFileAsync = promisify(execFile);

export function environment(): Record<string,string> {
  const env: Record<string,string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  const key = Object.keys(env).find(k => k.toLowerCase() === 'path') ?? 'PATH';
  const extra = [path.join(os.homedir(), '.local', 'bin'), path.join(os.homedir(), '.npm-global', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  if (process.platform === 'win32') extra.push(path.join(env.APPDATA ?? '', 'npm'));
  env[key] = [...(env[key] ?? '').split(path.delimiter), ...extra].filter(Boolean).join(path.delimiter);
  // Electron's startup switches must not propagate to shell / CLI processes.
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.WORKBENCH_DEV_URL;
  delete env.WORKBENCH_DATA_DIR;
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  return env;
}

export function findExecutable(name: string, env = environment()): string | undefined {
  const dirs = path.isAbsolute(name) || /[/\\]/.test(name) ? [''] : (env.PATH ?? env.Path ?? '').split(path.delimiter);
  const extensions = process.platform === 'win32' && !path.extname(name) ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of dirs) for (const extension of extensions) {
    const file = dir ? path.join(dir, name + extension) : name + extension;
    try {
      if (!fs.statSync(file).isFile()) continue;
      fs.accessSync(file, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
      return path.resolve(file);
    } catch { /* Try the next PATH entry. */ }
  }
}

export function cliInvocation(settings: Settings): { file: string; prefix: string[] } {
  const file = findExecutable(settings.claudePath || 'claude');
  if (!file) throw new Error('找不到 Claude Code。请先安装 CLI，或在设置中填写 claude 可执行文件的完整路径。');
  if (/\.(cmd|bat)$/i.test(file)) {
    // Do not pass arbitrary strings through cmd.exe: resolve npm's standard shim.
    const script = path.join(path.dirname(file), 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
    const node = findExecutable('node');
    if (!node || !fs.existsSync(script)) throw new Error('该 CMD/BAT 启动器无法安全解析。请使用官方 claude.exe，或标准 npm 安装并将 node.exe 加入 PATH。');
    return { file: node, prefix: [script] };
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
    const { file, prefix } = cliInvocation(settings);
    const options = { env: environment(), timeout: 12000, maxBuffer: 2 * 1024 * 1024, windowsHide: true };
    const [version, help] = await Promise.all([
      execFileAsync(file, [...prefix, '--version'], options), execFileAsync(file, [...prefix, '--help'], options)
    ]);
    return parseCapabilities(help.stdout, file, version.stdout);
  } catch (error) {
    return { available: false, executable: '', version: '', flags: [], efforts: ['default'], error: String((error as Error).message).slice(0, 1000) };
  }
}

export function claudeArguments(session: Session, capabilities: Capabilities, hasTranscript: boolean): string[] {
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
