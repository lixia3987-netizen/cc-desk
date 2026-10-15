import type { NativeTaskSnapshot, NativeTaskView, NativeTaskWorkspace, NativeTaskWorkspaceView } from '@cc-desk/contracts/native-task';

/** 针对某个持久任务及已观察工作区版本的人工审核。 */
export interface NativeTaskReviewInput {
  taskId: string;
  expectedRevision: number;
  expectedWorkspaceFingerprint: string;
  decision: 'passed' | 'failed' | 'not_applicable' | 'approve' | 'reject';
  criterionId?: string;
  reason: string;
}

/** IPC 仅需扫描结果与版本，不传递完整的逐文件哈希清单。 */
export function toNativeTaskView(snapshot: NativeTaskSnapshot): NativeTaskView {
  const { workspace, ...task } = snapshot;
  const workspaceView = ({ files, ...metadata }: NativeTaskWorkspace): NativeTaskWorkspaceView => ({ ...structuredClone(metadata), fileCount: files.length });
  return { ...structuredClone(task), ...(workspace ? { workspace: {
    baseline: workspaceView(workspace.baseline), current: workspaceView(workspace.current), changes: structuredClone(workspace.changes),
  } } : {}) };
}
