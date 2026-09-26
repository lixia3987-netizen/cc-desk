import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { NativeConnectionInput, NativeConnectionList, NativeConnectionReadiness, NativeConnectionView, NativeCredentialMutation } from '../../../shared/native-connections';
import { NativeCredentialStore, type NativeSafeStorage } from './credentials';

const id = z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/);
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const text = z.string().trim().min(1).max(200).refine(value => !/[\x00-\x1f\x7f]/.test(value));
const model = text;
const auth = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('env'), variable: z.string().min(1).max(128).regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/) }).strict(),
  z.object({ mode: z.literal('memory') }).strict(),
  z.object({ mode: z.literal('encrypted') }).strict(),
]);
const fields = {
  name: text, protocol: z.literal('responses'), baseURL: z.string().trim().min(1).max(2048), model,
  allowLoopbackHttp: z.boolean(), enabled: z.boolean(), auth,
};
export const nativeConnectionInputSchema = z.object({ id: id.optional(), revision: revision.optional(), ...fields }).strict();
export const nativeConnectionReferenceSchema = z.object({ id, revision }).strict();
export const nativeConnectionReadinessSchema = z.object({ id, model: model.optional() }).strict();
export const nativeCredentialMutationSchema = z.object({
  id, revision, mode: z.enum(['memory', 'encrypted']),
  secret: z.string().min(1).max(16384).refine(value => value.trim() === value && !/[\x00-\x20\x7f]/.test(value), '凭据格式无效。'),
}).strict();
const persistedConnectionSchema = z.object({ id, revision, ...fields, ciphertext: z.string().min(1).max(65536).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/).optional() }).strict();
const diskSchema = z.object({ schemaVersion: z.literal(1), connections: z.array(persistedConnectionSchema).max(100) }).strict();
type StoredConnection = z.infer<typeof persistedConnectionSchema>;

export interface NativeConnectionStoreOptions {
  safeStorage?: NativeSafeStorage;
  platform?: string;
  /** Consult all native executors; active includes preparing and stopping runs. */
  isConnectionActive?(id: string): boolean;
  /** Include archived sessions: deleting a reference destroys their future readiness. */
  isConnectionReferenced?(id: string): boolean;
  environment?: NodeJS.ProcessEnv;
}
/** Main-only result. Never serialize this object into state, logs or a run journal. */
export interface ResolvedNativeConnection {
  readonly connectionId: string;
  readonly revision: number;
  readonly protocol: 'responses';
  readonly baseURL: string;
  readonly model: string;
  readonly apiKey: string;
  readonly allowLoopbackHttp: boolean;
  readonly redirect: 'error';
}

/** Reject credentials, query tokens, fragments, non-HTTP protocols and implicit plaintext transport. */
export function validateNativeBaseURL(value: string, allowLoopbackHttp: boolean): string {
  let url: URL;
  try {
    if (/[\s\\]/.test(value) || /:\/\/[^/]*@/.test(value)) throw new Error();
    url = new URL(value);
  } catch { throw new Error('服务地址格式无效，请填写不含账号、密码或令牌的完整地址。'); }
  if (url.username || url.password || url.search || url.hash) throw new Error('服务地址不能包含账号、密码、查询参数或片段；请通过独立凭据设置认证。');
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127\.(\d{1,3}\.){2}\d{1,3}$/.test(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback && allowLoopbackHttp)) {
    throw new Error('远程服务必须使用 HTTPS；本地回环 HTTP 需明确勾选允许。');
  }
  return url.toString().replace(/\/$/, '');
}

/** Connection metadata and OS-encrypted blobs live outside ordinary workspace state. */
export class ConnectionStore {
  private connections: StoredConnection[] = [];
  private loadError?: string;
  private readonly file: string;
  private readonly credentials: NativeCredentialStore;
  private readonly environment: NodeJS.ProcessEnv;

  constructor(dataDirectory: string, private readonly options: NativeConnectionStoreOptions = {}) {
    this.file = path.join(dataDirectory, 'native', 'connections.json');
    this.credentials = new NativeCredentialStore(options.safeStorage, options.platform);
    this.environment = options.environment ?? process.env;
    this.load();
  }

  list(): NativeConnectionList {
    return { connections: this.connections.map(item => this.view(item)), storage: this.credentials.protection(), ...(this.loadError ? { error: this.loadError } : {}) };
  }

  upsert(input: NativeConnectionInput): NativeConnectionView {
    this.assertLoaded();
    const parsed = nativeConnectionInputSchema.safeParse(input);
    if (!parsed.success) throw new Error('连接配置无效，请检查名称、地址、模型和认证方式。');
    const value = parsed.data;
    if (Boolean(value.id) !== Boolean(value.revision)) throw new Error('修改连接必须提供当前修订版，请刷新后重试。');
    const previous = value.id ? this.current(value.id, value.revision!) : undefined;
    if (previous) this.assertInactive(previous.id);
    else if (this.connections.length >= 100) throw new Error('连接数量已达上限。');
    const { id: suppliedId, revision: _revision, ...metadata } = value;
    const baseURL = validateNativeBaseURL(metadata.baseURL, metadata.allowLoopbackHttp);
    const item: StoredConnection = { ...metadata, baseURL, id: suppliedId ?? randomUUID(), revision: (previous?.revision ?? 0) + 1 };
    const sameAuth = previous?.auth.mode === item.auth.mode;
    if (sameAuth && item.auth.mode === 'encrypted' && previous?.ciphertext) item.ciphertext = previous.ciphertext;
    this.commit(previous ? this.connections.map(entry => entry.id === item.id ? item : entry) : [...this.connections, item]);
    if (!sameAuth) this.credentials.delete(item.id);
    return this.view(item);
  }

