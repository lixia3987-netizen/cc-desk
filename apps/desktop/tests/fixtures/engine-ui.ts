import { BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createExecutors as productionExecutors } from '../../src/main/execution/create-executors';
import { HistorySources as ProductionHistorySources } from '../../src/main/execution/history-sources';
import type { ExecutionRegistry } from '../../src/main/execution/registry';
import type { StructuredExecutor } from '../../src/main/execution/ports';
import type { StateStore } from '../../src/main/store';
import { ChatHistory } from '../../src/main/chat-history';
import { ChatArchive } from '../../src/main/chat-archive';
import type { ChatDecision, ChatMessage, ChatPageOptions, ChatTurnResult, TaskState } from '../../src/shared/chat';
import { getSessionIdentity, type EngineConfig } from '../../src/shared/execution';

// This module is reachable only through the test build's esbuild resolver.
export const TEST_ENGINE_MARKER = 'P2_ONLY_HETEROGENEOUS_ENGINE';
const configSchema = z.object({ schemaVersion: z.literal(7), options: z.object({ route: z.string().min(1), responseStyle: z.enum(['terse', 'expanded']) }).strict() }).strict();
const pendingHistory = new Map<string, () => void>();
const controls = {
  available: true,
  historyStarted: [] as string[],
  releaseHistory(query: string) { pendingHistory.get(query)?.(); pendingHistory.delete(query); },
  refresh() {},
};
Object.assign(globalThis, { __p2EngineFixture: controls });

export class HistorySources extends ProductionHistorySources {
  constructor() {
    super();
    for (const providerId of ['test.native', 'test.archive']) this.register(providerId, async (cwd, options) => {
      const query = options.query ?? '';
      if (providerId === 'test.native' && query.startsWith('delayed')) {
        controls.historyStarted.push(query);
        await new Promise<void>(resolve => pendingHistory.set(query, resolve));
        if (query === 'delayed-error') throw new Error('Expired native history failure');
      }
      return { entries: [{ id: 'opaque/shared:history', title: providerId === 'test.native' ? 'Native 原始历史' : 'Archive 原始历史', cwd, modifiedAt: '2026-01-01T00:00:00.000Z' }], total: 1, nextOffset: null };
    });
  }
}

