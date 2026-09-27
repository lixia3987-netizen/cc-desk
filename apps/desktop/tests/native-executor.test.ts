import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { runAgent } from '@cc-desk/agent-core';
import { NativeRunStore } from '@cc-desk/agent-node/run-store';
import { ResponsesModel } from '@cc-desk/agent-node/responses-model';
import { StateStore } from '../src/main/store';
import { ExecutionEvents } from '../src/main/execution/events';
import { ConnectionStore } from '../src/main/engines/native/connections';
import { NativeStructuredExecutor, type NativeExecutorOptions } from '../src/main/engines/native/structured-executor';
import { createNativeConfig } from '../src/main/engines/native/config';
// The package fixture is shared with real utilityProcess and packaged acceptance tests.
// @ts-expect-error Local test-only ESM fixture has no declarations.
import { startResponsesFixture, responseEvents, assistantMessage, functionCall } from '../../../packages/agent-node/tests/fixtures/responses-server.mjs';

const sentinel = 'sk-native-executor-sentinel-never-persist';
const inlineWorker: NonNullable<NativeExecutorOptions['worker']> = options => runAgent({ ...options.request, signal: options.signal }, {
  model: new ResponsesModel(options.model), tools: options.tools, store: options.store, approvals: options.approvals,
  host: { now: Date.now, digest: value => createHash('sha256').update(value).digest('hex'), emit: options.onEvent,
    deadline: (timeout, parent) => { const controller = new AbortController(); const abort = () => controller.abort(); const timer = setTimeout(abort, timeout); parent.addEventListener('abort', abort, { once: true }); if (parent.aborted) abort(); return { signal: controller.signal, dispose: () => { clearTimeout(timer); parent.removeEventListener('abort', abort); } }; },
  },
});
async function fixture(worker = inlineWorker) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-executor-'));
  const data = path.join(directory, 'data'), project = path.join(directory, 'project');
  await fs.mkdir(project); await fs.writeFile(path.join(project, 'fixture.txt'), 'original\n');
  await fs.writeFile(path.join(project, 'AGENTS.md'), 'Use the approved file tools and verify edits.\n');
  const server = await startResponsesFixture({ task: { path: 'fixture.txt', content: 'edited\n', command: { executable: process.execPath, argv: ['-e', 'process.stdout.write("verified")'], cwd: '.' } } });
  const store = new StateStore(data);
  const connections = new ConnectionStore(data);
  const created = connections.upsert({ name: 'local', protocol: 'responses', baseURL: server.baseURL, model: 'fixture-model', allowLoopbackHttp: true, enabled: true, auth: { mode: 'memory' } });
  const connection = connections.setCredential({ id: created.id, revision: created.revision, mode: 'memory', secret: sentinel });
  const id = randomUUID(), conversationId = randomUUID(), projectId = randomUUID();
  store.change(state => { state.projects.push({ id: projectId, path: project, name: 'project', createdAt: new Date().toISOString() }); state.sessions.push({ id, projectId, title: 'native', kind: 'agent', cwd: project, execution: { providerId: 'native', mode: 'structured', conversationId }, engineConfig: createNativeConfig({ schemaVersion: 1, options: { connectionId: connection.id } }), started: false, status: 'idle', archived: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }); });
  const events = new ExecutionEvents();
  let executor = new NativeStructuredExecutor(store, connections, events, { worker });
  await executor.initialize();
  const approvalIds = new Set<string>();
  const approve = (behavior: 'allow' | 'deny' = 'allow') => events.subscribe(event => {
    if (event.type !== 'conversation.changed') return;
    for (const pending of executor.snapshot(id).pending) if (!approvalIds.has(pending.requestId)) {
      approvalIds.add(pending.requestId);
      queueMicrotask(() => executor.respond(id, pending.requestId, { behavior }));
    }
  });
  return { directory, data, project, server, store, connections, connection, id, conversationId, events, approve,
    get executor() { return executor; },
    restart: async (next = new ConnectionStore(data)) => { await executor.shutdown(); executor = new NativeStructuredExecutor(store, next, events, { worker }); await executor.initialize(); return next; },
    dispose: async () => { await executor.shutdown().catch(() => {}); await server.close(); store.flush(); await fs.rm(directory, { recursive: true, force: true }); },
  };
}

