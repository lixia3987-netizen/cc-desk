import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { RunIdentity } from '@cc-desk/agent-core';
import { StateStore } from '../src/main/store';
import { SessionService } from '../src/main/session-service';
import { ExecutionRegistry } from '../src/main/execution/registry';
import type { StructuredExecutor, TerminalExecutor } from '../src/main/execution/ports';
import type { ChatSnapshot, ChatTurnResult } from '../src/shared/chat';
import type { ExecutionCapabilities } from '../src/shared/execution';
import type { Session } from '../src/shared/types';

class TestStructured implements StructuredExecutor {
  pending = new Map<string, (result: ChatTurnResult) => void>();
  recovery = new Set<string>();
  childRecoveryRoots = new Map<string, readonly string[]>();
  get activeCount() { return this.pending.size; }
  has(id: string) { return this.pending.has(id); }
  isBusy(id: string) { return this.has(id); }
  taskState(id: string) { return this.has(id) ? 'thinking' as const : 'idle' as const; }
  async hydrate(_id: string) {}
  snapshot(id: string): ChatSnapshot { return { sessionId: id, taskState: this.taskState(id), messages: [], pending: [] }; }
  async page(_id: string) { return { messages: [], before: null, after: null, incomplete: false }; }
  async search(_id: string, _query: string) { return { hits: [], nextBefore: null, incomplete: false }; }
  attention() { return []; }
  async prepareCommands(id: string) { return this.snapshot(id); }
  send(id: string) { return new Promise<ChatTurnResult>(resolve => this.pending.set(id, resolve)); }
  respond(_id: string) {}
  async updateConfig(_id: string) {}
  async exports(_id: string) { return []; }
  finish(id: string) { const resolve = this.pending.get(id); this.pending.delete(id); resolve?.({ success: false, summary: '', interrupted: true }); }
  interrupt(id: string) { this.finish(id); }
  stop(id: string) { this.finish(id); }
  async stopIdle(id: string) { if (this.has(id)) throw new Error('Parent remains active'); }
  async whenReleased(id: string) { if (this.has(id)) throw new Error('Parent remains active'); }
  recoveryRequired(id: string) { return this.recovery.has(id); }
  async recoveryDirectories(id: string) { return this.childRecoveryRoots.get(id) ?? []; }
  forget(id: string) { this.finish(id); }
  setMaintenance(_value: boolean) {}
  async disconnectAll() { for (const id of this.pending.keys()) this.finish(id); }
  async shutdown() { await this.disconnectAll(); }
}
class TestTerminal implements TerminalExecutor {
  active = new Set<string>();
  get activeCount() { return this.active.size; }
  has(id: string) { return this.active.has(id); }
  isBusy(id: string) { return this.has(id); }
  async start(id: string) { this.active.add(id); }
  write(_id: string, _text: string) {}
  resize(_id: string, _cols: number, _rows: number) {}
  snapshot(_id: string) { return { chunks: [], status: 'running' as const }; }
  async exports(_id: string) { return []; }
  interrupt(id: string) { this.active.delete(id); }
  stop(id: string) { this.active.delete(id); }
  async stopIdle(id: string) { this.stop(id); }
  async whenReleased(id: string) { if (this.has(id)) throw new Error('Terminal remains active'); }
  forget(id: string) { this.stop(id); }
  setMaintenance(_value: boolean) {}
  async disconnectAll() { this.active.clear(); }
  async shutdown() { this.active.clear(); }
}
const capabilities: ExecutionCapabilities = { available: true, structured: true, terminal: true, approvals: true, resume: true, fork: true,
  commands: true, contextUsage: false, liveConfig: false, attachments: false };
const childIdentity = (): RunIdentity => ({ sessionId: randomUUID(), conversationId: randomUUID(), runId: randomUUID(), requestId: randomUUID(), workerGeneration: 1 });

