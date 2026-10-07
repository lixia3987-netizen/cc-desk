import { randomUUID } from 'node:crypto';
import { initialSessionTitle } from '../shared/session-title';
import { sessionSchema } from '../shared/schema';
import type { NewSession, Session } from '../shared/types';
import { cleanupWorktree, createWorktree } from './git';
import type { StateStore } from './store';
import type { SessionService } from './session-service';
import { isSessionBusy } from '../shared/session-activity';
import { continuationDraft, previewContinuation } from './session-continuation';

/** Session identity allocation is delegated to the registered provider. */
export class SessionCreation {
  private projects = new Map<string, number>();
  constructor(private store: StateStore, private services: SessionService, private notify: () => void, private defaultProvider: string) {}
  pending(projectId: string) { return this.projects.has(projectId); }
  private continuationSource(id: string): Session {
    const source = this.store.state.sessions.find(session => session.id === id);
    if (!source || source.kind !== 'agent' || source.execution.mode !== 'structured') throw new Error('只能从已有结构化对话带入可见内容。');
    if (isSessionBusy(source) || this.services.chat.isBusy(id) || this.services.workflows.isSessionBusy(id) || this.services.queue.hasActive(id)) throw new Error('请先停止来源会话的任务，再读取要带入的内容。');
    return source;
  }
  async previewContinuation(id: string) {
    const source = structuredClone(this.continuationSource(id));
    const page = await this.services.chat.page(id);
    const current = this.continuationSource(id);
    if (JSON.stringify({ cwd: source.cwd, projectId: source.projectId, execution: source.execution }) !== JSON.stringify({ cwd: current.cwd, projectId: current.projectId, execution: current.execution })) throw new Error('来源会话已变化，请重新读取。');
    return previewContinuation(source, page);
  }
  async create(input: NewSession): Promise<Session> {
    const project = this.store.state.projects.find(project => project.id === input.projectId);
    if (!project) throw new Error('项目不存在。');
    if (input.continuation && (input.kind !== 'agent' || input.mode !== 'structured' || input.conversationId || input.fork)) throw new Error('带入内容必须创建新的结构化会话，不能同时导入身份或分叉。');
    const continuationSource = input.continuation ? this.continuationSource(input.continuation.sourceSessionId) : undefined;
    if (continuationSource && continuationSource.projectId !== project.id) throw new Error('请在来源会话的项目内继续。');
    // Resolve before allocating a worktree, then recheck after directory ownership is acquired.
    const resolveDraft = async () => input.continuation ? continuationDraft(await this.previewContinuation(input.continuation.sourceSessionId), input.continuation) : '';
    const draft = input.continuation ? await resolveDraft() : '';
    if (input.kind === 'shell' && (input.conversationId || input.fork || (input.providerId && input.providerId !== 'shell') || input.mode === 'structured')) throw new Error('Shell 会话不支持导入、分支或图形化执行。');
    if (input.fork && !input.conversationId) throw new Error('请指定要分支的会话。');
    const providerId = input.kind === 'shell' ? 'shell' : input.providerId ?? this.defaultProvider;
    const assertAdmission = this.services.captureEngineAdmission(providerId);
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
    const sourcePath = source?.cwd ?? continuationSource?.cwd ?? project.path;
    const title = initialSessionTitle(input);
    const location = this.store.state.settings.worktreeLocation ?? 'project';
    const customRoot = this.store.state.settings.worktreeRoot;
    const now = new Date().toISOString();
    let configured = input.engineConfig ?? source?.engineConfig ?? this.store.state.settings.engineDefaults[providerId];
    if (providerId === 'native' && !input.engineConfig && !source?.engineConfig) {
      const freshDefaults = this.services.execution.defaultConfig(providerId, mode);
      const savedDefaults = this.store.state.settings.engineDefaults[providerId];
      configured = {
        schemaVersion: savedDefaults?.schemaVersion ?? freshDefaults.schemaVersion,
        options: { ...freshDefaults.options, inputBudgetMode: 'model', ...savedDefaults?.options, runtimePolicy: 'defaults' },
      };
    }
    const session: Session = {
      id, projectId: project.id, ...title, cwd: sourcePath, kind: input.kind, execution,
      started: !!execution.imported,
      engineConfig: this.services.execution.defaultConfig(providerId, mode, configured),
      taskState: 'idle', draft, status: 'idle', archived: false, createdAt: now, updatedAt: now,
    };
    this.services.execution.validateSession(session);
    sessionSchema.parse(session);
    this.projects.set(project.id, (this.projects.get(project.id) ?? 0) + 1);
    try {
      return await this.services.withSessionCreation(sourcePath, input.isolated, async () => {
        assertAdmission();
        if (input.continuation) await resolveDraft();
        const worktree = input.isolated ? await createWorktree(sourcePath, this.store.directory, id, {
          location, customRoot, projectPath: project.path, projectName: project.name,
          name: input.worktreeName?.trim(),
        }, input.worktreeBaseRef) : undefined;
        Object.assign(session, { cwd: worktree || sourcePath, worktree, worktreeBase: worktree ? sourcePath : undefined });
        try {
          assertAdmission();
          if (input.continuation) await resolveDraft();
          this.store.change(state => state.sessions.unshift(session));
        }
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
