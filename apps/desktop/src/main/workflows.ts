import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DEFAULT_WORKFLOW_STAGES, NATIVE_WORKFLOW_POLICIES_ENABLED } from '../shared/workflows';
import type { NewWorkflow, WorkflowBinding, WorkflowRun, WorkflowStage, WorkflowStageResult } from '../shared/workflows';
import type { WorkflowConfirmation, WorkflowNativeReceipt, WorkflowVerification } from '../shared/workflows';
import { getNativeTaskCriterionVerification, type NativeTaskView } from '@cc-desk/contracts/native-task';
import { MAX_STORED_RUNS, newWorkflowSchema, validateGraph, workflowBindingSchema, workflowNativeReceiptSchema, workflowQualityFailure } from './workflow-schema';
import type { WorkflowState } from './workflow-schema';
import { WorkflowStorage } from './workflow-storage';
import type { ExecutionSubmission } from './execution/ports';

export { newWorkflowSchema } from './workflow-schema';

interface ActiveRun { cancelled: boolean; completion: Promise<void>; persistenceFailed?: boolean }
export interface WorkflowEngineOptions {
  /** 必须拒绝已删除、已归档或非结构化会话，并返回已声明的执行器身份。 */
  getSession(sessionId: string): WorkflowBinding;
  /** 仅在真实结构化轮次结果返回后完成，不能在写入 stdin 后完成。 */
  runStage(sessionId: string, prompt: string, titlePrompt: string, submission?: ExecutionSubmission): Promise<WorkflowStageResult>;
  cancelSession(sessionId: string): void | Promise<void>;
  onChange?(runs: WorkflowRun[]): void;
  /** 释放此外层持有者前，必须持久化所有阶段结果和终态。 */
  settled?(sessionId: string): void | Promise<void>;
  /** 批准 Native 阶段前，刷新权威任务依据和工作区。 */
  inspectNativeTask?(receipt: WorkflowNativeReceipt): Promise<NativeTaskView | undefined>;
  nativePoliciesEnabled?: boolean;
}

function errorText(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 4000); }

/** 顺序、持久化编排。取消不会回滚文件系统副作用。 */
export class WorkflowEngine {
  readonly file: string;
  private state: WorkflowState;
  private readonly storage: WorkflowStorage;
  private readonly active = new Map<string, ActiveRun>();
  private readonly sessionOwners = new Map<string, string>();
  private closed = false;

  constructor(directory: string, private readonly options: WorkflowEngineOptions) {
    this.storage = new WorkflowStorage(directory);
    this.file = this.storage.file;
    this.state = this.storage.load();
    if (this.state.runs.some(run => run.status === 'running')) {
      this.commit(state => {
        for (const run of state.runs) {
          if (run.status !== 'running') continue;
          run.status = 'interrupted';
          run.error = '应用关闭时工作流尚未完成。请检查现有文件与执行记录后，手动继续；已产生的操作不会自动撤销。';
          run.updatedAt = new Date().toISOString();
          for (const stage of run.stages) if (stage.status === 'running') stage.status = 'interrupted';
        }
      });
    }
  }

  list(sessionId?: string): WorkflowRun[] {
    return structuredClone(this.state.runs.filter(run => !sessionId || run.sessionId === sessionId));
  }

  private inactive(id: string): WorkflowRun {
    const run = this.get(id);
    if (this.active.has(id) || run.status === 'running') throw new Error('工作流仍在运行或停止中，请等待完全停止后再导出或删除。');
    return run;
  }

  /** 显式移除历史不会取消任务或修改其输出文件。 */
  remove(id: string): void {
    this.inactive(id);
    this.commit(state => { state.runs = state.runs.filter(run => run.id !== id); });
  }

  exportRun(id: string): string {
    return JSON.stringify({ version: 1, runs: [this.inactive(id)] }, null, 2) + '\n';
  }

  removeSession(sessionId: string): void {
    if (this.isSessionBusy(sessionId)) throw new Error('会话仍有运行或停止中的工作流。');
    if (!this.state.runs.some(run => run.sessionId === sessionId)) return;
    for (const run of this.state.runs) if (run.sessionId === sessionId) this.inactive(run.id);
    this.commit(state => { state.runs = state.runs.filter(run => run.sessionId !== sessionId); });
  }

