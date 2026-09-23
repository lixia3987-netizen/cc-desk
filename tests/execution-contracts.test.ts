import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BrowserWindow } from 'electron';
import { z } from 'zod';
import { StateStore } from '../src/main/store';
import { SessionService } from '../src/main/session-service';
import { Attachments } from '../src/main/attachments';
import { ExecutionRegistry } from '../src/main/execution/registry';
import { ExecutionStatePublisher } from '../src/main/execution/events';
import type { StructuredExecutor, TerminalExecutor } from '../src/main/execution/ports';
import type { ChatDecision, ChatSnapshot, ChatTurnResult, TaskState } from '../src/shared/chat';
import type { ExecutionCapabilities, SessionExecution } from '../src/shared/execution';
import { getSessionIdentity } from '../src/shared/execution';
import type { ExecutionEvent } from '../src/shared/execution-events';
import type { Session } from '../src/shared/types';

const capabilities = (): ExecutionCapabilities => ({ available: true, structured: true, terminal: true, approvals: true,
  resume: true, fork: true, commands: true, contextUsage: true, liveConfig: true, attachments: true });
const done: ChatTurnResult = { success: true, summary: 'Actual fake executor result' };
const interrupted: ChatTurnResult = { success: false, summary: '', interrupted: true };
const until = async (check: () => boolean) => {
  const deadline = Date.now() + 2000;
  while (!check()) { if (Date.now() > deadline) throw new Error('Expected executor activity did not occur'); await new Promise(resolve => setTimeout(resolve, 5)); }
};

/** Deliberately not Claude: no CLI flags, UUID remote identities, or protocol frames. */
class FakeStructured implements StructuredExecutor {
  active = new Set<string>();
  pending = new Map<string, (result: ChatTurnResult) => void>();
  snapshots = new Map<string, ChatSnapshot>();
  requests: { id: string; text: string; attachments?: string[]; titlePrompt?: string }[] = [];
  decisions: ChatDecision[] = [];
  configCalls = 0;
  maintenance: boolean[] = [];
  disconnects = 0;
  shutdowns = 0;
  rejectDisconnect = false;
  rejectShutdown = false;
  hold = false;
  constructor(private registry: ExecutionRegistry) {}
  get activeCount() { return this.active.size; }
  has(id: string) { return this.active.has(id); }
  isBusy(id: string) { return this.pending.has(id); }
  taskState(id: string): TaskState { return this.snapshot(id).taskState; }
  async hydrate(_id: string) {}
  snapshot(id: string): ChatSnapshot {
    if (!this.snapshots.has(id)) this.snapshots.set(id, { sessionId: id, taskState: 'idle', messages: [], pending: [] });
    return this.snapshots.get(id)!;
  }
  async page(id: string) { return { messages: this.snapshot(id).messages, before: null, after: null, incomplete: false }; }
  async search(_id: string, _query: string) { return { hits: [], nextBefore: null, incomplete: false }; }
  attention() { return [...this.snapshots.values()].flatMap(s => s.pending.map(p => ({ sessionId: s.sessionId, requestId: p.requestId, kind: p.kind, toolName: p.toolName, createdAt: p.createdAt }))); }
  private task(id: string, state: TaskState) {
    this.snapshot(id).taskState = state;
    this.registry.events.emit({ type: 'conversation.changed', identity: getSessionIdentity(this.registry.getSession(id)), taskState: state });
  }
  send(id: string, text: string, attachments?: string[], titlePrompt?: string) {
    this.requests.push({ id, text, attachments, titlePrompt }); this.active.add(id);
    const pending = new Promise<ChatTurnResult>(resolve => this.pending.set(id, resolve));
    this.task(id, 'thinking');
    if (text === 'approve') {
      this.snapshot(id).pending = [{ requestId: 'opaque-approval', kind: 'permission', toolName: 'CustomAction', input: {}, createdAt: new Date().toISOString() }];
      this.task(id, 'waiting_approval');
    } else if (!this.hold) this.finish(id, done);
    return pending;
  }
  finish(id: string, result: ChatTurnResult) {
    const resolve = this.pending.get(id); this.pending.delete(id); this.snapshot(id).pending = [];
    this.task(id, result.interrupted ? 'interrupted' : result.success ? 'completed' : 'error'); resolve?.(result);
  }
  async prepareCommands(id: string) {
    this.active.add(id); this.snapshot(id).commands = [{ name: 'custom', description: 'Custom command', kind: 'command', aliases: [], argumentHint: '' }];
    return this.snapshot(id);
  }
  respond(id: string, _requestId: string, decision: ChatDecision) { this.decisions.push(decision); this.finish(id, decision.behavior === 'allow' ? done : interrupted); }
  async updateConfig(_id: string, _config: Parameters<StructuredExecutor['updateConfig']>[1]) { this.configCalls++; }
  async exports(_id: string) { return []; }
  interrupt(id: string) { this.finish(id, interrupted); }
  stop(id: string) { this.interrupt(id); this.active.delete(id); }
  async stopIdle(id: string) { if (this.isBusy(id)) throw new Error('Busy'); this.stop(id); }
  forget(id: string) { this.active.delete(id); this.snapshots.delete(id); }
  setMaintenance(value: boolean) { this.maintenance.push(value); }
  async disconnectAll() { this.disconnects++; for (const id of this.active) this.stop(id); if (this.rejectDisconnect) throw new Error('Fake shutdown failed'); }
  async shutdown() { this.shutdowns++; for (const id of this.active) this.stop(id); if (this.rejectShutdown) throw new Error('Fake shutdown failed'); }
}