async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ccdesk-native-child-ownership-')));
  const parentRoot = path.join(root, 'parent'), childRoot = path.join(root, 'children', 'one'), siblingRoot = path.join(root, 'children', 'two');
  await fs.mkdir(parentRoot, { recursive: true }); await fs.mkdir(childRoot, { recursive: true }); await fs.mkdir(siblingRoot);
  const store = new StateStore(path.join(root, 'data'));
  const registry = new ExecutionRegistry(id => { const session = store.state.sessions.find(item => item.id === id); if (!session) throw new Error('No StateStore child session'); return session; });
  const structured = new TestStructured(), terminal = new TestTerminal();
  for (const providerId of ['native', 'claude']) registry.register({ providerId, mode: 'structured', executor: structured, capabilities: () => capabilities });
  registry.register({ providerId: 'shell', mode: 'terminal', executor: terminal, capabilities: () => capabilities });
  const service = new SessionService(store, registry, () => {}, () => null, { history: async () => ({ entries: [], total: 0, nextOffset: null }), diagnose: async () => { throw new Error('Not used'); } });
  const handlers = new Map<string, (input: unknown) => unknown>();
  service.register(<T>(name: string, schema: z.ZodType<T>, action: (data: T) => unknown) => handlers.set(name, input => action(schema.parse(input))));
  const add = (cwd: string, providerId = 'native') => {
    const projectId = randomUUID(), now = new Date().toISOString();
    const session: Session = { id: randomUUID(), projectId, title: providerId, kind: providerId === 'shell' ? 'shell' : 'agent', cwd,
      execution: providerId === 'shell' ? { providerId, mode: 'terminal' } : { providerId, mode: 'structured', conversationId: randomUUID() },
      engineConfig: { schemaVersion: 1, options: {} }, started: false, archived: false, status: 'idle', createdAt: now, updatedAt: now };
    store.change(state => { state.projects.push({ id: projectId, name: providerId, path: cwd, createdAt: now }); state.sessions.push(session); }); return session;
  };
  const parent = add(parentRoot), leases: Awaited<ReturnType<SessionService['acquireNativeChildOwnership']>>[] = [];
  const acquire = async (cwd = childRoot, identity = childIdentity()) => { const lease = await service.acquireNativeChildOwnership(parent.id, identity, cwd); leases.push(lease); return lease; };
  const send = (session: Session) => Promise.resolve().then(() => handlers.get('chat:send')!({ id: session.id, text: 'Hold the actual parent admission' })) as Promise<ChatTurnResult>;
  const start = async (session: Session) => {
    const pending = send(session); void pending.catch(() => {});
    const deadline = Date.now() + 2000;
    while (!structured.pending.has(session.id)) { if (Date.now() >= deadline) throw new Error('Parent admission did not start'); await new Promise(resolve => setTimeout(resolve, 5)); }
    return { pending };
  };
  const running = await start(parent);
  return { root, childRoot, siblingRoot, parent, structured, terminal, store, service, add, acquire, start, send,
    async dispose() { for (const lease of leases) lease.release(); await service.stop(parent.id); await running.pending; await service.shutdown(); await fs.rm(root, { recursive: true, force: true }); },
  };
}

test('independent child cwd blocks cross-provider same, ancestor and descendant admissions without adding a StateStore session', async () => {
  const f = await fixture();
  try {
    const identity = childIdentity(), lease = await f.acquire(f.childRoot, identity);
    lease.assert(); assert.equal(f.store.state.sessions.length, 1);
    assert.throws(() => f.service.execution.getSession(identity.sessionId), /No StateStore child/);
    for (const cwd of [f.childRoot, path.dirname(f.childRoot), path.join(f.childRoot, 'nested')]) {
      await fs.mkdir(cwd, { recursive: true }); const session = f.add(cwd, 'shell');
      await assert.rejects(f.service.start(session.id), /占用/);
    }
    const competitor = f.add(f.childRoot, 'claude');
    await assert.rejects(f.service.maintainNativeContext(competitor.id, false, async () => {}), /只适用于自研/);
    await assert.rejects(f.send(competitor), /占用/);
    lease.release(); lease.release();
    const shell = f.add(f.childRoot, 'shell'); await f.service.start(shell.id); assert.equal(f.terminal.has(shell.id), true); await f.service.stop(shell.id);
  } finally { await f.dispose(); }
});

