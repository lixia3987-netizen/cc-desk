import { isPermissionMode } from './permissions.js';
import type { ClaudeCapabilities, ClaudeSession } from './types.js';
import type { ClaudeLaunchHost } from './host.js';
import { claudeArguments } from './commands.js';
import { transcriptExists } from './history.js';
import { createPtyHookBridge, supportsPtyHooks, type PtySessionPatch, type TerminalSubtaskEvent } from './pty-hooks.js';

export interface ClaudeTerminalCallbacks {
  update(patch: PtySessionPatch): void;
  subtask(event: TerminalSubtaskEvent): void;
  prompt(text: string): void;
}
export interface ClaudeTerminalLaunchSpec {
  file: string; args: string[]; env: Record<string, string>;
  resource?: { close(): Promise<void> };
  terminalSync?: 'waiting' | 'synced' | 'unsupported';
}
/** Only provider setup: the PTY host owns all spawned processes and launch resources. */
export class ClaudeTerminalLaunchBuilder {
  constructor(private launch: ClaudeLaunchHost, private capabilities: () => ClaudeCapabilities) {}
  async prepare(session: ClaudeSession, callbacks: ClaudeTerminalCallbacks): Promise<ClaudeTerminalLaunchSpec> {
    if (session.execution.providerId !== 'claude' || session.execution.mode !== 'terminal') throw new Error('此终端启动器只支持 Claude 会话。');
    if (session.observedPermissionMode && !isPermissionMode(session.observedPermissionMode)) {
      throw new Error('上次 CLI 使用了客户端启动选项以外的权限模式。请先在会话设置中明确选择受支持的权限模式，再恢复。');
    }
    const conversationId = session.execution.conversationId;
    if (!conversationId) throw new Error('Claude 会话缺少对话身份。');
    const capabilities = this.capabilities();
    if (!capabilities.available) throw new Error(capabilities.error || 'Claude Code 尚未就绪，请在设置中检测。');
    const env = this.launch.environment();
    const cli = this.launch.invocation(env);
    const args = [...cli.prefix, ...claudeArguments(session, capabilities, await transcriptExists(conversationId))];
    const resource = supportsPtyHooks(capabilities)
      ? await createPtyHookBridge(conversationId, callbacks.update, callbacks.subtask, callbacks.prompt)
      : undefined;
    if (resource) args.push('--settings', resource.settings);
    return { file: cli.file, args, env, resource, terminalSync: resource ? 'waiting' : 'unsupported' };
  }
}
