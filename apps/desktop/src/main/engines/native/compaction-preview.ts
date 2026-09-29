import { contextHasUserImages, type JsonValue, type ModelContext } from '@cc-desk/agent-core';
import { RunStoreError, type ContextCompactionSource } from '@cc-desk/agent-node/run-store';
import type { NativeContextCompactionPreview } from '../../../shared/chat';

const unavailable = (): NativeContextCompactionPreview => ({ status: 'unavailable', reason: 'unavailable' });
const object = (value: JsonValue): value is { [key: string]: JsonValue } => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Input is the host's validated ledger source, never a renderer projection. */
export function nativeCompactionPreview(source: ContextCompactionSource): NativeContextCompactionPreview {
  try {
    const { context, retainedContext } = source;
    const supported = (value: ModelContext) => value?.protocol?.version === 1
      && ['openai-responses', 'openai-chat-completions'].includes(value.protocol.id)
      && Array.isArray(value.items) && value.items.length > 0;
    if (!supported(context) || !supported(retainedContext) || context.protocol.id !== retainedContext.protocol.id
      || source.scope !== 'prefix' || contextHasUserImages(context)) return unavailable();
    const summarizableBytes = Buffer.byteLength(JSON.stringify(context));
    const retainedBytes = Buffer.byteLength(JSON.stringify(retainedContext));
    let retainedImages = 0;
    const imageType = retainedContext.protocol.id === 'openai-chat-completions' ? 'image_url' : 'input_image';
    for (const item of retainedContext.items) {
      if (!object(item)) return unavailable();
      if (item.role === 'user' && Array.isArray(item.content)) {
        retainedImages += item.content.filter(part => object(part) && part.type === imageType).length;
      }
    }
    // Only whitelisted scalars cross the snapshot boundary. These independently
    // serialized sizes overlap at the original goal and are not net savings.
    return { status: 'available', summarizableBytes, retainedBytes, retainedImages,
      retention: retainedImages ? 'image_suffix' : 'recent_turns' };
  } catch { return unavailable(); }
}

/** Never expose thrown messages: they may contain local paths or provider data. */
export function unavailableCompactionPreview(error: unknown): NativeContextCompactionPreview {
  if (!(error instanceof RunStoreError)) return unavailable();
  switch (error.code) {
    case 'nothing_to_compact': return { status: 'unavailable', reason: 'no_complete_prefix' };
    case 'image_context_compaction_unsupported': return { status: 'unavailable', reason: 'image_prefix_unavailable' };
    case 'conversation_busy': return { status: 'unavailable', reason: 'busy' };
    case 'recovery_required': return { status: 'unavailable', reason: 'recovery_required' };
    case 'unsupported_protocol': case 'pending_tools': return { status: 'unavailable', reason: 'unsupported_context' };
    default: return unavailable();
  }
}
