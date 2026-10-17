import type { EngineConfig } from './execution';

export const nativeSubagentPolicyKeys = ['maxModelRequests', 'maxToolCalls', 'maxActiveMs', 'maxSubagents'] as const;

/** 运行时策略由设置管理，模型绑定与项目选择仍由会话持有。 */
export const nativeRuntimePolicyKeys = [
  'inputBudgetMode', 'maxInputTokens', 'maxOutputTokens', 'autoCompact', 'modelRetry',
  ...nativeSubagentPolicyKeys,
] as const;

/** 仅解析支持的策略字段，旧版与未知配置保持原样。 */
export function resolveNativeRuntimeConfig(config: EngineConfig, defaults?: EngineConfig): EngineConfig {
  const resolved = structuredClone(config);
  if (![1, 2].includes(config.schemaVersion) || config.options.runtimePolicy !== 'defaults' || !defaults || ![1, 2].includes(defaults.schemaVersion)) return resolved;
  for (const key of nativeRuntimePolicyKeys) {
    if (Object.hasOwn(defaults.options, key)) resolved.options[key] = structuredClone(defaults.options[key]);
  }
  return resolved;
}
