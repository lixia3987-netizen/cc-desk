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
  artifact?: { patchPath: string; changedFiles: Array<{ path: string; status: string }>; omittedFiles: number; sha256?: string; bytes?: number };
  evidence?: { taskSnapshotPath?: string; runJournalPath?: string;
    commandReceipts: Array<{ toolCallId: string; status: string; exitCode: number | null; receiptPath: string }> };
}
export interface NativeAgentSnapshot {
  parentRunId: string;
  /** At most sixteen children from this parent run, prioritizing active children. */
  items: NativeAgentView[];
  /** Additional results are retained in the parent run's receipt directory. */
  omitted: number; receiptDirectory: string;
  /** Some saved records could not be read or validated. */
  incomplete?: boolean;
}

/** Host resolves all paths from a ledger-owned parent run and child receipt. */
export interface NativeAgentResultRequest {
  parentRunId: string;
  childId: string;
  patchOffset?: number;
  patchCharacters?: number;
  expectedPatchSha256?: string;
}
export interface NativeAgentPatchPage {
  sha256: string;
  integrity: 'verified' | 'legacy_unverified';
  text: string;
  /** UTF-16 character offset; pages never split a surrogate pair. */
  offset: number;
  nextOffset: number | null;
  totalCharacters: number;
  totalBytes: number;
}
export interface NativeAgentResult {
  agent: NativeAgentView;
  goal: string;
  patch?: NativeAgentPatchPage;
  /** Reading or handing off a result never passes task acceptance. */
  acceptance: 'not_assessed';
}
