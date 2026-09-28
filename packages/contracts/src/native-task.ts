/** Durable engineering-task state. This never replaces the operational RunStatus. */
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
/** The model may propose these declarations, but cannot provide verification results. */
export interface NativeTaskPlan {
  goal: string; steps: NativeTaskStep[]; criteria: NativeTaskCriterion[];
}
export interface NativeTaskCommand {
  executable: string; argv: string[]; cwd: string;
}
/** Bounded host scan; no file contents are persisted or sent to the model. */
export interface NativeTaskWorkspace {
  fingerprint: string; complete: boolean; rootFingerprint: string;
  files: Array<{ path: string; hash: string; bytes: number; mode: number }>;
  scope: string[]; issues: string[]; capturedAt: string;
}
/** Observed changes can include other actors; this is never a rollback allowlist. */
export interface NativeTaskChangeSummary {
  complete: boolean; added: string[]; modified: string[]; removed: string[];
  attribution: 'observed_since_task_start'; truncated: boolean;
}
/** Constructed only by the host from a committed tool receipt or explicit human review. */
export interface NativeTaskEvidence {
  id: string; identity: NativeTaskIdentity; stepIds: string[]; criterionIds: string[];
  source: 'command' | 'manual'; status: 'unverified' | 'passed' | 'failed' | 'not_applicable';
  planRevision: number; acceptanceRevision: number;
  workspaceFingerprint: string; workspaceComplete: boolean;
  toolCallId?: string; command?: NativeTaskCommand; exitCode?: number | null;
  output?: string; outputDigest?: string; truncated?: boolean;
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
export type NativeTaskMutation =
  | { type: 'plan'; plan: NativeTaskPlan; explanation?: string }
  | { type: 'evidence'; evidence: NativeTaskEvidence }
  | { type: 'workspace'; baseline?: NativeTaskWorkspace; current: NativeTaskWorkspace; changes: NativeTaskChangeSummary }
  | { type: 'invalidate'; reason: string }
  | { type: 'review'; status: 'approved' | 'rejected'; reason: string }
  | { type: 'finish'; outcome: string }
  | { type: 'interrupt'; reason: string }
  /** Only an explicit host continuation may rebind an existing task to a new run. */
  | { type: 'continue'; previousRunId: string };
export interface NativeTaskUpdate {
  identity: NativeTaskIdentity; taskId: string; mutationId: string;
  /** Zero creates a task; subsequent writes compare-and-swap this durable revision. */
  expectedRevision: number; mutation: NativeTaskMutation;
}

export type NativeTaskWorkspaceView = Omit<NativeTaskWorkspace, 'files'> & { fileCount: number };
/** Renderer view omits the full host file inventory. */
export type NativeTaskView = Omit<NativeTaskSnapshot, 'workspace'> & {
  workspace?: { baseline: NativeTaskWorkspaceView; current: NativeTaskWorkspaceView; changes: NativeTaskChangeSummary };
};

/** Shared display/host rule: only a human condition receipt can establish acceptance in N1. */
export function getNativeTaskCriterionVerification(task: NativeTaskSnapshot | NativeTaskView, criterionId: string): NativeTaskVerification {
  const evidence = [...task.evidence].reverse().find(item => item.source === 'manual' && item.criterionIds.includes(criterionId));
  if (!evidence) return 'unverified';
  if (evidence.stale || evidence.planRevision !== task.planRevision || evidence.acceptanceRevision !== task.acceptanceRevision ||
      !evidence.workspaceComplete || !task.workspace?.current.complete || evidence.workspaceFingerprint !== task.workspace.current.fingerprint) return 'stale';
  return evidence.status;
}
