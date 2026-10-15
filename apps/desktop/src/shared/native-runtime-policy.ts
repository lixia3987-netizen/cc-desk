import type { EngineConfig } from './execution';

/** 运行时策略由设置管理，模型绑定与项目选择仍由会话持有。 */
export const nativeRuntimePolicyKeys = [
  'inputBudgetMode', 'maxInputTokens', 'maxOutputTokens', 'autoCompact', 'modelRetry',
  'maxModelRequests', 'maxToolCalls', 'maxActiveMs',
] as const;

/** 仅解析支持的策略字段，旧版与未知配置保持原样。 */
export function resolveNativeRuntimeConfig(config: EngineConfig, defaults?: EngineConfig): EngineConfig {
  const resolved = structuredClone(config);
  if (config.schemaVersion !== 1 || config.options.runtimePolicy !== 'defaults' || defaults?.schemaVersion !== config.schemaVersion) return resolved;
  for (const key of nativeRuntimePolicyKeys) {
    if (Object.hasOwn(defaults.options, key)) resolved.options[key] = structuredClone(defaults.options[key]);
  }
  return resolved;
}
