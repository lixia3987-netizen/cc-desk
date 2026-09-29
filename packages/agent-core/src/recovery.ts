import type { ModelFailureDiagnostic } from './types.js'

const categories = new Set<ModelFailureDiagnostic['category']>([
  'authentication', 'configuration', 'rate_limit', 'service_unavailable', 'service_error',
  'protocol', 'network', 'timeout', 'security', 'unknown',
])

/** Closed diagnostic boundary shared by the core, host and durable journal. */
export function validateModelFailureDiagnostic(value: unknown): value is ModelFailureDiagnostic {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  if (Object.keys(item).some(key => !['category', 'httpStatus', 'retryable'].includes(key)) ||
    !categories.has(item.category as ModelFailureDiagnostic['category']) || typeof item.retryable !== 'boolean') return false
  const status = item.httpStatus
  if (status === undefined) return item.retryable === false
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 300 || status > 599) return false
  const expected = status === 401 || status === 403 ? 'authentication' : status === 429 ? 'rate_limit' :
    [502, 503, 504].includes(status) ? 'service_unavailable' : status >= 500 ? 'service_error' : status >= 400 ? 'configuration' : 'protocol'
  return item.category === expected && (!item.retryable || [429, 502, 503, 504].includes(status))
}
