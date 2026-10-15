import { ClaudeConnection as EngineConnection } from '@cc-desk/engine-claude';
import { signalPosixGroup } from '../../posix-process-group';
/** 为共享 POSIX 资源生命周期测试提供兼容构造器。 */
export class ClaudeConnection extends EngineConnection {
  constructor(
    invocation: ConstructorParameters<typeof EngineConnection>[0],
    cwd: string, env: NodeJS.ProcessEnv,
    events: ConstructorParameters<typeof EngineConnection>[3], controlTimeoutMs?: number, outputLimitBytes?: number,
  ) { super(invocation, cwd, env, events, controlTimeoutMs, signalPosixGroup, outputLimitBytes); }
}
