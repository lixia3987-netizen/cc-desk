import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { cliInvocation, detectCLI, environment, execFileAsync, findExecutable } from './commands';
import type { Settings } from '../shared/types';
import { cliVersion, type CLIUpdateCandidate } from './cli-update-service';

const RELEASES = 'https://downloads.claude.ai/claude-code-releases';
type Channel = 'latest' | 'stable';
type Fetch = (url: string, options: RequestInit) => Promise<Response>;
type Invocation = { file: string; prefix: string[] };

function readConfiguration(file: string): Record<string, unknown> {
  try {
    if (fs.statSync(file).size > 1024 * 1024) throw new Error();
    const data: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error('无法读取 Claude Code 更新配置，请检查 settings.json 后重试。');
  }
}
export function updateConfiguration(env: Record<string, string>, home = os.homedir(), platform = process.platform) {
  const config = readConfiguration(path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'settings.json'));
  const managedPath = platform === 'win32' ? path.join(env.ProgramFiles || 'C:\\Program Files', 'ClaudeCode', 'managed-settings.json')
    : platform === 'darwin' ? '/Library/Application Support/ClaudeCode/managed-settings.json' : '/etc/claude-code/managed-settings.json';
  const managed = readConfiguration(managedPath);
  const settings = { ...config, ...managed };
  const configuredEnv = { ...env, ...(config.env as object), ...(managed.env as object) } as Record<string, unknown>;
  const disabled = configuredEnv.DISABLE_UPDATES;
  if (disabled === '1' || disabled === 'true' || disabled === true) throw new Error('Claude Code 配置禁用了更新（DISABLE_UPDATES）。请联系配置维护者。');
  const channel: Channel = settings.autoUpdatesChannel === 'stable' ? 'stable' : 'latest';
  return { channel };
}

function npmPackage(invocation: Invocation): boolean {
  let directory = path.dirname(fs.realpathSync(invocation.prefix[0] || invocation.file));
  for (let depth = 0; depth < 6; depth++) {
    const manifest = path.join(directory, 'package.json');
    try {
      if (fs.statSync(manifest).size <= 128 * 1024 && JSON.parse(fs.readFileSync(manifest, 'utf8')).name === '@anthropic-ai/claude-code') return true;
    } catch { /* Not an npm package directory. */ }
    const parent = path.dirname(directory); if (parent === directory) break; directory = parent;
  }
  return false;
}
/** Resolve npm's standard Windows entry without executing or interpolating a CMD script. */
export function npmInvocation(launcher: string, env: Record<string, string>, platform = process.platform): Invocation {
  const npm = findExecutable(path.join(path.dirname(launcher), 'npm'), env, platform) ?? findExecutable('npm', env, platform);
  if (!npm) throw new Error('未找到 npm，无法查询当前 npm 仓库中的 Claude Code 版本。请检查 Node.js / npm 安装。');
  if (!/\.(cmd|bat)$/i.test(npm)) return { file: npm, prefix: [] };
  const script = path.join(path.dirname(npm), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const nodeName = platform === 'win32' ? 'node.exe' : 'node';
  const node = findExecutable(path.join(path.dirname(npm), nodeName), env, platform) ?? findExecutable(nodeName, env, platform);
  if (!node || !fs.existsSync(script)) throw new Error('npm 启动文件不完整，请修复 Node.js / npm 安装后重试。');
  return { file: node, prefix: [script] };
}

async function releaseVersion(channel: Channel, fetch: Fetch): Promise<string> {
  const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 15_000);
  try {
    const response = await fetch(`${RELEASES}/${channel}`, { signal: abort.signal, credentials: 'omit', cache: 'no-store' });
    if (!response.ok || !response.body) throw new Error();
    const reader = response.body.getReader();
    let data = '';
    try {
      for (;;) {
        const chunk = await reader.read(); if (chunk.done) break;
        data += Buffer.from(chunk.value).toString('utf8');
        if (data.length > 200) throw new Error();
      }
    } finally { await reader.cancel(); }
    return cliVersion(data);
  } finally { clearTimeout(timer); }
}

