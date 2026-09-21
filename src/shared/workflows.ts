export type WorkflowStatus = 'draft' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export type WorkflowStageStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

export interface WorkflowStageDefinition {
  id: string;
  title: string;
  instruction: string;
  dependsOn?: string[];
}

export interface WorkflowArtifact {
  id: string;
  kind: 'summary';
  title: string;
  content: string;
  createdAt: string;
}

export interface WorkflowStage {
  id: string;
  title: string;
  instruction: string;
  dependsOn: string[];
  status: WorkflowStageStatus;
  attempts: number;
  maxAttempts: number;
  artifacts: WorkflowArtifact[];
  startedAt?: string;
  finishedAt?: string;
  error?: string;
}

/** A workflow keeps one conversation and one working directory throughout its life. */
export interface WorkflowBinding {
  sessionId: string;
  projectId: string;
  cwd: string;
  worktree?: string;
}

export interface WorkflowRun extends WorkflowBinding {
  id: string;
  title: string;
  goal: string;
  status: WorkflowStatus;
  stages: WorkflowStage[];
  pauseAfterEachStage: boolean;
  createdAt: string;
  updatedAt: string;
  error?: string;
}

export interface NewWorkflow {
  sessionId: string;
  title?: string;
  goal: string;
  stages?: WorkflowStageDefinition[];
  pauseAfterEachStage?: boolean;
  /** Includes the initial attempt. Retries always require an explicit user action. */
  maxAttempts?: number;
}

export interface WorkflowStageResult {
  success: boolean;
  summary: string;
  error?: string;
}

export const DEFAULT_WORKFLOW_STAGES: WorkflowStageDefinition[] = [
  { id: 'plan', title: '分析与计划', instruction: '先阅读项目和相关约束，分析目标、依赖与风险，输出具体实施步骤和验收标准。本阶段仅分析，不修改文件。', dependsOn: [] },
  { id: 'implement', title: '实现与验证', instruction: '依据上一阶段计划实施修改，遵守项目规范，运行与修改相关的验证。说明已修改文件、验证结果以及未能验证的部分。', dependsOn: ['plan'] },
  { id: 'review', title: '审查与交付', instruction: '审查本次实际代码差异和验证结果，重点检查正确性、权限和回归风险。输出按严重程度排序的问题与交付总结；不要擅自提交、推送或部署。', dependsOn: ['implement'] },
];
