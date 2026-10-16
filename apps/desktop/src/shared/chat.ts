export type * from '@cc-desk/contracts/chat';
import type { ChatUsage } from '@cc-desk/contracts/chat';
import { nativeCostLabel } from './native-cost';

const usageLabels: Record<string, string> = { inputTokens: '输入', outputTokens: '输出', cacheReadTokens: '缓存读取', cacheCreationTokens: '缓存写入', costUSD: '估算费用 $', durationMs: '耗时 ms', turns: '轮次' };
const tokenLabel = (value: number | null | undefined): string => typeof value === 'number' ? value.toLocaleString() : '未知';

/** 累计用量与单次上下文分别显示，不把未知项格式化为零。 */
export function chatUsageLabel(usage: ChatUsage, native: boolean): string {
  if (!native) return Object.entries(usage).filter(([, value]) => typeof value === 'number').map(([key, value]) =>
    (usageLabels[key] ?? key) + ': ' + Number(value).toLocaleString(undefined, { maximumFractionDigits: key === 'costUSD' ? 6 : 0 })).join(' · ');
  return `本回合累计（tokens） · 输入 ${tokenLabel(usage.inputTokens)} · 输出 ${tokenLabel(usage.outputTokens)}`
    + ` · 非缓存输入 ${tokenLabel(usage.nonCachedInputTokens)} · 缓存读取 ${tokenLabel(usage.cacheReadInputTokens)} · 缓存创建 ${tokenLabel(usage.cacheCreationInputTokens)}`
    + ` · ${nativeCostLabel(usage.nativeCost)}`;
}
