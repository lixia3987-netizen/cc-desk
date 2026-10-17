import { after, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { runAgent } from '@cc-desk/agent-core';
import { NativeRunStore } from '@cc-desk/agent-node/run-store';
import { ResponsesModel } from '@cc-desk/agent-node/responses-model';
import { SkillSnapshotStore } from '@cc-desk/agent-node/skill-snapshots';
import type { NativeSkillSubmission } from '@cc-desk/contracts/native-skills';
import type { ChatSubmission } from '../src/shared/chat';
import type { Capabilities, Session } from '../src/shared/types';
import { StateStore } from '../src/main/store';
import { ChatQueueStorage } from '../src/main/chat-queue-storage';
import { ChatQueue } from '../src/main/chat-queue';
import { Attachments } from '../src/main/attachments';
import { ExecutionRegistry } from '../src/main/execution/registry';
import { ConnectionStore } from '../src/main/engines/native/connections';
import { NativeMcpConnectionStore } from '../src/main/engines/native/mcp-connections';
import { NativeCredentialStore } from '../src/main/engines/native/credentials';
import { NativeStructuredExecutor, type NativeExecutorOptions } from '../src/main/engines/native/structured-executor';
import { createNativeConfig, normalizeNativeLegacySkillPolicy } from '../src/main/engines/native/config';
import { NativeSkillCatalogHost } from '../src/main/engines/native/skill-catalog-host';
import { createNativeSkillHostRuntime } from '../src/main/engines/native/skill-host-runtime';
// @ts-expect-error Local HTTP/SSE fixture deliberately has no TypeScript declaration.
import { startResponsesFixture, assistantMessage } from '../../../packages/agent-node/tests/fixtures/responses-server.mjs';

const require = createRequire(import.meta.url), electronPath = require.resolve('electron'), previous = require.cache[electronPath];
require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true,
  exports: { dialog: {}, Notification: { isSupported: () => false } } } as NodeModule;
after(() => { if (previous) require.cache[electronPath] = previous; else delete require.cache[electronPath]; });

const guide = 'HOST_ASSEMBLY_EXPLICIT_GUIDE: Read every affected file before changing it.';
const credential = 'sk-host-assembly-active-model-private';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    assert.ok(Date.now() < deadline, 'timed out waiting for the actual host/queue/executor state');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
const inlineWorker: NonNullable<NativeExecutorOptions['worker']> = options => runAgent({ ...options.request, signal: options.signal }, {
  model: new ResponsesModel(options.model), tools: options.tools, store: options.store, approvals: options.approvals,
  contextMaintenance: options.contextMaintenance, completionValidation: options.completionValidation,
  host: { now: Date.now, digest: hash, emit: options.onEvent, consumeBudget: options.consumeBudget, deadline: (timeout, parent) => {
    const controller = new AbortController(), abort = () => controller.abort();
    const timer = setTimeout(abort, timeout); parent.addEventListener('abort', abort, { once: true });
    if (parent.aborted) abort();
    return { signal: controller.signal, dispose: () => { clearTimeout(timer); parent.removeEventListener('abort', abort); } };
  } },
});

