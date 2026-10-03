import { assertNoModelCredential } from '@cc-desk/agent-node/responses-model';
import type { NativeModelCapabilities, NativeModelCapabilityInput, NativeModelCapabilitySnapshot } from '../../../shared/native-connections';
import { nativeConnectionReadinessSchema, nativeConnectionReferenceSchema, type ConnectionStore, type ResolvedNativeConnection } from './connections';
import { NativeConnectionModelCatalog } from './connection-models';
import { readNativeModelMetadata } from './model-metadata';
import { localNativeModelCapabilities } from './local-model-capabilities';

export const nativeModelCapabilitySchema = nativeConnectionReferenceSchema.extend({ model: nativeConnectionReadinessSchema.shape.model }).strict();
type Binding = Pick<ResolvedNativeConnection, 'connectionId' | 'revision' | 'model'>;
interface Pending { controller: AbortController; promise: Promise<NativeModelCapabilitySnapshot> }
const keys = ['contextWindow', 'maxInputTokens', 'maxOutputTokens'] as const;
const cacheKey = (binding: Binding): string => JSON.stringify([binding.connectionId, binding.revision, binding.model]);
function immutable(snapshot: NativeModelCapabilitySnapshot): NativeModelCapabilitySnapshot {
  for (const key of keys) if (snapshot.capabilities[key]) Object.freeze(snapshot.capabilities[key]);
  Object.freeze(snapshot.capabilities); return Object.freeze(snapshot);
}
/** Per-field precedence; partial provider metadata cannot erase another source's known fields. */
export function mergeNativeModelCapabilities(provider: NativeModelCapabilities | undefined, catalog: NativeModelCapabilities | undefined, fallback: NativeModelCapabilities): NativeModelCapabilities {
  const result: NativeModelCapabilities = {};
  for (const key of keys) { const selected = provider?.[key] ?? catalog?.[key] ?? fallback[key]; if (selected) result[key] = { ...selected }; }
  return result;
}

/** Main-only bounded metadata reads. No readiness/mutation lock, generation request or workspace write. */
export class NativeModelCapabilityService {
  private readonly cache = new Map<string, NativeModelCapabilitySnapshot>();
  private readonly pending = new Map<string, Pending>();
  private closing = false;
  constructor(private readonly connections: ConnectionStore, private readonly catalog: NativeConnectionModelCatalog, private readonly options: { timeoutMs?: number; now?(): number; onChanged?(): void } = {}) {}
  peek(binding: Binding): NativeModelCapabilitySnapshot | undefined {
    const found = this.cache.get(cacheKey(binding));
    return found && Date.parse(found.expiresAt) > this.now() ? found : undefined;
  }
  async resolveReference(input: NativeModelCapabilityInput): Promise<NativeModelCapabilitySnapshot> {
    const parsed = nativeModelCapabilitySchema.safeParse(input);
    if (!parsed.success) throw new Error('读取模型能力请求格式无效。');
    let connection: ResolvedNativeConnection;
    try { connection = this.connections.resolve(parsed.data.id, parsed.data.model); if (connection.revision !== parsed.data.revision) throw new Error(); }
    catch { throw new Error('模型连接已更新或不可用，请刷新后重试。'); }
    return this.resolve(connection);
  }
  resolve(connection: ResolvedNativeConnection, options: { timeoutMs?: number } = {}): Promise<NativeModelCapabilitySnapshot> {
    try { assertNoModelCredential(connection.model, connection.apiKey); } catch { throw new Error('模型能力绑定无效。'); }
    const cached = this.peek(connection); if (cached) return Promise.resolve(cached);
    const key = cacheKey(connection), pending = this.pending.get(key); if (pending) return pending.promise;
    const fallback = localNativeModelCapabilities(connection);
    if (this.closing || this.pending.size >= 4) return Promise.resolve(this.snapshot(connection, fallback.capabilities, this.closing ? 'cancelled' : 'busy', fallback.conservative));
    const entry: Pending = { controller: new AbortController(), promise: Promise.resolve(this.snapshot(connection, {}, 'busy')) };
    this.pending.set(key, entry);
    entry.promise = this.read(connection, entry.controller, options.timeoutMs ?? this.options.timeoutMs ?? 3000).then(snapshot => {
      if (snapshot.code !== 'cancelled' && snapshot.code !== 'configuration' && this.current(connection)) {
        this.cache.set(key, snapshot); while (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value!);
        try { this.options.onChanged?.(); } catch { /* Notifications cannot change safe metadata. */ }
      }
      return snapshot;
    }).finally(() => { if (this.pending.get(key) === entry) this.pending.delete(key); });
    return entry.promise;
  }
  cancelAll(): void { for (const pending of this.pending.values()) pending.controller.abort(); }
  async shutdown(): Promise<void> { this.closing = true; this.cancelAll(); await Promise.all([...this.pending.values()].map(item => item.promise)); this.cache.clear(); }
  resumeAfterFailedShutdown(): void { this.closing = false; }
  private now(): number { return this.options.now?.() ?? Date.now(); }
  private current(connection: Binding): boolean {
    const current = this.connections.list().connections.find(item => item.id === connection.connectionId);
    return !!current && current.enabled && current.revision === connection.revision;
  }
  private snapshot(connection: Binding, capabilities: NativeModelCapabilities, code: NativeModelCapabilitySnapshot['code'], conservative?: boolean): NativeModelCapabilitySnapshot {
    const now = this.now();
    return immutable({ connectionId: connection.connectionId, revision: connection.revision, model: connection.model, capabilities,
      resolvedAt: new Date(now).toISOString(), expiresAt: new Date(now + (code === 'ok' ? 300_000 : 30_000)).toISOString(), code, ...(conservative ? { conservative: true } : {}) });
  }
  private async read(connection: ResolvedNativeConnection, controller: AbortController, timeoutMs: number): Promise<NativeModelCapabilitySnapshot> {
    const fallback = localNativeModelCapabilities(connection), started = performance.now();
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000) return this.snapshot(connection, fallback.capabilities, 'configuration', fallback.conservative);
    const remaining = () => Math.max(1, Math.floor(timeoutMs - (performance.now() - started)));
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const detail = await readNativeModelMetadata(connection, { kind: 'detail', signal: controller.signal, timeoutMs: remaining() });
      let provider = detail.code === 'ok' ? detail.models?.find(item => item.id === connection.model)?.capabilities : undefined;
      let catalog = this.catalog.peek(connection)?.find(item => item.id === connection.model)?.capabilities;
      let code = detail.code;
      if (!keys.every(key => provider?.[key] !== undefined) && !catalog && !controller.signal.aborted
        && !['authentication', 'permission', 'credential_echo', 'redirect', 'cancelled', 'timeout', 'rate_limit'].includes(detail.code)) {
        const listed = await this.catalog.read(connection, { signal: controller.signal, timeoutMs: remaining() });
        catalog = listed.code === 'ok' ? listed.models?.find(item => item.id === connection.model)?.capabilities : undefined;
        code = listed.code;
        if (listed.code === 'credential_echo') provider = undefined;
      }
      if (!this.current(connection)) return this.snapshot(connection, {}, 'configuration');
      const capabilities = mergeNativeModelCapabilities(provider, catalog, fallback.capabilities);
      const conservative = fallback.conservative && keys.some(key => capabilities[key]?.source === 'fallback');
      if (controller.signal.aborted) return this.snapshot(connection, capabilities, performance.now() - started >= timeoutMs ? 'timeout' : 'cancelled', conservative);
      return this.snapshot(connection, capabilities, code, conservative);
    } finally { clearTimeout(timer); }
  }
}
