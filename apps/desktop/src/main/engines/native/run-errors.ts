import type { ModelFailureDiagnostic } from '@cc-desk/agent-core';

type ModelFailureCategory = ModelFailureDiagnostic['category'];
const MODEL_FAILURE_LABELS: Record<ModelFailureCategory, string> = {
  authentication: '认证或权限失败', configuration: '连接或请求配置错误', rate_limit: '服务限流',
  service_unavailable: '服务暂不可用', service_error: '服务错误', protocol: '响应协议错误',
  network: '网络连接失败', timeout: '模型请求超时', security: '连接安全限制', unknown: '未知模型错误',
};
const MODEL_FAILURE_MESSAGES: Record<ModelFailureCategory, string> = {
  authentication: '模型服务未接受认证或访问权限，已停止本回合。请检查连接密钥、账号权限和模型权限，再发送新指令。',
  configuration: '模型连接或请求配置无效，已停止本回合。请检查服务地址、协议、模型名称和请求限制，再发送新指令。',
  rate_limit: '模型服务触发限流，已停止本回合。请检查配额与限流设置，等待恢复后发送新指令。',
  service_unavailable: '模型服务暂不可用，已停止本回合。请检查服务状态，恢复后发送新指令。',
  service_error: '模型服务返回了未纳入自动恢复范围的服务错误，已停止本回合。请检查服务状态与原始记录后，再决定是否发送新指令。',
  protocol: '模型响应不符合所选协议或未完整结束，已停止本回合。请核查服务协议兼容性；未完成的输出不会作为完整结果继续使用。',
  network: '模型请求发生网络错误，服务端是否已处理请求尚未确认，已停止本回合。请检查网络与原始记录，再决定是否发送新指令；本次不会自动重试。',
  timeout: '模型请求超时，服务端是否已处理请求尚未确认，已停止本回合。请检查服务状态与原始记录，再决定是否发送新指令；本次不会自动重试。',
  security: '模型连接触发安全限制，已停止本回合。请检查服务地址、HTTPS 和重定向设置，修正后发送新指令。',
  unknown: '模型请求发生无法确认原因的错误，已停止本回合。请核查连接与原始记录，再决定后续操作；不会自动重试或重放工具。',
};
const PARTIAL_OUTPUT_MESSAGE = '本次未完成的模型输出已丢弃，不会与后续响应拼接。';
function modelFailureCategory(value: unknown): ModelFailureCategory {
  return typeof value === 'string' && Object.hasOwn(MODEL_FAILURE_LABELS, value) ? value as ModelFailureCategory : 'unknown';
}
function validCount(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }

export interface NativeRunErrorDetails {
  modelRequests?: number;
  toolCalls?: number;
  modelFailure?: string;
  retries?: number;
  partial?: boolean;
}

/** Only stable categories and validated counts enter a UI diagnostic, never provider error text. */
export function nativeModelFailureMessage(failure: ModelFailureDiagnostic, partial: boolean, retryDelayMs?: number): string {
  const category = modelFailureCategory(failure.category);
  const safeRetry = !partial && failure.retryable === true &&
    ((category === 'rate_limit' && failure.httpStatus === 429) ||
      (category === 'service_unavailable' && [502, 503, 504].includes(failure.httpStatus ?? 0))) &&
    (retryDelayMs === 500 || retryDelayMs === 1500);
  if (safeRetry) return `模型请求失败：${MODEL_FAILURE_LABELS[category]}。将在 ${retryDelayMs} 毫秒后进行本回合有界重试，等待期间可取消；整个回合最多额外请求 2 次。每次请求可能计费，计入模型请求次数与执行时长；不会重放本地工具。`;
  return `${MODEL_FAILURE_MESSAGES[category]}${partial ? PARTIAL_OUTPUT_MESSAGE : ''}`;
}

