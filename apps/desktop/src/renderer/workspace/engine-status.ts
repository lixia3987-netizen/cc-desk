import type { ExecutionDescriptor } from '../../shared/execution';
import type { Session } from '../../shared/types';

/** An executor's availability does not imply that a particular model credential is ready. */
export function currentEngineStatus(session: Session | undefined, executors: ExecutionDescriptor[], defaultProviderId: string) {
  const descriptor = executors.find(item => item.providerId === (session?.execution.providerId ?? defaultProviderId)
    && item.mode === (session?.execution.mode ?? 'structured'));
  const name = descriptor?.displayName ?? session?.execution.providerId ?? defaultProviderId;
  return { name, text: `当前引擎：${name}`, ready: !!descriptor?.capabilities.available && !descriptor?.maintenance,
    detail: descriptor?.maintenance ? '正在维护' : descriptor?.capabilities.available ? '引擎可用，具体连接状态请查看会话' : descriptor?.capabilities.error ?? '引擎尚未就绪' };
}
