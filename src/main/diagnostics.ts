import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { cliInvocation, environment, execFileAsync } from './commands';
import type { DiagnosticScope, EnvironmentDiagnostics } from '../shared/diagnostics';

type JsonObject = Record<string, unknown>;
interface ProbeResult { stdout: string; exitCode: number }
export type DiagnosticRunner = (file: string, args: string[], options: {
  cwd?: string; env: Record<string, string>; timeout: number; maxBuffer: number; windowsHide: boolean;
}) => Promise<ProbeResult>;
/** Injection points isolate tests from the user's actual account and configuration. */
export interface DiagnosticOptions {
  home?: string;
  env?: Record<string, string>;
  run?: DiagnosticRunner;
  invocation?: { file: string; prefix: string[] };
}

const CONFIG_LIMIT = 2 * 1024 * 1024;
const ENTRY_LIMIT = 500;
const PROVIDER_KEYS = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL',
  'ANTHROPIC_CUSTOM_HEADERS', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST', 'AWS_PROFILE', 'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'ANTHROPIC_FOUNDRY_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY',
];
const isObject = (value: unknown): value is JsonObject => !!value && typeof value === 'object' && !Array.isArray(value);
const object = (value: unknown): JsonObject => isObject(value) ? value : {};
const own = (value: JsonObject, key: string): unknown => Object.hasOwn(value, key) ? value[key] : undefined;

/** Only the URL origin survives: never username, password, path, query or fragment. */
export function sanitizedOrigin(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 8192) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : undefined;
  } catch { return undefined; }
}

const runProcess: DiagnosticRunner = async (file, args, options) => {
  try {
    const result = await execFileAsync(file, args, options);
    return { stdout: result.stdout, exitCode: 0 };
  } catch (error) {
    // Authentication status deliberately exits 1 when logged out. Ignore stderr entirely.
    const failure = error as { code?: unknown; stdout?: unknown };
    if (typeof failure.code === 'number' && typeof failure.stdout === 'string') {
      return { stdout: failure.stdout, exitCode: failure.code };
    }
    throw new Error('诊断命令无法完成。');
  }
};

/** Parse only explicit status fields; email, account IDs, tokens and raw errors never leave main. */
export function authenticationSummary(output: string, exitCode: number): EnvironmentDiagnostics['auth'] {
  try {
    const value: unknown = JSON.parse(output);
    if (!isObject(value) || typeof value.loggedIn !== 'boolean' || ![0, 1].includes(exitCode)) throw new Error();
    if ((value.loggedIn && exitCode !== 0) || (!value.loggedIn && exitCode !== 1)) throw new Error();
    const method = typeof value.authMethod === 'string' &&
      ['claude.ai', 'api_key', 'apiKey', 'oauth', 'bedrock', 'vertex', 'foundry', 'none'].includes(value.authMethod)
      ? value.authMethod : undefined;
    return value.loggedIn
      ? { state: 'authenticated', method, message: 'CLI 报告已登录；尚未验证模型请求是否成功。' }
      : { state: 'unauthenticated', method, message: 'CLI 报告未登录；第三方提供商仍需单独检查其凭据与请求。' };
  } catch {
    return { state: 'unknown', message: '无法识别 CLI 返回的登录状态；原始输出已隐藏。' };
  }
}

