import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { canonicalJson, runAgent, type BeginRunRequest, type RunResult } from '@cc-desk/agent-core';
import { NativeRunStore } from '@cc-desk/agent-node/run-store';
import { ResponsesModel } from '@cc-desk/agent-node/responses-model';
import { StateStore } from '../src/main/store';
import { ExecutionEvents } from '../src/main/execution/events';
import { ConnectionStore } from '../src/main/engines/native/connections';
import { NativeCredentialStore } from '../src/main/engines/native/credentials';
import { NativeMcpConnectionStore } from '../src/main/engines/native/mcp-connections';
import { NativeStructuredExecutor, type NativeExecutorOptions } from '../src/main/engines/native/structured-executor';
import { createNativeConfig, parseNativeConfig } from '../src/main/engines/native/config';
// @ts-expect-error The test-only ESM fixture has no declarations.
import { startResponsesFixture, assistantMessage, functionCall } from '../../../packages/agent-node/tests/fixtures/responses-server.mjs';

type Worker = NonNullable<NativeExecutorOptions['worker']>;
type ChildRecord = { event: string; pid: number; method?: string; id?: string | number; params?: Record<string, unknown>;
  cwd?: string; target?: string | null; source?: string | null; unrelated?: string | null; prepared?: number };
type Mode = 'normal' | 'bad_init' | 'hold' | 'echo_env' | 'gate_init';
const executableFixture = fileURLToPath(new URL('./fixtures/mcp-stdio-executor.mjs', import.meta.url));
const modelSecret = 'sk-native-stdio-executor-model-fixture';
const childSecret = 'native-stdio-only-child-environment-secret';
const unrelatedSecret = 'native-stdio-unrelated-parent-secret';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const inlineWorker: Worker = options => runAgent({ ...options.request, signal: options.signal }, {
  model: new ResponsesModel(options.model), tools: options.tools, store: options.store, approvals: options.approvals,
  host: { now: Date.now, digest, emit: options.onEvent,
    deadline: (timeout, parent) => {
      const controller = new AbortController(), abort = () => controller.abort();
      const timer = setTimeout(abort, timeout); parent.addEventListener('abort', abort, { once: true });
      if (parent.aborted) abort();
      return { signal: controller.signal, dispose: () => { clearTimeout(timer); parent.removeEventListener('abort', abort); } };
    },
  },
});

