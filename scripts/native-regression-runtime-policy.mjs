// 取消兜底与生产运行预算共用同一上限，不另加等待预算。
export const REGRESSION_MAX_ACTIVE_MS = 240000;

/** 只有已经调用真实上游 transport、尚未结束的不同 child 才触发重叠取消。 */
export function hasActiveChildTransportOverlap(requests) {
  return new Set(requests.filter(request => request.role === 'child' && Number.isFinite(request.upstreamBeginMs) && request.endMs === null).map(request => request.runId)).size >= 2;
}
