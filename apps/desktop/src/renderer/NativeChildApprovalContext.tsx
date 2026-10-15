import type { NativeAgentApprovalScope } from '../shared/chat';

/** 父任务审批的是确定的子任务动作，应清楚展示其执行方与文件系统目标。 */
export function NativeChildApprovalContext({ scope }: { scope?: NativeAgentApprovalScope }) {
  if (!scope) return null;
  return <section className="native-child-approval-context" aria-label="子 Agent 操作范围">
    <p>子 Agent：<strong>{scope.title}</strong></p>
    <p>工作区：<code>{scope.cwd}</code></p>
  </section>;
}
