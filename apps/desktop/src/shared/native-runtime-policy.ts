import type { EngineConfig } from './execution';

/** Settings-owned runtime policy; model bindings and project selections stay with the session. */
export const nativeRuntimePolicyKeys = [
  'inputBudgetMode', 'maxInputTokens', 'maxOutputTokens', 'autoCompact', 'modelRetry',
  'maxModelRequests', 'maxToolCalls', 'maxActiveMs',
] as const;

/** Resolve only the supported policy fields, retaining legacy and unknown configurations verbatim. */
export function resolveNativeRuntimeConfig(config: EngineConfig, defaults?: EngineConfig): EngineConfig {
  const resolved = structuredClone(config);
  if (config.schemaVersion !== 1 || config.options.runtimePolicy !== 'defaults' || defaults?.schemaVersion !== config.schemaVersion) return resolved;
  for (const key of nativeRuntimePolicyKeys) {
    if (Object.hasOwn(defaults.options, key)) resolved.options[key] = structuredClone(defaults.options[key]);
  }
  return resolved;
}
