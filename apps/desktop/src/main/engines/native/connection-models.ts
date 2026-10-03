import type { NativeConnectionModelListCode, NativeConnectionModelListInput, NativeConnectionModelListResult, NativeModelMetadata } from '../../../shared/native-connections';
import { nativeConnectionTestCancelSchema, nativeConnectionTestSchema } from './connection-diagnostics';
import type { ConnectionStore, ResolvedNativeConnection } from './connections';
import { readNativeModelMetadata, type NativeMetadataResult } from './model-metadata';

export const nativeConnectionModelListSchema = nativeConnectionTestSchema;
export const nativeConnectionModelListCancelSchema = nativeConnectionTestCancelSchema;
interface ModelListRequest {
  input: NativeConnectionModelListInput;
  controller: AbortController;
  promise: Promise<NativeConnectionModelListResult>;
}
interface CachedCatalog { connectionId: string; revision: number; expiresAt: number; models: NativeModelMetadata[] }

/** Explicit discovery holds a connection lock; automatic metadata reads use the same safe transport without a lock. */
export class NativeConnectionModelCatalog {
  private active?: ModelListRequest;
  private readonly recent = new Map<string, ModelListRequest>();
  private readonly cached = new Map<string, CachedCatalog>();
  private closing = false;
  constructor(private readonly connections: ConnectionStore, private readonly options: {
    onChanged?(): void;
    /** Internal test seam; renderer input cannot change transport limits. */
    timeoutMs?: number;
  } = {}) {}
  isConnectionListing(id: string): boolean { return this.active?.input.id === id; }
  peek(connection: Pick<ResolvedNativeConnection, 'connectionId' | 'revision'>): NativeModelMetadata[] | undefined {
    const found = this.cached.get(connection.connectionId);
    return found && found.revision === connection.revision && found.expiresAt > Date.now() ? structuredClone(found.models) : undefined;
  }
  /** Main-only automatic GET. The caller owns its short timeout, cancellation and revision validation. */
  async read(connection: ResolvedNativeConnection, options: { signal: AbortSignal; timeoutMs: number }): Promise<NativeMetadataResult> {
    if (this.closing) return { code: 'cancelled', durationMs: 0 };
    const result = await readNativeModelMetadata(connection, { ...options, kind: 'list' });
    this.remember(connection, result);
    return result;
  }

  list(input: NativeConnectionModelListInput): Promise<NativeConnectionModelListResult> {
    const parsed = nativeConnectionModelListSchema.safeParse(input);
    if (!parsed.success) throw new Error('读取模型列表请求格式无效。');
    const value = parsed.data;
    const result = (code: NativeConnectionModelListCode): Promise<NativeConnectionModelListResult> => Promise.resolve({ requestId: value.requestId, connectionId: value.id, revision: value.revision, code, durationMs: 0 });
    if (this.closing) return result('cancelled');
    const previous = this.recent.get(value.requestId);
    if (previous) return previous.input.id === value.id && previous.input.revision === value.revision ? previous.promise : result('configuration');
    if (this.active) return result('busy');
    let connection: ResolvedNativeConnection;
    try { connection = this.connections.resolveForDiagnostic({ id: value.id, revision: value.revision }); }
    catch { return result('configuration'); }
    const entry: ModelListRequest = { input: value, controller: new AbortController(), promise: result('busy') };
    this.active = entry;
    entry.promise = Promise.resolve().then(async () => {
      const metadata = await readNativeModelMetadata(connection, { signal: entry.controller.signal, timeoutMs: this.options.timeoutMs, kind: 'list' });
      this.remember(connection, metadata);
      return { requestId: value.requestId, connectionId: value.id, revision: value.revision, ...metadata };
    }).finally(() => {
      if (this.active === entry) this.active = undefined;
      this.changed();
    });
    this.recent.set(value.requestId, entry);
    while (this.recent.size > 32) this.recent.delete(this.recent.keys().next().value!);
    this.changed();
    return entry.promise;
  }

  cancel(input: { requestId: string }): void {
    const parsed = nativeConnectionModelListCancelSchema.safeParse(input);
    if (!parsed.success) throw new Error('取消模型列表请求格式无效。');
    if (this.active?.input.requestId === parsed.data.requestId) this.active.controller.abort();
  }
  cancelAll(): void { this.active?.controller.abort(); }
  async shutdown(): Promise<void> { this.closing = true; this.cancelAll(); await this.active?.promise; this.recent.clear(); this.cached.clear(); }
  resumeAfterFailedShutdown(): void { this.closing = false; }
  private changed(): void { try { this.options.onChanged?.(); } catch { /* Notifications cannot alter a read-only result or its lock cleanup. */ } }
  private remember(connection: ResolvedNativeConnection, result: NativeMetadataResult): void {
    if (result.code !== 'ok' || !result.models) return;
    const current = this.connections.list().connections.find(item => item.id === connection.connectionId);
    if (!current || current.revision !== connection.revision) return;
    this.cached.set(connection.connectionId, { connectionId: connection.connectionId, revision: connection.revision, models: structuredClone(result.models), expiresAt: Date.now() + 300_000 });
    while (this.cached.size > 100) this.cached.delete(this.cached.keys().next().value!);
  }
}
