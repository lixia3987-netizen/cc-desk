import type { NativeWorkflowQualityState } from './native-workflow-quality.js';

/** 持久化的工程任务状态，绝不替代运行层面的 RunStatus。 */
export interface NativeTaskIdentity {
  sessionId: string; conversationId: string; runId: string; requestId: string; workerGeneration: number;
}
export type NativeTaskStepStatus = 'pending' | 'in_progress' | 'implemented' | 'blocked' | 'interrupted';
export type NativeTaskVerification = 'unverified' | 'verifying' | 'passed' | 'failed' | 'not_applicable' | 'stale';
export interface NativeTaskStep {
  id: string; title: string; dependsOn: string[]; status: NativeTaskStepStatus; blockedReason?: string;
}
export interface NativeTaskCriterion {
  id: string; description: string; stepIds: string[]; kind: 'command' | 'manual';
}
/** 模型可以提出这些声明，但不能提供验证结果。 */
export interface NativeTaskPlan {
  goal: string; steps: NativeTaskStep[]; criteria: NativeTaskCriterion[];
}
export interface NativeTaskCommand {
  executable: string; argv: string[]; cwd: string;
}
/** 有边界的宿主扫描；文件内容不会持久化，也不会发送给模型。 */
export interface NativeTaskWorkspace {
  fingerprint: string; complete: boolean; rootFingerprint: string;
  files: Array<{ path: string; hash: string; bytes: number; mode: number }>;
  scope: string[]; issues: string[]; capturedAt: string;
}
/** 观测到的变更可能来自其他参与方，绝不作为回滚白名单。 */
export interface NativeTaskChangeSummary {
  complete: boolean; added: string[]; modified: string[]; removed: string[];
  attribution: 'observed_since_task_start'; truncated: boolean;
}
/** 宿主读取的来源上下文，保留原始换行符及完整文件身份。 */
export interface NativeTaskCodeLocation {
  path: string; startLine: number; endLine: number;
  fileHash: string; fileBytes: number; excerpt: string; excerptHash: string;
}
/** 宿主证据来自已提交的工具回执、显式人工审查，或在任务存储中持久化记录的宿主读取观测。 */
export interface NativeTaskEvidence {
  id: string; identity: NativeTaskIdentity; stepIds: string[]; criterionIds: string[];
  source: 'command' | 'manual' | 'location'; status: 'unverified' | 'passed' | 'failed' | 'not_applicable';
  planRevision: number; acceptanceRevision: number;
  workspaceFingerprint: string; workspaceComplete: boolean;
  toolCallId?: string; command?: NativeTaskCommand; exitCode?: number | null;
  output?: string; outputDigest?: string; truncated?: boolean;
  /** 位置回执仅作为上下文，必须保持未验证状态。 */
  location?: NativeTaskCodeLocation;
  reason?: string; createdAt: string; stale?: boolean;
}
export interface NativeTaskHistoryEntry {
  revision: number; mutationId: string; kind: string; runId: string; at: string; summary: string;
}
export interface NativeTaskSnapshot extends NativeTaskPlan {
  schemaVersion: 1; taskId: string; identity: NativeTaskIdentity;
  revision: number; planRevision: number; acceptanceRevision: number;
  execution: 'active' | 'ended' | 'interrupted';
  runOutcome?: string;
  verification: NativeTaskVerification;
  evidence: NativeTaskEvidence[];
  workspace?: { baseline: NativeTaskWorkspace; current: NativeTaskWorkspace; changes: NativeTaskChangeSummary };
  review?: { status: 'approved' | 'rejected'; reason: string; at: string };
  history: NativeTaskHistoryEntry[];
  createdAt: string; updatedAt: string;
}
/** 由宿主生成且有边界的执行回执。运行完成与验收相互独立。 */
export interface NativeExecutionReceipt {
  version: 1;
  identity: NativeTaskIdentity;
  taskId?: string;
  taskRevision?: number;
  planRevision?: number;
  acceptanceRevision?: number;
  verification?: NativeTaskVerification;
  workspace?: { fingerprint: string; complete: boolean; capturedAt: string };
  changes?: NativeTaskChangeSummary;
  criteria: NativeTaskCriterion[];
  evidence: Array<Pick<NativeTaskEvidence, 'id' | 'identity' | 'source' | 'status' | 'criterionIds' | 'stepIds' |
    'planRevision' | 'acceptanceRevision' | 'workspaceFingerprint' | 'workspaceComplete' | 'toolCallId' |
    'command' | 'exitCode' | 'outputDigest' | 'truncated' | 'stale'>>;
  usage: { modelRequests: number; toolCalls: number; activeMs: number };
  truncated: boolean;
  /** 宿主独立审查记录；不会替代任务面板中的人工验收。 */
  workflowQuality?: NativeWorkflowQualityState;
}
export type NativeTaskMutation =
  | { type: 'plan'; plan: NativeTaskPlan; explanation?: string }
  | { type: 'evidence'; evidence: NativeTaskEvidence }
  | { type: 'workspace'; baseline?: NativeTaskWorkspace; current: NativeTaskWorkspace; changes: NativeTaskChangeSummary }
  | { type: 'invalidate'; reason: string }
  | { type: 'review'; status: 'approved' | 'rejected'; reason: string }
  | { type: 'finish'; outcome: string }
  | { type: 'interrupt'; reason: string }
  /** 只有宿主显式延续任务时，才可以将已有任务重新绑定到新运行。 */
  | { type: 'continue'; previousRunId: string };
export interface NativeTaskUpdate {
  identity: NativeTaskIdentity; taskId: string; mutationId: string;
  /** 零表示创建任务；后续写入以此持久化修订号进行比较并交换。 */
  expectedRevision: number; mutation: NativeTaskMutation;
}

export type NativeTaskWorkspaceView = Omit<NativeTaskWorkspace, 'files'> & { fileCount: number };
/** 渲染进程视图省略完整的宿主文件清单。 */
export type NativeTaskView = Omit<NativeTaskSnapshot, 'workspace'> & {
  workspace?: { baseline: NativeTaskWorkspaceView; current: NativeTaskWorkspaceView; changes: NativeTaskChangeSummary };
};

/** 显示层与宿主共用的规则：N1 中只有人工条件回执才能确认验收通过。 */
export function getNativeTaskCriterionVerification(task: NativeTaskSnapshot | NativeTaskView, criterionId: string): NativeTaskVerification {
  const evidence = [...task.evidence].reverse().find(item => item.source === 'manual' && item.criterionIds.includes(criterionId));
  if (!evidence) return 'unverified';
  if (evidence.stale || evidence.planRevision !== task.planRevision || evidence.acceptanceRevision !== task.acceptanceRevision ||
      !evidence.workspaceComplete || !task.workspace?.current.complete || evidence.workspaceFingerprint !== task.workspace.current.fingerprint) return 'stale';
  return evidence.status;
}
