import type { NativeConnectionView } from './native-connections';

export interface ClaudeModelImportChoice {
  model: string;
  sources: string[];
  /** Claude aliases without a configured concrete mapping cannot be sent to the native API. */
  nativeImportable: boolean;
}

/** Metadata only. Credentials and file contents never cross the renderer boundary. */
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
  /** Only a model shown in this preview may be selected. */
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