  setCredential(input: NativeCredentialMutation): NativeConnectionView {
    this.assertLoaded();
    const parsed = nativeCredentialMutationSchema.safeParse(input);
    if (!parsed.success) throw new Error('凭据设置无效，请重新输入。');
    const { id, revision, mode, secret } = parsed.data;
    const previous = this.current(id, revision);
    this.assertInactive(id);
    const item: StoredConnection = { ...previous, revision: previous.revision + 1, auth: { mode } };
    delete item.ciphertext;
    if (mode === 'encrypted') item.ciphertext = this.credentials.encrypt(secret);
    this.commit(this.connections.map(entry => entry.id === id ? item : entry));
    if (mode === 'memory') this.credentials.set(id, secret);
    else this.credentials.delete(id);
    return this.view(item);
  }

  remove(input: { id: string; revision: number }): void {
    this.assertLoaded();
    const parsed = nativeConnectionReferenceSchema.safeParse(input);
    if (!parsed.success) throw new Error('连接引用无效，请刷新后重试。');
    this.current(parsed.data.id, parsed.data.revision);
    this.assertInactive(parsed.data.id);
    if (this.options.isConnectionReferenced?.(parsed.data.id)) throw new Error('已有会话引用此连接；请先禁用连接或替换会话引用，再删除。');
    this.commit(this.connections.filter(entry => entry.id !== parsed.data.id));
    this.credentials.delete(parsed.data.id);
  }

  readiness(connectionId: string, modelOverride?: string): NativeConnectionReadiness {
    try {
      const resolved = this.resolve(connectionId, modelOverride);
      return { ready: true, connectionId: resolved.connectionId, revision: resolved.revision, model: resolved.model };
    } catch (error) { return { ready: false, error: error instanceof Error ? error.message : '连接不可用。' }; }
  }

  resolve(connectionId: string, modelOverride?: string): ResolvedNativeConnection {
    this.assertLoaded();
    const parsed = nativeConnectionReadinessSchema.safeParse({ id: connectionId, ...(modelOverride !== undefined ? { model: modelOverride } : {}) });
    if (!parsed.success) throw new Error('请选择有效的 native 模型连接和模型。');
    const item = this.current(connectionId);
    if (!item.enabled) throw new Error('此模型连接已禁用，请在设置中启用或选择其他连接。');
    const baseURL = validateNativeBaseURL(item.baseURL, item.allowLoopbackHttp);
    let apiKey: string | undefined;
    if (item.auth.mode === 'env') apiKey = this.environment[item.auth.variable];
    else if (item.auth.mode === 'memory') apiKey = this.credentials.get(item.id);
    else if (item.ciphertext) apiKey = this.credentials.decrypt(item.ciphertext);
    if (!apiKey) throw new Error(item.auth.mode === 'env' ? '主进程未找到此连接指定的环境变量，请设置后重启应用。' : '此连接尚无可用凭据，请重新设置（本次内存凭据不会跨重启保留）。');
    if (!nativeCredentialMutationSchema.shape.secret.safeParse(apiKey).success) throw new Error('此连接的凭据格式无效，请重新设置。');
    return Object.freeze({ connectionId: item.id, revision: item.revision, protocol: item.protocol, baseURL, model: parsed.data.model ?? item.model, apiKey, allowLoopbackHttp: item.allowLoopbackHttp, redirect: 'error' });
  }

  private current(connectionId: string, expectedRevision?: number): StoredConnection {
    const value = this.connections.find(item => item.id === connectionId);
    if (!value) throw new Error('模型连接不存在，请在设置中选择或创建连接。');
    if (expectedRevision !== undefined && value.revision !== expectedRevision) throw new Error('此连接已更新，请刷新后重试。');
    return value;
  }

  private view(item: StoredConnection): NativeConnectionView {
    const { ciphertext: _ciphertext, ...metadata } = item;
    const credentialConfigured = item.auth.mode === 'env' || (item.auth.mode === 'encrypted' ? Boolean(item.ciphertext) : Boolean(this.credentials.get(item.id)));
    const status = this.readiness(item.id);
    return { ...metadata, auth: { ...metadata.auth }, credentialConfigured, ready: status.ready, ...(status.error ? { error: status.error } : {}) };
  }

  private assertLoaded(): void { if (this.loadError) throw new Error(this.loadError); }
  private assertInactive(connectionId: string): void {
    if (this.options.isConnectionActive?.(connectionId)) throw new Error('此连接正被运行中的回合使用，请先停止相关回合并等待清理完成。');
  }

  private load(): void {
    try {
      let source: string;
      try {
        if (fs.statSync(this.file).size > 1024 * 1024) throw new Error();
        source = fs.readFileSync(this.file, 'utf8');
      } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      const parsed = diskSchema.parse(JSON.parse(source));
      const ids = new Set<string>();
      for (const item of parsed.connections) {
        if (ids.has(item.id) || (item.ciphertext && item.auth.mode !== 'encrypted')) throw new Error();
        ids.add(item.id);
        validateNativeBaseURL(item.baseURL, item.allowLoopbackHttp);
      }
      this.connections = parsed.connections;
    } catch { this.loadError = '模型连接文件损坏、版本不受支持或无法读取。已停止读写，请保留文件并修复后重启应用。'; }
  }

  private commit(next: StoredConnection[]): void {
    const directory = path.dirname(this.file), temporary = path.join(directory, `.connections-${randomUUID()}.tmp`);
    let fd: number | undefined;
    try {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      fd = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify({ schemaVersion: 1, connections: next }));
      fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      fs.renameSync(temporary, this.file);
      this.connections = next;
    } catch { throw new Error('模型连接保存失败，请检查磁盘空间和数据目录权限。'); }
    finally {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(temporary); } catch { /* A completed rename removes the temporary file. */ }
    }
  }
}