  create(input: NewWorkflow): WorkflowRun {
    if (this.closed) throw new Error('工作流引擎正在关闭');
    if (this.state.runs.length >= MAX_STORED_RUNS) throw new Error(`已保留 ${MAX_STORED_RUNS} 条工作流记录，请在“全部记录”中导出并删除不再需要的已停止工作流，再创建新工作流。`);
    const parsed = newWorkflowSchema.parse(input);
    const binding = workflowBindingSchema.parse(this.options.getSession(parsed.sessionId));
    if (binding.sessionId !== parsed.sessionId) throw new Error('工作流会话绑定不匹配');
    const definitions = parsed.stages ?? DEFAULT_WORKFLOW_STAGES;
    const policiesEnabled = this.options.nativePoliciesEnabled ?? NATIVE_WORKFLOW_POLICIES_ENABLED;
    if (parsed.collaboration && (binding.providerId !== 'native' || !policiesEnabled)) throw new Error('显式协作策略仅支持已启用阶段权限的自研 Agent。');
    if (!policiesEnabled && parsed.stages?.some(stage => stage.toolPolicy === 'read_only')) throw new Error('阶段只读权限尚未启用。');
    if (binding.providerId !== 'native' && (parsed.budget || definitions.some(stage => stage.gate === 'native_task') || parsed.stages?.some(stage => stage.toolPolicy === 'read_only'))) throw new Error('严格只读、任务证据门槛和旧版累计预算仅支持自研 Agent；请使用普通阶段或切换执行器。');
    const stages: WorkflowStage[] = definitions.map(stage => ({
      ...stage, dependsOn: [...(stage.dependsOn ?? [])], status: 'pending', attempts: 0,
      maxAttempts: parsed.maxAttempts, artifacts: [],
      gate: stage.gate ?? 'none', toolPolicy: binding.providerId === 'native' && policiesEnabled ? stage.toolPolicy ?? 'standard' : 'standard',
    }));
    validateGraph(stages);
    const now = new Date().toISOString();
    const run: WorkflowRun = {
      ...binding, id: randomUUID(), title: parsed.title ?? parsed.goal.slice(0, 80),
      goal: parsed.goal, status: 'draft', stages, pauseAfterEachStage: parsed.pauseAfterEachStage,
      ...(parsed.collaboration ? { collaboration: parsed.collaboration } : {}),
      createdAt: now, updatedAt: now,
      ...(binding.providerId === 'native' ? { usage: { modelRequests: 0, toolCalls: 0, activeMs: 0, recordedExecutionIds: [], complete: true } } : {}),
    };
    this.commit(state => state.runs.unshift(run));
    return structuredClone(run);
  }

  start(id: string): WorkflowRun {
    const run = this.get(id);
    if (run.status !== 'draft') throw new Error('仅新建工作流可以启动；暂停后请继续，失败后请重试');
    return this.launch(id);
  }

  continue(id: string): WorkflowRun {
    const run = this.get(id);
    if (!['paused', 'interrupted'].includes(run.status)) throw new Error('仅暂停或中断的工作流可以继续');
    const interrupted = run.stages.find(stage => stage.status === 'interrupted');
    if (interrupted && interrupted.attempts >= interrupted.maxAttempts) throw new Error('中断阶段已达到执行次数上限，请检查现有结果后新建工作流');
    return this.launch(id, 'interrupted');
  }

  retry(id: string): WorkflowRun {
    const run = this.get(id);
    if (run.status !== 'failed') throw new Error('仅失败的工作流可以重试');
    const failed = run.stages.find(stage => stage.status === 'failed');
    if (!failed) throw new Error('没有可重试的阶段');
    if (failed.attempts >= failed.maxAttempts) throw new Error('该阶段已达到执行次数上限；请检查现有结果后新建工作流');
    return this.launch(id, 'failed');
  }

