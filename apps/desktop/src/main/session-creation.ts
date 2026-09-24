import { randomUUID } from 'node:crypto';
import { initialSessionTitle } from '../shared/session-title';
import { sessionSchema } from '../shared/schema';
import type { NewSession, Session } from '../shared/types';
import { cleanupWorktree, createWorktree } from './git';
import { sanitizeWorktreeName } from './worktree-paths';
import type { StateStore } from './store';
import type { SessionService } from './session-service';

/** Session identity allocation is delegated to the registered provider. */
export class SessionCreation {
  private projects = new Map<string, number>();
  constructor(private store: StateStore, private services: SessionService, private notify: () => void, private defaultProvider: string) {}
  pending(projectId: string) { return this.projects.has(projectId); }
  async create(input: NewSession): Promise<Session> {
    const project = this.store.state.projects.find(project => project.id === input.projectId);
    if (!project) throw new Error('项目不存在。');
    if (input.kind === 'shell' && (input.conversationId || input.fork || (input.providerId && input.providerId !== 'shell') || input.mode === 'structured')) throw new Error('Shell 会话不支持导入、分支或图形化执行。');
    if (input.fork && !input.conversationId) throw new Error('请指定要分支的会话。');
    const providerId = input.kind === 'shell' ? 'shell' : input.providerId ?? this.defaultProvider;
    if (input.kind === 'agent' && providerId === 'shell') throw new Error('Shell 提供方必须使用 Shell 会话类型。');
    const mode = input.kind === 'shell' ? 'terminal' : input.mode ?? 'terminal';
    const execution = this.services.execution.createIdentity(providerId, mode, input);
    if (input.conversationId && !input.fork) {
      const existing = this.store.state.sessions.find(session => session.execution.providerId === providerId && session.execution.conversationId === input.conversationId);
      if (existing) {
        this.store.change(state => { state.sessions.find(session => session.id === existing.id)!.archived = false; });
        this.notify(); return this.services.execution.getSession(existing.id);
      }
    }
    const id = randomUUID();
    const source = input.fork ? this.store.state.sessions.find(session => session.execution.providerId === providerId && session.execution.conversationId === input.conversationId && session.projectId === project.id) : undefined;
    const sourcePath = source?.cwd ?? project.path;
    const title = initialSessionTitle(input);
    const location = this.store.state.settings.worktreeLocation ?? 'project';
    const customRoot = this.store.state.settings.worktreeRoot;
    const now = new Date().toISOString();
    const session: Session = {
      id, projectId: project.id, ...title, cwd: sourcePath, kind: input.kind, execution,
      started: !!execution.imported, model: input.model, effort: input.effort,
      permissionMode: input.permissionMode ?? source?.permissionMode ?? (input.kind === 'agent' ? this.store.state.settings.defaultPermissionMode ?? 'default' : 'default'),
      taskState: 'idle', draft: '', status: 'idle', archived: false, createdAt: now, updatedAt: now,
    };
    this.services.execution.validateSession(session);
    sessionSchema.parse(session);
    this.projects.set(project.id, (this.projects.get(project.id) ?? 0) + 1);
    try {
      return await this.services.withSessionCreation(sourcePath, input.isolated, async () => {
        const worktree = input.isolated ? await createWorktree(sourcePath, this.store.directory, id, {
          location, customRoot, projectPath: project.path, projectName: project.name,
          name: input.worktreeName?.trim() || sanitizeWorktreeName(title.title),
        }) : undefined;
        Object.assign(session, { cwd: worktree || sourcePath, worktree, worktreeBase: worktree ? sourcePath : undefined });
        try { this.store.change(state => state.sessions.unshift(session)); }
        catch (error) {
          if (worktree) {
            const cleanup = await cleanupWorktree(sourcePath, worktree, id, false).catch(() => undefined);
            if (!cleanup?.ok) throw new Error('会话保存失败；新建的工作目录已保留，请检查磁盘后处理：' + worktree);
          }
          throw error;
        }
        this.notify(); return session;
      }, input.isolated && location === 'project' ? project.path : undefined);
    } finally {
      const count = (this.projects.get(project.id) ?? 1) - 1;
      if (count) this.projects.set(project.id, count); else this.projects.delete(project.id);
    }
  }
}
