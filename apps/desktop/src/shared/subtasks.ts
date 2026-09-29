export const SUBTASK_STATUSES = ['pending','running','paused','waiting_approval','waiting_input','completed','failed','stopped','interrupted','unknown'] as const;
export type SubtaskStatus = typeof SUBTASK_STATUSES[number];
export interface Subtask {
  id: string; turnId: string; source: 'stream' | 'hooks'; kind: 'agent' | 'shell' | 'task';
  status: SubtaskStatus; description: string; startedAt: string; updatedAt: string; endedAt?: string;
  taskId?: string; toolUseId?: string; parentToolUseId?: string; agentId?: string;
  summary?: string; progress?: string; lastTool?: string;
  toolUses?: number; totalTokens?: number; durationMs?: number; background?: boolean;
}
export interface SubtaskActivity { turnId: string; tasks: Subtask[]; truncated?: boolean }
export const SUBTASK_LIMIT = 200;
export function isSubtaskActive(status: SubtaskStatus): boolean {
  return ['pending','running','paused','waiting_approval','waiting_input'].includes(status);
}
export function isSubtaskTerminal(status: SubtaskStatus): boolean { return !isSubtaskActive(status); }
export function subtaskCounts(tasks: Subtask[]) {
  return tasks.reduce((counts, task) => {
    counts.total++;
    if(isSubtaskActive(task.status))counts.active++;
    else if(task.status==='completed')counts.completed++;
    else if(task.status==='failed')counts.failed++;
    else if(task.status==='stopped'||task.status==='interrupted')counts.stopped++;
    else counts.unknown++;
    return counts;
  },{total:0,active:0,completed:0,failed:0,stopped:0,unknown:0});
}
