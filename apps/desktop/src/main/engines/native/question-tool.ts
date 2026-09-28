import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson, type ApprovalDecision, type ApprovalRequest, type JsonObject, type PreparedTool, type RunIdentity, type ToolDefinition, type ToolExecutionContext, type ToolPort, type ToolResult } from '@cc-desk/agent-core';
import { assertNoModelCredential } from '@cc-desk/agent-node/responses-model';
import type { ChatQuestion } from '../../../shared/chat';

const questionSchema = z.object({
  question: z.string().trim().min(1).max(1000),
  header: z.string().max(80).optional(),
  options: z.array(z.object({ label: z.string().trim().min(1).max(160), description: z.string().max(500).optional() }).strict()).max(8),
  multiSelect: z.boolean().optional(),
}).strict();
const inputSchema = z.object({ questions: z.array(questionSchema).min(1).max(3) }).strict();
const definition: ToolDefinition = {
  name: 'ask_user', risk: 'read',
  description: 'Ask the user up to three concise questions when a task needs their input. The options array may be empty; the user can always write a free-text answer. Answers do not authorize any file write, command, or external tool; those operations still require their own approval.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['questions'], properties: { questions: {
    type: 'array', minItems: 1, maxItems: 3, items: { type: 'object', additionalProperties: false, required: ['question', 'options'], properties: {
      question: { type: 'string', minLength: 1, maxLength: 1000 }, header: { type: 'string', maxLength: 80 },
      multiSelect: { type: 'boolean' }, options: { type: 'array', maxItems: 8, items: { type: 'object', additionalProperties: false, required: ['label'], properties: {
        label: { type: 'string', minLength: 1, maxLength: 160 }, description: { type: 'string', maxLength: 500 },
      } } },
    } },
  } } },
};
const encode = (value: unknown) => canonicalJson(JSON.parse(JSON.stringify(value)));
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
interface QuestionState { prepared: PreparedTool; answers?: Record<string, string>; answerExpiresAt?: number; result?: ToolResult }
export interface NativeQuestionTool extends ToolPort {
  questions(request: ApprovalRequest): ChatQuestion[];
  answer(request: ApprovalRequest, answers: unknown): void;
}

/** Answers remain in the trusted host until the core has durably prepared this exact call. */
export function createQuestionTool(options: {
  identity: RunIdentity; forbiddenValues: string[]; assertOwnership(): Promise<void>;
}): NativeQuestionTool {
  const states = new Map<string, QuestionState>();
  const identity = encode(options.identity);
  const credentials = (value: unknown) => { for (const secret of options.forbiddenValues) assertNoModelCredential(value, secret); };
  const current = (prepared: PreparedTool, context: ToolExecutionContext) => {
    if (context.signal.aborted || encode(context.identity) !== identity || context.policyRevision !== prepared.policyRevision) throw new Error('提问归属已失效。');
    const state = states.get(prepared.call.id);
    if (!state || encode(state.prepared) !== encode(prepared)) throw new Error('提问参数已改变。');
    return state;
  };
  const requested = (request: ApprovalRequest) => {
    const state = states.get(request.binding.toolCallId);
    if (!state || state.result || encode(request.binding) !== encode({ ...options.identity, toolCallId: state.prepared.call.id, inputDigest: state.prepared.inputDigest, policyRevision: state.prepared.policyRevision }) ||
        encode(request.tool) !== encode(state.prepared.definition) || encode(request.input) !== encode(state.prepared.input) || encode(request.preconditions) !== encode(state.prepared.preconditions)) throw new Error('提问已结束或不属于当前运行。');
    return state;
  };
  return {
    definitions: [structuredClone(definition)],
    async prepare(call, context) {
      if (call.name !== definition.name || !call.id || states.has(call.id) || states.size >= 200 || Buffer.byteLength(call.arguments) > 32 * 1024) throw new Error('提问参数无效。');
      if (context.signal.aborted || encode(context.identity) !== identity) throw new Error('提问归属已失效。');
      await options.assertOwnership();
      const raw = JSON.parse(call.arguments), input = inputSchema.parse(raw);
      // Do not silently rewrite the model's exact input before core digest validation.
      if (encode(raw) !== encode(input) || new Set(input.questions.map(item => item.question)).size !== input.questions.length || input.questions.some(item =>
        Object.hasOwn(Object.prototype, item.question) || new Set(item.options.map(option => option.label)).size !== item.options.length ||
        item.multiSelect && item.options.some(option => option.label.includes(', ')))) throw new Error('提问或选项重复、为空或包含不支持的名称与分隔符。');
      credentials(input);
      const prepared: PreparedTool = { call: structuredClone(call), definition: structuredClone(definition), input: input as JsonObject,
        inputDigest: digest(encode(input)), policyRevision: context.policyRevision, requiresApproval: true, preconditions: { interaction: 'user_question' } };
      states.set(call.id, { prepared: structuredClone(prepared) });
      return prepared;
    },
    async validate(prepared, context) { current(prepared, context); await options.assertOwnership(); current(prepared, context); },
    questions(request) { return structuredClone(inputSchema.parse(requested(request).prepared.input).questions); },
    answer(request, answers) {
      const state = requested(request);
      if (!Number.isFinite(request.expiresAt) || request.expiresAt <= Date.now() || state.answers) throw new Error('提问已过期或已经回答。');
      if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw new Error('请回答全部问题。');
      const questions = inputSchema.parse(state.prepared.input).questions;
      const entries = Object.entries(answers);
      if (entries.length !== questions.length || entries.some(([key, value]) => !questions.some(item => item.question === key) || typeof value !== 'string' || !value.trim() || value.length > 4000) || Buffer.byteLength(JSON.stringify(answers)) > 16 * 1024) throw new Error('回答缺失、超出限制或包含未知问题。');
      const accepted = Object.fromEntries(entries) as Record<string, string>;
      try { credentials(accepted); } catch { throw new Error('回答包含当前连接的凭据，不能提交给模型。'); }
      state.answers = accepted;
      state.answerExpiresAt = request.expiresAt;
    },
    async execute(prepared, context, approval?: ApprovalDecision) {
      let state: QuestionState;
      try {
        state = current(prepared, context); await options.assertOwnership(); current(prepared, context);
        if (!approval || approval.decision !== 'approved' || approval.expiresAt !== state.answerExpiresAt || approval.expiresAt <= Date.now() || encode(approval.binding) !== encode({ ...options.identity, toolCallId: prepared.call.id, inputDigest: prepared.inputDigest, policyRevision: prepared.policyRevision }) || !state.answers) throw new Error('无有效回答。');
      } catch { return { status: 'not_executed', output: { error: 'question_answer_unavailable' } }; }
      if (state.result) return structuredClone(state.result);
      const result: ToolResult = { status: 'completed', output: { answers: structuredClone(state.answers!) } };
      if (Buffer.byteLength(JSON.stringify(result.output)) > context.maxOutputBytes) return { status: 'failed', output: { error: 'question_answer_exceeds_output_budget' } };
      state.result = result;
      return structuredClone(result);
    },
  };
}
