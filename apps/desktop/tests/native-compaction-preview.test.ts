import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { BeginRunRequest, JsonValue, ModelContext, ProtocolVersion } from '@cc-desk/agent-core';
import { NativeRunStore, RunStoreError, type ContextCompactionSource } from '@cc-desk/agent-node/run-store';
import type { NativeContextCompactionPreview } from '../src/shared/chat';
import { StateStore } from '../src/main/store';
import { ExecutionEvents } from '../src/main/execution/events';
import { ConnectionStore } from '../src/main/engines/native/connections';
import { NativeStructuredExecutor } from '../src/main/engines/native/structured-executor';
import { createNativeConfig } from '../src/main/engines/native/config';
import { nativeCompactionPreview, unavailableCompactionPreview } from '../src/main/engines/native/compaction-preview';

const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
const protocols = ['openai-responses', 'openai-chat-completions'] as const;
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const unavailable = (reason: Extract<NativeContextCompactionPreview, { status: 'unavailable' }>['reason']) => ({ status: 'unavailable', reason });

function userItems(protocol: ProtocolVersion, input: string, images = 0): JsonValue[] {
  const chat = protocol.id === 'openai-chat-completions';
  return [{ role: 'user', content: images ? [{ type: chat ? 'text' : 'input_text', text: input },
    ...Array.from({ length: images }, (): JsonValue => chat ? { type: 'image_url', image_url: { url: image, detail: 'auto' } }
      : { type: 'input_image', image_url: image, detail: 'auto' })] : input }];
}
function assistantItems(protocol: ProtocolVersion, text: string): JsonValue[] {
  return protocol.id === 'openai-chat-completions' ? [{ role: 'assistant', content: text }]
    : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }];
}
async function addTurn(ledger: NativeRunStore, sessionId: string, protocol: ProtocolVersion, input: string, images = 0, finish = true) {
  const request: BeginRunRequest = {
    identity: { sessionId, conversationId: ledger.conversationId, runId: randomUUID(), requestId: randomUUID(), workerGeneration: 1 },
    input, inputDigest: input, userItems: userItems(protocol, input, images), protocol,
    configuration: {}, policyRevision: 'test-preview',
  };
  await ledger.beginRun(request);
  await ledger.append(request.identity, { type: 'model_response', response: {
    outputItems: assistantItems(protocol, 'Saved historical findings 中文. '.repeat(80)),
    toolCalls: [], finishReason: 'completed', usage: null,
  } });
  if (finish) await ledger.append(request.identity, { type: 'run_finished', result: {
    identity: request.identity, status: 'completed', reason: 'model_completed', modelRequests: 1, toolCalls: 0,
    usage: null, context: ledger.loadContext()!, committed: true,
  } });
}
async function fixture(t: TestContext, protocolId: typeof protocols[number], turns: number[], unfinished = false) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'native-compaction-preview-')));
  const data = path.join(directory, 'data'), project = path.join(directory, 'project');
  await fs.mkdir(project);
  const store = new StateStore(data), connections = new ConnectionStore(data), events = new ExecutionEvents();
  const id = randomUUID(), otherId = randomUUID(), conversationId = randomUUID(), projectId = randomUUID();
  const protocol: ProtocolVersion = { id: protocolId, version: 1 };
  store.change(state => {
    state.projects.push({ id: projectId, path: project, name: 'fixture', createdAt: new Date().toISOString() });
    for (const sessionId of [id, otherId]) state.sessions.push({ id: sessionId, projectId, title: 'preview', kind: 'agent', cwd: project,
      execution: { providerId: 'native', mode: 'structured', conversationId: sessionId === id ? conversationId : randomUUID() },
      engineConfig: createNativeConfig(), started: sessionId === id && turns.length > 0, status: 'idle', archived: false,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  });
  const rootDirectory = path.join(data, 'native', 'conversations');
  const withLedger = async <T>(read: (ledger: NativeRunStore) => T | Promise<T>) => {
    const ledger = await NativeRunStore.open({ rootDirectory, conversationId });
    try { return await read(ledger); } finally { await ledger.close(); }
  };
  await withLedger(async ledger => {
    for (const [index, images] of turns.entries()) await addTurn(ledger, id, protocol,
      index === 0 ? 'Original goal /private/path.txt and https://private.invalid/history' : `Turn ${index}`, images,
      !(unfinished && index === turns.length - 1));
  });
  let credentials = 0, workers = 0;
  connections.resolve = () => { credentials++; throw new Error('Preview fixture has no model credentials.'); };
  let executor = new NativeStructuredExecutor(store, connections, events, { worker: async () => { workers++; throw new Error('Preview must not start a model.'); } });
  t.after(async () => { await executor.shutdown().catch(() => {}); store.flush(); await fs.rm(directory, { recursive: true, force: true }); });
  await executor.initialize(); store.flush();
  return { directory, data, id, otherId, protocol, withLedger, store,
    get executor() { return executor; }, get credentials() { return credentials; }, get workers() { return workers; },
    async restart() {
      await executor.shutdown();
      executor = new NativeStructuredExecutor(store, connections, events, { worker: async () => { workers++; throw new Error('Preview must not start a model.'); } });
      await executor.initialize();
    },
  };
}

async function directoryState(directory: string): Promise<unknown[]> {
  const entries: unknown[] = [];
  for (const name of (await fs.readdir(directory)).sort()) {
    const file = path.join(directory, name), stat = await fs.lstat(file);
    entries.push([name, stat.mode, stat.mtimeMs, stat.size, stat.isDirectory() ? await directoryState(file)
      : createHash('sha256').update(await fs.readFile(file)).digest('hex')]);
  }
  return entries;
}

for (const protocol of protocols) {
  test(`${protocol}: no complete prefix is explained without credentials or a model`, async t => {
    const f = await fixture(t, protocol, []);
    assert.deepEqual(f.executor.snapshot(f.id).nativeContextMaintenance?.preview, unavailable('no_complete_prefix'));
    await f.withLedger(ledger => addTurn(ledger, f.id, f.protocol, 'Only complete turn'));
    await f.executor.hydrate(f.id);
    assert.deepEqual(f.executor.snapshot(f.id).nativeContextMaintenance?.preview, unavailable('no_complete_prefix'));
    assert.equal(f.executor.snapshot(f.id).nativeContextMaintenance?.canCompact, false);
    assert.equal(f.credentials, 0); assert.equal(f.workers, 0);
  });

  test(`${protocol}: saved text range follows the real source and refreshes with the same durable head`, async t => {
    const f = await fixture(t, protocol, [0, 0]);
    const first = f.executor.snapshot(f.id).nativeContextMaintenance!;
    const source = await f.withLedger(ledger => ledger.getCompactionSource());
    assert.equal(first.headHash, source.expectedHash);
    assert.deepEqual(first.preview, { status: 'available', summarizableBytes: bytes(source.context), retainedBytes: bytes(source.retainedContext), retainedImages: 0, retention: 'recent_turns' });
    assert.equal(first.canCompact, true);
    await f.withLedger(ledger => addTurn(ledger, f.id, f.protocol, 'New current turn'));
    const original = NativeRunStore.prototype.getCompactionSource;
    let reads = 0;
    const mock = t.mock.method(NativeRunStore.prototype, 'getCompactionSource', function (this: NativeRunStore, ...args: Parameters<typeof original>) {
      reads++; return original.apply(this, args);
    });
    await f.executor.hydrate(f.id);
    assert.equal(reads, 1, 'Refresh shares one source lookup with canCompact');
    mock.mock.restore();
    const updated = f.executor.snapshot(f.id).nativeContextMaintenance!;
    assert.notEqual(updated.headHash, first.headHash);
    const nextSource = await f.withLedger(ledger => ledger.getCompactionSource());
    assert.equal(updated.headHash, nextSource.expectedHash);
    assert.deepEqual(updated.preview, nativeCompactionPreview(nextSource));
    assert.equal(f.credentials, 0); assert.equal(f.workers, 0);
  });

  test(`${protocol}: image suffix ranges survive compaction and restart without exposing content`, async t => {
    const f = await fixture(t, protocol, [0, 0, 2, 0, 1]);
    const before = f.executor.snapshot(f.id).nativeContextMaintenance!;
    const source = await f.withLedger(ledger => ledger.getCompactionSource());
    assert.deepEqual(before.preview, { status: 'available', summarizableBytes: bytes(source.context), retainedBytes: bytes(source.retainedContext), retainedImages: 3, retention: 'image_suffix' });
    const serialized = JSON.stringify(before.preview);
    assert.doesNotMatch(serialized, /data:image|private|Original goal|Turn|https|input_image|image_url/);
    await f.withLedger(async ledger => { await ledger.commitContextCompaction(ledger.planContextCompaction({ summary: 'Saved earlier findings.' })); });
    await f.executor.hydrate(f.id);
    const after = f.executor.snapshot(f.id).nativeContextMaintenance!;
    assert.equal(after.preview?.status, 'available');
    if (after.preview?.status !== 'available') throw new Error('Expected an available preserved prefix');
    assert.equal(after.preview.retainedImages, 3);
    assert.equal(after.preview.retainedBytes, bytes(source.retainedContext));
    assert.ok(after.preview.summarizableBytes < bytes(source.context));
    await f.restart();
    assert.deepEqual(f.executor.snapshot(f.id).nativeContextMaintenance?.preview, after.preview);
    assert.equal(f.credentials, 0); assert.equal(f.workers, 0);
  });

  test(`${protocol}: a first-turn image reports its protected prefix boundary`, async t => {
    const f = await fixture(t, protocol, [1, 0, 0]);
    assert.deepEqual(f.executor.snapshot(f.id).nativeContextMaintenance?.preview, unavailable('image_prefix_unavailable'));
    assert.equal(f.executor.snapshot(f.id).nativeContextMaintenance?.canCompact, false);
  });

  test(`${protocol}: recovery masks metrics even when its ledger error is conversation_busy`, async t => {
    const f = await fixture(t, protocol, [0, 0], true);
    const view = f.executor.snapshot(f.id);
    assert.ok(view.nativeRecovery);
    assert.deepEqual(view.nativeContextMaintenance?.preview, unavailable('recovery_required'));
    assert.equal(view.nativeContextMaintenance?.canCompact, false);
    assert.equal(f.credentials, 0); assert.equal(f.workers, 0);
  });
}

test('cached snapshots are read-only, independently owned and isolated across sessions', async t => {
  const f = await fixture(t, 'openai-responses', [0, 1]);
  const expected = structuredClone(f.executor.snapshot(f.id).nativeContextMaintenance?.preview);
  const before = await directoryState(f.data);
  t.mock.method(NativeRunStore, 'open', () => { throw new Error('Snapshot must not reopen a ledger'); });
  for (const method of ['reserveAutoCompaction', 'reserveRunCompaction', 'commitContextCompaction'] as const) {
    t.mock.method(NativeRunStore.prototype, method, () => { throw new Error('Snapshot must not reserve or commit'); });
  }
  for (let index = 0; index < 5; index++) {
    const preview = f.executor.snapshot(f.id).nativeContextMaintenance?.preview;
    assert.deepEqual(preview, expected);
    if (preview?.status !== 'available') throw new Error('Expected image range');
    preview.retainedImages = 999; preview.summarizableBytes = -1;
    assert.deepEqual(f.executor.snapshot(f.otherId).nativeContextMaintenance?.preview, unavailable('no_complete_prefix'));
  }
  assert.deepEqual(await directoryState(f.data), before);
  assert.equal(f.credentials, 0); assert.equal(f.workers, 0);
});

test('host activity and maintenance hide cached ranges, and release restores the saved view', async t => {
  const f = await fixture(t, 'openai-responses', [0, 0]);
  const expected = f.executor.snapshot(f.id).nativeContextMaintenance?.preview;
  const pending = f.executor.send(f.id, 'Explicit send with unavailable credentials');
  assert.equal(f.executor.has(f.id), true);
  assert.deepEqual(f.executor.snapshot(f.id).nativeContextMaintenance?.preview, unavailable('busy'));
  const result = await pending;
  assert.equal(result.success, false);
  assert.deepEqual(f.executor.snapshot(f.id).nativeContextMaintenance?.preview, expected);
  assert.equal(f.credentials, 1); assert.equal(f.workers, 0);
  f.executor.setSessionMaintenance([f.id], true);
  assert.deepEqual(f.executor.snapshot(f.id).nativeContextMaintenance?.preview, unavailable('busy'));
  assert.deepEqual(f.executor.snapshot(f.otherId).nativeContextMaintenance?.preview, unavailable('no_complete_prefix'));
  f.executor.setSessionMaintenance([f.id], false);
  assert.deepEqual(f.executor.snapshot(f.id).nativeContextMaintenance?.preview, expected);
  f.executor.setMaintenance(true);
  assert.deepEqual(f.executor.snapshot(f.id).nativeContextMaintenance?.preview, unavailable('busy'));
  f.executor.setMaintenance(false);
  assert.deepEqual(f.executor.snapshot(f.id).nativeContextMaintenance?.preview, expected);
});

test('only recognized store codes become user reasons; error data never enters the preview', () => {
  const pairs = [
    ['nothing_to_compact', 'no_complete_prefix'], ['image_context_compaction_unsupported', 'image_prefix_unavailable'],
    ['conversation_busy', 'busy'], ['recovery_required', 'recovery_required'],
    ['unsupported_protocol', 'unsupported_context'], ['pending_tools', 'unsupported_context'],
    ['store_closed', 'unavailable'], ['__proto__', 'unavailable'],
  ] as const;
  for (const [code, reason] of pairs) assert.deepEqual(unavailableCompactionPreview(new RunStoreError(code, 'secret /private/path https://private.invalid')), unavailable(reason));
  for (const value of [new Error('private'), { code: 'nothing_to_compact', message: 'private' }, null, undefined, 'private']) {
    assert.deepEqual(unavailableCompactionPreview(value), unavailable('unavailable'));
  }
});

test('missing or inconsistent source metadata fails closed', () => {
  const protocol = { id: 'openai-responses', version: 1 }, context: ModelContext = { protocol, items: userItems(protocol, 'text') };
  const valid: ContextCompactionSource = { expectedHash: 'head', sourceSeq: 1, scope: 'prefix', beforeBytes: 999, context, retainedContext: context };
  for (const source of [undefined, null, {}, { ...valid, scope: 'everything' }, { ...valid, context: { ...context, items: [] } },
    { ...valid, retainedContext: { protocol: { id: 'future', version: 1 }, items: [] } },
    { ...valid, context: { protocol, items: userItems(protocol, 'image', 1) } }]) {
    assert.deepEqual(nativeCompactionPreview(source as ContextCompactionSource), unavailable('unavailable'));
  }
});
