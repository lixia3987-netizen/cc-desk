import type { ContextUsage, ModelCapabilitySource, ModelTokenCapabilities } from '@cc-desk/contracts/execution';

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const sources = new Set<ModelCapabilitySource>(['provider', 'catalog', 'fallback']);
const fields = ['contextWindow', 'maxInputTokens', 'maxOutputTokens'] as const;

/** Only bounded token counts and their provenance can enter the display ledger. */
export function nativeModelCapabilityUsage(value: unknown, model: string): ContextUsage['modelCapabilities'] {
  if (!object(value) || value.model !== model || !object(value.capabilities)) return undefined;
  const capabilities: ModelTokenCapabilities = {};
  for (const field of fields) {
    const entry = value.capabilities[field];
    if (object(entry) && Number.isSafeInteger(entry.value) && (entry.value as number) > 0 && (entry.value as number) <= 10_000_000
      && sources.has(entry.source as ModelCapabilitySource)) {
      capabilities[field] = { value: entry.value as number, source: entry.source as ModelCapabilitySource };
    }
  }
  return { model, capabilities,
    ...(typeof value.resolvedAt === 'string' && value.resolvedAt.length <= 40 && Number.isFinite(Date.parse(value.resolvedAt)) ? { resolvedAt: value.resolvedAt } : {}),
    ...(value.conservative === true ? { conservative: true } : {}),
  };
}

/** Model metadata may lower configured budgets, but never increases them. */
export function nativeModelBudget<T extends { maxInputTokens: number; maxOutputTokens: number }>(configured: T, capabilities?: ModelTokenCapabilities): T {
  const maxOutputTokens = Math.min(configured.maxOutputTokens, capabilities?.maxOutputTokens?.value ?? configured.maxOutputTokens);
  const maxInputTokens = Math.min(configured.maxInputTokens, capabilities?.maxInputTokens?.value ?? configured.maxInputTokens,
    capabilities?.contextWindow ? capabilities.contextWindow.value - maxOutputTokens : configured.maxInputTokens);
  if (!Number.isSafeInteger(maxInputTokens) || maxInputTokens < 1 || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1) {
    throw new Error('模型窗口不足以容纳当前输出预算，未发起模型请求。请降低输出上限或检查模型窗口信息。');
  }
  return { ...configured, maxInputTokens, maxOutputTokens };
}