async function probeCLI(binary: string, projectPath: string | undefined, env: Record<string, string>, options: DiagnosticOptions): Promise<Pick<EnvironmentDiagnostics, 'cli' | 'auth'>> {
  let invocation: { file: string; prefix: string[] };
  try { invocation = options.invocation ?? cliInvocation({ claudePath: binary, shellPath: '', maxSessions: 4, fontSize: 14, scrollback: 5000 }); }
  catch { return { cli: { installed: false, binary, runnable: false }, auth: { state: 'unavailable', message: '未找到可安全启动的 Claude Code CLI。' } }; }
  const cli: EnvironmentDiagnostics['cli'] = { installed: true, binary: invocation.file, runnable: false };
  const run = options.run ?? runProcess;
  const probeOptions = { env, cwd: projectPath, timeout: 8000, maxBuffer: 256 * 1024, windowsHide: true };
  try {
    const version = await run(invocation.file, [...invocation.prefix, '--version'], probeOptions);
    if (version.exitCode !== 0) throw new Error();
    // --version output is untrusted text too; retain a semver only, not arbitrary output.
    cli.version = version.stdout.match(/\b\d+\.\d+\.\d+\b/)?.[0];
    cli.runnable = true;
    const help = await run(invocation.file, [...invocation.prefix, 'auth', 'status', '--help'], probeOptions);
    if (help.exitCode !== 0 || !/\bauth\s+status\b/i.test(help.stdout) || !/--(?:json|text)\b/.test(help.stdout)) {
      return { cli, auth: { state: 'unsupported', message: '此 CLI 未声明支持登录状态查询，请在终端中检查 /status。' } };
    }
    // Current CLI emits JSON by default; only add --json when this exact subcommand advertises it.
    const args = [...invocation.prefix, 'auth', 'status'];
    if (/--json\b/.test(help.stdout)) args.push('--json');
    const status = await run(invocation.file, args, probeOptions);
    return { cli, auth: authenticationSummary(status.stdout, status.exitCode) };
  } catch {
    return { cli, auth: { state: 'unknown', message: 'CLI 状态查询失败或超时，请检查安装与本地配置；未验证服务连接。' } };
  }
}

async function readConfig(file: string, scope: DiagnosticScope, report: EnvironmentDiagnostics): Promise<JsonObject> {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > CONFIG_LIMIT) {
      report.configs.push({ scope, path: file, status: 'invalid', message: '文件类型不支持或超过 2 MiB 诊断读取限制。' });
      return {};
    }
    const contents = await fs.readFile(file, 'utf8');
    if (Buffer.byteLength(contents) > CONFIG_LIMIT) throw new Error();
    const value: unknown = JSON.parse(contents);
    if (!isObject(value)) throw new Error();
    report.configs.push({ scope, path: file, status: 'found' });
    return value;
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
    // JSON errors can include fragments of credentials. Never forward error.message.
    report.configs.push({ scope, path: file, status: missing ? 'missing' : 'invalid',
      ...(missing ? {} : { message: '无法读取或解析配置；错误原文已隐藏。' }) });
    return {};
  }
}

function collectProvider(env: JsonObject, source: string, report: EnvironmentDiagnostics): void {
  for (const name of PROVIDER_KEYS) {
    const value = own(env, name);
    if (value !== undefined) report.provider.env.push({ name, present: typeof value === 'string' && value.length > 0, source });
  }
  const rawOrigin = own(env, 'ANTHROPIC_BASE_URL');
  const origin = sanitizedOrigin(rawOrigin);
  if (origin) report.provider.origins!.push({ origin, source });
  else if (rawOrigin !== undefined) report.warnings.push(`${source} 中的 ANTHROPIC_BASE_URL 无法解析为 HTTP(S) origin；其值已隐藏。`);
}

function collectMcp(value: unknown, scope: DiagnosticScope, report: EnvironmentDiagnostics): void {
  const entries = Object.entries(object(value));
  if (entries.length > ENTRY_LIMIT) report.warnings.push(`${scope} MCP 配置超过 ${ENTRY_LIMIT} 项，列表已截断。`);
  for (const [name, config] of entries.slice(0, ENTRY_LIMIT)) {
    if (!isObject(config)) continue;
    const transport = config.type === 'http' || config.type === 'sse' || config.type === 'stdio' ? config.type
      : typeof config.command === 'string' ? 'stdio' : 'unknown';
    const candidate = typeof config.command === 'string' ? path.win32.basename(path.posix.basename(config.command)) : '';
    const commandName = candidate && /^[A-Za-z0-9_.+-]{1,80}$/.test(candidate) && !/^(?:sk-|token|secret)/i.test(candidate) ? candidate : undefined;
    report.mcp.push({ name: name.slice(0, 120), scope, transport,
      origin: sanitizedOrigin(config.url), commandName,
      envNames: Object.keys(object(config.env)).filter(key => /^[A-Za-z_][A-Za-z0-9_]{0,100}$/.test(key)).slice(0, ENTRY_LIMIT),
      status: 'configured' });
  }
}

