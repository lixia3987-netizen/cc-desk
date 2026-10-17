import { z } from 'zod';
import { providerIdSchema } from '../shared/schema';
import { nativeWorkflowQualitySchema } from './native-workflow-quality-schema';
import { nativeQualityFindingsForRound } from './engines/native/workflow-quality-report';
import type { WorkflowCollaboration, WorkflowNativeReceipt } from '../shared/workflows';
export { nativeWorkflowQualitySchema as workflowQualitySchema } from './native-workflow-quality-schema';

const shortId = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
const date = z.string().datetime();
const collaboration = z.enum(['auto', 'single_agent', 'parallel', 'adversarial']);
/** 仅为兼容旧版请求、草稿和存档保留；不再约束 Native 主任务。 */
export const workflowBudgetSchema = z.object({
  maxModelRequests: z.number().int().min(1).max(1000), maxToolCalls: z.number().int().min(1).max(2000),
  maxActiveMs: z.number().int().min(1000).max(7_200_000),
}).strict();
const usageCounters = { modelRequests: z.number().int().min(0), toolCalls: z.number().int().min(0), activeMs: z.number().int().min(0) };
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
  }).strict()).max(32), usage: z.object(usageCounters).strict(), truncated: z.boolean(), workflowQuality: nativeWorkflowQualitySchema.optional(),
}).strict().refine(value => Buffer.byteLength(JSON.stringify(value)) <= 64 * 1024, '阶段成果记录超过 64 KiB，请检查宿主截断标记。');