class FakeTerminal implements TerminalExecutor {
  active = new Set<string>();
  maintenance: boolean[] = [];
  disconnects = 0;
  shutdowns = 0;
  get activeCount() { return this.active.size; }
  has(id: string) { return this.active.has(id); }
  isBusy(id: string) { return this.has(id); }
  async start(id: string) { this.active.add(id); }
  write(_id: string, _data: string) {}
  resize(_id: string, _cols: number, _rows: number) {}
  snapshot(_id: string) { return { status: 'running' as const, chunks: [] }; }
  async exports(_id: string) { return []; }
  async interrupt(_id: string) {}
  async stop(id: string) { this.active.delete(id); }
  async stopIdle(id: string) { await this.stop(id); }
  forget(id: string) { this.active.delete(id); }
  setMaintenance(value: boolean) { this.maintenance.push(value); }
  async disconnectAll() { this.disconnects++; this.active.clear(); }
  async shutdown() { this.shutdowns++; this.active.clear(); }
}

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ccdesk-execution-contract-'));
  const store = new StateStore(directory);
  const projectId = randomUUID(), now = new Date().toISOString();
  store.change(state => state.projects.push({ id: projectId, path: directory, name: 'Fake provider', createdAt: now }));
  const registry = new ExecutionRegistry(id => {
    const value = store.state.sessions.find(s => s.id === id); if (!value) throw new Error('Missing session'); return value;
  });
  const sent: { channel: string; args: unknown[] }[] = [];
  const window = { webContents: { send: (channel: string, ...args: unknown[]) => sent.push({ channel, args }) } } as unknown as BrowserWindow;
  let changed = 0;
  const service = new SessionService(store, registry, () => { changed++; }, () => window, {
    history: async () => ({ entries: [], total: 0, nextOffset: null }),
    diagnose: async () => { throw new Error('Diagnostics must be explicitly requested'); },
  });
  const handlers = new Map<string, (input: unknown) => unknown>();
  service.register(<T>(name: string, schema: z.ZodType<T>, action: (data: T) => unknown) => handlers.set(name, input => action(schema.parse(input))));
  const call = async <T>(name: string, input?: unknown): Promise<T> => await handlers.get(name)!(input) as T;
  const add = (providerId = 'test.engine', mode: SessionExecution['mode'] = 'structured', conversationId = 'opaque/conversation:42') => {
    const value: Session = { id: randomUUID(), projectId, title: providerId, kind: providerId === 'shell' ? 'shell' : 'agent',
      execution: providerId === 'shell' ? { providerId, mode } : { providerId, mode, conversationId },
      cwd: directory, started: false, model: '', effort: 'default', permissionMode: 'default', status: 'idle', archived: false, createdAt: now, updatedAt: now };
    store.change(state => state.sessions.push(value)); return value;
  };
  const register = (providerId = 'test.engine', caps = capabilities()) => {
    const executor = new FakeStructured(registry); registry.register({ providerId, mode: 'structured', executor, capabilities: () => caps }); return { executor, caps };
  };
  return { store, registry, service, sent, call, add, register, changes: () => changed, directory,
    dispose: async () => { try { await service.shutdown(); } finally { fs.rmSync(directory, { recursive: true, force: true }); } } };
}

