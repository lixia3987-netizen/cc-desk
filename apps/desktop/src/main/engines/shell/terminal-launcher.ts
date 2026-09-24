import type { Session } from '../../../shared/types';
import { environment, shellInvocation } from '../../commands';
import type { TerminalLauncher, TerminalLaunchSpec } from '../../execution/terminal-launch';
import type { StateStore } from '../../store';

export class ShellTerminalLauncher implements TerminalLauncher {
  constructor(private store: StateStore) {}

  async prepare(session: Session): Promise<TerminalLaunchSpec> {
    if (session.execution.providerId !== 'shell' || session.execution.mode !== 'terminal') {
      throw new Error('此终端启动器只支持 Shell 会话。');
    }
    return { ...shellInvocation(this.store.state.settings), env: environment() };
  }
}
