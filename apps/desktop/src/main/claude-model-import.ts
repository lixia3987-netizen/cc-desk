import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ClaudeModelImportChoice, ClaudeModelImportInput, ClaudeModelImportPreview, ClaudeModelImportResult } from '../shared/claude-model-import';
import { ConnectionStore, nativeCredentialMutationSchema, validateNativeBaseURL } from './engines/native/connections';

const MAX_FILE_BYTES = 1024 * 1024;
const PREVIEW_TTL_MS = 5 * 60 * 1000;
const MAX_PREVIEWS = 10;
const modelVariables = ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL', 'ANTHROPIC_CUSTOM_MODEL_OPTION'] as const;
const aliases = new Set(['default', 'sonnet', 'opus', 'haiku', 'fable', 'opusplan', 'best']);
const invalidConfig = 'Claude 配置格式无效，请选择包含有效 model 或 env 字段的 JSON 配置文件。';

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function own(value: Record<string, unknown>, key: string): unknown { return Object.hasOwn(value, key) ? value[key] : undefined; }
function stringField(value: Record<string, unknown>, key: string, max: number): string | undefined {
  const field = own(value, key);
  if (field === undefined || field === '') return undefined;
  if (typeof field !== 'string' || field.length > max || /[\x00-\x1f\x7f]/.test(field) || field.trim() !== field) throw new Error(invalidConfig);
  return field;
}
function concreteModel(model: string): boolean { return !aliases.has(model.toLowerCase()) && !/\[[^\]]*\]$/.test(model); }

/** Main-only parse result. Never serialize the secret or the original source object. */
export interface ParsedClaudeModelConfig {
  preview: Omit<ClaudeModelImportPreview, 'token' | 'expiresAt'>;
  secret?: string;
  authHeader: 'x-api-key' | 'authorization';
}

