import fs from 'node:fs/promises';
import { nativeAutoApproves, nativePermissionInstructions } from '../../../shared/native-permissions';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { canonicalJson, contextBudgetUsage, DEFAULT_RUN_BUDGET, type ApprovalDecision, type ApprovalRequest, type UserImage, type RunIdentity, type RunResult, type RunStore, type ToolPort } from '@cc-desk/agent-core';
import { NativeRunStore, nativeSubmissionInputDigest } from '@cc-desk/agent-node/run-store';
import { NativeTaskStore } from '@cc-desk/agent-node/task-store';
import { isNativeChangeSetPreview } from '@cc-desk/contracts/native-changes';
import type { NativeExecutionReceipt, NativeTaskSnapshot } from '@cc-desk/contracts/native-task';
import { toNativeTaskView, type NativeTaskReviewInput } from '../../../shared/native-task';
import { NativeTaskSession } from './task-session';
import { createNativeTaskTool } from './task-tool';
import { createCodeLocationTool } from './code-location-tool';
import { createLocalToolPort } from '@cc-desk/agent-node/tools';
import { ProcessSupervisor } from '@cc-desk/agent-node/process-supervisor';
import { loadProjectInstructions, projectInstructionText } from '@cc-desk/agent-node/project-instructions';
import { composeToolPorts, createMcpToolPort, type ManagedMcpToolPort } from '@cc-desk/agent-node/mcp-tools';
import { createNativeModel, extractNativeAssistantText } from '@cc-desk/agent-node/native-model';
import { contextSummaryItem } from '@cc-desk/agent-node/context-maintenance';
import { assertNoModelCredential } from '@cc-desk/agent-node/responses-model';
import type { ExecutionSubmission, NativeExecutionPolicy } from '@cc-desk/contracts/execution-ports';
import { isNativeImageAttachments, type NativeImageAttachment } from '@cc-desk/contracts/chat';
import { readNativeImageAttachments } from '../../native-image-attachments';
import type { ChatDecision, ChatPageOptions, ChatSnapshot, ChatTurnResult, TaskState } from '../../../shared/chat';
import type { EngineConfig } from '../../../shared/types';
import { resolveNativeRuntimeConfig } from '../../../shared/native-runtime-policy';
import type { StructuredExecutor } from '../../execution/ports';
import { ExecutionStatePublisher, type ExecutionEvents } from '../../execution/events';
import type { StateStore } from '../../store';
import type { ConnectionStore } from './connections';
import type { NativeMcpConnectionStore } from './mcp-connections';
import { createNativeConfig, createNativeDefaultConfig, parseNativeConfig } from './config';
import { NativeProjection, MISSING_NATIVE_CONTEXT_MESSAGE } from './projection';
import { runNativeWorker } from './worker-host';
import { sameRun } from './worker-protocol';
import { nativeRunError, type NativeRunErrorDetails } from './run-errors';
import { summarizeNativeContext } from './context-summary';
import { assertNativeInputBudget, autoCompactBeforeSend } from './automatic-compaction';
import { mcpConnectionMetadata, mcpStartupMetadata } from './mcp-startup';
import { createQuestionTool, type NativeQuestionTool } from './question-tool';
import { createCommandTools, type NativeCommandTools } from './command-tools';
import { createInRunCompaction } from './in-run-compaction';
import { buildNativeContextContinuity } from './context-continuity';
import { nativeCompactionPreview, unavailableCompactionPreview } from './compaction-preview';
import { estimateNativeCost } from '../../../shared/native-cost';
import type { NativeModelCapabilityService } from './model-capabilities';
import { nativeModelBudget, nativeModelCapabilityUsage } from './model-budget';
import { nativeExecutionReceipt, readNativeExecutionReceipt, saveNativeExecutionReceipt } from './execution-receipt';
import { parseNativeExecutionPolicy, restrictNativeTools } from './execution-policy';
import { NativeAggregateBudget } from './aggregate-budget';
import { createNativeChildBudget } from './child-budget';
import { createAgentDelegationTools, type NativeAgentChildInput, type NativeAgentChildResult, type NativeAgentDelegationTools } from './agent-delegation';
import { runNativeAgentChild } from './agent-child-runner';
import { NativeActivePause } from './active-pause';
import { loadNativeAgents } from './agent-projection';
import { readNativeAgentResult } from './agent-results';
import { createAgentResultTools } from './agent-result-tool';
import type { NativeAgentResultRequest, NativeAgentResult } from '../../../shared/chat';
import { buildNativeParentInstructions, NATIVE_DELEGATION_PROMPT_VERSION, nativeParallelReviewIntent, nativeWorkflowCollaborationIntent, nativePromptInstructionSections } from './agent-prompts';
import { createNativeWorkflowQualityController, loadNativeWorkflowQuality, type NativeWorkflowQualityController } from './workflow-quality';
import { nativeDelegationAuditFailure, saveNativeDelegationAudit } from './agent-delegation-audit';
import { reportNativeDiagnostic } from './diagnostic';
import { normalizeNativeSkillSubmission, type NativeSkillSubmission } from '@cc-desk/contracts/native-skills';
import { conversationSkillContinuityItems } from '@cc-desk/agent-node/skill-continuity';
import type { NativeSkillRuntime } from './skill-runtime';

