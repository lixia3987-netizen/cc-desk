import type { ChatDecision, ChatPageOptions } from '../../shared/chat';
import type { Effort, PermissionMode } from '../../shared/types';
import { ExecutionRegistry } from './registry';
import type { StructuredExecutor } from './ports';

/** Route by each persisted execution identity, never by a concrete provider class. */
export class StructuredExecutions {
  constructor(private registry: ExecutionRegistry) {}
  private get(id: string) { return this.registry.structured(id); }
  private all() { return this.registry.executors('structured') as StructuredExecutor[]; }
  get activeCount() { return this.all().reduce((count, executor) => count + executor.activeCount, 0); }
  has(id: string) { return this.all().some(executor => executor.has(id)); }
  isBusy(id: string) { return this.all().some(executor => executor.isBusy(id)); }
  taskState(id: string) { return this.get(id).taskState(id); }
  hydrate(id: string) { return this.get(id).hydrate(id); }
  snapshot(id: string) { return this.get(id).snapshot(id); }
  page(id: string, options?: ChatPageOptions) { return this.get(id).page(id, options); }
  search(id: string, query: string, before?: string) { return this.get(id).search(id, query, before); }
  attention() { return this.all().flatMap(executor => executor.attention()); }
  send(id: string, text: string, attachments?: string[], titlePrompt?: string) {
    this.registry.require(id, 'structured');
    if (attachments?.length) this.registry.require(id, 'attachments');
    return this.get(id).send(id, text, attachments, titlePrompt);
  }
  prepareCommands(id: string) { this.registry.require(id, 'commands'); return this.get(id).prepareCommands(id); }
  recoverContext(id: string) {
    const executor = this.get(id);
    if (!executor.recoverContext) throw new Error('此提供方不支持重建上下文。');
    return executor.recoverContext(id);
  }
  respond(id: string, requestId: string, decision: ChatDecision) { this.registry.require(id, 'approvals', false); return this.get(id).respond(id, requestId, decision); }
  updateConfig(id: string, config: { model?: string; effort?: Effort; permissionMode?: PermissionMode }) {
    if (this.has(id)) this.registry.require(id, 'liveConfig');
    return this.get(id).updateConfig(id, config);
  }
  interrupt(id: string) { return this.get(id).interrupt(id); }
  async interruptAndWait(id: string) {
    const executor = this.get(id);
    if (executor.interruptAndWait) return executor.interruptAndWait(id);
    await executor.interrupt(id);
    const deadline = Date.now() + 10_000;
    while (executor.isBusy(id) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    if (executor.isBusy(id)) throw new Error('上一轮尚未完全停止，请稍后重试。');
    await executor.stopIdle(id);
  }
  stop(id: string) { return this.get(id).stop(id); }
  async stopIdle(id: string) {
    // Callers also release directories containing terminal sessions.
    if (this.registry.getSession(id).execution.mode === 'structured') await this.get(id).stopIdle(id);
  }
  forget(id: string) { if (this.registry.getSession(id).execution.mode === 'structured') this.get(id).forget(id); }
}

export class TerminalExecutions {
  constructor(private registry: ExecutionRegistry) {}
  private get(id: string) { return this.registry.terminal(id); }
  get activeCount() { return this.registry.executors('terminal').reduce((count, executor) => count + executor.activeCount, 0); }
  has(id: string) { return this.registry.executors('terminal').some(executor => executor.has(id)); }
  start(id: string) { this.registry.require(id, 'terminal'); return this.get(id).start(id); }
  interrupt(id: string) { return this.get(id).interrupt(id); }
  stop(id: string) { return this.get(id).stop(id); }
  async stopAndWait(id: string) {
    const executor = this.get(id);
    if (executor.stopAndWait) await executor.stopAndWait(id);
    else await this.stop(id);
  }
  snapshot(id: string) { return this.get(id).snapshot(id); }
  write(id: string, data: string) { return this.get(id).write(id, data); }
  resize(id: string, cols: number, rows: number) { return this.get(id).resize(id, cols, rows); }
  forget(id: string) { if (this.registry.getSession(id).execution.mode === 'terminal') this.get(id).forget(id); }
}
