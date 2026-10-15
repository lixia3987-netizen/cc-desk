import fs from 'node:fs/promises';
import type { JsonObject } from '@cc-desk/agent-core';
import type { ResolvedNativeMcpConnection } from './mcp-connections';

/** 只有命令元数据和环境引用可以进入审批或存储。 */
export async function mcpStartupMetadata(connections: ResolvedNativeMcpConnection[], cwd: string): Promise<JsonObject> {
  const servers: JsonObject[] = [];
  for (const connection of connections) {
    if (connection.transport !== 'stdio') continue;
    const realPath = await fs.realpath(connection.executable);
    const stat = await fs.stat(realPath, { bigint: true });
    if (!stat.isFile()) throw new Error('MCP 本地服务必须指向已安装的可执行文件。');
    servers.push({
      connectionId: connection.connectionId, revision: connection.revision, name: connection.name,
      transport: 'stdio', protocolVersion: '2025-11-25', executable: connection.executable, argv: [...connection.argv],
      environmentSources: Object.entries(connection.environmentSources).sort(([a], [b]) => a.localeCompare(b)).map(([variable, source]) => ({ variable, source })),
      executableIdentity: { realPath, device: String(stat.dev), inode: String(stat.ino), size: String(stat.size), modified: String(stat.mtimeNs), changed: String(stat.ctimeNs) },
    });
  }
  return { cwd, servers };
}

/** 解析后的环境值不得进入模型请求或持久化运行配置。 */
export function mcpConnectionMetadata(connection: ResolvedNativeMcpConnection): JsonObject {
  const shared = { connectionId: connection.connectionId, revision: connection.revision, name: connection.name,
    transport: connection.transport, protocolVersion: connection.protocolVersion };
  return connection.transport === 'stdio'
    ? { ...shared, executable: connection.executable, argv: [...connection.argv],
      environmentSources: Object.entries(connection.environmentSources).sort(([a], [b]) => a.localeCompare(b)).map(([variable, source]) => ({ variable, source })) }
    : { ...shared, endpoint: connection.endpoint };
}
