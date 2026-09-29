import type { ExecutionDescriptor } from '../../shared/execution';
import type { Session } from '../../shared/types';
import { isSessionBusy } from '../../shared/session-activity';
import { configurationSupported } from '../EngineConfiguration';

/** Local metadata stays available when credentials are missing, but unavailable
 * executors/configurations must not mutate provider-owned records or directories. */
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
    // Continuation copies only visible content and creates an unsent new draft.
    continue: !readOnly && !maintained && !taskBusy && session.kind === 'agent' && session.execution.mode === 'structured',
  };
}