test('native executor runs real local tools, durable projection and full-context restart without credential persistence', async () => {
  const f = await fixture(); const unsubscribe = f.approve();
  try {
    const result = await f.executor.send(f.id, '修改并验证', [], undefined, { requestId: 'durable-first' });
    assert.equal(result.success, true, JSON.stringify(result)); assert.match(result.summary, /完成/);
    assert.equal(await fs.readFile(path.join(f.project, 'fixture.txt'), 'utf8'), 'edited\n');
    assert.equal(f.executor.has(f.id), false); assert.equal(f.executor.snapshot(f.id).taskState, 'completed');
    assert.deepEqual(f.server.errors, []); assert.equal(f.server.requests.length, 4);
    const ledger = await NativeRunStore.open({ rootDirectory: path.join(f.data, 'native', 'conversations'), conversationId: f.conversationId });
    const runs = ledger.listRuns(); assert.equal(runs.length, 1); assert.equal(runs[0].tools.length, 3);
    assert.match(String(runs[0].configuration.modelInstructions), /Use the approved file tools/);
    assert.equal(JSON.stringify(ledger.replay()).includes(sentinel), false); await ledger.close();
    const restarted = await f.restart();
    const duplicate = await f.executor.send(f.id, '修改并验证', [], undefined, { requestId: 'durable-first' });
    assert.equal(duplicate.success, true); assert.equal(f.executor.snapshot(f.id).taskState, 'completed'); assert.equal(f.server.requests.length, 4, 'receipt retry requires neither key nor model');
    const view = restarted.list().connections[0]; restarted.setCredential({ id: view.id, revision: view.revision, mode: 'memory', secret: sentinel });
    const continued = await f.executor.send(f.id, '继续', [], undefined, { requestId: 'durable-second' });
    assert.equal(continued.success, true, JSON.stringify(continued)); assert.match(continued.summary, /完整上下文/); assert.equal(f.server.requests.length, 5); assert.deepEqual(f.server.errors, []);
    assert.equal(JSON.stringify(f.store.state).includes(sentinel), false); assert.equal(JSON.stringify(f.executor.snapshot(f.id)).includes(sentinel), false);
  } finally { unsubscribe(); await f.dispose(); }
});

test('denied write is a persisted tool result with no filesystem mutation', async () => {
  const f = await fixture(); const unsubscribe = f.approve('deny');
  try {
    const result = await f.executor.send(f.id, '修改');
    assert.equal(result.success, true, JSON.stringify(result)); assert.match(result.summary, /denied/);
    assert.equal(await fs.readFile(path.join(f.project, 'fixture.txt'), 'utf8'), 'original\n');
    assert.equal(f.server.requests.length, 3); assert.equal(f.executor.attention().length, 0);
  } finally { unsubscribe(); await f.dispose(); }
});

