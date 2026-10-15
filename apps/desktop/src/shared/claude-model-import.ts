import type { NativeConnectionView } from './native-connections';

export interface ClaudeModelImportChoice {
  model: string;
  sources: string[];
  /** 未配置具体模型映射的 Claude 别名不能发送到原生 API。 */
  nativeImportable: boolean;
}

/** 仅包含元数据，凭据与文件内容不会跨越渲染进程边界。 */
export interface ClaudeModelImportPreview {
  token: string;
  expiresAt: string;
  sourcePath: string;
  baseURL: string;
  requiresLoopbackHttp?: boolean;
  model?: string;
  modelSource?: string;
  models: ClaudeModelImportChoice[];
  credential: { configured: boolean; source?: 'ANTHROPIC_AUTH_TOKEN' | 'ANTHROPIC_API_KEY' };
  warnings: string[];
}

export interface ClaudeModelImportInput {
  token: string;
  credentialMode?: 'memory' | 'encrypted';
  /** 只能选择此预览中展示的模型。 */
  model?: string;
  allowLoopbackHttp?: boolean;
}

export interface ClaudeModelImportResult {
  connection: NativeConnectionView;
  model?: string;
  notice?: string;
}

export interface ClaudeModelImportAPI {
  preview(input: { source: 'default' | 'file' }): Promise<ClaudeModelImportPreview | null>;
  import(input: ClaudeModelImportInput): Promise<ClaudeModelImportResult>;
}
