import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const execFileAsync = promisify(execFile);

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

export function shellInvocation(settings: { shellPath: string }): { file: string; args: string[] } {
  const file = settings.shellPath ? findExecutable(settings.shellPath) : process.platform === 'win32'
    ? findExecutable('pwsh') ?? findExecutable('powershell') : findExecutable(process.env.SHELL || 'bash') ?? findExecutable('bash');
  if (!file || /\.(cmd|bat)$/i.test(file)) throw new Error('找不到 Shell 可执行文件，请在设置中填写 Bash、Zsh 或 PowerShell 的完整路径。');
  return { file, args: /(?:pwsh|powershell)(?:\.exe)?$/i.test(file) ? ['-NoLogo'] : ['-l'] };
}
