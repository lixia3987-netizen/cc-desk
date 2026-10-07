import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { StateStore } from '../src/main/store';
import { SessionCreation } from '../src/main/session-creation';
import { SessionService } from '../src/main/session-service';
import { ExecutionRegistry } from '../src/main/execution/registry';
import { createNativeConfig, createNativeDefaultConfig } from '../src/main/engines/native/config';
import type { StructuredExecutor } from '../src/main/execution/ports';
import type { EngineConfig, NewSession } from '../src/shared/types';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccdesk-native-session-defaults-'));
  const projectPath = path.join(root, 'project');
  fs.mkdirSync(projectPath);
  const store = new StateStore(path.join(root, 'data'));
  const projectId = randomUUID();
  store.change(state => state.projects.push({ id: projectId, path: projectPath, name: 'Fixture', createdAt: new Date().toISOString() }));
  const registry = new ExecutionRegistry(id => {
    const session = store.state.sessions.find(item => item.id === id);
    if (!session) throw new Error('Missing fixture session');
    return session;
  });
  const unexpected = () => { throw new Error('Creation must not dispatch execution'); };
  const executor: StructuredExecutor = {
    activeCount: 0, has: () => false, isBusy: () => false, taskState: () => 'idle',
    hydrate: async () => {}, snapshot: unexpected, page: async () => unexpected(), search: async () => unexpected(),
    attention: () => [], send: async () => unexpected(), prepareCommands: async () => unexpected(),
    respond: unexpected, updateConfig: async () => unexpected(), exports: async () => [],
    interrupt: unexpected, stop: unexpected, stopIdle: async () => {}, forget: () => {},
    setMaintenance: () => {}, disconnectAll: async () => {}, shutdown: async () => {},
  };
  for (const providerId of ['native', 'other.engine']) registry.register({
    providerId, mode: 'structured', executor,
    configuration: () => ({ schemaVersion: 1, defaults: providerId === 'native' ? createNativeDefaultConfig() : { schemaVersion: 1, options: {} }, fields: [] }),
    validateConfig: providerId === 'native' ? createNativeConfig : config => config,
    capabilities: () => ({ available: true, structured: true, terminal: false, approvals: false, resume: true, fork: true,
      commands: false, contextUsage: false, liveConfig: false, attachments: false }),
    // Native currently disallows forks; the creation boundary must also preserve any future provider source config.
    createIdentity: input => ({ providerId, mode: 'structured',
      conversationId: input.conversationId && !input.fork ? input.conversationId : randomUUID(),
      ...(input.fork ? { forkFrom: input.conversationId } : {}),
      imported: !!input.conversationId && !input.fork,
    }),
  });
  const services = new SessionService(store, registry, () => {}, () => null, {
    history: async () => ({ entries: [], total: 0, nextOffset: null }), diagnose: async () => { throw new Error('Unused query'); },
  });
  const creation = new SessionCreation(store, services, () => {}, 'native');
  return { store, creation,
    input: (patch: Partial<NewSession> = {}): NewSession => ({ projectId, title: '', kind: 'agent', isolated: false, mode: 'structured', ...patch }),
    setDefaults: (providerId: string, config: EngineConfig) => store.change(state => { state.settings.engineDefaults[providerId] = structuredClone(config); }),
    async dispose() { try { await services.shutdown(); store.flush(); } finally { fs.rmSync(root, { recursive: true, force: true }); } },
  };
}

test('Native API creation without engineConfig follows fresh defaults and persists the inheritance marker', async () => {
  const f = fixture();
  try {
    const session = await f.creation.create(f.input());
    assert.equal(session.engineConfig.options.runtimePolicy, 'defaults');
    assert.equal(session.engineConfig.options.inputBudgetMode, 'model');
    assert.equal(session.engineConfig.options.maxInputTokens, 64_000);
    assert.equal(session.engineConfig.options.maxOutputTokens, 8192);
    assert.deepEqual(new StateStore(f.store.directory).state.sessions[0].engineConfig, session.engineConfig);
    assert.deepEqual(f.store.state.settings.engineDefaults, {});
  } finally { await f.dispose(); }
});

