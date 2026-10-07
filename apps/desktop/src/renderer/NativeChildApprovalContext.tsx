import type { NativeAgentApprovalScope } from '../shared/chat';

/** The parent approves an exact child action; show its owner and filesystem target plainly. */
export function NativeChildApprovalContext({ scope }: { scope?: NativeAgentApprovalScope }) {
  if (!scope) return null;
  return <section className="native-child-approval-context" aria-label="子 Agent 操作范围">
    <p>子 Agent：<strong>{scope.title}</strong></p>
    <p>工作区：<code>{scope.cwd}</code></p>
  </section>;
}