async function fixture(options: { mode?: Mode; workerFailure?: boolean; selected?: boolean; twoChildren?: boolean; gateStartup?: boolean } = {}) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'native-mcp-stdio-executor-')));
  const data = path.join(directory, 'data'), project = path.join(directory, 'project');
  const id = randomUUID(), conversationId = randomUUID(), projectId = randomUUID();
  await fs.mkdir(project); await fs.writeFile(path.join(project, 'AGENTS.md'), 'Only perform approved operations.\n');
  const journalFile = path.join(data, 'native', 'conversations', conversationId, 'journal.jsonl');
  const initializationGate = path.join(directory, 'initialization-released');
  const environment: NodeJS.ProcessEnv = { CC_DESK_STDIO_FIXTURE_SOURCE: childSecret };
  const previousUnrelated = process.env.CC_DESK_STDIO_FIXTURE_UNRELATED;
  process.env.CC_DESK_STDIO_FIXTURE_UNRELATED = unrelatedSecret;
  const server = await startResponsesFixture({ assertReplay: false, handler: ({ body }: { body: {
    input: Array<Record<string, unknown>>; tools: Array<{ name: string }>;
  } }) => {
    const turn = body.input.filter(item => item.role === 'user').length, callId = `turn-${turn}-stdio`;
    const result = body.input.find(item => item.type === 'function_call_output' && item.call_id === callId);
    if (result) return { output: [assistantMessage(`done-${turn}`, `MCP result: ${JSON.parse(String(result.output)).status}`)] };
    const tool = body.tools.find(item => item.name.startsWith('mcp_'));
    return { output: tool ? [functionCall(callId, tool.name, { note: 'approved fixture note' })] : [assistantMessage(`done-${turn}`, 'No MCP was selected.')] };
  } });
  let store = new StateStore(data), executor: NativeStructuredExecutor;
  let connections = new ConnectionStore(data);
  const model = connections.upsert({ name: 'local', protocol: 'responses', baseURL: server.baseURL,
    model: 'stdio-fixture', allowLoopbackHttp: true, enabled: true, auth: { mode: 'memory' } });
  const setModelSecret = () => {
    const view = connections.list().connections.find(item => item.id === model.id)!;
    connections.setCredential({ id: model.id, revision: view.revision, mode: 'memory', secret: modelSecret });
  };
  setModelSecret();
  const makeMcpStore = () => new NativeMcpConnectionStore(data, new NativeCredentialStore(), {
    environment, isConnectionActive: connectionId => Boolean(executor?.isMcpConnectionActive(connectionId)),
  });
  let mcpConnections = makeMcpStore();
  const logFiles: string[] = [];
  const addConnection = (name: string, mode: Mode, mapped: boolean) => {
    const logFile = path.join(directory, `child-${logFiles.length}.jsonl`); logFiles.push(logFile);
    return mcpConnections.upsert({ name, transport: 'stdio', protocolVersion: '2025-11-25', executable: process.execPath,
      argv: [executableFixture, logFile, options.gateStartup ? 'gate_init' : mode, journalFile, initializationGate], environment: mapped ? { FIXTURE_TARGET: 'CC_DESK_STDIO_FIXTURE_SOURCE' } : {},
      enabled: true, auth: { mode: 'none' } });
  };
  const mcpConnection = addConnection('Local stdio fixture', options.mode ?? 'normal', true);
  const extraConnection = options.twoChildren ? addConnection('Unrelated local stdio fixture', 'normal', false) : undefined;
  store.change(state => {
    state.projects.push({ id: projectId, path: project, name: 'project', createdAt: new Date().toISOString() });
    state.sessions.push({ id, projectId, title: 'Stdio MCP fixture', kind: 'agent', cwd: project,
      execution: { providerId: 'native', mode: 'structured', conversationId },
      engineConfig: createNativeConfig({ schemaVersion: 1, options: { connectionId: model.id,
        mcpConnections: options.selected === false ? [] : [mcpConnection.id, ...(extraConnection ? [extraConnection.id] : [])] } }),
      started: false, status: 'idle', archived: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  });
  const events = new ExecutionEvents(), workerPayloads: unknown[] = [], pending = new Set<Promise<unknown>>();
  const createExecutor = () => new NativeStructuredExecutor(store, connections, events, { mcpConnections, worker: workerOptions => {
    workerPayloads.push(structuredClone({ request: workerOptions.request, model: workerOptions.model, definitions: workerOptions.tools.definitions }));
    if (options.workerFailure) return Promise.reject(new Error('Controlled worker loss before its first model request.'));
    return inlineWorker(workerOptions);
  } });
  executor = createExecutor(); await executor.initialize();
  const childRecords = async (index?: number): Promise<ChildRecord[]> => {
    const files = index === undefined ? logFiles : [logFiles[index]];
    const records = await Promise.all(files.map(async file => {
      try { return (await fs.readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as ChildRecord); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    }));
    return records.flat();
  };
  const ledger = async () => {
    const current = await NativeRunStore.open({ rootDirectory: path.join(data, 'native', 'conversations'), conversationId });
    try { return { records: current.replay(), runs: current.listRuns(), context: current.loadContext(), recovery: current.getRecoveryReport() }; }
    finally { await current.close(); }
  };
  return { data, project, id, conversationId, journalFile, environment, server, mcpConnection, extraConnection, workerPayloads, childRecords, ledger,
    get store() { return store; }, get executor() { return executor; }, get mcpConnections() { return mcpConnections; },
    send(input: string, requestId: string = randomUUID()) {
      const promise = executor.send(id, input, [], undefined, { requestId }); pending.add(promise);
      void promise.then(() => pending.delete(promise), () => pending.delete(promise)); return promise;
    },
    async approval() {
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) {
        const approval = executor.snapshot(id).pending[0]; if (approval) return approval;
        if (!executor.has(id)) throw new Error(`Execution ended before the next approval: ${JSON.stringify(executor.snapshot(id))}`);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error('Expected approval within eight seconds.');
    },
    async waitFor(method: string) {
      const deadline = Date.now() + 5_000;
      while (!(await childRecords()).some(record => record.method === method)) {
        if (Date.now() > deadline) throw new Error(`Expected ${method} within five seconds.`);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    },
    async releaseInitialization() { await fs.writeFile(initializationGate, 'released\n'); },
    async restart() {
      await executor.shutdown(); store.flush(); store = new StateStore(data); connections = new ConnectionStore(data); setModelSecret();
      mcpConnections = makeMcpStore(); executor = createExecutor(); await executor.initialize();
    },
    async dispose() {
      await executor.shutdown().catch(() => {}); await Promise.allSettled(pending); await server.close(); store.flush();
      for (const record of await childRecords()) if (record.event === 'spawn') {
        try { process.kill(record.pid, 0); process.kill(record.pid, 'SIGKILL'); } catch { /* Confirmed-dead fixture needs no fallback cleanup. */ }
      }
      if (previousUnrelated === undefined) delete process.env.CC_DESK_STDIO_FIXTURE_UNRELATED;
      else process.env.CC_DESK_STDIO_FIXTURE_UNRELATED = previousUnrelated;
      await fs.rm(directory, { recursive: true, force: true });
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const allow = (f: Fixture, requestId: string) => f.executor.respond(f.id, requestId, { behavior: 'allow' });
async function allowStartup(f: Fixture) {
  const approval = await f.approval(); assert.equal(approval.toolName, 'mcp_stdio_startup');
  assert.equal((await f.childRecords()).filter(record => record.event === 'spawn').length, f.workerPayloads.length);
  assert.equal(JSON.stringify(approval).includes(childSecret), false); allow(f, approval.requestId); return approval;
}
async function allowTool(f: Fixture) {
  const approval = await f.approval(); assert.match(approval.toolName, /^mcp_/); assert.notEqual(approval.toolName, 'mcp_stdio_startup');
  allow(f, approval.requestId); return approval;
}
async function assertChildrenStopped(f: Fixture) {
  const records = await f.childRecords();
  for (const child of records.filter(record => record.event === 'spawn')) {
    assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' }, 'send must settle only after the local process is gone');
  }
  assert.equal(f.executor.isMcpConnectionActive(f.mcpConnection.id), false);
}
function assertNoChildSecrets(...values: unknown[]) {
  const text = JSON.stringify(values);
  for (const secret of [childSecret, unrelatedSecret]) assert.equal(text.includes(secret), false, 'child environment values must stay in main and the selected child');
}

test('saving, listing and running without selecting stdio never starts its configured executable', async () => {
  const f = await fixture({ selected: false });
  try {
    const listed = f.mcpConnections.list(); assert.equal(listed.connections[0].ready, true); assertNoChildSecrets(listed);
    assert.deepEqual(await f.childRecords(), []);
    assert.equal((await f.send('Use no MCP.')).success, true);
    assert.deepEqual(await f.childRecords(), []); assert.equal(f.executor.attention().length, 0);
    assert.equal((await f.ledger()).records.some(record => record.event.type === 'startup_prepared'), false);
  } finally { await f.dispose(); }
});

test('denying the stdio startup batch sends no model request and starts no process', async () => {
  const f = await fixture();
  try {
    const pending = f.send('Deny local startup.'); const approval = await f.approval();
    assert.equal(approval.toolName, 'mcp_stdio_startup'); assert.deepEqual(await f.childRecords(), []);
    f.executor.respond(f.id, approval.requestId, { behavior: 'deny' });
    assert.equal((await pending).success, false); assert.equal(f.server.requests.length, 0); assert.equal(f.workerPayloads.length, 0);
    assert.deepEqual(await f.childRecords(), []);
    assert.equal((await f.ledger()).records.some(record => record.event.type === 'startup_prepared'), false);
    assert.equal(f.executor.isMcpConnectionActive(f.mcpConnection.id), false);
  } finally { await f.dispose(); }
});

test('stdio startup is durably approved before spawn, tools require separate approval, and new turns use fresh processes', async () => {
  const f = await fixture();
  try {
    for (let turn = 1; turn <= 2; turn++) {
      const pending = f.send(`Approved turn ${turn}.`, `stdio-approved-${turn}`); await allowStartup(f);
      const approval = await f.approval(); assert.notEqual(approval.toolName, 'mcp_stdio_startup');
      let records = await f.childRecords(); assert.equal(records.filter(record => record.method === 'tools/call').length, turn - 1);
      assert.equal(records.filter(record => record.event === 'spawn').at(-1)?.prepared, turn, 'the child observes durable preparation before it starts');
      allow(f, approval.requestId); const result = await pending; assert.equal(result.success, true, JSON.stringify(result)); assert.match(result.summary, /completed/);
      await assertChildrenStopped(f); records = await f.childRecords();
      assert.equal(records.filter(record => record.method === 'initialize').length, turn);
      assert.equal(records.filter(record => record.method === 'notifications/initialized').length, turn);
      assert.equal(records.filter(record => record.method === 'tools/call').length, turn);
      const ledger = await f.ledger();
      assert.equal(ledger.records.filter(record => record.event.type === 'startup_prepared').length, turn);
      assert.equal(ledger.records.filter(record => record.event.type === 'startup_closed').length, turn);
    }
    const before = await f.childRecords(), requests = f.server.requests.length;
    assert.equal(new Set(before.filter(record => record.event === 'spawn').map(record => record.pid)).size, 2);
    assert.equal((await f.send('Approved turn 2.', 'stdio-approved-2')).success, true);
    assert.deepEqual(await f.childRecords(), before); assert.equal(f.server.requests.length, requests);
    assertNoChildSecrets(await f.ledger(), f.workerPayloads, f.server.requests, f.executor.snapshot(f.id));
    assert.deepEqual(f.server.errors, []);
  } finally { await f.dispose(); }
});

test('a pending stdio startup locks its metadata and rechecks changed project instructions before spawning', async () => {
  const f = await fixture();
  try {
    const pending = f.send('Check approval ownership.'); const approval = await f.approval();
    assert.equal(f.executor.isMcpConnectionActive(f.mcpConnection.id), true);
    const { credentialConfigured: _credential, ready: _ready, error: _error, ...input } = f.mcpConnection;
    assert.throws(() => f.mcpConnections.upsert({ ...input, name: 'Changed while active' }));
    assert.throws(() => f.mcpConnections.remove({ id: input.id, revision: input.revision }));
    await fs.writeFile(path.join(f.project, 'CLAUDE.md'), 'The startup approval must be requested again.\n');
    allow(f, approval.requestId); assert.equal((await pending).success, false);
    assert.deepEqual(await f.childRecords(), []); assert.equal(f.server.requests.length, 0);
    assert.equal(f.executor.isMcpConnectionActive(f.mcpConnection.id), false);
  } finally { await f.dispose(); }
});

test('changing a resolved stdio environment source during approval invalidates startup without exposing either value', async () => {
  const f = await fixture();
  try {
    const pending = f.send('Keep the approved environment.'); const approval = await f.approval();
    f.environment.CC_DESK_STDIO_FIXTURE_SOURCE = 'changed-private-child-environment';
    allow(f, approval.requestId); assert.equal((await pending).success, false);
    assert.deepEqual(await f.childRecords(), []); assert.equal(f.server.requests.length, 0);
    const publicState = JSON.stringify([f.executor.snapshot(f.id), await f.ledger()]);
    assert.equal(publicState.includes('changed-private-child-environment'), false); assertNoChildSecrets(publicState);
  } finally { await f.dispose(); }
});

test('bad stdio initialization and worker loss both close the approved child before send settles', async () => {
  for (const options of [{ mode: 'bad_init' as const }, { workerFailure: true }]) {
    const f = await fixture(options);
    try {
      const pending = f.send('Exercise controlled initialization or worker failure.'); await allowStartup(f);
      assert.equal((await pending).success, false); assert.equal(f.server.requests.length, 0);
      assert.equal((await f.childRecords()).filter(record => record.event === 'spawn').length, 1);
      await assertChildrenStopped(f);
      const ledger = await f.ledger(); assert.equal(ledger.records.filter(record => record.event.type === 'startup_prepared').length, 1);
      assert.equal(ledger.records.filter(record => record.event.type === 'startup_closed').length, 1);
    } finally { await f.dispose(); }
  }
});

test('a startup environment changed while the first child initializes prevents spawning the next approved child', async () => {
  const f = await fixture({ twoChildren: true, gateStartup: true, workerFailure: true });
  try {
    const pending = f.send('Recheck the batch immediately before each child starts.'); await allowStartup(f);
    await f.waitFor('initialize');
    assert.equal((await f.childRecords()).filter(record => record.event === 'spawn').length, 1);
    f.environment.CC_DESK_STDIO_FIXTURE_SOURCE = 'changed-while-first-child-initializes';
    await f.releaseInitialization(); assert.equal((await pending).success, false);
    assert.equal((await f.childRecords()).filter(record => record.event === 'spawn').length, 1, 'the stale batch approval cannot authorize the second spawn');
    assert.equal(f.workerPayloads.length, 0); assert.equal(f.server.requests.length, 0); await assertChildrenStopped(f);
    const ledger = await f.ledger();
    assert.equal(ledger.records.filter(record => record.event.type === 'startup_prepared').length, 1);
    assert.equal(ledger.records.filter(record => record.event.type === 'startup_closed').length, 1);
    assertNoChildSecrets(ledger, f.executor.snapshot(f.id));
  } finally { await f.dispose(); }
});

test('cancelling a dispatched stdio call closes its child and preserves the unknown-result barrier across restart', async () => {
  const f = await fixture({ mode: 'hold' });
  try {
    const pending = f.send('Cancel the issued note.', 'stdio-cancel'); await allowStartup(f); await allowTool(f);
    await f.waitFor('tools/call'); await f.executor.stop(f.id); assert.equal((await pending).success, false); await assertChildrenStopped(f);
    const records = await f.childRecords(), issued = records.find(record => record.method === 'tools/call')!;
    const cancelled = records.find(record => record.method === 'notifications/cancelled'); assert.ok(cancelled);
    assert.equal(cancelled.params?.requestId, issued.id); assert.equal(f.executor.recoveryRequired(f.id), true);
    assert.equal(f.executor.snapshot(f.id).nativeRecovery?.tools.unknown, 1);
    await f.restart(); assert.equal(f.executor.recoveryRequired(f.id), true);
    const before = await f.ledger(), requestCount = f.server.requests.length;
    assert.equal((await f.send('Cancel the issued note.', 'stdio-cancel')).success, false);
    assert.equal((await f.send('Do not automatically repeat an uncertain note.')).success, false);
    assert.deepEqual(await f.childRecords(), records); assert.equal(f.server.requests.length, requestCount);
    assert.deepEqual(await f.ledger(), before); assertNoChildSecrets(before, f.workerPayloads, f.executor.snapshot(f.id));
  } finally { await f.dispose(); }
});

test('one startup approval covers selected children while environment mappings stay isolated from other children and public data', async () => {
  const f = await fixture({ twoChildren: true });
  try {
    const pending = f.send('Approve the selected local servers.'); const startup = await allowStartup(f);
    const display = JSON.stringify(startup); assert.ok(display.includes(f.mcpConnection.id)); assert.ok(display.includes(f.extraConnection!.id));
    assert.ok(display.includes('FIXTURE_TARGET')); assert.ok(display.includes('CC_DESK_STDIO_FIXTURE_SOURCE')); assertNoChildSecrets(startup);
    await allowTool(f); assert.equal((await pending).success, true); await assertChildrenStopped(f);
    const first = (await f.childRecords(0)).find(record => record.event === 'spawn')!;
    const second = (await f.childRecords(1)).find(record => record.event === 'spawn')!;
    assert.equal(first.target, childSecret); assert.equal(second.target, null);
    for (const record of [first, second]) {
      assert.equal(record.cwd, f.project); assert.equal(record.source, null); assert.equal(record.unrelated, null); assert.equal(record.prepared, 1);
    }
    const ledger = await f.ledger(); assert.equal(ledger.records.filter(record => record.event.type === 'startup_prepared').length, 1);
    assertNoChildSecrets(ledger, f.workerPayloads, f.server.requests, f.executor.snapshot(f.id), f.mcpConnections.list());
  } finally { await f.dispose(); }
});

test('a stdio tool echoing its mapped environment value fails closed without leaking into worker, model, renderer or ledger', async () => {
  const f = await fixture({ mode: 'echo_env' });
  try {
    const pending = f.send('Reject child environment echo.'); await allowStartup(f); await allowTool(f);
    assert.equal((await pending).success, false); await assertChildrenStopped(f);
    assert.equal(f.executor.recoveryRequired(f.id), true); assert.equal(f.executor.snapshot(f.id).nativeRecovery?.tools.unknown, 1);
    assertNoChildSecrets(await f.ledger(), f.workerPayloads, f.server.requests, f.executor.snapshot(f.id));
  } finally { await f.dispose(); }
});

async function seedUnclosedStartup(f: Fixture, completed: boolean) {
  await f.executor.shutdown();
  const ledger = await NativeRunStore.open({ rootDirectory: path.join(f.data, 'native', 'conversations'), conversationId: f.conversationId });
  const input = 'Prepared startup needs explicit recovery.', requestId = completed ? 'finished-core-unclosed-startup' : 'prepared-before-core';
  const sessionOptions = parseNativeConfig(f.store.state.sessions.find(session => session.id === f.id)!.engineConfig);
  const identity = { sessionId: f.id, conversationId: f.conversationId, runId: randomUUID(), requestId, workerGeneration: 1 };
  const metadata = { cwd: f.project, servers: [{ connectionId: f.mcpConnection.id, transport: 'stdio', environmentSources: [] }] };
  const policyRevision = 'stdio-recovery-fixture', startupId = 'mcp_stdio_startup';
  try {
    await ledger.prepareStartup({ identity, startupId, inputDigest: digest(input), optionsDigest: digest(canonicalJson(sessionOptions)), metadata, policyRevision,
      approval: { decision: 'approved', expiresAt: Date.now() + 30_000,
        binding: { ...identity, toolCallId: startupId, inputDigest: digest(canonicalJson(metadata)), policyRevision } } });
    if (completed) {
      const request: BeginRunRequest = { identity, input, inputDigest: digest(input), userItems: [{ role: 'user', content: input }],
        protocol: { id: 'openai.responses', version: 1 }, configuration: { sessionOptions }, policyRevision };
      const accepted = await ledger.beginRun(request); assert.equal(accepted.kind, 'accepted');
      await ledger.append(identity, { type: 'model_response', response: { outputItems: [assistantMessage('complete-before-cleanup', 'Core completed.')],
        toolCalls: [], finishReason: 'completed', usage: null } });
      const result: RunResult = { identity, status: 'completed', reason: 'model_completed', modelRequests: 1, toolCalls: 0,
        context: ledger.loadContext()!, usage: null, committed: true };
      await ledger.append(identity, { type: 'run_finished', result });
    }
  } finally { await ledger.close(); }
  await f.restart(); return { input, requestId };
}

for (const completed of [false, true]) test(`unclosed stdio preparation blocks restart and duplicate receipts ${completed ? 'even after core completion' : 'before core run creation'}`, async () => {
  const f = await fixture();
  try {
    const receipt = await seedUnclosedStartup(f, completed); assert.equal(f.executor.recoveryRequired(f.id), true);
    const before = await f.ledger(); assert.equal(before.recovery?.classification, 'unknown_effects');
    assert.equal((await f.send(receipt.input, receipt.requestId)).success, false);
    assert.equal((await f.send('A new request cannot bypass the unresolved child.')).success, false);
    assert.deepEqual(await f.childRecords(), []); assert.equal(f.server.requests.length, 0); assert.equal(f.workerPayloads.length, 0);
    assert.deepEqual(await f.ledger(), before);
  } finally { await f.dispose(); }
});