  reviseStage(id: string, stageId: string, instruction: string): WorkflowRun {
    const text = z.string().trim().min(1).max(20_000).parse(instruction);
    if (this.active.has(id)) throw new Error('请先停止当前执行再修改阶段');
    const run = this.get(id);
    if (['completed', 'cancelled'].includes(run.status)) throw new Error('已结束的工作流不能修改');
    const stage = run.stages.find(item => item.id === stageId);
    if (!stage || !['pending', 'failed', 'interrupted'].includes(stage.status)) throw new Error('只能修改尚未完成且不在等待验收的阶段');
    this.update(id, draft => { draft.stages.find(item => item.id === stageId)!.instruction = text; });
    return this.get(id);
  }

  private gatedStage(input: WorkflowVerification, expected: 'waiting_confirmation' | 'waiting_verification'): { run: WorkflowRun; stage: WorkflowStage } {
    const run = this.get(input.id), stage = run.stages.find(item => item.id === input.stageId);
    if (this.active.has(input.id) || run.status !== expected || !stage || stage.status !== expected || stage.attempts !== input.expectedAttempt) throw new Error('阶段状态已变化，请刷新后确认。');
    this.assertBinding(run);
    return { run, stage };
  }

  confirmStage(input: WorkflowConfirmation): WorkflowRun {
    const { stage } = this.gatedStage(input, 'waiting_confirmation');
    const reason = z.string().trim().min(1).max(4000).parse(input.reason);
    this.update(input.id, draft => {
      const current = draft.stages.find(item => item.id === stage.id)!;
      current.confirmation = { decision: input.decision, reason, at: new Date().toISOString() };
      if (input.decision === 'approve') this.completeGatedStage(draft, current);
      else current.gateReason = '用户未确认此阶段：' + reason;
    });
    return this.get(input.id);
  }

  async verifyStage(input: WorkflowVerification): Promise<WorkflowRun> {
    const { stage } = this.gatedStage(input, 'waiting_verification');
    const receipt = stage.nativeReceipts?.at(-1);
    let reason = '此阶段未记录可核查的 Native 任务，请检查执行记录。';
    let approved = false;
    if (receipt?.taskId && this.options.inspectNativeTask) {
      const task = await this.options.inspectNativeTask(structuredClone(receipt));
      this.gatedStage(input, 'waiting_verification');
      if (!task || task.taskId !== receipt.taskId || (['sessionId', 'conversationId', 'runId', 'requestId', 'workerGeneration'] as const).some(key => task.identity[key] !== receipt.identity[key])) reason = '任务身份已变化，不能用于确认此阶段。';
      else if (task.execution === 'active' || task.revision < (receipt.taskRevision ?? 0) || task.planRevision !== receipt.planRevision || task.acceptanceRevision !== receipt.acceptanceRevision) reason = '任务或验收条件已变化，请检查对应执行记录。';
      else if (!receipt.workspace?.complete || !task.workspace?.current.complete || task.workspace.current.fingerprint !== receipt.workspace.fingerprint) reason = '工作区内容已变化或核查不完整，原阶段证据不能确认通过。';
      else {
        const selected = stage.criterionIds?.length ? stage.criterionIds : task.criteria.map(item => item.id);
        if (!selected.length || selected.some(id => !task.criteria.some(item => item.id === id))) reason = '此阶段缺少有效的验收条件，请在任务面板核查。';
        else {
          const missingReferences = selected.filter(id => {
            const current = task.criteria.find(item => item.id === id)!, recorded = receipt.criteria.find(item => item.id === id);
            return !recorded || recorded.description !== current.description || recorded.kind !== current.kind || JSON.stringify(recorded.stepIds) !== JSON.stringify(current.stepIds);
          });
          const incompleteSteps = [...new Set(selected.flatMap(id => task.criteria.find(item => item.id === id)!.stepIds))]
            .filter(id => task.steps.find(item => item.id === id)?.status !== 'implemented');
          const unresolved = selected.filter(id => !['passed', 'not_applicable'].includes(getNativeTaskCriterionVerification(task, id)));
          approved = !missingReferences.length && !incompleteSteps.length && !unresolved.length;
          reason = missingReferences.length ? `阶段成果缺少完整的验收条件引用：${missingReferences.join('、')}。请核查完整任务记录，不能从截断列表自动确认。`
            : incompleteSteps.length ? `验收条件引用的任务步骤尚未实现：${incompleteSteps.join('、')}。请核查对应任务。`
              : approved ? '' : `尚待核查的验收条件：${unresolved.join('、')}。请在任务面板复核后重新检查。`;
        }
      }
    }
    this.update(input.id, draft => {
      const current = draft.stages.find(item => item.id === stage.id)!;
      if (approved) this.completeGatedStage(draft, current); else current.gateReason = reason;
    });
    return this.get(input.id);
  }

