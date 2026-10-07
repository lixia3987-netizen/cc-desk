import type { ModelFailureDiagnostic } from './types.js'

const categories = new Set<ModelFailureDiagnostic['category']>([
  'authentication', 'configuration', 'rate_limit', 'service_unavailable', 'service_error',
  'protocol', 'network', 'timeout', 'security', 'unknown',
])
const protocols = new Set<ModelFailureDiagnostic['protocol']>(['openai-responses', 'openai-chat-completions', 'anthropic-messages'])
const stages = new Set<ModelFailureDiagnostic['stage']>(['request', 'response_headers', 'message_start', 'content', 'thinking', 'tool_call', 'completion'])
const reasons = new Set<ModelFailureDiagnostic['reason']>([
  'protocol_mismatch', 'invalid_history', 'pending_tool_calls', 'invalid_json', 'invalid_event', 'invalid_sequence',
  'unsupported_event', 'unsupported_content', 'invalid_thinking', 'invalid_tool_call', 'invalid_usage',
  'missing_terminal', 'truncated_event', 'stream_disconnected', 'unexpected_content_type', 'incomplete_response', 'response_limit',
])

/** Closed diagnostic boundary shared by the core, host and durable journal. */
export function validateModelFailureDiagnostic(value: unknown): value is ModelFailureDiagnostic {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  if (Object.keys(item).some(key => !['category', 'httpStatus', 'retryable', 'protocol', 'stage', 'reason'].includes(key)) ||
    !categories.has(item.category as ModelFailureDiagnostic['category']) || typeof item.retryable !== 'boolean') return false
  if (item.protocol !== undefined && !protocols.has(item.protocol as ModelFailureDiagnostic['protocol']) ||
      item.stage !== undefined && !stages.has(item.stage as ModelFailureDiagnostic['stage']) ||
      item.reason !== undefined && !reasons.has(item.reason as ModelFailureDiagnostic['reason'])) return false
  const status = item.httpStatus
  if (status === undefined) return item.retryable === false
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 300 || status > 599) return false
  const expected = status === 401 || status === 403 ? 'authentication' : status === 429 ? 'rate_limit' :
    [502, 503, 504].includes(status) ? 'service_unavailable' : status >= 500 ? 'service_error' : status >= 400 ? 'configuration' : 'protocol'
  return item.category === expected && (!item.retryable || [429, 502, 503, 504].includes(status))
}