async function fixture(t: TestContext, options: { enabled?: boolean; schemaVersion?: 1 | 2 } = {}) {
  const { SessionService } = await import('../src/main/session-service');
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'native-skill-host-')));
  const data = path.join(directory, 'data'), project = path.join(directory, 'project');
  const skillPath = path.join(project, '.agents', 'skills', 'review', 'SKILL.md');
  await fs.mkdir(path.dirname(skillPath), { recursive: true });
  await fs.writeFile(skillPath, `---\nname: review\ndescription: Host assembly review guide.\n---\n${guide}`);
  const server = await startResponsesFixture({ handler: () => ({ output: [assistantMessage('final', 'Done.')] }) });
  let store = new StateStore(data), connections = new ConnectionStore(data);
  const connection = connections.upsert({ name: 'local', protocol: 'responses', baseURL: server.baseURL, model: 'host-fixture',
    allowLoopbackHttp: true, enabled: true, auth: { mode: 'memory' } });
  connections.setCredential({ id: connection.id, revision: connection.revision, mode: 'memory', secret: credential });
  const id = randomUUID(), projectId = randomUUID(), conversationId = randomUUID(), now = new Date().toISOString();
  const schemaVersion = options.schemaVersion ?? 1;
  const session: Session = { id, projectId, title: 'host assembly', kind: 'agent', cwd: project,
    execution: { providerId: 'native', mode: 'structured', conversationId },
    engineConfig: createNativeConfig({ schemaVersion, options: { connectionId: connection.id,
      ...(schemaVersion === 2 ? { projectSkills: [], skills: normalizeNativeLegacySkillPolicy([]) } : {}) } }),
    started: false, status: 'idle', archived: false, createdAt: now, updatedAt: now };
  store.change(state => { state.projects.push({ id: projectId, name: 'project', path: project, createdAt: now }); state.sessions.push(session); });
  let mcpConnections: NativeMcpConnectionStore, catalog: NativeSkillCatalogHost, snapshots: SkillSnapshotStore;
  let assembly: ReturnType<typeof createNativeSkillHostRuntime>, executor: NativeStructuredExecutor;
  let service: InstanceType<typeof SessionService>, handlers: Map<string, (value: unknown) => unknown>;
  let preparations = 0;
  const environment: NodeJS.ProcessEnv = {};
  const assemble = async () => {
    mcpConnections = new NativeMcpConnectionStore(data, new NativeCredentialStore(), { environment });
    catalog = new NativeSkillCatalogHost(store);
    snapshots = new SkillSnapshotStore({ directory: path.join(data, 'native', 'skill-snapshots') });
    assembly = createNativeSkillHostRuntime(store, { catalog, connections, mcpConnections, snapshots });
    const registry = new ExecutionRegistry(sessionId => {
      const current = store.state.sessions.find(value => value.id === sessionId);
      if (!current) throw new Error('Session missing');
      return current;
    });
    executor = new NativeStructuredExecutor(store, connections, registry.events, {
      worker: inlineWorker, mcpConnections, ...(options.enabled === false ? {} : { skills: assembly.runtime }),
      assertOwnership: sessionId => service.assertExecutionOwnership(sessionId),
    });
    registry.register({ providerId: 'native', mode: 'structured', executor, validateConfig: createNativeConfig,
      capabilities: () => ({ available: true, structured: true, terminal: false, approvals: true, resume: false, fork: false,
        commands: false, contextUsage: true, liveConfig: false, attachments: true }) });
    service = new SessionService(store, registry, () => {}, () => null, {
      history: async () => ({ entries: [], total: 0, nextOffset: null }), diagnose: async () => { throw new Error('Not used'); },
    }, options.enabled === false ? {} : { prepareNativeSkills: async (sessionId, selected) => {
      preparations++; return assembly.prepareNativeSkills(sessionId, selected);
    } });
    handlers = new Map();
    service.register((name, schema, action) => handlers.set(name, value => action(schema.parse(value))));
    await executor.initialize();
  };
  await assemble();
  t.after(async () => {
    await service.shutdown(); await server.close(); store.flush(); await tick();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, data, project, skillPath, id, conversationId, server, environment,
    get store() { return store; }, get connections() { return connections; }, get mcpConnections() { return mcpConnections; },
    get catalog() { return catalog; }, get snapshots() { return snapshots; }, get assembly() { return assembly; },
    get service() { return service; }, get executor() { return executor; }, preparations: () => preparations,
    call: async <T>(name: string, value: unknown): Promise<T> => await handlers.get(name)!(value) as T,
    async selection(): Promise<NativeSkillSubmission> {
      const view = await catalog.catalog(id, true), descriptor = view.entries[0];
      assert.ok(descriptor);
      const loaded = await catalog.inspect(id, descriptor.skillId, view.revision);
      return { schemaVersion: 1, explicitSkillRefs: [{ skillId: descriptor.skillId, catalogRevision: view.revision, version: loaded.version }], excludedSkillIds: [] };
    },
    async ledger() {
      const ledger = await NativeRunStore.open({ rootDirectory: path.join(data, 'native', 'conversations'), conversationId });
      try { return { runs: ledger.listRuns(), records: ledger.replay() }; } finally { await ledger.close(); }
    },
    async restart() {
      await service.shutdown(); store.flush();
      store = new StateStore(data); connections = new ConnectionStore(data);
      await assemble();
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
function gateSnapshot(t: TestContext, f: Fixture, failure?: string) {
  const entered = deferred(), release = deferred(), original = f.snapshots.put.bind(f.snapshots);
  t.mock.method(f.snapshots, 'put', async (...args: Parameters<SkillSnapshotStore['put']>) => {
    entered.resolve(); await release.promise;
    if (failure) throw new Error(failure);
    return original(...args);
  });
  return { entered: entered.promise, release: release.resolve };
}
const assertNoAcceptance = (f: Fixture) => {
  assert.deepEqual(f.service.queue.snapshot(f.id).items, []);
  assert.deepEqual(f.service.queue.snapshot(f.id).receipts, []);
  assert.equal(f.server.requests.length, 0);
};

// These use the actual SessionService-created ChatQueue, factory, immutable disk store and executor.
test('host assembly keeps receipt pending until CAS is durable, then passes the frozen guide into the first real model request', async t => {
  const f = await fixture(t), selected = await f.selection(), gate = gateSnapshot(t, f);
  let acknowledged = false;
  const pending = f.call<ChatSubmission>('chat:submit', { id: f.id, text: 'Use the explicit guide.', requestId: 'host-accepted', nativeSkills: selected })
    .then(value => { acknowledged = true; return value; });
  await gate.entered; await tick();
  assert.equal(acknowledged, false); assertNoAcceptance(f);
  assert.deepEqual(await fs.readdir(path.join(f.data, 'native', 'skill-snapshots')).catch(() => []), []);
  // Pausing an in-flight preparation preserves its queue generation and prevents eager dispatch.
  f.service.queue.pause(f.id); gate.release();
  const accepted = await pending;
  assert.deepEqual(f.service.queue.snapshot(f.id).receipts, [{ requestId: 'host-accepted', messageId: accepted.messageId }]);
  assert.deepEqual(f.service.queue.snapshot(f.id).items[0].nativeSkills, selected);
  const version = selected.explicitSkillRefs[0].version;
  assert.match(await fs.readFile(path.join(f.data, 'native', 'skill-snapshots', `${version.fullFileHash}.skill`), 'utf8'), /HOST_ASSEMBLY_EXPLICIT_GUIDE/);
  assert.equal(f.server.requests.length, 0);
  await f.call('chat:queue-resume', f.id);
  await until(() => !f.service.queue.hasActive(f.id) && !f.service.queue.hasPending(f.id));
  assert.equal(f.server.requests.length, 1);
  assert.equal(f.server.requests[0].instructions.split(guide).length - 1, 1);
  assert.deepEqual(f.server.errors, []);
  const saved = await f.ledger();
  assert.deepEqual(saved.runs[0].configuration.nativeSkills, selected);
  assert.equal((saved.runs[0].configuration.initialNativeSkills as { activations: unknown[] }).activations.length, 1);
});

test('host assembly rejects a failed CAS write without an accepted receipt or model request', async t => {
  const f = await fixture(t), selected = await f.selection(), gate = gateSnapshot(t, f, 'fixture CAS write failed');
  const pending = f.call('chat:submit', { id: f.id, text: 'Keep draft', requestId: 'cas-failed', nativeSkills: selected });
  const rejection = assert.rejects(pending, /fixture CAS write failed/);
  await gate.entered; assertNoAcceptance(f); gate.release(); await rejection;
  assertNoAcceptance(f);
});

test('host assembly publishes no receipt when actual queue persistence fails after CAS persistence', async t => {
  const f = await fixture(t), selected = await f.selection();
  const original = ChatQueueStorage.prototype.save;
  t.mock.method(ChatQueueStorage.prototype, 'save', function (this: ChatQueueStorage, ...args: Parameters<ChatQueueStorage['save']>) {
    if (args[0] === f.id && args[1].items.length) throw new Error('fixture queue disk full');
    return original.apply(this, args);
  });
  await assert.rejects(f.call('chat:submit', { id: f.id, text: 'Keep draft', requestId: 'queue-failed', nativeSkills: selected }), /fixture queue disk full/);
  assertNoAcceptance(f);
  assert.match(await fs.readFile(path.join(f.data, 'native', 'skill-snapshots', `${selected.explicitSkillRefs[0].version.fullFileHash}.skill`), 'utf8'), /HOST_ASSEMBLY_EXPLICIT_GUIDE/);
});

test('interrupt during actual CAS preparation cancels acceptance even if the immutable write later completes', async t => {
  const f = await fixture(t), selected = await f.selection(), gate = gateSnapshot(t, f);
  const pending = f.call('chat:submit', { id: f.id, text: 'Cancelled draft', requestId: 'cancel-cas', nativeSkills: selected });
  const rejection = assert.rejects(pending, /技能提交已取消|会话已变化/);
  await gate.entered; await f.service.interrupt(f.id); gate.release(); await rejection;
  assertNoAcceptance(f);
});

for (const change of ['conversation', 'project', 'cwd', 'config'] as const) test(`host assembly rejects a late prepared selection after ${change} identity changes`, async t => {
  const f = await fixture(t), selected = await f.selection(), gate = gateSnapshot(t, f);
  const pending = f.call('chat:submit', { id: f.id, text: 'Bound draft', requestId: `late-${change}`, nativeSkills: selected });
  const rejection = assert.rejects(pending, /会话|来源配置|技能提交/);
  await gate.entered;
  f.store.change(state => {
    const session = state.sessions.find(value => value.id === f.id)!;
    if (change === 'conversation') session.execution.conversationId = randomUUID();
    if (change === 'project') state.projects.find(value => value.id === session.projectId)!.path = path.join(f.directory, 'changed-project');
    if (change === 'cwd') session.cwd = path.join(f.directory, 'changed-worktree');
    if (change === 'config') session.engineConfig.options.model = 'changed-model';
  });
  gate.release(); await rejection; assertNoAcceptance(f);
});

test('accepted queued versions pause before any run or model request if their source changed before dispatch', async t => {
  const f = await fixture(t), selected = await f.selection(), gate = gateSnapshot(t, f);
  const pending = f.call<ChatSubmission>('chat:submit', { id: f.id, text: 'Frozen queued guide', requestId: 'queued-change', nativeSkills: selected });
  await gate.entered; f.service.queue.pause(f.id); gate.release(); const accepted = await pending;
  await fs.writeFile(f.skillPath, 'Source changed after the accepted exact version.');
  await f.call('chat:queue-resume', f.id);
  await until(() => !!f.service.queue.snapshot(f.id).error && !f.service.queue.hasActive(f.id));
  const queue = f.service.queue.snapshot(f.id);
  assert.equal(queue.paused, true); assert.equal(queue.items[0].id, accepted.messageId);
  assert.deepEqual(queue.items[0].nativeSkills, selected);
  assert.match(queue.error!, /技能目录、来源或文件版本已改变/);
  assert.equal(f.server.requests.length, 0); assert.equal((await f.ledger()).runs.length, 0);
});

test('accepted queue receipt retries survive source/credential removal and host restart before preparing anything again', async t => {
  const f = await fixture(t), selected = await f.selection(), gate = gateSnapshot(t, f);
  const input = { id: f.id, text: 'Retained queued guide', requestId: 'restart-receipt', nativeSkills: selected };
  const pending = f.call<ChatSubmission>('chat:submit', input);
  await gate.entered; f.service.queue.pause(f.id); gate.release(); const accepted = await pending;
  assert.equal(f.preparations(), 1);
  await fs.rm(path.join(f.project, '.agents'), { recursive: true });
  const connection = f.connections.list().connections[0];
  f.connections.remove({ id: connection.id, revision: connection.revision });
  await f.restart();
  t.mock.method(f.assembly, 'prepareNativeSkills', async () => { throw new Error('accepted retry must precede preparation'); });
  t.mock.method(f.catalog, 'registry', () => { throw new Error('accepted retry must not discover sources'); });
  t.mock.method(f.connections, 'protectedValues', () => { throw new Error('accepted retry must not need current credentials'); });
  assert.deepEqual(await f.call('chat:submit', input), accepted);
  assert.equal(f.preparations(), 1); assert.equal(f.service.queue.snapshot(f.id).paused, true);
  assert.deepEqual(f.service.queue.snapshot(f.id).items[0].nativeSkills, selected);
  const changed = structuredClone(selected); changed.explicitSkillRefs[0].version.fullFileHash = 'a'.repeat(64);
  await assert.rejects(f.call('chat:submit', { ...input, nativeSkills: changed }), /不同内容/);
  await assert.rejects(f.call('chat:submit', { ...input, nativeSkills: undefined }), /不同内容/);
  assert.equal(f.server.requests.length, 0);
});

for (const secretType of ['disabled-model', 'disabled-mcp-http', 'disabled-mcp-stdio'] as const) test(`shared host protection includes ${secretType} credentials before any CAS put`, async t => {
  const f = await fixture(t), privateValue = `PRIVATE_HOST_${secretType.replaceAll('-', '_')}_CREDENTIAL`;
  if (secretType === 'disabled-model') {
    const item = f.connections.upsert({ name: 'disabled', protocol: 'responses', baseURL: 'https://fixture.invalid/v1', model: 'disabled',
      enabled: false, allowLoopbackHttp: false, auth: { mode: 'memory' } });
    f.connections.setCredential({ id: item.id, revision: item.revision, mode: 'memory', secret: privateValue });
  } else if (secretType === 'disabled-mcp-http') {
    const item = f.mcpConnections.upsert({ name: 'disabled', transport: 'http', endpoint: 'https://fixture.invalid/mcp',
      enabled: false, allowLoopbackHttp: false, auth: { mode: 'memory' }, protocolVersion: '2025-11-25' });
    f.mcpConnections.setCredential({ id: item.id, revision: item.revision, mode: 'memory', secret: privateValue });
  } else {
    f.environment.CC_DESK_HOST_ASSEMBLY_SECRET = privateValue;
    f.mcpConnections.upsert({ name: 'disabled', transport: 'stdio', executable: process.execPath, argv: [],
      environment: { SERVICE_TOKEN: 'CC_DESK_HOST_ASSEMBLY_SECRET' }, enabled: false, auth: { mode: 'none' }, protocolVersion: '2025-11-25' });
  }
  await fs.writeFile(f.skillPath, `---\nname: review\ndescription: Host assembly review guide.\n---\nDo not publish ${privateValue}`);
  const selected = await f.selection(); let writes = 0;
  t.mock.method(f.snapshots, 'put', async () => { writes++; throw new Error('credential reached CAS'); });
  await assert.rejects(f.call('chat:submit', { id: f.id, text: 'Protected draft', requestId: secretType, nativeSkills: selected }), error => {
    assert.ok(error instanceof Error); assert.equal(error.message.includes(privateValue), false); return true;
  });
  assert.equal(writes, 0); assertNoAcceptance(f);
  assert.deepEqual(await fs.readdir(path.join(f.data, 'native', 'skill-snapshots')).catch(() => []), []);
});

for (const schemaVersion of [1, 2] as const) test(`ordinary v${schemaVersion} legacy host sends remain free of registry/CAS access, skill tools and new guide body`, async t => {
  const f = await fixture(t, { enabled: false, schemaVersion });
  t.mock.method(f.catalog, 'registry', () => { throw new Error('ordinary legacy send must not scan'); });
  t.mock.method(f.snapshots, 'put', async () => { throw new Error('ordinary legacy send must not write CAS'); });
  await f.call('chat:submit', { id: f.id, text: 'Ordinary existing message', requestId: `ordinary-v${schemaVersion}` });
  await until(() => !f.service.queue.hasActive(f.id) && !f.service.queue.hasPending(f.id));
  assert.equal(f.server.requests.length, 1); assert.deepEqual(f.server.errors, []);
  assert.equal(f.preparations(), 0);
  assert.ok(f.server.requests[0].tools.every((tool: { name: string }) => !['list_skills', 'load_skill'].includes(tool.name)));
  assert.equal(f.server.requests[0].instructions.includes(guide), false);
  const saved = await f.ledger();
  assert.equal(saved.runs[0].configuration.nativeSkills, undefined);
  assert.equal(saved.runs[0].configuration.nativeSkillCatalog, undefined);
  assert.deepEqual(await fs.readdir(path.join(f.data, 'native', 'skill-snapshots')).catch(() => []), []);
});


for (const change of ['config', 'project'] as const) test(`factory-created run guards retain original ${change} scope across later runtime operations`, async t => {
  const f = await fixture(t), selected = await f.selection();
  await f.assembly.prepareNativeSkills(f.id, selected);
  const active = await f.assembly.runtime.createRun({ sessionId: f.id,
    identity: { sessionId: f.id, conversationId: f.conversationId, runId: randomUUID(), requestId: 'scope-run', workerGeneration: 1 },
    submission: selected, signal: new AbortController().signal, baseInstructionBytes: 0, assertOwnership: () => {} });
  await active.assertInitialCurrent();
  f.store.change(state => {
    if (change === 'config') state.sessions.find(value => value.id === f.id)!.engineConfig.options.model = 'changed-after-capture';
    else state.projects[0].path = path.join(f.directory, 'different-project');
  });
  await assert.rejects(active.assertInitialCurrent(), /会话或 Skills 来源配置已变化/);
  await assert.rejects(active.tools.assertSideEffectsCurrent(new AbortController().signal), /会话或 Skills 来源配置已变化/);
  assert.equal(f.server.requests.length, 0);
});

test('the production executor composition root passes a Skills runtime only through explicit internal injection', async t => {
  const f = await fixture(t);
  const { createExecutors } = await import('../src/main/execution/create-executors');
  const capabilities = () => ({ efforts: ['default'] }) as Capabilities;
  for (const enabled of [false, true]) {
    let native: NativeStructuredExecutor | undefined;
    const registry = createExecutors(f.store, capabilities, error => { throw error; }, {
      connections: f.connections, mcpConnections: f.mcpConnections,
      ...(enabled ? { skills: f.assembly.runtime } : {}), onNative: value => { native = value; },
    });
    try {
      assert.ok(native instanceof NativeStructuredExecutor);
      assert.equal(registry.structured(f.id), native);
      // A bounded assembly assertion avoids adding a worker override to the production API.
      assert.equal((native as unknown as { options: NativeExecutorOptions }).options.skills, enabled ? f.assembly.runtime : undefined);
    } finally { await registry.shutdown(); }
  }
  assert.equal(f.server.requests.length, 0);
});


for (const action of ['interrupt', 'identity-change', 'config-change'] as const) test(`prepared selection cannot be accepted after ${action} while attachment ownership is still awaiting I/O`, async t => {
  const f = await fixture(t), selected = await f.selection(), entered = deferred(), release = deferred();
  const original = Attachments.prototype.acceptQueued;
  t.mock.method(Attachments.prototype, 'acceptQueued', async function (this: Attachments, ...args: Parameters<Attachments['acceptQueued']>) {
    entered.resolve(); await release.promise;
    return original.apply(this, args);
  });
  const pending = f.call('chat:submit', { id: f.id, text: 'Prepared but not accepted', requestId: `attachment-window-${action}`, nativeSkills: selected });
  const rejection = assert.rejects(pending, /技能提交已取消|会话已变化/);
  await entered.promise;
  assert.equal(f.preparations(), 1);
  assert.match(await fs.readFile(path.join(f.data, 'native', 'skill-snapshots', `${selected.explicitSkillRefs[0].version.fullFileHash}.skill`), 'utf8'), /HOST_ASSEMBLY_EXPLICIT_GUIDE/);
  assertNoAcceptance(f);
  if (action === 'interrupt') await f.service.interrupt(f.id);
  else f.store.change(state => {
    if (action === 'identity-change') state.sessions[0].execution.conversationId = randomUUID();
    else state.sessions[0].engineConfig.options.model = 'config-changed-during-attachment-I/O';
  });
  release.resolve(); await rejection; assertNoAcceptance(f);
});

test('a completed engine maintenance cycle invalidates a still-pending skill preparation', async t => {
  const f = await fixture(t), selected = await f.selection(), gate = gateSnapshot(t, f);
  const pending = f.call('chat:submit', { id: f.id, text: 'Old preparation', requestId: 'maintenance-window', nativeSkills: selected });
  const rejection = assert.rejects(pending, /维护已取消此前操作|技能提交已取消/);
  await gate.entered;
  let maintained = false;
  await f.service.withEngineMaintenance('native', async () => { maintained = true; });
  assert.equal(maintained, true);
  gate.release(); await rejection; assertNoAcceptance(f);
});

test('interrupt immediately after submit invalidates preparation captured before the queue serial turn', async t => {
  const f = await fixture(t), selected = await f.selection();
  const pending = f.service.queue.submit(f.id, 'Cancelled before queue turn', [], 'synchronous-cancel', { nativeSkills: selected });
  const rejected = assert.rejects(pending, /取消/);
  await f.service.interrupt(f.id);
  await rejected;
  assert.equal(f.preparations(), 0);
  assertNoAcceptance(f);
});


function hostQueueOptions(f: Fixture) {
  // Use the existing constructor dependency as an I/O gate without extending the production API.
  type QueueOptions = ConstructorParameters<typeof ChatQueue>[1];
  const options = (f.service.queue as unknown as { options: QueueOptions }).options;
  assert.equal(typeof options.attachmentMetadata, 'function');
  assert.equal(typeof options.captureNativeSkillAdmission, 'function');
  return options as QueueOptions & Required<Pick<QueueOptions, 'attachmentMetadata' | 'captureNativeSkillAdmission'>>;
}
function gateAttachmentMetadata(t: TestContext, f: Fixture) {
  const options = hostQueueOptions(f), original = options.attachmentMetadata!.bind(options);
  const entered = deferred(), release = deferred();
  t.mock.method(options, 'attachmentMetadata', async (...args: Parameters<NonNullable<typeof options.attachmentMetadata>>) => {
    const metadata = await original(...args);
    entered.resolve(); await release.promise;
    return metadata;
  });
  return { entered: entered.promise, release: release.resolve };
}

test('interrupt while the host attachment metadata callback is awaiting rejects a new skill submission before preparation', async t => {
  const f = await fixture(t), selected = await f.selection(), gate = gateAttachmentMetadata(t, f);
  const pending = f.call('chat:submit', { id: f.id, text: 'Cancelled during metadata', requestId: 'metadata-cancel', nativeSkills: selected });
  const rejection = assert.rejects(pending, /技能提交已取消|会话已变化/);
  await gate.entered;
  assert.equal(f.preparations(), 0); assertNoAcceptance(f);
  await f.service.interrupt(f.id);
  gate.release(); await rejection;
  assert.equal(f.preparations(), 0); assertNoAcceptance(f);
  assert.deepEqual(await fs.readdir(path.join(f.data, 'native', 'skill-snapshots')).catch(() => []), []);
});

test('interrupt during attachment metadata lookup still returns an accepted same-request receipt before new Skills checks', async t => {
  const f = await fixture(t), selected = await f.selection(), initialGate = gateSnapshot(t, f);
  const input = { id: f.id, text: 'Already accepted before interruption', requestId: 'metadata-old-receipt', nativeSkills: selected };
  const first = f.call<ChatSubmission>('chat:submit', input);
  await initialGate.entered; f.service.queue.pause(f.id); initialGate.release(); const accepted = await first;
  t.mock.method(f.assembly, 'prepareNativeSkills', async () => { throw new Error('accepted receipt must not prepare again'); });
  t.mock.method(f.snapshots, 'put', async () => { throw new Error('accepted receipt must not write CAS again'); });
  const gate = gateAttachmentMetadata(t, f);
  let acknowledged = false;
  const retry = f.call<ChatSubmission>('chat:submit', input).then(value => { acknowledged = true; return value; });
  await gate.entered;
  assert.equal(acknowledged, false);
  await f.service.interrupt(f.id);
  gate.release();
  assert.deepEqual(await retry, accepted);
  assert.equal(f.preparations(), 1); assert.equal(f.server.requests.length, 0);
  assert.deepEqual(f.service.queue.snapshot(f.id).receipts, [{ requestId: input.requestId, messageId: accepted.messageId }]);
  assert.equal(f.service.queue.snapshot(f.id).items.length, 1);
});

test('a failed Skills admission capture rejects only new skill intent and preserves accepted retries and ordinary sends', async t => {
  const f = await fixture(t), selected = await f.selection(), gate = gateSnapshot(t, f);
  const input = { id: f.id, text: 'Accepted before capture failure', requestId: 'capture-old-receipt', nativeSkills: selected };
  const first = f.call<ChatSubmission>('chat:submit', input);
  await gate.entered; f.service.queue.pause(f.id); gate.release(); const accepted = await first;
  let captures = 0;
  t.mock.method(hostQueueOptions(f), 'captureNativeSkillAdmission', () => {
    captures++; throw new Error('fixture Skills admission capture failed');
  });
  t.mock.method(f.assembly, 'prepareNativeSkills', async () => { throw new Error('captured failure/old receipt must not prepare'); });
  t.mock.method(f.snapshots, 'put', async () => { throw new Error('captured failure/old receipt must not write CAS'); });
  assert.deepEqual(await f.call('chat:submit', input), accepted);
  assert.equal(captures, 1);
  await assert.rejects(f.call('chat:submit', { ...input, requestId: 'capture-new-intent' }), /fixture Skills admission capture failed/);
  assert.equal(captures, 2);
  assert.equal(f.service.queue.snapshot(f.id).items.length, 1);
  assert.deepEqual(f.service.queue.snapshot(f.id).receipts, [{ requestId: input.requestId, messageId: accepted.messageId }]);
  const ordinary = await f.call<ChatSubmission>('chat:submit', { id: f.id, text: 'Ordinary send without Skills dependency', requestId: 'capture-ordinary' });
  assert.ok(ordinary.messageId); assert.equal(captures, 2, 'ordinary submits must not capture a Skills admission');
  assert.equal(f.preparations(), 1); assert.equal(f.server.requests.length, 0);
  assert.equal(f.service.queue.snapshot(f.id).items.length, 2);
});
