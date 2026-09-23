import type { ChatSnapshot, ChatDecision, ChatTurnResult, TaskState, ChatPage, ChatPageOptions, ChatSearchPage, ChatAttention } from './chat';
import type { GitChanges, GitDiff, ProjectFiles, ProjectFile, WorktreeInfo, WorktreeActionResult } from './git';
import type { EnvironmentDiagnostics } from './diagnostics';
import type { WorkflowRun, NewWorkflow } from './workflows';
import type { ThemeId } from './theme';
import type { PanelDrafts } from './panel-drafts';
import type { PermissionMode } from './permissions';
export type { PermissionMode } from './permissions';
export type Effort = 'default' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultracode';
export type SessionStatus = 'idle' | 'running' | 'stopping' | 'stopped' | 'error';
export interface Project { id: string; name: string; path: string; createdAt: string }
export interface Session {
  id: string; projectId: string; title: string; kind: 'claude' | 'shell';
  cwd: string; claudeId: string; resumeFrom?: string; imported?: boolean; started: boolean;
  model: string; effort: Effort; permissionMode: PermissionMode;
  status: SessionStatus; archived: boolean; createdAt: string; updatedAt: string;
  worktree?: string; worktreeBase?: string; exitCode?: number; error?: string;
  adapter?: 'terminal' | 'structured'; taskState?: TaskState; draft?: string;
  terminalSync?: 'waiting' | 'synced' | 'unsupported'; identityPending?: boolean;
  observedPermissionMode?: 'default' | 'plan' | 'acceptEdits' | 'auto' | 'dontAsk' | 'bypassPermissions';
  panelDrafts?: PanelDrafts;
}
export interface Settings { claudePath: string; shellPath: string; idePath?: string; maxSessions: number; fontSize: number; scrollback: number; notifications?: boolean; closeToTray?: boolean; theme?: ThemeId; defaultPermissionMode?: PermissionMode }
export interface AppState { version: 1; projects: Project[]; sessions: Session[]; settings: Settings; selectedSessionId?: string }
export interface Capabilities { executable: string; version: string; available: boolean; flags: string[]; efforts: Effort[]; error?: string }
export interface Snapshot { state: AppState; capabilities: Capabilities; platform: string; dataPath: string }
export interface NewSession { projectId: string; title: string; kind: 'claude' | 'shell'; model: string; effort: Effort; permissionMode?: PermissionMode; isolated: boolean; resumeFrom?: string; fork?: boolean; adapter?: 'terminal' | 'structured' }
export interface Attachment { path: string; name: string; bytes: number }
export interface HistoryPage { entries: HistoryEntry[]; total: number; nextOffset: number | null }
export interface TerminalChunk { sessionId: string; seq: number; data: string }
export interface TerminalSnapshot { chunks: TerminalChunk[]; status: SessionStatus }
export interface HistoryEntry { id: string; title: string; cwd: string; modifiedAt: string }
export interface GitInfo { branch: string; status: string; diff: string; error?: string }
export interface DesktopAPI {
  snapshot(): Promise<Snapshot>;
  copyText(text: string): Promise<void>;
  chooseProject(): Promise<Project | null>;
  addProject(path: string): Promise<Project>;
  removeProject(id: string): Promise<void>;
  createSession(input: NewSession): Promise<Session>;
  updateSession(input: { id: string; title?: string; archived?: boolean; model?: string; effort?: Effort; permissionMode?: PermissionMode }): Promise<void>;
  saveDraft(id: string, text: string): Promise<void>;
  savePanelDrafts(id: string, patch: PanelDrafts): Promise<void>;
  setSelection(id: string): Promise<void>;
  deleteSession(id: string): Promise<void>;
  chatSnapshot(id: string): Promise<ChatSnapshot>;
  chatPage(id: string, options?: ChatPageOptions): Promise<ChatPage>;
  searchChat(id: string, query: string, before?: string): Promise<ChatSearchPage>;
  chatAttention(): Promise<ChatAttention[]>;
  sendChat(id: string, text: string, attachments?: string[]): Promise<ChatTurnResult>;
  respondChat(id: string, requestId: string, decision: ChatDecision): Promise<void>;
  pickAttachments(id: string): Promise<Attachment[]>;
  listAttachments(id: string): Promise<Attachment[]>;
  removeAttachment(id: string, path: string): Promise<void>;
  onChat(callback: (sessionId: string, taskState?: TaskState) => void): () => void;
  queryHistory(projectId: string, options?: {query?: string; offset?: number; limit?: number}): Promise<HistoryPage>;
  gitChanges(id: string): Promise<GitChanges>;
  gitDiff(id: string, path: string, staged: boolean): Promise<GitDiff>;
  listProjectFiles(id: string, query: string): Promise<ProjectFiles>;
  readProjectFile(id: string, path: string): Promise<ProjectFile>;
  worktreeInfo(id: string): Promise<WorktreeInfo>;
  mergeWorktree(id: string): Promise<WorktreeActionResult>;
  cleanupWorktree(id: string): Promise<WorktreeActionResult>;
  diagnostics(sessionId?: string): Promise<EnvironmentDiagnostics>;
  workflows(sessionId?: string): Promise<WorkflowRun[]>;
  createWorkflow(input: NewWorkflow): Promise<WorkflowRun>;
  startWorkflow(id: string): Promise<WorkflowRun>;
  continueWorkflow(id: string): Promise<WorkflowRun>;
  retryWorkflow(id: string): Promise<WorkflowRun>;
  cancelWorkflow(id: string): Promise<WorkflowRun>;
  deleteWorkflow(id: string): Promise<void>;
  exportWorkflow(id: string): Promise<string | null>;
  reviseWorkflowStage(id: string, stageId: string, instruction: string): Promise<WorkflowRun>;
  onWorkflows(callback: () => void): () => void;
  startSession(id: string): Promise<void>;
  stopSession(id: string): Promise<void>;
  interruptSession(id: string): Promise<void>;
  terminalSnapshot(id: string): Promise<TerminalSnapshot>;
  writeTerminal(id: string, data: string): Promise<void>;
  resizeTerminal(id: string, cols: number, rows: number): Promise<void>;
  saveSettings(settings: Settings): Promise<void>;
  detect(): Promise<Capabilities>;
  history(projectId: string): Promise<HistoryEntry[]>;
  gitInfo(sessionId: string): Promise<GitInfo>;
  exportTranscript(id: string): Promise<string | null>;
  openFolder(id: string): Promise<void>;
  chooseIdeApplication(): Promise<string | null>;
  openIde(id: string): Promise<void>;
  onState(callback: (state: AppState) => void): () => void;
  onError(callback: (message: string) => void): () => void;
  onNavigate(callback: (sessionId: string) => void): () => void;
  onCapabilities(callback: (capabilities: Capabilities) => void): () => void;
  onTerminal(callback: (chunk: TerminalChunk) => void): () => void;
}
