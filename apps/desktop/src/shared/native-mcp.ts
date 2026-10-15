/** 可安全公开 MCP 元数据，解析后的 bearer token 和环境变量值保留在主进程。 */
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
  /** 参数按字面量传递，不经 shell 解释；不要在此处放置凭据。 */
  argv: string[];
  /** 子进程变量名映射到主进程变量名，此处不保存变量值。 */
  environment: Record<string, string>;
  auth: { mode: 'none' };
}
export type NativeMcpConnection = NativeMcpHttpConnection | NativeMcpStdioConnection;
type InputIdentity = { id?: string; revision?: number };
export type NativeMcpHttpConnectionInput = Omit<NativeMcpHttpConnection, 'id' | 'revision' | 'transport' | 'protocolVersion'> & InputIdentity & {
  /** 旧版元数据写入方未提供这些字段，应保留其 HTTP/2026 行为。 */
  transport?: 'http';
  protocolVersion?: NativeMcpProtocolVersion;
};
export type NativeMcpStdioConnectionInput = Omit<NativeMcpStdioConnection, 'id' | 'revision' | 'protocolVersion'> & InputIdentity & {
  protocolVersion?: '2025-11-25';
};
export type NativeMcpConnectionInput = NativeMcpHttpConnectionInput | NativeMcpStdioConnectionInput;
export type NativeMcpConnectionView = NativeMcpConnection & {
  /** 明确无需认证的连接也返回 true。 */
  credentialConfigured: boolean;
  /** 仅表示配置就绪，不会连接或启动 MCP 服务器。 */
  ready: boolean;
  error?: string;
};
export interface NativeMcpConnectionList {
  connections: NativeMcpConnectionView[];
  storage: { persistentAvailable: boolean; reason?: string };
  error?: string;
}
/** 仅针对 HTTP 的 token 变更操作，响应中不包含 token。 */
export interface NativeMcpCredentialMutation { id: string; revision: number; mode: 'memory' | 'encrypted'; secret: string }
export interface NativeMcpConnectionsAPI {
  list(): Promise<NativeMcpConnectionList>;
  upsert(input: NativeMcpConnectionInput): Promise<NativeMcpConnectionView>;
  remove(input: { id: string; revision: number }): Promise<void>;
  setCredential(input: NativeMcpCredentialMutation): Promise<NativeMcpConnectionView>;
}
