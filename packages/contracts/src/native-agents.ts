import type { NativeTaskIdentity } from './native-task.js';

/** Bound by the host approval queue; never inferred from model-supplied tool arguments. */
export interface NativeAgentApprovalScope { title: string; cwd: string; taskId: string; runId: string }

/** Host-owned execution facts. A completed child has not passed task acceptance. */
export interface NativeAgentView {
  childId: string; batchId: string; taskId: string; parentTaskId: string;
  identity: NativeTaskIdentity; parentIdentity: NativeTaskIdentity; toolCallId: string;
  title: string; mode: 'review' | 'implement';
  status: 'prepared' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown';
  createdAt: string; updatedAt: string; cwd: string; receiptPath: string;
  /** No durable child terminal result; the host never restores a live-looking worker. */
  missingTerminal?: boolean;
  summary?: string; reason?: string; error?: string;
  usage?: { modelRequests: number; toolCalls: number };
  worktree?: { path: string; cwd: string; branch: string; baseCommit: string; parentHead: string; baseline: 'head' | 'snapshot'; verified: boolean };
  artifact?: { patchPath: string; changedFiles: Array<{ path: string; status: string }>; omittedFiles: number };
  evidence?: { taskSnapshotPath?: string; runJournalPath?: string;
    commandReceipts: Array<{ toolCallId: string; status: string; exitCode: number | null; receiptPath: string }> };
}
export interface NativeAgentSnapshot {
  parentRunId: string;
  /** Most recent four children, prioritizing children currently executing. */
  items: NativeAgentView[];
  /** Additional results are retained in the parent run's receipt directory. */
  omitted: number; receiptDirectory: string;
  /** Some saved records could not be read or validated. */
  incomplete?: boolean;
}
