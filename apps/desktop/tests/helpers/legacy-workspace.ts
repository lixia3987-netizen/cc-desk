import type { AppState, Session, Settings } from '../../src/shared/types';

// 这些测试装置有意保留 P2 之前的磁盘格式。测试验证当前渲染进程与 IPC API 前，
// Electron 必须先迁移它们。
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
