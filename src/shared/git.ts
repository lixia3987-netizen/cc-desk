export interface GitChange {
  path: string;
  originalPath?: string;
  indexStatus: string;
  worktreeStatus: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  conflicted: boolean;
}

export interface GitChanges {
  available: boolean;
  branch?: string;
  changes: GitChange[];
  truncated: boolean;
  error?: string;
}

export interface GitDiff {
  path: string;
  staged: boolean;
  text: string;
  binary: boolean;
  truncated: boolean;
}

export interface ProjectFiles { files: string[]; truncated: boolean }
export interface ProjectFile {
  path: string;
  content: string;
  bytes: number;
  binary: boolean;
  truncated: boolean;
}

export interface WorktreeInfo {
  owned: boolean;
  path: string;
  basePath: string;
  branch?: string;
  baseBranch?: string;
  clean: boolean;
  baseClean: boolean;
  merged: boolean;
  canMerge: boolean;
  canCleanup: boolean;
  reasons: string[];
  cleanupReasons: string[];
}

export interface WorktreeActionResult {
  ok: boolean;
  status: 'merged' | 'conflict' | 'removed' | 'blocked';
  message: string;
}
