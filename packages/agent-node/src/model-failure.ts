import { validateModelFailureDiagnostic, type ModelFailureDiagnostic, type ModelFailureReason } from '@cc-desk/agent-core'

type FailureDetails = Pick<ModelFailureDiagnostic, 'protocol' | 'stage' | 'reason'>
const adapterDetails = new WeakMap<Error, FailureDetails>()
const defaultReasons: Readonly<Record<string, ModelFailureReason>> = Object.freeze({
  protocol: 'invalid_history', schema: 'invalid_event', unsupported: 'unsupported_content', incomplete: 'incomplete_response',
  interrupted: 'missing_terminal', response_limit: 'response_limit', transport: 'stream_disconnected',
})

/** Only constant adapter call sites supply detail; error messages and provider fields are never inspected. */
export function describeNativeModelFailure<T extends Error>(error: T, details: FailureDetails): T {
  const candidate = { ...adapterDetails.get(error), ...details }
  if (validateModelFailureDiagnostic({ category: 'unknown', retryable: false, ...candidate })) {
    adapterDetails.set(error, {
      ...(candidate.protocol === undefined ? {} : { protocol: candidate.protocol }),
      ...(candidate.stage === undefined ? {} : { stage: candidate.stage }),
      ...(candidate.reason === undefined ? {} : { reason: candidate.reason }),
    })
  }
  return error
}
export function nativeModelFailureDetails(error: Error): FailureDetails | undefined { return adapterDetails.get(error) }
export function defaultModelFailureReason(code: string): ModelFailureReason | undefined { return Object.hasOwn(defaultReasons, code) ? defaultReasons[code] : undefined }

/** Only adapter-owned codes and numeric HTTP status enter a persisted diagnostic. */
export function classifyNativeModelFailure(code: string, httpStatus?: number, rejectedBeforeStream = false, details?: FailureDetails): ModelFailureDiagnostic {
  if ((code === 'http' || code === 'redirect') && typeof httpStatus === 'number' && Number.isInteger(httpStatus) && httpStatus >= 300 && httpStatus <= 599) {
    const status = httpStatus
    const category = status === 401 || status === 403 ? 'authentication'
      : status === 429 ? 'rate_limit'
      : status === 502 || status === 503 || status === 504 ? 'service_unavailable'
      : status >= 500 ? 'service_error'
      : status >= 400 ? 'configuration' : 'protocol'
    return { category, httpStatus: status, retryable: rejectedBeforeStream && (status === 429 || status === 502 || status === 503 || status === 504), ...details }
  }
  const category = code === 'credential' ? 'authentication'
    : ['configuration', 'tool_catalog', 'request_limit'].includes(code) ? 'configuration'
    : ['protocol', 'schema', 'unsupported', 'incomplete', 'interrupted', 'response_limit', 'redirect'].includes(code) ? 'protocol'
    : code === 'provider' ? 'service_error'
    : code === 'transport' ? 'network'
    : code === 'timeout' ? 'timeout'
    : code === 'credential_echo' ? 'security' : 'unknown'
  return { category, retryable: false, ...details }
}
