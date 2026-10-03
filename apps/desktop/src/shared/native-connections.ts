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
/** Only references and connection metadata may cross the renderer boundary. */
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
/** The secret is accepted by one mutation only and is never returned. */
export interface NativeCredentialMutation { id: string; revision: number; mode: 'memory' | 'encrypted'; secret: string }
export interface NativeConnectionTestInput { id: string; revision: number; requestId: string }
export type NativeConnectionTestCode = 'ok' | 'configuration' | 'busy' | 'cancelled' | 'timeout' | 'authentication' | 'permission' | 'endpoint' | 'rate_limit' | 'service' | 'http' | 'redirect' | 'protocol' | 'incomplete' | 'refused' | 'unexpected_tool' | 'credential_echo' | 'transport' | 'response_limit';
/** Only locally constructed status fields cross IPC; never provider text or an exception. */
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
/** Only validated model metadata crosses IPC; results remain tied to the saved connection revision. */
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
