import { ClaudeConnection as EngineConnection } from '@cc-desk/engine-claude';
import { signalPosixGroup } from '../../posix-process-group';
/** Compatibility constructor for the shared POSIX resource-lifecycle tests. */
export class ClaudeConnection extends EngineConnection {
  constructor(
    invocation: ConstructorParameters<typeof EngineConnection>[0],
    cwd: string, env: NodeJS.ProcessEnv,
    events: ConstructorParameters<typeof EngineConnection>[3], controlTimeoutMs?: number,
  ) { super(invocation, cwd, env, events, controlTimeoutMs, signalPosixGroup); }
}
