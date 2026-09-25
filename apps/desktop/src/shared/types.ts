import type { ChatSnapshot, ChatDecision, ChatTurnResult, ChatSubmission, TaskState, ChatPage, ChatPageOptions, ChatSearchPage, ChatAttention } from './chat';
import type { GitChanges, GitDiff, ProjectFiles, ProjectFile, WorktreeInfo, WorktreeActionResult } from './git';
import type { EnvironmentDiagnostics } from './diagnostics';
import type { WorkflowRun, NewWorkflow } from './workflows';
import type { ThemeId } from './theme';
import type { PanelDrafts } from './panel-drafts';
import type { SubtaskActivity } from './subtasks';
import type { SessionTitleSource } from './session-title';
import type { ImportedFont, TypographySettings } from './fonts';
import type { CLIUpdateState } from './cli-update';
import type { SessionExecution, ExecutionMode, ExecutionDescriptor, SessionStatus, TerminalChunk, EngineConfig } from './execution';
import type { ExecutionEvent } from './execution-events';
import type { ClaudeCapabilities } from '@cc-desk/engine-claude';
export type { PermissionMode } from './permissions';
export type { SessionStatus, TerminalChunk, EngineConfig, EngineConfigField, EngineConfiguration, JsonValue } from './execution';
export type { Effort } from '@cc-desk/engine-claude/permissions';
export interface Project { id: string; name: string; path: string; createdAt: string }
export interface Session {
  id: string; projectId: string; title: string; kind: 'agent' | 'shell';
  titleSource?: SessionTitleSource;
  cwd: string; execution: SessionExecution; started: boolean;
  engineConfig: EngineConfig;
  status: SessionStatus; archived: boolean; createdAt: string; updatedAt: string;
  worktree?: string; worktreeBase?: string; exitCode?: number; error?: string;
  taskState?: TaskState; draft?: string;
  terminalSync?: 'waiting' | 'synced' | 'unsupported'; identityPending?: boolean;
  observedPermissionMode?: 'default' | 'plan' | 'acceptEdits' | 'auto' | 'dontAsk' | 'bypassPermissions';
  panelDrafts?: PanelDrafts;
  subtasks?: SubtaskActivity;
}
export interface Settings extends TypographySettings { claudePath: string; shellPath: string; idePath?: string; worktreeLocation?: 'project' | 'custom'; worktreeRoot?: string; maxSessions: number; fontSize: number; scrollback: number; notifications?: boolean; closeToTray?: boolean; theme?: ThemeId; engineDefaults: Record<string, EngineConfig> }
export interface AppState { version: 3; projects: Project[]; sessions: Session[]; settings: Settings; selectedSessionId?: string }
export type Capabilities = ClaudeCapabilities;
export interface Snapshot { state: AppState; capabilities: Capabilities; executors: ExecutionDescriptor[]; cliUpdate: CLIUpdateState; platform: string; dataPath: string }
export interface NewSession { projectId: string; title: string; kind: 'agent' | 'shell'; engineConfig?: EngineConfig; isolated: boolean; worktreeName?: string; providerId?: string; mode?: ExecutionMode; conversationId?: string; fork?: boolean }
export interface Attachment { path: string; name: string; bytes: number }
export interface HistoryPage { entries: HistoryEntry[]; total: number; nextOffset: number | null }
export interface TerminalSnapshot { chunks: TerminalChunk[]; status: SessionStatus }
export interface HistoryEntry { providerId: string; id: string; title: string; cwd: string; modifiedAt: string }
export interface GitInfo { branch: string; status: string; diff: string; error?: string }
export interface DesktopAPI {
  snapshot(): Promise<Snapshot>;
  copyText(text: string): Promise<void>;
  chooseProject(): Promise<Project | null>;
  addProject(path: string): Promise<Project>;
  removeProject(id: string): Promise<void>;
  createSession(input: NewSession): Promise<Session>;
  updateSession(input: { id: string; title?: string; archived?: boolean; engineConfig?: EngineConfig }): Promise<void>;
  saveDraft(id: string, text: string): Promise<void>;
  savePanelDrafts(id: string, patch: PanelDrafts): Promise<void>;
  setSelection(id: string): Promise<void>;
  deleteSession(id: string, options?: { preserveWorktree: true } | { forceWorktree: true; worktreePath: string }): Promise<void>;
  chatSnapshot(id: string): Promise<ChatSnapshot>;
  prepareChatCommands(id: string): Promise<ChatSnapshot>;
  recoverChatContext(id: string): Promise<void>;
  chatPage(id: string, options?: ChatPageOptions): Promise<ChatPage>;
  searchChat(id: string, query: string, before?: string): Promise<ChatSearchPage>;
  chatAttention(): Promise<ChatAttention[]>;
  sendChat(id: string, text: string, attachments?: string[]): Promise<ChatTurnResult>;
  submitChat(id: string, text: string, attachments?: string[], requestId?: string): Promise<ChatSubmission>;
  sendQueuedChatNow(id: string, messageId: string): Promise<void>;
  removeQueuedChat(id: string, messageId: string): Promise<void>;
  resumeChatQueue(id: string): Promise<void>;
  respondChat(id: string, requestId: string, decision: ChatDecision): Promise<void>;
  pickAttachments(id: string): Promise<Attachment[]>;
  addDroppedAttachments(id: string, files: File[]): Promise<Attachment[]>;
  listAttachments(id: string): Promise<Attachment[]>;
  removeAttachment(id: string, path: string): Promise<void>;
  onChat(callback: (sessionId: string, taskState?: TaskState) => void): () => void;
  queryHistory(projectId: string, options?: {providerId?: string; query?: string; offset?: number; limit?: number}): Promise<HistoryPage>;
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
  listFonts(): Promise<ImportedFont[]>;
  importFont(): Promise<ImportedFont | null>;
  readFont(id: string): Promise<Uint8Array>;
  removeFont(id: string): Promise<void>;
  detect(): Promise<Capabilities>;
  checkCLIUpdate(): Promise<CLIUpdateState>;
  updateCLI(): Promise<CLIUpdateState>;
  dismissCLIUpdate(): Promise<void>;
  onCLIUpdate(callback: (state: CLIUpdateState) => void): () => void;
  history(projectId: string, providerId?: string): Promise<HistoryEntry[]>;
  gitInfo(sessionId: string): Promise<GitInfo>;
  exportTranscript(id: string): Promise<string | null>;
  openFolder(id: string): Promise<void>;
  chooseIdeApplication(): Promise<string | null>;
  chooseWorktreeRoot(): Promise<string | null>;
  openIde(id: string): Promise<void>;
  onState(callback: (state: AppState) => void): () => void;
  onError(callback: (message: string) => void): () => void;
  onNavigate(callback: (sessionId: string) => void): () => void;
  onCapabilities(callback: (capabilities: Capabilities) => void): () => void;
  onExecutors(callback: (executors: ExecutionDescriptor[]) => void): () => void;
  onExecution(callback: (event: ExecutionEvent) => void): () => void;
  onTerminal(callback: (chunk: TerminalChunk) => void): () => void;
}