  private completeGatedStage(run: WorkflowRun, stage: WorkflowStage): void {
    stage.status = 'completed'; delete stage.gateReason;
    // 新协作策略在人工验收后仍需异步核查最终工作区；继续操作只核查，不重复阶段。
    run.status = run.stages.every(item => item.status === 'completed') && !this.qualityEnabled(run) ? 'completed' : 'paused';
  }

  private qualityEnabled(run: WorkflowRun): boolean {
    return run.providerId === 'native' && Boolean(run.collaboration && run.collaboration !== 'single_agent');
  }

  private qualityValidation(run: WorkflowRun, stage: WorkflowStage): 'commands' | 'static' | undefined {
    if (!this.qualityEnabled(run)) return;
    if (stage.toolPolicy !== 'read_only') return 'commands';
    if (run.stages.every(item => item.toolPolicy === 'read_only') && run.stages.every(item => item.id === stage.id || item.status === 'completed')) return 'static';
  }

  /** 后续合法实现会让旧快照过期；只将最后一次标准阶段的完整审查作为最终版本依据。 */
  private async finalQualityFailure(run: WorkflowRun, latestReceipt?: WorkflowNativeReceipt): Promise<string | undefined> {
    if (!this.qualityEnabled(run)) return;
    const standard = run.stages.filter(stage => stage.toolPolicy !== 'read_only');
    const history = (standard.length ? standard : run.stages).flatMap(stage => stage.nativeReceipts ?? []);
    const ordered = run.usage?.recordedExecutionIds ?? [];
    const receipt = latestReceipt ?? history.sort((left, right) => ordered.indexOf(left.identity.runId) - ordered.indexOf(right.identity.runId)).at(-1);
    const invalid = workflowQualityFailure(receipt, run.collaboration!, standard.length ? 'commands' : 'static');
    if (invalid) return invalid;
    if (!receipt) return '缺少最终质量审查的执行回执。';
    if (!this.options.inspectNativeTask) return '当前执行器无法核查最终工作区版本，不能完成独立质量交付。';
    try {
      const task = await this.options.inspectNativeTask(structuredClone(receipt));
      if (!task || task.taskId !== receipt.taskId || (['sessionId', 'conversationId', 'runId', 'requestId', 'workerGeneration'] as const).some(key => task.identity[key] !== receipt.identity[key])) return '最终质量审查对应任务身份已变化，不能完成工作流。';
      if (task.execution === 'active' || !task.workspace?.current.complete || task.workspace.current.fingerprint !== receipt.workspace?.fingerprint
        || task.workspace.current.fingerprint !== receipt.workflowQuality?.workspaceFingerprint) return '最终工作区版本已变化或核查不完整，请修复并重新进行独立质量审查。';
      if (task.planRevision !== receipt.planRevision || task.acceptanceRevision !== receipt.acceptanceRevision) return '最终质量审查后任务计划或验收条件已变化，请重新审查。';
    } catch (error) { return `最终质量审查版本核查失败：${errorText(error)}`; }
  }

