/** 自动审查与人工验收分别记录；任何模型文本都不能直接生成宿主通过状态。 */
export type NativeWorkflowCollaboration = 'auto' | 'single_agent' | 'parallel' | 'adversarial';
export type NativeQualityRole = 'reviewer' | 'challenger' | 'verifier';
export type NativeQualityValidationMode = 'commands' | 'static';
export interface NativeQualityIdentity {
  sessionId: string; conversationId: string; runId: string; requestId: string; workerGeneration: number;
}
export interface NativeQualityEvidence {
  toolCallId: string; path: string; fileHash: string; startLine: number; endLine: number;
}
export interface NativeQualityFinding {
  id: string; severity: 'blocking' | 'high' | 'medium' | 'low'; title: string; detail: string;
  evidence: NativeQualityEvidence[]; reproduction: string;
}
/** 由 submit_quality_report 结构化提交的模型声明；身份、版本和核验另由宿主绑定。 */
export interface NativeQualityReportDeclaration {
  verdict: 'passed' | 'changes_requested' | 'unknown';
  reviewedPaths: string[]; limitations: string[]; findings: NativeQualityFinding[];
  resolutions: Array<{ findingId: string; status: 'resolved' | 'unresolved' | 'unknown'; evidence: NativeQualityEvidence[]; explanation: string }>;
  verification: { status: 'executed' | 'not_applicable' | 'unknown'; commandToolCallIds: string[]; reason: string };
}
export interface NativeQualityReport {
  version: 1; role: NativeQualityRole; round: number; identity: NativeQualityIdentity; taskId: string;
  snapshotCommit: string; workspaceFingerprint: string; deliveryDigest?: string; declaration: NativeQualityReportDeclaration;
  /** 宿主从真实子账本读取；不能通过模型自报增加条目。 */
  materialReads: Array<{ toolCallId: string; path: string; fileHash: string }>;
  commandReceipts: Array<{ toolCallId: string; exitCode: number | null; successful: boolean }>;
  submittedAt: string;
}
export interface NativeQualityRoleState {
  role: NativeQualityRole; childId: string; identity: NativeQualityIdentity; taskId: string; cwd: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown';
  report?: NativeQualityReport; error?: string;
}
export interface NativeQualityRound {
  round: number; status: 'running' | 'passed' | 'changes_requested' | 'blocked' | 'cancelled' | 'unknown';
  snapshotCommit?: string; snapshotTree?: string; parentFingerprint?: string; deliveryDigest?: string;
  roles: NativeQualityRoleState[]; issues: string[];
}
export interface NativeWorkflowQualityState {
  version: 1; parentIdentity: NativeQualityIdentity; taskId: string; collaboration: NativeWorkflowCollaboration;
  validationMode: NativeQualityValidationMode;
  status: 'pending' | 'running' | 'changes_requested' | 'passed' | 'blocked' | 'cancelled' | 'unknown';
  round: number; maxRounds: 2; receiptPath: string; updatedAt: string;
  rounds: NativeQualityRound[]; findings: NativeQualityFinding[]; workspaceFingerprint?: string;
  automaticReview: 'pending' | 'passed' | 'blocked' | 'unknown'; manualAcceptance: 'not_requested';
}
