import type { ExecutionDescriptor } from '../../shared/execution';
import type { Session } from '../../shared/types';
import { isSessionBusy } from '../../shared/session-activity';
import { configurationSupported } from '../EngineConfiguration';

/** 缺少凭据时，本地元数据仍可用，但不可用的
 * 执行器或配置不能修改归属于提供方的记录与目录。 */
export function sessionActionAvailability(session: Session, descriptor?: ExecutionDescriptor) {
  const readOnly = !configurationSupported(descriptor, session.engineConfig);
  const maintained = !!descriptor?.maintenance;
  const taskBusy = isSessionBusy(session);
  return {
    readOnly, taskBusy,
    manage: !readOnly && !maintained && !taskBusy && (session.execution.mode === 'structured' || !['running', 'stopping'].includes(session.status)),
    fork: !readOnly && !maintained && !taskBusy && !!descriptor?.capabilities.fork && session.started && !session.identityPending,
    export: !readOnly && !maintained && !!descriptor?.capabilities.export,
    stop: !readOnly,
    // 继续会话仅复制可见内容，并创建尚未发送的新草稿。
    continue: !readOnly && !maintained && !taskBusy && session.kind === 'agent' && session.execution.mode === 'structured',
  };
}
