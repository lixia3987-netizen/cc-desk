import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SessionCreation } from '../src/main/session-creation';
import { SessionService } from '../src/main/session-service';
import { StateStore } from '../src/main/store';
import { ExecutionRegistry } from '../src/main/execution/registry';
import { validateClaudeSession } from '../src/main/engines/claude/capabilities';
import type { TerminalExecutor } from '../src/main/execution/ports';
import type { NewSession, Session } from '../src/shared/types';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccdesk-session-creation-'));
  const projectPath = path.join(root, 'project'); fs.mkdirSync(projectPath);
  const store = new StateStore(path.join(root, 'data'));
  const projectId = randomUUID();
  store.change(state => state.projects.push({ id: projectId, path: projectPath, name: 'Fixture', createdAt: new Date().toISOString() }));
  const registry = new ExecutionRegistry(id => {
    const session = store.state.sessions.find(item => item.id === id);
    if (!session) throw new Error('Missing fixture session');
    return session;
  });
  // Creation must not dispatch a turn or launch a process.
  const unexpected = () => { throw new Error('Unexpected execution during creation'); };
  const executor: TerminalExecutor = {
    activeCount: 0, has: () => false, isBusy: () => false,
    start: async () => unexpected(), write: unexpected, resize: unexpected, snapshot: unexpected,
    exports: async () => [], interrupt: unexpected, stop: unexpected, stopIdle: async () => {},
    forget: () => {}, setMaintenance: () => {}, disconnectAll: async () => {}, shutdown: async () => {},
  };
  let allocated = 0;
  const register = (providerId: string, validateSession?: (session: Session) => void) => registry.register({
    providerId, mode: 'terminal', executor,
    capabilities: () => ({ available: true, structured: false, terminal: true, approvals: false,
      resume: providerId !== 'shell', fork: providerId !== 'shell', commands: false, contextUsage: false, liveConfig: false, attachments: false }),
    validateSession: validateSession ?? (providerId === 'claude' ? validateClaudeSession : undefined),
    createIdentity: input => providerId === 'shell' ? { providerId, mode: 'terminal' } : {
      providerId, mode: 'terminal',
      conversationId: input.conversationId && !input.fork ? input.conversationId : providerId === 'claude' ? randomUUID() : `opaque/new:${++allocated}`,
      forkFrom: input.fork ? input.conversationId : undefined, imported: !!input.conversationId && !input.fork,
    },
  });
  register('claude'); register('test.engine'); register('other.engine'); register('shell');
  const service = new SessionService(store, registry, () => {}, () => null, {
    history: async () => ({ entries: [], total: 0, nextOffset: null }), diagnose: async () => { throw new Error('Unused query'); },
  });
  const creation = new SessionCreation(store, service, () => {}, 'claude');
  const input = (patch: Partial<NewSession> = {}): NewSession => ({ projectId, title: '', kind: 'agent',
    model: '', effort: 'default', isolated: false, mode: 'terminal', ...patch });
  return { root, projectPath, projectId, store, creation, input, register,
    dispose: async () => { try { await service.shutdown(); } finally { fs.rmSync(root, { recursive: true, force: true }); } } };
}

test('session creation accepts opaque provider identities while Claude alone requires UUIDs', async () => {
  const f = fixture();
  try {
    const opaque = 'remote/project:conversation/42';
    const other = await f.creation.create(f.input({ providerId: 'test.engine', conversationId: opaque }));
    assert.equal(other.execution.conversationId, opaque);
    assert.equal(other.execution.imported, true); assert.equal(other.started, true);
    await assert.rejects(f.creation.create(f.input({ conversationId: opaque })), /Claude.*UUID/);
    const local = await f.creation.create(f.input());
    assert.equal(local.execution.providerId, 'claude'); assert.notEqual(local.id, local.execution.conversationId);
    assert.match(local.execution.conversationId!, /^[0-9a-f-]{36}$/);
    assert.equal(local.started, false); assert.equal(f.store.state.sessions.length, 2);
  } finally { await f.dispose(); }
});

