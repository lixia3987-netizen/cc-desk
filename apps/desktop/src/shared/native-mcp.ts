/** MCP connection metadata is safe to expose; bearer tokens stay in the main process. */
export type NativeMcpProtocolVersion = '2026-07-28' | '2025-11-25';
export type NativeMcpConnectionAuth = { mode: 'none' } | { mode: 'env'; variable: string } | { mode: 'memory' } | { mode: 'encrypted' };
export interface NativeMcpConnection {
  id: string;
  revision: number;
  name: string;
  endpoint: string;
  protocolVersion: NativeMcpProtocolVersion;
  allowLoopbackHttp: boolean;
  enabled: boolean;
  auth: NativeMcpConnectionAuth;
}
export interface NativeMcpConnectionInput extends Omit<NativeMcpConnection, 'id' | 'revision' | 'protocolVersion'> {
  id?: string;
  revision?: number;
  /** Omitted by older metadata writers; keeps their existing 2026 behavior. */
  protocolVersion?: NativeMcpProtocolVersion;
}
export interface NativeMcpConnectionView extends NativeMcpConnection {
  /** Also true for an explicitly unauthenticated connection. */
  credentialConfigured: boolean;
  ready: boolean;
  error?: string;
}
export interface NativeMcpConnectionList {
  connections: NativeMcpConnectionView[];
  storage: { persistentAvailable: boolean; reason?: string };
  error?: string;
}
/** This is the only operation that accepts a token; its response never contains the token. */
export interface NativeMcpCredentialMutation { id: string; revision: number; mode: 'memory' | 'encrypted'; secret: string }
export interface NativeMcpConnectionsAPI {
  list(): Promise<NativeMcpConnectionList>;
  upsert(input: NativeMcpConnectionInput): Promise<NativeMcpConnectionView>;
  remove(input: { id: string; revision: number }): Promise<void>;
  setCredential(input: NativeMcpCredentialMutation): Promise<NativeMcpConnectionView>;
}
