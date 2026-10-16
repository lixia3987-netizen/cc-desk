import type { ChatMessage, ChatQueueSnapshot } from '../shared/chat';
import type { Attachment } from '../shared/types';

export interface PendingChatSubmission {
  requestId: string;
  draft: string;
  text: string;
  files: Attachment[];
  nativeTaskId?: string;
  messageId?: string;
  status: 'submitting' | 'accepted' | 'failed';
  error?: string;
  /** 已在宿主队列或正式消息中看到；IPC 尚未结束时仍保留用于同步门禁。 */
  observed?: boolean;
}

interface SubmissionRecord {
  value: PendingChatSubmission;
  inFlight: boolean;
  visible: boolean;
  /** IPC 未明确确认时，即使宿主已投影消息，重试也必须使用同一幂等身份。 */
  retryable: boolean;
}
interface SessionSubmissions {
  records: Map<string, SubmissionRecord>;
  canonicalIds: Set<string>;
  observedIds: Set<string>;
  snapshot: readonly PendingChatSubmission[];
}
const empty: readonly PendingChatSubmission[] = Object.freeze([]);
const maxRememberedIds = 512;
const maxHiddenRetries = 8;

function remember(ids: Set<string>, id: string): void {
  ids.delete(id);
  ids.add(id);
  if (ids.size > maxRememberedIds) ids.delete(ids.values().next().value!);
}

function samePayload(record: PendingChatSubmission, draft: string, files: readonly Attachment[], nativeTaskId?: string): boolean {
  return record.draft === draft && record.nativeTaskId === nativeTaskId
    && record.files.length === files.length && record.files.every((file, index) => {
      const next = files[index];
      return file.path === next.path && file.name === next.name && file.bytes === next.bytes;
    });
}

/** 同一帧内按宿主身份去重，不等待订阅 effect，也不按消息内容猜测身份。 */
export function visibleChatSubmissions(
  records: readonly PendingChatSubmission[], queue?: ChatQueueSnapshot, messages?: readonly ChatMessage[],
): readonly PendingChatSubmission[] {
  const canonicalIds = new Set(messages?.filter(message => message.role === 'user').map(message => message.submissionId));
  const visible = records.filter(record => !record.observed
    && !queue?.items.some(item => item.clientRequestId === record.requestId || (record.messageId !== undefined && item.id === record.messageId))
    && !queue?.receipts?.some(receipt => receipt.requestId === record.requestId || (record.messageId !== undefined && receipt.messageId === record.messageId))
    && !(record.messageId !== undefined && canonicalIds.has(record.messageId)));
  return visible.length === records.length ? records : visible;
}

/**
 * Renderer 生命周期内的提交回执与重试身份。按会话（可含上下文代次）存储，
 * 不随聊天面板卸载而丢失；只投影临时 UI，绝不修改宿主快照。
 */
export class ChatSubmissionState {
  private readonly sessions = new Map<string, SessionSubmissions>();
  private readonly listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot(sessionId: string): readonly PendingChatSubmission[] {
    return this.sessions.get(sessionId)?.snapshot ?? empty;
  }

  hasInFlight(sessionId: string): boolean {
    return [...(this.sessions.get(sessionId)?.records.values() ?? [])].some(record => record.inFlight);
  }

  /** 持久队列或正式用户消息提供的接收证明，适用于 IPC 确认丢失后的界面收尾。 */
  isObserved(sessionId: string, requestId: string): boolean {
    const session = this.sessions.get(sessionId);
    return session?.records.get(requestId)?.value.observed === true || session?.observedIds.has(requestId) === true;
  }

  /** 供异步提交在绘制反馈后核对来源上下文是否仍然存在。 */
  hasScope(sessionId: string): boolean { return this.sessions.has(sessionId); }

  begin(sessionId: string, draft: string, files: readonly Attachment[], nativeTaskId?: string): PendingChatSubmission | undefined {
    if (this.hasInFlight(sessionId) || (!draft.trim() && !files.length)) return undefined;
    const session = this.session(sessionId);
    const retry = [...session.records.values()].find(record => record.retryable
      && samePayload(record.value, draft, files, nativeTaskId));
    // 新的显式提交取代旧错误卡；保留其不可变身份，以便返回原稿重试时不重复执行。
    for (const record of session.records.values()) if (record.value.status === 'failed') record.visible = false;
    const capturedFiles = structuredClone([...files]);
    for (const file of capturedFiles) Object.freeze(file);
    Object.freeze(capturedFiles);
    const value: PendingChatSubmission = Object.freeze({
      requestId: retry?.value.requestId ?? crypto.randomUUID(), draft, text: draft.trim(),
      files: capturedFiles, ...(nativeTaskId === undefined ? {} : { nativeTaskId }), status: 'submitting',
      ...(retry?.value.messageId === undefined ? {} : { messageId: retry.value.messageId }),
      ...(retry?.value.observed ? { observed: true } : {}),
    });
    session.records.delete(value.requestId);
    session.records.set(value.requestId, { value, inFlight: true, visible: true, retryable: false });
    this.publish(session);
    return value;
  }

