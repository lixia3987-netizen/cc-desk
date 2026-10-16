import { createHash, randomUUID } from 'node:crypto';
import { canonicalJson, contextBudgetUsage, DEFAULT_RUN_BUDGET, type JsonValue, type ModelContext, type RunIdentity, type UserImage } from '@cc-desk/agent-core';
import { nativeSubmissionInputDigest, type NativeRunStore } from '@cc-desk/agent-node/run-store';
import { createNativeModel, type NativeModelOptions } from '@cc-desk/agent-node/native-model';
import { contextSummaryItem } from '@cc-desk/agent-node/context-maintenance';
import type { NativeImageAttachment } from '@cc-desk/contracts/chat';
import type { parseNativeConfig } from './config';
import { prepareNativeContextSummary, summarizeNativeContext } from './context-summary';
import type { runNativeWorker } from './worker-host';

type Config = ReturnType<typeof parseNativeConfig>;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const blocked = () => new Error('这份上下文已有未完成的自动压缩尝试，已暂停本次发送。请先手动压缩，或关闭自动压缩后重新发送；不会自动重复请求摘要。');

export function pendingNativeContext(context: ModelContext, input: string, model: NativeModelOptions, images?: UserImage[]): ModelContext {
  const adapter = createNativeModel(model);
  if (context.protocol.id !== adapter.protocol.id || context.protocol.version !== adapter.protocol.version) throw new Error('已有会话不能更换模型协议，请新建会话。');
  return { ...context, items: [...context.items, ...adapter.userItems(input, images)] };
}

export function assertNativeInputBudget(context: ModelContext, input: string, instructions: string, config: Config, model: NativeModelOptions, images?: UserImage[]): void {
  const pending = pendingNativeContext(context, input, model, images);
  const estimator = createNativeModel({ ...model, instructions });
  const usage = contextBudgetUsage(pending, estimator.estimateInputUsage?.(pending, config.maxOutputTokens) ?? estimator.estimateInputTokens(pending), { maxInputTokens: config.maxInputTokens, maxContextBytes: DEFAULT_RUN_BUDGET.maxContextBytes });
  if (usage.status === 'exceeded') throw new Error('压缩后本次输入仍超过运行预算，已暂停发送；请减少输入、调整预算或新建会话，不会连续请求摘要。');
}

