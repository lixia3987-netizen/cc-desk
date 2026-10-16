export type NativeDiagnosticStage = 'write' | 'sync' | 'rename' | 'other' | 'execute';

const stages = new Set<string>(['write', 'sync', 'rename', 'other', 'execute']);
export const NATIVE_DIAGNOSTIC_CODES = Object.freeze([
  'EPERM', 'EACCES', 'ENOENT', 'EBADF', 'ENOSPC', 'EIO', 'EBUSY', 'EMFILE', 'ENFILE', 'EROFS',
  'ENOTDIR', 'EISDIR', 'EINVAL', 'ENAMETOOLONG', 'EEXIST', 'EXDEV', 'ENOMEM', 'ENOTEMPTY',
  'EPIPE', 'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH',
  'protocol', 'transport', 'spawn', 'crash', 'startup', 'stdio', 'stdio_limit', 'cancelled',
  'cleanup_unconfirmed', 'configuration', 'credential', 'approval', 'budget', 'active_time_budget', 'completion_validation',
  'protocol_model_request_diagnostic', 'protocol_model_request_started', 'protocol_model_request_failed',
  'protocol_model_response', 'protocol_run_finished', 'protocol_store_other', 'protocol_event', 'protocol_other', 'protocol_envelope',
  'store_closed', 'writer_locked', 'writer_lost', 'corrupt_store', 'invalid_record',
  'unsupported_schema', 'invalid_identity', 'invalid_usage', 'invalid_limits', 'limit_exceeded',
  'unsafe_path', 'recovery_required', 'context_mismatch', 'stale_owner', 'conversation_busy', 'unknown',
] as const);
const codes = new Set<string>(NATIVE_DIAGNOSTIC_CODES);

/** 只复制固定标识；不读取 message/stack，也不调用错误对象上的 getter 或序列化方法。 */
export function formatNativeDiagnostic(stage: unknown, error: unknown): string {
  let code = 'unknown';
  try {
    const value = error && (typeof error === 'object' || typeof error === 'function')
      ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
    if (typeof value === 'string' && codes.has(value)) code = value;
  } catch { /* Proxy 和异常属性访问也不能使诊断改变执行结果。 */ }
  return '[cc-desk:native-diagnostic]' + JSON.stringify({ stage: typeof stage === 'string' && stages.has(stage) ? stage : 'other', code });
}

/** 仅错误分支调用；诊断失败不得替换原始异常或恢复处理。 */
export function reportNativeDiagnostic(stage: NativeDiagnosticStage, error: unknown): void {
  if (process.env.CC_DESK_CHAT_PERF !== '1') return;
  try { console.error(formatNativeDiagnostic(stage, error)); }
  catch { /* 不向执行链传播 stderr/console 错误。 */ }
}
