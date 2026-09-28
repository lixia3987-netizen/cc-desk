import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson, type JsonObject, type PreparedTool, type RunIdentity, type ToolDefinition, type ToolExecutionContext, type ToolPort, type ToolResult } from '@cc-desk/agent-core';
import { assertNoModelCredential } from '@cc-desk/agent-node/responses-model';
import { loadProjectInstructions, type ProjectInstructions } from '@cc-desk/agent-node/project-instructions';
import { isSensitivePath, normalizeProjectPath, ProjectFiles } from '@cc-desk/agent-node/tools';
import { codeLocationEvidence, readCodeLocation, type CodeLocationInput } from './code-location';
import { NativeTaskSession, TaskLocationCapacityError, TaskLocationCommitError } from './task-session';
import type { NativeTaskCodeLocation } from '@cc-desk/contracts/native-task';

const identifier = z.string().min(1).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/);
const schema = z.object({
  expectedRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  path: z.string().min(1).max(4096), expectedHash: z.string().regex(/^[a-f0-9]{64}$/),
  startLine: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), endLine: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  stepIds: z.array(identifier).min(1).max(32), criterionIds: z.array(identifier).max(32),
}).strict();
const idSchema = { type: 'string', minLength: 1, maxLength: 80, pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]*$' };
const definition: ToolDefinition = {
  name: 'record_code_location', risk: 'read',
  description: 'Explicitly attach one host-read file/line snapshot to the current task steps and optionally criteria. First obtain the complete file hash from read_file/search and current expectedRevision from read_task. Select 1–80 actual lines, at most 8192 UTF-8 bytes. The host reads the file, preserves original line endings and saves unverified historical evidence; this never verifies acceptance or changes step status. A changed workspace is refreshed separately and returns task_revision_changed: read_task, reread changed files and retry with a new call ID. Applicable AGENTS.md/CLAUDE.md/selected skill instructions accompany success; use read_file/list_directory before later writes to satisfy their existing scope checks.',
  inputSchema: { type: 'object', additionalProperties: false,
    required: ['expectedRevision', 'path', 'expectedHash', 'startLine', 'endLine', 'stepIds', 'criterionIds'], properties: {
      expectedRevision: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER }, path: { type: 'string', minLength: 1, maxLength: 4096 },
      expectedHash: { type: 'string', pattern: '^[a-f0-9]{64}$' }, startLine: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER }, endLine: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
      stepIds: { type: 'array', minItems: 1, maxItems: 32, uniqueItems: true, items: idSchema }, criterionIds: { type: 'array', maxItems: 32, uniqueItems: true, items: idSchema },
    } },
};
const encode = (value: unknown) => canonicalJson(JSON.parse(JSON.stringify(value)));
const digest = (value: unknown) => createHash('sha256').update(encode(value)).digest('hex');
const instructionOutput = (value: ProjectInstructions) => ({ digest: value.digest, text: value.text,
  sources: value.sources.map(({ path, scope, hash }) => ({ path, scope, hash })) });
interface CallState { prepared: PreparedTool; instructions: ProjectInstructions; maxOutputBytes: number; execution?: Promise<ToolResult> }
export interface CodeLocationToolOptions {
  identity: RunIdentity; taskId: string; session: NativeTaskSession; projectRoot: string;
  excludedRoots?: readonly string[]; projectSkills?: readonly string[]; forbiddenValues: readonly string[];
  assertOwnership(): Promise<void>;
}

