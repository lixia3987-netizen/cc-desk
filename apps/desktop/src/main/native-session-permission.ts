import type { EngineConfig, Session } from '../shared/types';
import { NATIVE_PERMISSION_MODES, type NativePermissionMode } from '../shared/native-permissions';

interface Ports {
  session(id: string): Session;
  assertAllowed(session: Session): void;
  validateConfig(id: string, config: EngineConfig): EngineConfig;
  commit(id: string, config: EngineConfig): void;
  changed(): void;
}

/** Persist only the next-turn mode. This path never touches an active run, approval or queue. */
export function changeNativePermissionForNextTurn(id: string, mode: NativePermissionMode, ports: Ports): NativePermissionMode {
  const session = ports.session(id);
  if (session.kind !== 'agent' || session.execution.providerId !== 'native' || session.execution.mode !== 'structured') {
    throw new Error('此权限入口只用于自研 Agent 会话。');
  }
  if (!NATIVE_PERMISSION_MODES.includes(mode)) throw new Error('无效权限模式。');
  if (session.archived || session.status === 'stopping') throw new Error('请先取消归档或等待会话停止。');
  ports.assertAllowed(session);
  const config = ports.validateConfig(id, {
    ...session.engineConfig, options: { ...session.engineConfig.options, permissionMode: mode },
  });
  if (config.options.permissionMode !== mode) throw new Error('权限模式校验失败。');
  ports.commit(id, config);
  ports.changed();
  return mode;
}
