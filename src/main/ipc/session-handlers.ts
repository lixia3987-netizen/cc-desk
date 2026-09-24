import { z } from 'zod';
import type { Session } from '../../shared/types';
import { idSchema, panelDraftsSchema, sessionInputSchema } from '../../shared/schema';
import type { StateStore } from '../store';
import type { StructuredExecutions, TerminalExecutions } from '../execution/routers';
import type { Attachments } from '../attachments';
import type { WorkflowEngine } from '../workflows';
import type { Register } from './registration';

interface SessionPorts {
  store: Pick<StateStore, 'state' | 'change'>;
  chat: Pick<StructuredExecutions, 'has' | 'stopIdle' | 'updateConfig' | 'forget'>;
  runtime: Pick<TerminalExecutions, 'has' | 'forget'>;
  workflows: Pick<WorkflowEngine, 'isSessionBusy' | 'removeSession'>;
  attachments: Pick<Attachments, 'remove'>;
  session(id: string): Session;
  taskOccupied(id: string): boolean;
  admissionPending(id: string): boolean;
  manage<T>(id: string, action: () => T | Promise<T>): Promise<T>;
  select(id: string): void;
  export(id: string): Promise<string | null>;
  onState(): void;
  forgetQueue(id: string): void;
}

const updateSchema = z.object({
  id: idSchema, title: z.string().trim().min(1).max(120).optional(), archived: z.boolean().optional(),
  model: sessionInputSchema.shape.model.optional(), effort: sessionInputSchema.shape.effort.optional(),
  permissionMode: sessionInputSchema.shape.permissionMode.optional(),
});
const deleteSchema = z.union([idSchema, z.object({ id: idSchema, preserveWorktree: z.literal(true) }).strict()]);

export function registerSessionHandlers(handle: Register, ports: SessionPorts): void {
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
    const save = () => ports.store.change(state => Object.assign(state.sessions.find(item => item.id === session.id)!, input,
      input.title !== undefined ? { titleSource: 'manual' } : {},
      input.permissionMode ? { observedPermissionMode: input.permissionMode } : {},
      { updatedAt: new Date().toISOString() }));
    const configChanged = input.model !== undefined || input.effort !== undefined || input.permissionMode !== undefined;
    if (configChanged) {
      if (ports.workflows.isSessionBusy(session.id) || ports.admissionPending(session.id)) throw new Error('请等待当前任务完成后再修改配置。');
      if (ports.runtime.has(session.id)) throw new Error('终端模式请停止会话后修改启动配置。');
      await ports.manage(session.id, async () => {
        if (input.archived && ports.chat.has(session.id)) await ports.chat.stopIdle(session.id);
        if (session.execution.mode === 'structured') {
          await ports.chat.updateConfig(session.id, { model: input.model, effort: input.effort, permissionMode: input.permissionMode });
        }
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
    const preserveWorktree = typeof input !== 'string' && input.preserveWorktree;
    return ports.manage(id, async () => {
      const session = ports.session(id);
      if (ports.taskOccupied(id)) throw new Error('请先停止会话及工作流，再删除。');
      if (session.worktree && !preserveWorktree) throw new Error('请先在 Git 面板检查并清理独立 worktree，或选择“仅删除会话，保留隔离目录”。');
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
    });
  });
  handle('session:export', idSchema, id => ports.export(id));
}