  private recordReceipt(run: WorkflowRun, stage: WorkflowStage, receipt?: WorkflowNativeReceipt): void {
    if (!receipt) { if (run.providerId === 'native' && run.usage) run.usage.complete = false; return; }
    const prior = run.stages.flatMap(item => item.nativeReceipts ?? []).find(item => item.identity.runId === receipt.identity.runId);
    if (prior && (prior.identity.requestId !== receipt.identity.requestId || prior.identity.conversationId !== receipt.identity.conversationId || prior.identity.workerGeneration !== receipt.identity.workerGeneration)) throw new Error('重复执行标识对应不同提交，请核查阶段回执。');
    stage.executionIds ??= []; stage.nativeReceipts ??= [];
    if (!stage.executionIds.includes(receipt.identity.runId)) { stage.executionIds.push(receipt.identity.runId); stage.nativeReceipts.push(receipt); }
    stage.taskId = receipt.taskId;
    run.usage ??= { modelRequests: 0, toolCalls: 0, activeMs: 0, recordedExecutionIds: [], complete: true };
    if (!run.usage.recordedExecutionIds.includes(receipt.identity.runId)) {
      run.usage.recordedExecutionIds.push(receipt.identity.runId);
      run.usage.modelRequests += receipt.usage.modelRequests; run.usage.toolCalls += receipt.usage.toolCalls; run.usage.activeMs += receipt.usage.activeMs;
    }
  }

  async cancel(id: string): Promise<WorkflowRun> {
    const run = this.get(id);
    const token = this.active.get(id);
    if (run.status === 'completed' || (run.status === 'cancelled' && !token && this.sessionOwners.get(run.sessionId) !== id)) return run;
    const errors: unknown[] = [];
    // 等待进程终止回调前，先使迟到的完成事件失效。
    if (token) token.cancelled = true;
    try { this.update(id, draft => {
      draft.status = 'cancelled';
      draft.error = '工作流已取消；已执行的文件或外部操作不会自动撤销。';
      for (const stage of draft.stages) if (stage.status === 'running') {
        stage.status = 'cancelled'; stage.finishedAt = new Date().toISOString();
      }
    }); if (token) token.persistenceFailed = false;
    } catch (error) { if (token) token.persistenceFailed = true; errors.push(error); }
    if (token) {
      try { await this.options.cancelSession(run.sessionId); }
      catch (error) {
        errors.push(error);
        try { this.update(id, draft => { draft.error = `工作流已取消，但会话停止失败：${errorText(error)}`.slice(0, 4000); }); }
        catch (failure) { token.persistenceFailed = true; errors.push(failure); }
      }
    }
    else if (!errors.length && this.sessionOwners.get(run.sessionId) === id) {
      // 显式取消可修复此前失败的终态确认，无须重放阶段。
      this.sessionOwners.delete(run.sessionId);
      await this.options.settled?.(run.sessionId);
    }
    if (errors.length) throw new AggregateError(errors, `工作流取消或状态保存失败：${errors.map(errorText).join('\n')}`);
    return this.get(id);
  }

  isSessionBusy(sessionId: string): boolean { return this.sessionOwners.has(sessionId); }

  async wait(id: string): Promise<WorkflowRun> {
    await this.active.get(id)?.completion;
    return this.get(id);
  }