/** Own the updater's process group so a timeout cannot leave an npm child installing in the background. */
export async function runUpdateCommand(invocation: Invocation, env: Record<string, string>, timeout = 10 * 60_000): Promise<void> {
  const child = spawn(invocation.file, [...invocation.prefix, 'update'], {
    env, cwd: os.homedir(), windowsHide: true, detached: process.platform !== 'win32', shell: false, stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Do not forward command output: it can contain registry credentials or proxy URLs.
  child.stdout.resume(); child.stderr.resume();
  let timedOut = false;
  let cleanup: Promise<void> | undefined;
  const stop = async () => {
    if (!child.pid) return;
    if (process.platform === 'win32') {
      await execFileAsync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }).catch(() => { child.kill('SIGKILL'); });
    } else {
      const signal = (name: NodeJS.Signals) => { try { process.kill(-child.pid!, name); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } };
      signal('SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 1500));
      signal('SIGKILL');
    }
  };
  const timer = setTimeout(() => { timedOut = true; cleanup = stop(); void cleanup.catch(() => {}); }, timeout);
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
    if (code !== 0 && !cleanup) cleanup = stop();
    await cleanup;
    if (timedOut) throw new Error('更新超时，更新进程已停止。请检查网络或代理后重新检查更新。');
    if (code !== 0) throw new Error('Claude Code 更新失败。请检查网络、仓库和安装权限；通过包管理器安装时，请使用对应的更新命令后重新检测。');
  } catch (error) {
    if (error instanceof Error && /^更新超时|^Claude Code 更新失败/.test(error.message)) throw error;
    throw new Error('无法完成 Claude Code 更新，请检查 CLI 安装和执行权限后重试。');
  } finally { clearTimeout(timer); }
}

export class CLIUpdater {
  constructor(private settings: () => Settings, private fetch: Fetch) {}
  private async local() {
    const settings = { ...this.settings() }, env = environment();
    const configuration = updateConfiguration(env);
    const launcher = findExecutable(settings.claudePath || 'claude', env);
    const invocation = cliInvocation(settings, env);
    const capabilities = await detectCLI(settings);
    if (!capabilities.available || !launcher) throw new Error(capabilities.error || '请先安装并检测 Claude Code，再检查更新。');
    const currentVersion = cliVersion(capabilities.version);
    const identity = JSON.stringify([settings.claudePath, fs.realpathSync(launcher), invocation, currentVersion, configuration]);
    return { ...configuration, currentVersion, identity, invocation, launcher, env };
  }
  async check(): Promise<CLIUpdateCandidate> {
    const local = await this.local();
    let latestVersion: string;
    try {
      if (npmPackage(local.invocation)) {
        const npm = npmInvocation(local.launcher, local.env);
        const result = await execFileAsync(npm.file, [...npm.prefix, 'view', `@anthropic-ai/claude-code@${local.channel}`, 'version', '--json', '--fetch-timeout=10000', '--fetch-retries=0'],
          { env: local.env, cwd: os.homedir(), windowsHide: true, timeout: 15_000, maxBuffer: 64 * 1024 });
        const version: unknown = JSON.parse(result.stdout);
        if (typeof version !== 'string') throw new Error();
        latestVersion = cliVersion(version);
      } else latestVersion = await releaseVersion(local.channel, this.fetch);
    } catch {
      throw new Error('检查更新失败，请检查网络、代理或 npm 仓库后重试。现有会话可继续使用。');
    }
    return { identity: local.identity, currentVersion: local.currentVersion, latestVersion, channel: local.channel };
  }
  async verify(candidate: CLIUpdateCandidate) {
    const local = await this.local();
    if (local.identity !== candidate.identity) throw new Error('Claude Code 路径、版本或更新配置已变化，请重新检查更新并确认。');
    return local;
  }
  async install(candidate: CLIUpdateCandidate) {
    const local = await this.verify(candidate);
    await runUpdateCommand(local.invocation, local.env);
  }
}