/** Stable runtime reasons remain in the native ledger; the desktop shows actionable explanations. */
export function nativeRunError(reason: string, details?: NativeRunErrorDetails): string {
  const messages: Record<string, string> = {
    context_budget: '上下文超过运行预算，已停止发送下一次模型请求。可在上下文面板手动压缩、调整输入预算，或新建会话继续。',
    recovery_resolved: '原回合已收束；已保存的工具结果保留，未执行的操作不会自动重放。请发送新指令继续。',
    model_request_budget: '已达到本回合的模型请求次数上限。已完成的工具结果已保存，可发送新消息继续，或调整会话预算。',
    tool_call_budget: '已达到本回合的工具调用次数上限。已完成的工具结果已保存，可发送新消息继续，或调整会话预算。',
    active_time_budget: '已达到本回合的执行时长上限。请查看已完成的工作，再发送新消息继续。',
    context_maintenance_failed: '回合内上下文维护未完成，已停止继续执行。请核查项目指令、连接与原始记录；摘要可能产生费用，不会自动重复请求或重放工具。',
    context_maintenance_images_unsupported: '仅可压缩首张图片所在轮次之前的完整纯文本历史，当前没有这样的历史，未调用摘要模型；请提高输入预算或新建会话。原始图片、工具结果和任务记录保持不变。',
    context_maintenance_unhelpful: '回合内上下文无法安全缩减到预算内，已停止继续执行。完整用户请求、最新工具结果和任务证据引用保留；请调整预算或发送新消息继续。',
    store_context_maintenance_failed: '上下文维护的保存或清理结果尚未确认，已暂停执行。原始记录保留，不会自动重复摘要或重放工具。',
    model_authentication: MODEL_FAILURE_MESSAGES.authentication,
    model_configuration: MODEL_FAILURE_MESSAGES.configuration,
    model_rate_limit: MODEL_FAILURE_MESSAGES.rate_limit,
    model_service_unavailable: MODEL_FAILURE_MESSAGES.service_unavailable,
    model_service_error: MODEL_FAILURE_MESSAGES.service_error,
    model_protocol: MODEL_FAILURE_MESSAGES.protocol,
    model_network: MODEL_FAILURE_MESSAGES.network,
    model_timeout: MODEL_FAILURE_MESSAGES.timeout,
    model_security: MODEL_FAILURE_MESSAGES.security,
    model_unknown: MODEL_FAILURE_MESSAGES.unknown,
    model_retry_exhausted: '已用完本回合允许的有限重试次数，已停止继续请求。请检查模型服务与配额，恢复后发送新指令；不会自动重放本地工具。',
    model_retry_wait_failed: '有限重试的等待过程未完成，已停止本回合。请核查运行记录后再发送新指令；不会自动继续请求或重放工具。',
    tool_failure_repeated: '工具调用重复失败，已停止本回合。请检查工具结果、输入与任务证据，修正问题后发送新指令；不会自动重放已准备或结果未知的操作。',
    tool_no_progress: '工具调用重复且未发现新的进展，已停止本回合。请检查已完成的工作与任务证据，调整目标或输入后发送新指令；不会自动重放已准备或结果未知的操作。',
    store_model_request_started_failed: '模型请求开始记录未可靠保存，已暂停执行，本次未发送模型请求。请核查原始记录与恢复状态；不会自动重试模型请求或重放工具。',
    store_model_request_failed_failed: '模型请求失败回执未可靠保存，已暂停执行，请核查原始记录与恢复状态。请求结果和费用可能尚未确认，不会自动重试或重放工具。',
  };
  let message = Object.hasOwn(messages, reason) ? messages[reason] : reason;
  if (details?.modelFailure !== undefined) message += `最近一次模型错误：${MODEL_FAILURE_LABELS[modelFailureCategory(details.modelFailure)]}。`;
  const counts: string[] = [];
  if (validCount(details?.modelRequests)) counts.push(`模型请求 ${details.modelRequests} 次`);
  if (validCount(details?.toolCalls)) counts.push(`工具调用 ${details.toolCalls} 次`);
  if (counts.length) message += `本回合已计入${counts.join('、')}。`;
  if (validCount(details?.retries) && details.retries <= 2) message += `已执行有限重试 ${details.retries} 次。`;
  if (details?.partial === true) message += PARTIAL_OUTPUT_MESSAGE;
  return message;
}