  /** 应用退出时调用；重启不能默默重复工具调用。 */
  async shutdown(): Promise<void> {
    this.closed = true;
    await this.interruptRuns('应用退出导致工作流中断，请检查现有结果后手动继续。');
  }
  async disconnectAll(): Promise<void> {
    await this.interruptRuns('Claude Code 更新导致工作流中断，请检查现有结果后手动继续。', undefined, true);
  }
  async disconnectSessions(ids: readonly string[], reason = '执行器维护导致工作流中断，请检查现有结果后手动继续。'): Promise<void> {
    await this.interruptRuns(reason, new Set(ids), true);
  }
  private async interruptRuns(reason: string, sessionIds?: ReadonlySet<string>, waitForCompletion = false): Promise<void> {
    const selected = this.state.runs.filter(run => !sessionIds || sessionIds.has(run.sessionId));
    const selectedIds = new Set(selected.map(run => run.id));
    const running = [...this.active.entries()].filter(([id]) => selectedIds.has(id));
    // 在任何可能失败的持久化操作之前，使选中的全部迟到结果失效。
    for (const [,token] of running) token.cancelled = true;
    const errors:unknown[]=[];
    // 保存失败后重试时，也应包含内存中仍标记为运行的旧记录；
    // 存储不可用期间，它们的运行器可能已经结束。
    for (const id of new Set([...running.map(([id])=>id),...selected.filter(run=>run.status==='running').map(run=>run.id)])) {
      try {
        this.update(id, run => {
          if (run.status !== 'running') return;
          run.status = 'interrupted'; run.error = reason;
          for (const stage of run.stages) if (stage.status === 'running') stage.status = 'interrupted';
        });
      } catch(error) { const token = this.active.get(id); if (token) token.persistenceFailed = true; errors.push(error); }
    }
    for(const result of await Promise.allSettled(running.map(([id])=>Promise.resolve().then(()=>this.options.cancelSession(this.get(id).sessionId))))) {
      if(result.status==='rejected')errors.push(result.reason);
    }
    // 持久化或取消失败时，必须等运行器结束后才能解除维护。
    if (waitForCompletion) for (const result of await Promise.allSettled(running.map(([,token]) => token.completion))) {
      if (result.status === 'rejected') errors.push(result.reason);
    }
    for (const run of this.state.runs) {
      if ((sessionIds && !sessionIds.has(run.sessionId)) || this.active.has(run.id) || run.status === 'running' || this.sessionOwners.get(run.sessionId) !== run.id) continue;
      this.sessionOwners.delete(run.sessionId);
      try { await this.options.settled?.(run.sessionId); } catch (error) { errors.push(error); }
    }
    if(errors.length)throw new AggregateError(errors,`工作流停止或状态保存失败：${errors.map(errorText).join('\n')}`);
  }

  private get(id: string): WorkflowRun {
    const run = this.state.runs.find(item => item.id === id);
    if (!run) throw new Error('工作流不存在');
    return structuredClone(run);
  }

  private assertBinding(run: WorkflowRun): void {
    const current = workflowBindingSchema.parse(this.options.getSession(run.sessionId));
    if (current.providerId !== run.providerId || current.executionMode !== run.executionMode) {
      throw new Error('会话的执行后端或执行模式已改变，不能继续执行此工作流');
    }
    if (current.sessionId !== run.sessionId || current.projectId !== run.projectId || current.cwd !== run.cwd || current.worktree !== run.worktree) {
      throw new Error('会话的项目或工作目录已改变，不能继续执行此工作流');
    }
  }

  private launch(id: string, resetStatus?: 'failed' | 'interrupted'): WorkflowRun {
    if (this.closed) throw new Error('工作流引擎正在关闭');
    const run = this.get(id);
    if (this.active.has(id) || this.sessionOwners.has(run.sessionId)) throw new Error('此会话已有工作流正在运行或停止中');
    this.assertBinding(run);
    this.update(id, draft => {
      draft.status = 'running'; delete draft.error;
      if (resetStatus) for (const stage of draft.stages) if (stage.status === resetStatus) {
        stage.status = 'pending'; delete stage.error;
      }
    });
    const token: ActiveRun = { cancelled: false, completion: Promise.resolve() };
    this.active.set(id, token);
    this.sessionOwners.set(run.sessionId, id);
    token.completion = Promise.resolve().then(() => this.execute(id, token)).catch(error => {
      if (token.cancelled) return;
      // 存储错误会停止派发；保存失败后不能继续下一个阶段。
      try { this.update(id, draft => {
        draft.status = 'interrupted'; draft.error = errorText(error);
        for (const stage of draft.stages) if (stage.status === 'running') stage.status = 'interrupted';
      }); } catch { token.persistenceFailed = true; /* 保留所有权，直到修复已持久化。 */ }
    }).finally(async () => {
      if (this.active.get(id) === token) this.active.delete(id);
      if (!token.persistenceFailed && this.sessionOwners.get(run.sessionId) === id) {
        this.sessionOwners.delete(run.sessionId);
        await this.options.settled?.(run.sessionId);
      }
    });
    void token.completion.catch(() => { /* wait() 仍会报告清理失败；避免未被等待的 Promise 拒绝。 */ });
    return this.get(id);
  }

