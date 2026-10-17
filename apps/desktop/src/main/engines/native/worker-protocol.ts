import { ToolPreparationError, validateToolPreparationFeedback, type AgentRunRequest, type RunIdentity, type ToolDefinition, type ToolPreparationFeedback } from '@cc-desk/agent-core';
import type { NativeModelOptions } from '@cc-desk/agent-node/native-model';

export const WORKER_PROTOCOL = 1;
export const MAX_WORKER_MESSAGE_BYTES = 16 * 1024 * 1024;
export const MAX_WORKER_PENDING = 32;
export interface WorkerStart {
  type: 'start'; version: 1;
  request: Omit<AgentRunRequest, 'signal'>;
  model: NativeModelOptions;
  definitions: ToolDefinition[];
  contextMaintenance?: boolean;
  sharedBudget?: boolean;
  completionValidation?: boolean;
  activePaused?: boolean;
}
export interface WorkerActivePause { type: 'active_pause'; version: 1; identity: RunIdentity; paused: boolean }
export interface WorkerEnvelope { version: 1; identity: RunIdentity; seq: number }
export interface WorkerRequest extends WorkerEnvelope { type: 'request'; requestId: string; method: string; args: unknown }
export interface WorkerPreparationFailure { callId: string; feedback: ToolPreparationFeedback }
export interface WorkerReply extends WorkerEnvelope { type: 'reply'; requestId: string; value?: unknown; error?: string; preparationFailure?: WorkerPreparationFailure }
/** RPC 不传 Error 实例或异常文本，只接收当前准备调用的严格固定反馈。 */
export function checkedPreparationFailure(value: unknown, expectedCallId: string): ToolPreparationFeedback {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid tool preparation reply.');
    const prototype = Object.getPrototypeOf(value), descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
    if ((prototype !== Object.prototype && prototype !== null) || keys.length !== 2 || keys.some(key => typeof key !== 'string' || !['callId', 'feedback'].includes(key) ||
      !('value' in descriptors[key as string]) || !descriptors[key as string].enumerable) || descriptors.callId?.value !== expectedCallId ||
      !validateToolPreparationFeedback(descriptors.feedback?.value)) throw new Error('Invalid tool preparation reply.');
    // The constructor snapshots primitive descriptors. Never spread the original value:
    // a Proxy could pass descriptor validation, then execute getters during spreading.
    return { ...new ToolPreparationError(descriptors.feedback.value).feedback };
  } catch { throw new Error('Invalid tool preparation reply.'); }
}
export function sameRun(a: RunIdentity, b: RunIdentity) {
  return a.sessionId === b.sessionId && a.conversationId === b.conversationId && a.runId === b.runId && a.requestId === b.requestId && a.workerGeneration === b.workerGeneration;
}
export function checkedMessage(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('无效 native worker 消息。');
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > MAX_WORKER_MESSAGE_BYTES) throw new Error('native worker 消息超过限制。');
  return value as Record<string, unknown>;
}
