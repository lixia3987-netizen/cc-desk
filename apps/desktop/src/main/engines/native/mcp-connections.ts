import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { assertStdioEnvironmentName, validateStdioEnvironment } from '@cc-desk/agent-node/process-supervisor';
import type { NativeMcpConnectionInput, NativeMcpConnectionList, NativeMcpConnectionView, NativeMcpCredentialMutation, NativeMcpProtocolVersion } from '../../../shared/native-mcp';
import { NativeCredentialStore } from './credentials';

const id = z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/);
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const name = z.string().trim().min(1).max(200).refine(value => !/[\x00-\x1f\x7f]/.test(value));
const auth = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('none') }).strict(),
  z.object({ mode: z.literal('env'), variable: z.string().min(1).max(128).regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/) }).strict(),
  z.object({ mode: z.literal('memory') }).strict(),
  z.object({ mode: z.literal('encrypted') }).strict(),
]);
const variableName = z.string().min(1).max(128).regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/);
const stdioEnvironment = z.preprocess(input => {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) return null;
  try { for (const key of Object.keys(input)) assertStdioEnvironmentName(key); }
  catch { return null; }
  return input;
}, z.record(variableName, variableName).superRefine((environment, context) => {
  const keys = Object.keys(environment), normalized = new Set<string>();
  if (keys.length > 16) context.addIssue({ code: 'custom', message: 'Too many environment mappings' });
  for (const key of keys) {
    try { assertStdioEnvironmentName(key); }
    catch { context.addIssue({ code: 'custom', message: 'Unsupported child environment variable' }); }
    const upper = key.toUpperCase();
    if (normalized.has(upper)) context.addIssue({ code: 'custom', message: 'Duplicate child environment variable' });
    normalized.add(upper);
  }
}));
const executable = z.string().min(1).max(4096).refine(value =>
  path.isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value) && !/\.(?:cmd|bat)$/i.test(value));
const argv = z.array(z.string().refine(value => !value.includes('\0'))).max(128).refine(values =>
  Buffer.byteLength(JSON.stringify(values), 'utf8') <= 32 * 1024);
const commonFields = { name, enabled: z.boolean() };
const httpFields = {
  ...commonFields, transport: z.literal('http'),
  endpoint: z.string().trim().min(1).max(2048), allowLoopbackHttp: z.boolean(), auth,
  protocolVersion: z.enum(['2026-07-28', '2025-11-25']).default('2026-07-28'),
};
const stdioFields = {
  ...commonFields, transport: z.literal('stdio'),
  protocolVersion: z.literal('2025-11-25').default('2025-11-25'),
  executable, argv, environment: stdioEnvironment, auth: z.object({ mode: z.literal('none') }).strict(),
};
function withDefaultTransport(input: unknown): unknown {
  if (input && typeof input === 'object' && !Array.isArray(input) && !('transport' in input)) return { ...input, transport: 'http' };
  return input;
}
export const nativeMcpConnectionInputSchema = z.preprocess(withDefaultTransport, z.discriminatedUnion('transport', [
  z.object({ id: id.optional(), revision: revision.optional(), ...httpFields }).strict(),
  z.object({ id: id.optional(), revision: revision.optional(), ...stdioFields }).strict(),
]));
export const nativeMcpConnectionReferenceSchema = z.object({ id, revision }).strict();
export const nativeMcpCredentialMutationSchema = z.object({
  id, revision, mode: z.enum(['memory', 'encrypted']),
  secret: z.string().min(1).max(8192).regex(/^[\x21-\x7e]+$/),
}).strict();
const persistedConnectionSchema = z.preprocess(withDefaultTransport, z.discriminatedUnion('transport', [
  z.object({
    id, revision, ...httpFields,
    ciphertext: z.string().min(1).max(65536).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/).optional(),
  }).strict(),
  z.object({ id, revision, ...stdioFields }).strict(),
]));
const diskSchema = z.object({ schemaVersion: z.literal(1), connections: z.array(persistedConnectionSchema).max(100) }).strict();
type StoredConnection = z.infer<typeof persistedConnectionSchema>;
const maximumFileBytes = 1024 * 1024;

