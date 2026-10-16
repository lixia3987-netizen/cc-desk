// 取消兜底与生产运行预算共用同一上限，不另加等待预算。
export const REGRESSION_MAX_ACTIVE_MS = 240000;

const transportErrorCodes = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT',
  'ENETUNREACH', 'EHOSTUNREACH', 'EACCES', 'EPERM', 'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_TLS_HANDSHAKE_TIMEOUT', 'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
]);

const ownValue = (value, key) => {
  if (!value || typeof value !== 'object') return undefined;
  try { return Object.getOwnPropertyDescriptor(value, key)?.value; } catch { return undefined; }
};

/** 仅公开固定连接错误码，不读取 getter、异常正文、主机名或证书内容。 */
export function safeUpstreamTransportFailure(error, { aborted = false, stage = 'before_headers' } = {}) {
  const safeStage = ['request_preparation', 'before_headers', 'response_stream'].includes(stage) ? stage : 'before_headers';
  if (aborted) return { stage: safeStage, code: 'ABORTED' };
  const seen = new Set();
  for (let depth = 0; depth < 3 && error && typeof error === 'object' && !seen.has(error); depth++) {
    seen.add(error);
    const code = ownValue(error, 'code');
    if (typeof code === 'string' && transportErrorCodes.has(code)) return { stage: safeStage, code };
    error = ownValue(error, 'cause');
  }
  return { stage: safeStage, code: 'UNKNOWN' };
}

/** 只有已经调用真实上游 transport、尚未结束的不同 child 才触发重叠取消。 */
export function hasActiveChildTransportOverlap(requests) {
  return new Set(requests.filter(request => request.role === 'child' && Number.isFinite(request.upstreamBeginMs) && request.endMs === null).map(request => request.runId)).size >= 2;
}
