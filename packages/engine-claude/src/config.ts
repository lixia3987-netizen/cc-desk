import type { EngineConfig } from '@cc-desk/contracts/execution';
import { isPermissionMode, type Effort } from './permissions.js';
import type { ClaudeConfig } from './types.js';
export type { ClaudeConfig } from './types.js';

export const CLAUDE_EFFORTS = ['default', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode'] as const satisfies readonly Effort[];
export function createClaudeConfig(options: Partial<ClaudeConfig> = {}): EngineConfig {
  const config: EngineConfig = { schemaVersion: 1, options: { model: '', effort: 'default', permissionMode: 'default', ...options } };
  parseClaudeConfig(config);
  return config;
}
export function parseClaudeConfig(config: EngineConfig): ClaudeConfig {
  if (config.schemaVersion !== 1) throw new Error('不支持此 Claude 配置版本。');
  const values = config.options;
  if (!values || Array.isArray(values) || Object.keys(values).some(key => !['model', 'effort', 'permissionMode'].includes(key))) throw new Error('Claude 配置包含不支持的选项。');
  if (typeof values.model !== 'string' || values.model.length > 200 || /[\x00-\x1f\x7f]/.test(values.model)) throw new Error('Claude 模型名称无效。');
  if (!CLAUDE_EFFORTS.includes(values.effort as Effort)) throw new Error('Claude 推理强度无效。');
  if (!isPermissionMode(values.permissionMode)) throw new Error('Claude 权限模式无效。');
  return { model: values.model, effort: values.effort as Effort, permissionMode: values.permissionMode };
}
