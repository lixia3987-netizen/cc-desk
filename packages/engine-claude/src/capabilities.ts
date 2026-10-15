import type { ExecutionCapabilities, ExecutionMode } from '@cc-desk/contracts/execution';
import type { ClaudeCapabilities as Capabilities, ClaudeSession as Session } from './types.js';

const STRUCTURED_FLAGS = ['--print', '--input-format', '--output-format', '--verbose', '--permission-prompt-tool'];
export function claudeCapabilities(cli: Capabilities, mode: ExecutionMode): ExecutionCapabilities {
  const structured = mode === 'structured';
  const missing = structured ? STRUCTURED_FLAGS.filter(flag => !cli.flags.includes(flag)) : [];
  // 离线创建身份使用适配器已实现的功能。得知 CLI 参数后，
  // 即使后续探测不可用，也保留这些参数所限定的较窄支持范围。
  const undiscovered = !cli.available && cli.flags.length === 0;
  return {
    available: cli.available && !missing.length,
    error: !cli.available ? cli.error : missing.length ? '当前 CLI 不支持结构化双向会话，请更新 CLI 或使用终端模式。' : undefined,
    structured, terminal: !structured, approvals: structured,
    resume: undiscovered || cli.flags.includes('--resume'),
    fork: undiscovered || cli.flags.includes('--fork-session') && cli.flags.includes('--session-id'),
    commands: structured, contextUsage: structured, liveConfig: structured, attachments: structured,
    recoverContext: structured, export: true,
  };
}
export function validateClaudeSession(session: Pick<Session, 'execution'>) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (session.execution.providerId !== 'claude' || !session.execution.conversationId || !uuid.test(session.execution.conversationId) ||
    (session.execution.forkFrom && !uuid.test(session.execution.forkFrom))) throw new Error('Claude 会话 ID 必须为有效的 UUID。');
}
