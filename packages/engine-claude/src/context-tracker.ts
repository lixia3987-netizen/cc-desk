import type { ClaudeHistory as ChatHistory } from './host.js';
import { object, string, type WireObject } from './chat-protocol.js';
import { contextCapacity, reportedContext, requestContext, tokenCount, type ContextUsage } from './claude-session.js';
import type { ContextObservationSource, Entry } from './entry.js';

const inputFields = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'] as const;

/** 用量随根任务请求更新；整个交互轮次的容量身份保持不变。 */
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
    // 新进程可能直到标准输入收到首条提示词后才报告 init。
    // 后续 init 帧描述下一次选择，不表示当前交互轮次已改变。
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
      // 旧版 CLI 可能省略 init：优先使用派发时捕获的配置，
      // 再将首个根任务响应一次性绑定为唯一可用身份。
      turn.contextModel = turn.configuredModel || responseModel || undefined;
      if (turn.contextModel) this.bind(id, turn.contextModel);
    }
    return turn.contextModel;
  }

  private bind(id: string, model: string) {
    const previous = this.history.get(id).context;
    if (previous?.requestModel === model && previous.selectionModel === model) return;
    // 旧日志将 requestModel 绑定到响应路由名称。将报告带入
    // 新交互轮次时，以已保存的 CLI 选择为准。
    const known = previous?.selectionModel ?? previous?.requestModel ?? (previous?.source === 'request' ? previous.model : undefined);
    this.publish(id, { status: 'unknown', ...(known && known !== model ? { model } : previous), requestModel: model, selectionModel: model });
  }

  observe(id: string, entry: Entry, payload: WireObject, report?: unknown, source: ContextObservationSource = 'assistant') {
    if (!entry.turn) return; // 仅在交互轮次活跃期间读取用量。
    const snapshot = this.history.get(id);
    const reported = reportedContext(report, snapshot.context, new Date().toISOString());
    if (reported) {
      const model = this.model(id, entry);
      this.publish(id, { ...reported, requestModel: model, selectionModel: model ?? reported.selectionModel }); return;
    }
    // 压缩过程中的摘要请求描述的是旧上下文窗口。
    if (entry.turn.command === 'compact' || snapshot.context?.status === 'compacting') return;
    const model = this.model(id, entry, string(payload.model));
    const previous = entry.contextRequest;
    // 流活跃时，旧版完整封包可能省略 API ID。
    const streamId = source === 'assistant' ? entry.assistant.currentMessageId() : undefined;
    const messageId = string(payload.id) || (streamId && streamId === previous?.id ? streamId : '');
    const incoming = object(payload.usage);
    const sameMessage = Boolean(messageId && previous?.id === messageId);
    // 增量必须属于最近的交互轮次、重置或压缩边界后观测到的开始事件；
    // 延迟封包不能将当前请求切回更早的流式请求。
    if (source === 'message_delta' && (!sameMessage || !previous?.streamed)) return;
    if (source === 'assistant' && messageId && !sameMessage && entry.assistant.hasMessage(messageId)) return;
    if (messageId && !sameMessage) entry.contextRequest = { id: messageId, usage: {}, streamed: source === 'message_start' };
    else if (source === 'message_start' && previous) previous.streamed = true;
    else if (source === 'assistant' && !messageId) entry.contextRequest = undefined;

    let fields = inputFields.filter(key => incoming[key] !== undefined);
    if (!fields.length || fields.some(key => tokenCount(incoming[key]) === undefined)) return;
    // 某些 CLI 最初显式发出 0/0 占位值，随后在 message_delta
    // 中报告真实输入用量。不要用这些零值初始化待处理输入。
    // 缓存命中、旧版仅输入为零的报告，以及权威增量中的零值
    // 仍然是有效测量值。
    if (source !== 'message_delta' && incoming.input_tokens === 0 && incoming.output_tokens === 0 &&
      inputFields.slice(1).every(key => incoming[key] === undefined || incoming[key] === 0)) return;
    // 封包可以补全缺失的缓存项，但不能撤销该消息的增量
    // 已报告的缓存项。
    if (sameMessage && source !== 'message_delta') fields = fields.filter(key => !previous?.deltaFields?.includes(key));
    if (!fields.length) return;
    const usage = { ...(sameMessage ? previous?.usage : {}), ...Object.fromEntries(fields.map(key => [key, incoming[key]])) };
    const context = requestContext(snapshot.context, usage, model, new Date().toISOString());
    const measured = tokenCount(usage.input_tokens) !== undefined && context?.source === 'request' && context.status === 'ready';
    // 无效总量不得污染先前有效的逐消息基线。
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
      // /clear 会丢弃用量，但新结果元数据仍可以报告当前模型的
      // 上下文窗口。保留该窗口绑定，不恢复旧用量。
      if (model) this.bind(id, model);
      this.publish(id, { status: 'unknown', ...this.history.get(id).context, contextWindow: capacity });
    }
  }
}
