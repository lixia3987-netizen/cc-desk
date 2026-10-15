/** 用户为某个确定模型输入的费率，单位为每百万个上报 token 的美元价格。 */
export interface NativeModelPricing {
  model: string;
  inputUSDPerMillion: number;
  outputUSDPerMillion: number;
  cacheReadUSDPerMillion?: number;
  cacheCreationUSDPerMillion?: number;
}

export type NativeCostUnknownReason = 'missing_usage' | 'missing_pricing' | 'model_mismatch' | 'missing_cache_usage' | 'inconsistent_usage' | 'missing_cache_pricing' | 'incomplete_requests';
export interface NativeCostEstimate {
  source: 'user_rates';
  status: 'ready' | 'unknown';
  model?: string;
  reason?: NativeCostUnknownReason;
  costUSD?: number;
}

export const nativeCostReasonLabels: Record<NativeCostUnknownReason, string> = {
  missing_usage: '服务未报告完整输入和输出用量',
  missing_pricing: '未填写完整的普通输入和输出费率',
  model_mismatch: '价格对应模型与请求模型不一致',
  missing_cache_usage: '服务未报告完整缓存分项',
  inconsistent_usage: '输入分项与总量不一致',
  missing_cache_pricing: '有缓存用量，但未填写对应缓存费率',
  incomplete_requests: '存在未报告完整用量的请求',
};

export function nativeCostLabel(estimate: NativeCostEstimate | undefined): string {
  if (estimate?.status === 'ready' && typeof estimate.costUSD === 'number') return `用户填写费率估价 $${estimate.costUSD.toLocaleString(undefined, { maximumFractionDigits: 6 })}`;
  return `费用未知${estimate?.reason ? `：${nativeCostReasonLabels[estimate.reason]}` : ''}（估价来源：用户填写费率）`;
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const rate = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1_000_000;

/** 不能依据预算、仅含总量的用量数据或其他模型的价格进行估算。 */
export function estimateNativeCost(usage: unknown, pricing: unknown, model: unknown): number | undefined {
  return nativeCostEstimate(usage, pricing, model).costUSD;
}

/** 只按可核对的互斥用量分项估价；缺失缓存数据不能默认为零。 */
export function nativeCostEstimate(usage: unknown, pricing: unknown, model: unknown): NativeCostEstimate {
  const base = { source: 'user_rates' as const, ...(typeof model === 'string' && model ? { model } : {}) };
  const unknown = (reason: NativeCostUnknownReason): NativeCostEstimate => ({ ...base, status: 'unknown', reason });
  if (!object(usage) || !count(usage.inputTokens) || !count(usage.outputTokens)) return unknown('missing_usage');
  if (!object(pricing) || !rate(pricing.inputUSDPerMillion) || !rate(pricing.outputUSDPerMillion)) return unknown('missing_pricing');
  if (typeof model !== 'string' || !model || pricing.model !== model) return unknown('model_mismatch');
  if (!count(usage.nonCachedInputTokens) || !count(usage.cacheReadInputTokens) || !count(usage.cacheCreationInputTokens)) return unknown('missing_cache_usage');
  const inputSum = usage.nonCachedInputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens;
  if (!Number.isSafeInteger(inputSum) || inputSum !== usage.inputTokens) return unknown('inconsistent_usage');
  if (usage.cacheReadInputTokens > 0 && !rate(pricing.cacheReadUSDPerMillion)
    || usage.cacheCreationInputTokens > 0 && !rate(pricing.cacheCreationUSDPerMillion)) return unknown('missing_cache_pricing');
  // 缓存分项明确为零时无须对应费率；零费率不能由缺失值生成。
  const costUSD = (usage.nonCachedInputTokens * pricing.inputUSDPerMillion
    + usage.outputTokens * pricing.outputUSDPerMillion
    + usage.cacheReadInputTokens * (rate(pricing.cacheReadUSDPerMillion) ? pricing.cacheReadUSDPerMillion : 0)
    + usage.cacheCreationInputTokens * (rate(pricing.cacheCreationUSDPerMillion) ? pricing.cacheCreationUSDPerMillion : 0)) / 1_000_000;
  return Number.isFinite(costUSD) ? { ...base, status: 'ready', costUSD } : unknown('inconsistent_usage');
}
