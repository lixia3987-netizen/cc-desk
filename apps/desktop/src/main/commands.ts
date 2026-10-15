import { environment, findExecutable } from './platform-commands';
export { environment, findExecutable, shellInvocation, execFileAsync } from './platform-commands';
import type { Capabilities, Session, Settings } from '../shared/types';
import type { ClaudeSession } from '@cc-desk/engine-claude';
import { projectClaudeSession } from './engines/claude/session';
import {
  claudeArguments as buildClaudeArguments,
  cliInvocation as claudeInvocation,
  detectCLI as detectClaudeCLI,
  resolveNpmLauncher as resolveClaudeNpmLauncher,
  type ClaudeCommandHost,
} from '@cc-desk/engine-claude/commands';
export { CLIResolutionError, parseCapabilities } from '@cc-desk/engine-claude/commands';
/** 仅 Claude 命令使用此宿主；通用 Shell 解析仍在本地进行。 */
const claudeCommandHost: ClaudeCommandHost = { environment, findExecutable };

export function resolveNpmLauncher(file: string, env = environment(), platform: NodeJS.Platform = process.platform) {
  return resolveClaudeNpmLauncher(file, env, platform, claudeCommandHost);
}

export function cliInvocation(settings: Pick<Settings, 'claudePath'>, env = environment()) {
  return claudeInvocation(settings, env, claudeCommandHost);
}

export function detectCLI(settings: Pick<Settings, 'claudePath'>) {
  return detectClaudeCLI(settings, claudeCommandHost);
}

export function claudeArguments(session: Session | ClaudeSession, capabilities: Capabilities, hasTranscript: boolean) {
  return buildClaudeArguments('engineConfig' in session ? projectClaudeSession(session) : session, capabilities, hasTranscript);
}
