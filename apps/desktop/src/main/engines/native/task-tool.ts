import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson, validateNativeTaskPlan, type JsonObject, type PreparedTool, type RunIdentity, type ToolDefinition, type ToolExecutionContext, type ToolPort, type ToolResult } from '@cc-desk/agent-core';
import type { NativeTaskPlan, NativeTaskSnapshot, NativeTaskUpdate } from '@cc-desk/contracts/native-task';
import { assertNoModelCredential } from '@cc-desk/agent-node/responses-model';

const identifier = z.string().min(1).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/);
const planSchema = z.object({
  goal: z.string().trim().min(1).max(2000),
  steps: z.array(z.object({ id: identifier, title: z.string().trim().min(1).max(500),
    dependsOn: z.array(identifier).max(32), status: z.enum(['pending', 'in_progress', 'implemented', 'blocked']),
    blockedReason: z.string().trim().min(1).max(2000).optional(),
  }).strict()).min(1).max(32),
  criteria: z.array(z.object({ id: identifier, description: z.string().trim().min(1).max(1000),
    stepIds: z.array(identifier).min(1).max(32), kind: z.enum(['command', 'manual']),
  }).strict()).max(32),
}).strict();
const updateSchema = z.object({ expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  plan: planSchema, explanation: z.string().trim().min(1).max(2000).optional(),
}).strict();
const readSchema = z.object({ evidenceOffset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  historyOffset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(), limit: z.number().int().min(1).max(20).optional(),
}).strict();
const idSchema: JsonObject = { type: 'string', minLength: 1, maxLength: 80, pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]*$' };
const definitions: ToolDefinition[] = [{
  name: 'update_plan', risk: 'read',
  description: 'Create or revise the current engineering task plan with expectedRevision (0 for a new task; otherwise use read_task). Use stable step and acceptance-condition IDs. Step implemented is a model declaration, never verification. Dependencies must be acyclic and met before starting dependent work. A blocked step needs a reason. Criteria describe actual command checks or human review; a command success alone does not prove acceptance. Plans change only task metadata and grant no file, command, or external-tool permissions. Simple questions need no plan.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['expectedRevision', 'plan'], properties: {
    expectedRevision: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, explanation: { type: 'string', minLength: 1, maxLength: 2000 },
    plan: { type: 'object', additionalProperties: false, required: ['goal', 'steps', 'criteria'], properties: {
      goal: { type: 'string', minLength: 1, maxLength: 2000 },
      steps: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'object', additionalProperties: false, required: ['id', 'title', 'dependsOn', 'status'], properties: {
        id: idSchema, title: { type: 'string', minLength: 1, maxLength: 500 }, dependsOn: { type: 'array', maxItems: 32, items: idSchema },
        status: { type: 'string', enum: ['pending', 'in_progress', 'implemented', 'blocked'] }, blockedReason: { type: 'string', minLength: 1, maxLength: 2000 },
      } } },
      criteria: { type: 'array', maxItems: 32, items: { type: 'object', additionalProperties: false, required: ['id', 'description', 'stepIds', 'kind'], properties: {
        id: idSchema, description: { type: 'string', minLength: 1, maxLength: 1000 }, stepIds: { type: 'array', minItems: 1, maxItems: 32, items: idSchema }, kind: { type: 'string', enum: ['command', 'manual'] },
      } } },
    } },
  } },
}, {
  name: 'read_task', risk: 'read',
  description: 'Read the host-bound durable task plan, current revision, verification state and paged evidence/history index. No task is created by reading. Evidence logs are not duplicated into context. Use next offsets for more index entries. This is the authoritative task state after compaction or a stale plan revision; prose is not verification.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {
    evidenceOffset: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, historyOffset: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, limit: { type: 'integer', minimum: 1, maximum: 20 },
  } },
}];
const encode = (value: unknown) => canonicalJson(JSON.parse(JSON.stringify(value)));
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const bytes = (value: unknown) => Buffer.byteLength(encode(value));
interface CallState { prepared: PreparedTool; maxOutputBytes: number; execution?: Promise<ToolResult> }
export interface NativeTaskToolOptions {
  identity: RunIdentity;
  /** Chosen by the host for this run; model arguments cannot select another task. */
  taskId: string;
  forbiddenValues: string[];
  /** Rechecks run ownership, cancellation and the applicable project instructions. */
  assertOwnership(): Promise<void>;
  store: { read(taskId: string): NativeTaskSnapshot | null | undefined; apply(update: NativeTaskUpdate): Promise<NativeTaskSnapshot> };
  /** Host may append a workspace observation; the returned revision is read after it. */
  onCommitted?(snapshot: NativeTaskSnapshot): Promise<void>;
}