  private async execute(id: string, token: ActiveRun): Promise<void> {
    while (!token.cancelled) {
      const run = this.get(id);
      const stage = run.stages.find(item => item.status === 'pending' && item.dependsOn.every(dependency => run.stages.find(other => other.id === dependency)?.status === 'completed'));
      if (!stage) {
        if (run.stages.every(item => item.status === 'completed')) {
          const failure = await this.finalQualityFailure(run);
          if (token.cancelled) return;
          this.update(id, draft => { draft.status = failure ? 'interrupted' : 'completed'; if (failure) draft.error = failure; });
        }
        else throw new Error('工作流没有可执行阶段，请检查依赖和阶段状态');
        return;
      }
      if (stage.attempts >= stage.maxAttempts) throw new Error('阶段已达到执行次数上限');
      this.assertBinding(run);
      this.update(id, draft => {
        const current = draft.stages.find(item => item.id === stage.id)!;
        current.status = 'running'; current.attempts += 1; current.startedAt = new Date().toISOString();
        delete current.finishedAt; delete current.error;
        delete current.gateReason; delete current.confirmation;
      });
      let result: WorkflowStageResult;
      const qualityValidation = this.qualityValidation(run, stage);
      try { result = await this.options.runStage(run.sessionId, this.prompt(run, stage), run.goal, {
        requestId: `workflow:${run.id}:${stage.id}:${stage.attempts + 1}`,
        source: 'workflow', workflowRunId: run.id, stageId: stage.id, attempt: stage.attempts + 1,
        ...(run.providerId === 'native' && (this.options.nativePoliciesEnabled ?? NATIVE_WORKFLOW_POLICIES_ENABLED) ? { nativeExecutionPolicy: { toolPolicy: stage.toolPolicy ?? 'standard', ...(run.collaboration ? { collaboration: run.collaboration } : {}), ...(qualityValidation ? { qualityValidation } : {}) } } : {}),
      }); }
      catch (error) { result = { success: false, summary: '', error: errorText(error) }; }
      if (!result || typeof result.success !== 'boolean' || typeof result.summary !== 'string') {
        result = { success: false, summary: '', error: '会话未返回有效的结构化阶段结果' };
      }
      let receipt: WorkflowNativeReceipt | undefined;
      try {
        if (result.nativeReceipt) {
          receipt = workflowNativeReceiptSchema.parse(result.nativeReceipt);
          if (receipt.identity.sessionId !== run.sessionId || receipt.identity.requestId !== `workflow:${run.id}:${stage.id}:${stage.attempts + 1}`) throw new Error('阶段执行回执与提交身份不匹配。');
          const prior = run.stages.flatMap(item => item.nativeReceipts ?? []).find(item => item.identity.runId === receipt!.identity.runId);
          if (prior && (prior.identity.requestId !== receipt.identity.requestId || prior.identity.conversationId !== receipt.identity.conversationId || prior.identity.workerGeneration !== receipt.identity.workerGeneration)) throw new Error('重复执行标识对应不同提交，请核查阶段回执。');
        }
      } catch (error) {
        try { this.update(id, draft => { if (draft.usage) draft.usage.complete = false; }); }
        catch (failure) { token.persistenceFailed = true; throw failure; }
        throw error;
      }
      if (token.cancelled) {
        // 取消阻止阶段推进，但已消耗的请求和副作用仍属于本次尝试。
        if (receipt || run.providerId === 'native') try { this.update(id, draft => { this.recordReceipt(draft, draft.stages.find(item => item.id === stage.id)!, receipt); }); }
        catch (error) { token.persistenceFailed = true; throw error; }
        return;
      }
      if (result.success && qualityValidation) {
        const failure = workflowQualityFailure(receipt, run.collaboration!, qualityValidation);
        if (failure) result = { ...result, success: false, error: failure };
      }
      if (result.success && !['manual', 'native_task'].includes(stage.gate ?? 'none') && run.stages.every(item => item.id === stage.id || item.status === 'completed')) {
        const failure = await this.finalQualityFailure(run, qualityValidation ? receipt : undefined);
        if (token.cancelled) {
          this.update(id, draft => this.recordReceipt(draft, draft.stages.find(item => item.id === stage.id)!, receipt));
          return;
        }
        if (failure) result = { ...result, success: false, error: failure };
      }
      this.update(id, draft => {
        const current = draft.stages.find(item => item.id === stage.id)!;
        const now = new Date().toISOString();
        current.finishedAt = now;
        this.recordReceipt(draft, current, receipt);
        if (result.summary) current.artifacts.push({
          id: randomUUID(), kind: 'summary', title: `${current.title} · 第 ${current.attempts} 次`,
          content: result.summary.slice(0, 100_000), createdAt: now,
        });
        if (!result.success) {
          current.status = 'failed'; current.error = (result.error || '阶段执行失败，请检查对话和工具结果').slice(0, 4000);
          draft.status = 'failed'; draft.error = current.error;
        } else {
          if (current.gate === 'manual') { current.status = 'waiting_confirmation'; draft.status = 'waiting_confirmation'; }
          else if (current.gate === 'native_task') { current.status = 'waiting_verification'; draft.status = 'waiting_verification'; }
          else { current.status = 'completed';
            if (draft.stages.every(item => item.status === 'completed')) draft.status = 'completed';
            else if (draft.pauseAfterEachStage) draft.status = 'paused';
          }
        }
      });
      if (this.get(id).status !== 'running') return;
    }
  }