/** The model selects a range; only the host can create its content and durable evidence. */
export function createCodeLocationTool(options: CodeLocationToolOptions): ToolPort {
  const identity = structuredClone(options.identity), identityKey = encode(identity), taskId = options.taskId;
  const files = new ProjectFiles({ projectRoot: options.projectRoot, excludedRoots: options.excludedRoots });
  const states = new Map<string, CallState>(); let preparedBytes = 0;
  const credentials = (value: unknown) => { for (const secret of options.forbiddenValues) assertNoModelCredential(value, secret); };
  const current = (context: ToolExecutionContext) => {
    if (context.signal.aborted || encode(context.identity) !== identityKey) throw new Error('位置记录的运行归属已失效。');
  };
  const load = (targetPath: string, signal: AbortSignal) => loadProjectInstructions({ projectRoot: options.projectRoot,
    excludedRoots: options.excludedRoots, projectSkills: options.projectSkills, targetPath, targetKind: 'file' }, signal);
  const guard = async (context: ToolExecutionContext, state?: CallState) => {
    current(context); await options.assertOwnership(); current(context);
    if (state) {
      const instructions = await load(String(state.prepared.input.path), context.signal);
      if (instructions.digest !== state.instructions.digest) throw new Error('文件作用域项目指令已改变，请重新读取。');
      credentials(instructions);
      current(context); await options.assertOwnership(); current(context);
    }
  };
  const stateFor = (prepared: PreparedTool, context: ToolExecutionContext) => {
    current(context); const state = states.get(prepared.call.id);
    if (!state || context.policyRevision !== prepared.policyRevision || context.maxOutputBytes !== state.maxOutputBytes || encode(state.prepared) !== encode(prepared)) throw new Error('位置工具参数或策略已改变。');
    return state;
  };
  const taskFor = (input: CodeLocationInput) => {
    const task = options.session.store.read(taskId);
    if (!task || task.execution !== 'active' || encode(task.identity) !== identityKey) throw new Error('请先建立当前任务计划。');
    if (task.revision !== input.expectedRevision) throw new Error('任务修订已改变，请先 read_task。');
    if (new Set(input.stepIds).size !== input.stepIds.length || new Set(input.criterionIds).size !== input.criterionIds.length ||
        input.stepIds.some(id => !task.steps.some(step => step.id === id)) || input.criterionIds.some(id => !task.criteria.some(criterion => criterion.id === id))) throw new Error('步骤或条件不属于当前任务。');
    return task;
  };
  const receipt = (revision: number, evidenceId: string, location: Omit<NativeTaskCodeLocation, 'excerpt'>, instructions: ProjectInstructions) => ({
    taskId, revision, evidenceId, source: 'location', status: 'unverified', location, projectInstructions: instructionOutput(instructions),
    note: 'Saved historical file observation. This does not verify acceptance or prove the current file is unchanged.',
  });
  return {
    definitions: [structuredClone(definition)],
    async prepare(call, context) {
      if (call.name !== definition.name || !call.id || call.id.length > 256 || call.id.includes('\0') || Buffer.byteLength(call.arguments) > 16 * 1024 || context.maxOutputBytes < 2048) throw new Error('位置工具参数超出限制。');
      await guard(context);
      const previous = states.get(call.id);
      if (previous) {
        if (encode(previous.prepared.call) !== encode(call)) throw new Error('位置调用标识已使用。');
        stateFor(previous.prepared, context); return structuredClone(previous.prepared);
      }
      if (states.size >= 200 || preparedBytes + Buffer.byteLength(call.arguments) > 1024 * 1024) throw new Error('位置工具调用缓存已满。');
      const raw = JSON.parse(call.arguments), input = schema.parse(raw);
      if (encode(input) !== encode(raw) || normalizeProjectPath(input.path) !== input.path || isSensitivePath(input.path) || input.endLine < input.startLine || input.endLine - input.startLine >= 80) throw new Error('位置工具参数或行范围无效。');
      credentials(input); taskFor(input);
      const instructions = await load(input.path, context.signal); credentials(instructions);
      // Reserve a bounded receipt before writing: success can never be truncated
      // after a durable metadata mutation simply because instructions were large.
      const largestReceipt = receipt(Number.MAX_SAFE_INTEGER, `location-${'f'.repeat(40)}`, {
        path: input.path, startLine: input.startLine, endLine: input.endLine, fileHash: input.expectedHash,
        fileBytes: 1024 * 1024, excerptHash: 'f'.repeat(64),
      }, instructions);
      if (Buffer.byteLength(encode(largestReceipt)) > context.maxOutputBytes) throw new Error('位置记录与文件作用域指令超过输出预算。');
      const prepared: PreparedTool = { call: structuredClone(call), definition: structuredClone(definition), input: input as unknown as JsonObject,
        inputDigest: digest(input), policyRevision: context.policyRevision, requiresApproval: false,
        preconditions: { taskId, interaction: 'task_location', instructionDigest: instructions.digest } };
      await guard(context);
      taskFor(input);
      // Independent prepare calls may overlap their scope reads. Recheck the
      // exact-call binding and both capacity bounds after the final await.
      const raced = states.get(call.id);
      if (raced) {
        if (encode(raced.prepared.call) !== encode(call)) throw new Error('位置调用标识已使用。');
        stateFor(raced.prepared, context); return structuredClone(raced.prepared);
      }
      if (states.size >= 200 || preparedBytes + Buffer.byteLength(call.arguments) > 1024 * 1024) throw new Error('位置工具调用缓存已满。');
      states.set(call.id, { prepared: structuredClone(prepared), instructions, maxOutputBytes: context.maxOutputBytes });
      preparedBytes += Buffer.byteLength(call.arguments); return prepared;
    },
    async validate(prepared, context) {
      const state = stateFor(prepared, context); await guard(context, state); stateFor(prepared, context);
      if (!state.execution) taskFor(schema.parse(prepared.input));
    },
    async execute(prepared, context) {
      let state: CallState;
      try { state = stateFor(prepared, context); await guard(context, state); stateFor(prepared, context); }
      catch { return { status: 'not_executed', output: { error: 'code_location_preconditions_changed' } }; }
      if (state.execution) return structuredClone(await state.execution);
      state.execution = (async (): Promise<ToolResult> => {
        const input = schema.parse(prepared.input);
        try {
          const result = await options.session.recordCodeLocation({ taskId, identity, expectedRevision: input.expectedRevision,
            mutationId: `location:${digest({ identity, callId: prepared.call.id })}`, signal: context.signal,
            assertCurrent: () => guard(context, state),
            createEvidence: async task => {
              const location = await readCodeLocation(files, input, context.signal); credentials(location);
              return codeLocationEvidence(task, input, location, prepared.call.id);
            },
            assertEvidenceCurrent: async evidence => {
              const location = await readCodeLocation(files, input, context.signal); credentials(location);
              if (encode(location) !== encode(evidence.location)) throw new Error('文件位置版本已改变。');
              current(context);
            },
          });
          if (result.status === 'revision_changed') return { status: 'not_executed', output: { error: 'task_revision_changed', currentRevision: result.revision, readTask: true } };
          const { excerpt: _excerpt, ...location } = result.evidence.location!;
          const output = receipt(result.task.revision, result.evidence.id, location, state.instructions);
          credentials(output);
          if (Buffer.byteLength(encode(output)) > context.maxOutputBytes) throw new TaskLocationCommitError('位置记录回执超过预算。');
          return { status: 'completed', output: output as unknown as JsonObject };
        } catch (error) {
          if (error instanceof TaskLocationCapacityError) return { status: 'failed', output: { error: 'task_capacity_exceeded' } };
          return error instanceof TaskLocationCommitError
            ? { status: 'unknown', output: { error: 'code_location_commit_unconfirmed' } }
            : { status: 'not_executed', output: { error: 'code_location_preconditions_changed', readTask: true, readFile: true } };
        }
      })();
      return structuredClone(await state.execution);
    },
  };
}
