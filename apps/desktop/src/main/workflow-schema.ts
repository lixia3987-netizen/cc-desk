import { z } from 'zod';
import { providerIdSchema } from '../shared/schema';

const shortId = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
const date = z.string().datetime();
export const workflowBudgetSchema = z.object({
  maxModelRequests: z.number().int().min(1).max(1000), maxToolCalls: z.number().int().min(1).max(2000),
  maxActiveMs: z.number().int().min(1000).max(7_200_000),
}).strict();
const usageCounters = { modelRequests: z.number().int().min(0).max(100_000), toolCalls: z.number().int().min(0).max(200_000), activeMs: z.number().int().min(0).max(86_400_000) };
const identity = z.object({ sessionId: z.string().uuid(), conversationId: z.string().uuid(), runId: z.string().uuid(),
  requestId: z.string().min(1).max(256), workerGeneration: z.number().int().min(1) }).strict();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const criterion = z.object({ id: shortId, description: z.string().max(1000), stepIds: z.array(shortId).max(64), kind: z.enum(['command', 'manual']) }).strict();
const command = z.object({ executable: z.string().max(4096), argv: z.array(z.string().max(4096)).max(128), cwd: z.string().max(8192) }).strict();
export const workflowNativeReceiptSchema = z.object({
  version: z.literal(1), identity, taskId: z.string().uuid().optional(), taskRevision: z.number().int().min(1).optional(),
  planRevision: z.number().int().min(1).optional(), acceptanceRevision: z.number().int().min(1).optional(),
  verification: z.enum(['unverified', 'verifying', 'passed', 'failed', 'not_applicable', 'stale']).optional(),
  workspace: z.object({ fingerprint: digest, complete: z.boolean(), capturedAt: date }).strict().optional(),
  changes: z.object({ complete: z.boolean(), added: z.array(z.string().max(4096)).max(64), modified: z.array(z.string().max(4096)).max(64),
    removed: z.array(z.string().max(4096)).max(64), attribution: z.literal('observed_since_task_start'), truncated: z.boolean() }).strict().optional(),
  criteria: z.array(criterion).max(32), evidence: z.array(z.object({
    id: z.string().max(128), identity, source: z.enum(['command', 'manual', 'location']), status: z.enum(['unverified', 'passed', 'failed', 'not_applicable']),
    criterionIds: z.array(shortId).max(64), stepIds: z.array(shortId).max(64), planRevision: z.number().int().min(1), acceptanceRevision: z.number().int().min(1),
    workspaceFingerprint: digest, workspaceComplete: z.boolean(), toolCallId: z.string().max(256).optional(), command: command.optional(),
    exitCode: z.number().int().nullable().optional(), outputDigest: digest.optional(), truncated: z.boolean().optional(), stale: z.boolean().optional(),
  }).strict()).max(32), usage: z.object(usageCounters).strict(), truncated: z.boolean(),
}).strict().refine(value => Buffer.byteLength(JSON.stringify(value)) <= 64 * 1024, '阶段成果记录超过 64 KiB，请检查宿主截断标记。');
const stageDefinitionSchema = z.object({
  id: shortId, title: z.string().trim().min(1).max(200),
  instruction: z.string().trim().min(1).max(20_000), dependsOn: z.array(shortId).max(12).default([]),
  gate: z.enum(['none', 'manual', 'native_task']).optional(), criterionIds: z.array(shortId).max(32).optional(),
  toolPolicy: z.enum(['read_only', 'standard']).optional(),
}).strict();
export const newWorkflowSchema = z.object({
  sessionId: z.string().uuid(), title: z.string().trim().min(1).max(200).optional(),
  goal: z.string().trim().min(1).max(20_000),
  stages: z.array(stageDefinitionSchema).min(1).max(12).optional(),
  pauseAfterEachStage: z.boolean().default(false), maxAttempts: z.number().int().min(1).max(3).default(2),
  budget: workflowBudgetSchema.optional(),
}).strict();
export const workflowBindingSchema = z.object({
  providerId: providerIdSchema, executionMode: z.literal('structured'),
  sessionId: z.string().uuid(), projectId: z.string().uuid(), cwd: z.string().min(1).max(8192),
  worktree: z.string().min(1).max(8192).optional(),
});
const stageSchema = stageDefinitionSchema.extend({
  status: z.enum(['pending', 'running', 'waiting_verification', 'waiting_confirmation', 'completed', 'failed', 'cancelled', 'interrupted']),
  attempts: z.number().int().min(0).max(3), maxAttempts: z.number().int().min(1).max(3),
  artifacts: z.array(z.object({
    id: z.string().uuid(), kind: z.literal('summary'), title: z.string().max(250),
    content: z.string().max(100_000), createdAt: date,
  }).strict()).max(3),
  startedAt: date.optional(), finishedAt: date.optional(), error: z.string().max(4000).optional(),
  gateReason: z.string().max(4000).optional(), confirmation: z.object({ decision: z.enum(['approve', 'reject']), reason: z.string().max(4000), at: date }).strict().optional(),
  taskId: z.string().uuid().optional(), executionIds: z.array(z.string().uuid()).max(3).optional(), nativeReceipts: z.array(workflowNativeReceiptSchema).max(3).optional(),
}).strict();
// Only persisted v1 records may omit the executor identity. New bindings must declare it.
const storedBindingSchema = workflowBindingSchema.extend({
  providerId: providerIdSchema.default('claude'), executionMode: z.literal('structured').default('structured'),
});
const runSchema = storedBindingSchema.extend({
  id: z.string().uuid(), title: z.string().min(1).max(200), goal: z.string().min(1).max(20_000),
  status: z.enum(['draft', 'running', 'paused', 'waiting_verification', 'waiting_confirmation', 'completed', 'failed', 'cancelled', 'interrupted']),
  stages: z.array(stageSchema).min(1).max(12), pauseAfterEachStage: z.boolean(),
  createdAt: date, updatedAt: date, error: z.string().max(4000).optional(),
  budget: workflowBudgetSchema.optional(), usage: z.object({ ...usageCounters, recordedExecutionIds: z.array(z.string().uuid()).max(36), complete: z.boolean() }).strict().optional(),
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
      if (['running', 'completed', 'failed', 'interrupted', 'waiting_verification', 'waiting_confirmation'].includes(stage.status) && !stage.attempts) throw new Error('工作流阶段缺少执行次数');
      if (['running', 'completed', 'waiting_verification', 'waiting_confirmation'].includes(stage.status)) {
        if (stage.dependsOn.some(id => run.stages.find(item => item.id === id)?.status !== 'completed')) throw new Error('工作流依赖尚未完成');
      }
    }
    if (run.status === 'completed' && run.stages.some(stage => stage.status !== 'completed')) throw new Error('工作流完成状态无效');
    const waiting = run.stages.filter(stage => ['waiting_verification', 'waiting_confirmation'].includes(stage.status));
    if (waiting.length > 1 || waiting.length && run.status !== waiting[0].status && run.status !== 'cancelled' || ['waiting_verification', 'waiting_confirmation'].includes(run.status) && waiting.length !== 1) throw new Error('工作流等待阶段状态无效');
    for (const stage of run.stages) {
      if (stage.status === 'waiting_verification' && stage.gate !== 'native_task' || stage.status === 'waiting_confirmation' && stage.gate !== 'manual') throw new Error('工作流验收状态与门槛不匹配');
      if (stage.nativeReceipts?.some(receipt => receipt.identity.sessionId !== run.sessionId || !stage.executionIds?.includes(receipt.identity.runId)) || stage.nativeReceipts?.at(-1)?.taskId !== stage.taskId) throw new Error('阶段执行回执身份不匹配');
      if (new Set(stage.executionIds ?? []).size !== (stage.executionIds?.length ?? 0)) throw new Error('重复阶段执行身份');
    }
    if (new Set(run.usage?.recordedExecutionIds ?? []).size !== (run.usage?.recordedExecutionIds.length ?? 0)) throw new Error('工作流用量重复记账');
    if (run.budget && run.providerId !== 'native') throw new Error('工作流累计预算仅支持自研 Agent');
  }
}
