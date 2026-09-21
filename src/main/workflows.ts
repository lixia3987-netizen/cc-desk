import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DEFAULT_WORKFLOW_STAGES } from '../shared/workflows';
import type { NewWorkflow, WorkflowBinding, WorkflowRun, WorkflowStage, WorkflowStageResult } from '../shared/workflows';

const shortId = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
const date = z.string().datetime();
const stageDefinitionSchema = z.object({
  id: shortId, title: z.string().trim().min(1).max(200),
  instruction: z.string().trim().min(1).max(20_000), dependsOn: z.array(shortId).max(12).default([]),
}).strict();
export const newWorkflowSchema = z.object({
  sessionId: z.string().uuid(), title: z.string().trim().min(1).max(200).optional(),
  goal: z.string().trim().min(1).max(20_000),
  stages: z.array(stageDefinitionSchema).min(1).max(12).optional(),
  pauseAfterEachStage: z.boolean().default(false), maxAttempts: z.number().int().min(1).max(3).default(2),
}).strict();
const bindingSchema = z.object({
  sessionId: z.string().uuid(), projectId: z.string().uuid(), cwd: z.string().min(1).max(8192),
  worktree: z.string().min(1).max(8192).optional(),
});
const stageSchema = stageDefinitionSchema.extend({
  status: z.enum(['pending', 'running', 'completed', 'failed', 'cancelled', 'interrupted']),
  attempts: z.number().int().min(0).max(3), maxAttempts: z.number().int().min(1).max(3),
  artifacts: z.array(z.object({
    id: z.string().uuid(), kind: z.literal('summary'), title: z.string().max(250),
    content: z.string().max(100_000), createdAt: date,
  }).strict()).max(3),
  startedAt: date.optional(), finishedAt: date.optional(), error: z.string().max(4000).optional(),
}).strict();
const runSchema = bindingSchema.extend({
  id: z.string().uuid(), title: z.string().min(1).max(200), goal: z.string().min(1).max(20_000),
  status: z.enum(['draft', 'running', 'paused', 'completed', 'failed', 'cancelled', 'interrupted']),
  stages: z.array(stageSchema).min(1).max(12), pauseAfterEachStage: z.boolean(),
  createdAt: date, updatedAt: date, error: z.string().max(4000).optional(),
}).strict();
const stateSchema = z.object({ version: z.literal(1), runs: z.array(runSchema).max(500) }).strict();
type WorkflowState = z.infer<typeof stateSchema>;

interface ActiveRun { cancelled: boolean; completion: Promise<void> }
export interface WorkflowEngineOptions {
  /** Must reject deleted, archived, non-Claude, or non-structured sessions. */
  getSession(sessionId: string): WorkflowBinding;
  /** Resolves only after a real structured turn result (not after writing stdin). */
  runStage(sessionId: string, prompt: string): Promise<WorkflowStageResult>;
  cancelSession(sessionId: string): void | Promise<void>;
  onChange?(runs: WorkflowRun[]): void;
}

function validateGraph(stages: { id: string; dependsOn: string[] }[]): void {
  const ids = new Set(stages.map(stage => stage.id));
  if (ids.size !== stages.length) throw new Error('工作流阶段 ID 不能重复');
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error('工作流依赖不能成环');
    visiting.add(id);
    const stage = stages.find(item => item.id === id)!;
    if (new Set(stage.dependsOn).size !== stage.dependsOn.length) throw new Error('工作流依赖不能重复');
    for (const dependency of stage.dependsOn) {
      if (!ids.has(dependency)) throw new Error(`工作流阶段不存在：${dependency}`);
      visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const stage of stages) visit(stage.id);
}

function validateState(state: WorkflowState): void {
  stateSchema.parse(state);
  const ids = new Set<string>();
  for (const run of state.runs) {
    if (ids.has(run.id)) throw new Error('重复工作流 ID');
    ids.add(run.id);
    validateGraph(run.stages);
    if (run.stages.filter(stage => stage.status === 'running').length > 1) throw new Error('顺序工作流不能同时运行多个阶段');
    for (const stage of run.stages) {
      if (stage.attempts > stage.maxAttempts) throw new Error('工作流重试次数超出限制');
      if (['running', 'completed', 'failed', 'interrupted'].includes(stage.status) && !stage.attempts) throw new Error('工作流阶段缺少执行次数');
      if (stage.status === 'running' || stage.status === 'completed') {
        if (stage.dependsOn.some(id => run.stages.find(item => item.id === id)?.status !== 'completed')) throw new Error('工作流依赖尚未完成');
      }
    }
    if (run.status === 'completed' && run.stages.some(stage => stage.status !== 'completed')) throw new Error('工作流完成状态无效');
  }
}