export function parseClaudeModelConfig(source: unknown, sourcePath: string): ParsedClaudeModelConfig {
  if (!record(source)) throw new Error(invalidConfig);
  const rawEnv = own(source, 'env');
  if (rawEnv !== undefined && !record(rawEnv)) throw new Error(invalidConfig);
  const env = record(rawEnv) ? rawEnv : {};
  const authToken = stringField(env, 'ANTHROPIC_AUTH_TOKEN', 16384);
  const apiKey = stringField(env, 'ANTHROPIC_API_KEY', 16384);
  for (const secret of [authToken, apiKey]) if (secret && !nativeCredentialMutationSchema.shape.secret.safeParse(secret).success) throw new Error('Claude 配置中的凭据格式无效。');
  const secret = authToken ?? apiKey;
  const secrets = [authToken, apiKey].filter((value): value is string => !!value);
  const containsSecret = (value: string) => secrets.some(item => value.includes(item));
  const warnings: string[] = [];
  const models: ClaudeModelImportChoice[] = [];
  const values = new Map<string, string>();
  for (const key of modelVariables) {
    const value = stringField(env, key, 200);
    if (value && /\s/.test(value)) throw new Error(invalidConfig);
    if (value && !containsSecret(value)) values.set(key, value);
    else if (value) warnings.push('一个模型字段包含凭据信息，已忽略该字段。');
  }
  const rawSettingsModel = stringField(source, 'model', 200);
  if (rawSettingsModel && /\s/.test(rawSettingsModel)) throw new Error(invalidConfig);
  const settingsModel = rawSettingsModel && !containsSecret(rawSettingsModel) ? rawSettingsModel : undefined;
  if (rawSettingsModel && !settingsModel) warnings.push('默认模型字段包含凭据信息，已忽略该字段。');
  const resolveAlias = (value: string): string => {
    const mappings: Record<string, string> = { opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL', sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL', haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL', fable: 'ANTHROPIC_DEFAULT_FABLE_MODEL' };
    const mapping = Object.hasOwn(mappings, value.toLowerCase()) ? mappings[value.toLowerCase()] : undefined;
    return mapping ? values.get(mapping) ?? value : value;
  };
  const add = (value: string, sourceName: string): string => {
    const resolved = resolveAlias(value);
    const existing = models.find(item => item.model === resolved);
    if (existing) { if (!existing.sources.includes(sourceName)) existing.sources.push(sourceName); }
    else models.push({ model: resolved, sources: [sourceName], nativeImportable: concreteModel(resolved) });
    return resolved;
  };
  let model: string | undefined, modelSource: string | undefined;
  const environmentModel = values.get('ANTHROPIC_MODEL');
  if (environmentModel) { model = add(environmentModel, 'env.ANTHROPIC_MODEL'); modelSource = 'env.ANTHROPIC_MODEL'; }
  if (settingsModel) { const resolved = add(settingsModel, 'settings.model'); if (!model) { model = resolved; modelSource = 'settings.model'; } }
  const defaultModel = values.get('ANTHROPIC_DEFAULT_MODEL');
  if (!model && defaultModel) { model = add(defaultModel, 'env.ANTHROPIC_DEFAULT_MODEL'); modelSource = 'env.ANTHROPIC_DEFAULT_MODEL'; }
  for (const [key, value] of values) add(value, `env.${key}`);
  if (!model && models.length === 1) { model = models[0].model; modelSource = models[0].sources[0]; }
  if (!models.length) warnings.push('未找到模型名称。可以先在 Claude 源配置中设置 model，或手动添加自研 Agent 模型连接。');
  if (models.some(item => !item.nativeImportable)) warnings.push('Claude 模型别名需要配置对应的具体模型名称后，才能导入为自研 Agent 模型连接。');
  let baseURL: string;
  const configuredURL = stringField(env, 'ANTHROPIC_BASE_URL', 2048);
  if (configuredURL && containsSecret(configuredURL)) throw new Error('Claude 服务地址包含凭据信息，无法导入；请将凭据放到独立认证字段。');
  try { baseURL = validateNativeBaseURL(configuredURL ?? 'https://api.anthropic.com', true); }
  catch { throw new Error('Claude 服务地址无效；请使用不含凭据、查询参数或片段的 HTTPS 地址，或本机回环 HTTP 地址。'); }
  if (!secret) warnings.push('配置中未发现 API 凭据。导入的自研 Agent 模型连接需要另外设置凭据；Claude 登录状态不会被读取。');
  if (own(source, 'apiKeyHelper') !== undefined) warnings.push('未执行 apiKeyHelper；这里只读取配置文件中的模型和环境变量字段。');
  if (!sourcePath || sourcePath.length > 4096 || /[\x00-\x1f\x7f]/.test(sourcePath)) throw new Error('Claude 配置文件路径无效。');
  return {
    preview: {
      sourcePath: containsSecret(sourcePath) ? '已隐藏含凭据信息的配置文件路径' : sourcePath,
      baseURL, ...(baseURL.startsWith('http:') ? { requiresLoopbackHttp: true } : {}), ...(model ? { model, modelSource } : {}), models,
      credential: { configured: !!secret, ...(secret ? { source: authToken ? 'ANTHROPIC_AUTH_TOKEN' as const : 'ANTHROPIC_API_KEY' as const } : {}) },
      warnings: [...new Set(warnings)],
    },
    ...(secret ? { secret } : {}), authHeader: authToken ? 'authorization' : 'x-api-key',
  };
}

interface PendingImport extends ParsedClaudeModelConfig { expiresAt: number; timer: NodeJS.Timeout }
export interface ClaudeModelImportOptions {
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  chooseFile?(): Promise<string | null>;
  now?(): number;
  onChanged?(): void;
}

export class ClaudeModelImporter {
  private readonly pending = new Map<string, PendingImport>();
  private readonly now: () => number;
  constructor(private readonly connections: ConnectionStore, private readonly options: ClaudeModelImportOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  async preview(input: { source: 'default' | 'file' }): Promise<ClaudeModelImportPreview | null> {
    if (!input || !['default', 'file'].includes(input.source)) throw new Error('Claude 配置预览请求无效。');
    this.prune();
    let sourcePath: string;
    if (input.source === 'file') {
      let selected: string | null | undefined;
      try { selected = await this.options.chooseFile?.(); }
      catch { throw new Error('无法打开配置文件选择窗口，请重试。'); }
      if (!selected) return null;
      sourcePath = selected;
    } else {
      const configuredDirectory = (this.options.environment ?? process.env).CLAUDE_CONFIG_DIR;
      if (configuredDirectory !== undefined && (!configuredDirectory.trim() || configuredDirectory.length > 4096 || /[\x00-\x1f\x7f]/.test(configuredDirectory))) throw new Error('CLAUDE_CONFIG_DIR 配置无效。');
      sourcePath = path.join(configuredDirectory ? path.resolve(configuredDirectory) : path.join(this.options.homeDirectory ?? os.homedir(), '.claude'), 'settings.json');
    }
    const parsed = parseClaudeModelConfig(this.read(sourcePath), sourcePath);
    while (this.pending.size >= MAX_PREVIEWS) this.drop(this.pending.keys().next().value!);
    const token = randomUUID(), expiresAt = this.now() + PREVIEW_TTL_MS;
    const timer = setTimeout(() => this.drop(token), PREVIEW_TTL_MS);
    timer.unref();
    this.pending.set(token, { ...parsed, expiresAt, timer });
    return { ...structuredClone(parsed.preview), token, expiresAt: new Date(expiresAt).toISOString() };
  }

  import(input: ClaudeModelImportInput): ClaudeModelImportResult {
    this.prune();
    const pending = this.pending.get(input.token);
    if (!pending) throw new Error('导入预览已过期或已使用，请重新读取 Claude 配置。');
    // Every attempt consumes the capability, including failed imports. Original configuration stays untouched.
    this.drop(input.token);
    const selectedModel = input.model ?? pending.preview.model;
    const choice = pending.preview.models.find(item => item.model === selectedModel);
    if (!choice) throw new Error('请选择预览中有效的模型名称，然后重新读取并导入。');
    if (!choice.nativeImportable) throw new Error('该 Claude 别名没有具体模型映射，请设置映射或选择具体模型后重新读取。');
    if (pending.preview.requiresLoopbackHttp && input.allowLoopbackHttp !== true) throw new Error('本机代理使用 HTTP；请明确勾选允许本机回环 HTTP 后重新读取并导入。');
    const mode = input.credentialMode ?? 'memory';
    if (mode !== 'memory' && mode !== 'encrypted') throw new Error('凭据保存方式无效。');
    const connection = this.connections.import({
      name: '从 Claude 导入', protocol: 'anthropic', authHeader: pending.authHeader,
      baseURL: pending.preview.baseURL, model: choice.model, allowLoopbackHttp: pending.preview.requiresLoopbackHttp === true && input.allowLoopbackHttp === true, enabled: true, auth: { mode },
    }, pending.secret ? { mode, secret: pending.secret } : undefined);
    this.changed();
    return { connection, model: choice.model, notice: pending.secret ? '已创建独立的自研 Agent 模型连接。' : '已创建自研 Agent 模型连接；请设置 API 凭据后使用。Claude 登录凭据不会被读取或导入。' };
  }

  dispose(): void { for (const token of this.pending.keys()) this.drop(token); }
  private changed(): void { try { this.options.onChanged?.(); } catch { /* A UI notification cannot turn a committed import into a reported failure. */ } }
  private drop(token: string): void { const value = this.pending.get(token); if (value) clearTimeout(value.timer); this.pending.delete(token); }
  private prune(): void { const now = this.now(); for (const [token, value] of this.pending) if (value.expiresAt <= now) this.drop(token); }
  private read(sourcePath: string): unknown {
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(sourcePath, 'r');
      const status = fs.fstatSync(descriptor);
      if (!status.isFile() || status.size > MAX_FILE_BYTES) throw new Error();
      const bytes = Buffer.alloc(MAX_FILE_BYTES + 1);
      let length = 0, count = 0;
      do { count = fs.readSync(descriptor, bytes, length, bytes.length - length, null); length += count; } while (count > 0 && length < bytes.length);
      if (length > MAX_FILE_BYTES) throw new Error();
      return JSON.parse(bytes.subarray(0, length).toString('utf8').replace(/^\uFEFF/, ''));
    } catch { throw new Error('无法读取 Claude 配置；请确认文件存在、为有效 JSON 且不超过 1 MiB。'); }
    finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
  }
}
