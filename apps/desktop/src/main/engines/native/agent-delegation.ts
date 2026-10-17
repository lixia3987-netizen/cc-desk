import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { canonicalJson, type ApprovalDecision, type JsonObject, type PreparedTool, type RunIdentity, type RunStatus, type ToolDefinition, type ToolExecutionContext, type ToolPort, type ToolResult } from '@cc-desk/agent-core';
import { assertNoModelCredential } from '@cc-desk/agent-node/responses-model';
import { collectAgentWorkspaceEvidence, createAgentWorktree, materializeAgentBaseline, NativeAgentWorktreeError, prepareAgentBaseline, verifyAgentBaseline,
  verifyAgentWorkspace, type NativeAgentBaseline, type NativeAgentWorktree } from './agent-worktrees';
import { writeAgentArtifact, writeAgentReceipt } from './agent-artifacts';
import type { NativeActivePauseSource } from './active-pause';
import { nativeDelegationExecutionPath, type NativeDelegationExecution } from './agent-delegation-audit';
import { normalizeNativeSkillInheritanceManifest, type NativeSkillInheritanceManifest } from './skill-inheritance';
import { createNativeAgentTaskPool, NativeAgentTaskPoolClosedError, type NativeAgentTaskPool, type NativeAgentTaskSlot } from './agent-task-pool';

export interface NativeDelegationBudget {
  /** 单个子任务自己的原子门控；父任务和同级子任务不消耗这份预算。 */
  consume(kind: 'model' | 'tool', identity: RunIdentity): Promise<boolean>;
  remainingMs(): number;
  activePause?: NativeActivePauseSource;
  pause?(): () => void;
  snapshot(): { modelRequests: number; toolCalls: number };
}
export interface NativeAgentChildInput {
  identity: RunIdentity;
  /** 由实际宿主回执分配，绝不从标题或模型输出推断。 */
  childId?: string;
  taskId: string;
  parentIdentity: RunIdentity;
  parentTaskId: string;
  title: string;
  goal: string;
  cwd: string;
  /** 这些限制必须由宿主强制执行，不能仅依赖提示词。 */
  toolPolicy: 'read_only' | 'workspace_write' | 'workspace_verify';
  /** 仅由完成前质量宿主创建；通用委派工具不能提供此绑定。 */
  quality?: import('./workflow-quality-report').NativeQualityChildBinding;
  signal: AbortSignal;
  budget: NativeDelegationBudget;
  /** Exact parent Skill evidence; child bindings remain tied to its own cwd. */
  nativeSkills?: NativeSkillInheritanceManifest;
  recovery?: { previousChildId: string; previousRunId: string; summary: string; reason: string; receiptPath: string; patchPath?: string };
}
export interface NativeAgentChildResult {
  identity: RunIdentity;
  taskId: string;
  status: RunStatus;
  reason: string;
  committed: boolean;
  summary: string;
  modelRequests: number;
  toolCalls: number;
  evidence?: {
    taskSnapshotPath?: string;
    runJournalPath?: string;
    commandReceipts?: Array<{ toolCallId: string; status: string; exitCode: number | null; receiptPath: string }>;
  };
  qualityReport?: import('@cc-desk/contracts/native-workflow-quality').NativeQualityReport;
}
export interface NativeDelegationReceipt {
  version: 1;
  batchId: string;
  childId: string;
  taskId: string;
  identity: RunIdentity;
  parentIdentity: RunIdentity;
  parentTaskId: string;
  toolCallId: string;
  title: string;
  goal: string;
  mode: 'review' | 'implement';
  status: 'queued' | 'prepared' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown';
  /** 稳定的批内入队次序；后续状态保留，绝不从模型输出推断。 */
  queueIndex?: number;
  createdAt: string;
  updatedAt: string;
  receiptPath: string;
  cwd: string;
  workspace?: NativeAgentWorktree;
  workspaceVerified?: boolean;
  recovery?: { previousChildId: string; previousRunId: string; attempt: number; workspaceOwnerChildId?: string };
  artifact?: { patchPath: string; changedFiles: Array<{ path: string; status: string }>; head: string; baseCommit: string; sha256?: string; bytes?: number };
  result?: NativeAgentChildResult;
  nativeSkills?: NativeSkillInheritanceManifest;
  /** 此处只保留稳定的宿主错误码，绝不复制供应商或子进程错误。 */
  error?: string;
}
export interface NativeAgentDelegationOptions {
  identity: RunIdentity;
  parentTaskId: string;
  cwd: string;
  policy: 'read_only' | 'workspace_write';
  signal: AbortSignal;
  forbiddenValues: readonly string[];
  storeDirectory: string;
  worktreeRoot: string;
  maxSubagents?: number;
  /** 同一父运行的委派及质量角色共享；不提供时创建本工具自己的池。 */
  taskPool?: NativeAgentTaskPool;
  createChildBudget(identity: RunIdentity): NativeDelegationBudget;
  assertOwnership(): Promise<void>;
  /** 必须创建独立的上下文和工作进程；子任务宿主不得注册委派能力。 */
  runChild(input: NativeAgentChildInput): Promise<NativeAgentChildResult>;
  record?(receipt: NativeDelegationReceipt): Promise<void>;
  /** 标准自动写入策略可以关闭对话框，但不能取消宿主限制。 */
  requiresApproval?: boolean;
  skills?: NativeAgentSkillInheritanceHooks;
}
export interface NativeAgentSkillInheritanceHooks {
  freeze(signal: AbortSignal): Promise<NativeSkillInheritanceManifest>;
  assertCurrent(manifest: NativeSkillInheritanceManifest, signal: AbortSignal, recovery: boolean): Promise<void>;
  preflightChild(manifest: NativeSkillInheritanceManifest,
    input: Pick<NativeAgentChildInput, 'identity' | 'childId' | 'parentIdentity' | 'cwd' | 'toolPolicy' | 'signal' | 'recovery'>): Promise<void>;
}
export interface NativeAgentDelegationTools extends ToolPort { closeAll(): Promise<void> }

