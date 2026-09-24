import type { ChatHistory } from '../../chat-history';
import { object, string, type WireObject } from '../../chat-protocol';
import { contextCapacity, reportedContext, requestContext, type ContextUsage } from '../../../shared/claude-session';
import type { Entry } from './entry';

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

  observe(id: string, entry: Entry, payload: WireObject, report?: unknown) {
    if (!entry.turn) return; // Late old-turn frames cannot overwrite the next baseline.
    const snapshot = this.history.get(id);
    const reported = reportedContext(report, snapshot.context, new Date().toISOString());
    if (reported) {
      const model = this.model(id, entry);
      this.publish(id, { ...reported, requestModel: model, selectionModel: model ?? reported.selectionModel }); return;
    }
    // Compaction's summarization request describes the old window.
    if (entry.turn.command === 'compact' || snapshot.context?.status === 'compacting') return;
    const model = this.model(id, entry, string(payload.model));
    const messageId = string(payload.id), incoming = object(payload.usage);
    const hasUsage = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'].some(key => incoming[key] !== undefined);
    const usage = !hasUsage ? undefined : messageId && entry.contextRequest?.id === messageId ? { ...entry.contextRequest.usage, ...incoming } : incoming;
    const context = requestContext(snapshot.context, usage, model, new Date().toISOString());
    if (context && messageId && usage) entry.contextRequest = { id: messageId, usage };
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
