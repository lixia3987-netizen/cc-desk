import { isDeepStrictEqual } from 'node:util';
import type { EngineConfig } from '../../../shared/execution';
import { parseNativeConfig } from './config';

/** General configuration editors cannot bypass the backed-up Skills transaction. */
export function assertNativeSkillConfigChangeAllowed(current: EngineConfig, next: EngineConfig): void {
  if (current.schemaVersion !== next.schemaVersion) throw new Error('请通过会话 Skills 设置升级配置；不能在普通配置保存中切换版本。');
  if (current.schemaVersion !== 2) return;
  const before = parseNativeConfig(current), after = parseNativeConfig(next);
  if (!isDeepStrictEqual(before.skills, after.skills) || !isDeepStrictEqual(before.projectSkills, after.projectSkills)) {
    throw new Error('技能选择已变化，请通过会话 Skills 设置保存；其他配置修改已保留在草稿中。');
  }
}

/** New defaults stay on the established configuration until catalog rollout. */
export function assertNativeDefaultSkillConfigAllowed(current: EngineConfig | undefined, next: EngineConfig): void {
  if (!current && next.schemaVersion !== 1) throw new Error('新的默认配置暂不支持 Skills 升级，请在具体会话中设置。');
  if (current) assertNativeSkillConfigChangeAllowed(current, next);
}