const taskSchema = z.object({ title: z.string().trim().min(1).max(200), goal: z.string().trim().min(1).max(6000) }).strict();
const reviewSchema = z.object({ tasks: z.array(taskSchema).min(1).max(30) }).strict();
const implementSchema = z.object({ tasks: z.array(taskSchema).min(1).max(30), baseline: z.enum(['snapshot', 'head']) }).strict();
const tasksJson: JsonObject = { type: 'array', minItems: 1, maxItems: 30, items: { type: 'object', additionalProperties: false, required: ['title', 'goal'], properties: {
  title: { type: 'string', minLength: 1, maxLength: 200 }, goal: { type: 'string', minLength: 1, maxLength: 6000 },
} } };
const recoverySchema = z.object({ childId: z.string().uuid(), goal: z.string().trim().min(1).max(6000).optional() }).strict();
const toolDefinitions: ToolDefinition[] = [{
  name: 'delegate_review', risk: 'read',
  description: 'Run independent Native agents concurrently to review the current workspace. For an explicit user request for parallel analysis, use one call with independently answerable questions up to the configured maximum; a textual plan or sequential single-child calls do not satisfy it. Each child starts with its own goal/context and a separate worker; it can only read local files and cannot run commands, write files, use MCP/external tools or spawn agents. Every child has an independent request/tool/time budget; the parent has no such limits. Put Materials, Version/content, Independent question, Scope, Existing evidence, Permissions and Return format sections inside each bounded goal (maximum 6000 characters), including paths/source references and known/unknown evidence. Do not add unsupported tool fields. Read actual returned children using read_agent_result; completed execution is not acceptance.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['tasks'], properties: { tasks: tasksJson } },
}, {
  name: 'delegate_implement', risk: 'write',
  description: 'Run independent Native implementation agents concurrently, each in its own retained Git linked worktree and codex branch. Explicitly choose baseline snapshot (include current tracked and non-ignored new changes) or head (allowed only when the parent workspace is clean). The parent index, branch and files are preserved. Siblings share the same baseline and each has an independent request/tool/time budget. Children cannot spawn more agents. Results provide worktree paths, patches, task/run and command receipts for review; no branch is merged automatically. Assign separate bounded tasks and review each diff before integrating.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['tasks', 'baseline'], properties: { tasks: tasksJson, baseline: { type: 'string', enum: ['snapshot', 'head'] } } },
}, {
  name: 'recover_agent', risk: 'write',
  description: 'Recover one failed or cancelled child from this parent run after inspecting its saved result. Start a fresh child context, identity and budget in the same retained workspace, preserving previous changes and evidence. Supply an optional bounded continuation goal. Never replay previous journals, commands or other effects. Recovery is blocked until previous execution, cleanup and workspace ownership are confirmed; an unknown result is never presumed safe. No automatic merge. Capacity only counts active children.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['childId'], properties: { childId: { type: 'string', format: 'uuid' }, goal: { type: 'string', minLength: 1, maxLength: 6000 } } },
}];
const encode = (value: unknown) => canonicalJson(JSON.parse(JSON.stringify(value)));
const hash = (value: unknown) => createHash('sha256').update(encode(value)).digest('hex');
interface CallState { prepared: PreparedTool; maxOutputBytes: number; baseline?: NativeAgentBaseline; nativeSkills?: NativeSkillInheritanceManifest; recovery?: { receipt: NativeDelegationReceipt; workspaceSha256?: string; workspaceHead?: string }; execution?: Promise<ToolResult>; effectsStarted?: boolean }
const knownChildNotStarted = (error: unknown): boolean => Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'child_start_preconditions_failed'
  && 'childNotStarted' in error && error.childNotStarted === true && !('cleanupUnconfirmed' in error && error.cleanupUnconfirmed === true));
