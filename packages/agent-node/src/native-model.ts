import type { JsonValue, ModelContext, ModelPort, ProtocolVersion, ToolDefinition } from '@cc-desk/agent-core';
import { ResponsesModel, estimateResponsesInputTokens, type ResponsesModelOptions } from './responses-model.js';
import { ChatCompletionsModel, estimateChatCompletionsInputTokens } from './chat-completions-model.js';

export type NativeModelProtocol = 'responses' | 'chat-completions';
/** Optional discriminator preserves existing Responses connection and worker callers. */
export interface NativeModelOptions extends ResponsesModelOptions { protocol?: NativeModelProtocol }

export function nativeModelProtocol(protocol: NativeModelProtocol = 'responses'): ProtocolVersion {
  if (protocol === 'responses') return { id: 'openai-responses', version: 1 };
  if (protocol === 'chat-completions') return { id: 'openai-chat-completions', version: 1 };
  throw new Error('Unsupported native model protocol.');
}
export function createNativeModel(options: NativeModelOptions): ModelPort {
  const { protocol = 'responses', ...transport } = options;
  if (protocol === 'responses') return new ResponsesModel(transport);
  if (protocol === 'chat-completions') return new ChatCompletionsModel(transport);
  throw new Error('Unsupported native model protocol.');
}
/** Uses the persisted context discriminator, never a mutable connection's current value. */
export function estimateNativeInputTokens(context: ModelContext, instructions = '', tools: readonly ToolDefinition[] = []): number {
  if (context.protocol.version === 1 && context.protocol.id === 'openai-responses') return estimateResponsesInputTokens(context, instructions, tools);
  if (context.protocol.version === 1 && context.protocol.id === 'openai-chat-completions') return estimateChatCompletionsInputTokens(context, instructions, tools);
  throw new Error('Unsupported native model context.');
}
const object = (value: JsonValue): value is { [key: string]: JsonValue } => value !== null && typeof value === 'object' && !Array.isArray(value);
/** Only user-visible assistant text/refusals; never opaque reasoning or tool arguments. */
export function extractNativeAssistantText(items: readonly JsonValue[]): string {
  return items.flatMap(item => {
    if (!object(item)) return [];
    if ((item.type === undefined || item.type === 'message') && item.role === 'assistant') {
      if (typeof item.content === 'string') return [item.content, ...(typeof item.refusal === 'string' ? [item.refusal] : [])];
      if (Array.isArray(item.content)) return item.content.flatMap(part => !object(part) ? [] : part.type === 'output_text' && typeof part.text === 'string' ? [part.text] : part.type === 'refusal' && typeof part.refusal === 'string' ? [part.refusal] : []);
      if (typeof item.refusal === 'string') return [item.refusal];
    }
    if (item.type === 'output_text' && typeof item.text === 'string') return [item.text];
    return [];
  }).join('\n');
}