test('a non-Claude executor handles commands, messages and approvals through real SessionService IPC', async () => {
  const f = fixture();
  try {
    const { executor, caps } = f.register(), s = f.add();
    const commands = await f.call<ChatSnapshot>('chat:commands', s.id);
    assert.equal(commands.commands?.[0].name, 'custom'); assert.equal(executor.requests.length, 0);
    assert.deepEqual(await f.call('chat:send', { id: s.id, text: 'hello' }), done);
    const pending = f.call<ChatTurnResult>('chat:send', { id: s.id, text: 'approve' });
    await until(() => executor.taskState(s.id) === 'waiting_approval');
    assert.equal((await f.call<unknown[]>('chat:attention')).length, 1);
    caps.available = false; // An existing approval remains answerable while discovery is unavailable.
    await f.call('chat:respond', { id: s.id, requestId: 'opaque-approval', decision: { behavior: 'allow' } });
    assert.equal((await pending).success, true);
    assert.deepEqual(executor.decisions, [{ behavior: 'allow' }]);
    assert.ok(f.sent.some(item => item.channel === 'chat:changed' && item.args[0] === s.id && item.args[1] === 'waiting_approval'));
    const event = f.sent.find(item => item.channel === 'execution:event' && (item.args[0] as ExecutionEvent).type === 'conversation.changed')!.args[0] as ExecutionEvent;
    assert.equal(event.identity.providerId, 'test.engine'); assert.equal(event.identity.conversationId, 'opaque/conversation:42');
    assert.equal('flags' in f.registry.descriptors()[0].capabilities, false);
  } finally { await f.dispose(); }
});

test('missing operation capabilities reject before invoking a provider, including resident command catalogs', async () => {
  const f = fixture();
  try {
    const { executor, caps } = f.register(), s = f.add();
    caps.commands = false;
    await assert.rejects(f.call('chat:commands', s.id), /commands/);
    executor.active.add(s.id);
    await assert.rejects(f.call('chat:commands', s.id), /commands/);
    caps.approvals = false;
    await assert.rejects(f.call('chat:respond', { id: s.id, requestId: 'no', decision: { behavior: 'allow' } }), /approvals/);
    assert.equal(executor.decisions.length, 0);
    caps.liveConfig = false;
    await assert.rejects(f.call('session:update', { id: s.id, model: 'another' }), /liveConfig/);
    assert.equal(executor.configCalls, 0);
    caps.structured = false;
    await assert.rejects(f.call('chat:send', { id: s.id, text: 'blocked' }), /structured/);
    assert.equal(executor.requests.length, 0);
  } finally { await f.dispose(); }
});

test('an executor without attachment support never receives retained attachments', async () => {
  const f = fixture();
  try {
    const { executor, caps } = f.register(), s = f.add(); caps.attachments = false;
    const source = path.join(f.directory, 'source.txt'); fs.writeFileSync(source, 'Owned fixture');
    const [attachment] = await new Attachments(f.directory).add(s.id, [source]);
    await assert.rejects(f.call('chat:send', { id: s.id, text: 'read', attachments: [attachment.path] }), /attachments/);
    assert.equal(executor.requests.length, 0); assert.ok(fs.existsSync(source));
  } finally { await f.dispose(); }
});

