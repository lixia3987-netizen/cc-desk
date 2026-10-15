import type { NativeModelPricing } from './native-cost';
import type { ModelTokenCapabilities } from '@cc-desk/contracts/execution';
export type NativeModelCapabilities = ModelTokenCapabilities;
export interface NativeModelCapabilityInput { id: string; revision: number; model?: string }
export interface NativeModelCapabilitySnapshot {
  connectionId: string;
  revision: number;
  model: string;
  capabilities: NativeModelCapabilities;
  resolvedAt: string;
  expiresAt: string;
  code: NativeConnectionModelListCode;
  conservative?: boolean;
}
export interface NativeModelMetadata { id: string; name?: string; capabilities?: NativeModelCapabilities }
/** 仅引用与连接元数据可跨越渲染进程边界。 */
export type NativeConnectionAuth = { mode: 'env'; variable: string } | { mode: 'memory' } | { mode: 'encrypted' };
export interface NativeConnection {
  id: string;
  revision: number;
  name: string;
  protocol: 'responses' | 'chat-completions' | 'anthropic';
  authHeader?: 'x-api-key' | 'authorization';
  baseURL: string;
  model: string;
  allowLoopbackHttp: boolean;
  enabled: boolean;
  auth: NativeConnectionAuth;
  pricing?: NativeModelPricing;
}
export interface NativeConnectionInput extends Omit<NativeConnection, 'id' | 'revision'> { id?: string; revision?: number }
export interface NativeConnectionView extends NativeConnection { credentialConfigured: boolean; ready: boolean; error?: string }
export interface NativeConnectionReadiness { ready: boolean; error?: string; connectionId?: string; revision?: number; model?: string }
export interface NativeConnectionList {
  connections: NativeConnectionView[];
  storage: { persistentAvailable: boolean; reason?: string };
  error?: string;
}
/** 密钥仅由一次变更操作接收，且不会返回。 */
export interface NativeCredentialMutation { id: string; revision: number; mode: 'memory' | 'encrypted'; secret: string }
export interface NativeConnectionTestInput { id: string; revision: number; requestId: string }
export type NativeConnectionTestCode = 'ok' | 'configuration' | 'busy' | 'cancelled' | 'timeout' | 'authentication' | 'permission' | 'endpoint' | 'rate_limit' | 'service' | 'http' | 'redirect' | 'protocol' | 'incomplete' | 'refused' | 'unexpected_tool' | 'credential_echo' | 'transport' | 'response_limit';
/** 仅本地构造的状态字段可通过 IPC，不传递提供方文本或异常。 */
export interface NativeConnectionTestResult {
  requestId: string;
  code: NativeConnectionTestCode;
  durationMs: number;
  httpStatus?: number;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  estimatedCostUSD?: number;
}
export interface NativeConnectionModelListInput { id: string; revision: number; requestId: string }
export type NativeConnectionModelListCode = 'ok' | 'configuration' | 'busy' | 'cancelled' | 'timeout' | 'authentication' | 'permission' | 'endpoint' | 'rate_limit' | 'service' | 'http' | 'redirect' | 'protocol' | 'credential_echo' | 'transport' | 'response_limit';
/** 仅已校验的模型元数据通过 IPC，结果始终与已保存的连接修订版绑定。 */
export interface NativeConnectionModelListResult {
  requestId: string;
  connectionId: string;
  revision: number;
  code: NativeConnectionModelListCode;
  models?: NativeModelMetadata[];
  durationMs: number;
  httpStatus?: number;
}
export interface NativeConnectionsAPI {
  list(): Promise<NativeConnectionList>;
  upsert(input: NativeConnectionInput): Promise<NativeConnectionView>;
  remove(input: { id: string; revision: number }): Promise<void>;
  setCredential(input: NativeCredentialMutation): Promise<NativeConnectionView>;
  readiness(input: { id: string; model?: string }): Promise<NativeConnectionReadiness>;
  test(input: NativeConnectionTestInput): Promise<NativeConnectionTestResult>;
  cancelTest(input: { requestId: string }): Promise<void>;
  listModels(input: NativeConnectionModelListInput): Promise<NativeConnectionModelListResult>;
  cancelListModels(input: { requestId: string }): Promise<void>;
  modelCapabilities(input: NativeModelCapabilityInput): Promise<NativeModelCapabilitySnapshot>;
}
