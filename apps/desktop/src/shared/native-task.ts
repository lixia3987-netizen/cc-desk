/** Human review of a particular durable task and observed workspace version. */
export interface NativeTaskReviewInput {
  taskId: string;
  expectedRevision: number;
  expectedWorkspaceFingerprint: string;
  decision: 'passed' | 'failed' | 'not_applicable' | 'approve' | 'reject';
  criterionId?: string;
  reason: string;
}
