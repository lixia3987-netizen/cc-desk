/** 应用的稳定会话 ID 与提供商的对话 ID 相互独立。 */
export type ExecutionMode = 'structured' | 'terminal';
/** 持久化的提供商配置，禁止在此存储凭据。 */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export interface EngineConfig { schemaVersion: number; options: Record<string, JsonValue> }
export interface EngineConfigField {
  key: string;
  label: string;
  type: 'text' | 'select' | 'number';
  min?: number;
  max?: number;
  /** 数字控件的显示单位对应多少存储单位；min/max 仍使用存储单位。 */
  numberScale?: number;
  options?: { value: string; label: string }[];
  placeholder?: string;
  description?: string;
  apply?: 'stopped' | 'live' | 'restart';
}
export interface EngineConfiguration {
  schemaVersion: number;
  defaults: EngineConfig;
  fields: EngineConfigField[];
}
export interface SessionExecution {
  providerId: string;
  mode: ExecutionMode;
  conversationId?: string;
  forkFrom?: string;
  imported?: boolean;
}
export interface SessionIdentity extends SessionExecution { sessionId: string }

export function getSessionIdentity(session: { id: string; execution: SessionExecution }): SessionIdentity {
  return { sessionId: session.id, ...session.execution };
}

/** 提供商管理各自的对话命名空间；缺失的身份绝不关联任何对话。 */
export function sameConversation(a: SessionExecution, b: SessionExecution): boolean {
  return Boolean(a.conversationId && b.conversationId && a.providerId === b.providerId && a.conversationId === b.conversationId);
}

/** 公共操作，与 CLI 参数或传输协议无关。 */
export interface ExecutionCapabilities {
  available: boolean;
  error?: string;
  structured: boolean;
  terminal: boolean;
  approvals: boolean;
  resume: boolean;
  fork: boolean;
  commands: boolean;
  contextUsage: boolean;
  liveConfig: boolean;
  attachments: boolean;
  recoverContext?: boolean;
  /** 显式摘要上下文，与重建空白对话相区分。 */
  compactContext?: boolean;
  export?: boolean;
}
export interface ExecutionDescriptor {
  providerId: string;
  mode: ExecutionMode;
  displayName?: string;
  capabilities: ExecutionCapabilities;
  configuration?: EngineConfiguration;
  maintenance?: boolean;
  /** 导入外部历史与继续本地会话是不同操作。 */
  history?: boolean;
}

export type ModelCapabilitySource = 'provider' | 'catalog' | 'fallback';
export interface ModelCapabilityValue<T> { value: T; source: ModelCapabilitySource }
/** 缺失的上限保持未知；各字段分别记录其来源。 */
export interface ModelTokenCapabilities {
  contextWindow?: ModelCapabilityValue<number>;
  maxInputTokens?: ModelCapabilityValue<number>;
  maxOutputTokens?: ModelCapabilityValue<number>;
}

/** 提供商测量值与本地预算相互独立，绝不猜测模型的上下文窗口。 */
export interface ContextUsage {
  model?: string;
  /** 交互轮次开始时选定的模型；响应路由名称及报告标签不会将其替换。 */
  requestModel?: string;
  /** 提供商选定的模型或别名，在进程重启后保留。 */
  selectionModel?: string;
  inputTokens?: number;
  /** 本回合各请求的已报告输入峰值；并非当前上下文或累计输入。 */
  peakInputTokens?: number;
  peakInputComplete?: boolean;
  /** 最后一次普通请求的提供方计数，原始值与归一化规则分开保留。 */
  requestUsage?: {
    inputTokens?: number; outputTokens?: number;
    nonCachedInputTokens?: number | null; cacheReadInputTokens?: number | null; cacheCreationInputTokens?: number | null;
    provider?: { raw: Record<string, number | null>; normalization: string };
  };
  /** 最后一次普通请求的脱敏诊断，只保留计量和来源，不含正文。 */
  requestDiagnostic?: {
    attempt: number; purpose: 'normal' | 'child' | 'retry'; phase: 'started' | 'request' | 'dispatched' | 'finished';
    requestSent: boolean | null; contextBytes: number; payloadBytes?: number; elapsedMs?: number;
    estimatedInputTokens: number | null;
    estimateMethod: 'utf8_bytes' | 'tokenizer' | 'calibrated' | 'unknown';
    estimateSource: 'fallback' | 'tokenizer' | 'calibration' | 'unknown';
    components: Partial<Record<'systemPrompt' | 'permissions' | 'projectRules' | 'skills' | 'instructions' | 'tools' | 'userInput' | 'history' | 'toolResults' | 'reasoning' | 'continuation' | 'images' | 'transport', { bytes: number; accounting: 'serialized' | 'logical'; count?: number }>>;
  };
  contextWindow?: number;
  measuredAt?: string;
  source?: 'request' | 'context-command';
  modelCapabilities?: { model: string; capabilities: ModelTokenCapabilities; resolvedAt?: string; conservative?: boolean };
  /** 请求前的本地上限，既不是提供商测量值，也不是模型的上下文窗口。 */
  budget?: {
    estimatedInputTokens: number;
    maxInputTokens: number;
    contextBytes: number;
    maxContextBytes: number;
    estimator: 'utf8_bytes';
    status: 'within_budget' | 'near_limit' | 'exceeded';
  };
  status: 'unknown' | 'ready' | 'compacting' | 'compacted';
  lastCompaction?: { at: string; trigger?: 'manual' | 'auto'; preTokens?: number };
}

export interface SessionCommand {
  name: string;
  description: string;
  argumentHint: string;
  aliases: string[];
  kind: 'builtin' | 'skill' | 'command';
  disabledReason?: string;
}

/** 资源生命周期，与交互轮次的 TaskState 相互独立。 */
export type SessionStatus = 'idle' | 'running' | 'stopping' | 'stopped' | 'error';
export interface TerminalChunk { sessionId: string; seq: number; data: string }