  accepted(sessionId: string, requestId: string, messageId?: string): boolean {
    const session = this.sessions.get(sessionId), record = session?.records.get(requestId);
    if (!session || !record) return session?.observedIds.has(requestId) === true;
    const acceptedId = record.value.messageId ?? messageId;
    if (acceptedId === undefined) return false;
    this.update(record, {
      messageId: acceptedId, status: 'accepted', error: undefined,
      observed: record.value.observed || session.canonicalIds.has(acceptedId) || undefined,
    });
    record.inFlight = false;
    record.retryable = false;
    this.publish(session);
    return true;
  }

  failed(sessionId: string, requestId: string, error: string): void {
    const session = this.sessions.get(sessionId), record = session?.records.get(requestId);
    if (!session || !record || !record.inFlight) return;
    // 队列先于 ACK 证明已经接收时，丢失/失败的 ACK 不得把消息还原成可重发错误卡。
    this.update(record, record.value.observed ? { status: 'accepted', error: undefined } : { status: 'failed', error });
    record.inFlight = false;
    record.retryable = true;
    this.publish(session);
  }

  reconcile(sessionId: string, queue?: ChatQueueSnapshot, messages?: readonly ChatMessage[]): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    for (const message of messages ?? []) if (message.role === 'user' && message.submissionId) remember(session.canonicalIds, message.submissionId);
    for (const record of session.records.values()) {
      const queued = queue?.items.find(item => item.clientRequestId === record.value.requestId
        || (record.value.messageId !== undefined && item.id === record.value.messageId));
      const receipt = queue?.receipts?.find(item => item.requestId === record.value.requestId
        || (record.value.messageId !== undefined && item.messageId === record.value.messageId));
      const messageId = queued?.id ?? receipt?.messageId ?? record.value.messageId;
      if (queued || receipt || (messageId !== undefined && session.canonicalIds.has(messageId))) {
        this.update(record, { messageId, observed: true });
      }
    }
    this.publish(session);
  }

  /** 删除会话时释放数据；旧 Promise 的迟到回执不会创建或恢复已删除记录。 */
  clear(sessionId: string): void {
    if (this.sessions.delete(sessionId)) this.emit();
  }

  /** App 只传入仍存在的会话与上下文代次，清除删除或重建前的临时内容。 */
  retain(scopes: readonly string[]): void {
    const keep = new Set(scopes);
    let changed = false;
    for (const scope of this.sessions.keys()) if (!keep.has(scope)) { this.sessions.delete(scope); changed = true; }
    if (changed) this.emit();
  }

  private session(sessionId: string): SessionSubmissions {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = { records: new Map(), canonicalIds: new Set(), observedIds: new Set(), snapshot: empty };
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  private update(record: SubmissionRecord, patch: Partial<PendingChatSubmission>): void {
    if (Object.entries(patch).some(([key, value]) => record.value[key as keyof PendingChatSubmission] !== value)) {
      record.value = Object.freeze({ ...record.value, ...patch });
    }
  }

  private publish(session: SessionSubmissions): void {
    // 已确认并由宿主接管的消息立即释放完整草稿与附件，只保留有界的接收证明。
    for (const [requestId, record] of session.records) {
      if (record.value.observed) remember(session.observedIds, requestId);
      if (record.value.observed && record.value.status === 'accepted' && !record.inFlight && !record.retryable) session.records.delete(requestId);
    }
    // 当前卡片和正在发送的内容不淘汰，历史错误仅保留最近几份不可变重试内容。
    const hiddenRetries = [...session.records.entries()].filter(([, record]) => record.retryable && !record.inFlight
      && (!record.visible || record.value.observed));
    for (const [requestId] of hiddenRetries.slice(0, -maxHiddenRetries)) session.records.delete(requestId);
    const next = [...session.records.values()].filter(record => record.visible && (!record.value.observed || record.inFlight)).map(record => record.value);
    if (next.length === session.snapshot.length && next.every((value, index) => value === session.snapshot[index])) return;
    session.snapshot = next.length ? Object.freeze(next) : empty;
    this.emit();
  }

  private emit(): void { for (const listener of this.listeners) listener(); }
}

export const chatSubmissionState = new ChatSubmissionState();
