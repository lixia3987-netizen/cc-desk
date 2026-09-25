/** The application's stable session ID is separate from a provider's conversation ID. */
export type ExecutionMode = 'structured' | 'terminal';
/** Persisted provider-owned configuration. Credentials must not be stored here. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export interface EngineConfig { schemaVersion: number; options: Record<string, JsonValue> }
export interface EngineConfigField {
  key: string;
  label: string;
  type: 'text' | 'select';
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

/** Providers own their conversation namespace; an absent identity never owns a conversation. */
export function sameConversation(a: SessionExecution, b: SessionExecution): boolean {
  return Boolean(a.conversationId && b.conversationId && a.providerId === b.providerId && a.conversationId === b.conversationId);
}

/** Public operations, independent of any CLI flags or transport protocol. */
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
  export?: boolean;
}
export interface ExecutionDescriptor {
  providerId: string;
  mode: ExecutionMode;
  displayName?: string;
  capabilities: ExecutionCapabilities;
  configuration?: EngineConfiguration;
  maintenance?: boolean;
  /** External history import is distinct from continuing a local session. */
  history?: boolean;
}

/** Only values reported by the provider are used; no model-name based window guesses. */
export interface ContextUsage {
  model?: string;
  /** Model selected when the turn starts; response routing names and report labels do not replace it. */
  requestModel?: string;
  /** Provider's selected model/alias, retained across process restarts. */
  selectionModel?: string;
  inputTokens?: number;
  contextWindow?: number;
  measuredAt?: string;
  source?: 'request' | 'context-command';
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

/** Resource lifecycle, separate from a turn's TaskState. */
export type SessionStatus = 'idle' | 'running' | 'stopping' | 'stopped' | 'error';
export interface TerminalChunk { sessionId: string; seq: number; data: string }
