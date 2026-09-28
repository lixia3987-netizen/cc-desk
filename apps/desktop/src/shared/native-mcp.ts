/** MCP metadata is safe to expose; resolved bearer tokens and environment values stay in main. */
export type NativeMcpProtocolVersion = '2026-07-28' | '2025-11-25';
export type NativeMcpConnectionAuth = { mode: 'none' } | { mode: 'env'; variable: string } | { mode: 'memory' } | { mode: 'encrypted' };
interface NativeMcpConnectionBase {
  id: string;
  revision: number;
  name: string;
  enabled: boolean;
}
export interface NativeMcpHttpConnection extends NativeMcpConnectionBase {
  transport: 'http';
  endpoint: string;
  protocolVersion: NativeMcpProtocolVersion;
  allowLoopbackHttp: boolean;
  auth: NativeMcpConnectionAuth;
}
export interface NativeMcpStdioConnection extends NativeMcpConnectionBase {
  transport: 'stdio';
  protocolVersion: '2025-11-25';
  executable: string;
  /** Literal arguments, never interpreted by a shell. Do not place credentials here. */
  argv: string[];
  /** Child variable name -> main process variable name. Values are never stored here. */
  environment: Record<string, string>;
  auth: { mode: 'none' };
}
export type NativeMcpConnection = NativeMcpHttpConnection | NativeMcpStdioConnection;
type InputIdentity = { id?: string; revision?: number };
export type NativeMcpHttpConnectionInput = Omit<NativeMcpHttpConnection, 'id' | 'revision' | 'transport' | 'protocolVersion'> & InputIdentity & {
  /** Older metadata writers omit these fields; their HTTP/2026 behavior is preserved. */
  transport?: 'http';
  protocolVersion?: NativeMcpProtocolVersion;
};
export type NativeMcpStdioConnectionInput = Omit<NativeMcpStdioConnection, 'id' | 'revision' | 'protocolVersion'> & InputIdentity & {
  protocolVersion?: '2025-11-25';
};
export type NativeMcpConnectionInput = NativeMcpHttpConnectionInput | NativeMcpStdioConnectionInput;
export type NativeMcpConnectionView = NativeMcpConnection & {
  /** Also true for an explicitly unauthenticated connection. */
  credentialConfigured: boolean;
  /** Configuration readiness only; does not connect to or start an MCP server. */
  ready: boolean;
  error?: string;
};
export interface NativeMcpConnectionList {
  connections: NativeMcpConnectionView[];
  storage: { persistentAvailable: boolean; reason?: string };
  error?: string;
}
/** HTTP-only token mutation; its response never contains the token. */
export interface NativeMcpCredentialMutation { id: string; revision: number; mode: 'memory' | 'encrypted'; secret: string }
export interface NativeMcpConnectionsAPI {
  list(): Promise<NativeMcpConnectionList>;
  upsert(input: NativeMcpConnectionInput): Promise<NativeMcpConnectionView>;
  remove(input: { id: string; revision: number }): Promise<void>;
  setCredential(input: NativeMcpCredentialMutation): Promise<NativeMcpConnectionView>;
}