const RECOVERY = '上次执行的副作用或保存状态尚未确认。已保留原始记录，请核查工作目录、进程及远端 MCP 操作；此会话只读，请新建会话继续。';
const RECOVERY_ACK = '已核查执行现场并解除目录隔离。此会话只读，原始记录继续保留；请新建会话继续，不会重放未知工具。';
const SAFE_RECOVERY = '上次回合已中断，恢复前此会话只读。已保存的结果可继续使用；确认旧进程已停止后可恢复会话，未执行的工具不会自动重放。';
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const json = (value: unknown) => JSON.parse(JSON.stringify(value));
type NativeRuntimeConfig = ReturnType<typeof parseNativeConfig>;
interface ActiveRun {
  requestId: string; input: string; options: string; sourceOptions: string; runtimeConfig: NativeRuntimeConfig;
  expectedImageAttachments?: NativeImageAttachment[];
  attachmentPaths: string[]; images: UserImage[]; imageAttachments: NativeImageAttachment[];
  imageSnapshot?: ReturnType<typeof readNativeImageAttachments>;
  connectionId: string; mcpConnections: string[];
  abort: AbortController; promise: Promise<ChatTurnResult>; identity?: RunIdentity;
  store?: NativeRunStore; cleanupUnconfirmed: boolean; released: boolean;
  phase?: 'compacting' | 'compacting_in_turn';
  executionPolicy?: NativeExecutionPolicy;
  nativeSkills?: NativeSkillSubmission;
  delegation?: NativeAgentDelegationTools;
  children?: Map<string, NativeAgentChildInput>;
  childApprovalQueue?: Promise<void>;
  childLeases?: Map<string, { assert(): void | Promise<void>; release(): void | Promise<void> }>;
  questions?: NativeQuestionTool;
  taskId: string; continuedTaskId?: string; tasks?: NativeTaskSession;
  taskCleanupOnly?: boolean;
  approval?: { publicId: string; kind: 'permission' | 'question'; request: ApprovalRequest; createdAt: string; settle(decision: ApprovalDecision['decision']): void };
}
interface ContextOperation {
  kind: 'resume' | 'compact' | 'confirm'; expectedHead: string; connectionId: string;
  runtimeConfig: NativeRuntimeConfig;
  abort: AbortController; promise: Promise<void>; store?: NativeRunStore;
  identity?: RunIdentity; cleanupUnconfirmed: boolean; released: boolean;
}
export interface NativeExecutorOptions {
  /** Internal M2 gate. Ordinary executor construction leaves this absent. */
  skills?: NativeSkillRuntime;
  mcpConnections?: NativeMcpConnectionStore;
  modelCapabilities?: NativeModelCapabilityService;
  worker?: typeof runNativeWorker;
  supervisor?: ProcessSupervisor;
  /** 如可用，由宿主的目录协调器提供。 */
  assertOwnership?(id: string, identity: RunIdentity): void | Promise<void>;
  acquireChildOwnership?(parentId: string, identity: RunIdentity, cwd: string): Promise<{ assert(): void | Promise<void>; release(): void | Promise<void> }>;
  onError?(error: Error): void;
}
/** 主进程管理持久化账本、权限、文件及命令子进程。 */
export class NativeStructuredExecutor implements StructuredExecutor {
  private active = new Map<string, ActiveRun>();
  private contextOperations = new Map<string, ContextOperation>();
  private recoveryViews = new Map<string, NonNullable<ChatSnapshot['nativeRecovery']>>();
  private contextViews = new Map<string, NonNullable<ChatSnapshot['nativeContextMaintenance']>>();
  private autoCompactionBlocked = new Set<string>();
  private skillContinuityBlocked = new Set<string>();
  private recovery = new Set<string>();
  private acknowledged = new Set<string>();
  private maintenance = false;
  private sessionMaintenance = new Set<string>();
  private projection: NativeProjection;
  private publisher: ExecutionStatePublisher;
  private supervisor: ProcessSupervisor;
  private hydration = new Map<string, Promise<void>>();
  private hydrationClosed = false;
  private taskViews = new Map<string, NativeTaskSnapshot>();
  private taskErrors = new Map<string, string>();
  private taskReviews = new Map<string, { abort: AbortController; promise: Promise<NativeTaskSnapshot> }>();
  private taskLedgers = new Map<NativeTaskStore, string>();
  private taskLeaseFailures = new Set<string>();
  private hydrationLedgers = new Set<NativeRunStore>();
  private childRecoveryRoots = new Map<string, string[]>();
  private agentResultParents = new Map<string, Map<string, RunIdentity>>();
  constructor(private store: StateStore, private connections: ConnectionStore, events: ExecutionEvents, private options: NativeExecutorOptions = {}) {
    this.supervisor = options.supervisor ?? new ProcessSupervisor({ maxTimeoutMs: 3600000 });
    this.publisher = new ExecutionStatePublisher(events);
    this.projection = new NativeProjection(store.directory, events, id => this.session(id), id => this.has(id), (_id, error) => options.onError?.(error), id => this.active.get(id)?.phase === 'compacting');
  }
  private session(id: string) {
    const session = this.store.state.sessions.find(item => item.id === id);
    if (!session || session.kind !== 'agent' || session.execution.providerId !== 'native' || session.execution.mode !== 'structured' || !session.execution.conversationId) throw new Error('此执行器只支持自研 agent 图形会话。');
    return session;
  }
  private runtimeConfig(config: EngineConfig): NativeRuntimeConfig {
    if (config.options.runtimePolicy !== 'defaults') return parseNativeConfig(config);
    const savedDefaults = this.store.state.settings.engineDefaults.native;
    const freshDefaults = createNativeDefaultConfig();
    const defaults = savedDefaults ? createNativeConfig({ ...savedDefaults, options: { ...freshDefaults.options, ...savedDefaults.options } }) : freshDefaults;
    return parseNativeConfig(resolveNativeRuntimeConfig(config, defaults));
  }
  private changed(id: string, taskState: TaskState, error?: string) {
    this.projection.state(id, taskState, error, this.active.get(id)?.requestId);
    this.store.change(state => {
      const session = state.sessions.find(item => item.id === id)!;
      session.taskState = taskState;
      session.status = this.has(id) ? ((this.active.get(id) ?? this.contextOperations.get(id))?.abort.signal.aborted ? 'stopping' : 'running') : error ? 'error' : 'stopped';
      session.error = error; session.updatedAt = new Date().toISOString();
    });
    this.publisher.publish(this.store.state.sessions.filter(item => item.execution.providerId === 'native'));
  }
  get activeCount() { return new Set([...this.active.keys(), ...this.contextOperations.keys(), ...this.taskReviews.keys(), ...this.taskLeaseFailures]).size; }
  has(id: string) { return this.active.has(id) || this.contextOperations.has(id) || this.taskReviews.has(id) || this.taskLeaseFailures.has(id); }
  isBusy(id: string) { return this.has(id); }
  private recoveryMessage(id: string) { return this.acknowledged.has(id) ? RECOVERY_ACK : this.projection.hasMissingContext(id) ? MISSING_NATIVE_CONTEXT_MESSAGE : this.recoveryViews.get(id)?.status === 'recoverable' ? SAFE_RECOVERY : RECOVERY; }
  recoveryRequired(id: string) { return this.taskLeaseFailures.has(id) || this.recovery.has(id) && !this.acknowledged.has(id); }
  async recoveryDirectories(id: string): Promise<readonly string[]> {
    await this.hydrate(id);
    return [...this.childRecoveryRoots.get(id) ?? []];
  }
  private async refreshChildRecovery(id: string, ledger: NativeRunStore): Promise<boolean> {
    const roots = new Set<string>(); let uncertain = this.projection.hasMissingContext(id);
    if (uncertain) roots.add(path.join(this.store.directory, 'native', 'agent-worktrees'));
    for (const run of ledger.listRuns()) {
      const children = await loadNativeAgents(this.store.directory, run.identity);
      const missingImplementation = !children.receipts().length && run.tools.some(tool => tool.call.name === 'delegate_implement' &&
        tool.prepared && !['denied', 'not_executed'].includes(tool.completed?.result.status ?? 'unknown'));
      if (children.snapshot(false).incomplete || missingImplementation) { uncertain = true; roots.add(path.join(this.store.directory, 'native', 'agent-worktrees')); }
      for (const receipt of children.receipts()) {
        if (!['prepared', 'running', 'unknown'].includes(receipt.status) && receipt.result?.committed !== false && receipt.result?.status !== 'recovery_required' && !(receipt.workspace && receipt.workspaceVerified !== true)) continue;
        uncertain = true;
        if (receipt.mode === 'implement' && receipt.workspace) roots.add(path.join(this.store.directory, 'native', 'agent-worktrees', receipt.childId));
      }
    }
    this.childRecoveryRoots.set(id, [...roots]);
    return uncertain;
  }
  isConnectionActive(id: string) { return [...this.active.values(), ...this.contextOperations.values()].some(run => run.connectionId === id); }
  isMcpConnectionActive(id: string) { return [...this.active.values()].some(run => run.mcpConnections.includes(id)); }
  taskState(id: string) { return this.snapshot(id).taskState; }
  async initialize() {
    for (const session of this.store.state.sessions.filter(item => item.execution.providerId === 'native')) {
      try { await this.hydrate(session.id); if (this.recovery.has(session.id)) this.changed(session.id, 'error', this.recoveryMessage(session.id)); }
      catch { this.recovery.add(session.id); this.changed(session.id, 'error', '自研 agent 记录无法读取，原文件已保留；请检查磁盘与数据版本。'); }
    }
  }
  hydrate(id: string): Promise<void> {
    // 退出开始后，渲染进程刷新请求仍可能到达。保留现有
    // 投影，但绝不在关闭屏障后打开另一个写入器。
    if (this.hydrationClosed) return Promise.resolve();
    // Active execution publishes committed changes itself. A presentation read
    // must not join disk/projection or task-workspace work; execute() still
    // awaits any existing hydration before acquiring its ledger and starting.
    const live = this.active.get(id);
    if (live && !live.cleanupUnconfirmed && !this.recovery.has(id) && !this.taskLeaseFailures.has(id)) return Promise.resolve();
    const pending = this.hydration.get(id); if (pending) return pending;
    const operation = (async () => {
      const active = this.active.get(id) ?? this.contextOperations.get(id);
      if (active && !active.store) return;
      const ownsLedger = !active?.store;
      const ledger = active?.store ?? await NativeRunStore.open({ rootDirectory: path.join(this.store.directory, 'native', 'conversations'), conversationId: this.session(id).execution.conversationId! });
      if (ownsLedger) this.hydrationLedgers.add(ledger);
      try {
        await this.refreshProjection(id, ledger);
        await this.refreshTaskView(id, ledger);
        const childRecovery = !active || active.cleanupUnconfirmed ? await this.refreshChildRecovery(id, ledger) : false;
        if (ledger.recoveryRequired || this.projection.hasMissingContext(id) || childRecovery) {
          this.recovery.add(id);
          const marker = this.recoveryMarker(id), latest = ledger.replay(Math.max(0, ledger.usage.records - 1), 1)[0];
          try {
            const stat = await fs.lstat(marker); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error();
            const confirmation = JSON.parse(await fs.readFile(marker, 'utf8'));
            if (confirmation.schemaVersion === 1 && confirmation.conversationId === ledger.conversationId && confirmation.hash === latest?.hash) this.acknowledged.add(id);
            else this.acknowledged.delete(id);
          } catch { this.acknowledged.delete(id); }
          this.projection.state(id, 'error', this.recoveryMessage(id));
        } else if (!active?.cleanupUnconfirmed) { this.recovery.delete(id); this.acknowledged.delete(id); }
      } finally {
        if (ownsLedger) { await ledger.close(); this.hydrationLedgers.delete(ledger); }
      }
    })();
    this.hydration.set(id, operation);
    void operation.finally(() => { if (this.hydration.get(id) === operation) this.hydration.delete(id); }).catch(() => {});
    return operation;
  }
  private async refreshProjection(id: string, ledger: NativeRunStore, bestEffortDisplay = false) {
    const runs = ledger.listRuns();
    if (!this.options.skills && runs.some(run => run.configuration.nativeSkillCatalog !== undefined || run.configuration.nativeSkills !== undefined)) this.skillContinuityBlocked.add(id);
    else this.skillContinuityBlocked.delete(id);
    this.agentResultParents.set(id, new Map(runs.filter(run => run.identity.sessionId === id &&
      run.identity.conversationId === this.session(id).execution.conversationId).map(run => [run.identity.runId, structuredClone(run.identity)])));
    const headHash = ledger.head?.hash ?? '';
    const report = ledger.getRecoveryReport();
    if (report) {
      const tools = { completed: 0, notExecuted: 0, unknown: 0 };
      for (const tool of report.tools) tools[tool.status === 'not_executed' ? 'notExecuted' : tool.status]++;
      this.recoveryViews.set(id, { status: report.classification === 'safe_to_continue' ? 'recoverable' : 'blocked', headHash, runId: report.runId, tools });
    } else this.recoveryViews.delete(id);
    let canCompact = false, preview: NonNullable<ChatSnapshot['nativeContextMaintenance']>['preview'];
    try {
      const source = ledger.getCompactionSource(); canCompact = true;
      preview = nativeCompactionPreview(source);
    } catch (error) { preview = ledger.recoveryRequired ? { status: 'unavailable', reason: 'recovery_required' } : unavailableCompactionPreview(error); }
    const last = ledger.getLastCompaction();
    if (ledger.getAutoCompactionForCurrentContext()?.status === 'attempted') this.autoCompactionBlocked.add(id);
    else this.autoCompactionBlocked.delete(id);
    const recentAttempt = runs.toReversed().map(run => ({ run, attempt: ledger.lookupRunCompaction(run.identity.runId) })).find(item => item.attempt);
    const attempt = recentAttempt?.attempt;
    const active = this.active.get(id);
    const summaryCostUSD = attempt?.usage ? estimateNativeCost(attempt.usage, recentAttempt?.run.configuration.pricing, recentAttempt?.run.configuration.model) : undefined;
    const inTurn = attempt ? { runId: attempt.runId, createdAt: attempt.createdAt,
      status: attempt.status === 'attempted' && (!active?.identity || !sameRun(active.identity, recentAttempt!.run.identity) || active.phase !== 'compacting_in_turn') ? 'unknown' as const : attempt.status,
      beforeBytes: attempt.beforeBytes, ...(attempt.afterBytes === undefined ? {} : { afterBytes: attempt.afterBytes }),
      ...(attempt.usage ? { summaryUsage: { ...(attempt.usage.inputTokens === undefined ? {} : { inputTokens: attempt.usage.inputTokens }), ...(attempt.usage.outputTokens === undefined ? {} : { outputTokens: attempt.usage.outputTokens }) } } : {}),
      ...(summaryCostUSD === undefined ? {} : { summaryCostUSD }) } : undefined;
    this.contextViews.set(id, { headHash, canCompact, preview, ...(last ? { lastCompaction: { beforeBytes: last.beforeBytes, afterBytes: last.afterBytes, createdAt: last.createdAt, trigger: last.automaticRequestId ? 'automatic' : 'manual' } } : {}), ...(inTurn ? { inTurn } : {}) });
    // 只有已确认提交后的显示发布和关闭前的显示修复允许退化。
    // 上方账本/恢复读取仍必须成功；默认路径保留严格的执行前屏障。
    if (bestEffortDisplay) {
      try { await this.projection.hydrate(id, ledger); }
      catch { /* 投影已标记不完整并报告原错误，下次 hydrate 从权威账本修复。 */ }
    } else await this.projection.hydrate(id, ledger);
  }
  private async openTaskSession(id: string, forbiddenValues: string[] = []) {
    const session = this.session(id);
    // 为当前会话取得另一个写入器前，先重试尚未完成的元数据清理。
    for (const [ledger, owner] of this.taskLedgers) if (owner === id) await this.closeTaskStore(ledger);
    const taskStore = await NativeTaskStore.open({ rootDirectory: path.join(this.store.directory, 'native'),
      sessionId: id, conversationId: session.execution.conversationId!, forbiddenValues });
    this.taskLedgers.set(taskStore, id);
    return new NativeTaskSession(taskStore, { projectRoot: session.cwd, excludedRoots: [this.store.directory],
      assertSafe: value => { for (const secret of forbiddenValues) assertNoModelCredential(value, secret); },
      changed: task => {
        const prior = this.taskViews.get(id), hadError = this.taskErrors.delete(id);
        this.taskViews.set(id, task);
        if (hadError || !prior || prior.taskId !== task.taskId || prior.revision !== task.revision) this.projection.notifyTask(id);
      } });
  }
  private async closeTaskStore(ledger: NativeTaskStore) {
    const owner = this.taskLedgers.get(ledger);
    try { await ledger.close(); this.taskLedgers.delete(ledger); }
    catch (error) { if (owner) this.taskLeaseFailures.add(owner); throw error; }
    if (owner && ![...this.taskLedgers.values()].includes(owner)) this.taskLeaseFailures.delete(owner);
  }
  async inspectTaskReceipt(receipt: NativeExecutionReceipt) {
    const id = receipt.identity.sessionId, session = this.session(id);
    if (!receipt.taskId || session.execution.conversationId !== receipt.identity.conversationId || this.isBusy(id) || this.taskReviews.has(id)) throw new Error('阶段任务身份已变化或会话仍在执行，请刷新后核查。');
    await this.hydrate(id);
    if (this.isBusy(id) || this.taskReviews.has(id) || this.recoveryRequired(id)) throw new Error('阶段任务当前无法安全核查。');
    const tasks = await this.openTaskSession(id);
    try {
      const task = await tasks.inspect(receipt.taskId);
      if (!task || !sameRun(task.identity, receipt.identity)) throw new Error('阶段成果不属于该任务执行记录。');
      return toNativeTaskView(task);
    } finally { await this.closeTaskStore(tasks.store); }
  }
  private async refreshTaskView(id: string, ledger: NativeRunStore) {
    // 运行独占其写入器；空闲刷新使用短暂写入器，由 hydrate() 串行化。
    const active = this.active.get(id);
    if (this.taskReviews.has(id) || active && (!active.tasks || this.taskErrors.has(id))) return;
    let tasks: NativeTaskSession | undefined;
    try {
      tasks = active?.tasks ?? await this.openTaskSession(id);
      await tasks.refresh(ledger, active?.identity);
      if (!tasks.store.latest()) this.taskViews.delete(id);
      this.taskErrors.delete(id);
    } catch {
      this.taskViews.delete(id);
      this.taskErrors.set(id, '任务记录或工作区无法核查；当前验收状态未知，请检查磁盘并重试。');
    } finally { if (tasks && tasks !== active?.tasks) await this.closeTaskStore(tasks.store); }
  }
  reviewTask(id: string, input: NativeTaskReviewInput): Promise<NativeTaskSnapshot> {
    const session = this.session(id);
    if (this.has(id) || this.maintenance || this.hydrationClosed || this.sessionMaintenance.has(id) || session.archived || this.recoveryRequired(id)) return Promise.reject(new Error('请先停止运行并核查恢复状态，再复核任务。'));
    const abort = new AbortController();
    let resolve!: (value: NativeTaskSnapshot) => void, reject!: (error: unknown) => void;
    const promise = new Promise<NativeTaskSnapshot>((yes, no) => { resolve = yes; reject = no; });
    const operation = { abort, promise }; this.taskReviews.set(id, operation);
    const original = JSON.stringify([session.cwd, session.execution]);
    const assertCurrent = () => {
      if (abort.signal.aborted || this.taskReviews.get(id) !== operation || this.maintenance || this.sessionMaintenance.has(id) ||
          this.session(id).archived || original !== JSON.stringify([this.session(id).cwd, this.session(id).execution])) throw new Error('任务复核已取消或会话已改变。');
    };
    void (async () => {
      let tasks: NativeTaskSession | undefined;
      try {
        await this.hydration.get(id); assertCurrent();
        const forbiddenValues: string[] = [];
        try { const config = parseNativeConfig(session.engineConfig); forbiddenValues.push(this.connections.resolve(config.connectionId, config.model || undefined).apiKey); } catch { /* 离线审查仍可使用。 */ }
        for (const connectionId of parseNativeConfig(session.engineConfig).mcpConnections) {
          try {
            const connection = this.options.mcpConnections?.resolve(connectionId);
            if (connection?.transport === 'stdio') forbiddenValues.push(...Object.values(connection.environment));
            else if (connection?.bearerToken) forbiddenValues.push(connection.bearerToken);
          } catch { /* MCP 服务断开不能阻止本地审查。 */ }
        }
        tasks = await this.openTaskSession(id, forbiddenValues); assertCurrent();
        return await tasks.review(input, assertCurrent);
      } finally {
        try { if (tasks) await this.closeTaskStore(tasks.store); }
        catch (error) { this.taskErrors.set(id, '任务复核记录尚未安全关闭，请重试或检查磁盘。'); throw error; }
        finally { if (this.taskReviews.get(id) === operation) this.taskReviews.delete(id); }
      }
    })().then(resolve, reject);
    return promise;
  }
  private agentResultSecrets(): string[] {
    return [...new Set([...this.connections.protectedValues(), ...this.options.mcpConnections?.protectedValues() ?? []])];
  }
  async readAgentResult(id: string, input: NativeAgentResultRequest): Promise<NativeAgentResult> {
    const conversationId = this.session(id).execution.conversationId;
    if (this.hydrationClosed || this.maintenance || this.sessionMaintenance.has(id)) throw new Error('会话正在关闭或维护，请稍后读取成果。');
    await this.hydrate(id);
    const assertCurrent = () => {
      if (this.hydrationClosed || this.maintenance || this.sessionMaintenance.has(id) || this.session(id).execution.conversationId !== conversationId)
        throw new Error('会话已改变，成果读取已取消。');
    };
    assertCurrent();
    const parent = this.agentResultParents.get(id)?.get(input.parentRunId);
    if (!parent || parent.sessionId !== id || parent.conversationId !== conversationId) throw new Error('成果不属于此会话的父回合。');
    const result = await readNativeAgentResult(this.store.directory, parent, input, { forbiddenValues: this.agentResultSecrets() });
    assertCurrent();
    return result;
  }
  snapshot(id: string): ChatSnapshot {
    this.session(id);
    const snapshot = this.projection.snapshot(id), operation = this.contextOperations.get(id), active = this.active.get(id);
    // 新请求已被接收但历史、凭据或能力元数据尚在读取时，旧完成回执只属于历史。
    if (active && !active.cleanupUnconfirmed && !this.recovery.has(id)
        && (!active.identity || !snapshot.nativeRun || !sameRun(active.identity, snapshot.nativeRun))) {
      snapshot.taskState = active.abort.signal.aborted ? 'interrupted' : 'starting';
      snapshot.error = undefined;
    }
    const view = this.contextViews.get(id), recovery = this.recoveryViews.get(id);
    const runtimeConfig = view ? active?.runtimeConfig ?? operation?.runtimeConfig ?? this.runtimeConfig(this.session(id).engineConfig) : undefined;
    if (this.recovery.has(id)) snapshot.nativeRecovery = { ...(recovery ?? { status: 'blocked', headHash: view?.headHash ?? '', tools: { completed: 0, notExecuted: 0, unknown: 0 } }), ...(this.acknowledged.has(id) ? { status: 'acknowledged' as const } : {}), reason: this.recoveryMessage(id) };
    const skillsContinuityBlocked = this.skillContinuityBlocked.has(id);
    const automaticMode = skillsContinuityBlocked ? 'off' as const : runtimeConfig?.autoCompact ?? 'off';
    if (view) snapshot.nativeContextMaintenance = { ...view, canCompact: view.canCompact && !this.has(id) && !this.recovery.has(id) && !skillsContinuityBlocked,
      preview: this.recovery.has(id) ? { status: 'unavailable', reason: 'recovery_required' }
        : skillsContinuityBlocked ? { status: 'unavailable', reason: 'unsupported_context' }
        : this.has(id) || this.maintenance || this.sessionMaintenance.has(id) ? { status: 'unavailable', reason: 'busy' } : view.preview ? { ...view.preview } : undefined,
      compacting: operation?.kind === 'compact' || active?.phase === 'compacting' || active?.phase === 'compacting_in_turn',
      ...(active?.phase === 'compacting' ? { compactionTrigger: 'automatic' as const } : active?.phase === 'compacting_in_turn' ? { compactionTrigger: 'in_turn' as const } : operation?.kind === 'compact' ? { compactionTrigger: 'manual' as const } : {}),
      autoCompact: { enabled: automaticMode !== 'off', mode: automaticMode, thresholdPercent: 90, ...(this.autoCompactionBlocked.has(id) && active?.phase !== 'compacting' ? { blocked: true } : {}) } };
    if (operation && !operation.abort.signal.aborted) snapshot.taskState = operation.kind === 'compact' ? 'thinking' : 'starting';
    if (active?.phase === 'compacting' || active?.phase === 'compacting_in_turn') { snapshot.taskState = active.abort.signal.aborted ? 'interrupted' : 'thinking'; snapshot.error = undefined; }
    const task = this.taskViews.get(id);
    if (task && (!active || active.taskId === task.taskId)) snapshot.nativeTask = toNativeTaskView(task);
    if (this.taskErrors.has(id)) { delete snapshot.nativeTask; snapshot.nativeTaskError = this.taskErrors.get(id); }
    // 只有已发布的账本运行定义快照的权威性。预检身份
    // 可能被弃用，例如自动压缩取消后；若暴露此身份，
    // 会导致下一个持久化快照的工作进程代次回退。
    return snapshot;
  }
  async page(id: string, options?: ChatPageOptions) { await this.hydrate(id); return this.projection.page(id, options); }
  readDisplay(id: string, options?: ChatPageOptions) { this.session(id); return this.projection.readDisplay(id, options); }
  async search(id: string, query: string, before?: string) { await this.hydrate(id); return this.projection.search(id, query, before); }
  attention() { return [...this.active.entries()].flatMap(([sessionId, run]) => run.approval ? [{ sessionId, requestId: run.approval.publicId, kind: run.approval.kind, toolName: run.approval.request.tool.name, createdAt: run.approval.createdAt }] : []); }
  send(id: string, text: string, attachments: string[] = [], _titlePrompt?: string, submission?: ExecutionSubmission): Promise<ChatTurnResult> {
    const session = this.session(id), sourceConfig = parseNativeConfig(session.engineConfig);
    if (!Array.isArray(attachments)) return Promise.reject(new Error('图片附件无效，请重新选择。'));
    if ((!text.trim() && !attachments.length) || Buffer.byteLength(text) > 1024 * 1024) return Promise.reject(new Error('输入为空或超过 1 MiB。'));
    const requestId = submission?.requestId ?? randomUUID();
    if (this.taskLeaseFailures.has(id)) return Promise.reject(new Error('任务记录仍持有写入资源，请先停止会话以重试释放。'));
    if (!requestId || requestId.length > 256 || requestId.includes('\0')) return Promise.reject(new Error('无效提交标识。'));
    const continuedTaskId = submission?.nativeTaskId;
    const executionPolicy = parseNativeExecutionPolicy(submission?.nativeExecutionPolicy);
    let nativeSkills: NativeSkillSubmission | undefined;
    try { nativeSkills = submission?.nativeSkills === undefined ? undefined : normalizeNativeSkillSubmission(submission.nativeSkills); }
    catch { return Promise.reject(new Error('无效技能引用，请重新选择。')); }
    if (nativeSkills !== undefined && !this.options.skills) return Promise.reject(new Error('当前执行器尚未启用新版技能运行能力，无法接受技能引用。'));
    if (continuedTaskId !== undefined && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(continuedTaskId)) return Promise.reject(new Error('无效任务标识。'));
    const expectedImageAttachments = submission?.imageAttachments;
    if (expectedImageAttachments !== undefined && !isNativeImageAttachments(expectedImageAttachments) ||
        submission?.source === 'queue' && attachments.length > 0 && expectedImageAttachments === undefined) return Promise.reject(new Error('图片队列记录缺少有效的内容校验，请重新选择并发送。'));
    const sourceOptions = canonicalJson(json(sourceConfig));
    const previous = this.active.get(id);
    if (previous) {
      if (previous.requestId !== requestId || previous.input !== text || previous.sourceOptions !== sourceOptions || previous.continuedTaskId !== continuedTaskId || canonicalJson(json(previous.nativeSkills ?? null)) !== canonicalJson(json(nativeSkills ?? null)) || canonicalJson(json(previous.executionPolicy ?? null)) !== canonicalJson(json(executionPolicy ?? null)) || canonicalJson(json(previous.expectedImageAttachments ?? [])) !== canonicalJson(json(expectedImageAttachments ?? []))) return Promise.reject(new Error('此会话仍持有执行资源，请等待停止完成。'));
      if (!previous.attachmentPaths.length && !attachments.length) return previous.promise;
      // 重复提交时重新读取所选清单条目。正在运行的
      // 请求保留原始快照，即使文件已变化。
      return Promise.all([previous.imageSnapshot ?? Promise.resolve({ images: previous.images, metadata: previous.imageAttachments }),
        readNativeImageAttachments(this.store.directory, id, [...attachments])]).then(([initial, current]) => {
        if (canonicalJson(json(initial)) !== canonicalJson(json(current))) throw new Error('此提交标识已用于不同的图片附件。');
        return previous.promise;
      });
    }
    if (this.taskReviews.has(id)) return Promise.reject(new Error('任务正在复核，请等待完成。'));
    if (this.contextOperations.has(id)) return Promise.reject(new Error('会话正在恢复或压缩上下文，请等待完成。'));
    if (this.maintenance || this.sessionMaintenance.has(id)) return Promise.reject(new Error('执行器正在维护或关闭。'));
    const config = this.runtimeConfig(session.engineConfig), encoded = canonicalJson(json(config));
    let resolve!: (value: ChatTurnResult) => void, reject!: (error: unknown) => void;
    const promise = new Promise<ChatTurnResult>((yes, no) => { resolve = yes; reject = no; });
    const active: ActiveRun = { executionPolicy, ...(nativeSkills === undefined ? {} : { nativeSkills }), ...(expectedImageAttachments === undefined ? {} : { expectedImageAttachments: json(expectedImageAttachments) }), attachmentPaths: [...attachments], images: [], imageAttachments: [], requestId, input: text, options: encoded, sourceOptions, runtimeConfig: config, connectionId: config.connectionId, mcpConnections: executionPolicy?.toolPolicy === 'read_only' ? [] : config.mcpConnections, abort: new AbortController(), promise, cleanupUnconfirmed: false, released: false, taskId: continuedTaskId ?? randomUUID(), continuedTaskId };
    this.active.set(id, active);
    void this.execute(id, active).then(resolve, reject);
    return promise;
  }
  private async execute(id: string, active: ActiveRun): Promise<ChatTurnResult> {
    let result: ChatTurnResult | undefined, failure: unknown;
    let receiptOnly = false;
    let mcpTools: ManagedMcpToolPort | undefined;
    let commandTools: NativeCommandTools | undefined;
    let quality: NativeWorkflowQualityController | undefined;
    let startup: { identity: RunIdentity; startupId: string } | undefined;
    let startedAt = performance.now();
    const activePause = new NativeActivePause();
    let pauseStarted: number | undefined;
    const stopPauseClock = activePause.subscribe(paused => {
      if (paused) pauseStarted = performance.now();
      else if (pauseStarted !== undefined) { startedAt += performance.now() - pauseStarted; pauseStarted = undefined; }
    });
    const elapsedActiveMs = () => Math.max(0, (pauseStarted ?? performance.now()) - startedAt);
    try {
      this.assertActive(id, active);
      active.imageSnapshot = readNativeImageAttachments(this.store.directory, id, active.attachmentPaths).catch(() => { throw new Error('图片附件无效或已变更，请重新选择 PNG/JPEG 图片。'); });
      // 为处理并发重复调用，在首次 await 前开始捕获快照。
      // 立即观察拒绝结果，但在将其报告前先检查历史所有权，
      // 防止无效旧附件改变较新的状态。
      void active.imageSnapshot.catch(() => {});
      await this.hydration.get(id);
      this.assertActive(id, active);
      const session = this.session(id), requestedConfig = active.runtimeConfig;
      // Internal Skills support fresh turns and exact context maintenance.
      // Delegated inheritance remains separately gated.
      const boundedConfig = requestedConfig;
      let config = boundedConfig;
      const optionsDigest = digest(active.options + (active.executionPolicy ? canonicalJson(json(active.executionPolicy)) : '') + (active.nativeSkills ? canonicalJson(json(active.nativeSkills)) : ''));
      // 先查回执，再解析凭据并创建工作进程；重试不得再次执行。
      let ledger = await NativeRunStore.open({ rootDirectory: path.join(this.store.directory, 'native', 'conversations'), conversationId: session.execution.conversationId! });
      active.store = ledger;
      await this.refreshProjection(id, ledger);
      if (ledger.recoveryRequired || this.projection.hasMissingContext(id)) this.recovery.add(id);
      // 模型终态回执不能证明其本地服务资源已关闭。
      if (ledger.getRecoveryReport()?.tools.some(tool => tool.name === 'mcp_stdio_startup' && tool.status === 'unknown')) throw new Error(RECOVERY);
      const priorStartup = ledger.lookupStartup(active.requestId);
      if (priorStartup?.status === 'recovery_required') throw new Error(RECOVERY);
      const duplicate = ledger.lookupSubmission(active.requestId);
      receiptOnly = Boolean(duplicate || priorStartup);
      const selected = await active.imageSnapshot;
      active.images = selected.images; active.imageAttachments = selected.metadata;
      if (active.expectedImageAttachments !== undefined && canonicalJson(json(active.imageAttachments)) !== canonicalJson(json(active.expectedImageAttachments))) throw new Error('图片附件内容与已接受的队列记录不一致，请重新选择并发送。');
      this.assertActive(id, active);
      const submissionDigest = nativeSubmissionInputDigest(active.input, json(active.imageAttachments), active.nativeSkills === undefined ? undefined : json(active.nativeSkills));
      if (duplicate) {
        receiptOnly = true;
        const priorOptions = parseNativeConfig({ schemaVersion: 1, options: duplicate.request.configuration.sessionOptions as EngineConfig['options'] });
        if (duplicate.request.input !== active.input || canonicalJson(duplicate.request.configuration.imageAttachments ?? []) !== canonicalJson(json(active.imageAttachments)) || canonicalJson(duplicate.request.configuration.nativeSkills ?? null) !== canonicalJson(json(active.nativeSkills ?? null)) || canonicalJson(json(priorOptions)) !== active.options || canonicalJson(duplicate.request.configuration.nativeExecutionPolicy ?? null) !== canonicalJson(json(active.executionPolicy ?? null)) || duplicate.request.configuration.continuedTaskId !== active.continuedTaskId) throw new Error('此提交标识已用于不同的输入或配置。');
        await this.refreshProjection(id, ledger);
        if (!duplicate.result) throw new Error(RECOVERY);
        result = await this.turnResult(duplicate.result, ledger);
      } else if (priorStartup) {
        receiptOnly = true;
        if (priorStartup.inputDigest !== submissionDigest || priorStartup.optionsDigest !== optionsDigest) throw new Error('此提交标识已用于不同的输入或配置。');
        result = { success: false, summary: '', error: '此提交已尝试启动本地 MCP 服务，不会重复启动。请重新发送新任务。' };
      } else {
      if (ledger.recoveryRequired || this.recovery.has(id)) throw new Error(RECOVERY);
      const hasHistoricalSkills = ledger.listRuns().some(run => run.configuration.nativeSkillCatalog !== undefined || run.configuration.nativeSkills !== undefined);
      if (hasHistoricalSkills && !this.options.skills) throw new Error('当前执行器尚未启用新版技能连续性，不能继续此会话；原提交仍可查询回执。');
      this.changed(id, 'starting');
      const connection = this.connections.resolve(config.connectionId, config.model || undefined);
      const capabilitySnapshot = await this.options.modelCapabilities?.resolve(connection, { timeoutMs: 3000 });
      this.assertActive(id, active);
      if (this.connections.resolve(requestedConfig.connectionId, requestedConfig.model || undefined).revision !== connection.revision) throw new Error('模型连接已更新，请重新发送。');
      const modelCapabilities = capabilitySnapshot?.connectionId === connection.connectionId && capabilitySnapshot.revision === connection.revision
        ? nativeModelCapabilityUsage(capabilitySnapshot, connection.model) : undefined;
      config = nativeModelBudget(boundedConfig, modelCapabilities?.capabilities);
      const mcpConnections = (active.executionPolicy?.toolPolicy === 'read_only' ? [] : config.mcpConnections).map(id => {
        if (!this.options.mcpConnections) throw new Error('MCP 连接管理尚未就绪。');
        return this.options.mcpConnections.resolve(id);
      });
      const forbiddenValues = [connection.apiKey, ...mcpConnections.flatMap(item => item.transport === 'stdio' ? Object.values(item.environment) : [item.bearerToken])].filter((value): value is string => Boolean(value));
      const previous = ledger.listRuns().at(-1)?.configuration;
      if (previous && (previous.connectionId !== connection.connectionId || previous.model !== connection.model || previous.baseURL !== connection.baseURL || (previous.protocol ?? 'responses') !== connection.protocol)) throw new Error('已有上下文绑定原服务、协议与模型。切换服务、协议或模型请新建会话。');
      const generation = Math.max(0, ...ledger.listRuns().map(run => run.identity.workerGeneration)) + 1;
      await ledger.close(); active.store = undefined;
      ledger = await NativeRunStore.open({ rootDirectory: path.join(this.store.directory, 'native', 'conversations'), conversationId: session.execution.conversationId!, forbiddenValues });
      active.store = ledger;
      this.assertActive(id, active);
      const identity: RunIdentity = { sessionId: id, conversationId: session.execution.conversationId!, runId: randomUUID(), requestId: active.requestId, workerGeneration: generation };
      active.identity = identity;
      active.tasks = await this.openTaskSession(id, forbiddenValues);
      await active.tasks.refresh(ledger, identity);
      this.taskErrors.delete(id);
      if (active.continuedTaskId && !active.tasks.store.read(active.continuedTaskId)) throw new Error('待继续的任务不属于当前会话。');
      this.assertActive(id, active);
      this.changed(id, 'starting');
      let instructions = await loadProjectInstructions({ projectRoot: session.cwd, excludedRoots: [this.store.directory], projectSkills: config.projectSkills }, active.abort.signal);
      this.assertActive(id, active);
      const assertOwnership = async () => { this.assertActive(id, active); await this.options.assertOwnership?.(id, identity); this.assertActive(id, active); };
      const skillRun = await this.options.skills?.createRun({ sessionId: id, identity, submission: active.nativeSkills, signal: active.abort.signal, hasHistoricalSkills,
        baseInstructionBytes: 2 + Buffer.byteLength(buildNativeParentInstructions({ permissionInstructions: nativePermissionInstructions(config.permissionMode), projectInstructions: instructions.text })),
        forbiddenValues, assertOwnership, canActivate: () => {
          if (active.approval || active.cleanupUnconfirmed) return false;
          return !(ledger.getRun(identity.runId)?.tools ?? []).some(tool => tool.prepared &&
            (tool.prepared.prepared.definition.risk !== 'read' && (!tool.completed || tool.completed.result.status === 'unknown') ||
              tool.commandProgress?.length && tool.commandProgress.at(-1)?.status !== 'finished'));
        } });
      let modelInstructions = buildNativeParentInstructions({ permissionInstructions: nativePermissionInstructions(config.permissionMode),
        projectInstructions: [instructions.text, skillRun?.initialInstructions].filter(Boolean).join('\n\n') });
      const parentBudget = new NativeAggregateBudget({ ...config, unlimited: true }, active.abort.signal, () => Number.POSITIVE_INFINITY,
        { modelRequests: ledger.lookupAutoCompaction(identity.requestId) ? 1 : 0, toolCalls: 0 });
      const childBudgets = new Map<string, { budget: ReturnType<typeof createNativeChildBudget>; modelRequests: number; toolCalls: number }>();
      const worker: typeof runNativeWorker = async options => {
        const unregister = parentBudget.register(options.request.identity);
        try { return await (this.options.worker ?? runNativeWorker)({ ...options, activePause, consumeBudget: (kind, run) => parentBudget.consume(kind, run) }); }
        finally { unregister(); }
      };
      const stdioConnections = mcpConnections.filter(item => item.transport === 'stdio');
      active.children = new Map(); active.childApprovalQueue = Promise.resolve(); active.childLeases = new Map();
      const createChildBudget = (childIdentity: RunIdentity) => {
        const budget = createNativeChildBudget(childIdentity, config, active.abort.signal);
        childBudgets.set(childIdentity.runId, { budget, modelRequests: 0, toolCalls: 0 }); return budget;
      };
      const runChild = async (input: NativeAgentChildInput): Promise<NativeAgentChildResult> => {
        await assertOwnership();
        active.children!.set(input.identity.runId, input);
        let lease: { assert(): void | Promise<void>; release(): void | Promise<void> } | undefined;
        let retainLease = false;
        try {
          if (input.toolPolicy === 'workspace_write' || input.toolPolicy === 'workspace_verify' || input.quality) {
            lease = await this.options.acquireChildOwnership?.(id, input.identity, input.cwd);
            if (lease) active.childLeases!.set(input.identity.runId, lease);
          }
          const run = await runNativeAgentChild(input, { dataDirectory: this.store.directory,
            model: { protocol: connection.protocol, authHeader: connection.authHeader, baseURL: connection.baseURL,
              model: connection.model, apiKey: connection.apiKey, allowLoopbackHttp: connection.allowLoopbackHttp },
            config, forbiddenValues, worker: this.options.worker,
            assertOwnership: async () => { await assertOwnership(); await lease?.assert(); },
            approvals: { request: (request, signal) => {
              const operation = active.childApprovalQueue!.then(async () => {
                if (signal.aborted) return { binding: request.binding, expiresAt: request.expiresAt, decision: 'denied' as const };
                return await this.approve(id, active, request, signal, input);
              });
              active.childApprovalQueue = operation.then(() => {}, () => {});
              return operation;
            } },
          });
          const usage = childBudgets.get(input.identity.runId);
          if (usage) { usage.modelRequests = run.modelRequests; usage.toolCalls = run.toolCalls; }
          retainLease = !run.committed || run.status === 'recovery_required';
          return run;
        } catch (error) {
          retainLease = Boolean(error && typeof error === 'object' && 'cleanupUnconfirmed' in error && error.cleanupUnconfirmed);
          throw error;
        } finally {
          active.children!.delete(input.identity.runId);
          if (retainLease) { active.cleanupUnconfirmed = true; this.recovery.add(id); }
          else if (lease) {
            try { await lease.release(); active.childLeases!.delete(input.identity.runId); }
            catch { active.cleanupUnconfirmed = true; this.recovery.add(id); }
          }
        }
      };
      active.delegation = createAgentDelegationTools({ identity, parentTaskId: active.taskId, cwd: session.cwd,
        policy: active.executionPolicy?.toolPolicy === 'read_only' ? 'read_only' : 'workspace_write',
        signal: active.abort.signal, forbiddenValues, storeDirectory: path.join(this.store.directory, 'native'),
        worktreeRoot: path.join(this.store.directory, 'native', 'agent-worktrees'), maxSubagents: config.maxSubagents,
        createChildBudget, assertOwnership, runChild,
        record: async receipt => { try { this.projection.nativeAgent(id, receipt); } catch { this.options.onError?.(new Error('Native child state projection needs repair.')); } },
      });
      // Only current user input or the host's explicit workflow policy may request this team.
      const workflowIntent = active.executionPolicy ? undefined : nativeWorkflowCollaborationIntent(active.input);
      const collaboration = active.executionPolicy?.collaboration ?? workflowIntent?.collaboration;
      const singleAgent = collaboration === 'single_agent' || nativeParallelReviewIntent(active.input).mode === 'single_agent';
      const validationMode = active.executionPolicy ? active.executionPolicy.qualityValidation ??
        (active.executionPolicy.toolPolicy === 'standard' ? 'commands' : undefined) : workflowIntent?.validationMode;
      if (collaboration && !singleAgent && validationMode) {
        if (skillRun) throw new Error('当前技能运行尚不支持独立质量子任务的权限继承，请使用未启用技能的工作流；本轮未开始执行。');
        quality = createNativeWorkflowQualityController({ identity, parentTaskId: active.taskId, cwd: session.cwd,
          dataDirectory: this.store.directory, collaboration, validationMode, goal: active.input,
          maxSubagents: config.maxSubagents, forbiddenValues, signal: active.abort.signal, createChildBudget, assertOwnership, runChild,
          readDelivery: async () => {
            for (let end = ledger.usage.records; end > 0;) {
              const start = Math.max(0, end - 1000), records = ledger.replay(start, end - start);
              for (let index = records.length - 1; index >= 0; index--) {
                const record = records[index];
                if (record.identity && sameRun(record.identity, identity) && record.event.type === 'model_response')
                  return extractNativeAssistantText(record.event.response.outputItems);
              }
              end = start;
            }
            throw new Error('独立质量核查缺少当前运行的实际交付正文。');
          },
          materialPaths: async () => {
            await active.tasks!.settled();
            const task = active.tasks!.store.read(active.taskId), run = ledger.getRun(identity.runId);
            const paths = new Set([...(task?.workspace?.changes.added ?? []), ...(task?.workspace?.changes.modified ?? [])]);
            for (const tool of run?.tools ?? []) {
              const output = tool.completed?.result.output;
              if (tool.call.name === 'read_file' && tool.completed?.result.status === 'completed' && output &&
                  typeof output === 'object' && !Array.isArray(output) && typeof output.path === 'string') paths.add(output.path);
            }
            return paths.size ? [...paths] : undefined;
          },
          onChanged: state => this.projection.workflowQuality(id, state),
        });
      }
      let assertStartupCurrent: (() => Promise<void>) | undefined;
      if (stdioConnections.length) {
        const metadata = await mcpStartupMetadata(mcpConnections, session.cwd);
        for (const secret of forbiddenValues) assertNoModelCredential(metadata, secret);
        const policyRevision = digest(canonicalJson(json({ instructions: instructions.digest, launch: metadata,
          ...(skillRun ? { nativeSkillCatalog: skillRun.catalogRevision, initialSkills: skillRun.tools.snapshot() } : {}) })));
        const request: ApprovalRequest = {
          binding: { ...identity, toolCallId: 'mcp_stdio_startup', inputDigest: digest(canonicalJson(metadata)), policyRevision },
          tool: { name: 'mcp_stdio_startup', description: '启动所选本地 MCP 服务。程序可访问当前用户资源；启动及后续工具调用分别审批。', risk: 'command', inputSchema: { type: 'object' } },
          input: metadata, preconditions: { instructions: instructions.digest,
            ...(skillRun ? { nativeSkillCatalog: skillRun.catalogRevision, initialSkills: json(skillRun.tools.snapshot()) } : {}) }, expiresAt: Date.now() + 5 * 60_000,
        };
        const resume = activePause.pause();
        let approval: ApprovalDecision;
        try { approval = await this.approve(id, active, request, active.abort.signal); }
        finally { resume(); }
        if (approval.decision !== 'approved' || approval.expiresAt <= Date.now()) throw new Error('本地 MCP 服务启动未获批准，未启动服务。');
        const recheck = async () => {
          await assertOwnership();
          await skillRun?.assertInitialCurrent();
          const current = await loadProjectInstructions({ projectRoot: session.cwd, excludedRoots: [this.store.directory], projectSkills: config.projectSkills }, active.abort.signal);
          if (current.digest !== instructions.digest) throw new Error('项目指令或 Skills 已改变，本地 MCP 启动审批失效。');
          for (const selected of stdioConnections) {
            const current = this.options.mcpConnections!.resolve(selected.connectionId);
            if (canonicalJson(json(current)) !== canonicalJson(json(selected))) throw new Error('MCP 连接或环境值已改变，请重新审批启动。');
          }
          if (canonicalJson(await mcpStartupMetadata(mcpConnections, session.cwd)) !== canonicalJson(metadata)) throw new Error('MCP 可执行文件已改变，请重新审批启动。');
          if (approval.expiresAt <= Date.now()) throw new Error('MCP 启动审批已过期。');
          await assertOwnership();
        };
        assertStartupCurrent = recheck;
        await recheck();
        await ledger.prepareStartup({ identity, startupId: 'mcp_stdio_startup', inputDigest: submissionDigest, optionsDigest, metadata, policyRevision, approval });
        startup = { identity, startupId: 'mcp_stdio_startup' };
        await recheck();
        this.changed(id, 'starting');
      }
      // 读取目录是当前会话显式选择服务产生的操作。
      // 工具目录发现保留自己的传输超时，不占用子 Agent 的时长。
      if (mcpConnections.length) {
        mcpTools = await createMcpToolPort({ connections: mcpConnections, forbiddenValues,
          ...(skillRun ? { assertSideEffectsCurrent: (signal: AbortSignal) => skillRun.tools.assertSideEffectsCurrent(signal) } : {}),
          ...(stdioConnections.length ? { stdio: { supervisor: this.supervisor, ownerId: identity.runId, cwd: session.cwd,
            assertStartupCurrent: assertStartupCurrent!, ...(skillRun ? { beforeLaunch: assertStartupCurrent! } : {}) } } : {}),
          assertOwnership: async () => {
            await assertOwnership();
            const current = await loadProjectInstructions({ projectRoot: session.cwd, excludedRoots: [this.store.directory], projectSkills: config.projectSkills }, active.abort.signal);
            if (current.digest !== instructions.digest) throw new Error('项目指令或 Skills 已改变，MCP 审批失效，请重新发送任务。');
            await assertOwnership();
          }, assertConnectionCurrent: (id, revision) => this.options.mcpConnections!.assertCurrent({ id, revision }),
        }, AbortSignal.any([active.abort.signal, AbortSignal.timeout(30_000)]));
      }
      const questions = createQuestionTool({ identity, forbiddenValues, assertOwnership: async () => {
        await assertOwnership();
        const current = await loadProjectInstructions({ projectRoot: session.cwd, excludedRoots: [this.store.directory], projectSkills: config.projectSkills }, active.abort.signal);
        if (current.digest !== instructions.digest) throw new Error('项目指令或 Skills 已改变，提问已失效，请重新发送任务。');
        await assertOwnership();
      } });
      active.questions = questions;
      const assertTaskOwnership = async () => {
        await assertOwnership();
        if (this.taskErrors.has(id)) throw new Error('任务记录当前不可用，请结束后重新核查。');
        const current = await loadProjectInstructions({ projectRoot: session.cwd, excludedRoots: [this.store.directory], projectSkills: config.projectSkills }, active.abort.signal);
        if (current.digest !== instructions.digest) throw new Error('项目指令或 Skills 已改变，任务计划更新已失效。');
        await assertOwnership();
      };
      const taskTools = createNativeTaskTool({ identity, taskId: active.taskId, forbiddenValues, assertOwnership: assertTaskOwnership,
        store: { read: taskId => active.tasks!.store.read(taskId), apply: update => active.tasks!.store.apply(update, { assertWriteAllowed: assertTaskOwnership }) },
        onCommitted: snapshot => active.tasks!.planCommitted(snapshot) });
      const locationTools = createCodeLocationTool({ identity, taskId: active.taskId, session: active.tasks,
        projectRoot: session.cwd, excludedRoots: [this.store.directory], projectSkills: config.projectSkills,
        forbiddenValues, assertOwnership: assertTaskOwnership });
      commandTools = createCommandTools({ identity, taskId: active.taskId, supervisor: this.supervisor, signal: active.abort.signal, forbiddenValues,
        ...(skillRun ? { assertSideEffectsCurrent: () => skillRun.tools.assertSideEffectsCurrent(active.abort.signal) } : {}),
        remainingMs: () => Number.POSITIVE_INFINITY, assertOwnership,
        record: async (call, progress) => {
          if (progress.status === 'prepared') await assertOwnership();
          await ledger.recordCommandEvent(identity, call, progress);
          try { await this.refreshProjection(id, ledger); } catch { /* 投影修复失败时，持久化生命周期仍是权威依据。 */ }
        },
        onFailure: () => { active.cleanupUnconfirmed = true; this.recovery.add(id); active.abort.abort(); },
        onPrepared: async (prepared, signal) => active.tasks!.commandStarted({ taskId: active.taskId, identity, prepared, signal }),
        onFinished: async (prepared, result) => {
          try { await active.tasks!.commandTerminated({ taskId: active.taskId, identity, callId: prepared.call.id, result }); }
          catch { this.taskErrors.set(id, '长命令终态已保存，但任务证据暂不可用；验收状态未知，请结束后刷新核查。'); this.projection.notifyTask(id); }
        },
      });
      const createTools = (): ToolPort => {
        const local = composeToolPorts([questions, taskTools, locationTools, commandTools!, createLocalToolPort({ startCommand: (prepared, context, command) => commandTools!.start(prepared, context, command), projectRoot: session.cwd, excludedRoots: [this.store.directory], supervisor: this.supervisor, ownerId: identity.runId, forbiddenValues, initialInstructions: instructions, projectSkills: config.projectSkills,
          ...(skillRun ? { assertSideEffectsCurrent: (signal: AbortSignal) => skillRun.tools.assertSideEffectsCurrent(signal) } : {}), assertOwnership: async run => {
          if (!sameRun(run, identity)) throw new Error('工具运行归属已失效。');
          await assertOwnership();
        }, recordChangeSetEvent: async (run, call, progress) => {
          if (!sameRun(run, identity)) throw new Error('变更集回执的运行归属已失效。');
          // 操作生效前必须有当前所有者。操作生效后保留
          // 回执，即使写入期间收到取消或丢失租约。
          if (progress.status === 'prepared') await assertOwnership();
          await ledger.recordChangeSetEvent(run, call, progress);
          // 投影修复不得将已提交的操作回执变成
          // 看似持久化失败的结果；账本仍是权威依据。
          try { await this.refreshProjection(id, ledger); } catch { /* hydrate 已报告投影错误 */ }
        } })]);
        if (!mcpTools) return local;
        const remote = mcpTools, instructionDigest = instructions.digest;
        const validateInstructions = async (signal: AbortSignal) => {
          await assertOwnership();
          const current = await loadProjectInstructions({ projectRoot: session.cwd, excludedRoots: [this.store.directory], projectSkills: config.projectSkills }, signal);
          if (current.digest !== instructionDigest) throw new Error('项目指令或 Skills 已改变，MCP 审批失效，请重新发送任务。');
          await assertOwnership();
        };
        return composeToolPorts([local, {
          definitions: remote.definitions,
          prepare: async (call, context) => { await validateInstructions(context.signal); return remote.prepare(call, context); },
          validate: async (prepared, context) => { await remote.validate(prepared, context); await validateInstructions(context.signal); },
          execute: async (prepared, context, approval) => {
            try { await validateInstructions(context.signal); }
            catch { return { status: 'not_executed', output: { code: 'mcp_precondition_changed' } }; }
            return remote.execute(prepared, context, approval);
          },
        }]);
      };
      const resultTools = createAgentResultTools({ dataDirectory: this.store.directory, identity, forbiddenValues: [...forbiddenValues, ...this.agentResultSecrets()],
        assertOwnership, resolveParent: parentRunId => ledger.listRuns().find(run => run.identity.runId === parentRunId &&
          run.identity.sessionId === identity.sessionId && run.identity.conversationId === identity.conversationId)?.identity });
      // 单 Agent 或明确禁止委派的请求在宿主侧不注册委派工具，不能靠模型自律放宽。
      const stageTools = () => {
        const ordinary = active.tasks!.wrapTools(composeToolPorts([createTools(),
          ...(skillRun || singleAgent ? [] : [active.delegation!]), resultTools]), active.taskId, identity);
        const combined = skillRun ? composeToolPorts([skillRun.tools.guard(ordinary), ...(skillRun.catalog.entries.some(entry => entry.autoMatchable) ? [skillRun.tools] : [])]) : ordinary;
        return restrictNativeTools(combined, active.executionPolicy);
      };
      let tools = stageTools();
      const model = { protocol: connection.protocol, authHeader: connection.authHeader, baseURL: connection.baseURL, model: connection.model, apiKey: connection.apiKey, allowLoopbackHttp: connection.allowLoopbackHttp, toolDefinitions: tools.definitions };
      for (const secret of forbiddenValues) assertNoModelCredential({ input: active.input, instructions: modelInstructions, tools: tools.definitions, context: ledger.loadContext() }, secret);
      const automatic = await autoCompactBeforeSend({ ledger, identity, input: active.input, images: active.images, imageAttachments: active.imageAttachments,
        ...(active.nativeSkills ? { nativeSkills: active.nativeSkills } : {}),
        config, model, instructions: modelInstructions, forbiddenValues,
        ...(skillRun ? { skills: {
          prepare: retainedContext => this.options.skills!.prepareConversationContinuity(id, ledger, retainedContext, active.abort.signal, forbiddenValues),
          assertCurrent: async () => {
            await skillRun.assertInitialCurrent();
            const current = await loadProjectInstructions({ projectRoot: session.cwd, excludedRoots: [this.store.directory], projectSkills: config.projectSkills }, active.abort.signal);
            if (current.digest !== instructions.digest) throw new Error('摘要期间项目指令或 Skills 已改变，未替换原始上下文。');
            await assertOwnership();
          },
        } } : {}),
        signal: active.abort.signal, startedAt, assertOwnership, worker, unlimited: true,
        onCompacting: () => { active.phase = 'compacting'; this.changed(id, 'thinking'); },
        onCommitted: () => this.refreshProjection(id, ledger) });
      if (automatic.compacted) {
        // 摘要请求进行期间，项目指令可能发生变化。
        instructions = await loadProjectInstructions({ projectRoot: session.cwd, excludedRoots: [this.store.directory], projectSkills: config.projectSkills }, active.abort.signal);
        modelInstructions = buildNativeParentInstructions({ permissionInstructions: nativePermissionInstructions(config.permissionMode),
          projectInstructions: [instructions.text, skillRun?.initialInstructions].filter(Boolean).join('\n\n') });
        tools = stageTools();
        model.toolDefinitions = tools.definitions;
        assertNativeInputBudget(ledger.loadContext()!, active.input, modelInstructions, config, model, active.images);
      }
      await assertOwnership();
      // 主任务显式关闭三类运行上限；保留有限数值作为兼容元数据，不创建超大计时器。
      const maxActiveMs = config.maxActiveMs;
      const mcpMetadata = mcpConnections.map(mcpConnectionMetadata);
      const policyRevision = digest(canonicalJson(json({ version: 1, cwd: session.cwd, instructions: instructions.digest,
        ...(skillRun ? { nativeSkillCatalog: skillRun.catalogRevision, initialSkills: skillRun.tools.snapshot() } : {}),
        ...(active.executionPolicy ? { nativeExecutionPolicy: active.executionPolicy } : {}),
        ...(mcpMetadata.length ? { mcpConnections: mcpMetadata, mcpTools: mcpTools!.definitions } : {}) })));
      const durable: RunStore = {
        beginRun: async request => { const accepted = await ledger.beginRun(request); if (accepted.kind === 'accepted') {
          this.store.change(state => { state.sessions.find(session => session.id === id)!.started = true; });
          if (active.continuedTaskId) { await assertTaskOwnership(); await active.tasks!.continueTask(active.continuedTaskId, identity, assertTaskOwnership); }
        } await this.refreshProjection(id, ledger, true); return accepted; },
        append: async (run, event) => {
          // 模型完成不会释放仍在运行的命令。提交模型结果前，所有管理的
          // 进程树和终态回执必须先结束。
          if (event.type === 'run_finished') {
            try { await quality?.closeAll(); await active.delegation?.closeAll(); await commandTools?.closeAll(); }
            catch (error) { active.cleanupUnconfirmed = true; throw error; }
          }
          const accepted = await ledger.append(run, event);
          // UI projection events cannot activate guides. Only the actual durable
          // append receipt may advance the per-run observation barrier.
          skillRun?.tools.observeCommitted(event, accepted.seq);
          try { if (!this.taskErrors.has(id)) await active.tasks!.committed(active.taskId, identity, event); }
          catch { this.taskErrors.set(id, '执行回执已保存，但任务证据暂不可用；验收状态未知，请结束后刷新核查。'); this.projection.notifyTask(id); }
          await this.refreshProjection(id, ledger, true); return accepted;
        },
        ensureCapacity: (run, bytes) => ledger.ensureCapacity(run, bytes),
        checkpoint: (run, context) => ledger.checkpoint(run, context),
      };
      active.phase = undefined;
      this.changed(id, 'starting');
      await skillRun?.assertInitialCurrent();
      const run = await worker({
        request: { identity, input: active.input, diagnosticPurpose: 'normal', diagnosticInstructionSections: nativePromptInstructionSections({ permissionInstructions: nativePermissionInstructions(config.permissionMode), projectInstructions: instructions.text, projectRules: projectInstructionText(instructions.sources.filter(source => !source.path.endsWith('/SKILL.md'))), skills: [projectInstructionText(instructions.sources.filter(source => source.path.endsWith('/SKILL.md'))), skillRun?.initialInstructions].filter(Boolean).join('\n\n') }), ...(active.images.length ? { images: json(active.images) } : {}), policyRevision, modelRetry: config.modelRetry, configuration: json({ ...(active.imageAttachments.length ? { imageAttachments: active.imageAttachments } : {}), connectionId: connection.connectionId, connectionRevision: connection.revision, protocol: connection.protocol, baseURL: connection.baseURL, model: connection.model, ...(connection.pricing ? { pricing: connection.pricing } : {}), sessionOptions: requestedConfig, effectiveSubagentPolicy: { maxSubagents: config.maxSubagents, policySource: requestedConfig.runtimePolicy === 'defaults' ? 'defaults' : 'session' }, ...(quality ? { nativeWorkflowQualityPolicy: { collaboration, validationMode } } : {}), ...(active.nativeSkills ? { nativeSkills: active.nativeSkills } : {}), ...(skillRun ? { nativeSkillCatalog: { revision: skillRun.catalogRevision, entries: skillRun.catalog.entries.map(({ skillId, sourceId, relativePath, sourceRevision, sourceFingerprint, metadataHash, format }) => ({ skillId, sourceId, relativePath, sourceRevision, sourceFingerprint, metadataHash, format })), truncated: skillRun.catalog.truncated }, initialNativeSkills: skillRun.tools.snapshot(), effectiveAutoCompact: config.autoCompact } : {}), ...(active.executionPolicy ? { nativeExecutionPolicy: active.executionPolicy } : {}), ...(modelCapabilities ? { modelCapabilities } : {}), effectiveBudget: { maxInputTokens: config.maxInputTokens, maxOutputTokens: config.maxOutputTokens }, ...(active.continuedTaskId ? { continuedTaskId: active.continuedTaskId } : {}), nativeTaskId: active.taskId, delegationPromptVersion: NATIVE_DELEGATION_PROMPT_VERSION, delegationIntent: nativeParallelReviewIntent(active.input), modelInstructions, toolDefinitions: tools.definitions, mcpConnections: mcpMetadata, adapterVersion: 1, instructions: instructions.sources.map(({ path: sourcePath, scope, hash }) => ({ path: sourcePath, scope, hash })) }), budget: { unlimited: true, maxModelRequests: config.maxModelRequests, maxToolCalls: config.maxToolCalls, maxActiveMs, maxInputTokens: config.maxInputTokens, maxOutputTokens: config.maxOutputTokens } },
        model: { ...model, instructions: modelInstructions }, forbiddenValues,
        tools, store: durable, approvals: { request: async (request, signal) => {
          const resume = activePause.pause();
          try { return await this.approve(id, active, request, signal); }
          finally { resume(); }
        } }, signal: active.abort.signal,
        ...(quality ? { completionValidation: { validate: async candidate => {
          await assertOwnership();
          if (!sameRun(candidate.identity, identity) || canonicalJson(json(candidate.context)) !== canonicalJson(json(ledger.loadContext()))) throw new Error('独立质量核查的父运行上下文已改变。');
          const pending = ledger.getRun(identity.runId)?.tools.filter(tool => tool.commandProgress?.length && tool.commandProgress.at(-1)?.status !== 'finished') ?? [];
          if (pending.length) return { kind: 'continue' as const, code: 'workflow_quality_changes_requested' as const, paths: [],
            feedback: JSON.stringify({ issue: 'parent_commands_not_terminal', instruction: 'Await command_status or use stop_command for all current command handles before requesting independent validation. Startup does not prove validation completed.' }) };
          return quality!.validate(candidate);
        } } } : {}),
        ...(config.autoCompact === 'before_send_and_during_run' ? { contextMaintenance: createInRunCompaction({ ledger, identity,
          model: { ...model, instructions: modelInstructions }, forbiddenValues, signal: active.abort.signal,
          remainingMs: () => Number.POSITIVE_INFINITY, assertOwnership,
          assertInstructions: async signal => {
            await assertOwnership();
            const current = await loadProjectInstructions({ projectRoot: session.cwd, excludedRoots: [this.store.directory], projectSkills: config.projectSkills }, signal);
            if (current.digest !== instructions.digest) throw new Error('项目指令或 Skills 已改变，请结束当前回合后重新发送。');
            await skillRun?.tools.assertSourcesCurrent(signal);
            await assertOwnership();
          }, continuity: async () => {
            await active.tasks!.settled();
            return buildNativeContextContinuity({ identity, taskId: active.taskId, task: active.tasks!.store.read(active.taskId),
              run: ledger.listRuns().find(item => sameRun(item.identity, identity)), issues: this.taskErrors.has(id) ? [this.taskErrors.get(id)!] : [] });
          }, ...(skillRun ? { skills: {
            prepare: retainedContext => skillRun.prepareContinuity(ledger, retainedContext),
            prepareHistorical: retainedContext => this.options.skills!.prepareConversationContinuity(id, ledger, retainedContext, active.abort.signal, forbiddenValues, identity.runId),
            onCommitted: (seq, section) => skillRun.tools.observeContextReplacement(seq, section.manifest),
          } } : {}),
          onCompacting: async () => { active.phase = 'compacting_in_turn'; this.changed(id, 'thinking'); await this.refreshProjection(id, ledger); },
          onSettled: async () => { active.phase = undefined; await this.refreshProjection(id, ledger); }, worker,
        }) } : {}),
        onEvent: event => this.projection.event(id, event),
      });
      if (run.status === 'recovery_required' || !run.committed) { this.recovery.add(id); this.acknowledged.delete(id); }
      if (run.projectionError) this.options.onError?.(new Error('Native result was committed but its UI projection needs repair.'));
      await this.refreshProjection(id, ledger, true);
      try { if (!this.taskErrors.has(id)) await active.tasks.refresh(ledger); }
      catch { this.taskErrors.set(id, '本轮执行已结束，但任务记录未能完成核查，验收状态未知。'); this.projection.notifyTask(id); }
      const parentCounts = parentBudget.snapshot();
      const childCounts = [...childBudgets.values()].reduce((total, child) => {
        const counts = child.budget.snapshot(); return { modelRequests: total.modelRequests + Math.max(counts.modelRequests, child.modelRequests),
          toolCalls: total.toolCalls + Math.max(counts.toolCalls, child.toolCalls) };
      }, { modelRequests: 0, toolCalls: 0 });
      result = await this.turnResult(run, ledger, active.tasks.store.read(active.taskId), elapsedActiveMs(),
        { modelRequests: Math.max(parentCounts.modelRequests, run.modelRequests + config.maxModelRequests - automatic.remainingRequests) + childCounts.modelRequests,
          toolCalls: Math.max(parentCounts.toolCalls, run.toolCalls) + childCounts.toolCalls });
      }
    } catch (error) {
      reportNativeDiagnostic('execute', error);
      failure = error;
      if (error && typeof error === 'object' && 'cleanupUnconfirmed' in error && error.cleanupUnconfirmed) active.cleanupUnconfirmed = true;
      result = { success: false, summary: '', error: active.abort.signal.aborted ? '执行已取消。' : this.safeError(error), interrupted: active.abort.signal.aborted };
    } finally {
      // 水合期间打开的文件描述符属于当前活动运行。
      await active.imageSnapshot?.catch(() => {});
      active.phase = undefined;
      active.approval?.settle('denied');
      try { await quality?.closeAll(); await active.delegation?.closeAll(); await active.childApprovalQueue; }
      catch { active.cleanupUnconfirmed = true; }
      stopPauseClock();
      try { await commandTools?.closeAll(); }
      catch { active.cleanupUnconfirmed = true; }
      try { await mcpTools?.close(); }
      catch { active.cleanupUnconfirmed = true; }
      try { if (active.identity) await this.supervisor.stopOwner(active.identity.runId); }
      catch { active.cleanupUnconfirmed = true; }
      if (startup && active.store && !active.cleanupUnconfirmed) {
        try { await active.store.closeStartup(startup.identity, startup.startupId); }
        catch { active.cleanupUnconfirmed = true; }
      }
      try {
        if (active.store) {
          // 工作进程崩溃可能留下活动账本；下方重新打开并标记为 interrupted/unknown。
          try { await this.refreshProjection(id, active.store, true); }
          finally { await active.store.close(); active.store = undefined; }
        }
        this.projection.flush();
      } catch { this.recovery.add(id); active.cleanupUnconfirmed = true; }
      const executionCleanupUnconfirmed = active.cleanupUnconfirmed;
      try {
        if (active.tasks) { await active.tasks.settled().catch(() => {}); await this.closeTaskStore(active.tasks.store); active.tasks = undefined; }
      } catch { active.cleanupUnconfirmed = true; active.taskCleanupOnly = !executionCleanupUnconfirmed; this.taskErrors.set(id, '任务记录尚未安全关闭，请检查磁盘。'); }
      if (!active.cleanupUnconfirmed) {
        active.released = true;
        if (this.active.get(id) === active) this.active.delete(id);
        if (failure && active.identity) {
          try { await this.hydrate(id); } catch { this.recovery.add(id); }
        }
      }
      if (active.cleanupUnconfirmed) {
        this.recovery.add(id);
        // 任务元数据所有权仍会阻止新运行，但不能撤销
        // 已提交的执行回执，或使已执行队列项被重放。
        if (executionCleanupUnconfirmed || !result?.success) result = { success: false, summary: '', error: '进程或记录的清理尚未确认，目录继续保持占用。请先解决清理失败。' };
      }
      // 历史回执，包括因身份不匹配被拒绝的回执，归属于
      // 原始运行，不得覆盖较新运行的当前状态。
      // 实际的恢复失败或资源释放失败仍会发布屏障。
      try {
        if (!receiptOnly || this.recovery.has(id)) this.changed(id,
          this.recovery.has(id) ? 'error' : result?.success ? 'completed' : result?.interrupted ? 'interrupted' : 'error',
          this.recovery.has(id) ? this.recoveryMessage(id) : result?.error);
      }
      catch { this.options.onError?.(new Error('Native session state could not be saved.')); }
    }
    return result!;
  }
  private assertActive(id: string, active: ActiveRun) {
    if (this.active.get(id) !== active || active.abort.signal.aborted || this.maintenance || this.sessionMaintenance.has(id)) throw new Error('执行已取消或运行归属已失效。');
  }
  private safeError(error: unknown) {
    // 保留有用的宿主诊断信息，不持久化任意传输错误或凭据。
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    const contextErrors: Record<string, string> = {
      active_time_budget: '本次执行时长预算已耗尽，未发起后续模型请求；请调整预算或缩小任务后重新发送。',
      nothing_to_compact: '暂无可压缩的完整旧回合；至少需要保留一个最近完整回合。',
      compaction_not_smaller: '模型摘要未能缩小上下文，本次未替换历史；摘要请求仍可能产生费用。',
      image_context_compaction_unsupported: '仅可压缩首张图片所在轮次之前的完整纯文本历史，当前没有这样的历史，未调用摘要模型；请提高输入预算或新建会话，原始图片和记录保持不变。',
      unsupported_protocol: '记录包含暂不支持压缩或恢复的协议内容，原始记录保持不变。',
      stale_context: '上下文记录已改变，请刷新后重试。',
      skill_snapshot_unavailable: '历史技能的精确版本快照缺失或损坏，未替换上下文。请核查技能快照与原始记录；不会自动重试摘要。',
      invalid_skill_evidence: '技能历史的版本或持久回执无法核验，未替换上下文。请核查原始记录。',
      invalid_skill_continuity: '完整技能历史无法在连续性限制内核验或保留，未替换上下文。请核查版本与输入预算，或新建会话。',
      limit_exceeded: '本地记录达到容量限制，请检查数据目录；压缩不会删除原始记录或释放账本空间。',
    };
    if (typeof code === 'string' && contextErrors[code]) return contextErrors[code];
    const message = error instanceof Error ? error.message : '';
    return /^[\u3400-\u9fff]/.test(message) && message.length < 1000 ? message : '自研 agent 执行失败，请检查连接、项目权限和本地记录。';
  }
  private async turnResult(result: RunResult, ledger: NativeRunStore, task?: NativeTaskSnapshot | null, activeMs?: number,
    counts?: { modelRequests: number; toolCalls: number }): Promise<ChatTurnResult> {
    // 压缩后的上下文含有宿主编写的历史助手数据。只有
    // 当前运行最新的持久化模型响应可以成为其工作流
    // 产物；纯工具响应或空响应明确不生成摘要。
    let summary = '', foundResponse = false;
    const details: NativeRunErrorDetails = { modelRequests: result.modelRequests, toolCalls: result.toolCalls, retries: 0 };
    const startedAttempts = new Set<number>();
    for (let end = ledger.usage.records; end > 0;) {
      const start = Math.max(0, end - 1000);
      const records = ledger.replay(start, end - start);
      for (let index = records.length - 1; index >= 0; index--) {
        const record = records[index];
        if (!record.identity || !sameRun(record.identity, result.identity)) continue;
        const event = record.event;
        if (event.type === 'model_response' && !foundResponse) {
          summary = extractNativeAssistantText(event.response.outputItems); foundResponse = true;
        } else if (event.type === 'model_request_started') startedAttempts.add(event.attempt);
        else if (event.type === 'model_request_failed') {
          if (details.modelFailure === undefined) { details.modelFailure = event.failure.category; details.diagnostic = event.failure; details.partial = event.partial; }
          // 在下一次持久化尝试前取消的已调度延迟不算
          // 已执行的重试；逆向重放已经见过后续启动记录。
          if (event.retryDelayMs !== undefined && startedAttempts.has(event.attempt + 1)) details.retries!++;
        } else if (event.type === 'run_started') { end = 0; break; }
      }
      if (end === 0) break;
      end = start;
    }
    let receipt: NativeExecutionReceipt | undefined;
    try {
      receipt = await readNativeExecutionReceipt(this.store.directory, result) ?? undefined;
      if (!receipt) {
        if (task === undefined) {
          const snapshots = await NativeTaskStore.readAllSnapshots({ rootDirectory: path.join(this.store.directory, 'native'),
            sessionId: result.identity.sessionId, conversationId: result.identity.conversationId });
          task = snapshots.find(item => sameRun(item.identity, result.identity)) ?? null;
        }
        // 较早的已完成运行没有耗时回执；按保守的已保存上限计费，不虚构零耗时。
        const savedOptions = ledger.getRun(result.identity.runId)?.configuration.sessionOptions;
        const savedTime = savedOptions && typeof savedOptions === 'object' && !Array.isArray(savedOptions) ? savedOptions.maxActiveMs : undefined;
        const savedCeiling = typeof savedTime === 'number' && Number.isSafeInteger(savedTime) && savedTime > 0 ? savedTime : DEFAULT_RUN_BUDGET.maxActiveMs;
        receipt = nativeExecutionReceipt(result, task, activeMs ?? savedCeiling, counts);
        const workflowQuality = await loadNativeWorkflowQuality({ dataDirectory: this.store.directory, identity: result.identity });
        if (workflowQuality) receipt.workflowQuality = workflowQuality;
        await saveNativeExecutionReceipt(this.store.directory, receipt);
      }
    } catch {
      // 回执元数据失败不能让已提交操作触发队列重放。
      receipt = undefined; this.options.onError?.(new Error('Native execution receipt metadata is unavailable; workflow verification must pause.'));
    }
    let delegationFailure: string | undefined;
    const storedRun = ledger.getRun(result.identity.runId);
    if (storedRun) {
      try { delegationFailure = nativeDelegationAuditFailure(await saveNativeDelegationAudit(this.store.directory, storedRun), result); }
      catch {
        if (nativeParallelReviewIntent(storedRun.input).mode === 'explicit_parallel_review' || storedRun.tools.some(tool => tool.call.name.startsWith('delegate_'))) {
          delegationFailure = '并行委派的宿主审计无法保存或确认，本轮完成状态未知；请核查保留的工具账本和子任务成果。';
        }
      }
    }
    const expectedQuality = storedRun?.configuration.nativeWorkflowQualityPolicy;
    const qualityRequired = expectedQuality !== undefined;
    const workflowQuality = receipt?.workflowQuality;
    const qualityFailure = qualityRequired && (!expectedQuality || typeof expectedQuality !== 'object' || Array.isArray(expectedQuality) ||
      workflowQuality?.status !== 'passed' || workflowQuality.automaticReview !== 'passed' ||
      !sameRun(workflowQuality.parentIdentity, result.identity) || workflowQuality.taskId !== receipt?.taskId ||
      workflowQuality.collaboration !== expectedQuality.collaboration || workflowQuality.validationMode !== expectedQuality.validationMode ||
      receipt?.workspace?.complete !== true || workflowQuality.workspaceFingerprint !== receipt.workspace.fingerprint ||
      workflowQuality.rounds.at(-1)?.deliveryDigest !== digest(summary))
      ? '独立质量核查尚未通过或回执无法确认，本轮不能作为已验收交付。' : undefined;
    return { success: result.status === 'completed' && result.committed && !delegationFailure && !qualityFailure,
      summary: delegationFailure ? `${delegationFailure}${summary ? `\n模型原回复（未通过宿主并行核验）：\n${summary}` : ''}` : summary,
      ...(receipt ? { nativeReceipt: receipt } : {}), ...(qualityFailure ? { error: qualityFailure } : {}), ...(delegationFailure ? { error: delegationFailure } : {}),
      ...(result.status !== 'completed' ? { error: nativeRunError(result.reason, details), interrupted: result.status === 'cancelled' } : {}) };
  }
  private approve(id: string, active: ActiveRun, request: ApprovalRequest, signal: AbortSignal, child?: NativeAgentChildInput): Promise<ApprovalDecision> {
    this.assertActive(id, active);
    const expectedIdentity = child && active.children?.get(child.identity.runId) === child ? child.identity : active.identity;
    if (!expectedIdentity || !sameRun(request.binding, expectedIdentity) || request.expiresAt <= Date.now() || active.approval) throw new Error('审批归属或有效期无效。');
    const questions = request.tool.name === 'ask_user' ? active.questions?.questions(request) : undefined;
    if (request.tool.name === 'ask_user' && !questions) throw new Error('提问归属无效。');
    const kind = questions ? 'question' as const : 'permission' as const;
    if (signal.aborted) return Promise.resolve({ binding: request.binding, expiresAt: request.expiresAt, decision: 'denied' });
    // 已结算子任务的恢复只复用经核查的原工作区；子任务内的写入、命令继续逐次遵循权限策略。
    const childRecovery = request.tool.name === 'recover_agent' && request.preconditions && typeof request.preconditions === 'object' &&
      !Array.isArray(request.preconditions) && ['review', 'implement'].includes(String(request.preconditions.recoveryMode));
    if (childRecovery || nativeAutoApproves(active.runtimeConfig.permissionMode, request.tool)) {
      return Promise.resolve({ binding: request.binding, expiresAt: request.expiresAt, decision: 'approved' });
    }
    return new Promise(resolve => {
      const publicId = randomUUID(); let settled = false;
      const settle = (decision: ApprovalDecision['decision']) => {
        if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', cancel);
        if (active.approval?.publicId === publicId) active.approval = undefined;
        this.projection.approval(id, undefined);
        resolve({ binding: request.binding, expiresAt: request.expiresAt, decision });
      };
      const cancel = () => settle('denied');
      const timer = setTimeout(() => settle('expired'), Math.max(0, request.expiresAt - Date.now()));
      active.approval = { publicId, kind, request: structuredClone(request), createdAt: new Date().toISOString(), settle };
      // 远程模式本身可能定义名为 "preconditions" 的参数。
      // 将任意 MCP 参数单独保存，使审批显示精确调用。
      const approvalInput = child ? { arguments: request.input, preconditions: request.preconditions,
        delegatedAgent: { title: child.title, cwd: child.cwd, taskId: child.taskId, runId: child.identity.runId } } : request.tool.name.startsWith('mcp_')
        ? { arguments: request.input, preconditions: request.preconditions }
        : { ...request.input, preconditions: request.preconditions };
      this.projection.approval(id, { requestId: publicId, toolName: request.tool.name, toolUseId: request.binding.toolCallId, input: approvalInput, kind,
        ...(child ? { nativeDelegation: { title: child.title, cwd: child.cwd, taskId: child.taskId, runId: child.identity.runId } } : {}),
        ...(request.tool.name === 'apply_change_set' && request.preconditions && typeof request.preconditions === 'object' && !Array.isArray(request.preconditions) && isNativeChangeSetPreview(request.preconditions.changeSet) ? { nativeChangeSet: request.preconditions.changeSet } : {}), ...(questions ? { questions } : {}), createdAt: new Date().toISOString() });
      signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) cancel();
    });
  }
  respond(id: string, requestId: string, decision: ChatDecision) {
    const active = this.active.get(id), approval = active?.approval;
    if (!active || !approval || approval.publicId !== requestId) throw new Error('审批已结束或不属于当前运行。');
    this.assertActive(id, active);
    if (approval.kind === 'question') {
      if (approval.request.expiresAt <= Date.now()) { approval.settle('expired'); throw new Error('提问已过期，请等待模型继续。'); }
      if (decision.message) throw new Error('请在回答框中填写内容。');
      if (decision.behavior === 'allow') active.questions!.answer(approval.request, decision.answers);
      approval.settle(decision.behavior === 'allow' ? 'approved' : 'denied');
      return;
    }
    if (decision.answers || decision.message) throw new Error('此审批只接受允许或拒绝，不能修改工具参数。');
    approval.settle(approval.request.expiresAt > Date.now() ? decision.behavior === 'allow' ? 'approved' : 'denied' : 'expired');
  }
  async prepareCommands(_id: string): Promise<never> { throw new Error('自研 agent Alpha 不支持 Claude 命令目录。'); }
  async updateConfig(id: string, config: EngineConfig) {
    const session = this.session(id), options = parseNativeConfig(config);
    if (this.has(id)) throw new Error('请停止运行后修改配置。');
    const current = parseNativeConfig(session.engineConfig);
    if (session.started && (options.connectionId !== current.connectionId || options.model !== current.model)) throw new Error('已有上下文绑定原服务、协议与模型。切换服务、协议或模型请新建会话。');
    // 结构化会话更新由其提供者负责持久化。IPC 报告保存成功前，
    // 先提交规范化配置。
    this.store.change(state => { state.sessions.find(item => item.id === id)!.engineConfig = { schemaVersion: config.schemaVersion, options }; });
  }
  interrupt(id: string) { const active = this.active.get(id); active?.abort.abort(); active?.approval?.settle('denied'); this.contextOperations.get(id)?.abort.abort(); this.taskReviews.get(id)?.abort.abort(); }
  stop(id: string) { this.interrupt(id); return this.whenReleased(id); }
  stopAndWait(id: string) { return this.stop(id); }
  interruptAndWait(id: string) { return this.stop(id); }
  async whenReleased(id: string) {
    const review = this.taskReviews.get(id); if (review) await review.promise.catch(() => {});
    await this.hydration.get(id)?.catch(() => {});
    const active = this.active.get(id) ?? this.contextOperations.get(id);
    if (!active) {
      for (const [ledger, owner] of this.taskLedgers) if (owner === id) await this.closeTaskStore(ledger);
      return;
    }
    await active.promise.catch(() => {});
    if ('taskCleanupOnly' in active && active.taskCleanupOnly && active.tasks) {
      await this.closeTaskStore(active.tasks.store);
      active.tasks = undefined; active.released = true; active.cleanupUnconfirmed = false;
      if (this.active.get(id) === active) this.active.delete(id);
      await this.hydrate(id);
    }
    if (!active.released) throw new Error('执行资源清理尚未确认，不能释放目录占用。');
  }
  async stopIdle(id: string) { if (this.has(id)) throw new Error('会话仍在执行或清理。'); }
  forget(id: string) { if (this.has(id) || this.recoveryRequired(id)) throw new Error('请先确认会话资源与恢复状态。'); this.projection.forget(id); this.recoveryViews.delete(id); this.contextViews.delete(id); this.autoCompactionBlocked.delete(id); this.skillContinuityBlocked.delete(id); this.taskViews.delete(id); this.taskErrors.delete(id); this.agentResultParents.delete(id); }
  private assertContextOperation(id: string, operation: ContextOperation) {
    if (this.contextOperations.get(id) !== operation || operation.abort.signal.aborted || this.maintenance || this.sessionMaintenance.has(id)) throw new Error('恢复或压缩操作已取消。');
  }
  private contextOperation(id: string, kind: ContextOperation['kind'], expectedHead: string, action: (operation: ContextOperation) => Promise<void>): Promise<void> {
    try { return this.startContextOperation(id, kind, expectedHead, action); }
    catch (error) { return Promise.reject(error); }
  }
  private startContextOperation(id: string, kind: ContextOperation['kind'], expectedHead: string, action: (operation: ContextOperation) => Promise<void>): Promise<void> {
    const session = this.session(id);
    const previous = this.contextOperations.get(id);
    if (previous) return previous.kind === kind && previous.expectedHead === expectedHead ? previous.promise : Promise.reject(new Error('会话正在恢复或压缩上下文。'));
    if (this.has(id) || this.maintenance || this.sessionMaintenance.has(id) || session.archived) return Promise.reject(new Error('请先停止运行、退出维护并取消归档，再操作上下文。'));
    if (kind !== 'confirm' && !/^[a-f0-9]{64}$/.test(expectedHead)) return Promise.reject(new Error('记录版本无效，请刷新后重试。'));
    const config = this.runtimeConfig(session.engineConfig);
    let resolve!: () => void, reject!: (error: unknown) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const operation: ContextOperation = { kind, expectedHead, connectionId: config.connectionId, runtimeConfig: config, abort: new AbortController(), promise, cleanupUnconfirmed: false, released: false };
    this.contextOperations.set(id, operation);
    void (async () => {
      let failure: unknown;
      try {
        await this.hydration.get(id);
        this.assertContextOperation(id, operation);
        operation.store = await NativeRunStore.open({ rootDirectory: path.join(this.store.directory, 'native', 'conversations'), conversationId: session.execution.conversationId! });
        this.assertContextOperation(id, operation);
        await this.refreshProjection(id, operation.store);
        this.assertContextOperation(id, operation);
        if (kind !== 'confirm' && this.projection.hasMissingContext(id)) throw new Error(MISSING_NATIVE_CONTEXT_MESSAGE);
        this.changed(id, kind === 'compact' ? 'thinking' : 'starting');
        await action(operation);
      } catch (error) {
        failure = error;
        if (error && typeof error === 'object' && 'cleanupUnconfirmed' in error && error.cleanupUnconfirmed) operation.cleanupUnconfirmed = true;
      } finally {
        try { if (operation.store) await operation.store.close(); operation.store = undefined; }
        catch { operation.cleanupUnconfirmed = true; }
        if (!operation.cleanupUnconfirmed) {
          operation.released = true;
          if (this.contextOperations.get(id) === operation) this.contextOperations.delete(id);
          // 追加错误结果不明确时重新打开；只有持久化账本能决定
          // 恢复或压缩是否已提交，不能根据被拒绝的 Promise 判断。
          try { await this.hydrate(id); }
          catch { this.recovery.add(id); failure ??= new Error('原始记录无法核验，请检查磁盘；会话保持只读。'); }
        } else {
          this.recovery.add(id); this.acknowledged.delete(id);
          failure = new Error('进程或记录的清理尚未确认，目录继续保持占用。请先解决清理失败。');
        }
        try { this.changed(id, failure ? operation.abort.signal.aborted ? 'interrupted' : 'error' : 'interrupted', this.recovery.has(id) ? this.recoveryMessage(id) : failure ? operation.abort.signal.aborted ? '恢复或压缩已取消，已提交记录保持不变。' : this.safeError(failure) : undefined); }
        catch { failure ??= new Error('会话状态保存失败，请检查磁盘。'); }
      }
      if (failure) throw new Error(this.safeError(failure));
    })().then(resolve, reject);
    return promise;
  }
  resumeRecovery(id: string, expectedHead: string): Promise<void> {
    return this.contextOperation(id, 'resume', expectedHead, async operation => {
      const ledger = operation.store!;
      const previous = ledger.listRuns().find(run => run.recoveryResolution?.expectedHash === expectedHead);
      if (previous) return; // 重试确认绝不会创建另一次运行。
      const report = ledger.getRecoveryReport();
      if (!report || report.expectedHash !== expectedHead) throw new Error('恢复记录已改变，请刷新后重新核查。');
      if (report.classification !== 'safe_to_continue') throw new Error('存在结果未知的操作或不完整协议，此会话只读，请核查后新建会话。');
      this.assertContextOperation(id, operation);
      await ledger.resolveRecovery({ runId: report.runId, expectedHash: expectedHead, resourcesVerified: true });
      this.recovery.delete(id); this.acknowledged.delete(id);
      await this.refreshProjection(id, ledger);
    });
  }
  compactContext(id: string, expectedHead: string): Promise<void> {
    return this.contextOperation(id, 'compact', expectedHead, async operation => {
      let ledger = operation.store!;
      const previousCompaction = ledger.getLastCompaction();
      if (previousCompaction?.expectedHash === expectedHead) return;
      // 手动摘要诊断推进日志头后，提交计划绑定的是诊断后的头。
      // 重试原用户授权的头时只接受紧邻已提交摘要的真实成功诊断，绝不再次付费。
      const priorDiagnostic = previousCompaction ? ledger.replay(Math.max(0, previousCompaction.seq - 2), 1)[0] : undefined;
      if (previousCompaction && priorDiagnostic?.hash === previousCompaction.expectedHash && priorDiagnostic.event.type === 'model_request_diagnostic' &&
          priorDiagnostic.event.diagnostic.purpose === 'summary_manual' && priorDiagnostic.event.diagnostic.phase === 'finished' &&
          priorDiagnostic.event.diagnostic.outcome === 'completed' && priorDiagnostic.event.diagnostic.identity.requestId === `compact:${expectedHead}`) return;
      if (!this.options.skills && ledger.listRuns().some(run => run.configuration.nativeSkillCatalog !== undefined || run.configuration.nativeSkills !== undefined)) throw new Error('当前执行器尚未启用新版技能连续性，不能压缩此会话；原始上下文保持不变。');
      if (ledger.recoveryRequired || this.recovery.has(id)) throw new Error('请先核查恢复状态，再压缩上下文。');
      const source = ledger.getCompactionSource();
      if (source.expectedHash !== expectedHead) throw new Error('上下文已改变，请刷新后重新压缩。');
      const requestedConfig = operation.runtimeConfig;
      const connection = this.connections.resolve(requestedConfig.connectionId, requestedConfig.model || undefined);
      const capabilitySnapshot = await this.options.modelCapabilities?.resolve(connection, { timeoutMs: 3000 });
      this.assertContextOperation(id, operation);
      if (this.connections.resolve(requestedConfig.connectionId, requestedConfig.model || undefined).revision !== connection.revision) throw new Error('模型连接已更新，请重新压缩。');
      const modelCapabilities = capabilitySnapshot?.connectionId === connection.connectionId && capabilitySnapshot.revision === connection.revision
        ? nativeModelCapabilityUsage(capabilitySnapshot, connection.model) : undefined;
      const config = nativeModelBudget(requestedConfig, modelCapabilities?.capabilities);
      const previous = ledger.listRuns().at(-1)?.configuration;
      if (previous && (previous.connectionId !== connection.connectionId || previous.model !== connection.model || previous.baseURL !== connection.baseURL || (previous.protocol ?? 'responses') !== connection.protocol)) throw new Error('已有上下文绑定原服务、协议与模型。切换服务、协议或模型请新建会话。');
      const model = { protocol: connection.protocol, authHeader: connection.authHeader, baseURL: connection.baseURL, model: connection.model, apiKey: connection.apiKey, allowLoopbackHttp: connection.allowLoopbackHttp };
      const historicalSkills = await this.options.skills?.prepareConversationContinuity(id, ledger, source.retainedContext, operation.abort.signal, [connection.apiKey]);
      this.assertContextOperation(id, operation);
      const replacement = (summary: string) => ({ ...source.retainedContext, items: [
        ...source.retainedContext.items.slice(0, source.retainedPrefixItems), contextSummaryItem(summary, source.retainedContext.protocol),
        ...(historicalSkills ? conversationSkillContinuityItems(historicalSkills, source.retainedContext.protocol) : []),
        ...source.retainedContext.items.slice(source.retainedPrefixItems),
      ] });
      const estimator = createNativeModel(model);
      const withinBudget = (context: ReturnType<typeof replacement>) => contextBudgetUsage(context,
        estimator.estimateInputUsage?.(context, config.maxOutputTokens) ?? estimator.estimateInputTokens(context),
        { maxInputTokens: config.maxInputTokens, maxContextBytes: DEFAULT_RUN_BUDGET.maxContextBytes }).status !== 'exceeded';
      // 手动维护没有当前任务或工具目录。此处检查保留的
      // 上下文本身；发送时连同规则重新检查完整请求。
      if (historicalSkills && Buffer.byteLength(JSON.stringify(replacement('_'))) >= source.beforeBytes) {
        throw new Error('完整技能历史与必须保留的上下文已无法缩小，未请求摘要；请调整预算或新建会话。');
      }
      if (!withinBudget(replacement('摘要'))) {
        throw new Error('必须保留的上下文已超过运行预算，未调用摘要模型；含图会话仅可压缩首张图片所在轮次之前的纯文本，请提高预算或新建会话。');
      }
      await ledger.close(); operation.store = undefined;
      ledger = await NativeRunStore.open({ rootDirectory: path.join(this.store.directory, 'native', 'conversations'), conversationId: this.session(id).execution.conversationId!, forbiddenValues: [connection.apiKey] });
      operation.store = ledger;
      this.assertContextOperation(id, operation);
      if (ledger.getCompactionSource().expectedHash !== expectedHead) throw new Error('上下文已改变，请刷新后重新压缩。');
      const identity: RunIdentity = { sessionId: id, conversationId: ledger.conversationId, runId: randomUUID(), requestId: `compact:${expectedHead}`, workerGeneration: Math.max(0, ...ledger.listRuns().map(run => run.identity.workerGeneration)) + 1 };
      operation.identity = identity;
      const maxActiveMs = 60_000;
      const preparedSkills = await this.options.skills?.prepareConversationContinuity(id, ledger, source.retainedContext, operation.abort.signal, [connection.apiKey]);
      if (canonicalJson(json(preparedSkills ?? null)) !== canonicalJson(json(historicalSkills ?? null))) throw new Error('技能历史在压缩前发生变化，未请求摘要。');
      this.assertContextOperation(id, operation);
      const result = await summarizeNativeContext({ identity, context: source.context,
        model,
        maxInputTokens: config.maxInputTokens, maxOutputTokens: config.maxOutputTokens, maxActiveMs,
        signal: operation.abort.signal, worker: this.options.worker, diagnosticPurpose: 'summary_manual', forbiddenValues: [connection.apiKey],
        onDiagnostic: async diagnostic => { await ledger.recordModelDiagnostic(diagnostic); } });
      this.assertContextOperation(id, operation);
      // 诊断元数据推进日志头，须重新核对原始历史不变，再用新头提交摘要。
      const latestSource = ledger.getCompactionSource();
      if (canonicalJson(json(latestSource.context)) !== canonicalJson(json(source.context)) ||
          canonicalJson(json(latestSource.retainedContext)) !== canonicalJson(json(source.retainedContext))) throw new Error('摘要期间上下文已变化，未替换原始历史。');
      const latestSkills = await this.options.skills?.prepareConversationContinuity(id, ledger, latestSource.retainedContext, operation.abort.signal, [connection.apiKey]);
      if (canonicalJson(json(latestSkills ?? null)) !== canonicalJson(json(historicalSkills ?? null))) throw new Error('技能历史在摘要期间发生变化，未替换原始上下文。');
      this.assertContextOperation(id, operation);
      if (!withinBudget(replacement(result.summary))) throw new Error('完整历史技能与摘要超过运行预算，未替换原始上下文。');
      const plan = ledger.planContextCompaction({ summary: result.summary, expectedHash: latestSource.expectedHash, usage: result.usage,
        ...(historicalSkills ? { nativeSkills: historicalSkills } : {}) });
      await ledger.commitContextCompaction(plan);
      await this.refreshProjection(id, ledger);
    });
  }
  private recoveryMarker(id: string) { return path.join(this.store.directory, 'native', 'recovery-confirmations', this.session(id).execution.conversationId! + '.json'); }
  confirmRecovery(id: string): Promise<void> {
    return this.contextOperation(id, 'confirm', '', async operation => {
    if (!this.recoveryRequired(id)) throw new Error('没有待确认的恢复记录。');
    const ledger = operation.store!;
      if (!ledger.recoveryRequired && !this.projection.hasMissingContext(id) && !await this.refreshChildRecovery(id, ledger)) throw new Error('恢复记录尚不完整，不能解除隔离。');
      const latest = ledger.replay(Math.max(0, ledger.usage.records - 1), 1)[0];
      const file = this.recoveryMarker(id), temporary = file + '.' + randomUUID() + '.tmp';
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      try {
        const handle = await fs.open(temporary, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify({ schemaVersion: 1, conversationId: ledger.conversationId, hash: latest.hash, confirmedAt: new Date().toISOString() })); await handle.sync(); }
        finally { await handle.close(); }
        this.assertContextOperation(id, operation);
        await fs.rename(temporary, file);
        if (process.platform !== 'win32') { const directory = await fs.open(path.dirname(file), 'r'); try { await directory.sync(); } finally { await directory.close(); } }
      } finally { await fs.rm(temporary, { force: true }); }
      this.acknowledged.add(id);
      this.changed(id, 'error', RECOVERY_ACK);
    });
  }
  async exports(id: string) { await this.hydrate(id); const source = this.projection.exportPath(id); return [{ label: '自研 agent 对话记录（显示内容）', extension: 'jsonl' as const, write: async (destination: string) => { await fs.copyFile(source, destination); await fs.chmod(destination, 0o600); } }]; }
  setMaintenance(value: boolean) { this.maintenance = value; }
  setSessionMaintenance(ids: readonly string[], value: boolean) { for (const id of ids) value ? this.sessionMaintenance.add(id) : this.sessionMaintenance.delete(id); }
  async disconnectSessions(ids: readonly string[]) { await Promise.all(ids.map(id => this.stopAndWait(id))); }
  disconnectAll() { return this.disconnectSessions([...this.active.keys(), ...this.contextOperations.keys(), ...this.taskReviews.keys(), ...this.taskLeaseFailures]); }
  async shutdown() {
    this.maintenance = true;
    this.hydrationClosed = true;
    // 即使空闲历史刷新在打开或重建账本时也持有写入器。
    // 应用退出前，等待打开、投影及关闭全过程完成。
    const results = await Promise.allSettled([this.disconnectAll(), ...this.hydration.values()]);
    const errors: unknown[] = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    // 关闭失败时仍保留所有权，以便后续退出尝试重试实际
    // 释放，而非把已拒绝的水合过程视为清理完成。
    const releases = await Promise.allSettled([...this.hydrationLedgers].map(async ledger => {
      await ledger.close(); this.hydrationLedgers.delete(ledger);
    }));
    for (const result of releases) if (result.status === 'rejected') errors.push(result.reason);
    const taskReleases = await Promise.allSettled([...this.taskLedgers.keys()].map(ledger => this.closeTaskStore(ledger)));
    for (const result of taskReleases) if (result.status === 'rejected') errors.push(result.reason);
    try { await this.supervisor.dispose(); } catch (error) { errors.push(error); }
    try { this.projection.flush(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, '自研 Agent 记录或执行资源尚未完全释放，请检查磁盘并重试退出。');
  }
}
