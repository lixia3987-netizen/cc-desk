import type { EngineConfig, EngineConfigField, ExecutionDescriptor } from '../shared/execution';

export type EngineSettingsGroup = 'model' | 'context' | 'compaction' | 'limits' | 'recovery' | 'permissions' | 'tools';
export type SettingsScope = 'defaults' | 'session';

const groupKeys: Record<EngineSettingsGroup, ReadonlySet<string>> = {
  model: new Set(['connectionId', 'model']),
  context: new Set(['inputBudgetMode', 'maxInputTokens', 'maxOutputTokens']),
  compaction: new Set(['autoCompact']),
  limits: new Set(['maxModelRequests', 'maxToolCalls', 'maxActiveMs']),
  recovery: new Set(['modelRetry']),
  permissions: new Set(['permissionMode']),
  tools: new Set(['projectSkills', 'mcpConnections']),
};

export const engineGroupTitles: Record<EngineSettingsGroup, string> = {
  model: '会话模型', context: '上下文预算', compaction: '自动压缩', limits: '运行限制',
  recovery: '失败恢复', permissions: '权限与审批', tools: '会话工具',
};

/** Filter presentation only; the full configuration remains the saved draft. */
export function engineFieldsForGroup(descriptor: ExecutionDescriptor | undefined, group: EngineSettingsGroup, config: EngineConfig): EngineConfigField[] {
  if (!descriptor) return [];
  const fields = descriptor.configuration?.fields ?? [];
  if (group === 'limits') return fields.filter(field => groupKeys.limits.has(field.key)
    || !engineGroupForKey(field.key) && !['model', 'effort', 'runtimePolicy'].includes(field.key));
  if (group !== 'permissions' && descriptor.providerId !== 'native') return [];
  return fields.filter(field => groupKeys[group].has(field.key)
    && (field.key !== 'maxInputTokens' || config.options.inputBudgetMode === undefined || config.options.inputBudgetMode === 'custom'));
}

export function engineGroupForKey(key: string): EngineSettingsGroup | undefined {
  return (Object.keys(groupKeys) as EngineSettingsGroup[]).find(group => groupKeys[group].has(key));
}
