import { randomUUID } from 'node:crypto';
import type { NativeTaskEvidence, NativeTaskMutation, NativeTaskSnapshot } from '@cc-desk/contracts/native-task';
import type { NativeTaskStore } from '@cc-desk/agent-node/task-store';
import type { NativeRunStore } from '@cc-desk/agent-node/run-store';
import type { PreparedTool, RunIdentity, RunJournalEvent, ToolPort, ToolResult } from '@cc-desk/agent-core';
import { NATIVE_TASK_LIMITS, NativeTaskError } from '@cc-desk/agent-core';
import type { NativeTaskReviewInput } from '../../../shared/native-task';
import { captureTaskWorkspace, commandEvidenceReceipt, describeTaskChanges, terminalCommandEvidenceReceipt, type TaskCommandWorkspace, type TaskWorkspace } from './task-evidence';
import { sameRun } from './worker-protocol';

/** 元数据写入失败时可能已持久化；核心必须停止，不能重试。 */
export class TaskLocationCommitError extends Error {}
export class TaskLocationCapacityError extends Error {}
function rethrowKnownCapacity(error: unknown): void {
  // NativeTaskStore 在打开临时文件前抛出此类型化错误。
  // 通用 I/O 错误及发布后错误仍具有不确定结果。
  if (error instanceof NativeTaskError && error.code === 'limit_exceeded') throw new TaskLocationCapacityError('任务记录容量已满。');
}
const sameWorkspaceObservation = (left: TaskWorkspace | undefined, right: TaskWorkspace) => Boolean(left &&
  left.rootFingerprint === right.rootFingerprint && left.fingerprint === right.fingerprint && left.complete === right.complete &&
  JSON.stringify(left.issues) === JSON.stringify(right.issues));
const commandWorkspace = ({ fingerprint, rootFingerprint, complete }: TaskWorkspace): TaskCommandWorkspace => ({ fingerprint, rootFingerprint, complete });
const COMMAND_OBSERVATIONS = 32;
const MANAGED_COMMAND_TOOLS = new Set(['start_command', 'command_status', 'read_command_output', 'stop_command']);
interface CommandObservation {
  taskId: string; identity: RunIdentity; prepared: PreparedTool; before: TaskCommandWorkspace;
  planRevision?: number; acceptanceRevision?: number; stepIds: string[]; overlap: boolean;
  terminal?: NativeTaskEvidence;
}

