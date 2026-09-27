import type { ContextUsage } from '../shared/execution';

const count = (value: number) => value.toLocaleString();
export function ContextMeter({ context, native = false }: { context?: ContextUsage; native?: boolean }) {
  if (native || context?.budget) return <NativeContextMeter context={context}/>;
  const used = context?.inputTokens, capacity = context?.contextWindow;
  const percentage = used !== undefined && capacity ? used / capacity * 100 : undefined;
  const waiting = context?.status === 'compacted';
  const compacting = context?.status === 'compacting';
  const label = compacting ? '正在压缩上下文…' : waiting ? '已压缩 · 等待更新用量'
    : used === undefined ? '等待用量数据' : `${count(used)} / ${capacity ? count(capacity) : '未知容量'} tokens`;
  return <details className={'context-meter' + (percentage !== undefined && percentage >= 90 ? ' context-high' : '')}>
    <summary aria-label={'上下文使用情况：' + label}>
      <span>Context · 上下文</span>
      <span className="context-track" role="progressbar" aria-label="上下文占用" aria-valuemin={0} aria-valuemax={100}
        aria-valuenow={percentage === undefined || waiting || compacting ? undefined : Math.min(100, Number(percentage.toFixed(1)))} aria-valuetext={label}>
        <span style={{ width: `${waiting || compacting ? 0 : Math.min(100, percentage ?? 0)}%` }}/>
      </span>
      <strong>{percentage === undefined || waiting || compacting ? '—' : `${percentage.toFixed(1)}%`}</strong>
      <span className="context-count">{label}</span>
    </summary>
    <div className="context-details">
      <span>{context?.source === 'context-command' ? '来自最近一次 /context 报告。' : '最近一次主会话请求的输入 token，包含缓存读取和缓存写入。'} 新输入及工具结果在下一次请求后更新。</span>
      {(context?.requestModel || context?.model) && <span>上下文计算模型：{context.requestModel ?? context.model}</span>}
      {context?.measuredAt && <span>更新时间：{new Date(context.measuredAt).toLocaleString()}</span>}
      {!capacity && <span>CLI 尚未报告窗口容量，暂不计算占比。</span>}
      {context?.lastCompaction && <span>最近压缩：{new Date(context.lastCompaction.at).toLocaleString()}{context.lastCompaction.trigger === 'auto' ? ' · 自动' : context.lastCompaction.trigger === 'manual' ? ' · 手动' : ''}{context.lastCompaction.preTokens !== undefined ? ` · 压缩前 ${count(context.lastCompaction.preTokens)} tokens` : ''}</span>}
      <span>输入 /context 查看详细分布，或用 /compact 压缩已有上下文。</span>
    </div>
  </details>;
}

function NativeContextMeter({ context }: { context?: ContextUsage }) {
  const budget = context?.budget;
  const ratio = budget ? Math.max(budget.estimatedInputTokens / budget.maxInputTokens, budget.contextBytes / budget.maxContextBytes) : undefined;
  const percentage = ratio === undefined ? undefined : ratio * 100;
  const label = budget ? `${count(budget.estimatedInputTokens)} / ${count(budget.maxInputTokens)} 估算 tokens` : '等待本回合预算数据';
  return <details className={'context-meter' + (budget && budget.status !== 'within_budget' ? ' context-high' : '')}>
    <summary aria-label={'上下文运行预算：' + label}>
      <span>Context · 运行预算</span>
      <span className="context-track" role="progressbar" aria-label="运行预算占用" aria-valuemin={0} aria-valuemax={100}
        aria-valuenow={percentage === undefined ? undefined : Math.min(100, Number(percentage.toFixed(1)))} aria-valuetext={label}>
        <span style={{ width: `${Math.min(100, percentage ?? 0)}%` }}/>
      </span>
      <strong>{percentage === undefined ? '—' : `${percentage.toFixed(1)}%`}</strong>
      <span className="context-count">{label}</span>
    </summary>
    <div className="context-details">
      <span>这是本地运行预算，不是模型的真实上下文窗口或计费用量。预算按输入估算与上下文字节两项中较高的占比显示。</span>
      <span>按已保存历史和项目指令的 UTF-8 字节保守估算，不含工具定义和协议封装。新输入和工具结果提交后更新。</span>
      {budget && <span>上下文大小：{count(budget.contextBytes)} / {count(budget.maxContextBytes)} 字节。</span>}
      {budget?.status === 'near_limit' && <span>接近预算上限；超过上限时会在下一次模型请求前停止。</span>}
      {budget?.status === 'exceeded' && <span>已超过预算；下一次模型请求将停止。请调整输入预算或新建会话继续。</span>}
      <span>{context?.inputTokens === undefined ? '本回合最近一次模型响应未提供输入 token 用量。' : `服务返回的最近一次请求输入：${count(context.inputTokens)} tokens（非累计）。`}</span>
      {(context?.requestModel || context?.model) && <span>请求模型：{context.requestModel ?? context.model}</span>}
      {context?.measuredAt && <span>服务响应时间：{new Date(context.measuredAt).toLocaleString()}</span>}
      <span>费用未估算；请以服务商账单为准。</span>
    </div>
  </details>;
}