test('parallel child directories and the parent keep independent leases when one child releases', async () => {
  const f = await fixture();
  try {
    const first = await f.acquire(), second = await f.acquire(f.siblingRoot);
    first.assert(); second.assert(); f.service.assertExecutionOwnership(f.parent.id);
    first.release(); assert.throws(first.assert, /已失效/); second.assert(); f.service.assertExecutionOwnership(f.parent.id);
    const firstShell = f.add(f.childRoot, 'shell'); await f.service.start(firstShell.id); await f.service.stop(firstShell.id);
    await assert.rejects(f.service.start(f.add(f.siblingRoot, 'shell').id), /占用/);
    await assert.rejects(f.service.start(f.add(f.parent.cwd, 'shell').id), /占用/);
  } finally { await f.dispose(); }
});

test('canonical aliases cannot evade a child lease and a retargeted child cwd invalidates its authorization', async () => {
  const f = await fixture();
  try {
    const alias = path.join(f.root, 'child-alias'); await fs.symlink(f.childRoot, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const lease = await f.acquire(alias);
    await assert.rejects(f.service.start(f.add(f.childRoot, 'shell').id), /占用/);
    await fs.unlink(alias); await fs.symlink(f.siblingRoot, alias, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(lease.assert, /已失效/); lease.release();
  } finally { await f.dispose(); }
});

test('parent cancellation invalidates child tools but cannot implicitly release a still-held child path', async () => {
  const f = await fixture();
  try {
    const lease = await f.acquire(); await f.service.stop(f.parent.id);
    assert.throws(lease.assert, /已失效/);
    await assert.rejects(f.service.start(f.add(f.childRoot, 'shell').id), /占用/);
    lease.release();
    const shell = f.add(f.childRoot, 'shell'); await f.service.start(shell.id); await f.service.stop(shell.id);
  } finally { await f.dispose(); }
});

test('recovery roots and in-progress directory management reject children before acquiring new ownership', async () => {
  const f = await fixture(); let release!: () => void;
  try {
    const quarantined = f.add(f.childRoot); f.structured.recovery.add(quarantined.id);
    await assert.rejects(f.acquire(), /需要核查/); f.structured.recovery.delete(quarantined.id);
    const held = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
    const managing = f.service.withSessionCreation(f.childRoot, false, async () => { entered(); await held; });
    await started; await assert.rejects(f.acquire(), /管理操作/); release(); await managing;
    const lease = await f.acquire(); lease.assert();
  } finally { release?.(); await f.dispose(); }
});

test('a parent renewal cannot reactivate an old child authorization', async () => {
  const f = await fixture();
  try {
    const lease = await f.acquire(); await f.service.stop(f.parent.id);
    const next = await f.start(f.parent); f.service.assertExecutionOwnership(f.parent.id);
    assert.throws(lease.assert, /已失效/); lease.release();
    const renewed = await f.acquire(); renewed.assert(); await f.service.stop(f.parent.id); await next.pending;
  } finally { await f.dispose(); }
});

test('durable child recovery roots block fresh admissions outside the parent workspace without an in-memory child lease', async () => {
  const f = await fixture();
  try {
    const recoveredParent = f.add(f.siblingRoot);
    f.structured.recovery.add(recoveredParent.id); f.structured.childRecoveryRoots.set(recoveredParent.id, [f.childRoot]);
    await assert.rejects(f.service.start(f.add(f.childRoot, 'shell').id), /需要核查/);
    await assert.rejects(f.send(f.add(f.childRoot, 'claude')), /需要核查/);
    await assert.rejects(f.acquire(), /需要核查/);
    f.structured.recovery.delete(recoveredParent.id); f.structured.childRecoveryRoots.delete(recoveredParent.id);
    const lease = await f.acquire(); lease.assert();
  } finally { await f.dispose(); }
});

test('mutating a child run binding invalidates authorization while release remains available', async () => {
  const f = await fixture();
  try {
    const identity = childIdentity(), lease = await f.acquire(f.childRoot, identity); lease.assert();
    identity.requestId = 'a-different-submission'; assert.throws(lease.assert, /身份已改变/);
    lease.release(); const shell = f.add(f.childRoot, 'shell'); await f.service.start(shell.id); await f.service.stop(shell.id);
  } finally { await f.dispose(); }
});
