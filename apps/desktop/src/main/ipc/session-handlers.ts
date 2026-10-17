import { z } from 'zod';
import { NATIVE_PERMISSION_MODES } from '../../shared/native-permissions';
import { changeNativePermissionForNextTurn } from '../native-session-permission';
import { assertNativeSkillConfigChangeAllowed } from '../engines/native/skill-config-guard';
import type { EngineConfig, Session } from '../../shared/types';
import { engineConfigSchema, idSchema, panelDraftsSchema } from '../../shared/schema';
import type { StateStore } from '../store';
import type { StructuredExecutions, TerminalExecutions } from '../execution/routers';
import type { Attachments } from '../attachments';
import type { WorkflowEngine } from '../workflows';
import type { Register } from './registration';
import { forceCleanupWorktree } from '../git';

interface SessionPorts {
  store: Pick<StateStore, 'state' | 'change'>;
  chat: Pick<StructuredExecutions, 'has' | 'stopIdle' | 'updateConfig' | 'forget'>;
  runtime: Pick<TerminalExecutions, 'has' | 'forget'>;
  workflows: Pick<WorkflowEngine, 'isSessionBusy' | 'removeSession'>;
  attachments: Pick<Attachments, 'remove'>;
  session(id: string): Session;
  validateConfig(id: string, config: EngineConfig): EngineConfig;
  assertPermissionChangeAllowed?(session: Session): void;
  taskOccupied(id: string): boolean;
  admissionPending(id: string): boolean;
  manage<T>(id: string, action: () => T | Promise<T>): Promise<T>;
  manageWorktreeDeletion<T>(id: string, confirmedPath: string, action: (session: Session) => Promise<T>): Promise<T>;
  worktreeBase(session: Session): string;
  cleanupDependencies(session: Session): boolean;
  select(id: string): void;
  export(id: string): Promise<string | null>;
  onState(): void;
  forgetQueue(id: string): void;
}

const updateSchema = z.object({
  id: idSchema, title: z.string().trim().min(1).max(120).optional(), archived: z.boolean().optional(),
  engineConfig: engineConfigSchema.optional(),
}).strict();
const deleteSchema = z.union([
  idSchema,
  z.object({ id: idSchema, preserveWorktree: z.literal(true) }).strict(),
  z.object({ id: idSchema, forceWorktree: z.literal(true), worktreePath: z.string().min(1).max(4096).refine(path => !/[\x00-\x1f\x7f]/.test(path)) }).strict(),
]);