test('imports deduplicate only within a provider and unarchive the original local session', async () => {
  const f = fixture();
  try {
    const conversationId = 'shared/remote:id';
    const first = await f.creation.create(f.input({ providerId: 'test.engine', conversationId }));
    const second = await f.creation.create(f.input({ providerId: 'other.engine', conversationId }));
    assert.notEqual(first.id, second.id); assert.equal(f.store.state.sessions.length, 2);
    f.store.change(state => { state.sessions.find(session => session.id === first.id)!.archived = true; });
    const restored = await f.creation.create(f.input({ providerId: 'test.engine', conversationId }));
    assert.equal(restored.id, first.id); assert.equal(restored.archived, false);
    assert.equal(f.store.state.sessions.length, 2);
    assert.equal(new StateStore(f.store.directory).state.sessions.find(session => session.id === first.id)!.archived, false);
  } finally { await f.dispose(); }
});

test('forks preserve their provider source identity, source directory and permission configuration', async () => {
  const f = fixture();
  try {
    const conversationId = 'source/conversation';
    const source = await f.creation.create(f.input({ providerId: 'test.engine', conversationId }));
    const sourcePath = path.join(f.root, 'source-worktree'); fs.mkdirSync(sourcePath);
    f.store.change(state => Object.assign(state.sessions.find(session => session.id === source.id)!, { cwd: sourcePath, permissionMode: 'plan' }));
    await f.creation.create(f.input({ providerId: 'other.engine', conversationId }));
    const fork = await f.creation.create(f.input({ providerId: 'test.engine', conversationId, fork: true }));
    assert.notEqual(fork.id, source.id); assert.notEqual(fork.execution.conversationId, conversationId);
    assert.equal(fork.execution.providerId, 'test.engine'); assert.equal(fork.execution.forkFrom, conversationId);
    assert.equal(fork.execution.imported, false); assert.equal(fork.started, false);
    assert.equal(fork.cwd, sourcePath); assert.equal(fork.permissionMode, 'plan');
    assert.equal(new StateStore(f.store.directory).state.sessions[0].execution.forkFrom, conversationId);
  } finally { await f.dispose(); }
});

test('unknown providers and invalid allocated identities reject before Git preparation', async () => {
  const f = fixture();
  try {
    // This directory is deliberately not a Git repository: Git must never run first.
    await assert.rejects(f.creation.create(f.input({ providerId: 'missing.engine', isolated: true })), /不支持创建会话|未安装/);
    await assert.rejects(f.creation.create(f.input({ conversationId: 'invalid-native-id', isolated: true })), /Claude.*UUID/);
    f.register('rejected.engine', () => { throw new Error('Provider identity rejected'); });
    await assert.rejects(f.creation.create(f.input({ providerId: 'rejected.engine', isolated: true })), /Provider identity rejected/);
    assert.equal(f.store.state.sessions.length, 0); assert.equal(f.creation.pending(f.projectId), false);
    assert.deepEqual(fs.readdirSync(f.projectPath), []);
  } finally { await f.dispose(); }
});

test('Shell rejects import, fork and structured requests through either kind or provider selection', async () => {
  const f = fixture();
  try {
    for (const patch of [
      { kind: 'shell' as const, conversationId: 'remote' }, { kind: 'shell' as const, conversationId: 'remote', fork: true },
      { kind: 'shell' as const, mode: 'structured' as const },
      { kind: 'agent' as const, providerId: 'shell', conversationId: 'remote' },
    ]) await assert.rejects(f.creation.create(f.input(patch)), /Shell|类型|提供方/);
    const shell = await f.creation.create(f.input({ kind: 'shell' }));
    assert.deepEqual(shell.execution, { providerId: 'shell', mode: 'terminal' });
    assert.equal(shell.kind, 'shell'); assert.equal(f.store.state.sessions.length, 1);
  } finally { await f.dispose(); }
});
