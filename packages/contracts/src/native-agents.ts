import type { NativeTaskIdentity } from './native-task.js';

/** 由宿主审批队列绑定，绝不根据模型提供的工具参数推断。 */
export interface NativeAgentApprovalScope { title: string; cwd: string; taskId: string; runId: string }

/** 宿主管理的执行事实。子任务完成并不代表任务验收通过。 */
export interface NativeAgentView {
  childId: string; batchId: string; taskId: string; parentTaskId: string;
  identity: NativeTaskIdentity; parentIdentity: NativeTaskIdentity; toolCallId: string;
  title: string; mode: 'review' | 'implement';
  status: 'prepared' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown';
  createdAt: string; updatedAt: string; cwd: string; receiptPath: string;
  /** 缺少持久化的子任务终态结果；宿主绝不恢复看似仍在运行的工作任务。 */
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
  /** 本次父任务运行最多包含 16 个子任务，优先显示活跃子任务。 */
  items: NativeAgentView[];
  /** 其他结果保留在父任务运行的回执目录中。 */
  omitted: number; receiptDirectory: string;
  /** 部分已保存记录无法读取或校验。 */
  incomplete?: boolean;
}

/** 宿主根据账本管理的父任务运行及子任务回执解析所有路径。 */
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
  /** UTF-16 字符偏移；分页绝不拆分代理对。 */
  offset: number;
  nextOffset: number | null;
  totalCharacters: number;
  totalBytes: number;
}
export interface NativeAgentResult {
  agent: NativeAgentView;
  goal: string;
  patch?: NativeAgentPatchPage;
  /** 读取或移交结果绝不代表任务验收通过。 */
  acceptance: 'not_assessed';
}
