export type Effort = 'default' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultracode';
export type PermissionMode = 'default' | 'plan' | 'acceptEdits';
export type SessionStatus = 'idle' | 'running' | 'stopping' | 'stopped' | 'error';
export interface Project { id: string; name: string; path: string; createdAt: string }
export interface Session {
  id: string; projectId: string; title: string; kind: 'claude' | 'shell';
  cwd: string; claudeId: string; resumeFrom?: string; imported?: boolean; started: boolean;
  model: string; effort: Effort; permissionMode: PermissionMode;
  status: SessionStatus; archived: boolean; createdAt: string; updatedAt: string;
  worktree?: string; exitCode?: number; error?: string;
}
export interface Settings { claudePath: string; shellPath: string; maxSessions: number; fontSize: number; scrollback: number }
export interface AppState { version: 1; projects: Project[]; sessions: Session[]; settings: Settings }
export interface Capabilities { executable: string; version: string; available: boolean; flags: string[]; efforts: Effort[]; error?: string }
export interface Snapshot { state: AppState; capabilities: Capabilities; platform: string; dataPath: string }
export interface NewSession { projectId: string; title: string; kind: 'claude' | 'shell'; model: string; effort: Effort; permissionMode: PermissionMode; isolated: boolean; resumeFrom?: string; fork?: boolean }
export interface TerminalChunk { sessionId: string; seq: number; data: string }
export interface TerminalSnapshot { chunks: TerminalChunk[]; status: SessionStatus }
export interface HistoryEntry { id: string; title: string; cwd: string; modifiedAt: string }
export interface GitInfo { branch: string; status: string; diff: string; error?: string }
export interface DesktopAPI {
  snapshot(): Promise<Snapshot>;
  chooseProject(): Promise<Project | null>;
  addProject(path: string): Promise<Project>;
  removeProject(id: string): Promise<void>;
  createSession(input: NewSession): Promise<Session>;
  updateSession(input: { id: string; title?: string; archived?: boolean }): Promise<void>;
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
  onState(callback: (state: AppState) => void): () => void;
  onTerminal(callback: (chunk: TerminalChunk) => void): () => void;
}