test('native config updates persist across store restart and change next-run budgets without replacing full context', async () => {
  const f = await fixture(); const unsubscribe = f.approve();
  const readLedger = async () => {
    const ledger = await NativeRunStore.open({ rootDirectory: path.join(f.data, 'native', 'conversations'), conversationId: f.conversationId });
    try { return { context: ledger.loadContext(), records: ledger.replay(), runs: ledger.listRuns() }; } finally { await ledger.close(); }
  };
  try {
    assert.equal((await f.executor.send(f.id, '修改并验证')).success, true);
    const before = await readLedger();
    const originalSession = structuredClone(f.store.state.sessions.find(item => item.id === f.id)!);
    const config = structuredClone(originalSession.engineConfig);
    config.options.maxInputTokens = 64010; config.options.maxOutputTokens = 1024;
    await f.executor.updateConfig(f.id, config);
    config.options.maxInputTokens = 99999;
    const updated = f.store.state.sessions.find(item => item.id === f.id)!;
    assert.equal(updated.engineConfig.options.maxInputTokens, 64010, 'stored config cannot alias the caller');
    assert.deepEqual(updated.execution, originalSession.execution);
    assert.deepEqual(await readLedger(), before, 'saving budgets never modifies the model ledger');
    const reloaded = new StateStore(f.data);
    assert.deepEqual(reloaded.state.sessions.find(item => item.id === f.id)!.engineConfig, updated.engineConfig);
    for (const options of [{ ...updated.engineConfig.options, model: 'another-model' }, { ...updated.engineConfig.options, connectionId: 'another-connection' }]) {
      await assert.rejects(f.executor.updateConfig(f.id, { schemaVersion: 1, options }), /新建会话/);
      assert.deepEqual(f.store.state.sessions.find(item => item.id === f.id)!.engineConfig, updated.engineConfig);
    }
    assert.equal((await f.executor.send(f.id, '继续')).success, true);
    assert.equal(f.server.requests.length, 5, 'the second run continues full context instead of repeating tools');
    const after = await readLedger();
    assert.deepEqual(after.records.slice(0, before.records.length), before.records);
    assert.deepEqual(after.context!.items.slice(0, before.context!.items.length), before.context!.items);
    assert.equal((after.runs.at(-1)!.configuration.sessionOptions as { maxInputTokens: number }).maxInputTokens, 64010);
    assert.equal(f.executor.snapshot(f.id).context?.budget?.maxInputTokens, 64010);
  } finally { unsubscribe(); await f.dispose(); }
});

test('invalid native config and failed persistence cannot overwrite the saved configuration', async () => {
  const f = await fixture();
  try {
    const before = structuredClone(f.store.state.sessions.find(item => item.id === f.id)!);
    const disk = await fs.readFile(f.store.file, 'utf8');
    for (const value of [1, NaN, Infinity, '64010']) await assert.rejects(f.executor.updateConfig(f.id, { schemaVersion: 1, options: { ...before.engineConfig.options, maxInputTokens: value } }));
    await assert.rejects(f.executor.updateConfig(f.id, { schemaVersion: 2, options: before.engineConfig.options }));
    assert.deepEqual(f.store.state.sessions.find(item => item.id === f.id), before);
    assert.equal(await fs.readFile(f.store.file, 'utf8'), disk);
    await fs.mkdir(f.store.file + '.tmp');
    try { await assert.rejects(f.executor.updateConfig(f.id, { schemaVersion: 1, options: { ...before.engineConfig.options, maxInputTokens: 64010 } })); }
    finally { await fs.rmdir(f.store.file + '.tmp'); }
    assert.deepEqual(f.store.state.sessions.find(item => item.id === f.id), before, 'failed disk commit cannot publish new in-memory config');
    assert.equal(await fs.readFile(f.store.file, 'utf8'), disk);
    assert.equal(f.server.requests.length, 0);
  } finally { await f.dispose(); }
});

test('native config updates remain blocked during active execution and stopping', async () => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(async options => { await blocked; return inlineWorker(options); });
  try {
    const before = structuredClone(f.store.state.sessions.find(item => item.id === f.id)!.engineConfig);
    const changed = { schemaVersion: 1, options: { ...before.options, maxInputTokens: 64010 } };
    const result = f.executor.send(f.id, '等待停止');
    await assert.rejects(f.executor.updateConfig(f.id, changed), /停止运行/);
    f.executor.interrupt(f.id);
    await assert.rejects(f.executor.updateConfig(f.id, changed), /停止运行/);
    assert.deepEqual(f.store.state.sessions.find(item => item.id === f.id)!.engineConfig, before);
    release(); await result; await f.executor.whenReleased(f.id);
    await f.executor.updateConfig(f.id, changed);
    assert.equal(new StateStore(f.data).state.sessions.find(item => item.id === f.id)!.engineConfig.options.maxInputTokens, 64010);
    assert.equal(f.server.requests.length, 0);
  } finally { release(); await f.dispose(); }
});

