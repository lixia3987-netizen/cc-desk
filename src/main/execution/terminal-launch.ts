import type { Session } from '../../shared/types';
import type { SubtaskObservation } from '../subtask-tracker';

/** Launchers report observed metadata, never replace the local or provider identity. */
export type TerminalSessionUpdate = Partial<Pick<Session,
  'taskState' | 'terminalSync' | 'identityPending' | 'model' | 'permissionMode' | 'observedPermissionMode'
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

/** Owns provider setup only; Runtime owns every spawned process and launch resource. */
export interface TerminalLauncher {
  prepare(session: Session, callbacks: TerminalLaunchCallbacks): Promise<TerminalLaunchSpec>;
}