export interface NativeMcpConnectionStoreOptions {
  /** Include initialization, approval waits and cleanup, not only tool execution. */
  isConnectionActive?(id: string): boolean;
  /** Include archived sessions so removing a connection cannot silently break their references. */
  isConnectionReferenced?(id: string): boolean;
  environment?: NodeJS.ProcessEnv;
}

/** Main-only snapshot. Never put this object in IPC responses or a journal. */
interface ResolvedNativeMcpConnectionBase {
  readonly connectionId: string;
  readonly revision: number;
  readonly name: string;
}
export interface ResolvedNativeMcpHttpConnection extends ResolvedNativeMcpConnectionBase {
  readonly transport: 'http';
  readonly endpoint: string;
  readonly protocolVersion: NativeMcpProtocolVersion;
  readonly allowLoopbackHttp: boolean;
  readonly bearerToken?: string;
}
export interface ResolvedNativeMcpStdioConnection extends ResolvedNativeMcpConnectionBase {
  readonly transport: 'stdio';
  readonly protocolVersion: '2025-11-25';
  readonly executable: string;
  readonly argv: readonly string[];
  /** Resolved values, deliberately excluded from public metadata and persistence. */
  readonly environment: Readonly<Record<string, string>>;
  /** Safe source names for startup review; never contains resolved values. */
  readonly environmentSources: Readonly<Record<string, string>>;
}
export type ResolvedNativeMcpConnection = ResolvedNativeMcpHttpConnection | ResolvedNativeMcpStdioConnection;