test('workflows use the injected provider and cancellation prevents later stage dispatch', async () => {
  const f = fixture();
  try {
    const { executor } = f.register(), s = f.add();
    const run = await f.call<{ id: string; providerId: string }>('workflow:create', { sessionId: s.id, goal: 'Actual goal', stages: [
      { id: 'first', title: 'First', instruction: 'inspect', dependsOn: [] }, { id: 'second', title: 'Second', instruction: 'review', dependsOn: ['first'] },
    ] });
    assert.equal(run.providerId, 'test.engine');
    await f.call('workflow:start', run.id);
    assert.equal((await f.service.workflows.wait(run.id)).status, 'completed');
    assert.equal(executor.requests.length, 2); assert.ok(executor.requests.every(item => item.titlePrompt === 'Actual goal'));
    executor.hold = true;
    const cancelled = await f.call<{ id: string }>('workflow:create', { sessionId: s.id, goal: 'Cancel goal' });
    await f.call('workflow:start', cancelled.id); await until(() => executor.isBusy(s.id));
    await f.call('workflow:cancel', cancelled.id);
    assert.equal((await f.service.workflows.wait(cancelled.id)).status, 'cancelled'); assert.equal(executor.requests.length, 3);
  } finally { await f.dispose(); }
});

test('conversation ownership is isolated by provider and rejects duplicate identities within one provider', async () => {
  const f = fixture();
  try {
    const a = f.register(), b = f.register('other.engine'); a.executor.hold = true; b.executor.hold = true;
    const first = f.add(), other = f.add('other.engine'), duplicate = f.add();
    const firstTurn = f.call('chat:send', { id: first.id, text: 'first' });
    await until(() => a.executor.isBusy(first.id));
    const otherTurn = f.call('chat:send', { id: other.id, text: 'other' });
    await until(() => b.executor.isBusy(other.id));
    assert.equal(f.service.activeCount, 2);
    await assert.rejects(f.call('chat:send', { id: duplicate.id, text: 'duplicate' }), /同一提供方/);
    a.executor.finish(first.id, done); b.executor.finish(other.id, done);
    await Promise.all([firstTurn, otherTurn]); assert.equal(a.executor.requests.length, 1);
  } finally { await f.dispose(); }
});

test('one terminal driver shared by multiple registrations is counted and maintained only once', async () => {
  const f = fixture();
  try {
    const executor = new FakeTerminal();
    for (const providerId of ['test.engine', 'shell']) f.registry.register({ providerId, mode: 'terminal', executor, capabilities });
    const agent = f.add('test.engine', 'terminal'), shell = f.add('shell', 'terminal');
    await f.service.start(agent.id); await f.service.start(shell.id); assert.equal(f.service.activeCount, 2);
    await f.service.withDisconnectedWorkspaces(async () => { assert.equal(executor.activeCount, 0); });
    assert.equal(executor.disconnects, 1); assert.deepEqual(executor.maintenance, [true, false]);
    await f.service.start(shell.id); await f.service.shutdown(); assert.equal(executor.shutdowns, 1);
  } finally { await f.dispose(); }
});

test('a failed driver cannot prevent independent cleanup or allow an update to proceed', async () => {
  const f = fixture();
  try {
    const first = f.register(), second = f.register('other.engine');
    first.executor.rejectDisconnect = true;
    first.executor.active.add(f.add().id); second.executor.active.add(f.add('other.engine').id);
    let updates = 0;
    await assert.rejects(f.service.withDisconnectedWorkspaces(async () => { updates++; }), /已取消更新/);
    assert.equal(updates, 0); assert.equal(first.executor.disconnects, 1); assert.equal(second.executor.disconnects, 1);
    assert.deepEqual(second.executor.maintenance, [true, false]); assert.equal(f.service.activeCount, 0);
    first.executor.rejectShutdown = true;
    await assert.rejects(f.service.shutdown(), /Fake shutdown failed/);
    assert.equal(first.executor.shutdowns, 1); assert.equal(second.executor.shutdowns, 1);
    first.executor.rejectShutdown = false;
  } finally { await f.dispose(); }
});

