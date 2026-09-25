import { parseClaudeConfig } from '@cc-desk/engine-claude/config';
import type { ChatDecision, ChatPageOptions } from '../../../shared/chat';
import { getSessionIdentity } from '../../../shared/execution';
import type { Capabilities, EngineConfig } from '../../../shared/types';
import { ChatRuntime } from '../../chat-runtime';
import type { ChatRuntimeOptions } from '../../chat-runtime';
import type { ExecutionEvents } from '../../execution/events';
import { ExecutionStatePublisher } from '../../execution/events';
import type { StructuredExecutor } from '../../execution/ports';
import type { StateStore } from '../../store';
import { claudeExports } from './exports';
import { validateClaudeSession } from './capabilities';

/** Claude flags and wire protocol terminate here; callers use the execution port. */
export class ClaudeStructuredExecutor implements StructuredExecutor {
  private runtime: ChatRuntime;
  constructor(private store: StateStore, private capabilities: () => Capabilities, events: ExecutionEvents, options: ChatRuntimeOptions = {}) {
    const publisher = new ExecutionStatePublisher(events);
    const sessions = () => store.state.sessions.filter(session => session.execution.providerId === 'claude' && session.execution.mode === 'structured');
    publisher.publish(sessions());
    this.runtime = new ChatRuntime(store, () => publisher.publish(sessions()), id => {
      events.emit({ type: 'conversation.changed', identity: getSessionIdentity(this.session(id)), taskState: this.runtime.taskState(id) });
    }, { ...options, onEvent: (id, event) => {
      options.onEvent?.(id, structuredClone(event));
      events.emit({ type: 'journal', identity: getSessionIdentity(this.session(id)), event });
    } });
  }
  private session(id: string) {
    const session = this.store.state.sessions.find(session => session.id === id);
    if (!session) throw new Error('会话不存在。');
    if (session.kind !== 'agent' || session.execution.providerId !== 'claude' || session.execution.mode !== 'structured') throw new Error('此执行器只支持图形化 Claude 会话。');
    return session;
  }
  get activeCount() { return this.runtime.activeCount; }
  has(id: string) { return this.runtime.has(id); }
  isBusy(id: string) { return this.runtime.isBusy(id); }
  taskState(id: string) { return this.runtime.taskState(id); }
  hydrate(id: string) { return this.runtime.hydrate(id); }
  snapshot(id: string) { return this.runtime.snapshot(id); }
  page(id: string, options?: ChatPageOptions) { return this.runtime.page(id, options); }
  search(id: string, query: string, before?: string) { return this.runtime.search(id, query, before); }
  attention() { return this.runtime.attention(); }
  send(id: string, text: string, attachments?: string[], titlePrompt?: string) {
    validateClaudeSession(this.session(id));
    return this.runtime.send(id, text, this.capabilities(), attachments, titlePrompt);
  }
  prepareCommands(id: string) { validateClaudeSession(this.session(id)); return this.runtime.prepareCommands(id, this.capabilities()); }
  recoverContext(id: string) { return this.runtime.recoverContext(id); }
  respond(id: string, requestId: string, decision: ChatDecision) { return this.runtime.respond(id, requestId, decision); }
  updateConfig(id: string, config: EngineConfig) {
    const next = parseClaudeConfig(config);
    const session = this.session(id);
    const current = parseClaudeConfig(session.engineConfig);
    return this.runtime.updateConfig(id, {
      ...(next.model !== current.model ? { model: next.model } : {}),
      ...(next.effort !== current.effort ? { effort: next.effort } : {}),
      ...(next.permissionMode !== current.permissionMode || session.observedPermissionMode !== next.permissionMode ? { permissionMode: next.permissionMode } : {}),
    });
  }
  interrupt(id: string) { return this.runtime.interrupt(id); }
  interruptAndWait(id: string) { return this.runtime.interruptAndWait(id); }
  stop(id: string) { return this.runtime.stop(id); }
  stopIdle(id: string) { return this.runtime.stopIdle(id); }
  forget(id: string) { this.runtime.forget(id); }
  exports(id: string) { return claudeExports(this.session(id), () => this.runtime.exportPath(id)); }
  setMaintenance(value: boolean) { this.runtime.setMaintenance(value); }
  disconnectAll() { return this.runtime.disconnectAll(); }
  shutdown() { return this.runtime.shutdown(); }
}