test('stable duplicate in-flight returns one promise and changed payload is rejected', async () => {
  let starts = 0;
  const f = await fixture(async options => { starts++; return inlineWorker(options); });
  try {
    const pending = f.executor.send(f.id, '修改', [], undefined, { requestId: 'same-request' });
    const duplicate = f.executor.send(f.id, '修改', [], undefined, { requestId: 'same-request' });
    assert.equal(pending, duplicate);
    await assert.rejects(f.executor.send(f.id, '不同输入', [], undefined, { requestId: 'same-request' }), /仍持有/);
    await new Promise<void>(resolve => { const off = f.events.subscribe(() => { if (f.executor.attention().length) { off(); resolve(); } }); });
    const approval = f.executor.attention()[0];
    assert.throws(() => f.executor.respond(f.id, randomUUID(), { behavior: 'allow' }), /审批/);
    assert.throws(() => f.executor.respond(f.id, approval.requestId, { behavior: 'allow', message: 'change parameters' }), /不能修改/);
    await f.executor.stopAndWait(f.id); const result = await pending;
    assert.equal(result.interrupted, true); assert.equal(starts, 1); assert.equal(f.executor.has(f.id), false);
    assert.throws(() => f.executor.respond(f.id, approval.requestId, { behavior: 'allow' }), /审批/);
    assert.equal(await fs.readFile(path.join(f.project, 'fixture.txt'), 'utf8'), 'original\n');
  } finally { await f.dispose(); }
});

test('missing credential and unsupported attachment reject before worker/model starts', async () => {
  let starts = 0; const f = await fixture(async options => { starts++; return inlineWorker(options); });
  try {
    await f.restart();
    const result = await f.executor.send(f.id, 'missing'); assert.equal(result.success, false);
    assert.equal(starts, 0); assert.equal(f.server.requests.length, 0);
    await assert.rejects(f.executor.send(f.id, 'attachment', ['/tmp/secret']), /附件/); assert.equal(starts, 0);
    assert.equal(f.executor.has(f.id), false);
  } finally { await f.dispose(); }
});

test('worker crash after durable acceptance blocks replay and persists explicit recovery acknowledgement', async () => {
  let starts = 0;
  const f = await fixture(async options => {
    starts++;
    const model = new ResponsesModel(options.model);
    await options.store.beginRun({ ...options.request, inputDigest: createHash('sha256').update(options.request.input).digest('hex'), userItems: model.userItems(options.request.input), protocol: model.protocol });
    throw new Error('worker crashed');
  });
  try {
    const result = await f.executor.send(f.id, 'uncertain', [], undefined, { requestId: 'uncertain' });
    assert.equal(result.success, false); assert.equal(f.executor.recoveryRequired(f.id), true); assert.match(f.executor.snapshot(f.id).error!, /此会话只读/);
    await f.executor.send(f.id, 'uncertain', [], undefined, { requestId: 'uncertain' }); assert.equal(starts, 1);
    await f.executor.confirmRecovery(f.id); assert.equal(f.executor.recoveryRequired(f.id), false);
    await f.restart(); assert.equal(f.executor.recoveryRequired(f.id), false, 'acknowledgement survives restart bound to ledger hash');
    const stillReadonly = await f.executor.send(f.id, 'new request'); assert.equal(stillReadonly.success, false); assert.equal(starts, 1);
  } finally { await f.dispose(); }
});

test('model failures carry no stale prior-turn summary into workflow result', async () => {
  const f = await fixture(); const unsubscribe = f.approve();
  try {
    assert.equal((await f.executor.send(f.id, 'first')).success, true);
    await f.server.close();
    const failed = await f.executor.send(f.id, 'second');
    assert.equal(failed.success, false); assert.equal(failed.summary, '');
  } finally { unsubscribe(); await f.executor.shutdown(); f.store.flush(); await fs.rm(f.directory, { recursive: true, force: true }); }
});