class NativeAgentReceiptPersistenceError extends Error {}
class NativeAgentExecutionPersistenceError extends Error {}

/** 一个批次对应父任务的一次工具调用，因此即使核心循环串行，同级任务仍可并行。 */
export function createAgentDelegationTools(options: NativeAgentDelegationOptions): NativeAgentDelegationTools {
  const maxSubagents = z.number().int().min(1).max(30).parse(options.maxSubagents ?? 4);
  const taskPool = options.taskPool ?? createNativeAgentTaskPool({ capacity: maxSubagents, signal: options.signal });
  if (taskPool.capacity !== maxSubagents) throw new Error('子任务池与本轮有效并发容量不一致。');
  const definitions = structuredClone(options.policy === 'read_only' ? [toolDefinitions[0], { ...toolDefinitions[2], risk: 'read' as const }] : toolDefinitions);
  for (const definition of definitions) {
    definition.description += ` Maximum active children: ${maxSubagents}; submit up to 30 independent tasks in one batch. Excess tasks queue in FIFO order and start automatically when a sibling fully settles. Child failures are reported individually; inspect then recover_agent when safe. Unknown execution or cleanup stops queued launches.`;
  }
  const states = new Map<string, CallState>(), operations = new Set<Promise<ToolResult>>(), children = new Set<AbortController>();
  const parentIdentity = structuredClone(options.identity), identityKey = encode(parentIdentity), lifecycle = new AbortController();
  const retained = new Map<string, NativeDelegationReceipt>(), settled = new Set<string>(), recovered = new Set<string>(), recovering = new Set<string>();
  let closing = false, unsafe = false, reserved = 0;
  const cancel = () => { lifecycle.abort('cancelled'); taskPool.close('cancelled'); for (const child of children) child.abort(); };
  const halt = () => { unsafe = true; taskPool.close('unsafe'); lifecycle.abort('unsafe'); for (const child of children) child.abort(); };
  const poolStopped = () => taskPool.signal.reason instanceof NativeAgentTaskPoolClosedError && taskPool.signal.reason.reason === 'unsafe' ? halt() : cancel();
  taskPool.signal.addEventListener('abort', poolStopped, { once: true });
  if (taskPool.signal.aborted) poolStopped();
  options.signal.addEventListener('abort', cancel);
  const credentials = (value: unknown) => assertNoModelCredential(value, options.forbiddenValues);
  const current = (context: ToolExecutionContext) => {
    if (closing || unsafe || taskPool.signal.aborted || options.signal.aborted || context.signal.aborted || encode(context.identity) !== identityKey) throw new Error('委派不属于当前运行。');
  };
  const guard = async (context: ToolExecutionContext) => { current(context); await options.assertOwnership(); current(context); };
  const inheritance = (manifest: NativeSkillInheritanceManifest): NativeSkillInheritanceManifest => {
    const captured = normalizeNativeSkillInheritanceManifest(manifest);
    credentials(captured);
    if (encode(captured.context.parentManifest.identity) !== identityKey) throw new Error('技能继承清单不属于当前父任务。');
    return captured;
  };
  const assertSkillsCurrent = async (state: Pick<CallState, 'nativeSkills' | 'recovery'>, context: ToolExecutionContext) => {
    if (!state.nativeSkills) return;
    if (!options.skills) throw new Error('技能继承运行时尚未就绪。');
    await options.skills.assertCurrent(structuredClone(state.nativeSkills), context.signal, Boolean(state.recovery));
    await guard(context);
  };
  const stateFor = (prepared: PreparedTool, context: ToolExecutionContext) => {
    current(context);
    const state = states.get(prepared.call.id);
    if (!state || state.maxOutputBytes !== context.maxOutputBytes || prepared.policyRevision !== context.policyRevision || encode(state.prepared) !== encode(prepared)) throw new Error('委派参数或策略已改变。');
    return state;
  };
  const save = async (receipt: NativeDelegationReceipt) => {
    credentials(receipt);
    receipt.updatedAt = new Date().toISOString();
    try {
      await writeAgentReceipt(receipt.receiptPath, receipt);
      await options.record?.(structuredClone(receipt));
    } catch { halt(); throw new NativeAgentReceiptPersistenceError(); }
    retained.set(receipt.childId, structuredClone(receipt));
  };
  const operationCancelled = (context: ToolExecutionContext) => closing || options.signal.aborted || context.signal.aborted;
  const safelySettled = (receipt: NativeDelegationReceipt) => settled.has(receipt.childId) &&
    ['failed', 'cancelled'].includes(receipt.status) && receipt.result?.committed === true && receipt.result.status !== 'recovery_required' &&
    (!receipt.workspace || receipt.workspaceVerified === true && !!receipt.artifact);
  const canRecover = (receipt: NativeDelegationReceipt) => safelySettled(receipt) && !recovered.has(receipt.childId);
  const verifyRecovery = async (recovery: NonNullable<CallState['recovery']>, admitted = false) => {
    const receipt = retained.get(recovery.receipt.childId);
    if (!receipt || !safelySettled(receipt) || !admitted && recovered.has(receipt.childId) || encode(receipt) !== encode(recovery.receipt)) throw new Error('子 Agent 恢复前提已改变。');
    if (receipt.workspace) {
      await verifyAgentWorkspace(receipt.workspace, options.worktreeRoot);
      const evidence = await collectAgentWorkspaceEvidence(receipt.workspace, options.worktreeRoot);
      if (evidence.head !== recovery.workspaceHead || createHash('sha256').update(evidence.patch).digest('hex') !== recovery.workspaceSha256) throw new Error('子 Agent 工作区在恢复审批后已改变。');
    }
  };
  const resultOutput = (receipts: NativeDelegationReceipt[], context: ToolExecutionContext): ToolResult => {
    // 子任务失败是可供父模型处理的结果，不是父工具的执行失败；只有父任务取消才传播取消。
    const status: ToolResult['status'] = operationCancelled(context) ? 'cancelled' : 'completed';
    const output = { parentRunId: parentIdentity.runId, children: receipts.map(r => ({ childId: r.childId, taskId: r.taskId, runId: r.identity.runId, title: r.title, status: r.status,
      receiptPath: r.receiptPath, cwd: r.cwd, recoverable: canRecover(r), ...(r.recovery ? { recovery: r.recovery } : {}), ...(r.workspace ? { workspace: r.workspace, workspaceVerified: r.workspaceVerified } : {}),
      ...(r.artifact ? { artifact: r.artifact } : {}), ...(r.error ? { error: r.error } : {}),
      ...(r.result ? { summary: r.result.summary, reason: r.result.reason, modelRequests: r.result.modelRequests, toolCalls: r.result.toolCalls, evidence: r.result.evidence } : {}) })),
      limits: { maxSubagents, scope: 'each_child' }, integration: 'Use read_agent_result with parentRunId and childId to review the retained patch and evidence. Integrate reviewed changes using normally approved tools; do not assume the child branch contains uncommitted changes. Execution completion does not prove acceptance.' };
    credentials(output);
    if (Buffer.byteLength(encode(output)) <= context.maxOutputBytes) return { status, output: JSON.parse(JSON.stringify(output)) };
    // 完整摘要和证据仍会持久化；截断仅用于向模型展示。
    const references = { parentRunId: parentIdentity.runId, children: receipts.map(r => ({ childId: r.childId, taskId: r.taskId, runId: r.identity.runId,
      status: r.status, receiptPath: r.receiptPath })), limits: { maxSubagents, scope: 'each_child' }, details: 'Use read_agent_result with parentRunId and childId to read saved results and page through retained patches.' };
    if (Buffer.byteLength(encode(references)) <= context.maxOutputBytes) return { status, truncated: true, output: references };
    const batchReference = { parentRunId: parentIdentity.runId, batchId: receipts[0].batchId, receiptDirectory: path.dirname(path.dirname(receipts[0].receiptPath)),
      children: receipts.map(r => ({ childId: r.childId, status: r.status })), details: 'Use read_agent_result with parentRunId and childId to read saved results and patches.' };
    return { status, truncated: true, output: Buffer.byteLength(encode(batchReference)) <= context.maxOutputBytes ? batchReference : {
      parentRunId: parentIdentity.runId, batchId: receipts[0].batchId, children: receipts.map(r => ({ childId: r.childId })), details: 'Use read_agent_result with parentRunId and childId to inspect every saved status and result.' } };
  };
  const instant = () => ({ monotonicMs: performance.now(), wallTime: new Date().toISOString() });
  type Instant = ReturnType<typeof instant>;
  type SlotClaim = Promise<{ slot: NativeAgentTaskSlot; admitted: Instant; error?: never } | { error: unknown; slot?: never; admitted?: never }>;
  const executeReservedBatch = async (state: CallState, context: ToolExecutionContext, claims: SlotClaim[], queued: Instant[], releaseAdmission: () => void): Promise<ToolResult> => {
    const operationSignal = AbortSignal.any([lifecycle.signal, taskPool.signal, options.signal, context.signal]);
    const recovery = state.recovery;
    const input = recovery ? { tasks: [{ title: recovery.receipt.title, goal: recoverySchema.parse(state.prepared.input).goal ?? recovery.receipt.goal }] } :
      state.prepared.call.name === 'delegate_review' ? reviewSchema.parse(state.prepared.input) : implementSchema.parse(state.prepared.input);
    await guard(context);
    await assertSkillsCurrent(state, context);
    const mode = recovery?.receipt.mode ?? (state.prepared.call.name === 'delegate_review' ? 'review' : 'implement');
    if (recovery) await verifyRecovery(recovery);
    if (state.baseline) await verifyAgentBaseline(state.baseline, operationSignal);
    const batchId = randomUUID(), batchPath = path.join(options.storeDirectory, 'delegations', parentIdentity.conversationId, parentIdentity.runId, batchId);
    const receipts: NativeDelegationReceipt[] = input.tasks.map((task, queueIndex) => {
      const childId = randomUUID(), now = new Date().toISOString();
      return { version: 1, batchId, childId, taskId: randomUUID(), identity: { sessionId: randomUUID(), conversationId: randomUUID(), runId: randomUUID(), requestId: randomUUID(), workerGeneration: 1 },
        parentIdentity: structuredClone(parentIdentity), parentTaskId: options.parentTaskId, toolCallId: state.prepared.call.id, ...task,
        mode, status: 'queued', queueIndex, createdAt: now, updatedAt: now, receiptPath: path.join(batchPath, childId, 'receipt.json'), cwd: recovery?.receipt.cwd ?? options.cwd,
        ...(state.nativeSkills ? { nativeSkills: structuredClone(state.nativeSkills) } : {}),
        ...(recovery ? { recovery: { previousChildId: recovery.receipt.childId, previousRunId: recovery.receipt.identity.runId, attempt: (recovery.receipt.recovery?.attempt ?? 0) + 1,
          ...(recovery.receipt.workspace ? { workspaceOwnerChildId: recovery.receipt.recovery?.workspaceOwnerChildId ?? recovery.receipt.childId } : {}) },
          } : {}) };
    });
    const execution: NativeDelegationExecution = { version: 1, batchId, parentRunId: parentIdentity.runId, toolCallId: state.prepared.call.id, mode, capacity: maxSubagents,
      clock: { id: randomUUID(), timeOrigin: performance.timeOrigin }, children: receipts.map((receipt, index) => ({ childId: receipt.childId, identity: structuredClone(receipt.identity),
        queued: queued[index] })) };
    let executionWrites = Promise.resolve();
    const saveExecution = () => {
      const snapshot = structuredClone(execution);
      const write = executionWrites.then(() => writeAgentReceipt(nativeDelegationExecutionPath(options.storeDirectory, parentIdentity, batchId), snapshot))
        .catch(() => { halt(); throw new NativeAgentExecutionPersistenceError(); });
      executionWrites = write.catch(() => {}); return write;
    };
    // 任何工作树或子模型操作前先持久化执行意图；完全相同的重复调用复用已有执行。
    state.effectsStarted = true;
    if (recovery) recovered.add(recovery.receipt.childId);
    try { for (const receipt of receipts) await save(receipt); await saveExecution(); }
    catch { halt(); return { status: 'unknown', output: { error: 'delegation_intent_unconfirmed', batchId } }; }
    let baselineCommit: Promise<string> | undefined;
    await Promise.allSettled(receipts.map(async (receipt, index) => {
      const abort = new AbortController(); children.add(abort);
      const signal = AbortSignal.any([abort.signal, operationSignal]);
      let childStarted = false, worktreeAttempted = false, skillPreflightFailed = false;
      let childOperation: Promise<NativeAgentChildResult> | undefined;
      let slot: NativeAgentTaskSlot | undefined;
      const timing = execution.children.find(child => child.childId === receipt.childId)!;
      try {
        const claim = await claims[index];
        if (claim.error) { if (claim.error instanceof NativeAgentTaskPoolClosedError && claim.error.reason === 'unsafe') halt(); throw claim.error; }
        slot = claim.slot;
        timing.admitted = claim.admitted;
        if (signal.aborted) throw new NativeAgentWorktreeError('cancelled', '委派已取消。');
        receipt.status = 'prepared';
        if (recovery?.receipt.workspace) {
          receipt.workspace = structuredClone(recovery.receipt.workspace); receipt.workspaceVerified = true; worktreeAttempted = true;
        }
        await save(receipt); await saveExecution();
        await guard(context);
        try { await assertSkillsCurrent(state, context); } catch (error) { skillPreflightFailed = true; throw error; }
        if (recovery) await verifyRecovery(recovery, true);
        if (state.baseline) {
          await verifyAgentBaseline(state.baseline, signal);
          baselineCommit ??= materializeAgentBaseline(state.baseline, options.worktreeRoot, operationSignal);
          const baseCommit = await baselineCommit;
          await guard(context); await verifyAgentBaseline(state.baseline, signal);
          const worktreePath = path.join(await fs.realpath(options.worktreeRoot), receipt.childId);
          receipt.workspace = { path: worktreePath, cwd: path.join(worktreePath, state.baseline.relativeCwd), branch: `codex/native-agent-${receipt.childId}`,
            baseCommit, parentHead: state.baseline.parentHead, baseline: state.baseline.mode };
          receipt.workspaceVerified = false;
          await save(receipt);
          worktreeAttempted = true;
          receipt.workspace = await createAgentWorktree(state.baseline, options.worktreeRoot, baseCommit, receipt.childId, signal);
          receipt.workspaceVerified = true;
          receipt.cwd = receipt.workspace.cwd;
          await save(receipt);
        }
        if (signal.aborted) throw new NativeAgentWorktreeError('cancelled', '委派已取消。');
        const childRecovery: NativeAgentChildInput['recovery'] = recovery ? { previousChildId: recovery.receipt.childId, previousRunId: recovery.receipt.identity.runId,
          summary: recovery.receipt.result!.summary, reason: recovery.receipt.result!.reason, receiptPath: recovery.receipt.receiptPath,
          ...(recovery.receipt.artifact ? { patchPath: recovery.receipt.artifact.patchPath } : {}) } : undefined;
        if (receipt.nativeSkills) {
          try {
            if (!options.skills) throw new Error('技能继承运行时尚未就绪。');
            await options.skills.preflightChild(structuredClone(receipt.nativeSkills), { identity: structuredClone(receipt.identity), childId: receipt.childId,
              parentIdentity: structuredClone(parentIdentity), cwd: receipt.cwd, toolPolicy: mode === 'review' ? 'read_only' : 'workspace_write', signal,
              ...(childRecovery ? { recovery: childRecovery } : {}) });
            await guard(context);
          } catch (error) { skillPreflightFailed = true; throw error; }
        }
        await guard(context);
        if (state.baseline) await verifyAgentBaseline(state.baseline, signal);
        try { await assertSkillsCurrent(state, context); } catch (error) { skillPreflightFailed = true; throw error; }
        receipt.status = 'running'; await save(receipt);
        if (signal.aborted) throw new NativeAgentWorktreeError('cancelled', '委派已停止。');
        const budget = options.createChildBudget(structuredClone(receipt.identity));
        childStarted = true;
        timing.started = instant();
        childOperation = options.runChild({ identity: structuredClone(receipt.identity), childId: receipt.childId, taskId: receipt.taskId,
          parentIdentity: structuredClone(parentIdentity), parentTaskId: options.parentTaskId, title: receipt.title, goal: receipt.goal,
          cwd: receipt.cwd, toolPolicy: mode === 'review' ? 'read_only' : 'workspace_write', budget, signal,
          ...(receipt.nativeSkills ? { nativeSkills: structuredClone(receipt.nativeSkills) } : {}),
          ...(childRecovery ? { recovery: childRecovery } : {}) })
          .finally(() => { timing.settled = instant(); });
        // 持久化起点期间 worker 仍并行执行；及时附加拒绝处理，失败后也必须等待物理子任务结算。
        void childOperation.catch(() => {});
        await saveExecution();
        const result = await childOperation;
        credentials(result);
        if (encode(result.identity) !== encode(receipt.identity) || result.taskId !== receipt.taskId || !Number.isSafeInteger(result.modelRequests) || result.modelRequests < 0 ||
            !Number.isSafeInteger(result.toolCalls) || result.toolCalls < 0 || !['completed', 'cancelled', 'failed', 'budget_exhausted', 'recovery_required'].includes(result.status) ||
            typeof result.committed !== 'boolean' || typeof result.reason !== 'string' || result.reason.length > 1024 || typeof result.summary !== 'string' || result.summary.length > 65536) throw new Error('Invalid child receipt.');
        receipt.result = structuredClone(result);
        receipt.status = !result.committed || result.status === 'recovery_required' ? 'unknown' : result.status === 'completed' ? 'completed' : result.status === 'cancelled' ? 'cancelled' : 'failed';
        if (result.status === 'recovery_required') receipt.error = 'child_recovery_required';
        else if (!result.committed) receipt.error = 'child_commit_unconfirmed';
        if (receipt.status === 'unknown') halt();
      } catch (error) {
        const wasCancelled = signal.aborted;
        abort.abort();
        if (childStarted && !timing.settled) timing.settled = instant();
        if (childOperation) await childOperation.catch(() => {});
        const notStarted = knownChildNotStarted(error);
        if (notStarted) { delete timing.started; delete timing.settled; }
        // 子任务启动被拒绝时仍可能已执行工具。除非
        // 宿主提供已持久化的终态 RunResult，否则必须恢复；绝不根据信号推断取消。
        receipt.status = error instanceof NativeAgentReceiptPersistenceError || error instanceof NativeAgentExecutionPersistenceError || childStarted && !notStarted || worktreeAttempted && !receipt.workspaceVerified ? 'unknown' : wasCancelled && !unsafe ? 'cancelled' : 'failed';
        receipt.error = error instanceof NativeAgentReceiptPersistenceError ? 'delegation_receipt_unconfirmed' : error instanceof NativeAgentExecutionPersistenceError ? 'delegation_execution_unconfirmed'
          : error instanceof NativeAgentTaskPoolClosedError && error.reason === 'unsafe' || unsafe && !childStarted ? 'delegation_queue_halted'
          : error instanceof NativeAgentWorktreeError ? error.code : notStarted ? 'child_start_preconditions_failed'
          : skillPreflightFailed ? 'skill_inheritance_preflight_failed' : childStarted ? 'child_run_unconfirmed' : 'child_launch_failed';
        if (receipt.status === 'unknown') halt();
      } finally {
        children.delete(abort);
        settled.add(receipt.childId);
        if (receipt.workspace && worktreeAttempted) {
          try {
            const evidence = await collectAgentWorkspaceEvidence(receipt.workspace, options.worktreeRoot);
            if (options.forbiddenValues.some(secret => secret && evidence.patch.includes(Buffer.from(secret, 'utf8')))) throw new Error('Protected value in retained agent artifact.');
            credentials({ ...evidence, patch: evidence.patch.toString('utf8') });
            const patchPath = path.join(path.dirname(receipt.receiptPath), 'workspace.diff.patch');
            await writeAgentArtifact(patchPath, evidence.patch);
            receipt.artifact = { patchPath, changedFiles: evidence.changedFiles, head: evidence.head, baseCommit: evidence.baseCommit,
              sha256: createHash('sha256').update(evidence.patch).digest('hex'), bytes: evidence.patch.byteLength };
          } catch { receipt.status = 'unknown'; receipt.error = 'workspace_evidence_unconfirmed'; }
        }
        if (receipt.status === 'unknown') halt();
        // 许可在真实 worker 和工作区证据都结算后才释放；未知状态先停止所有后续领取。
        try { await saveExecution(); } catch { receipt.status = 'unknown'; receipt.error = 'delegation_execution_unconfirmed'; halt(); }
        try { await save(receipt); }
        catch {
          receipt.status = 'unknown'; receipt.error = 'delegation_receipt_unconfirmed';
          // 文件保存与投影确认是两个步骤；确认失败后尽力把已写的终态降为未知。
          try { await save(receipt); } catch { /* 持续失败时保留现场，任务池已经停止。 */ }
        }
        if (receipt.status === 'unknown') halt();
        if (slot) {
          timing.released = instant();
          try { await saveExecution(); }
          catch {
            receipt.status = 'unknown'; receipt.error = 'delegation_execution_unconfirmed'; halt();
            try { await save(receipt); } catch { /* 已阻断后续启动，保留最后可确认的现场。 */ }
          }
        }
        slot?.release(); releaseAdmission();
      }
    }));
    return resultOutput(receipts, context);
  };
  const executeBatch = async (state: CallState, context: ToolExecutionContext): Promise<ToolResult> => {
    const count = state.recovery ? 1 : reviewSchema.parse({ tasks: state.prepared.input.tasks }).tasks.length;
    if (state.recovery && (recovering.has(state.recovery.receipt.childId) || recovered.has(state.recovery.receipt.childId))) return { status: 'not_executed', output: { error: 'agent_recovery_already_started' } };
    if (reserved + count > 30) return { status: 'not_executed', output: { error: 'delegation_queue_full' } };
    // 在首次 await 前完成预留，包括持久化和 Git 准备，以免
    // 并发工具调用都观察到尚未占用的子任务容量。
    reserved += count; let remaining = count;
    const batchAbort = new AbortController();
    const admissionSignal = AbortSignal.any([lifecycle.signal, options.signal, context.signal, batchAbort.signal]);
    // 同步排入共享 FIFO，并立即处理 rejection，避免保存意图期间取消造成未处理拒绝。
    const queued: Instant[] = [];
    const claims: SlotClaim[] = Array.from({ length: count }, () => {
      queued.push(instant());
      return taskPool.acquire(admissionSignal).then(slot => ({ slot, admitted: instant() }), error => ({ error }));
    });
    if (state.recovery) recovering.add(state.recovery.receipt.childId);
    const releaseAdmission = () => { remaining--; reserved--; };
    try { return await executeReservedBatch(state, context, claims, queued, releaseAdmission); }
    finally {
      batchAbort.abort();
      // 早期校验或保存失败也要归还同步领取的许可，并取消尚未领取的请求。
      for (const claim of await Promise.all(claims)) claim.slot?.release();
      reserved -= remaining;
      if (state.recovery) recovering.delete(state.recovery.receipt.childId);
    }
  };
  return {
    definitions,
    async prepare(call, context) {
      const definition = definitions.find(item => item.name === call.name);
      if (!definition || !call.id || call.id.length > 256 || call.id.includes('\0') || Buffer.byteLength(call.arguments) > 256 * 1024 || context.maxOutputBytes < 2048) throw new Error('无效的委派工具参数。');
      await guard(context);
      const previous = states.get(call.id);
      if (previous) { if (encode(previous.prepared.call) !== encode(call)) throw new Error('委派调用标识已使用。'); stateFor(previous.prepared, context); return structuredClone(previous.prepared); }
      const raw = JSON.parse(call.arguments), input = call.name === 'recover_agent' ? recoverySchema.parse(raw) : call.name === 'delegate_review' ? reviewSchema.parse(raw) : implementSchema.parse(raw);
      let recovery: CallState['recovery'];
      if (call.name === 'recover_agent') {
        const receipt = retained.get(recoverySchema.parse(raw).childId);
        if (!receipt || !canRecover(receipt)) throw new Error('子 Agent 尚未安全结算，或该失败尝试已恢复。');
        if (receipt.mode === 'implement' && options.policy !== 'workspace_write') throw new Error('当前策略不允许恢复实现任务。');
        recovery = { receipt: structuredClone(receipt) };
        if (receipt.workspace) {
          await verifyAgentWorkspace(receipt.workspace, options.worktreeRoot);
          const evidence = await collectAgentWorkspaceEvidence(receipt.workspace, options.worktreeRoot);
          recovery.workspaceSha256 = createHash('sha256').update(evidence.patch).digest('hex'); recovery.workspaceHead = evidence.head;
        }
      }
      if (encode(raw) !== encode(input)) throw new Error('委派参数不能被隐式改写。');
      credentials(input);
      const baseline = call.name === 'delegate_implement' ? await prepareAgentBaseline(options.cwd, implementSchema.parse(raw).baseline, context.signal) : undefined;
      const nativeSkills = recovery ? recovery.receipt.nativeSkills === undefined ? undefined : inheritance(recovery.receipt.nativeSkills)
        : options.skills ? inheritance(await options.skills.freeze(context.signal)) : undefined;
      if (nativeSkills && !options.skills) throw new Error('技能继承运行时尚未就绪。');
      await guard(context);
      const prepared: PreparedTool = { call: structuredClone(call), definition: structuredClone(definition), input: input as unknown as JsonObject,
        inputDigest: hash(input), policyRevision: context.policyRevision, requiresApproval: (call.name === 'delegate_implement' || recovery?.receipt.mode === 'implement') && (options.requiresApproval ?? true),
        preconditions: { parentTaskId: options.parentTaskId, cwd: options.cwd, interaction: 'independent_native_agents',
          ...(nativeSkills ? { nativeSkillsDigest: nativeSkills.digest, nativeSkills: JSON.parse(encode(nativeSkills)) as JsonObject } : {}),
          ...(recovery ? { recoveryMode: recovery.receipt.mode, recoveryChildId: recovery.receipt.childId, recoveryRunId: recovery.receipt.identity.runId, workspaceSha256: recovery.workspaceSha256 ?? '', workspaceHead: recovery.workspaceHead ?? '' } : {}),
          ...(baseline ? { parentHead: baseline.parentHead, baseline: baseline.mode, fingerprint: baseline.fingerprint, includesUncommittedChanges: baseline.dirty } : {}) } };
      states.set(call.id, { prepared: structuredClone(prepared), maxOutputBytes: context.maxOutputBytes, ...(nativeSkills ? { nativeSkills } : {}), ...(baseline ? { baseline } : {}), ...(recovery ? { recovery } : {}) });
      return prepared;
    },
    async validate(prepared, context) {
      const state = stateFor(prepared, context); await guard(context); stateFor(prepared, context);
      if (!state.execution && state.recovery) await verifyRecovery(state.recovery);
      if (!state.execution && state.baseline) await verifyAgentBaseline(state.baseline, context.signal);
      if (!state.execution) await assertSkillsCurrent(state, context);
    },
    async execute(prepared, context, approval?: ApprovalDecision) {
      let state: CallState;
      try { state = stateFor(prepared, context); await guard(context); stateFor(prepared, context); }
      catch { return { status: 'not_executed', output: { error: 'delegation_preconditions_changed' } }; }
      if (state.execution) return structuredClone(await state.execution);
      if (prepared.requiresApproval && (!approval || approval.decision !== 'approved' || approval.expiresAt <= Date.now() ||
        encode(approval.binding) !== encode({ ...parentIdentity, toolCallId: prepared.call.id, inputDigest: prepared.inputDigest, policyRevision: prepared.policyRevision }))) {
        return { status: 'denied', output: { error: 'delegation_approval_required' } };
      }
      const operation = executeBatch(state, context).catch(error => ({ status: state.effectsStarted ? 'unknown' as const : 'not_executed' as const, output: {
        error: error instanceof NativeAgentWorktreeError ? error.code : 'delegation_preconditions_changed' } }));
      state.execution = operation; operations.add(operation);
      void operation.finally(() => operations.delete(operation));
      return structuredClone(await operation);
    },
    async closeAll() {
      closing = true; cancel();
      await Promise.allSettled([...operations]);
      await taskPool.drain();
      options.signal.removeEventListener('abort', cancel);
      taskPool.signal.removeEventListener('abort', poolStopped);
    },
  };
}
