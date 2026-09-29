import type { ModelFailureDiagnostic } from '@cc-desk/agent-core'

/** Only adapter-owned codes and numeric HTTP status enter a persisted diagnostic. */
export function classifyNativeModelFailure(code: string, httpStatus?: number, rejectedBeforeStream = false): ModelFailureDiagnostic {
  if ((code === 'http' || code === 'redirect') && typeof httpStatus === 'number' && Number.isInteger(httpStatus) && httpStatus >= 300 && httpStatus <= 599) {
    const status = httpStatus
    const category = status === 401 || status === 403 ? 'authentication'
      : status === 429 ? 'rate_limit'
      : status === 502 || status === 503 || status === 504 ? 'service_unavailable'
      : status >= 500 ? 'service_error'
      : status >= 400 ? 'configuration' : 'protocol'
    return { category, httpStatus: status, retryable: rejectedBeforeStream && (status === 429 || status === 502 || status === 503 || status === 504) }
  }
  const category = code === 'credential' ? 'authentication'
    : ['configuration', 'tool_catalog', 'request_limit'].includes(code) ? 'configuration'
    : ['protocol', 'schema', 'unsupported', 'incomplete', 'interrupted', 'response_limit', 'redirect'].includes(code) ? 'protocol'
    : code === 'provider' ? 'service_error'
    : code === 'transport' ? 'network'
    : code === 'timeout' ? 'timeout'
    : code === 'credential_echo' ? 'security' : 'unknown'
  return { category, retryable: false }
}
