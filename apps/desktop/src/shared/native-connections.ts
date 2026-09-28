/** Only references and connection metadata may cross the renderer boundary. */
export type NativeConnectionAuth = { mode: 'env'; variable: string } | { mode: 'memory' } | { mode: 'encrypted' };
export interface NativeConnection {
  id: string;
  revision: number;
  name: string;
  protocol: 'responses';
  baseURL: string;
  model: string;
  allowLoopbackHttp: boolean;
  enabled: boolean;
  auth: NativeConnectionAuth;
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
export interface NativeConnectionsAPI {
  list(): Promise<NativeConnectionList>;
  upsert(input: NativeConnectionInput): Promise<NativeConnectionView>;
  remove(input: { id: string; revision: number }): Promise<void>;
  setCredential(input: NativeCredentialMutation): Promise<NativeConnectionView>;
  readiness(input: { id: string; model?: string }): Promise<NativeConnectionReadiness>;
}