/** 一次发送独占整个操作；模型请求前完成预留，绝不重试结果不确定的尝试。 */
export async function autoCompactBeforeSend(options: {
  ledger: NativeRunStore; identity: RunIdentity; input: string; images?: UserImage[]; imageAttachments?: NativeImageAttachment[]; config: Config;
  model: NativeModelOptions; instructions: string; signal: AbortSignal;
  forbiddenValues?: readonly (string | undefined)[];
  startedAt: number; assertOwnership(): Promise<void>; onCompacting(): void; onCommitted(): Promise<void>;
  worker?: typeof runNativeWorker;
  /** 主 Agent 无累计调用/时长上限，摘要请求仍保留自身的传输超时。 */
  unlimited?: boolean;
}): Promise<{ compacted: boolean; remainingRequests: number }> {
  const { ledger, config, identity, input, model, images } = options;
  const inputDigest = nativeSubmissionInputDigest(input, options.imageAttachments as unknown as JsonValue), configurationDigest = digest(canonicalJson(config as JsonValue));
  const previous = ledger.lookupAutoCompaction(identity.requestId);
  if (previous && previous.inputDigest !== inputDigest) {
    throw new Error('此提交标识已用于不同的输入；请重新发送一条消息。');
  }
  // 此时尚无常规运行。显式修改设置可以恢复
  // 保留的消息；新调用绝不复用旧摘要授权。
  // 结果不确定的尝试可能已经到达供应商。必须保留其扣减，
  // 即使用户在恢复同一次提交前关闭了自动化。
  const remainingRequests = config.maxModelRequests - (previous ? 1 : 0);
  if (previous?.status === 'committed') return { compacted: true, remainingRequests };
  const context = ledger.loadContext();
  if (config.autoCompact === 'off' || !context) return { compacted: false, remainingRequests };
  const pending = pendingNativeContext(context, input, model, images);
  const estimator = createNativeModel({ ...model, instructions: options.instructions });
  const usage = contextBudgetUsage(pending, estimator.estimateInputUsage?.(pending, config.maxOutputTokens) ?? estimator.estimateInputTokens(pending), { maxInputTokens: config.maxInputTokens, maxContextBytes: DEFAULT_RUN_BUDGET.maxContextBytes });
  if (usage.status === 'within_budget') return { compacted: false, remainingRequests };
  // 过大的新消息或指令集无法通过压缩旧历史来解决。
  const minimum = pendingNativeContext({ protocol: context.protocol, items: [] }, input, model, images);
  if (contextBudgetUsage(minimum, estimator.estimateInputUsage?.(minimum, config.maxOutputTokens) ?? estimator.estimateInputTokens(minimum), { maxInputTokens: config.maxInputTokens, maxContextBytes: DEFAULT_RUN_BUDGET.maxContextBytes }).status === 'exceeded') {
    throw new Error('本次新输入、项目指令与工具定义已超过运行预算，未调用自动摘要；请减少输入、所选工具或调整预算。');
  }
  let source;
  try { source = ledger.getCompactionSource(); }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'nothing_to_compact') return { compacted: false, remainingRequests };
    throw error;
  }
  if (previous || ledger.getAutoCompactionForCurrentContext()) throw blocked();
  // 图片会固定从其首次出现轮次开始的全部后续内容。即使最短的
  // 摘要也必须与这些后续内容、当前输入、指令及工具一起落在额度内。
  const retainedMinimum = pendingNativeContext({ ...source.retainedContext,
    items: [...source.retainedContext.items, contextSummaryItem('摘要', source.retainedContext.protocol)] }, input, model, images);
  if (contextBudgetUsage(retainedMinimum, estimator.estimateInputUsage?.(retainedMinimum, config.maxOutputTokens) ?? estimator.estimateInputTokens(retainedMinimum), { maxInputTokens: config.maxInputTokens, maxContextBytes: DEFAULT_RUN_BUDGET.maxContextBytes }).status === 'exceeded') {
    throw new Error('必须保留的上下文、本次输入、项目指令与工具定义已超过运行预算，未调用自动摘要；含图会话仅可压缩首张图片所在轮次之前的纯文本，请提高预算或新建会话。');
  }
  prepareNativeContextSummary({ context: source.context, model, maxInputTokens: config.maxInputTokens, maxOutputTokens: config.maxOutputTokens, forbiddenValues: options.forbiddenValues });
  if (!options.unlimited && config.maxModelRequests < 2) throw new Error('自动压缩需要为摘要和本次任务各保留一次请求；请提高模型请求次数上限，或关闭自动压缩后重新发送。');
  const remainingMs = options.unlimited ? 60_000 : Math.floor(config.maxActiveMs - (performance.now() - options.startedAt));
  if (remainingMs < 1) throw new Error('本次执行时长预算已耗尽，未调用自动摘要。');
  options.onCompacting();
  await options.assertOwnership();
  const reservation = await ledger.reserveAutoCompaction({ requestId: identity.requestId, inputDigest, configurationDigest, expectedHash: source.expectedHash });
  if (reservation.kind !== 'reserved') throw blocked();
  // 预留操作本身会推进日志；计划只能绑定推进后的日志头。
  source = ledger.getCompactionSource();
  await options.assertOwnership();
  const summaryMs = options.unlimited ? 60_000 : Math.floor(config.maxActiveMs - (performance.now() - options.startedAt));
  if (summaryMs < 1) throw new Error('本次执行时长预算已耗尽，未调用自动摘要。');
  const result = await summarizeNativeContext({ identity: { ...identity, runId: randomUUID(), requestId: `auto-compact:${identity.requestId}` },
    context: source.context, model, maxInputTokens: config.maxInputTokens, maxOutputTokens: config.maxOutputTokens,
    maxActiveMs: summaryMs, signal: options.signal, worker: options.worker, forbiddenValues: options.forbiddenValues,
    diagnosticPurpose: 'summary_before_send', onDiagnostic: async diagnostic => { await ledger.recordModelDiagnostic(diagnostic); } });
  await options.assertOwnership();
  // 摘要请求诊断只追加元数据，会推进日志头；重新核对相同历史后绑定新头。
  const latestSource = ledger.getCompactionSource();
  if (canonicalJson(latestSource.context as unknown as JsonValue) !== canonicalJson(source.context as unknown as JsonValue)
    || canonicalJson(latestSource.retainedContext as unknown as JsonValue) !== canonicalJson(source.retainedContext as unknown as JsonValue)) {
    throw new Error('摘要期间上下文已变化，未替换原始历史。');
  }
  source = latestSource;
  const plan = ledger.planContextCompaction({ summary: result.summary, expectedHash: source.expectedHash, usage: result.usage, automaticRequestId: identity.requestId });
  await ledger.commitContextCompaction(plan);
  await options.onCommitted();
  await options.assertOwnership();
  return { compacted: true, remainingRequests: config.maxModelRequests - 1 };
}
