import type { Session } from '../../shared/types';
import type { SubtaskObservation } from '../subtask-tracker';

/** 启动器报告观测到的元数据，不替换本地身份或提供方身份。 */
export type TerminalSessionUpdate = Partial<Pick<Session,
  'taskState' | 'terminalSync' | 'identityPending' | 'engineConfig' | 'observedPermissionMode'
>> & { conversationId?: string };

export type TerminalSubtaskEvent =
  | { type: 'begin'; turnId: string }
  | { type: 'observe'; observation: SubtaskObservation }
  | { type: 'end'; status: 'interrupted' | 'failed' | 'unknown'; reason?: string };

export interface TerminalLaunchCallbacks {
  update(patch: TerminalSessionUpdate): void;
  subtask(event: TerminalSubtaskEvent): void;
  prompt(text: string): void;
}

export interface TerminalLaunchResource { close(): Promise<void> }

export interface TerminalLaunchSpec {
  file: string;
  args: string[];
  env: Record<string, string>;
  resource?: TerminalLaunchResource;
  terminalSync?: Session['terminalSync'];
}

/** 仅负责提供方初始化；Runtime 持有所有派生进程与启动资源。 */
export interface TerminalLauncher {
  prepare(session: Session, callbacks: TerminalLaunchCallbacks): Promise<TerminalLaunchSpec>;
}