test('normalized identity and terminal events reach IPC while message bodies remain in the journal', async () => {
  const f = fixture();
  try {
    f.register(); const s = f.add(), publisher = new ExecutionStatePublisher(f.registry.events);
    publisher.publish(f.store.state.sessions); const changed = f.changes();
    publisher.publish(f.store.state.sessions); assert.equal(f.changes(), changed);
    const before = getSessionIdentity(s);
    f.store.change(state => { state.sessions[0].execution.conversationId = 'reset/opaque:new'; });
    publisher.publish(f.store.state.sessions);
    const identity = f.sent.find(item => item.channel === 'execution:event' && (item.args[0] as ExecutionEvent).type === 'identity.changed')!.args[0] as Extract<ExecutionEvent, { type: 'identity.changed' }>;
    assert.deepEqual(identity.previous, before); assert.equal(identity.identity.conversationId, 'reset/opaque:new');
    const count = f.sent.length;
    f.registry.events.emit({ type: 'journal', identity: getSessionIdentity(s), event: { type: 'message', message: { id: 'm', turnId: 't', role: 'assistant', text: 'Private large body', createdAt: '' } } });
    assert.equal(f.sent.length, count);
    const chunk = { sessionId: s.id, seq: 1, data: 'terminal data' };
    f.registry.events.emit({ type: 'terminal.data', identity: getSessionIdentity(s), chunk });
    assert.ok(f.sent.some(item => item.channel === 'terminal:data' && item.args[0] === chunk));
  } finally { await f.dispose(); }
});

test('unsupported stored providers fail explicitly without falling back to a different executor', async () => {
  const f = fixture();
  try {
    const { executor } = f.register(), unsupported = f.add('future.engine');
    await assert.rejects(f.call('chat:send', { id: unsupported.id, text: 'preserve identity' }), /未安装会话执行器/);
    assert.equal(executor.requests.length, 0);
    assert.equal(new StateStore(f.directory).state.sessions[0].execution.providerId, 'future.engine');
    assert.throws(() => f.registry.register({ providerId: 'test.engine', mode: 'structured', executor, capabilities }), /已注册/);
  } finally { await f.dispose(); }
});

test('terminal stop and interrupt await asynchronous provider completion and surface failures', async () => {
  const f = fixture();
  try {
    const executor = new FakeTerminal();
    f.registry.register({ providerId: 'test.engine', mode: 'terminal', executor, capabilities });
    const s = f.add('test.engine', 'terminal'); await f.service.start(s.id);
    let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
    executor.stop = async () => { await barrier; throw new Error('Provider stop failed'); };
    let settled = false; const stopping = f.service.stop(s.id).finally(() => { settled = true; });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
    release(); await assert.rejects(stopping, /Provider stop failed/);
    executor.interrupt = async () => { throw new Error('Provider interrupt failed'); };
    await assert.rejects(f.service.interrupt(s.id), /Provider interrupt failed/);
  } finally { await f.dispose(); }
});

test('a maintenance failure attempts every driver and releases the service admission guard', async () => {
  const f = fixture();
  try {
    const first = f.register(), second = f.register('other.engine'), s = f.add();
    const original = first.executor.setMaintenance.bind(first.executor);
    first.executor.setMaintenance = value => { original(value); if (value) throw new Error('Cannot enter maintenance'); };
    let updates = 0;
    await assert.rejects(f.service.withDisconnectedWorkspaces(async () => { updates++; }), /维护/);
    assert.equal(updates, 0);
    assert.deepEqual(first.executor.maintenance, [true, false]);
    assert.deepEqual(second.executor.maintenance, [true, false]);
    assert.deepEqual(await f.call('chat:send', { id: s.id, text: 'admission restored' }), done);
  } finally { await f.dispose(); }
});

test('a failed normalized-event observer cannot interrupt a provider turn or other subscribers', async () => {
  const f = fixture();
  try {
    f.register(); const s = f.add(); const seen: ExecutionEvent[] = [];
    const unsubscribe = f.registry.events.subscribe(() => { throw new Error('Renderer observer failed'); });
    f.registry.events.subscribe(event => seen.push(event));
    assert.deepEqual(await f.call('chat:send', { id: s.id, text: 'first turn' }), done);
    assert.ok(seen.some(event => event.type === 'conversation.changed' && event.taskState === 'completed'));
    unsubscribe();
    assert.deepEqual(await f.call('chat:send', { id: s.id, text: 'second turn' }), done);
  } finally { await f.dispose(); }
});