for (const reflected of ['text', 'tool_arguments', 'interleaved_text'] as const) test(`reflected credential split across ${reflected} SSE deltas never reaches renderer, approval, ledger or display export`, async () => {
  const f = await fixture();
  let authorizationObserved = false;
  const malicious = await startResponsesFixture({ handler: ({ request }: { request: { headers: { authorization?: string } } }) => {
    const key = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
    authorizationObserved = key === sentinel;
    const output = reflected === 'text'
      ? [assistantMessage('echo', `Safe prefix ${key} never display credential`)]
      : reflected === 'interleaved_text'
      ? [functionCall('filler', 'read_file', { path: 'fixture.txt' }), assistantMessage('echo', `Safe prefix ${key} never display credential`)]
      : [functionCall('echo', 'run_command', { executable: process.execPath, argv: ['-e', `process.stdout.write(${JSON.stringify(key)})`], cwd: '.' })];
    const events = responseEvents(output).flatMap((event: { type: string; delta?: string }) => {
      if (event.type !== 'response.output_text.delta' && event.type !== 'response.function_call_arguments.delta') return [event];
      if (reflected === 'interleaved_text' && event.type === 'response.output_text.delta') {
        const midpoint = 'Safe prefix '.length + Math.floor(key.length / 2);
        const filler = { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_filler', delta: ' '.repeat(key.length * 3) };
        return [{ ...event, delta: event.delta!.slice(0, midpoint) }, filler, { ...event, delta: event.delta!.slice(midpoint) }, filler];
      }
      // Both transport chunks and decoded SSE deltas split the credential. No
      // single delta contains it, so whole-event-only filtering is insufficient.
      return [...event.delta!].map(delta => ({ ...event, delta }));
    });
    return { output, events, splitBytes: 7 };
  } });
  const snapshots: string[] = [], events: string[] = [];
  let approvals = 0;
  const off = f.events.subscribe(event => {
    events.push(JSON.stringify(event));
    if (event.type === 'conversation.changed') snapshots.push(JSON.stringify(f.executor.snapshot(f.id)));
    if (event.type === 'journal' && event.event.type === 'approval_requested') approvals++;
  });
  try {
    const connection = f.connections.upsert({ name: 'malicious echo fixture', protocol: 'responses', baseURL: malicious.baseURL, model: 'echo-model', allowLoopbackHttp: true, enabled: true, auth: { mode: 'memory' } });
    f.connections.setCredential({ id: connection.id, revision: connection.revision, mode: 'memory', secret: sentinel });
    f.store.change(state => { state.sessions.find(session => session.id === f.id)!.engineConfig = createNativeConfig({ schemaVersion: 1, options: { connectionId: connection.id } }); });
    const result = await f.executor.send(f.id, 'Respond without exposing credentials');
    assert.equal(authorizationObserved, true, 'fixture echoed the real transport credential');
    assert.equal(result.success, false, 'credential echo fails closed, not silently redacted into a successful response');
    assert.equal(approvals, 0); assert.equal(f.executor.attention().length, 0);
    assert.equal(snapshots.some(snapshot => snapshot.includes(sentinel)), false, 'no transient renderer snapshot may expose the key');
    assert.equal(events.join('').includes(sentinel), false, 'renderer event stream is credential-free');
    assert.equal(JSON.stringify(result).includes(sentinel), false);
    assert.equal(await fs.readFile(path.join(f.project, 'fixture.txt'), 'utf8'), 'original\n');
    const ledger = await NativeRunStore.open({ rootDirectory: path.join(f.data, 'native', 'conversations'), conversationId: f.conversationId });
    try { assert.equal(JSON.stringify(ledger.replay()).includes(sentinel), false); assert.equal(ledger.listRuns()[0].tools.length, 0); } finally { await ledger.close(); }
    for (const entry of await fs.readdir(path.join(f.data, 'chat'))) {
      if (!entry.startsWith(f.id)) continue;
      assert.equal((await fs.readFile(path.join(f.data, 'chat', entry), 'utf8')).includes(sentinel), false, 'saved projection/export cannot contain credential');
    }
  } finally { off(); await malicious.close(); await f.dispose(); }
});

test('recovery confirmation stops releasing the barrier when its ledger binding becomes invalid in the same process', async () => {
  const f = await fixture(async options => {
    const model = new ResponsesModel(options.model);
    await options.store.beginRun({ ...options.request, inputDigest: 'crash-test-digest', userItems: model.userItems(options.request.input), protocol: model.protocol });
    throw new Error('worker crashed');
  });
  try {
    await f.executor.send(f.id, 'uncertain');
    assert.equal(f.executor.recoveryRequired(f.id), true);
    await f.executor.confirmRecovery(f.id); assert.equal(f.executor.recoveryRequired(f.id), false);
    const marker = path.join(f.data, 'native', 'recovery-confirmations', `${f.conversationId}.json`);
    const confirmation = JSON.parse(await fs.readFile(marker, 'utf8'));
    await fs.writeFile(marker, JSON.stringify({ ...confirmation, hash: '0'.repeat(64) }));
    await f.executor.hydrate(f.id);
    assert.equal(f.executor.recoveryRequired(f.id), true, 'a mismatched marker revokes the in-memory acknowledgement');
    await assert.rejects(f.executor.confirmRecovery(f.id + '-missing'));
  } finally { await f.dispose(); }
});

test('snapshot-only history remains readable and permanently read-only after recovery confirmation and restart', async () => {
  let starts = 0;
  const f = await fixture(async options => { starts++; return inlineWorker(options); });
  try {
    await f.executor.shutdown();
    const savedMessage = { id: 'missing-ledger-message', turnId: 'prior-turn', role: 'assistant', text: '保留这条展示历史，不能当成模型上下文。', createdAt: new Date().toISOString() };
    const file = path.join(f.data, 'chat', `${f.id}.json`);
    const original = JSON.stringify({ sessionId: f.id, taskState: 'completed', messages: [savedMessage], pending: [] });
    await fs.writeFile(file, original);
    await f.restart();
    assert.equal(f.executor.snapshot(f.id).messages[0].text, savedMessage.text);
    assert.equal(f.executor.snapshot(f.id).sourceIncomplete, true);
    assert.equal(f.executor.recoveryRequired(f.id), true, 'missing model ledger retains the directory recovery barrier');
    assert.match(f.executor.snapshot(f.id).error!, /原始模型记录缺失|只读/);
    const blocked = await f.executor.send(f.id, '不能使用展示摘要续聊');
    assert.equal(blocked.success, false); assert.equal(starts, 0);
    assert.equal((await f.executor.page(f.id)).messages[0].text, savedMessage.text);
    await f.executor.confirmRecovery(f.id);
    assert.equal(f.executor.recoveryRequired(f.id), false, 'manual confirmation releases only the directory recovery predicate');
    await f.restart();
    assert.equal(f.executor.recoveryRequired(f.id), false, 'matching recovery acknowledgement survives restart');
    assert.equal(f.executor.snapshot(f.id).messages[0].text, savedMessage.text);
    const stillBlocked = await f.executor.send(f.id, '确认目录后旧会话仍不能续聊');
    assert.equal(stillBlocked.success, false); assert.equal(starts, 0);
    assert.match(f.executor.snapshot(f.id).error!, /只读/);
    assert.equal(await fs.readFile(file, 'utf8'), original, 'initialization and rejected sends never erase display evidence');
  } finally { await f.dispose(); }
});

test('native shutdown waits through an empty writer-lock opening and late history reads cannot reopen it', async t => {
  const f = await fixture();
  // safeDirectory resolves the ledger root. macOS temp roots and test TMPDIR
  // aliases can spell the same directory differently from fs.open's real path.
  const root = await fs.realpath(path.join(f.data, 'native', 'conversations'));
  const lock = path.join(root, f.conversationId, '.writer-lock');
  const originalOpen = fs.open.bind(fs);
  let enter!: () => void, release!: () => void, opens = 0, shutdownFinished = false;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    if (args[0] === lock && typeof args[1] === 'number' && (args[1] & constants.O_EXCL)) {
      opens++; enter(); await pending;
    }
    return handle;
  });
  syncBuiltinESMExports();
  const hydration = f.executor.hydrate(f.id);
  let shutdown: Promise<void> | undefined;
  let enterTimeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      entered,
      hydration.then(() => { throw new Error('Writer-lock injection did not intercept the admitted ledger open'); }),
      new Promise<never>((_, reject) => { enterTimeout = setTimeout(() => reject(new Error('Writer-lock injection was not reached within 5 seconds')), 5_000); }),
    ]);
    clearTimeout(enterTimeout);
    assert.equal((await fs.stat(lock)).size, 0, 'pause after O_EXCL creates the lock, before its owner record is written');
    shutdown = f.executor.shutdown().then(() => { shutdownFinished = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(shutdownFinished, false, 'normal app exit must wait for every admitted ledger open and close');
    await f.executor.hydrate(f.id);
    assert.deepEqual((await f.executor.page(f.id)).messages, []);
    assert.deepEqual((await f.executor.search(f.id, 'late refresh')).hits, []);
    assert.equal(opens, 1, 'late renderer reads use the existing projection without creating a writer');
    release(); await hydration; await shutdown;
    await assert.rejects(fs.stat(lock), { code: 'ENOENT' });
    await f.executor.page(f.id); await f.executor.search(f.id, 'after shutdown');
    assert.equal(opens, 1);
    t.mock.restoreAll(); syncBuiltinESMExports();
    const reopened = await NativeRunStore.open({ rootDirectory: path.join(f.data, 'native', 'conversations'), conversationId: f.conversationId });
    try { assert.equal(reopened.recoveryRequired, false); assert.deepEqual(reopened.listRuns(), []); }
    finally { await reopened.close(); }
  } finally {
    clearTimeout(enterTimeout);
    release(); await hydration.catch(() => {}); await shutdown?.catch(() => {});
    t.mock.restoreAll(); syncBuiltinESMExports(); await f.dispose();
  }
});