test('Native API creation merges legacy saved defaults with the model budget mode without rewriting settings', async () => {
  const f = fixture();
  const legacy: EngineConfig = { schemaVersion: 1, options: { connectionId: 'saved-connection', model: 'saved-model',
    maxInputTokens: 32_000, maxOutputTokens: 4096, autoCompact: 'before_send', maxModelRequests: 12, mcpConnections: ['saved-mcp'] } };
  try {
    f.setDefaults('native', legacy);
    const session = await f.creation.create(f.input());
    assert.deepEqual(session.engineConfig, createNativeConfig({ schemaVersion: 1,
      options: { ...createNativeDefaultConfig().options, ...legacy.options, runtimePolicy: 'defaults' } }));
    assert.equal(session.engineConfig.options.inputBudgetMode, 'model');
    assert.deepEqual(new StateStore(f.store.directory).state.settings.engineDefaults.native, legacy);
  } finally { await f.dispose(); }
});

test('Native API creation preserves an explicitly saved custom budget mode while following settings', async () => {
  const f = fixture();
  const defaults = createNativeConfig({ schemaVersion: 1, options: { inputBudgetMode: 'custom', maxInputTokens: 48_000 } });
  try {
    f.setDefaults('native', defaults);
    const session = await f.creation.create(f.input());
    assert.equal(session.engineConfig.options.runtimePolicy, 'defaults');
    assert.equal(session.engineConfig.options.inputBudgetMode, 'custom');
    assert.equal(session.engineConfig.options.maxInputTokens, 48_000);
    assert.deepEqual(f.store.state.settings.engineDefaults.native, defaults);
  } finally { await f.dispose(); }
});

test('explicit legacy Native session configs retain custom markers and their numeric budget', async () => {
  const f = fixture();
  const legacy: EngineConfig = { schemaVersion: 1, options: { connectionId: 'legacy-connection', maxInputTokens: 64_000 } };
  try {
    f.setDefaults('native', createNativeConfig({ schemaVersion: 1, options: { inputBudgetMode: 'model', maxInputTokens: 8000 } }));
    const session = await f.creation.create(f.input({ engineConfig: legacy }));
    assert.deepEqual(session.engineConfig, createNativeConfig(legacy));
    assert.equal(session.engineConfig.options.runtimePolicy, 'custom');
    assert.equal(session.engineConfig.options.inputBudgetMode, 'custom');
    assert.equal(session.engineConfig.options.maxInputTokens, 64_000);
    assert.deepEqual(legacy.options, { connectionId: 'legacy-connection', maxInputTokens: 64_000 });
  } finally { await f.dispose(); }
});

test('Native creation preserves source configs when the registered provider supports forking', async () => {
  const f = fixture();
  try {
    const source = await f.creation.create(f.input({ engineConfig: { schemaVersion: 1, options: { maxInputTokens: 64_000 } } }));
    f.setDefaults('native', createNativeConfig({ schemaVersion: 1, options: { inputBudgetMode: 'model', maxInputTokens: 8000 } }));
    const fork = await f.creation.create(f.input({ conversationId: source.execution.conversationId, fork: true }));
    assert.deepEqual(fork.engineConfig, source.engineConfig);
    assert.equal(fork.engineConfig.options.runtimePolicy, 'custom');
    assert.equal(fork.engineConfig.options.inputBudgetMode, 'custom');
    assert.deepEqual(new StateStore(f.store.directory).state.sessions.find(session => session.id === source.id)?.engineConfig, source.engineConfig);
  } finally { await f.dispose(); }
});

test('non-Native creation retains the provider saved defaults without adding Native policy fields', async () => {
  const f = fixture();
  const defaults: EngineConfig = { schemaVersion: 1, options: { profile: 'research', budget: 73 } };
  try {
    f.setDefaults('other.engine', defaults);
    const session = await f.creation.create(f.input({ providerId: 'other.engine' }));
    assert.deepEqual(session.engineConfig, defaults);
  } finally { await f.dispose(); }
});

for (const schemaVersion of [0, 2]) test(`Native API creation rejects saved defaults version ${schemaVersion} and leaves the workspace intact`, async () => {
  const f = fixture();
  const unknown: EngineConfig = { schemaVersion, options: { futureBudget: 123 } };
  try {
    f.setDefaults('native', unknown);
    const persisted = fs.readFileSync(f.store.file, 'utf8');
    await assert.rejects(f.creation.create(f.input()), /配置版本不受支持|不支持此 native 配置版本/);
    assert.equal(f.store.state.sessions.length, 0);
    assert.deepEqual(f.store.state.settings.engineDefaults.native, unknown);
    assert.equal(fs.readFileSync(f.store.file, 'utf8'), persisted);
  } finally { await f.dispose(); }
});
