import type { ContextUsage } from '../shared/claude-session';

const count = (value: number) => value.toLocaleString();
export function ContextMeter({ context }: { context?: ContextUsage }) {
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
      {context?.model && <span>模型：{context.model}</span>}
      {context?.measuredAt && <span>更新时间：{new Date(context.measuredAt).toLocaleString()}</span>}
      {!capacity && <span>CLI 尚未报告窗口容量，暂不计算占比。</span>}
      {context?.lastCompaction && <span>最近压缩：{new Date(context.lastCompaction.at).toLocaleString()}{context.lastCompaction.trigger === 'auto' ? ' · 自动' : context.lastCompaction.trigger === 'manual' ? ' · 手动' : ''}{context.lastCompaction.preTokens !== undefined ? ` · 压缩前 ${count(context.lastCompaction.preTokens)} tokens` : ''}</span>}
      <span>输入 /context 查看详细分布，或用 /compact 压缩已有上下文。</span>
    </div>
  </details>;
}
