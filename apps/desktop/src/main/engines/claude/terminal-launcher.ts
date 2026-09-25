import { ClaudeTerminalLaunchBuilder } from '@cc-desk/engine-claude';
import type { Capabilities, Session } from '../../../shared/types';
import { cliInvocation } from '../../commands';
import { environment } from '../../platform-commands';
import type { TerminalLaunchCallbacks, TerminalLauncher, TerminalLaunchSpec, TerminalSessionUpdate } from '../../execution/terminal-launch';
import type { StateStore } from '../../store';
import { claudeSessionPatch, projectClaudeSession } from './session';

/** Maps confirmed provider configuration into the single desktop engineConfig source. */
export class ClaudeTerminalLauncher implements TerminalLauncher {
  private builder: ClaudeTerminalLaunchBuilder;
  constructor(private store: StateStore, capabilities: () => Capabilities) {
    this.builder = new ClaudeTerminalLaunchBuilder({ environment, invocation: env => cliInvocation(store.state.settings, env) }, capabilities);
  }
  prepare(session: Session, callbacks: TerminalLaunchCallbacks): Promise<TerminalLaunchSpec> {
    return this.builder.prepare(projectClaudeSession(session), {
      ...callbacks,
      update: patch => {
        const current = this.store.state.sessions.find(item => item.id === session.id);
        if (!current) return;
        const { model, permissionMode, ...runtime } = patch;
        const config = claudeSessionPatch(current, { model, permissionMode });
        const update: TerminalSessionUpdate = { ...runtime, ...(config.engineConfig ? { engineConfig: config.engineConfig } : {}) };
        callbacks.update(update);
      },
    });
  }
}
