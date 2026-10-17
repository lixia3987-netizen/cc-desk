import type { WorkflowBudget, WorkflowCollaboration, WorkflowGate, WorkflowToolPolicy } from './workflows';
export interface WorkflowDraft {
  goal: string;
  pauseAfterEachStage: boolean;
  maxAttempts: number;
  editing: string;
  instructions: Record<string, string>;
  allRuns: boolean;
  stageGates?: Record<string, WorkflowGate>;
  stageToolPolicies?: Record<string, WorkflowToolPolicy>;
  /** 缺省兼容旧草稿，Native 创建界面显式采用独立对抗验证。 */
  collaboration?: WorkflowCollaboration;
  /** @deprecated 兼容旧版草稿；不再提交累计预算。 */
  budget?: WorkflowBudget;
}

export interface GitReviewDraft {
  selected: string;
  staged: boolean;
  feedback: Record<string, string>;
}

export interface PanelDrafts {
  workflow?: WorkflowDraft;
  git?: GitReviewDraft;
}

export const emptyWorkflowDraft = (): WorkflowDraft => ({
  goal: '', pauseAfterEachStage: true, maxAttempts: 2, editing: '', instructions: {}, allRuns: false,
});
export const emptyGitReviewDraft = (): GitReviewDraft => ({ selected: '', staged: false, feedback: {} });

/** 仅用于渲染进程的更新函数，通过 IPC 发送校验后的配置区域。 */
export type UpdateDraft<T> = (update: (current: T) => T) => void;
