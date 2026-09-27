/** Stable runtime reasons remain in the native ledger; the desktop shows actionable explanations. */
export function nativeRunError(reason: string): string {
  const messages: Record<string, string> = {
    context_budget: '上下文超过运行预算，已停止发送下一次模型请求。可在上下文面板手动压缩、调整输入预算，或新建会话继续。',
    recovery_resolved: '原回合已收束；已保存的工具结果保留，未执行的操作不会自动重放。请发送新指令继续。',
    model_request_budget: '已达到本回合的模型请求次数上限。已完成的工具结果已保存，可发送新消息继续，或调整会话预算。',
    tool_call_budget: '已达到本回合的工具调用次数上限。已完成的工具结果已保存，可发送新消息继续，或调整会话预算。',
    active_time_budget: '已达到本回合的执行时长上限。请查看已完成的工作，再发送新消息继续。',
  };
  return messages[reason] ?? reason;
}
