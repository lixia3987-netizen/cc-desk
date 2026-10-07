import type { WorkflowBudget, WorkflowGate, WorkflowToolPolicy } from './workflows';
export interface WorkflowDraft {
  goal: string;
  pauseAfterEachStage: boolean;
  maxAttempts: number;
  editing: string;
  instructions: Record<string, string>;
  allRuns: boolean;
  stageGates?: Record<string, WorkflowGate>;
  stageToolPolicies?: Record<string, WorkflowToolPolicy>;
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

/** Renderer-only updater; the validated resulting section is sent through IPC. */
export type UpdateDraft<T> = (update: (current: T) => T) => void;