async function collectSkills(directory: string, scope: DiagnosticScope, report: EnvironmentDiagnostics): Promise<void> {
  for (const kind of ['skills', 'commands'] as const) {
    const root = path.join(directory, kind);
    try {
      const entries = await fs.readdir(root, { withFileTypes: true });
      if (entries.length > ENTRY_LIMIT) report.warnings.push(`${scope} ${kind} 超过 ${ENTRY_LIMIT} 项，列表已截断。`);
      for (const entry of entries.sort((a,b) => a.name.localeCompare(b.name)).slice(0, ENTRY_LIMIT)) {
        if (entry.name.startsWith('.') || entry.name.toLowerCase() === 'synced') continue;
        if (kind === 'commands' && (!entry.isFile() || !entry.name.endsWith('.md'))) continue;
        if (kind === 'skills' && !entry.isDirectory() && !entry.isSymbolicLink()) continue;
        const file = kind === 'skills' ? path.join(root, entry.name, 'SKILL.md') : path.join(root, entry.name);
        try {
          if (!(await fs.stat(file)).isFile()) continue;
          report.skills.push({ name: kind === 'skills' ? entry.name : entry.name.slice(0, -3), scope, path: file });
        } catch { /* Broken symlinks and absent SKILL.md are not loadable skills. */ }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') report.warnings.push(`${scope} ${kind} 目录无法读取。`);
    }
  }
}

/** Metadata-only discovery: does not launch MCP, run hooks, read credentials files or edit configs. */
export async function diagnoseEnvironment(projectPath?: string, binary = '', options: DiagnosticOptions = {}): Promise<EnvironmentDiagnostics> {
  const env = options.env ?? environment();
  const home = options.home ?? os.homedir();
  const configuredDir = env.CLAUDE_CONFIG_DIR;
  const configDir = configuredDir ? path.resolve(projectPath ?? home, configuredDir) : path.join(home, '.claude');
  const report: EnvironmentDiagnostics = {
    checkedAt: Date.now(), cli: { installed: false, binary },
    auth: { state: 'unknown', message: '尚未查询登录状态。' },
    provider: { env: [], origins: [], verified: false }, configs: [], mcp: [], skills: [],
    warnings: ['这是本地配置清单；MCP、Skills 是否实际启用仍取决于 CLI 信任、策略与配置优先级。',
      '未枚举托管策略、插件内置、云端同步与项目子目录的 MCP/Skills，未调用模型或启动 MCP 服务。'],
  };
  const cliProbe = probeCLI(binary, projectPath, env, options);
  collectProvider(env, 'process', report);
  const settings = await readConfig(path.join(configDir, 'settings.json'), 'user', report);
  collectProvider(object(settings.env), 'user', report);
  if (settings.apiKeyHelper) report.warnings.push('用户配置包含 apiKeyHelper；诊断不会主动执行该命令，也不显示命令内容。');
  // A custom CLAUDE_CONFIG_DIR uses its own .claude.json; do not mix another account's metadata.
  const globalFile = configuredDir ? path.join(configDir, '.claude.json') : path.join(home, '.claude.json');
  const global = await readConfig(globalFile, 'user', report);
  collectMcp(global.mcpServers, 'user', report);
  await collectSkills(configDir, 'user', report);
  if (projectPath) {
    for (const [name, scope] of [['settings.json', 'project'], ['settings.local.json', 'local']] as const) {
      const settings = await readConfig(path.join(projectPath, '.claude', name), scope, report);
      collectProvider(object(settings.env), scope, report);
      if (settings.apiKeyHelper) report.warnings.push(`${scope} 配置包含 apiKeyHelper；诊断不执行或显示命令内容。`);
    }
    const projectMcp = await readConfig(path.join(projectPath, '.mcp.json'), 'project', report);
    collectMcp(projectMcp.mcpServers, 'project', report);
    const projects = object(global.projects);
    const normal = (file: string) => { const resolved = path.resolve(file); return process.platform === 'win32' ? resolved.toLowerCase() : resolved; };
    const entry = Object.entries(projects).find(([key]) => normal(key) === normal(projectPath));
    collectMcp(object(entry?.[1]).mcpServers, 'local', report);
    await collectSkills(path.join(projectPath, '.claude'), 'project', report);
  }
  const origins = [...new Set(report.provider.origins!.map(item => item.origin))];
  if (origins.length === 1) report.provider.origin = origins[0];
  else if (origins.length > 1) report.warnings.push('发现多个 Provider origin；此处不推断 CLI 最终采用哪一个，请结合会话 /status 检查。');
  if (env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST) report.warnings.push('检测到宿主托管 Provider，配置文件中的 Provider 可能不会生效。');
  Object.assign(report, await cliProbe);
  return report;
}
