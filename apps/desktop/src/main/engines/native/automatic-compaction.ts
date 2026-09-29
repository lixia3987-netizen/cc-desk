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
  const usage = contextBudgetUsage(pending, createNativeModel({ ...model, instructions }).estimateInputTokens(pending), { maxInputTokens: config.maxInputTokens, maxContextBytes: DEFAULT_RUN_BUDGET.maxContextBytes });
  if (usage.status === 'exceeded') throw new Error('压缩后本次输入仍超过运行预算，已暂停发送；请减少输入、调整预算或新建会话，不会连续请求摘要。');
}

/** A send owns the entire operation. Reserve before any model request; never retry an uncertain attempt. */
export async function autoCompactBeforeSend(options: {
  ledger: NativeRunStore; identity: RunIdentity; input: string; images?: UserImage[]; imageAttachments?: NativeImageAttachment[]; config: Config;
  model: NativeModelOptions; instructions: string; signal: AbortSignal;
  forbiddenValues?: readonly (string | undefined)[];
  startedAt: number; assertOwnership(): Promise<void>; onCompacting(): void; onCommitted(): Promise<void>;
  worker?: typeof runNativeWorker;
}): Promise<{ compacted: boolean; remainingRequests: number }> {
  const { ledger, config, identity, input, model, images } = options;
  const inputDigest = nativeSubmissionInputDigest(input, options.imageAttachments as unknown as JsonValue), configurationDigest = digest(canonicalJson(config as JsonValue));
  const previous = ledger.lookupAutoCompaction(identity.requestId);
  if (previous && previous.inputDigest !== inputDigest) {
    throw new Error('此提交标识已用于不同的输入；请重新发送一条消息。');
  }
  // No ordinary run exists yet. An explicit settings change may resume the
  // retained message; the old summary authorization is never used for a new call.
  // An uncertain attempt may already have reached the provider. Retain its debit
  // even when the user disables automation before resuming this same submission.
  const remainingRequests = config.maxModelRequests - (previous ? 1 : 0);
  if (previous?.status === 'committed') return { compacted: true, remainingRequests };
  const context = ledger.loadContext();
  if (config.autoCompact === 'off' || !context) return { compacted: false, remainingRequests };
  const pending = pendingNativeContext(context, input, model, images);
  const estimator = createNativeModel({ ...model, instructions: options.instructions });
  const usage = contextBudgetUsage(pending, estimator.estimateInputTokens(pending), { maxInputTokens: config.maxInputTokens, maxContextBytes: DEFAULT_RUN_BUDGET.maxContextBytes });
  if (usage.status === 'within_budget') return { compacted: false, remainingRequests };
  // A large new message/instruction set cannot be fixed by summarizing old history.
  const minimum = pendingNativeContext({ protocol: context.protocol, items: [] }, input, model, images);
  if (contextBudgetUsage(minimum, estimator.estimateInputTokens(minimum), { maxInputTokens: config.maxInputTokens, maxContextBytes: DEFAULT_RUN_BUDGET.maxContextBytes }).status === 'exceeded') {
    throw new Error('本次新输入、项目指令与工具定义已超过运行预算，未调用自动摘要；请减少输入、所选工具或调整预算。');
  }
  let source;
  try { source = ledger.getCompactionSource(); }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'nothing_to_compact') return { compacted: false, remainingRequests };
    throw error;
  }
  if (previous || ledger.getAutoCompactionForCurrentContext()) throw blocked();
  // Images pin the entire suffix from their first turn. Even the shortest
  // summary must fit alongside that suffix, this input, instructions and tools.
  const retainedMinimum = pendingNativeContext({ ...source.retainedContext,
    items: [...source.retainedContext.items, contextSummaryItem('摘要', source.retainedContext.protocol)] }, input, model, images);
  if (contextBudgetUsage(retainedMinimum, estimator.estimateInputTokens(retainedMinimum), { maxInputTokens: config.maxInputTokens, maxContextBytes: DEFAULT_RUN_BUDGET.maxContextBytes }).status === 'exceeded') {
    throw new Error('必须保留的上下文、本次输入、项目指令与工具定义已超过运行预算，未调用自动摘要；含图会话仅可压缩首张图片所在轮次之前的纯文本，请提高预算或新建会话。');
  }
  prepareNativeContextSummary({ context: source.context, model, maxInputTokens: config.maxInputTokens, forbiddenValues: options.forbiddenValues });
  if (config.maxModelRequests < 2) throw new Error('自动压缩需要为摘要和本次任务各保留一次请求；请提高模型请求次数上限，或关闭自动压缩后重新发送。');
  const remainingMs = Math.floor(config.maxActiveMs - (performance.now() - options.startedAt));
  if (remainingMs < 1) throw new Error('本次执行时长预算已耗尽，未调用自动摘要。');
  options.onCompacting();
  await options.assertOwnership();
  const reservation = await ledger.reserveAutoCompaction({ requestId: identity.requestId, inputDigest, configurationDigest, expectedHash: source.expectedHash });
  if (reservation.kind !== 'reserved') throw blocked();
  // The reservation itself advances the journal. Only its new head can bind the plan.
  source = ledger.getCompactionSource();
  await options.assertOwnership();
  const summaryMs = Math.floor(config.maxActiveMs - (performance.now() - options.startedAt));
  if (summaryMs < 1) throw new Error('本次执行时长预算已耗尽，未调用自动摘要。');
  const result = await summarizeNativeContext({ identity: { ...identity, runId: randomUUID(), requestId: `auto-compact:${identity.requestId}` },
    context: source.context, model, maxInputTokens: config.maxInputTokens, maxOutputTokens: config.maxOutputTokens,
    maxActiveMs: summaryMs, signal: options.signal, worker: options.worker, forbiddenValues: options.forbiddenValues });
  await options.assertOwnership();
  const plan = ledger.planContextCompaction({ summary: result.summary, expectedHash: source.expectedHash, usage: result.usage, automaticRequestId: identity.requestId });
  await ledger.commitContextCompaction(plan);
  await options.onCommitted();
  await options.assertOwnership();
  return { compacted: true, remainingRequests: config.maxModelRequests - 1 };
}
