import type { ContextUsage } from '../shared/execution';
import type { NativeContextMaintenance } from '../shared/chat';

const count = (value: number) => value.toLocaleString();
interface ContextMeterProps {
  context?: ContextUsage;
  native?: boolean;
  maintenance?: NativeContextMaintenance;
  currentRunId?: string;
  compactDisabled?: boolean;
  previewBlockedReason?: 'busy' | 'recovery_required' | 'unavailable';
  onCompact?: () => void;
  onCancelCompact?: () => void;
}
export function ContextMeter({ context, native = false, ...actions }: ContextMeterProps) {
  if (native || context?.budget) return <NativeContextMeter context={context} {...actions}/>;
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

function NativeContextMeter({ context, maintenance, currentRunId, compactDisabled, previewBlockedReason, onCompact, onCancelCompact }: Omit<ContextMeterProps, 'native'>) {
  const budget = context?.budget;
  const ratio = budget ? Math.max(budget.estimatedInputTokens / budget.maxInputTokens, budget.contextBytes / budget.maxContextBytes) : undefined;
  const percentage = ratio === undefined ? undefined : ratio * 100;
  const compacting = maintenance?.compacting;
  const automatic = maintenance?.compactionTrigger === 'automatic';
  const inTurn = maintenance?.compactionTrigger === 'in_turn';
  const label = compacting ? inTurn ? '正在回合内压缩上下文…' : automatic ? '正在自动压缩上下文…' : '正在压缩上下文…' : budget ? `${count(budget.estimatedInputTokens)} / ${count(budget.maxInputTokens)} 估算 tokens` : '等待本回合预算数据';
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
      <CompactionPreview maintenance={maintenance} blockedReason={previewBlockedReason}/>
      {maintenance?.autoCompact && <span>{maintenance.autoCompact.enabled
        ? maintenance.autoCompact.mode === 'before_send_and_during_run'
          ? `自动压缩已开启：发送前与回合内达到本地预算 ${maintenance.autoCompact.thresholdPercent}% 时尝试；发送前每次提交最多一次，回合内在完整响应与工具结果的边界最多一次。摘要请求可能计费，并计入本回合模型请求次数和运行时长。`
          : `自动压缩已开启：仅发送新指令前，达到本地预算 ${maintenance.autoCompact.thresholdPercent}% 时尝试，每次提交最多一次。摘要请求可能计费，并计入本回合模型请求次数和运行时长。`
        : '自动压缩已关闭，可在会话运行配置中开启。'}</span>}
      {maintenance?.autoCompact?.enabled && maintenance.autoCompact.mode === 'before_send_and_during_run' && <span>回合内压缩需保留摘要与继续执行的请求额度；长命令运行中或结果未知时暂缓。超出预算仍会停止。</span>}
      {maintenance?.autoCompact?.blocked && <span role="status">当前上下文的自动压缩未完成，已停止自动重试。请先手动压缩，或在运行配置中关闭自动压缩后调整输入预算或新建会话。</span>}
      {onCompact && <>
        <span>使用当前模型生成摘要，可能产生费用；不会执行工具。摘要会省略细节，原始记录保留，后续任务可重新读取项目文件。</span>
        {compacting ? <div className="panel-actions"><span role="status">{inTurn ? '正在回合内生成摘要，持久保存后继续当前任务；取消会停止本回合。原上下文在提交成功前保持不变，已完成工具不会重放。' : automatic ? '正在自动压缩，完成后继续本次发送；取消会停止本次发送。原上下文在摘要成功前保持不变。' : '正在生成摘要，完成前原上下文保持不变。'}</span>{onCancelCompact && <button type="button" className="secondary compact" onClick={onCancelCompact}>取消压缩</button>}</div>
          : <button type="button" className="secondary compact" disabled={compactDisabled || !maintenance?.canCompact} onClick={onCompact}>压缩上下文（可能计费）</button>}
      </>}
      {maintenance?.lastCompaction && <span role="status">最近压缩：{new Date(maintenance.lastCompaction.createdAt).toLocaleString()} · {maintenance.lastCompaction.trigger === 'in_turn' ? '回合内自动' : maintenance.lastCompaction.trigger === 'automatic' ? '自动' : '手动'} · 上下文 {count(maintenance.lastCompaction.beforeBytes)} → {count(maintenance.lastCompaction.afterBytes)} 字节。原始聊天和工具记录已保留。</span>}
      {maintenance?.inTurn && <InTurnReceipt receipt={maintenance.inTurn} compacting={!!compacting && inTurn} historical={!!currentRunId && currentRunId !== maintenance.inTurn.runId}/>}
      <span>这是本地运行预算，不是模型的真实上下文窗口或计费用量。预算按输入估算与上下文字节两项中较高的占比显示。</span>
      <span>按已保存历史、项目指令和工具定义的 UTF-8 字节保守估算，不等于服务端实际 token 计数。新输入和工具结果提交后更新。</span>
      {budget && <span>上下文大小：{count(budget.contextBytes)} / {count(budget.maxContextBytes)} 字节。</span>}
      {budget?.status === 'near_limit' && <span>接近预算上限；超过上限时会在下一次模型请求前停止。</span>}
      {budget?.status === 'exceeded' && <span>已超过预算；下一次模型请求将停止。请调整输入预算{onCompact ? '，或在可压缩时压缩上下文' : '或新建会话继续'}。</span>}
      <span>{context?.inputTokens === undefined ? '本回合最近一次模型响应未提供输入 token 用量。' : `服务返回的最近一次请求输入：${count(context.inputTokens)} tokens（非累计）。`}</span>
      {(context?.requestModel || context?.model) && <span>请求模型：{context.requestModel ?? context.model}</span>}
      {context?.measuredAt && <span>服务响应时间：{new Date(context.measuredAt).toLocaleString()}</span>}
      <span>可在模型连接中填写价格；本回合费用包含回合内摘要，仅在全部请求提供完整输入和输出用量、价格模型一致时估算。发送前及手动压缩另计，请以服务商账单为准。</span>
    </div>
  </details>;
}

const previewReasons = {
  no_complete_prefix: '暂无可摘要的完整旧历史前缀。',
  image_prefix_unavailable: '首个回合已含图片，没有可摘要的完整旧历史前缀。',
  busy: '会话正在运行或压缩，暂不提供范围预览。',
  recovery_required: '会话尚待恢复处理，暂不提供范围预览。',
  unsupported_context: '当前上下文协议不支持范围预览。',
  unavailable: '压缩范围暂不可用。',
} as const;

function CompactionPreview({ maintenance, blockedReason }: { maintenance?: NativeContextMaintenance; blockedReason?: ContextMeterProps['previewBlockedReason'] }) {
  const preview = maintenance?.preview;
  const knownSize = (value: number) => Number.isSafeInteger(value) && value >= 0;
  let unavailable: string | undefined;
  if (maintenance?.compacting) unavailable = previewReasons.busy;
  else if (blockedReason) unavailable = previewReasons[blockedReason];
  else if (!preview) unavailable = '当前快照未提供压缩范围。';
  else if (preview.status === 'unavailable') {
    unavailable = Object.hasOwn(previewReasons, preview.reason) ? previewReasons[preview.reason] : previewReasons.unavailable;
  } else if (maintenance?.canCompact === false) {
    unavailable = '当前界面暂不可压缩，范围信息暂不展示。';
  }
  const available = !unavailable && preview?.status === 'available'
    && knownSize(preview.summarizableBytes) && knownSize(preview.retainedBytes) && knownSize(preview.retainedImages)
    && (preview.retention === 'recent_turns' || preview.retention === 'image_suffix');
  return <div className="context-compaction-preview" role="group" aria-label="压缩范围预览">
    {available ? <>
      <span>可摘要旧历史：{count(preview.summarizableBytes)} 本地编码字节 · 需保留内容：{count(preview.retainedBytes)} 本地编码字节 · 保留图片：{count(preview.retainedImages)} 张。</span>
      <span>{preview.retention === 'image_suffix'
        ? '保留原始目标，首个含图回合及其后内容完整保留。'
        : '保留原始目标及最近完整回合。'}</span>
      <span>两组分别编码，原始目标有重叠，不可相加或推算节省量；摘要长度未知。字节数不是服务端 tokens 或实际费用，范围可用不代表预算或模型连接校验通过。</span>
    </> : <span>{unavailable ?? previewReasons.unavailable}</span>}
  </div>;
}

function InTurnReceipt({ receipt, compacting, historical }: { receipt: NonNullable<NativeContextMaintenance['inTurn']>; compacting: boolean; historical: boolean }) {
  const known = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value) && value >= 0;
  const status = receipt.status === 'committed' ? '回合内压缩已持久保存'
    : receipt.status === 'failed' ? '回合内压缩未完成，本回合不再自动重试'
    : receipt.status === 'attempted' && compacting ? '回合内压缩已登记，正在等待提交结果'
    : '回合内压缩结果尚未确认，不能视为已完成';
  return <div className="context-compaction-receipt" role="status">
    {historical && <span>历史回合压缩回执</span>}
    <span>{status}。{receipt.status === 'committed' && known(receipt.beforeBytes) && known(receipt.afterBytes)
      ? `上下文 ${count(receipt.beforeBytes)} → ${count(receipt.afterBytes)} 字节。` : ''}原始记录保留。</span>
    <span>摘要调用：{known(receipt.summaryUsage?.inputTokens) ? `输入 ${count(receipt.summaryUsage.inputTokens)} tokens` : '输入用量未报告'} · {known(receipt.summaryUsage?.outputTokens) ? `输出 ${count(receipt.summaryUsage.outputTokens)} tokens` : '输出用量未报告'} · {known(receipt.summaryCostUSD) ? `估算费用 $${receipt.summaryCostUSD.toLocaleString(undefined, { maximumFractionDigits: 6 })}` : '费用未估算'}。此项已计入所属回合汇总，不需重复相加；请以服务商账单为准。</span>
  </div>;
}