/** 独立自动审查不能由阶段成功文本或人工验收代替。旧工作流没有策略字段时保持兼容。 */
export function workflowQualityFailure(receipt: WorkflowNativeReceipt | undefined, mode: WorkflowCollaboration, validationMode: 'commands' | 'static' = 'commands'): string | undefined {
  if (mode === 'single_agent') return;
  const quality = receipt?.workflowQuality;
  if (!receipt || !quality) return '缺少宿主独立质量审查记录，不能完成本阶段。';
  const sameIdentity = (left: typeof receipt.identity, right: typeof receipt.identity): boolean =>
    (['sessionId', 'conversationId', 'runId', 'requestId', 'workerGeneration'] as const).every(key => left[key] === right[key]);
  if (!sameIdentity(quality.parentIdentity, receipt.identity) || quality.taskId !== receipt.taskId || quality.collaboration !== mode) return '独立质量审查身份或协作策略与本阶段不匹配。';
  if (quality.status !== 'passed' || quality.automaticReview !== 'passed') return '独立质量审查尚未通过，不能完成本阶段。';
  if (quality.validationMode !== validationMode) return validationMode === 'commands' ? '标准实现阶段需要独立执行验证，不能用静态审查替代。' : '只读交付需要独立静态审查，不能执行命令或写入文件。';
  if (!receipt.workspace?.complete || quality.workspaceFingerprint !== receipt.workspace.fingerprint) return '工作区版本已变化或核查不完整，独立质量审查证据已过期。';
  const latest = quality.rounds.at(-1);
  if (!latest || quality.rounds.length !== quality.round || quality.rounds.some((round, index) => round.round !== index + 1)
    || latest.round !== quality.round || latest.status !== 'passed' || latest.issues.length || !latest.snapshotCommit || !latest.snapshotTree || !latest.deliveryDigest || latest.parentFingerprint !== quality.workspaceFingerprint) return '独立质量审查缺少针对最终工作区版本及交付正文的通过轮次。';
  if (quality.findings.some(finding => finding.severity === 'blocking' || finding.severity === 'high')) return '独立质量审查仍有未关闭的阻塞问题。';
  const childIds = quality.rounds.flatMap(round => round.roles.map(role => role.childId));
  const runIds = quality.rounds.flatMap(round => round.roles.map(role => role.identity.runId));
  const sessionIds = quality.rounds.flatMap(round => round.roles.map(role => role.identity.sessionId));
  const conversationIds = quality.rounds.flatMap(round => round.roles.map(role => role.identity.conversationId));
  if (new Set(childIds).size !== childIds.length || new Set(runIds).size !== runIds.length || runIds.includes(receipt.identity.runId)
    || new Set(sessionIds).size !== sessionIds.length || sessionIds.includes(receipt.identity.sessionId)
    || new Set(conversationIds).size !== conversationIds.length || conversationIds.includes(receipt.identity.conversationId)) return '独立质量审查必须为每个角色与重验轮次创建新的执行身份。';
  const previousBlocking = quality.rounds.slice(0, -1).flatMap(round => nativeQualityFindingsForRound(round.roles))
    .filter(finding => finding.severity === 'blocking' || finding.severity === 'high');
  for (const expected of ['reviewer', 'challenger', 'verifier'] as const) {
    const roles = latest.roles.filter(role => role.role === expected), role = roles[0], report = role?.report;
    if (roles.length !== 1 || role.status !== 'completed' || !report || report.role !== expected || report.round !== latest.round
      || !sameIdentity(report.identity, role.identity) || report.taskId !== role.taskId || report.snapshotCommit !== latest.snapshotCommit || report.deliveryDigest !== latest.deliveryDigest) return '独立质量审查角色尚未完成，或报告没有绑定最终快照及交付正文。';
    if (report.declaration.verdict !== 'passed' || report.declaration.limitations.length || report.declaration.findings.some(finding => finding.severity === 'blocking' || finding.severity === 'high')) return '独立审查仍有阻塞发现或验证范围缺失。';
    if (role.identity.sessionId === receipt.identity.sessionId || role.identity.conversationId === receipt.identity.conversationId
      || report.declaration.reviewedPaths.some(path => !report.materialReads.some(read => read.path === path))) return '独立审查缺少新上下文或实际材料读取记录。';
    if (previousBlocking.some(finding => !report.declaration.resolutions.some(resolution => resolution.findingId === finding.id && resolution.status === 'resolved'
      && resolution.evidence.length && resolution.evidence.every(evidence => report.materialReads.some(read => read.toolCallId === evidence.toolCallId && read.path === evidence.path && read.fileHash === evidence.fileHash))))) return '此前阻塞问题尚未通过新轮次独立核验关闭。';
    const check = report.declaration.verification;
    if (report.commandReceipts.some(command => !command.successful || command.exitCode !== 0)) return '独立验证仍有失败或未完成的真实命令回执。';
    if (validationMode === 'static' && (check.status !== 'not_applicable' || !check.reason.trim() || check.commandToolCallIds.length || report.commandReceipts.length)) return '静态独立验证必须说明不执行测试的原因，且没有命令回执。';
    if (validationMode === 'commands' && expected === 'verifier'
      && (check.status !== 'executed' || !check.commandToolCallIds.length || check.commandToolCallIds.some(id => !report.commandReceipts.some(command => command.toolCallId === id && command.successful && command.exitCode === 0)))) return '独立验证缺少成功执行的真实命令回执。';
  }
}
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
  collaboration: collaboration.optional(),
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
// 仅持久化的 v1 记录可省略执行器身份。新绑定必须声明该身份。
const storedBindingSchema = workflowBindingSchema.extend({
  providerId: providerIdSchema.default('claude'), executionMode: z.literal('structured').default('structured'),
});
const runSchema = storedBindingSchema.extend({
  id: z.string().uuid(), title: z.string().min(1).max(200), goal: z.string().min(1).max(20_000),
  status: z.enum(['draft', 'running', 'paused', 'waiting_verification', 'waiting_confirmation', 'completed', 'failed', 'cancelled', 'interrupted']),
  stages: z.array(stageSchema).min(1).max(12), pauseAfterEachStage: z.boolean(),
  collaboration: collaboration.optional(),
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
      if (run.providerId === 'native' && run.collaboration && run.collaboration !== 'single_agent' && stage.toolPolicy !== 'read_only'
        && ['completed', 'waiting_verification', 'waiting_confirmation'].includes(stage.status)) {
        const failure = workflowQualityFailure(stage.nativeReceipts?.at(-1), run.collaboration);
        if (failure) throw new Error(`阶段独立质量记录无效：${failure}`);
      }
    }
    if (new Set(run.usage?.recordedExecutionIds ?? []).size !== (run.usage?.recordedExecutionIds.length ?? 0)) throw new Error('工作流用量重复记账');
    if (run.providerId === 'native' && run.collaboration && run.collaboration !== 'single_agent' && run.stages.every(stage => stage.toolPolicy === 'read_only')
      && run.stages.every(stage => ['completed', 'waiting_confirmation', 'waiting_verification'].includes(stage.status))) {
      const latest = run.usage?.recordedExecutionIds.at(-1), receipt = run.stages.flatMap(stage => stage.nativeReceipts ?? []).find(item => item.identity.runId === latest);
      const failure = workflowQualityFailure(receipt, run.collaboration, 'static');
      if (failure) throw new Error(`只读交付独立质量记录无效：${failure}`);
    }
    if (run.budget && run.providerId !== 'native') throw new Error('工作流累计预算仅支持自研 Agent');
    if (run.collaboration && run.providerId !== 'native') throw new Error('工作流协作策略仅支持自研 Agent');
  }
}
