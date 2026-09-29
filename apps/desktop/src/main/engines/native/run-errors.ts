/** Stable runtime reasons remain in the native ledger; the desktop shows actionable explanations. */
export function nativeRunError(reason: string): string {
  const messages: Record<string, string> = {
    context_budget: '上下文超过运行预算，已停止发送下一次模型请求。可在上下文面板手动压缩、调整输入预算，或新建会话继续。',
    recovery_resolved: '原回合已收束；已保存的工具结果保留，未执行的操作不会自动重放。请发送新指令继续。',
    model_request_budget: '已达到本回合的模型请求次数上限。已完成的工具结果已保存，可发送新消息继续，或调整会话预算。',
    tool_call_budget: '已达到本回合的工具调用次数上限。已完成的工具结果已保存，可发送新消息继续，或调整会话预算。',
    active_time_budget: '已达到本回合的执行时长上限。请查看已完成的工作，再发送新消息继续。',
    context_maintenance_failed: '回合内上下文维护未完成，已停止继续执行。请核查项目指令、连接与原始记录；摘要可能产生费用，不会自动重复请求或重放工具。',
    context_maintenance_unhelpful: '回合内上下文无法安全缩减到预算内，已停止继续执行。完整用户请求、最新工具结果和任务证据引用保留；请调整预算或发送新消息继续。',
    context_maintenance_unknown: '上下文维护的保存或清理结果尚未确认，已暂停执行。原始记录保留，不会自动重复摘要或重放工具。',
  };
  return messages[reason] ?? reason;
}