/** Only model declarations cross this tool boundary. Evidence/review remain host-only. */
export function createNativeTaskTool(options: NativeTaskToolOptions): ToolPort {
  const states = new Map<string, CallState>();
  const boundIdentity = structuredClone(options.identity), taskId = options.taskId;
  const identity = encode(boundIdentity);
  let preparedBytes = 0;
  const credentials = (value: unknown) => { for (const secret of options.forbiddenValues) assertNoModelCredential(value, secret); };
  const current = (context: ToolExecutionContext) => {
    if (context.signal.aborted || encode(context.identity) !== identity) throw new Error('任务运行归属已失效。');
  };
  const guard = async (context: ToolExecutionContext) => { current(context); await options.assertOwnership(); current(context); };
  const snapshot = () => {
    const task = options.store.read(taskId);
    if (task && (task.taskId !== taskId || encode(task.identity) !== identity)) throw new Error('任务归属已改变。');
    return task ?? undefined;
  };
  const stateFor = (prepared: PreparedTool, context: ToolExecutionContext) => {
    current(context);
    const state = states.get(prepared.call.id);
    if (!state || context.policyRevision !== prepared.policyRevision || state.maxOutputBytes !== context.maxOutputBytes || encode(state.prepared) !== encode(prepared)) throw new Error('任务工具参数或策略已改变。');
    return state;
  };
  const revision = (prepared: PreparedTool) => {
    const task = snapshot();
    if (prepared.call.name === 'update_plan' && (task?.revision ?? 0) !== prepared.input.expectedRevision) throw new Error('任务修订已改变，请先 read_task。');
    return task;
  };
  const bounded = (result: ToolResult, context: ToolExecutionContext): ToolResult => {
    credentials(result);
    return bytes(result.output) <= context.maxOutputBytes ? result : { status: 'failed', output: { error: 'task_output_exceeds_budget', retryWithSmallerPage: true } };
  };
  const readResult = (prepared: PreparedTool, task: NativeTaskSnapshot | undefined): ToolResult => {
    if (!task) return { status: 'completed', output: { task: null, expectedRevision: 0 } };
    const input = readSchema.parse(prepared.input), limit = input.limit ?? 10, evidenceOffset = input.evidenceOffset ?? 0, historyOffset = input.historyOffset ?? 0;
    const evidence = task.evidence.slice(evidenceOffset, evidenceOffset + limit).map(item => ({ id: item.id, source: item.source, status: item.status,
      stepIds: item.stepIds, criterionIds: item.criterionIds, planRevision: item.planRevision, acceptanceRevision: item.acceptanceRevision,
      createdAt: item.createdAt, ...(item.toolCallId ? { toolCallId: item.toolCallId } : {}), ...(item.stale ? { stale: true } : {}),
      ...(item.reason ? { reason: item.reason } : {}), ...(item.truncated ? { truncated: true } : {}), workspaceComplete: item.workspaceComplete,
      ...(item.location ? { location: { path: item.location.path, startLine: item.location.startLine, endLine: item.location.endLine,
        fileHash: item.location.fileHash, fileBytes: item.location.fileBytes, excerptHash: item.location.excerptHash } } : {}),
    }));
    return { status: 'completed', output: JSON.parse(JSON.stringify({ task: {
      taskId: task.taskId, revision: task.revision, planRevision: task.planRevision, acceptanceRevision: task.acceptanceRevision,
      goal: task.goal, steps: task.steps, criteria: task.criteria, execution: task.execution, runOutcome: task.runOutcome,
      verification: task.verification, review: task.review, evidence, history: task.history.slice(historyOffset, historyOffset + limit),
      evidenceTotal: task.evidence.length, historyTotal: task.history.length,
      nextEvidenceOffset: evidenceOffset + evidence.length < task.evidence.length ? evidenceOffset + evidence.length : null,
      nextHistoryOffset: historyOffset + limit < task.history.length ? historyOffset + limit : null,
    } })) };
  };
  return {
    definitions: structuredClone(definitions),
    async prepare(call, context) {
      const definition = definitions.find(item => item.name === call.name);
      if (!definition || !call.id || call.id.length > 256 || call.id.includes('\0') || Buffer.byteLength(call.arguments) > 32 * 1024 || context.maxOutputBytes < 1024) throw new Error('任务工具参数超出限制。');
      await guard(context);
      const previous = states.get(call.id);
      if (previous) {
        if (encode(previous.prepared.call) !== encode(call)) throw new Error('任务调用标识已使用。');
        stateFor(previous.prepared, context);
        return structuredClone(previous.prepared);
      }
      if (states.size >= 200 || preparedBytes + Buffer.byteLength(call.arguments) > 1024 * 1024) throw new Error('任务工具调用缓存已满。');
      const raw = JSON.parse(call.arguments), input = call.name === 'update_plan' ? updateSchema.parse(raw) : readSchema.parse(raw);
      if (encode(raw) !== encode(input)) throw new Error('任务工具参数不能被隐式改写。');
      if ('plan' in input) validateNativeTaskPlan(input.plan);
      credentials(input);
      const prepared: PreparedTool = { call: structuredClone(call), definition: structuredClone(definition), input: input as unknown as JsonObject,
        inputDigest: digest(encode(input)), policyRevision: context.policyRevision, requiresApproval: false,
        preconditions: { taskId, interaction: 'task_metadata' } };
      revision(prepared);
      states.set(call.id, { prepared: structuredClone(prepared), maxOutputBytes: context.maxOutputBytes });
      preparedBytes += Buffer.byteLength(call.arguments);
      return prepared;
    },
    async validate(prepared, context) {
      const state = stateFor(prepared, context); await guard(context); stateFor(prepared, context);
      if (!state.execution) revision(prepared);
    },
    async execute(prepared, context) {
      let state: CallState;
      try { state = stateFor(prepared, context); await guard(context); stateFor(prepared, context); }
      catch { return { status: 'not_executed', output: { error: 'task_preconditions_changed' } }; }
      if (state.execution) return structuredClone(await state.execution);
      state.execution = (async (): Promise<ToolResult> => {
        let task: NativeTaskSnapshot | undefined;
        try { task = revision(prepared); }
        catch { return { status: 'not_executed', output: { error: 'task_revision_changed', readTask: true } }; }
        if (prepared.call.name === 'read_task') {
          try { return bounded(readResult(prepared, task), context); }
          catch { return { status: 'failed', output: { error: 'task_read_unavailable' } }; }
        }
        const input = updateSchema.parse(prepared.input);
        try { await guard(context); }
        catch { return { status: 'not_executed', output: { error: 'task_preconditions_changed' } }; }
        try {
          // The store must repeat its host guard immediately before durable commit.
          const committed = await options.store.apply({ identity: boundIdentity, taskId,
            mutationId: `plan:${digest(encode({ identity: boundIdentity, callId: prepared.call.id }))}`,
            expectedRevision: input.expectedRevision,
            mutation: { type: 'plan', plan: input.plan as NativeTaskPlan, ...(input.explanation ? { explanation: input.explanation } : {}) },
          });
          await options.onCommitted?.(committed);
          await guard(context);
          const latest = snapshot();
          if (!latest || latest.revision < committed.revision) throw new Error('任务保存回执失效。');
          return bounded({ status: 'completed', output: { taskId: latest.taskId, revision: latest.revision,
            planRevision: latest.planRevision, acceptanceRevision: latest.acceptanceRevision, verification: latest.verification,
            implementationComplete: latest.steps.every(step => step.status === 'implemented'),
            note: 'Plan progress is a declaration. Verification requires host evidence and explicit review; this does not authorize other tools.',
          } }, context);
        } catch {
          // Metadata writes have read risk so they need no permission dialog. An
          // uncertain commit must still stop core; a plain throw would be swallowed.
          return { status: 'unknown', output: { error: 'task_commit_unconfirmed' } };
        }
      })();
      return structuredClone(await state.execution);
    },
  };
}
