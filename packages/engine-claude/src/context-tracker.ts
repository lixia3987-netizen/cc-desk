import type { ClaudeHistory as ChatHistory } from './host.js';
import { object, string, type WireObject } from './chat-protocol.js';
import { contextCapacity, reportedContext, requestContext, tokenCount, type ContextUsage } from './claude-session.js';
import type { ContextObservationSource, Entry } from './entry.js';

const inputFields = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'] as const;

/** Usage follows root requests; the capacity identity stays fixed for the whole turn. */
export class ClaudeContext {
  constructor(private history: Pick<ChatHistory, 'get'>, private publish: (id: string, context: ContextUsage) => void) {}

  begin(id: string, entry: Entry, configuredModel: string) {
    if (!entry.turn) return;
    entry.turn.configuredModel = configuredModel || undefined;
    entry.turn.contextModel = entry.selectionModel;
    entry.contextRequest = undefined;
    if (entry.turn.contextModel) this.bind(id, entry.turn.contextModel);
  }

  selection(id: string, entry: Entry, model: string) {
    if (!model) return;
    entry.selectionModel = model;
    // A new process may report init only after stdin receives the first prompt.
    // Later init frames describe the next selection, not a different current turn.
    if (entry.turn) {
      if (entry.turn.contextModel) return;
      entry.turn.contextModel = model;
    }
    this.bind(id, model);
  }

  private model(id: string, entry: Entry, responseModel?: string) {
    const turn = entry.turn;
    if (!turn) return;
    if (!turn.contextModel) {
      // Older CLIs can omit init: prefer the configuration captured at dispatch,
      // then bind once to the first root response as the only available identity.
      turn.contextModel = turn.configuredModel || responseModel || undefined;
      if (turn.contextModel) this.bind(id, turn.contextModel);
    }
    return turn.contextModel;
  }

  private bind(id: string, model: string) {
    const previous = this.history.get(id).context;
    if (previous?.requestModel === model && previous.selectionModel === model) return;
    // Older journals bound requestModel to a routed response name. The saved
    // CLI selection is authoritative when carrying a report into the new turn.
    const known = previous?.selectionModel ?? previous?.requestModel ?? (previous?.source === 'request' ? previous.model : undefined);
    this.publish(id, { status: 'unknown', ...(known && known !== model ? { model } : previous), requestModel: model, selectionModel: model });
  }

  observe(id: string, entry: Entry, payload: WireObject, report?: unknown, source: ContextObservationSource = 'assistant') {
    if (!entry.turn) return; // Only consume usage while a turn is active.
    const snapshot = this.history.get(id);
    const reported = reportedContext(report, snapshot.context, new Date().toISOString());
    if (reported) {
      const model = this.model(id, entry);
      this.publish(id, { ...reported, requestModel: model, selectionModel: model ?? reported.selectionModel }); return;
    }
    // Compaction's summarization request describes the old window.
    if (entry.turn.command === 'compact' || snapshot.context?.status === 'compacting') return;
    const model = this.model(id, entry, string(payload.model));
    const previous = entry.contextRequest;
    // Older complete envelopes may omit their API ID while a stream is active.
    const streamId = source === 'assistant' ? entry.assistant.currentMessageId() : undefined;
    const messageId = string(payload.id) || (streamId && streamId === previous?.id ? streamId : '');
    const incoming = object(payload.usage);
    const sameMessage = Boolean(messageId && previous?.id === messageId);
    // A delta must belong to a start observed after the latest turn/reset/compact
    // boundary. Late envelopes cannot switch us back to an older streamed request.
    if (source === 'message_delta' && (!sameMessage || !previous?.streamed)) return;
    if (source === 'assistant' && messageId && !sameMessage && entry.assistant.hasMessage(messageId)) return;
    if (messageId && !sameMessage) entry.contextRequest = { id: messageId, usage: {}, streamed: source === 'message_start' };
    else if (source === 'message_start' && previous) previous.streamed = true;
    else if (source === 'assistant' && !messageId) entry.contextRequest = undefined;

    let fields = inputFields.filter(key => incoming[key] !== undefined);
    if (!fields.length || fields.some(key => tokenCount(incoming[key]) === undefined)) return;
    // Some CLIs initially emit explicit 0/0 placeholders, then report real
    // input usage at message_delta. Do not seed pending input from those zeros.
    // A cache hit, a legacy input-only zero, and an authoritative delta zero
    // remain valid measurements.
    if (source !== 'message_delta' && incoming.input_tokens === 0 && incoming.output_tokens === 0 &&
      inputFields.slice(1).every(key => incoming[key] === undefined || incoming[key] === 0)) return;
    // Envelopes may fill missing cache components, but cannot undo components
    // already reported by a delta for this message.
    if (sameMessage && source !== 'message_delta') fields = fields.filter(key => !previous?.deltaFields?.includes(key));
    if (!fields.length) return;
    const usage = { ...(sameMessage ? previous?.usage : {}), ...Object.fromEntries(fields.map(key => [key, incoming[key]])) };
    const context = requestContext(snapshot.context, usage, model, new Date().toISOString());
    const measured = tokenCount(usage.input_tokens) !== undefined && context?.source === 'request' && context.status === 'ready';
    // Invalid totals must not poison an earlier valid per-message baseline.
    if (usage.input_tokens !== undefined && !measured) return;
    if (messageId) entry.contextRequest = {
      id: messageId, usage, streamed: source === 'message_start' || (sameMessage && previous?.streamed),
      deltaFields: source === 'message_delta' ? [...new Set([...(sameMessage ? previous?.deltaFields ?? [] : []), ...fields])]
        : sameMessage ? previous?.deltaFields : undefined,
    };
    if (context) this.publish(id, context);
  }

  capacity(id: string, entry: Entry, modelUsage: unknown) {
    const model = this.model(id, entry);
    const capacity = contextCapacity(modelUsage, model);
    if (capacity) {
      // /clear discards usage, but fresh result metadata can still report the
      // current model's window. Keep that window bound without reviving old usage.
      if (model) this.bind(id, model);
      this.publish(id, { status: 'unknown', ...this.history.get(id).context, contextWindow: capacity });
    }
  }
}