export function registerSessionHandlers(handle: Register, ports: SessionPorts): void {
  handle('session:native-permission', z.object({ id: idSchema, mode: z.enum(NATIVE_PERMISSION_MODES) }).strict(), ({ id, mode }) =>
    changeNativePermissionForNextTurn(id, mode, {
      session: ports.session,
      assertAllowed: session => {
        if (!ports.assertPermissionChangeAllowed) throw new Error('权限修改入口尚未就绪。');
        ports.assertPermissionChangeAllowed(session);
      },
      validateConfig: ports.validateConfig,
      commit: (sessionId, config) => ports.store.change(state => {
        const saved = state.sessions.find(item => item.id === sessionId)!;
        saved.engineConfig = config;
        saved.updatedAt = new Date().toISOString();
      }),
      changed: ports.onState,
    }));

  const removeRecord = async (id: string) => {
    if (ports.taskOccupied(id)) throw new Error('请先停止会话及工作流，再删除。');
    await ports.chat.stopIdle(id);
    ports.workflows.removeSession(id);
    ports.runtime.forget(id);
    ports.chat.forget(id);
    ports.forgetQueue(id);
    await ports.attachments.remove(id);
    ports.store.change(state => {
      state.sessions = state.sessions.filter(session => session.id !== id);
      if (state.selectedSessionId === id) state.selectedSessionId = '';
    });
    ports.onState();
  };
  handle('session:panel-drafts', z.object({ id: idSchema, patch: panelDraftsSchema }), ({ id, patch }) => {
    ports.session(id);
    const changed = ports.store.change(state => {
      const session = state.sessions.find(session => session.id === id)!;
      session.panelDrafts = { ...session.panelDrafts, ...patch };
    }, { defer: true });
    if (changed) ports.onState();
  });
  handle('session:draft', z.object({ id: idSchema, text: z.string().max(128 * 1024) }), ({ id, text }) => {
    if (ports.session(id).draft === text) return;
    ports.store.change(state => { state.sessions.find(session => session.id === id)!.draft = text; }, { defer: true });
    ports.onState();
  });
  handle('session:select', z.union([idSchema, z.literal('')]), id => ports.select(id));
  handle('session:update', updateSchema, async input => {
    const session = ports.session(input.id);
    if (input.archived && ports.taskOccupied(session.id)) throw new Error('请先停止会话和工作流，再归档。');
    const { engineConfig, ...metadata } = input;
    const save = () => ports.store.change(state => Object.assign(state.sessions.find(item => item.id === session.id)!, metadata,
      input.title !== undefined ? { titleSource: 'manual' } : {},
      { updatedAt: new Date().toISOString() }));
    const configChanged = engineConfig !== undefined;
    if (configChanged) {
      if (ports.workflows.isSessionBusy(session.id) || ports.admissionPending(session.id)) throw new Error('请等待当前任务完成后再修改配置。');
      if (ports.runtime.has(session.id)) throw new Error('终端模式请停止会话后修改启动配置。');
      await ports.manage(session.id, async () => {
        const validated = ports.validateConfig(session.id, engineConfig);
        if (session.execution.providerId === 'native') assertNativeSkillConfigChangeAllowed(ports.session(session.id).engineConfig, validated);
        if (input.archived && ports.chat.has(session.id)) await ports.chat.stopIdle(session.id);
        if (session.execution.mode === 'structured') {
          // 提供方提交每项已确认变更；不能用请求中的旧视图
          // 覆盖已经部分应用的实时配置。
          await ports.chat.updateConfig(session.id, validated);
        } else ports.store.change(state => { state.sessions.find(item => item.id === session.id)!.engineConfig = validated; });
        save();
      });
      ports.onState();
      return;
    }
    if (input.archived) await ports.manage(session.id, async () => { await ports.chat.stopIdle(session.id); save(); });
    else save();
    ports.onState();
  });
  handle('session:delete', deleteSchema, input => {
    const id = typeof input === 'string' ? input : input.id;
    if (typeof input !== 'string' && 'forceWorktree' in input) {
      // 使用与安全清理相同的目录锁和工作进程释放屏障。
      // 强制操作仅放宽 Git 的干净与已合并检查，不放宽资源所有权检查。
      return ports.manageWorktreeDeletion(id, input.worktreePath, async session => {
        if (session.worktree !== input.worktreePath) throw new Error('隔离目录已改变，请重新打开删除确认后重试。');
        if (ports.cleanupDependencies(session)) throw new Error('其他会话的工作目录或 worktree 来源依赖此目录，不能强制删除。');
        const result = await forceCleanupWorktree(ports.worktreeBase(session), session.worktree!, id);
        if (!result.ok) throw new Error(result.message);
        try {
          // 记录已完成的文件系统步骤，以便后续附件或历史
          // 移除失败时，按普通的仅记录删除流程重试。
          ports.store.change(state => {
            const saved = state.sessions.find(item => item.id === id)!;
            saved.worktree = undefined;
            saved.archived = true;
            saved.error = '隔离目录已强制删除；会话记录尚未删除，可再次删除会话。';
          });
          ports.onState();
          await removeRecord(id);
        } catch (error) {
          throw new Error('隔离目录已强制删除，但会话记录未完全删除。可选择仅删除会话重试：' + (error instanceof Error ? error.message : String(error)));
        }
      });
    }
    const preserveWorktree = typeof input !== 'string' && 'preserveWorktree' in input && input.preserveWorktree;
    return ports.manage(id, async () => {
      const session = ports.session(id);
      if (ports.taskOccupied(id)) throw new Error('请先停止会话及工作流，再删除。');
      if (session.worktree && !preserveWorktree) throw new Error('请先在 Git 面板检查并清理独立 worktree，或选择“仅删除会话，保留隔离目录”。');
      await removeRecord(id);
    });
  });
  handle('session:export', idSchema, id => ports.export(id));
}
