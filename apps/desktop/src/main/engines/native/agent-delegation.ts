import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { canonicalJson, type ApprovalDecision, type JsonObject, type PreparedTool, type RunIdentity, type RunStatus, type ToolDefinition, type ToolExecutionContext, type ToolPort, type ToolResult } from '@cc-desk/agent-core';
import { assertNoModelCredential } from '@cc-desk/agent-node/responses-model';
import { collectAgentWorkspaceEvidence, createAgentWorktree, materializeAgentBaseline, NativeAgentWorktreeError, prepareAgentBaseline, verifyAgentBaseline,
  type NativeAgentBaseline, type NativeAgentWorktree } from './agent-worktrees';
import { writeAgentArtifact, writeAgentReceipt } from './agent-artifacts';

export interface NativeDelegationBudget {
  /** Host-enforced, atomic gate shared with the parent and every sibling. */
  consume(kind: 'model' | 'tool', identity: RunIdentity): Promise<boolean>;
  remainingMs(): number;
  snapshot(): { modelRequests: number; toolCalls: number };
}
export interface NativeAgentChildInput {
  identity: RunIdentity;
  taskId: string;
  parentIdentity: RunIdentity;
  parentTaskId: string;
  title: string;
  goal: string;
  cwd: string;
  /** These restrictions must be enforced by the host, never only by a prompt. */
  toolPolicy: 'read_only' | 'workspace_write';
  signal: AbortSignal;
  budget: NativeDelegationBudget;
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
  status: 'prepared' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown';
  createdAt: string;
  updatedAt: string;
  receiptPath: string;
  cwd: string;
  workspace?: NativeAgentWorktree;
  workspaceVerified?: boolean;
  artifact?: { patchPath: string; changedFiles: Array<{ path: string; status: string }>; head: string; baseCommit: string };
  result?: NativeAgentChildResult;
  /** Stable host code only; provider or subprocess errors are never copied here. */
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
  budget: NativeDelegationBudget;
  assertOwnership(): Promise<void>;
  /** Must create an independent context/worker; child hosts must not register delegation. */
  runChild(input: NativeAgentChildInput): Promise<NativeAgentChildResult>;
  record?(receipt: NativeDelegationReceipt): Promise<void>;
  /** Standard automatic write policy can disable the dialog, never the host restriction. */
  requiresApproval?: boolean;
}
export interface NativeAgentDelegationTools extends ToolPort { closeAll(): Promise<void> }

const taskSchema = z.object({ title: z.string().trim().min(1).max(200), goal: z.string().trim().min(1).max(6000) }).strict();
const reviewSchema = z.object({ tasks: z.array(taskSchema).min(1).max(4) }).strict();
const implementSchema = z.object({ tasks: z.array(taskSchema).min(1).max(4), baseline: z.enum(['snapshot', 'head']) }).strict();
const tasksJson: JsonObject = { type: 'array', minItems: 1, maxItems: 4, items: { type: 'object', additionalProperties: false, required: ['title', 'goal'], properties: {
  title: { type: 'string', minLength: 1, maxLength: 200 }, goal: { type: 'string', minLength: 1, maxLength: 6000 },
} } };
const toolDefinitions: ToolDefinition[] = [{
  name: 'delegate_review', risk: 'read',
  description: 'Run 1–4 independent Native agents concurrently to review the current workspace. Each child starts with its own goal/context and a separate worker; it can only read local files and cannot run commands, write files, use external tools or spawn agents. Children and parent share request/tool/time limits. Provide complete, bounded review questions in tasks. Results include durable task/run receipts and summaries; a completed review is not implementation acceptance.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['tasks'], properties: { tasks: tasksJson } },
}, {
  name: 'delegate_implement', risk: 'write',
  description: 'Run 1–4 independent Native implementation agents concurrently, each in its own retained Git linked worktree and codex branch. Explicitly choose baseline snapshot (include current tracked and non-ignored new changes) or head (allowed only when the parent workspace is clean). The parent index, branch and files are preserved. Siblings share the same baseline and the parent request/tool/time budget. Children cannot spawn more agents. Results provide worktree paths, patches, task/run and command receipts for review; no branch is merged automatically. Assign separate bounded tasks and review each diff before integrating.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['tasks', 'baseline'], properties: { tasks: tasksJson, baseline: { type: 'string', enum: ['snapshot', 'head'] } } },
}];
const encode = (value: unknown) => canonicalJson(JSON.parse(JSON.stringify(value)));
const hash = (value: unknown) => createHash('sha256').update(encode(value)).digest('hex');
interface CallState { prepared: PreparedTool; maxOutputBytes: number; baseline?: NativeAgentBaseline; execution?: Promise<ToolResult>; effectsStarted?: boolean }

