/** The application's stable session ID is separate from a provider's conversation ID. */
export type ExecutionMode = 'structured' | 'terminal';
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
}
export interface ExecutionDescriptor {
  providerId: string;
  mode: ExecutionMode;
  capabilities: ExecutionCapabilities;
}

/** Only values reported by the provider are used; no model-name based window guesses. */
export interface ContextUsage {
  model?: string;
  /** Model identity from actual root requests; a /context display label is not an identity. */
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
