import type { ModelTokenCapabilities } from '@cc-desk/contracts/execution';

const sourceNames = { provider: '服务端', catalog: '模型目录', fallback: '本地能力表' };

export function ModelCapabilityInfo({ capabilities, conservative }: { capabilities?: ModelTokenCapabilities; conservative?: boolean }) {
  const values = ([['contextWindow', '模型窗口'], ['maxInputTokens', '输入上限'], ['maxOutputTokens', '输出上限']] as const)
    .flatMap(([key, label]) => {
      const entry = capabilities?.[key];
      return entry ? [`${label}：${entry.value.toLocaleString()} tokens（${sourceNames[entry.source]}）`] : [];
    });
  return <span role="group" aria-label="模型窗口信息">{values.length ? values.join(' · ') : '窗口信息未知，沿用用户预算。'}
    {values.length > 0 && !capabilities?.contextWindow && ' · 模型窗口未知'}
    {conservative && capabilities?.contextWindow?.source === 'fallback' && ' · 本地保守能力值，实际额度以账户为准。'}
  </span>;
}
