/** User-entered rates for one exact model, in USD per million reported tokens. */
export interface NativeModelPricing {
  model: string;
  inputUSDPerMillion: number;
  outputUSDPerMillion: number;
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const rate = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1_000_000;

/** Never estimate from budgets, total-only usage, or another model's price. */
export function estimateNativeCost(usage: unknown, pricing: unknown, model: unknown): number | undefined {
  if (!object(usage) || !object(pricing) || typeof model !== 'string' || !model || pricing.model !== model ||
      !count(usage.inputTokens) || !count(usage.outputTokens) || !rate(pricing.inputUSDPerMillion) || !rate(pricing.outputUSDPerMillion)) return undefined;
  const cost = usage.inputTokens / 1_000_000 * pricing.inputUSDPerMillion + usage.outputTokens / 1_000_000 * pricing.outputUSDPerMillion;
  return Number.isFinite(cost) ? cost : undefined;
}
