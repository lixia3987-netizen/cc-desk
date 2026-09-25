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

/** Merge confirmed values into the latest configuration, including partial CLI successes. */
export function claudeSessionPatch(session: Session, patch: ClaudeSessionPatch): Partial<Session> {
  const { model, effort, permissionMode, ...runtime } = patch;
  if (model === undefined && effort === undefined && permissionMode === undefined) return runtime;
  const current = parseClaudeConfig(session.engineConfig);
  return { ...runtime, engineConfig: createClaudeConfig({ ...current,
    ...(model === undefined ? {} : { model }), ...(effort === undefined ? {} : { effort }),
    ...(permissionMode === undefined ? {} : { permissionMode }),
  }) };
}