/** 仅宿主管理的任务元数据；运行回执及队列 ACK 仍是执行的权威依据。 */
export class NativeTaskSession {
  constructor(readonly store: NativeTaskStore, private options: {
    projectRoot: string; excludedRoots: string[];
    changed(snapshot: NativeTaskSnapshot): void;
    assertSafe(value: unknown): void;
  }) {}
  private baseline?: TaskWorkspace;
  private receipts = new Map<string, { prepared: PreparedTool; before: TaskWorkspace; after: TaskWorkspace; result?: ToolResult }>();
  private commands = new Map<string, CommandObservation>();
  private commandKey(identity: RunIdentity, callId: string): string { return `${identity.runId}:${callId}`; }
  private markCommandOverlap(): boolean {
    let overlap = false;
    for (const command of this.commands.values()) {
      if (command.terminal) continue;
      command.overlap = true; overlap = true;
    }
    return overlap;
  }
  private serial: Promise<unknown> = Promise.resolve();
  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const work = this.serial.catch(() => {}).then(action); this.serial = work; return work;
  }
  async settled(): Promise<void> { await this.serial; }
  private async mutate(task: NativeTaskSnapshot, mutation: NativeTaskMutation, mutationId: string = randomUUID(), assertWriteAllowed?: () => void | Promise<void>) {
    this.options.assertSafe(mutation);
    const next = await this.store.apply({ taskId: task.taskId, identity: task.identity, expectedRevision: task.revision, mutationId, mutation }, { assertWriteAllowed });
    this.options.changed(next); return next;
  }
  private capture(signal?: AbortSignal) {
    return captureTaskWorkspace({ projectRoot: this.options.projectRoot, excludedRoots: this.options.excludedRoots, signal });
  }
  private async workspace(taskId: string, capture?: TaskWorkspace) {
    const task = this.store.read(taskId); if (!task) return;
    const current = capture ?? await this.capture(), baseline = task.workspace?.baseline ?? this.baseline ?? current;
    this.baseline ??= baseline;
    if (task.workspace && task.workspace.current.fingerprint === current.fingerprint && task.workspace.current.complete === current.complete &&
        JSON.stringify(task.workspace.current.issues) === JSON.stringify(current.issues)) return task;
    return this.mutate(task, { type: 'workspace', ...(!task.workspace ? { baseline } : {}), current, changes: describeTaskChanges(baseline, current) });
  }
  /** 计划提交后调用，包括压缩后；任务保存在模型上下文之外。 */
  planCommitted(task: NativeTaskSnapshot): Promise<void> {
    return this.enqueue(async () => {
      this.options.changed(task); await this.workspace(task.taskId);
      for (const [callId, receipt] of this.receipts) {
        if (!receipt.result) continue;
        const current = this.store.read(task.taskId)!;
        const evidence = commandEvidenceReceipt(receipt.prepared, receipt.result, { task: current, before: receipt.before, after: receipt.after });
        if (evidence) await this.mutate(current, { type: 'evidence', evidence }, `receipt:${current.identity.runId}:${callId}`);
        this.receipts.delete(callId);
      }
      for (const [key, command] of this.commands) {
        if (!command.terminal || command.taskId !== task.taskId || !sameRun(command.identity, task.identity)) continue;
        // 执行回执已在其他位置持久化。绝不通过重放或重新附加命令
        // 来重试结果不确定的元数据发布。
        this.commands.delete(key);
        await this.publishCommand(this.store.read(task.taskId)!, command);
      }
    });
  }
  /** 审批之后、持久化准备及 spawn 之前调用；此时失败仍可安全地判定为未启动。 */
  commandStarted(options: { taskId: string; identity: RunIdentity; prepared: PreparedTool; signal: AbortSignal }): Promise<void> {
    return this.enqueue(async () => {
      const { taskId, identity, prepared, signal } = options;
      const task = this.store.read(taskId);
      if (task && (!sameRun(task.identity, identity) || task.execution !== 'active')) throw new Error('命令观察所属任务运行已改变。');
      if (prepared.call.name !== 'start_command' || prepared.definition.risk !== 'command') throw new Error('只允许观察真实长命令启动。');
      const key = this.commandKey(identity, prepared.call.id);
      if (this.commands.has(key)) throw new Error('命令观察已存在。');
      if (this.commands.size >= COMMAND_OBSERVATIONS) throw new Error('待关联命令观察已达上限，请先建立任务计划。');
      this.options.assertSafe(prepared);
      const before = await this.capture(signal);
      const current = this.store.read(taskId);
      if (current && (!sameRun(current.identity, identity) || current.execution !== 'active')) throw new Error('命令观察所属任务运行已改变。');
      this.baseline ??= before;
      const overlap = this.markCommandOverlap();
      this.commands.set(key, { taskId, identity: { ...identity }, prepared: structuredClone(prepared), before: commandWorkspace(before),
        planRevision: task?.planRevision, acceptanceRevision: task?.acceptanceRevision,
        stepIds: task?.steps.filter(step => step.status === 'in_progress').map(step => step.id) ?? [], overlap });
    });
  }
  /** 宿主账本持久化提交真实终态及清理回执后调用一次。 */
  commandTerminated(options: { taskId: string; identity: RunIdentity; callId: string; result: ToolResult }): Promise<void> {
    return this.enqueue(async () => {
      const key = this.commandKey(options.identity, options.callId), command = this.commands.get(key);
      if (!command || command.terminal || command.taskId !== options.taskId || !sameRun(command.identity, options.identity)) return;
      const task = this.store.read(options.taskId);
      if (task && !sameRun(task.identity, options.identity)) { this.commands.delete(key); return; }
      // 清理结果不确定后仍在运行的命令，不能验证执行后快照，
      // 即使当前观察到的字节相匹配。
      const output = options.result.output;
      const released = output !== null && typeof output === 'object' && !Array.isArray(output) && output.cleanup === 'released';
      let after: TaskWorkspace;
      try { after = await this.capture(); }
      catch { after = { ...command.before, complete: false, files: [], scope: [], issues: ['命令终止后的工作区无法完整核查。'], capturedAt: new Date().toISOString() }; }
      if (command.overlap || !released) command.before = { ...command.before, complete: false };
      // 等待计划时只保留 8 KiB 摘要及哈希；完整的
      // 有界日志仍保存在权威命令账本中。
      try {
        this.options.assertSafe(options.result);
        command.terminal = terminalCommandEvidenceReceipt(command.prepared, options.result, {
          task: task ?? { taskId: options.taskId, identity: options.identity, planRevision: 1, acceptanceRevision: 1 },
          before: command.before, after: commandWorkspace(after),
        });
      } catch (error) { this.commands.delete(key); throw error; }
      if (!task) return;
      this.commands.delete(key);
      const current = await this.workspace(task.taskId, after);
      if (current && sameRun(current.identity, options.identity)) await this.publishCommand(current, command);
    });
  }
  private async publishCommand(task: NativeTaskSnapshot, command: CommandObservation): Promise<void> {
    if (!command.terminal || !sameRun(task.identity, command.identity)) return;
    const samePlan = command.planRevision === task.planRevision && command.acceptanceRevision === task.acceptanceRevision;
    const evidence = { ...command.terminal, planRevision: task.planRevision, acceptanceRevision: task.acceptanceRevision,
      stepIds: samePlan ? command.stepIds : [] };
    if (!samePlan) evidence.reason += ' 启动时尚无计划或计划已改变；未自动关联到当前步骤或验收条件。';
    if (command.overlap) evidence.reason += ' 命令期间存在其他命令或文件操作，不能独立确认检查范围。';
    await this.mutate(task, { type: 'evidence', evidence }, `receipt:${command.identity.runId}:${command.prepared.call.id}`);
  }
  /** 直接在任务存储中记录宿主文件观察，不依赖运行日志是否完成。 */
  recordCodeLocation(options: {
    taskId: string; identity: RunIdentity; expectedRevision: number; mutationId: string; signal: AbortSignal;
    assertCurrent(): Promise<void>;
    createEvidence(task: NativeTaskSnapshot): Promise<NativeTaskEvidence>;
    assertEvidenceCurrent(evidence: NativeTaskEvidence): Promise<void>;
  }): Promise<{ status: 'recorded'; task: NativeTaskSnapshot; evidence: NativeTaskEvidence } | { status: 'revision_changed'; revision: number }> {
    return this.enqueue(async () => {
      await options.assertCurrent();
      const task = this.store.read(options.taskId);
      if (!task || !sameRun(task.identity, options.identity) || task.execution !== 'active') throw new Error('任务运行归属已改变。');
      if (task.revision !== options.expectedRevision) return { status: 'revision_changed', revision: task.revision };
      if (task.history.length >= NATIVE_TASK_LIMITS.history || task.evidence.length >= NATIVE_TASK_LIMITS.evidence) throw new TaskLocationCapacityError('任务记录容量已满。');
      const publishWorkspace = async (current: TaskWorkspace) => {
        const baseline = task.workspace?.baseline ?? this.baseline ?? current;
        try {
          const next = await this.mutate(task, { type: 'workspace', ...(!task.workspace ? { baseline } : {}), current,
            changes: describeTaskChanges(baseline, current) }, undefined, options.assertCurrent);
          this.baseline ??= baseline;
          return { status: 'revision_changed' as const, revision: next.revision };
        } catch (error) { rethrowKnownCapacity(error); throw new TaskLocationCommitError('工作区观察保存结果未知。'); }
      };
      const current = await this.capture(options.signal);
      await options.assertCurrent();
      // 通过独立 CAS 修改刷新。绝不使用尚未读取的新修订，
      // 在同次调用中追加证据；模型必须先 read_task，再重试。
      if (!sameWorkspaceObservation(task.workspace?.current, current)) return publishWorkspace(current);
      const evidence = await options.createEvidence(task);
      this.options.assertSafe(evidence);
      let changedWorkspace: TaskWorkspace | undefined;
      const guardedWrite = async () => {
        await options.assertCurrent();
        const fresh = await this.capture(options.signal);
        await options.assertCurrent();
        if (!sameWorkspaceObservation(task.workspace?.current, fresh)) {
          changedWorkspace = fresh; throw new Error('记录保存前工作区已改变。');
        }
        // 在范围、所有权及扫描的 await 之后，最后才实际重新读取文件。
        await options.assertEvidenceCurrent(evidence);
      };
      try {
        const next = await this.mutate(task, { type: 'evidence', evidence }, options.mutationId, guardedWrite);
        return { status: 'recorded', task: next, evidence };
      } catch (error) {
        rethrowKnownCapacity(error);
        if (changedWorkspace) return publishWorkspace(changedWorkspace);
        throw new TaskLocationCommitError('位置记录保存结果未知。');
      }
    });
  }
  async continueTask(taskId: string, identity: RunIdentity, assertWriteAllowed: () => Promise<void>) {
    return this.enqueue(async () => {
      const task = this.store.read(taskId);
      if (!task || task.execution === 'active') throw new Error('待继续的任务不存在或尚未结束，请刷新任务状态。');
      const next = await this.store.apply({ taskId, identity, expectedRevision: task.revision, mutationId: `continue:${identity.runId}`,
        mutation: { type: 'continue', previousRunId: task.identity.runId } }, { assertWriteAllowed });
      this.options.changed(next); await this.workspace(taskId);
    });
  }
  wrapTools(tools: ToolPort, taskId: string, identity: RunIdentity): ToolPort {
    return {
      definitions: tools.definitions,
      prepare: (call, context) => tools.prepare(call, context),
      validate: (prepared, context) => tools.validate(prepared, context),
      execute: async (prepared, context, approval) => {
        const task = this.store.read(taskId);
        const observed = (!task || sameRun(task.identity, identity)) && (prepared.definition.risk !== 'read') && !MANAGED_COMMAND_TOOLS.has(prepared.call.name);
        if (observed) this.markCommandOverlap();
        const before = observed ? await this.capture(context.signal) : undefined;
        if (before) this.baseline ??= before;
        const result = await tools.execute(prepared, context, approval);
        if (before) {
          // 操作效果已经发生；观察失败不得替换真实回执。
          let after: TaskWorkspace;
          try { after = await this.capture(); }
          catch { after = { ...before, complete: false, issues: ['工具执行后的工作区无法完整核查。'], capturedAt: new Date().toISOString() }; }
          this.receipts.set(prepared.call.id, { prepared, before, after });
        }
        return result;
      },
    };
  }
  /** 只有 NativeRunStore 已持久化接受精确的工具完成结果后才调用。 */
  committed(taskId: string, identity: RunIdentity, event: RunJournalEvent): Promise<void> {
    return this.enqueue(async () => {
      if (event.type === 'tool_completed') {
        const observed = this.receipts.get(event.call.id);
        if (observed) observed.result = event.result;
      }
      const task = this.store.read(taskId);
      if (!task || !sameRun(task.identity, identity)) return;
      if (event.type === 'tool_completed') {
        const observed = this.receipts.get(event.call.id); this.receipts.delete(event.call.id);
        if (!observed) return;
        const current = (await this.workspace(taskId, observed.after))!;
        const evidence = commandEvidenceReceipt(observed.prepared, event.result, { task: current, before: observed.before, after: observed.after,
          stepIds: current.steps.filter(step => step.status === 'in_progress').map(step => step.id) });
        if (evidence) await this.mutate(current, { type: 'evidence', evidence }, `receipt:${identity.runId}:${event.call.id}`);
      } else if (event.type === 'run_finished' && task.execution === 'active') {
        await this.workspace(taskId);
        await this.mutate(this.store.read(taskId)!, { type: 'finish', outcome: event.result.status }, `finish:${identity.runId}`);
      }
    });
  }
  /** 空闲刷新重新检查外部修改，只修复元数据，绝不重新执行。 */
  inspect(taskId: string): Promise<NativeTaskSnapshot | undefined> {
    return this.enqueue(async () => { await this.workspace(taskId); return this.store.read(taskId) ?? undefined; });
  }
  refresh(ledger: NativeRunStore, activeIdentity?: RunIdentity): Promise<void> {
    return this.enqueue(async () => {
      for (const task of this.store.list()) {
        if (task.execution !== 'active' || activeIdentity && sameRun(task.identity, activeIdentity)) continue;
        const run = ledger.getRun(task.identity.runId);
        await this.mutate(task, run?.result && run.result.committed
          ? { type: 'finish', outcome: run.result.status }
          : { type: 'interrupt', reason: '运行已中断；保留计划与证据，未自动重放任何工具。' });
      }
      const latest = this.store.latest();
      if (latest && !activeIdentity) await this.workspace(latest.taskId);
      const current = this.store.latest(); if (current) this.options.changed(current);
    });
  }
  review(input: NativeTaskReviewInput, assertCurrent: () => void): Promise<NativeTaskSnapshot> {
    return this.enqueue(async () => {
      assertCurrent();
      const before = this.store.read(input.taskId);
      if (!before || before.revision !== input.expectedRevision || before.execution === 'active') throw new Error('任务记录已改变或仍在执行，请刷新后复核。');
      const task = (await this.workspace(before.taskId))!;
      assertCurrent();
      if (task.revision !== input.expectedRevision || !task.workspace?.current.complete || task.workspace.current.fingerprint !== input.expectedWorkspaceFingerprint) throw new Error('工作区已改变或核查范围不完整，请刷新后复核。');
      const reason = input.reason.trim();
      if (!reason || reason.length > 2000) throw new Error('请填写 1–2000 字的复核说明。');
      this.options.assertSafe(reason);
      let changedWorkspace: TaskWorkspace | undefined;
      const guardedWrite = async () => {
        assertCurrent();
        const current = await this.capture();
        assertCurrent();
        if (!current.complete || current.fingerprint !== input.expectedWorkspaceFingerprint) {
          changedWorkspace = current;
          throw new Error('复核保存前工作区已改变，请刷新后重新检查。');
        }
      };
      const record = async (mutation: NativeTaskMutation) => {
        try { return await this.mutate(task, mutation, randomUUID(), guardedWrite); }
        catch (error) {
          if (changedWorkspace) await this.workspace(task.taskId, changedWorkspace);
          throw error;
        }
      };
      if (input.decision === 'approve' || input.decision === 'reject') {
        if (input.criterionId) throw new Error('整体验收不接受单项条件。');
        return record({ type: 'review', status: input.decision === 'approve' ? 'approved' : 'rejected', reason });
      }
      const criterion = task.criteria.find(item => item.id === input.criterionId);
      if (!criterion) throw new Error('验收条件已改变，请刷新。');
      return record({ type: 'evidence', evidence: {
        id: randomUUID(), identity: task.identity, source: 'manual', status: input.decision, reason,
        stepIds: criterion.stepIds, criterionIds: [criterion.id], planRevision: task.planRevision, acceptanceRevision: task.acceptanceRevision,
        workspaceFingerprint: task.workspace.current.fingerprint, workspaceComplete: true, createdAt: new Date().toISOString(),
      } });
    });
  }
}
