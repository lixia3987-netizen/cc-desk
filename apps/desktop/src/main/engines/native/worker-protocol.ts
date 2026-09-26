import type { AgentRunRequest, RunIdentity, ToolDefinition } from '@cc-desk/agent-core';
import type { ResponsesModelOptions } from '@cc-desk/agent-node/responses-model';

export const WORKER_PROTOCOL = 1;
export const MAX_WORKER_MESSAGE_BYTES = 16 * 1024 * 1024;
export const MAX_WORKER_PENDING = 32;
export interface WorkerStart {
  type: 'start'; version: 1;
  request: Omit<AgentRunRequest, 'signal'>;
  model: ResponsesModelOptions;
  definitions: ToolDefinition[];
}
export interface WorkerEnvelope { version: 1; identity: RunIdentity; seq: number }
export interface WorkerRequest extends WorkerEnvelope { type: 'request'; requestId: string; method: string; args: unknown }
export interface WorkerReply extends WorkerEnvelope { type: 'reply'; requestId: string; value?: unknown; error?: string }
export function sameRun(a: RunIdentity, b: RunIdentity) {
  return a.sessionId === b.sessionId && a.conversationId === b.conversationId && a.runId === b.runId && a.requestId === b.requestId && a.workerGeneration === b.workerGeneration;
}
export function checkedMessage(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('无效 native worker 消息。');
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > MAX_WORKER_MESSAGE_BYTES) throw new Error('native worker 消息超过限制。');
  return value as Record<string, unknown>;
}