class TestEngine implements StructuredExecutor {
  private active = new Set<string>();
  private pending = new Map<string, (result: ChatTurnResult) => void>();
  private history: ChatHistory;
  private archive: ChatArchive;
  constructor(private store: StateStore, private registry: ExecutionRegistry) {
    this.history = new ChatHistory(store.directory, id => this.has(id));
    this.archive = new ChatArchive(this.history.directory);
  }
  get activeCount() { return this.active.size; }
  has(id: string) { return this.active.has(id); }
  isBusy(id: string) { return this.pending.has(id); }
  taskState(id: string) { return this.snapshot(id).taskState; }
  async hydrate(_id: string) {}
  snapshot(id: string) { return this.history.get(id); }
  page(id: string, options?: ChatPageOptions) { this.history.flush(); return this.archive.page(id, this.snapshot(id), options); }
  search(id: string, query: string, before?: string) { this.history.flush(); return this.archive.search(id, this.snapshot(id), query, before); }
  attention() {
    return this.store.state.sessions.filter(session => session.execution.providerId.startsWith('test.')).flatMap(session =>
      this.snapshot(session.id).pending.map(item => ({ sessionId: session.id, requestId: item.requestId, kind: item.kind, toolName: item.toolName, createdAt: item.createdAt })));
  }
  private changed(id: string, taskState: TaskState) {
    this.snapshot(id).taskState = taskState;
    this.history.changed(id); this.history.flush();
    this.store.change(state => { const session = state.sessions.find(item => item.id === id)!; session.taskState = taskState; session.status = this.has(id) ? 'running' : 'stopped'; });
    const identity = getSessionIdentity(this.registry.getSession(id));
    this.registry.events.emit({ type: 'session.changed', identity, status: this.registry.getSession(id).status, taskState });
    this.registry.events.emit({ type: 'conversation.changed', identity, taskState });
  }
  private message(id: string, role: ChatMessage['role'], text: string) {
    const message: ChatMessage = { id: randomUUID(), turnId: 'fixture-turn', role, text, createdAt: new Date().toISOString() };
    this.history.append(id, { type: 'message', message }); this.history.upsertMessage(id, message);
  }
  send(id: string, text: string) {
    this.active.add(id);
    this.store.change(state => { state.sessions.find(item => item.id === id)!.started = true; });
    this.message(id, 'user', text);
    const result = new Promise<ChatTurnResult>(resolve => this.pending.set(id, resolve));
    this.changed(id, 'thinking');
    if (text === 'approve') {
      this.snapshot(id).pending = [{ requestId: 'test-only-approval', kind: 'permission', toolName: 'FixtureTool', input: { route: this.registry.getSession(id).engineConfig.options.route }, createdAt: new Date().toISOString() }];
      this.changed(id, 'waiting_approval');
    } else if (text !== 'hold') this.finish(id, { success: true, summary: `测试引擎完成：${text}` });
    return result;
  }
  private finish(id: string, result: ChatTurnResult) {
    const resolve = this.pending.get(id); this.pending.delete(id);
    this.snapshot(id).pending = [];
    if (result.summary) this.message(id, 'assistant', result.summary);
    this.changed(id, result.interrupted ? 'interrupted' : result.success ? 'completed' : 'error');
    resolve?.(result);
  }
  async prepareCommands(_id: string): Promise<never> { throw new Error('Unsupported test engine command preparation was invoked'); }
  respond(id: string, requestId: string, decision: ChatDecision) {
    if (requestId !== 'test-only-approval' || !this.snapshot(id).pending.length) throw new Error('Approval expired');
    this.finish(id, decision.behavior === 'allow' ? { success: true, summary: '测试审批已完成' } : { success: false, summary: '测试审批已拒绝', interrupted: true });
  }
  async updateConfig(id: string, config: EngineConfig) {
    const validated = configSchema.parse(config);
    this.store.change(state => { state.sessions.find(item => item.id === id)!.engineConfig = validated; });
  }
  async exports(_id: string) { return []; }
  interrupt(id: string) { if (this.pending.has(id)) this.finish(id, { success: false, summary: '测试任务已中断', interrupted: true }); }
  stop(id: string) { this.interrupt(id); this.active.delete(id); this.changed(id, this.snapshot(id).taskState); }
  async stopIdle(id: string) { if (this.pending.has(id)) throw new Error('Test turn is active'); this.stop(id); }
  forget(id: string) { this.active.delete(id); this.history.delete(id); this.archive.forget(id); }
  setMaintenance(_value: boolean) {}
  async disconnectAll() { for (const id of [...this.active]) this.stop(id); }
  async shutdown() { await this.disconnectAll(); this.history.flush(); }
}

export function createExecutors(...args: Parameters<typeof productionExecutors>) {
  const [store] = args, registry = productionExecutors(...args), executor = new TestEngine(store, registry);
  for (const providerId of ['test.native', 'test.archive']) registry.register({
    providerId, mode: 'structured', displayName: providerId === 'test.native' ? '测试 Native' : '测试 Archive', executor, history: true,
    capabilities: () => ({ available: controls.available, error: controls.available ? undefined : '测试引擎暂时离线', structured: true, terminal: false,
      approvals: true, resume: true, fork: true, commands: false, contextUsage: false, liveConfig: true, attachments: false, export: false, recoverContext: false }),
    configuration: () => ({ schemaVersion: 7, defaults: { schemaVersion: 7, options: { route: 'local-fixture', responseStyle: 'terse' } }, fields: [
      { key: 'route', label: '路由', type: 'text', apply: 'live' },
      { key: 'responseStyle', label: '回复风格', type: 'select', apply: 'live', options: [{ value: 'terse', label: '简短' }, { value: 'expanded', label: '展开' }] },
    ] }),
    validateConfig: config => configSchema.parse(config),
    createIdentity: input => ({ providerId, mode: 'structured', conversationId: input.fork ? `fork/${randomUUID()}` : input.conversationId ?? `native/${randomUUID()}`, forkFrom: input.fork ? input.conversationId : undefined, imported: !!input.conversationId && !input.fork }),
  });
  controls.refresh = () => { for (const window of BrowserWindow.getAllWindows()) window.webContents.send('workspace:executors', registry.descriptors()); };
  return registry;
}