function errorText(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 4000); }

/** Sequential, durable orchestration. Cancellation never rolls back filesystem effects. */
export class WorkflowEngine {
  readonly file: string;
  private state: WorkflowState = { version: 1, runs: [] };
  private readonly active = new Map<string, ActiveRun>();
  private readonly sessionOwners = new Map<string, string>();
  private closed = false;

  constructor(directory: string, private readonly options: WorkflowEngineOptions) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.file = path.join(directory, 'workflows.json');
    if (!fs.existsSync(this.file)) return;
    try {
      if (fs.statSync(this.file).size > 64 * 1024 * 1024) throw new Error('工作流存档过大');
      this.state = stateSchema.parse(JSON.parse(fs.readFileSync(this.file, 'utf8')));
      validateState(this.state);
    } catch { throw new Error(`工作流数据无法读取，原文件已保留：${this.file}。可从 workflows.json.bak 恢复。`); }
    if (this.state.runs.some(run => run.status === 'running')) {
      this.commit(state => {
        for (const run of state.runs) {
          if (run.status !== 'running') continue;
          run.status = 'interrupted';
          run.error = '应用关闭时工作流尚未完成。请检查现有文件与执行记录后，手动继续；已产生的操作不会自动撤销。';
          run.updatedAt = new Date().toISOString();
          for (const stage of run.stages) if (stage.status === 'running') stage.status = 'interrupted';
        }
      });
    }
  }

  list(sessionId?: string): WorkflowRun[] {
    return structuredClone(this.state.runs.filter(run => !sessionId || run.sessionId === sessionId));
  }

  create(input: NewWorkflow): WorkflowRun {
    if (this.closed) throw new Error('工作流引擎正在关闭');
    const parsed = newWorkflowSchema.parse(input);
    const binding = bindingSchema.parse(this.options.getSession(parsed.sessionId));
    if (binding.sessionId !== parsed.sessionId) throw new Error('工作流会话绑定不匹配');
    const definitions = parsed.stages ?? DEFAULT_WORKFLOW_STAGES;
    const stages: WorkflowStage[] = definitions.map(stage => ({
      ...stage, dependsOn: [...(stage.dependsOn ?? [])], status: 'pending', attempts: 0,
      maxAttempts: parsed.maxAttempts, artifacts: [],
    }));
    validateGraph(stages);
    const now = new Date().toISOString();
    const run: WorkflowRun = {
      ...binding, id: randomUUID(), title: parsed.title ?? parsed.goal.slice(0, 80),
      goal: parsed.goal, status: 'draft', stages, pauseAfterEachStage: parsed.pauseAfterEachStage,
      createdAt: now, updatedAt: now,
    };
    this.commit(state => state.runs.unshift(run));
    return structuredClone(run);
  }

  start(id: string): WorkflowRun {
    const run = this.get(id);
    if (run.status !== 'draft') throw new Error('仅新建工作流可以启动；暂停后请继续，失败后请重试');
    return this.launch(id);
  }

  continue(id: string): WorkflowRun {
    const run = this.get(id);
    if (!['paused', 'interrupted'].includes(run.status)) throw new Error('仅暂停或中断的工作流可以继续');
    const interrupted = run.stages.find(stage => stage.status === 'interrupted');
    if (interrupted && interrupted.attempts >= interrupted.maxAttempts) throw new Error('中断阶段已达到执行次数上限，请检查现有结果后新建工作流');
    return this.launch(id, 'interrupted');
  }

  retry(id: string): WorkflowRun {
    const run = this.get(id);
    if (run.status !== 'failed') throw new Error('仅失败的工作流可以重试');
    const failed = run.stages.find(stage => stage.status === 'failed');
    if (!failed) throw new Error('没有可重试的阶段');
    if (failed.attempts >= failed.maxAttempts) throw new Error('该阶段已达到执行次数上限；请检查现有结果后新建工作流');
    return this.launch(id, 'failed');
  }

  reviseStage(id: string, stageId: string, instruction: string): WorkflowRun {
    const text = z.string().trim().min(1).max(20_000).parse(instruction);
    if (this.active.has(id)) throw new Error('请先停止当前执行再修改阶段');
    const run = this.get(id);
    if (['completed', 'cancelled'].includes(run.status)) throw new Error('已结束的工作流不能修改');
    const stage = run.stages.find(item => item.id === stageId);
    if (!stage || stage.status === 'completed') throw new Error('只能修改尚未完成的阶段');
    this.update(id, draft => { draft.stages.find(item => item.id === stageId)!.instruction = text; });
    return this.get(id);
  }

  async cancel(id: string): Promise<WorkflowRun> {
    const run = this.get(id);
    if (['completed', 'cancelled'].includes(run.status)) return run;
    const token = this.active.get(id);
    // Invalidate late completions before awaiting the process termination callback.
    if (token) token.cancelled = true;
    this.update(id, draft => {
      draft.status = 'cancelled';
      draft.error = '工作流已取消；已执行的文件或外部操作不会自动撤销。';
      for (const stage of draft.stages) if (stage.status === 'running') {
        stage.status = 'cancelled'; stage.finishedAt = new Date().toISOString();
      }
    });
    if (token) {
      try { await this.options.cancelSession(run.sessionId); }
      catch (error) { this.update(id, draft => { draft.error = `工作流已取消，但会话停止失败：${errorText(error)}`.slice(0, 4000); }); }
    }
    return this.get(id);
  }

  isSessionBusy(sessionId: string): boolean { return this.sessionOwners.has(sessionId); }

  async wait(id: string): Promise<WorkflowRun> {
    await this.active.get(id)?.completion;
    return this.get(id);
  }

  /** Called on application shutdown; restarting never silently repeats a tool call. */
  async shutdown(): Promise<void> {
    this.closed = true;
    const running = [...this.active.entries()];
    for (const [id, token] of running) {
      token.cancelled = true;
      this.update(id, run => {
        if (run.status !== 'running') return;
        run.status = 'interrupted'; run.error = '应用退出导致工作流中断，请检查现有结果后手动继续。';
        for (const stage of run.stages) if (stage.status === 'running') stage.status = 'interrupted';
      });
    }
    await Promise.allSettled(running.map(([id]) => this.options.cancelSession(this.get(id).sessionId)));
  }

  private get(id: string): WorkflowRun {
    const run = this.state.runs.find(item => item.id === id);
    if (!run) throw new Error('工作流不存在');
    return structuredClone(run);
  }

  private assertBinding(run: WorkflowRun): void {
    const current = bindingSchema.parse(this.options.getSession(run.sessionId));
    if (current.sessionId !== run.sessionId || current.projectId !== run.projectId || current.cwd !== run.cwd || current.worktree !== run.worktree) {
      throw new Error('会话的项目或工作目录已改变，不能继续执行此工作流');
    }
  }

  private launch(id: string, resetStatus?: 'failed' | 'interrupted'): WorkflowRun {
    if (this.closed) throw new Error('工作流引擎正在关闭');
    const run = this.get(id);
    if (this.active.has(id) || this.sessionOwners.has(run.sessionId)) throw new Error('此会话已有工作流正在运行或停止中');
    this.assertBinding(run);
    this.update(id, draft => {
      draft.status = 'running'; delete draft.error;
      if (resetStatus) for (const stage of draft.stages) if (stage.status === resetStatus) {
        stage.status = 'pending'; delete stage.error;
      }
    });
    const token: ActiveRun = { cancelled: false, completion: Promise.resolve() };
    this.active.set(id, token);
    this.sessionOwners.set(run.sessionId, id);
    token.completion = Promise.resolve().then(() => this.execute(id, token)).catch(error => {
      if (token.cancelled) return;
      // Storage errors stop dispatch; never continue into another stage after a failed save.
      try { this.update(id, draft => {
        draft.status = 'interrupted'; draft.error = errorText(error);
        for (const stage of draft.stages) if (stage.status === 'running') stage.status = 'interrupted';
      }); } catch { /* Preserve the last durable state for recovery on next launch. */ }
    }).finally(() => {
      if (this.active.get(id) === token) this.active.delete(id);
      if (this.sessionOwners.get(run.sessionId) === id) this.sessionOwners.delete(run.sessionId);
    });
    return this.get(id);
  }

  private async execute(id: string, token: ActiveRun): Promise<void> {
    while (!token.cancelled) {
      const run = this.get(id);
      const stage = run.stages.find(item => item.status === 'pending' && item.dependsOn.every(dependency => run.stages.find(other => other.id === dependency)?.status === 'completed'));
      if (!stage) {
        if (run.stages.every(item => item.status === 'completed')) this.update(id, draft => { draft.status = 'completed'; });
        else throw new Error('工作流没有可执行阶段，请检查依赖和阶段状态');
        return;
      }
      if (stage.attempts >= stage.maxAttempts) throw new Error('阶段已达到执行次数上限');
      this.assertBinding(run);
      this.update(id, draft => {
        const current = draft.stages.find(item => item.id === stage.id)!;
        current.status = 'running'; current.attempts += 1; current.startedAt = new Date().toISOString();
        delete current.finishedAt; delete current.error;
      });
      let result: WorkflowStageResult;
      try { result = await this.options.runStage(run.sessionId, this.prompt(run, stage)); }
      catch (error) { result = { success: false, summary: '', error: errorText(error) }; }
      if (token.cancelled) return;
      if (!result || typeof result.success !== 'boolean' || typeof result.summary !== 'string') {
        result = { success: false, summary: '', error: '会话未返回有效的结构化阶段结果' };
      }
      this.update(id, draft => {
        const current = draft.stages.find(item => item.id === stage.id)!;
        const now = new Date().toISOString();
        current.finishedAt = now;
        if (result.summary) current.artifacts.push({
          id: randomUUID(), kind: 'summary', title: `${current.title} · 第 ${current.attempts} 次`,
          content: result.summary.slice(0, 100_000), createdAt: now,
        });
        if (!result.success) {
          current.status = 'failed'; current.error = (result.error || '阶段执行失败，请检查对话和工具结果').slice(0, 4000);
          draft.status = 'failed'; draft.error = current.error;
        } else {
          current.status = 'completed';
          if (draft.stages.every(item => item.status === 'completed')) draft.status = 'completed';
          else if (draft.pauseAfterEachStage) draft.status = 'paused';
        }
      });
      if (this.get(id).status !== 'running') return;
    }
  }

  private prompt(run: WorkflowRun, stage: WorkflowStage): string {
    const dependencies = stage.dependsOn.map(id => {
      const previous = run.stages.find(item => item.id === id)!;
      return `### ${previous.title}\n${previous.artifacts.at(-1)?.content.slice(0, 8000) || '此阶段已完成，请参照本会话历史。'}`;
    }).join('\n\n');
    return [
      `你正在执行工作流「${run.title}」的「${stage.title}」阶段。`,
      `用户目标：\n${run.goal}`, `本阶段要求：\n${stage.instruction}`,
      dependencies ? `已完成的前置阶段：\n${dependencies}` : '',
      stage.attempts > 0 ? '这是用户手动发起的再次执行。先核查已有改动与工具结果，避免重复具有副作用的操作。' : '',
      '保持当前会话的项目与工作目录，遵守现有权限和审批；不要自行跳过审批或另开独立执行任务。完成后明确报告实际产物、验证结果及仍需人工处理的事项。',
    ].filter(Boolean).join('\n\n');
  }

  private update(id: string, mutate: (run: WorkflowRun) => void): void {
    this.commit(state => {
      const run = state.runs.find(item => item.id === id);
      if (!run) throw new Error('工作流不存在');
      mutate(run); run.updatedAt = new Date().toISOString();
    });
  }

  private commit(mutate: (state: WorkflowState) => void): void {
    const next = structuredClone(this.state);
    mutate(next); validateState(next);
    const encoded = JSON.stringify(next, null, 2);
    if (Buffer.byteLength(encoded) > 64 * 1024 * 1024) throw new Error('工作流存档已达到容量限制');
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      fd = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(fd, encoded); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      if (fs.existsSync(this.file)) fs.copyFileSync(this.file, `${this.file}.bak`);
      fs.renameSync(temporary, this.file);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      fs.rmSync(temporary, { force: true });
    }
    this.state = next;
    // Rendering failures must not cause retries of already completed stage side effects.
    try { this.options.onChange?.(this.list()); } catch { /* State remains durable. */ }
  }
}
