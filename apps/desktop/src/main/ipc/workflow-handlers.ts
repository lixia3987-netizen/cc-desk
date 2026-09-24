import fs from 'node:fs/promises';
import { dialog, type BrowserWindow } from 'electron';
import { z } from 'zod';
import type { Session } from '../../shared/types';
import { idSchema } from '../../shared/schema';
import { newWorkflowSchema } from '../workflows';
import type { WorkflowEngine } from '../workflows';
import type { Register } from './registration';

interface WorkflowPorts {
  workflows: Pick<WorkflowEngine, 'list' | 'create' | 'start' | 'continue' | 'retry' | 'cancel' | 'remove' | 'exportRun' | 'reviseStage'>;
  structured(id: string): Session;
  assertUnlocked(session: Session): void;
  hasPendingTask(id: string): boolean;
  pauseQueue(id: string): void;
  getWindow(): BrowserWindow | null;
}

const shortId = z.string().min(1).max(200);

export function registerWorkflowHandlers(handle: Register, ports: WorkflowPorts): void {
  handle('workflow:list', idSchema.optional(), id => ports.workflows.list(id));
  handle('workflow:create', newWorkflowSchema, input => {
    if (ports.structured(input.sessionId).permissionMode === 'plan' && !input.stages) {
      throw new Error('默认工作流包含实现阶段，请先手动将权限切换为默认审批，或创建仅规划的自定义阶段。');
    }
    return ports.workflows.create(input);
  });
  const workflowReady = (id: string) => {
    const run = ports.workflows.list().find(run => run.id === id);
    if (!run) throw new Error('工作流不存在。');
    const session = ports.structured(run.sessionId);
    ports.assertUnlocked(session);
    if (ports.hasPendingTask(session.id)) throw new Error('当前会话仍有任务，请等待完成后再开始工作流。');
  };
  handle('workflow:start', idSchema, id => { workflowReady(id); return ports.workflows.start(id); });
  handle('workflow:continue', idSchema, id => { workflowReady(id); return ports.workflows.continue(id); });
  handle('workflow:retry', idSchema, id => { workflowReady(id); return ports.workflows.retry(id); });
  handle('workflow:cancel', idSchema, async id => {
    const run = ports.workflows.list().find(run => run.id === id);
    let failure: unknown;
    if (run) { try { ports.pauseQueue(run.sessionId); } catch (error) { failure = error; } }
    const result = await ports.workflows.cancel(id);
    if (failure) throw failure;
    return result;
  });
  handle('workflow:delete', idSchema, id => ports.workflows.remove(id));
  handle('workflow:export', idSchema, async id => {
    // Capture a stable, inactive record before showing a modal save dialog.
    const content = ports.workflows.exportRun(id);
    const target = await dialog.showSaveDialog(ports.getWindow()!, {
      title: '导出工作流记录', defaultPath: `workflow-${id.slice(0, 8)}.json`,
      filters: [{ name: '工作流记录 JSON', extensions: ['json'] }],
    });
    if (target.canceled || !target.filePath) return null;
    await fs.writeFile(target.filePath, content, { mode: 0o600 });
    return target.filePath;
  });
  handle('workflow:revise', z.object({ id: idSchema, stageId: shortId, instruction: z.string().min(1).max(20000) }), input => {
    return ports.workflows.reviseStage(input.id, input.stageId, input.instruction);
  });
}
