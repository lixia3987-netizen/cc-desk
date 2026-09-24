import { isPermissionMode } from '../../../shared/permissions';
import type { Capabilities, Session } from '../../../shared/types';
import { claudeArguments, cliInvocation, environment } from '../../commands';
import type { TerminalLaunchCallbacks, TerminalLauncher, TerminalLaunchSpec } from '../../execution/terminal-launch';
import { transcriptExists } from '../../history';
import { createPtyHookBridge, supportsPtyHooks } from '../../pty-hooks';
import type { StateStore } from '../../store';

export class ClaudeTerminalLauncher implements TerminalLauncher {
  constructor(private store: StateStore, private capabilities: () => Capabilities) {}

  async prepare(session: Session, callbacks: TerminalLaunchCallbacks): Promise<TerminalLaunchSpec> {
    if (session.execution.providerId !== 'claude' || session.execution.mode !== 'terminal') {
      throw new Error('此终端启动器只支持 Claude 会话。');
    }
    if (session.observedPermissionMode && !isPermissionMode(session.observedPermissionMode)) {
      throw new Error('上次 CLI 使用了客户端启动选项以外的权限模式。请先在会话设置中明确选择受支持的权限模式，再恢复。');
    }
    const conversationId = session.execution.conversationId;
    if (!conversationId) throw new Error('Claude 会话缺少对话身份。');
    const capabilities = this.capabilities();
    if (!capabilities.available) throw new Error(capabilities.error || 'Claude Code 尚未就绪，请在设置中检测。');
    const env = environment();
    const cli = cliInvocation(this.store.state.settings, env);
    const args = [...cli.prefix, ...claudeArguments(session, capabilities, await transcriptExists(conversationId))];
    const resource = supportsPtyHooks(capabilities)
      ? await createPtyHookBridge(conversationId, callbacks.update, callbacks.subtask, callbacks.prompt)
      : undefined;
    if (resource) args.push('--settings', resource.settings);
    return { file: cli.file, args, env, resource, terminalSync: resource ? 'waiting' : 'unsupported' };
  }
}
