import { randomUUID } from 'node:crypto';
import { contextBudgetUsage, type ContextMaintenancePort, type ContextMaintenanceResult, type ContextMaintenanceFailureReason, type RunIdentity, type Usage } from '@cc-desk/agent-core';
import type { NativeRunStore } from '@cc-desk/agent-node/run-store';
import { createNativeModel, type NativeModelOptions } from '@cc-desk/agent-node/native-model';
import { assertNoModelCredential } from '@cc-desk/agent-node/responses-model';
import { contextSummaryItem, runContinuityItem } from '@cc-desk/agent-node/context-maintenance';
import { NativeContextSummaryError, prepareNativeContextSummary, summarizeNativeContext } from './context-summary';
import type { runNativeWorker } from './worker-host';
import { sameRun } from './worker-protocol';

const errorCode = (error: unknown): string | undefined => error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
const unchanged = (): ContextMaintenanceResult => ({ kind: 'unchanged', modelRequests: 0, usage: null });

/** Main-process compaction keeps the current worker, task and tools alive. */
export function createInRunCompaction(options: {
  ledger: NativeRunStore; identity: RunIdentity; model: NativeModelOptions;
  forbiddenValues: readonly string[]; signal: AbortSignal; remainingMs(): number;
  assertOwnership(): Promise<void>; assertInstructions(signal: AbortSignal): Promise<void>;
  continuity(): Promise<string>; onCompacting(): void | Promise<void>; onSettled(): Promise<void>;
  worker?: typeof runNativeWorker;
}): ContextMaintenancePort {
  let attempted = false, maintaining = false;
  const model = createNativeModel(options.model);
  return { async maintain(request) {
    if (!sameRun(request.identity, options.identity) || maintaining) throw new Error('Invalid context maintenance ownership.');
    if (attempted || options.ledger.lookupRunCompaction(options.identity.runId)) return unchanged();
    if (request.signal.aborted || options.signal.aborted) return { kind: 'failed', modelRequests: 0, usage: null, reason: 'context_maintenance_failed' };
    if (request.modelRequests < 1 || request.budget.maxModelRequests - request.modelRequests < 2 ||
        contextBudgetUsage(request.context, model.estimateInputTokens(request.context), request.budget).status === 'within_budget') return unchanged();
    maintaining = true;
    let phaseStarted = false;
    try {
      await options.assertOwnership();
      try { await options.assertInstructions(request.signal); }
      catch { return { kind: 'failed', modelRequests: 0, usage: null, reason: 'context_maintenance_failed' }; }
      let source;
      try { source = options.ledger.getRunCompactionSource(options.identity, request.context); }
      catch (error) {
        if (['nothing_to_compact', 'commands_active'].includes(errorCode(error) ?? '')) return unchanged();
        throw error;
      }
      // The current user request, project rules, tools and most recent complete
      // tool batch cannot be removed to make a paid summary appear successful.
      let continuity: string;
      try {
        continuity = await options.continuity();
        assertNoModelCredential(continuity, options.forbiddenValues);
        prepareNativeContextSummary({ context: source.context, model: options.model, maxInputTokens: request.budget.maxInputTokens, forbiddenValues: options.forbiddenValues });
      } catch { return { kind: 'failed', modelRequests: 0, usage: null, reason: 'context_maintenance_unhelpful' }; }
      const minimum = { ...source.retainedContext, items: [...source.retainedContext.items,
        contextSummaryItem('摘要', source.retainedContext.protocol), runContinuityItem(continuity, source.retainedContext.protocol)] };
      if (contextBudgetUsage(minimum, model.estimateInputTokens(minimum), request.budget).status === 'exceeded') {
        return { kind: 'failed', modelRequests: 0, usage: null, reason: 'context_maintenance_unhelpful' };
      }
      const remaining = Math.floor(Math.min(request.remainingActiveMs, options.remainingMs()));
      if (remaining < 1) return { kind: 'failed', modelRequests: 0, usage: null, reason: 'context_maintenance_failed' };
      if (request.signal.aborted || options.signal.aborted) return { kind: 'failed', modelRequests: 0, usage: null, reason: 'context_maintenance_failed' };
      await options.assertOwnership();
      const requestId = `in-turn:${options.identity.runId}`;
      // No external call is made until the one-per-run debit is durable. Any
      // write acknowledgement failure propagates as an uncertain outcome.
      const reservation = await options.ledger.reserveRunCompaction(options.identity, { requestId, contextHash: source.contextHash });
      if (reservation.kind !== 'reserved') return unchanged();
      attempted = true;
      phaseStarted = true;
      try { await options.onCompacting(); } catch { /* Projection cannot undo the durable debit. */ }
      const fail = async (reason: ContextMaintenanceFailureReason, usage: Usage | null): Promise<ContextMaintenanceResult> => {
        await options.ledger.failRunCompaction(options.identity, { requestId, reason, usage });
        return { kind: 'failed', modelRequests: 1, usage, reason };
      };
      let summary;
      try {
        summary = await summarizeNativeContext({ identity: { ...options.identity, runId: randomUUID(), requestId },
          context: source.context, model: options.model, maxInputTokens: request.budget.maxInputTokens,
          maxOutputTokens: request.budget.maxOutputTokens, maxActiveMs: Math.max(1, Math.floor(Math.min(remaining, options.remainingMs()))),
          signal: AbortSignal.any([options.signal, request.signal]), worker: options.worker, forbiddenValues: options.forbiddenValues });
      } catch (error) {
        if (error && typeof error === 'object' && 'cleanupUnconfirmed' in error && error.cleanupUnconfirmed) throw error;
        return await fail('context_maintenance_failed', error instanceof NativeContextSummaryError ? error.usage : null);
      }
      if (request.signal.aborted || options.signal.aborted) return await fail('context_maintenance_failed', summary.usage);
      await options.assertOwnership();
      try { await options.assertInstructions(request.signal); }
      catch { return await fail('context_maintenance_failed', summary.usage); }
      if (request.signal.aborted || options.signal.aborted) return await fail('context_maintenance_failed', summary.usage);
      await options.assertOwnership();
      try {
        const receipt = await options.ledger.commitRunCompaction(options.identity, { requestId, contextHash: source.contextHash,
          summary: summary.summary, continuity, usage: summary.usage });
        // The host ledger is authoritative before the main worker can switch.
        return { kind: 'compacted', modelRequests: 1, usage: summary.usage, context: receipt.context };
      } catch (error) {
        if (['compaction_not_smaller', 'invalid_summary', 'invalid_continuity'].includes(errorCode(error) ?? '')) return await fail('context_maintenance_unhelpful', summary.usage);
        throw error;
      }
    } finally {
      maintaining = false;
      // A UI repair must not turn a committed replacement into an unknown write.
      if (phaseStarted) { try { await options.onSettled(); } catch { /* Hydration repairs the read-only projection. */ } }
    }
  } };
}
