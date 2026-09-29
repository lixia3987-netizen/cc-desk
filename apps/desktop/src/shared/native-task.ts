import type { NativeTaskSnapshot, NativeTaskView, NativeTaskWorkspace, NativeTaskWorkspaceView } from '@cc-desk/contracts/native-task';

/** Human review of a particular durable task and observed workspace version. */
export interface NativeTaskReviewInput {
  taskId: string;
  expectedRevision: number;
  expectedWorkspaceFingerprint: string;
  decision: 'passed' | 'failed' | 'not_applicable' | 'approve' | 'reject';
  criterionId?: string;
  reason: string;
}

/** IPC needs the scan result and version, never the full per-file hash inventory. */
export function toNativeTaskView(snapshot: NativeTaskSnapshot): NativeTaskView {
  const { workspace, ...task } = snapshot;
  const workspaceView = ({ files, ...metadata }: NativeTaskWorkspace): NativeTaskWorkspaceView => ({ ...structuredClone(metadata), fileCount: files.length });
  return { ...structuredClone(task), ...(workspace ? { workspace: {
    baseline: workspaceView(workspace.baseline), current: workspaceView(workspace.current), changes: structuredClone(workspace.changes),
  } } : {}) };
}
