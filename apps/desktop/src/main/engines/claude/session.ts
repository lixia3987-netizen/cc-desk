import { createClaudeConfig, parseClaudeConfig } from '@cc-desk/engine-claude/config';
import type { ClaudeSession, ClaudeSessionPatch } from '@cc-desk/engine-claude';
import type { Session } from '../../../shared/types';

export function projectClaudeSession(session: Session, projectPath?: string): ClaudeSession {
  if (session.execution.providerId !== 'claude') throw new Error('此适配器只支持 Claude 会话。');
  return {
    id: session.id, kind: session.kind, execution: session.execution, cwd: session.cwd, projectPath,
    started: session.started, archived: session.archived, status: session.status, taskState: session.taskState,
    error: session.error, exitCode: session.exitCode, subtasks: session.subtasks,
    observedPermissionMode: session.observedPermissionMode, ...parseClaudeConfig(session.engineConfig),
  };
}

/** 将已确认的值合并到最新配置中，包括 CLI 部分成功的结果。 */
export function claudeSessionPatch(session: Session, patch: ClaudeSessionPatch): Partial<Session> {
  const { model, effort, permissionMode, ...runtime } = patch;
  if (model === undefined && effort === undefined && permissionMode === undefined) return runtime;
  const current = parseClaudeConfig(session.engineConfig);
  return { ...runtime, engineConfig: createClaudeConfig({ ...current,
    ...(model === undefined ? {} : { model }), ...(effort === undefined ? {} : { effort }),
    ...(permissionMode === undefined ? {} : { permissionMode }),
  }) };
}
