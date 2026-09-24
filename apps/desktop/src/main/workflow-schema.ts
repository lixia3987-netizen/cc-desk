import { z } from 'zod';
import { providerIdSchema } from '../shared/schema';

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
export const workflowBindingSchema = z.object({
  providerId: providerIdSchema, executionMode: z.literal('structured'),
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
// Only persisted v1 records may omit the executor identity. New bindings must declare it.
const storedBindingSchema = workflowBindingSchema.extend({
  providerId: providerIdSchema.default('claude'), executionMode: z.literal('structured').default('structured'),
});
const runSchema = storedBindingSchema.extend({
  id: z.string().uuid(), title: z.string().min(1).max(200), goal: z.string().min(1).max(20_000),
  status: z.enum(['draft', 'running', 'paused', 'completed', 'failed', 'cancelled', 'interrupted']),
  stages: z.array(stageSchema).min(1).max(12), pauseAfterEachStage: z.boolean(),
  createdAt: date, updatedAt: date, error: z.string().max(4000).optional(),
}).strict();
export const MAX_STORED_RUNS = 500;
export const workflowStateSchema = z.object({ version: z.literal(1), runs: z.array(runSchema).max(MAX_STORED_RUNS) }).strict();
export type WorkflowState = z.infer<typeof workflowStateSchema>;

export function validateGraph(stages: { id: string; dependsOn: string[] }[]): void {
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

export function validateWorkflowState(state: WorkflowState): void {
  workflowStateSchema.parse(state);
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
