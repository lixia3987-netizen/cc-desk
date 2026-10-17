import { randomUUID } from 'node:crypto';
import { canonicalJson, contextBudgetUsage, type ContextMaintenancePort, type ContextMaintenanceResult, type ContextMaintenanceFailureReason, type JsonValue, type ModelContext, type RunIdentity, type Usage } from '@cc-desk/agent-core';
import type { NativeRunStore } from '@cc-desk/agent-node/run-store';
import { createNativeModel, type NativeModelOptions } from '@cc-desk/agent-node/native-model';
import { assertNoModelCredential } from '@cc-desk/agent-node/responses-model';
import { contextSummaryItem, runContinuityItem } from '@cc-desk/agent-node/context-maintenance';
import { skillContinuityItems, type SkillContinuitySection } from '@cc-desk/agent-node/skill-continuity';
import { NativeContextSummaryError, prepareNativeContextSummary, summarizeNativeContext } from './context-summary';
import type { runNativeWorker } from './worker-host';
import { sameRun } from './worker-protocol';

const errorCode = (error: unknown): string | undefined => error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
const unchanged = (): ContextMaintenanceResult => ({ kind: 'unchanged', modelRequests: 0, usage: null });

/** 主进程压缩会保持当前工作进程、任务及工具继续存活。 */
export function createInRunCompaction(options: {
  ledger: NativeRunStore; identity: RunIdentity; model: NativeModelOptions;
  forbiddenValues: readonly string[]; signal: AbortSignal; remainingMs(): number;
  assertOwnership(): Promise<void>; assertInstructions(signal: AbortSignal): Promise<void>;
  continuity(): Promise<string>; onCompacting(): void | Promise<void>; onSettled(): Promise<void>;
  /** Full guides are preserved independently of the task/evidence summary. */
  skills?: {
    prepare(retainedContext: ModelContext): Promise<SkillContinuitySection | undefined>;
    onCommitted(seq: number, section: SkillContinuitySection): void;
  };
  worker?: typeof runNativeWorker;
}): ContextMaintenancePort {
  let attempted = false, maintaining = false;
  const model = createNativeModel(options.model);
  return { async maintain(request) {
    if (!sameRun(request.identity, options.identity) || maintaining) throw new Error('Invalid context maintenance ownership.');
    if (attempted || options.ledger.lookupRunCompaction(options.identity.runId)) return unchanged();
    if (request.signal.aborted || options.signal.aborted) return { kind: 'failed', modelRequests: 0, usage: null, reason: 'context_maintenance_failed' };
    if (request.modelRequests < 1 || !request.budget.unlimited && request.budget.maxModelRequests - request.modelRequests < 2 ||
        contextBudgetUsage(request.context, model.estimateInputUsage?.(request.context, request.budget.maxOutputTokens) ?? model.estimateInputTokens(request.context), request.budget).status === 'within_budget') return unchanged();
    maintaining = true;
    let phaseStarted = false;
    try {
      await options.assertOwnership();
      try { await options.assertInstructions(request.signal); }
      catch { return { kind: 'failed', modelRequests: 0, usage: null, reason: 'context_maintenance_failed' }; }
      let source;
      try { source = options.ledger.getRunCompactionSource(options.identity, request.context); }
      catch (error) {
        if (errorCode(error) === 'image_context_compaction_unsupported') return { kind: 'failed', modelRequests: 0, usage: null, reason: 'context_maintenance_images_unsupported' };
        if (['nothing_to_compact', 'commands_active'].includes(errorCode(error) ?? '')) return unchanged();
        throw error;
      }
      // 不能移除当前用户请求、项目规则、工具及最近一次完整的
      // 工具批次，以制造付费摘要已成功的假象。
      let continuity: string;
      let nativeSkills: SkillContinuitySection | undefined;
      try {
        continuity = await options.continuity();
        assertNoModelCredential(continuity, options.forbiddenValues);
        nativeSkills = await options.skills?.prepare(source.retainedContext);
        if (nativeSkills) assertNoModelCredential(nativeSkills, options.forbiddenValues);
        prepareNativeContextSummary({ context: source.context, model: options.model, maxInputTokens: request.budget.maxInputTokens,
          maxOutputTokens: request.budget.maxOutputTokens, maxContextBytes: request.budget.maxContextBytes, forbiddenValues: options.forbiddenValues });
      } catch { return { kind: 'failed', modelRequests: 0, usage: null, reason: 'context_maintenance_unhelpful' }; }
      const replacement = (summary: string) => ({ ...source.retainedContext, items: [
        ...source.retainedContext.items.slice(0, source.retainedPrefixItems),
        contextSummaryItem(summary, source.retainedContext.protocol), runContinuityItem(continuity, source.retainedContext.protocol),
        ...(nativeSkills ? skillContinuityItems(nativeSkills, source.retainedContext.protocol) : []),
        ...source.retainedContext.items.slice(source.retainedPrefixItems)] });
      const minimum = replacement('摘要');
      if (contextBudgetUsage(minimum, model.estimateInputUsage?.(minimum, request.budget.maxOutputTokens) ?? model.estimateInputTokens(minimum), request.budget).status === 'exceeded') {
        return { kind: 'failed', modelRequests: 0, usage: null, reason: 'context_maintenance_unhelpful' };
      }
      const remaining = request.budget.unlimited ? 60_000 : Math.floor(Math.min(request.remainingActiveMs, options.remainingMs()));
      if (remaining < 1) return { kind: 'failed', modelRequests: 0, usage: null, reason: 'context_maintenance_failed' };
      if (request.signal.aborted || options.signal.aborted) return { kind: 'failed', modelRequests: 0, usage: null, reason: 'context_maintenance_failed' };
      await options.assertOwnership();
      const requestId = `in-turn:${options.identity.runId}`;
      // 每次运行限一次的扣减持久化之前，不发起外部调用。任何
      // 写入确认失败都以结果不确定的状态向上传播。
      const reservation = await options.ledger.reserveRunCompaction(options.identity, { requestId, contextHash: source.contextHash });
      if (reservation.kind !== 'reserved') return unchanged();
      attempted = true;
      phaseStarted = true;
      try { await options.onCompacting(); } catch { /* 投影不能撤销已持久化的扣减。 */ }
      const fail = async (reason: ContextMaintenanceFailureReason, usage: Usage | null): Promise<ContextMaintenanceResult> => {
        await options.ledger.failRunCompaction(options.identity, { requestId, reason, usage });
        return { kind: 'failed', modelRequests: 1, usage, reason };
      };
      let summary;
      try {
        summary = await summarizeNativeContext({ identity: { ...options.identity, runId: randomUUID(), requestId },
          context: source.context, model: options.model, maxInputTokens: request.budget.maxInputTokens, maxContextBytes: request.budget.maxContextBytes,
          maxOutputTokens: request.budget.maxOutputTokens, maxActiveMs: Math.max(1, Math.floor(Math.min(remaining, options.remainingMs()))),
          signal: AbortSignal.any([options.signal, request.signal]), worker: options.worker, forbiddenValues: options.forbiddenValues,
          diagnosticPurpose: 'summary_in_run', diagnosticIdentity: { parentRunId: options.identity.runId },
          onDiagnostic: async diagnostic => { await options.ledger.recordModelDiagnostic(diagnostic); } });
      } catch (error) {
        if (error && typeof error === 'object' && 'cleanupUnconfirmed' in error && error.cleanupUnconfirmed) throw error;
        return await fail('context_maintenance_failed', error instanceof NativeContextSummaryError ? error.usage : null);
      }
      if (request.signal.aborted || options.signal.aborted) return await fail('context_maintenance_failed', summary.usage);
      await options.assertOwnership();
      try {
        const latestSkills = await options.skills?.prepare(source.retainedContext);
        if (canonicalJson((latestSkills ?? null) as unknown as JsonValue) !== canonicalJson((nativeSkills ?? null) as unknown as JsonValue)) throw new Error('Skill continuity changed during compaction.');
        await options.assertInstructions(request.signal);
      }
      catch { return await fail('context_maintenance_failed', summary.usage); }
      if (request.signal.aborted || options.signal.aborted) return await fail('context_maintenance_failed', summary.usage);
      const candidate = replacement(summary.summary);
      if (contextBudgetUsage(candidate, model.estimateInputUsage?.(candidate, request.budget.maxOutputTokens) ?? model.estimateInputTokens(candidate), request.budget).status === 'exceeded') {
        return await fail('context_maintenance_unhelpful', summary.usage);
      }
      await options.assertOwnership();
      let receipt;
      try {
        receipt = await options.ledger.commitRunCompaction(options.identity, { requestId, contextHash: source.contextHash,
          summary: summary.summary, continuity, usage: summary.usage, ...(nativeSkills ? { nativeSkills } : {}) });
      } catch (error) {
        if (['compaction_not_smaller', 'invalid_summary', 'invalid_continuity'].includes(errorCode(error) ?? '')) return await fail('context_maintenance_unhelpful', summary.usage);
        throw error;
      }
      // Reset observation only after the complete replacement is durable. A
      // failed hook must propagate, never relabel a committed replacement as failed.
      if (receipt.nativeSkills) options.skills?.onCommitted(receipt.seq, receipt.nativeSkills);
      return { kind: 'compacted', modelRequests: 1, usage: summary.usage, context: receipt.context };
    } finally {
      maintaining = false;
      // 界面修复不能将已提交的替换变成结果不确定的写入。
      if (phaseStarted) { try { await options.onSettled(); } catch { /* 水合过程修复只读投影。 */ } }
    }
  } };
}