/** Preserve the complete endpoint path (including its trailing slash). Transports must reject redirects. */
export function validateNativeMcpEndpoint(value: string, allowLoopbackHttp: boolean): string {
  let url: URL;
  try {
    if (/[\s\\?#]/.test(value) || /:\/\/[^/]*@/.test(value)) throw new Error();
    url = new URL(value);
  } catch { throw new Error('MCP 地址格式无效，请填写不含账号、密码、查询参数或片段的完整地址。'); }
  if (url.username || url.password || url.search || url.hash) throw new Error('MCP 地址不能包含认证信息，请通过独立凭据设置认证。');
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127\.(\d{1,3}\.){2}\d{1,3}$/.test(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback && allowLoopbackHttp)) {
    throw new Error('远程 MCP 服务必须使用 HTTPS；本地回环 HTTP 需明确勾选允许。');
  }
  return url.toString();
}

/** Metadata and encrypted blobs are separate from workspace state and model connections. */
export class NativeMcpConnectionStore {
  private connections: StoredConnection[] = [];
  private loadError?: string;
  private readonly file: string;
  private readonly environment: NodeJS.ProcessEnv;

  constructor(dataDirectory: string, private readonly credentials: NativeCredentialStore, private readonly options: NativeMcpConnectionStoreOptions = {}) {
    this.file = path.join(dataDirectory, 'native', 'mcp-connections.json');
    this.environment = options.environment ?? process.env;
    this.load();
  }

  list(): NativeMcpConnectionList {
    return { connections: this.connections.map(item => this.view(item)), storage: this.credentials.protection(), ...(this.loadError ? { error: this.loadError } : {}) };
  }

  upsert(input: NativeMcpConnectionInput): NativeMcpConnectionView {
    this.assertLoaded();
    const parsed = nativeMcpConnectionInputSchema.safeParse(input);
    if (!parsed.success) throw new Error('MCP 连接配置无效，请检查名称、传输方式、地址、命令参数和环境变量映射。');
    const value = parsed.data;
    if (Boolean(value.id) !== Boolean(value.revision)) throw new Error('修改 MCP 连接必须提供当前修订版，请刷新后重试。');
    const previous = value.id ? this.current(value.id, value.revision!) : undefined;
    if (previous) this.assertInactive(previous.id);
    else if (this.connections.length >= 100) throw new Error('MCP 连接数量已达上限。');
    const { id: suppliedId, revision: _revision, ...metadata } = value;
    const normalized = metadata.transport === 'http' ? { ...metadata, endpoint: validateNativeMcpEndpoint(metadata.endpoint, metadata.allowLoopbackHttp) } : metadata;
    const item: StoredConnection = { ...normalized, id: suppliedId ?? randomUUID(), revision: this.nextRevision(previous) };
    const sameAuth = previous?.transport === item.transport && previous.auth.mode === item.auth.mode;
    if (sameAuth && item.transport === 'http' && item.auth.mode === 'encrypted' && previous?.transport === 'http' && previous.ciphertext) item.ciphertext = previous.ciphertext;
    this.commit(previous ? this.connections.map(entry => entry.id === item.id ? item : entry) : [...this.connections, item]);
    if (!sameAuth) this.credentials.delete(this.credentialKey(item.id));
    return this.view(item);
  }

  setCredential(input: NativeMcpCredentialMutation): NativeMcpConnectionView {
    this.assertLoaded();
    const parsed = nativeMcpCredentialMutationSchema.safeParse(input);
    if (!parsed.success) throw new Error('MCP 凭据设置无效，请重新输入。');
    const { id, revision, mode, secret } = parsed.data;
    const previous = this.current(id, revision);
    this.assertInactive(id);
    if (previous.transport !== 'http') throw new Error('stdio MCP 不使用 HTTP 凭据，请配置主进程环境变量映射。');
    const item: Extract<StoredConnection, { transport: 'http' }> = { ...previous, revision: this.nextRevision(previous), auth: { mode } };
    delete item.ciphertext;
    if (mode === 'encrypted') item.ciphertext = this.credentials.encrypt(secret);
    this.commit(this.connections.map(entry => entry.id === id ? item : entry));
    if (mode === 'memory') this.credentials.set(this.credentialKey(id), secret);
    else this.credentials.delete(this.credentialKey(id));
    return this.view(item);
  }

  remove(input: { id: string; revision: number }): void {
    this.assertLoaded();
    const parsed = nativeMcpConnectionReferenceSchema.safeParse(input);
    if (!parsed.success) throw new Error('MCP 连接引用无效，请刷新后重试。');
    this.current(parsed.data.id, parsed.data.revision);
    this.assertInactive(parsed.data.id);
    if (this.options.isConnectionReferenced?.(parsed.data.id)) throw new Error('已有会话引用此 MCP 连接；请先禁用连接或替换会话引用，再删除。');
    this.commit(this.connections.filter(entry => entry.id !== parsed.data.id));
    this.credentials.delete(this.credentialKey(parsed.data.id));
  }

  resolve(connectionId: string): ResolvedNativeMcpConnection {
    this.assertLoaded();
    if (!id.safeParse(connectionId).success) throw new Error('请选择有效的 MCP 连接。');
    const item = this.current(connectionId);
    if (!item.enabled) throw new Error('此 MCP 连接已禁用，请在设置中启用或选择其他连接。');
    if (item.transport === 'stdio') {
      const environment: Record<string, string> = Object.create(null);
      for (const [target, source] of Object.entries(item.environment)) {
        const value = this.environment[source];
        if (typeof value !== 'string') throw new Error('主进程未找到此 stdio MCP 映射的环境变量，请设置后重启应用。');
        environment[target] = value;
      }
      let checked: Record<string, string>;
      try { checked = validateStdioEnvironment(environment); }
      catch { throw new Error('此 stdio MCP 的环境变量值格式或大小无效，请检查后重启应用。'); }
      return Object.freeze({ transport: 'stdio', connectionId: item.id, revision: item.revision, name: item.name, protocolVersion: item.protocolVersion, executable: item.executable, argv: Object.freeze([...item.argv]), environment: Object.freeze(checked), environmentSources: Object.freeze({ ...item.environment }) });
    }
    const endpoint = validateNativeMcpEndpoint(item.endpoint, item.allowLoopbackHttp);
    let bearerToken: string | undefined;
    if (item.auth.mode === 'env') bearerToken = this.environment[item.auth.variable];
    else if (item.auth.mode === 'memory') bearerToken = this.credentials.get(this.credentialKey(item.id));
    else if (item.auth.mode === 'encrypted' && item.ciphertext) bearerToken = this.credentials.decrypt(item.ciphertext);
    if (item.auth.mode !== 'none') {
      if (!bearerToken) throw new Error(item.auth.mode === 'env' ? '主进程未找到此 MCP 连接指定的环境变量，请设置后重启应用。' : '此 MCP 连接尚无可用凭据，请重新设置（本次内存凭据不会跨重启保留）。');
      if (!nativeMcpCredentialMutationSchema.shape.secret.safeParse(bearerToken).success) throw new Error('此 MCP 连接的凭据格式无效，请重新设置。');
    }
    return Object.freeze({ transport: 'http', connectionId: item.id, revision: item.revision, name: item.name, endpoint, protocolVersion: item.protocolVersion, allowLoopbackHttp: item.allowLoopbackHttp, ...(bearerToken ? { bearerToken } : {}) });
  }

  /** Check a run's metadata snapshot without exposing or resolving its credential again. */
  assertCurrent(input: { id: string; revision: number }): void {
    this.assertLoaded();
    const parsed = nativeMcpConnectionReferenceSchema.safeParse(input);
    if (!parsed.success) throw new Error('MCP 连接引用无效，请刷新后重试。');
    this.current(parsed.data.id, parsed.data.revision);
  }

  private credentialKey(connectionId: string): string { return `native-mcp:${connectionId}`; }
  private nextRevision(previous?: StoredConnection): number {
    if (previous?.revision === Number.MAX_SAFE_INTEGER) throw new Error('MCP 连接修订版已达上限，请创建新连接。');
    return (previous?.revision ?? 0) + 1;
  }
  private current(connectionId: string, expectedRevision?: number): StoredConnection {
    const value = this.connections.find(item => item.id === connectionId);
    if (!value) throw new Error('MCP 连接不存在，请在设置中选择或创建连接。');
    if (expectedRevision !== undefined && value.revision !== expectedRevision) throw new Error('此 MCP 连接已更新，请刷新后重试。');
    return value;
  }
  private view(item: StoredConnection): NativeMcpConnectionView {
    let metadata;
    if (item.transport === 'http') {
      const { ciphertext: _ciphertext, ...publicMetadata } = item;
      metadata = { ...publicMetadata, auth: { ...publicMetadata.auth } };
    } else metadata = { ...item, argv: [...item.argv], environment: { ...item.environment }, auth: { ...item.auth } };
    const credentialConfigured = item.transport === 'stdio' || item.auth.mode === 'none' || item.auth.mode === 'env' || (item.auth.mode === 'encrypted' ? Boolean(item.ciphertext) : Boolean(this.credentials.get(this.credentialKey(item.id))));
    let ready = false, error: string | undefined;
    try { this.resolve(item.id); ready = true; }
    catch (cause) { error = cause instanceof Error ? cause.message : 'MCP 连接不可用。'; }
    return { ...metadata, credentialConfigured, ready, ...(error ? { error } : {}) };
  }
  private assertLoaded(): void { if (this.loadError) throw new Error(this.loadError); }
  private assertInactive(connectionId: string): void {
    if (this.options.isConnectionActive?.(connectionId)) throw new Error('此 MCP 连接正被运行中的回合使用，请先停止相关回合并等待清理完成。');
  }

  private load(): void {
    try {
      let source: string;
      try {
        if (fs.statSync(this.file).size > maximumFileBytes) throw new Error();
        source = fs.readFileSync(this.file, 'utf8');
      } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      const parsed = diskSchema.parse(JSON.parse(source));
      const ids = new Set<string>();
      for (const item of parsed.connections) {
        if (ids.has(item.id) || (item.transport === 'http' && item.ciphertext && item.auth.mode !== 'encrypted')) throw new Error();
        ids.add(item.id);
        if (item.transport === 'http') validateNativeMcpEndpoint(item.endpoint, item.allowLoopbackHttp);
      }
      this.connections = parsed.connections;
    } catch { this.loadError = 'MCP 连接文件损坏、版本不受支持或无法读取。已停止读写，请保留文件并修复后重启应用。'; }
  }

  private commit(next: StoredConnection[]): void {
    const directory = path.dirname(this.file), temporary = path.join(directory, `.mcp-connections-${randomUUID()}.tmp`);
    let fd: number | undefined;
    try {
      const source = JSON.stringify(diskSchema.parse({ schemaVersion: 1, connections: next }));
      if (Buffer.byteLength(source) > maximumFileBytes) throw new Error();
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      fd = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(fd, source);
      fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      fs.renameSync(temporary, this.file);
      this.connections = next;
    } catch { throw new Error('MCP 连接保存失败，请检查配置大小、磁盘空间和数据目录权限。'); }
    finally {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(temporary); } catch { /* A completed rename removes the temporary file. */ }
    }
  }
}