  private prompt(run: WorkflowRun, stage: WorkflowStage): string {
    const dependencies = stage.dependsOn.map(id => {
      const previous = run.stages.find(item => item.id === id)!;
      const receipt = previous.nativeReceipts?.at(-1);
      return `### ${previous.title}\n${previous.artifacts.at(-1)?.content.slice(0, 8000) || '此阶段已完成，请参照本会话历史。'}`
        + (receipt ? '\n宿主记录的阶段成果（历史证据，需核对当前文件；不是自动验收结论）：\n' + JSON.stringify(receipt) : '');
    }).join('\n\n');
    return [
      `你正在执行工作流「${run.title}」的「${stage.title}」阶段。`,
      `用户目标：\n${run.goal}`, `本阶段要求：\n${stage.instruction}`,
      dependencies ? `已完成的前置阶段：\n${dependencies}` : '',
      stage.attempts > 0 ? '这是用户手动发起的再次执行。先核查已有改动与工具结果，避免重复具有副作用的操作。' : '',
      run.collaboration ? `本工作流协作策略：${run.collaboration}。${run.collaboration === 'single_agent' ? '由当前 Agent 完成本阶段，不创建子 Agent。' : '按可独立开展的问题、代码范围和验证风险选择并解释子任务数量；并发上限仅代表容量，不固定使用 4 个，也不要求填满上限。仅通过宿主委派工具创建子任务；独立质量审查及修复后重验由宿主强制编排，不能用最终文字声明代替。'}` : '',
      stage.toolPolicy === 'read_only' ? '本阶段为严格只读：只允许读取材料和静态审查，不执行命令、不写入文件；继承的阶段成果仍需核对当前版本。' : '',
      '保持当前会话的项目与工作目录，遵守现有权限和审批；不要自行跳过审批或绕过宿主启动独立进程、会话或外部 Agent。完成后明确报告实际产物、验证结果及仍需人工处理的事项。',
    ].filter(Boolean).join('\n\n');
  }

  private update(id: string, mutate: (run: WorkflowRun) => void): void {
    this.commit(state => {
      const run = state.runs.find(item => item.id === id);
      if (!run) throw new Error('工作流不存在');
      mutate(run); run.updatedAt = new Date().toISOString();
    });
  }

  private commit(mutate: (state: WorkflowState) => void): void {
    const next = structuredClone(this.state);
    mutate(next);
    this.storage.save(next);
    this.state = next;
    // 渲染失败不能触发已完成阶段副作用的重试。
    try { this.options.onChange?.(this.list()); } catch { /* 状态仍已持久化。 */ }
  }
}