/** A batch is one parent tool call, so siblings remain parallel despite the serial core loop. */
export function createAgentDelegationTools(options: NativeAgentDelegationOptions): NativeAgentDelegationTools {
  const definitions = structuredClone(options.policy === 'read_only' ? toolDefinitions.slice(0, 1) : toolDefinitions);
  const states = new Map<string, CallState>(), operations = new Set<Promise<ToolResult>>(), children = new Set<AbortController>();
  const parentIdentity = structuredClone(options.identity), identityKey = encode(parentIdentity), lifecycle = new AbortController();
  let closing = false, launched = 0, reserved = 0;
  const cancel = () => { lifecycle.abort(); for (const child of children) child.abort(); };
  options.signal.addEventListener('abort', cancel);
  const credentials = (value: unknown) => assertNoModelCredential(value, options.forbiddenValues);
  const current = (context: ToolExecutionContext) => {
    if (closing || options.signal.aborted || context.signal.aborted || encode(context.identity) !== identityKey) throw new Error('委派不属于当前运行。');
  };
  const guard = async (context: ToolExecutionContext) => { current(context); await options.assertOwnership(); current(context); };
  const stateFor = (prepared: PreparedTool, context: ToolExecutionContext) => {
    current(context);
    const state = states.get(prepared.call.id);
    if (!state || state.maxOutputBytes !== context.maxOutputBytes || prepared.policyRevision !== context.policyRevision || encode(state.prepared) !== encode(prepared)) throw new Error('委派参数或策略已改变。');
    return state;
  };
  const save = async (receipt: NativeDelegationReceipt) => {
    credentials(receipt);
    receipt.updatedAt = new Date().toISOString();
    await writeAgentReceipt(receipt.receiptPath, receipt);
    await options.record?.(structuredClone(receipt));
  };
  const resultOutput = (receipts: NativeDelegationReceipt[], context: ToolExecutionContext): ToolResult => {
    const status: ToolResult['status'] = receipts.some(r => r.status === 'unknown') ? 'unknown' :
      receipts.every(r => r.status === 'completed') ? 'completed' : receipts.every(r => r.status === 'cancelled') ? 'cancelled' : 'failed';
    const output = { children: receipts.map(r => ({ childId: r.childId, taskId: r.taskId, runId: r.identity.runId, title: r.title, status: r.status,
      receiptPath: r.receiptPath, cwd: r.cwd, ...(r.workspace ? { workspace: r.workspace, workspaceVerified: r.workspaceVerified } : {}),
      ...(r.artifact ? { artifact: r.artifact } : {}), ...(r.error ? { error: r.error } : {}),
      ...(r.result ? { summary: r.result.summary, reason: r.result.reason, modelRequests: r.result.modelRequests, toolCalls: r.result.toolCalls, evidence: r.result.evidence } : {}) })),
      budget: options.budget.snapshot(), integration: 'Review retained worktrees and patches before explicitly integrating; execution completion does not prove acceptance.' };
    credentials(output);
    if (Buffer.byteLength(encode(output)) <= context.maxOutputBytes) return { status, output: JSON.parse(JSON.stringify(output)) };
    // Full summaries/evidence remain durable; truncation is only model presentation.
    const references = { children: receipts.map(r => ({ childId: r.childId, taskId: r.taskId, runId: r.identity.runId,
      status: r.status, receiptPath: r.receiptPath })), budget: options.budget.snapshot(), details: 'Full results, worktree and artifact references are in each durable receipt.' };
    if (Buffer.byteLength(encode(references)) <= context.maxOutputBytes) return { status, truncated: true, output: references };
    const batchReference = { batchId: receipts[0].batchId, receiptDirectory: path.dirname(path.dirname(receipts[0].receiptPath)),
      children: receipts.map(r => ({ childId: r.childId, status: r.status })), details: 'Each child has a receipt.json in its directory.' };
    return { status, truncated: true, output: Buffer.byteLength(encode(batchReference)) <= context.maxOutputBytes ? batchReference : {
      batchId: receipts[0].batchId, children: receipts.map(r => ({ childId: r.childId, status: r.status })), details: 'Full results are retained in the host delegation store.' } };
  };
  const executeReservedBatch = async (state: CallState, context: ToolExecutionContext): Promise<ToolResult> => {
    const operationSignal = AbortSignal.any([lifecycle.signal, options.signal, context.signal]);
    const input = state.prepared.call.name === 'delegate_review' ? reviewSchema.parse(state.prepared.input) : implementSchema.parse(state.prepared.input);
    if (options.budget.remainingMs() < 1) return { status: 'not_executed', output: { error: 'delegation_budget_exhausted' } };
    await guard(context);
    const mode = state.prepared.call.name === 'delegate_review' ? 'review' : 'implement';
    if (state.baseline) await verifyAgentBaseline(state.baseline, operationSignal);
    const batchId = randomUUID(), batchPath = path.join(options.storeDirectory, 'delegations', parentIdentity.conversationId, parentIdentity.runId, batchId);
    const receipts: NativeDelegationReceipt[] = input.tasks.map(task => {
      const childId = randomUUID(), now = new Date().toISOString();
      return { version: 1, batchId, childId, taskId: randomUUID(), identity: { sessionId: randomUUID(), conversationId: randomUUID(), runId: randomUUID(), requestId: randomUUID(), workerGeneration: 1 },
        parentIdentity: structuredClone(parentIdentity), parentTaskId: options.parentTaskId, toolCallId: state.prepared.call.id, ...task,
        mode, status: 'prepared', createdAt: now, updatedAt: now, receiptPath: path.join(batchPath, childId, 'receipt.json'), cwd: options.cwd };
    });
    // Persist intent before any worktree or child model operation. Exact repeats reuse execution.
    state.effectsStarted = true;
    try { for (const receipt of receipts) await save(receipt); }
    catch { return { status: 'unknown', output: { error: 'delegation_intent_unconfirmed', batchId } }; }
    let baseCommit: string | undefined;
    try {
      if (state.baseline) baseCommit = await materializeAgentBaseline(state.baseline, options.worktreeRoot, operationSignal);
    } catch (error) {
      for (const receipt of receipts) {
        receipt.status = operationSignal.aborted ? 'cancelled' : 'failed';
        receipt.error = error instanceof NativeAgentWorktreeError ? error.code : 'baseline_materialization_failed';
        try { await save(receipt); } catch { receipt.status = 'unknown'; }
      }
      return resultOutput(receipts, context);
    }
    await Promise.allSettled(receipts.map(async receipt => {
      const abort = new AbortController(); children.add(abort);
      const signal = AbortSignal.any([abort.signal, operationSignal]);
      let childStarted = false, worktreeAttempted = false;
      try {
        if (signal.aborted) throw new NativeAgentWorktreeError('cancelled', '委派已取消。');
        await options.assertOwnership();
        if (state.baseline) {
          const worktreePath = path.join(await fs.realpath(options.worktreeRoot), receipt.childId);
          receipt.workspace = { path: worktreePath, cwd: path.join(worktreePath, state.baseline.relativeCwd), branch: `codex/native-agent-${receipt.childId}`,
            baseCommit: baseCommit!, parentHead: state.baseline.parentHead, baseline: state.baseline.mode };
          receipt.workspaceVerified = false;
          await save(receipt);
          worktreeAttempted = true;
          receipt.workspace = await createAgentWorktree(state.baseline, options.worktreeRoot, baseCommit!, receipt.childId, signal);
          receipt.workspaceVerified = true;
          receipt.cwd = receipt.workspace.cwd;
          await save(receipt);
        }
        if (signal.aborted) throw new NativeAgentWorktreeError('cancelled', '委派已取消。');
        receipt.status = 'running'; await save(receipt);
        if (signal.aborted || options.budget.remainingMs() < 1) throw new NativeAgentWorktreeError(signal.aborted ? 'cancelled' : 'delegation_budget_exhausted', '委派已停止。');
        childStarted = true;
        const result = await options.runChild({ identity: structuredClone(receipt.identity), taskId: receipt.taskId,
          parentIdentity: structuredClone(parentIdentity), parentTaskId: options.parentTaskId, title: receipt.title, goal: receipt.goal,
          cwd: receipt.cwd, toolPolicy: mode === 'review' ? 'read_only' : 'workspace_write', budget: options.budget, signal });
        credentials(result);
        if (encode(result.identity) !== encode(receipt.identity) || result.taskId !== receipt.taskId || !Number.isSafeInteger(result.modelRequests) || result.modelRequests < 0 ||
            !Number.isSafeInteger(result.toolCalls) || result.toolCalls < 0 || !['completed', 'cancelled', 'failed', 'budget_exhausted', 'recovery_required'].includes(result.status) ||
            typeof result.committed !== 'boolean' || typeof result.reason !== 'string' || result.reason.length > 1024 || typeof result.summary !== 'string' || result.summary.length > 65536) throw new Error('Invalid child receipt.');
        receipt.result = structuredClone(result);
        receipt.status = !result.committed || result.status === 'recovery_required' ? 'unknown' : result.status === 'completed' ? 'completed' : result.status === 'cancelled' ? 'cancelled' : 'failed';
        if (result.status === 'recovery_required') receipt.error = 'child_recovery_required';
        else if (!result.committed) receipt.error = 'child_commit_unconfirmed';
      } catch (error) {
        abort.abort();
        // A rejected child launch can have executed tools. Require recovery unless the
        // host provides a durable terminal RunResult; never infer cancellation from signal.
        receipt.status = childStarted || worktreeAttempted && !receipt.workspaceVerified ? 'unknown' : signal.aborted ? 'cancelled' : 'failed';
        receipt.error = error instanceof NativeAgentWorktreeError ? error.code : childStarted ? 'child_run_unconfirmed' : 'child_launch_failed';
      } finally {
        children.delete(abort);
        if (receipt.workspace && worktreeAttempted) {
          try {
            const evidence = await collectAgentWorkspaceEvidence(receipt.workspace, options.worktreeRoot);
            if (options.forbiddenValues.some(secret => secret && evidence.patch.includes(Buffer.from(secret, 'utf8')))) throw new Error('Protected value in retained agent artifact.');
            credentials({ ...evidence, patch: evidence.patch.toString('utf8') });
            const patchPath = path.join(path.dirname(receipt.receiptPath), 'workspace.diff.patch');
            await writeAgentArtifact(patchPath, evidence.patch);
            receipt.artifact = { patchPath, changedFiles: evidence.changedFiles, head: evidence.head, baseCommit: evidence.baseCommit };
          } catch { receipt.status = 'unknown'; receipt.error = 'workspace_evidence_unconfirmed'; }
        }
        try { await save(receipt); } catch { receipt.status = 'unknown'; receipt.error = 'delegation_receipt_unconfirmed'; }
      }
    }));
    return resultOutput(receipts, context);
  };
  const executeBatch = async (state: CallState, context: ToolExecutionContext): Promise<ToolResult> => {
    const count = reviewSchema.parse({ tasks: state.prepared.input.tasks }).tasks.length;
    if (launched + reserved + count > 16 || reserved + count > 4) return { status: 'not_executed', output: { error: 'delegation_capacity_exhausted' } };
    // Reserve before the first await, including persistence/Git preparation, so
    // concurrent tool calls cannot each observe an empty child capacity.
    reserved += count;
    try { return await executeReservedBatch(state, context); }
    finally { reserved -= count; if (state.effectsStarted) launched += count; }
  };
  return {
    definitions,
    async prepare(call, context) {
      const definition = definitions.find(item => item.name === call.name);
      if (!definition || !call.id || call.id.length > 256 || call.id.includes('\0') || Buffer.byteLength(call.arguments) > 32768 || context.maxOutputBytes < 2048) throw new Error('无效的委派工具参数。');
      await guard(context);
      const previous = states.get(call.id);
      if (previous) { if (encode(previous.prepared.call) !== encode(call)) throw new Error('委派调用标识已使用。'); stateFor(previous.prepared, context); return structuredClone(previous.prepared); }
      if (states.size >= 32) throw new Error('委派工具缓存已满。');
      const raw = JSON.parse(call.arguments), input = call.name === 'delegate_review' ? reviewSchema.parse(raw) : implementSchema.parse(raw);
      if (encode(raw) !== encode(input)) throw new Error('委派参数不能被隐式改写。');
      credentials(input);
      const baseline = call.name === 'delegate_implement' ? await prepareAgentBaseline(options.cwd, implementSchema.parse(raw).baseline, context.signal) : undefined;
      await guard(context);
      const prepared: PreparedTool = { call: structuredClone(call), definition: structuredClone(definition), input: input as unknown as JsonObject,
        inputDigest: hash(input), policyRevision: context.policyRevision, requiresApproval: call.name === 'delegate_implement' && (options.requiresApproval ?? true),
        preconditions: { parentTaskId: options.parentTaskId, cwd: options.cwd, interaction: 'independent_native_agents',
          ...(baseline ? { parentHead: baseline.parentHead, baseline: baseline.mode, fingerprint: baseline.fingerprint, includesUncommittedChanges: baseline.dirty } : {}) } };
      states.set(call.id, { prepared: structuredClone(prepared), maxOutputBytes: context.maxOutputBytes, ...(baseline ? { baseline } : {}) });
      return prepared;
    },
    async validate(prepared, context) {
      const state = stateFor(prepared, context); await guard(context); stateFor(prepared, context);
      if (!state.execution && state.baseline) await verifyAgentBaseline(state.baseline, context.signal);
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
      options.signal.removeEventListener('abort', cancel);
    },
  };
}
