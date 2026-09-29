import type { AppState, Session, Settings } from '../../src/shared/types';

// These fixtures deliberately stay at the pre-P2 disk format. Electron must
// migrate them before the tests exercise the current renderer and IPC API.
export type LegacySession = Omit<Session, 'engineConfig'> & {
  model: string;
  effort: 'default' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultracode';
  permissionMode: 'default' | 'plan' | 'acceptEdits' | 'bypassPermissions';
};
export type LegacyAppState = Omit<AppState, 'version' | 'sessions' | 'settings'> & {
  version: 2;
  sessions: LegacySession[];
  settings: Omit<Settings, 'engineDefaults'> & { defaultPermissionMode?: LegacySession['permissionMode'] };
};
