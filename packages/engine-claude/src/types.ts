import type { SessionExecution, SessionStatus } from '@cc-desk/contracts/execution';
import type { TaskState } from '@cc-desk/contracts/chat';
import type { Effort, PermissionMode } from './permissions.js';
export type { Effort, PermissionMode } from './permissions.js';

export interface ClaudeCapabilities { executable: string; version: string; available: boolean; flags: string[]; efforts: Effort[]; error?: string }
export interface ClaudeSettings { claudePath: string }
export interface ClaudeConfig { model: string; effort: Effort; permissionMode: PermissionMode }

/** Runtime projection only: application preferences, titles and project registries stay with the host. */
export interface ClaudeSession extends ClaudeConfig {
  id: string; kind: 'agent' | 'shell'; execution: SessionExecution; cwd: string; projectPath?: string;
  started: boolean; archived: boolean; status: SessionStatus; taskState?: TaskState;
  error?: string; exitCode?: number; subtasks?: SubtaskActivity;
  observedPermissionMode?: PermissionMode | 'auto' | 'dontAsk';
}
export type ClaudeSessionPatch = Partial<Pick<ClaudeSession,
  'execution' | 'started' | 'status' | 'taskState' | 'error' | 'exitCode' | 'model' | 'effort' | 'permissionMode' | 'observedPermissionMode'
>>;

/** Structural projection shared with the host's subtask tracker, without depending on its implementation. */
export type SubtaskStatus = 'pending' | 'running' | 'paused' | 'waiting_approval' | 'waiting_input' | 'completed' | 'failed' | 'stopped' | 'interrupted' | 'unknown';
export interface Subtask {
  id: string; turnId: string; source: 'stream' | 'hooks'; kind: 'agent' | 'shell' | 'task';
  status: SubtaskStatus; description: string; startedAt: string; updatedAt: string; endedAt?: string;
  taskId?: string; toolUseId?: string; parentToolUseId?: string; agentId?: string;
  summary?: string; progress?: string; lastTool?: string;
  toolUses?: number; totalTokens?: number; durationMs?: number; background?: boolean;
}
export interface SubtaskActivity { turnId: string; tasks: Subtask[]; truncated?: boolean }
export interface SubtaskObservation extends Partial<Omit<Subtask, 'id' | 'source' | 'status'>> {
  source: Subtask['source']; status: SubtaskStatus; phase?: 'start' | 'progress' | 'finish';
}
export interface ClaudeExport {
  label: string; extension: 'jsonl' | 'txt'; suffix?: string; write(destination: string): Promise<void>;
}
