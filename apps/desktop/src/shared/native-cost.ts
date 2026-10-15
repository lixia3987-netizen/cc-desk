/** 用户为某个确定模型输入的费率，单位为每百万个上报 token 的美元价格。 */
export interface NativeModelPricing {
  model: string;
  inputUSDPerMillion: number;
  outputUSDPerMillion: number;
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const rate = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1_000_000;

/** 不能依据预算、仅含总量的用量数据或其他模型的价格进行估算。 */
export function estimateNativeCost(usage: unknown, pricing: unknown, model: unknown): number | undefined {
  if (!object(usage) || !object(pricing) || typeof model !== 'string' || !model || pricing.model !== model ||
      !count(usage.inputTokens) || !count(usage.outputTokens) || !rate(pricing.inputUSDPerMillion) || !rate(pricing.outputUSDPerMillion)) return undefined;
  const cost = usage.inputTokens / 1_000_000 * pricing.inputUSDPerMillion + usage.outputTokens / 1_000_000 * pricing.outputUSDPerMillion;
  return Number.isFinite(cost) ? cost : undefined;
}