test('native failed hydration close remains owned and an explicit shutdown retry performs real release', async t => {
  const f = await fixture();
  const lock = path.join(f.data, 'native', 'conversations', f.conversationId, '.writer-lock');
  const originalOpen = NativeRunStore.open.bind(NativeRunStore);
  let failClose = true, closeAttempts = 0, opens = 0;
  t.mock.method(NativeRunStore, 'open', async (options: Parameters<typeof NativeRunStore.open>[0]) => {
    opens++;
    const ledger = await originalOpen(options), close = ledger.close.bind(ledger);
    t.mock.method(ledger, 'close', async () => {
      closeAttempts++;
      if (failClose) throw new Error('fixture writer release unavailable');
      await close();
    });
    return ledger;
  });
  try {
    await assert.rejects(f.executor.hydrate(f.id), /writer release unavailable/);
    await assert.rejects(f.executor.shutdown(), /尚未完全释放/);
    assert.equal((await fs.stat(lock)).isFile(), true);
    await f.executor.page(f.id); await f.executor.search(f.id, 'failed quit');
    assert.equal(opens, 1);
    failClose = false;
    await f.executor.shutdown();
    assert.equal(closeAttempts, 3, 'the failed hydration and both quit attempts all reach the same owned close barrier');
    await assert.rejects(fs.stat(lock), { code: 'ENOENT' });
    const reopened = await originalOpen({ rootDirectory: path.join(f.data, 'native', 'conversations'), conversationId: f.conversationId });
    await reopened.close();
  } finally { failClose = false; await f.executor.shutdown().catch(() => {}); t.mock.restoreAll(); await f.dispose(); }
});
