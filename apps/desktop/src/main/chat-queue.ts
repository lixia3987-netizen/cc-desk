import { createHash, randomUUID } from 'node:crypto';
import type { ChatQueueSnapshot, ChatSubmission, ChatTurnResult, QueuedChatMessage } from '../shared/chat';
import { ChatQueueStorage, type StoredChatQueue } from './chat-queue-storage';

interface QueueOptions {
  assertAvailable(id: string): void;
  /** Captures host admission generations before a queue operation starts waiting. */
  captureAdmission?(id: string): () => void;
  blocked(id: string): boolean;
  acceptAttachments(id: string, files: string[], commit: (attachmentNames?: string[]) => void): Promise<void>;
  run(id: string, item: QueuedChatMessage): Promise<ChatTurnResult>;
  /** Returns only after the old turn and its process resources have settled. */
  interrupt(id: string): Promise<void>;
  changed(id: string): void;
  /** Invoked after the durable turn ACK, never from inside the executor's send barrier. */
  settled?(id: string): void | Promise<void>;
}
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 4000);

/** Durable per-session FIFO. A control ack is never treated as a completed turn. */
export class ChatQueue {
  private storage: ChatQueueStorage;
  private states = new Map<string, StoredChatQueue>();
  private mutations = new Map<string, Promise<unknown>>();
  private active = new Map<string, Promise<void>>();
  private priorities = new Map<string, { messageId: string; promise: Promise<void> }>();
  private generation = new Map<string, number>();
  private replaced = new Set<string>();
  private scheduled = new Set<string>();
  private failedAcks = new Map<string, { messageId: string; result: ChatTurnResult }>();
  constructor(directory: string, private options: QueueOptions) { this.storage = new ChatQueueStorage(directory); }
  private state(id: string) {
    let state = this.states.get(id);
    if (!state) {
      state = this.storage.load(id);
      if (state.items.length) {
        const uncertain = state.items.some(item => item.status === 'sending');
        state.items.forEach(item => { item.status = 'queued'; });
        state.paused = true;
        state.error = uncertain ? '上次退出时消息仍在执行，是否已完成无法确认。请检查聊天和已产生的操作，移除不应重复执行的消息后再继续。' : '已恢复待发送消息，请确认后继续队列。';
        this.storage.save(id, state);
      }
      this.states.set(id, state);
    }
    return state;
  }
  snapshot(id: string): ChatQueueSnapshot {
    const { items, paused, error } = this.state(id);
    return structuredClone({ items, paused, error });
  }
  private commit(id: string, mutate: (next: StoredChatQueue) => void) {
    const next = structuredClone(this.state(id)); mutate(next);
    this.storage.save(id, next); this.states.set(id, next); this.notify(id);
  }
  private notify(id: string) { try { this.options.changed(id); } catch { /* A closed renderer cannot invalidate an accepted prompt. */ } }
  private async serial<T>(id: string, action: () => T | Promise<T>): Promise<T> {
    const current = (this.mutations.get(id) ?? Promise.resolve()).catch(() => {}).then(action);
    this.mutations.set(id, current);
    try { return await current; } finally { if (this.mutations.get(id) === current) this.mutations.delete(id); }
  }
  private captureAdmission(id: string): () => void {
    const check = this.options.captureAdmission?.(id);
    return () => { check?.(); this.options.assertAvailable(id); };
  }
  async submit(id: string, text: string, attachments: string[] = [], requestId: string = randomUUID()): Promise<ChatSubmission> {
    const assertAdmission = this.captureAdmission(id);
    const epoch = this.generation.get(id) ?? 0;
    return this.serial(id, async () => {
      assertAdmission();
      if ((!text.trim() && !attachments.length) || text.length > 128 * 1024) throw new Error('消息为空或超过 128 KiB 上限。');
      if (attachments.length > 8 || new Set(attachments).size !== attachments.length) throw new Error('最多发送 8 个不同附件。');
      const digest = createHash('sha256').update(JSON.stringify({ text, attachments })).digest('hex');
      const state = this.state(id), receipt = state.receipts.find(item => item.requestId === requestId);
      if (receipt) {
        if (receipt.digest !== digest) throw new Error('同一消息提交标识不能用于不同内容。');
        return { messageId: receipt.messageId };
      }
      if (state.items.length >= 100) throw new Error('最多保留 100 条排队消息，请先移除部分消息。');
      if (attachments.some(file => state.items.some(item => item.attachments.includes(file)))) throw new Error('附件已用于排队或正在发送的消息，请重新添加附件。');
      const item: QueuedChatMessage = { id: randomUUID(), text, attachments: [...attachments], createdAt: new Date().toISOString(), status: 'queued' };
      await this.options.acceptAttachments(id, attachments, attachmentNames => {
        assertAdmission();
        item.attachmentNames = attachmentNames;
        this.commit(id, next => {
          if (!next.items.length && epoch === (this.generation.get(id) ?? 0)) { next.paused = false; delete next.error; }
          next.items.push(item);
          next.receipts.push({ requestId, messageId: item.id, digest });
          const live = new Set(next.items.map(value => value.id));
          while (next.receipts.length > 512) next.receipts.splice(next.receipts.findIndex(value => !live.has(value.messageId)), 1);
        });
      });
      this.wake(id);
      return { messageId: item.id };
    });
  }
  hasPending(id: string) { return this.state(id).items.length > 0 || this.priorities.has(id); }
  hasActive(id: string) { return this.active.has(id) || this.priorities.has(id) || this.failedAcks.has(id); }
  isPrioritizing(id: string) { return this.priorities.has(id); }
  references(id: string, file: string) { return this.state(id).items.some(item => item.attachments.includes(file)); }
  removeAttachment(id: string, file: string, remove: () => Promise<void>) {
    return this.serial(id, async () => {
      if (this.references(id, file)) throw new Error('附件正在被排队或执行中的消息使用，请先移除该排队消息。');
      await remove();
    });
  }
  async remove(id: string, messageId: string) {
    await this.serial(id, () => {
      this.options.assertAvailable(id);
      const item = this.state(id).items.find(value => value.id === messageId);
      if (!item) return;
      if (item.status === 'sending' || this.priorities.get(id)?.messageId === messageId) throw new Error('消息正在发送，请先中断当前任务。');
      this.commit(id, next => { next.items = next.items.filter(value => value.id !== messageId); });
    });
  }
  pause(id: string, error?: string) {
    this.generation.set(id, (this.generation.get(id) ?? 0) + 1);
    // In-memory suspension takes effect even if durable persistence fails.
    const state = this.state(id); state.paused = true;
    if (error) state.error = error;
    this.commit(id, () => {});
  }
  pauseAll(error?: string) {
    this.pauseSessions([...this.states.keys()], error ?? '');
  }
  pauseSessions(ids: readonly string[], reason: string): void {
    const errors: unknown[] = [];
    for (const id of new Set(ids)) { try { this.pause(id, reason); } catch (failure) { errors.push(failure); } }
    if (errors.length) throw new AggregateError(errors, errors.map(messageOf).join('\n'));
  }
  async resume(id: string) {
    const assertAdmission = this.captureAdmission(id);
    const epoch = this.generation.get(id) ?? 0;
    const failedAck = this.failedAcks.get(id);
    if (failedAck) {
      // Retry the acknowledgement, never the already-settled execution.
      await this.complete(id, failedAck.messageId, failedAck.result);
      this.failedAcks.delete(id);
      await this.options.settled?.(id);
    }
    await this.serial(id, () => {
      assertAdmission();
      if (epoch !== (this.generation.get(id) ?? 0)) throw new Error('队列操作已被后续停止取消。');
      if (this.priorities.has(id)) throw new Error('正在中断上一轮，请稍后重试。');
      this.commit(id, next => { next.paused = false; delete next.error; });
      this.wake(id);
    });
  }
  sendNow(id: string, messageId: string): Promise<void> {
    let assertAdmission: () => void;
    try { assertAdmission = this.captureAdmission(id); } catch (error) { return Promise.reject(error); }
    if (this.failedAcks.has(id)) return Promise.reject(new Error('上一轮执行回执尚未保存，请先继续队列以修复回执；不会重复执行已完成任务。'));
    const pending = this.priorities.get(id);
    if (pending) return pending.messageId === messageId ? pending.promise : Promise.reject(new Error('正在发送另一条排队消息，请稍后重试。'));
    const operation = this.prioritize(id, messageId, assertAdmission, this.generation.get(id) ?? 0);
    this.priorities.set(id, { messageId, promise: operation });
    void operation.finally(async () => { this.priorities.delete(id); await this.options.settled?.(id); this.wake(id); }).catch(() => {});
    return operation;
  }
  private async prioritize(id: string, messageId: string, assertAdmission: () => void, capturedGeneration: number) {
    let epoch = 0, selected = false;
    await this.serial(id, () => {
      assertAdmission();
      if (capturedGeneration !== (this.generation.get(id) ?? 0)) throw new Error('队列操作已被后续停止取消。');
      const item = this.state(id).items.find(value => value.id === messageId);
      if (!item || item.status === 'sending') return;
      selected = true;
      epoch = (this.generation.get(id) ?? 0) + 1; this.generation.set(id, epoch);
      const previous = this.state(id).items.find(value => value.status === 'sending');
      this.commit(id, next => {
        next.paused = true;
        const index = next.items.findIndex(value => value.id === messageId);
        next.items.unshift(...next.items.splice(index, 1));
      });
      if (previous) this.replaced.add(previous.id);
    });
    if (!selected) return;
    try {
      await this.options.interrupt(id);
      await this.active.get(id);
      if (this.failedAcks.has(id)) throw new Error('上一轮执行回执尚未保存，请先继续队列以修复回执。');
      await this.serial(id, () => {
        if (this.generation.get(id) !== epoch) return; // A later user stop or maintenance wins.
        assertAdmission();
        this.commit(id, next => { next.paused = false; delete next.error; });
      });
    } catch (error) { this.pause(id, '立即发送未完成，队列已暂停：' + messageOf(error)); throw error; }
  }
  wake(id: string) {
    if (this.scheduled.has(id)) return;
    this.scheduled.add(id);
    setImmediate(() => {
      this.scheduled.delete(id);
      void this.serial(id, () => this.dispatch(id)).catch(error => {
        try { this.pause(id, '队列已暂停：' + messageOf(error)); } catch { /* Memory remains paused; preserve durable evidence. */ }
      });
    });
  }
  private dispatch(id: string) {
    const state = this.state(id);
    if (state.paused || !state.items.length || this.active.has(id) || this.priorities.has(id) || this.failedAcks.has(id) || this.options.blocked(id)) return;
    this.options.assertAvailable(id);
    const item = state.items.find(value => value.status === 'queued');
    if (!item) return;
    this.commit(id, next => { next.items.find(value => value.id === item.id)!.status = 'sending'; });
    let outcome: ChatTurnResult | undefined;
    const running = Promise.resolve().then(() => this.options.run(id, structuredClone(item))).then(
      result => { outcome = result; return this.complete(id, item.id, result); },
      error => { outcome = { success: false, summary: '', error: messageOf(error) }; return this.complete(id, item.id, outcome); },
    ).catch(error => {
      if (outcome) this.failedAcks.set(id, { messageId: item.id, result: outcome });
      const state = this.state(id); state.paused = true; state.error = '执行状态保存失败，请检查聊天记录后再继续：' + messageOf(error);
      state.items.forEach(value => { if (value.status === 'sending') value.status = 'queued'; });
      this.generation.set(id, (this.generation.get(id) ?? 0) + 1);
      this.notify(id);
    }).finally(async () => {
      this.active.delete(id);
      if (!this.failedAcks.has(id)) await this.options.settled?.(id);
      this.wake(id);
    });
    // Cleanup failure keeps the directory lease; do not produce an unhandled rejection.
    void running.catch(() => {});
    this.active.set(id, running);
  }
  private complete(id: string, messageId: string, result: ChatTurnResult) {
    return this.serial(id, () => {
      const replaced = this.replaced.has(messageId);
      this.commit(id, next => {
        if (result.success || replaced) next.items = next.items.filter(value => value.id !== messageId);
        else {
          const item = next.items.find(value => value.id === messageId);
          if (item) item.status = 'queued';
          next.paused = true;
          next.error = (result.error || (result.interrupted ? '本轮已中断。' : '本轮执行失败。')).slice(0, 4000) + ' 消息已保留，请检查已产生的操作，移除不应重复执行的消息后再继续。';
        }
      });
      // Failed ACK retries need the replacement decision just as much as the result.
      this.replaced.delete(messageId);
    });
  }
  delete(id: string) {
    if (this.hasActive(id)) throw new Error('请先停止会话。');
    this.storage.delete(id); this.states.delete(id); this.generation.delete(id);
  }
}
