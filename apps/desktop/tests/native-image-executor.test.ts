import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { runAgent, contextHasUserImages, DEFAULT_RUN_BUDGET, type UserImage, type ModelContext } from '@cc-desk/agent-core';
import { createNativeModel } from '@cc-desk/agent-node/native-model';
import { NativeRunStore, nativeSubmissionInputDigest } from '@cc-desk/agent-node/run-store';
import { Attachments } from '../src/main/attachments';
import { StateStore } from '../src/main/store';
import { ExecutionEvents } from '../src/main/execution/events';
import { ConnectionStore } from '../src/main/engines/native/connections';
import { NativeStructuredExecutor, type NativeExecutorOptions } from '../src/main/engines/native/structured-executor';
import { createNativeConfig } from '../src/main/engines/native/config';
import { autoCompactBeforeSend } from '../src/main/engines/native/automatic-compaction';
import { parseNativeConfig } from '../src/main/engines/native/config';
import { createInRunCompaction } from '../src/main/engines/native/in-run-compaction';
import { prepareNativeContextSummary } from '../src/main/engines/native/context-summary';
// @ts-expect-error Local protocol fixture has no declarations.
import { startResponsesFixture, assistantMessage, functionCall } from '../../../packages/agent-node/tests/fixtures/responses-server.mjs';
// @ts-expect-error Local protocol fixture has no declarations.
import { startChatCompletionsFixture } from '../../../packages/agent-node/tests/fixtures/chat-completions-server.mjs';

type Worker = NonNullable<NativeExecutorOptions['worker']>;
type Protocol = 'responses' | 'chat-completions';
const secret = 'sk-images-local-fixture';
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
function png(color = 255) {
  const chunk = (type: string, data: Buffer) => {
    const content = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of content) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1; }
    const length = Buffer.alloc(4), checksum = Buffer.alloc(4); length.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, content, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0, color, 0, 0]))), chunk('IEND', Buffer.alloc(0))]);
}
const inline: Worker = options => runAgent({ ...options.request, signal: options.signal }, {
  model: createNativeModel(options.model), tools: options.tools, store: options.store, approvals: options.approvals,
  contextMaintenance: options.contextMaintenance,
  host: { now: Date.now, digest, emit: options.onEvent,
    deadline: (ms, parent) => {
      const controller = new AbortController(), abort = () => controller.abort(), timer = setTimeout(abort, ms);
      parent.addEventListener('abort', abort, { once: true }); if (parent.aborted) abort();
      return { signal: controller.signal, dispose() { clearTimeout(timer); parent.removeEventListener('abort', abort); } };
    },
  },
});
async function fixture(protocol: Protocol, gate?: () => Promise<void>, options: { inTurn?: boolean; invalidSummary?: boolean; cancelSummary?: boolean; firstPadding?: number } = {}) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'native-image-executor-')));
  const project = path.join(directory, 'project'), data = path.join(directory, 'data'); await fs.mkdir(project);
  await fs.writeFile(path.join(project, 'AGENTS.md'), 'Preserve user files.');
  await fs.writeFile(path.join(project, 'fixture.txt'), 'durable image turn tool result');
  let ordinary = 0;
  let summaryEntered!: () => void;
  const summaryStarted = new Promise<void>(resolve => { summaryEntered = resolve; });
  const server = await (protocol === 'responses' ? startResponsesFixture : startChatCompletionsFixture)({ assertReplay: false,
    handler: ({ body }: { body: { tools?: unknown[] } }) => {
      const isSummary = !body.tools?.length;
      if (isSummary) { summaryEntered(); if (options.cancelSummary) return { hang: true }; }
      if (isSummary && options.invalidSummary) return protocol === 'responses'
        ? { output: [functionCall('forbidden-summary-read', 'read_file', { path: 'fixture.txt' })] }
        : { message: { role: 'assistant', content: null, tool_calls: [{ id: 'forbidden-summary-read', type: 'function', function: { name: 'read_file', arguments: '{"path":"fixture.txt"}' } }] } };
      if (!isSummary && ordinary++ === 1 && options.inTurn) {
        const text = 'image turn observations '.repeat(400);
        return protocol === 'responses' ? { output: [assistantMessage('image-notes', text), functionCall('image-read', 'read_file', { path: 'fixture.txt' })] }
          : { message: { role: 'assistant', content: text, tool_calls: [{ id: 'image-read', type: 'function', function: { name: 'read_file', arguments: '{"path":"fixture.txt"}' } }] } };
      }
      const text = isSummary ? 'Earlier text-only history has been summarized. Preserve all image turns and user files.'
        : 'Image received. ' + 'historical details '.repeat(ordinary === 1 ? options.firstPadding ?? 400 : options.inTurn ? 1 : 400);
      return protocol === 'responses' ? { output: [assistantMessage('answer', text)] } : { message: { role: 'assistant', content: text } };
    },
  });
  const store = new StateStore(data), connections = new ConnectionStore(data), events = new ExecutionEvents();
  const connection = connections.upsert({ name: 'image fixture', protocol, baseURL: server.baseURL, model: 'fixture-model', enabled: true, allowLoopbackHttp: true, auth: { mode: 'memory' } });
  connections.setCredential({ id: connection.id, revision: connection.revision, mode: 'memory', secret });
  const id = randomUUID(), conversationId = randomUUID(), projectId = randomUUID();
  store.change(state => {
    state.projects.push({ id: projectId, path: project, name: 'project', createdAt: new Date().toISOString() });
    state.sessions.push({ id, projectId, title: 'images', kind: 'agent', cwd: project, execution: { providerId: 'native', mode: 'structured', conversationId },
      engineConfig: createNativeConfig({ schemaVersion: 1, options: { connectionId: connection.id } }), started: false, status: 'idle', archived: false,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  });
  const requests: Parameters<Worker>[0][] = [];
  const worker: Worker = async options => { requests.push(options); await gate?.(); return inline(options); };
  let executor = new NativeStructuredExecutor(store, connections, events, { worker }); await executor.initialize();
  const attachments = new Attachments(data);
  const add = async (name: string, color = 255) => {
    const source = path.join(directory, name); await fs.writeFile(source, png(color));
    return (await attachments.add(id, [source]))[0].path;
  };
  const imagePath = await add('picture.png'); await attachments.retain(id, [imagePath]);
  return { data, id, conversationId, server, store, requests, imagePath, add, summaryStarted,
    get executor() { return executor; },
    async ledger() {
      const ledger = await NativeRunStore.open({ rootDirectory: path.join(data, 'native', 'conversations'), conversationId });
      try { return { records: ledger.replay(), runs: ledger.listRuns(), context: ledger.loadContext() }; } finally { await ledger.close(); }
    },
    async configure(options: Record<string, unknown>) {
      const configuration = structuredClone(store.state.sessions.find(item => item.id === id)!.engineConfig); Object.assign(configuration.options, options);
      await executor.updateConfig(id, configuration);
    },
    async restart(noCredential = false) { await executor.shutdown(); executor = new NativeStructuredExecutor(store, noCredential ? new ConnectionStore(data) : connections, events, { worker }); await executor.initialize(); },
    async dispose() { await executor.shutdown().catch(() => {}); await server.close(); store.flush(); await fs.rm(directory, { recursive: true, force: true }); },
  };
}

for (const protocol of ['responses', 'chat-completions'] as const) {
  test(`${protocol}: selected image-only input reaches provider, persists exact context and returns same receipt after restart`, async () => {
    const f = await fixture(protocol);
    try {
      const result = await f.executor.send(f.id, '', [f.imagePath], undefined, { requestId: 'picture-request' });
      assert.equal(result.success, true, JSON.stringify(result));
      const first = await f.ledger(), metadata = first.runs[0].configuration.imageAttachments as any[];
      assert.equal(metadata.length, 1); assert.equal(metadata[0].name, 'picture.png'); assert.equal(metadata[0].sha256, createHash('sha256').update(png()).digest('hex'));
      const source = f.requests[0].request.images![0].dataUrl;
      assert.equal(JSON.stringify(first.context).includes(source), true);
      assert.equal(JSON.stringify(f.server.requests[0]).includes(source), true);
      assert.equal(JSON.stringify(f.executor.snapshot(f.id)).includes(source), false);
      assert.equal(JSON.stringify(f.executor.snapshot(f.id)).includes(secret), false);
      assert.equal(f.executor.snapshot(f.id).messages.find(message => message.role === 'user')?.nativeImageAttachments?.[0].sha256, metadata[0].sha256);
      await f.restart();
      assert.equal((await f.executor.send(f.id, 'continue')).success, true);
      assert.equal(JSON.stringify(f.server.requests[1]).includes(source), true, 'continuation replays original image bytes');
      await f.restart(true);
      assert.equal((await f.executor.send(f.id, '', [f.imagePath], undefined, { requestId: 'picture-request' })).success, true);
      assert.equal(f.server.requests.length, 2, 'terminal receipt needs no credential or new model request');
      const different = await f.add('different.png', 1);
      const rejected = await f.executor.send(f.id, '', [different], undefined, { requestId: 'picture-request' });
      assert.equal(rejected.success, false); assert.match(rejected.error!, /不同/); assert.equal(f.server.requests.length, 2);
      assert.deepEqual((await f.ledger()).records.slice(0, first.records.length), first.records);
    } finally { await f.dispose(); }
  });

  test(`${protocol}: back-to-back active duplicate shares exact snapshot, different image cannot reuse request id`, async () => {
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    const f = await fixture(protocol, async () => { entered(); await gate; });
    try {
      const original = f.executor.send(f.id, 'inspect', [f.imagePath], undefined, { requestId: 'active-picture' });
      const duplicate = f.executor.send(f.id, 'inspect', [f.imagePath], undefined, { requestId: 'active-picture' });
      await started;
      const changed = await f.add('changed.png', 1);
      await assert.rejects(f.executor.send(f.id, 'inspect', [changed], undefined, { requestId: 'active-picture' }), /不同/);
      // Alter the original staged file after capture; the active request retains
      // its bytes, but a duplicate attempting to reuse new bytes is refused.
      await fs.writeFile(f.imagePath, png(1));
      await assert.rejects(f.executor.send(f.id, 'inspect', [f.imagePath], undefined, { requestId: 'active-picture' }), /不同|变更|无效/);
      release(); assert.equal((await original).success, true); assert.deepEqual(await duplicate, await original);
      assert.equal(f.server.requests.length, 1); assert.equal(JSON.stringify(f.server.requests[0]).includes(png().toString('base64')), true);
    } finally { release(); await f.dispose(); }
  });

  test(`${protocol}: manual and automatic image compaction preserve journals without any summary attempt`, async () => {
    const f = await fixture(protocol);
    try {
      assert.equal((await f.executor.send(f.id, 'inspect', [f.imagePath])).success, true);
      assert.equal((await f.executor.send(f.id, 'another turn')).success, true);
      const before = await f.ledger();
      assert.equal(f.executor.snapshot(f.id).nativeContextMaintenance?.canCompact, false);
      await assert.rejects(f.executor.compactContext(f.id, before.records.at(-1)!.hash), /图片/);
      const previous = f.requests.at(-1)!, model = createNativeModel(previous.model);
      const pending = { ...before.context!, items: [...before.context!.items, ...model.userItems('next')] };
      await f.configure({ autoCompact: 'before_send', maxInputTokens: Math.floor(model.estimateInputTokens(pending) / 0.95) });
      const result = await f.executor.send(f.id, 'next');
      assert.equal(result.success, false); assert.match(result.error!, /图片.*未调用摘要/);
      assert.equal(f.requests.length, 2); assert.deepEqual((await f.ledger()).records, before.records);
    } finally { await f.dispose(); }
  });
}

test('legacy image-free startup identity and summary preflight remain distinct from image inputs', () => {
  assert.equal(nativeSubmissionInputDigest('hello'), digest('hello'));
  assert.equal(nativeSubmissionInputDigest('hello', []), digest('hello'));
  assert.notEqual(nativeSubmissionInputDigest('hello', [{ sha256: 'a'.repeat(64) }]), digest('hello'));
});

for (const protocol of ['responses', 'chat-completions'] as const) test(`${protocol}: in-turn and isolated text-summary guards reject images before reserving a billed attempt`, async () => {
  const model = { protocol, baseURL: 'http://127.0.0.1:1/v1', allowLoopbackHttp: true, model: 'fixture-model', apiKey: secret };
  const image: UserImage = { mimeType: 'image/png', dataUrl: `data:image/png;base64,${png().toString('base64')}` };
  const adapter = createNativeModel(model), context: ModelContext = { protocol: adapter.protocol, items: adapter.userItems('input', [image]) };
  const identity = { sessionId: randomUUID(), conversationId: randomUUID(), runId: randomUUID(), requestId: 'image-run', workerGeneration: 1 };
  let reserved = false;
  const maintenance = createInRunCompaction({ ledger: { lookupRunCompaction: () => undefined,
    getRunCompactionSource: () => { throw Object.assign(new Error('first image turn has no text prefix'), { code: 'image_context_compaction_unsupported' }); },
    reserveRunCompaction: () => { reserved = true; throw new Error('must not reserve'); } } as unknown as NativeRunStore,
    identity, model, signal: new AbortController().signal, forbiddenValues: [secret], remainingMs: () => 10000,
    assertOwnership: async () => {}, assertInstructions: async () => {}, continuity: async () => '', onCompacting() { reserved = true; }, onSettled: async () => {},
  });
  const result = await maintenance.maintain({ identity, context, budget: { ...DEFAULT_RUN_BUDGET, maxInputTokens: 1 }, modelRequests: 1, toolCalls: 1, remainingActiveMs: 10000, signal: new AbortController().signal });
  assert.deepEqual(result, { kind: 'failed', reason: 'context_maintenance_images_unsupported', modelRequests: 0, usage: null }); assert.equal(reserved, false);
  assert.throws(() => prepareNativeContextSummary({ context, model, maxInputTokens: 100000 }), /图片.*未调用摘要/);
});

for (const protocol of ['responses', 'chat-completions'] as const) test(`${protocol}: invalid historical image retry cannot overwrite a newer failed run`, async () => {
  const f = await fixture(protocol);
  try {
    assert.equal((await f.executor.send(f.id, 'inspect', [f.imagePath], undefined, { requestId: 'historic-image' })).success, true);
    const latest = await f.executor.send(f.id, 'x'.repeat(70_000), [], undefined, { requestId: 'newer-budget-failure' });
    assert.equal(latest.success, false);
    const before = structuredClone(f.store.state.sessions.find(item => item.id === f.id)!);
    assert.equal(before.taskState, 'error');
    const journal = (await f.ledger()).records;
    for (const mutation of ['invalid', 'missing']) {
      if (mutation === 'invalid') await fs.writeFile(f.imagePath, Buffer.alloc(png().length, 0));
      else await fs.rm(f.imagePath);
      const retried = await f.executor.send(f.id, 'inspect', [f.imagePath], undefined, { requestId: 'historic-image' });
      assert.equal(retried.success, false);
      assert.deepEqual(f.store.state.sessions.find(item => item.id === f.id), before);
      assert.deepEqual((await f.ledger()).records, journal);
      assert.equal(f.server.requests.length, 1);
    }
    await f.restart(); assert.equal(f.executor.snapshot(f.id).taskState, 'error');
  } finally { await f.dispose(); }
});

for (const protocol of ['responses', 'chat-completions'] as const) test(`${protocol}: queue-bound image digest is checked before worker or model startup`, async () => {
  const f = await fixture(protocol);
  try {
    await assert.rejects(f.executor.send(f.id, 'inspect', [f.imagePath], undefined, { requestId: 'queue-image', source: 'queue' }), /队列/);
    const metadata = [{ name: 'picture.png', mimeType: 'image/png' as const, bytes: png().length, sha256: createHash('sha256').update(png()).digest('hex') }];
    await fs.writeFile(f.imagePath, png(1));
    const result = await f.executor.send(f.id, 'inspect', [f.imagePath], undefined, { requestId: 'queue-image', source: 'queue', imageAttachments: metadata });
    assert.equal(result.success, false); assert.match(result.error!, /图片附件内容.*队列/);
    assert.equal(f.requests.length, 0); assert.equal(f.server.requests.length, 0); assert.equal((await f.ledger()).runs.length, 0);
  } finally { await f.dispose(); }
});


test('automatic attempt identity cannot reuse an earlier text submission after adding images', async () => {
  const identity = { sessionId: randomUUID(), conversationId: randomUUID(), runId: randomUUID(), requestId: 'previous-text', workerGeneration: 1 };
  const metadata = [{ name: 'picture.png', mimeType: 'image/png' as const, bytes: png().length, sha256: createHash('sha256').update(png()).digest('hex') }];
  let reached = false;
  await assert.rejects(autoCompactBeforeSend({
    ledger: { lookupAutoCompaction: () => ({ inputDigest: digest('input') }) } as unknown as NativeRunStore,
    identity, input: 'input', images: [{ mimeType: 'image/png', dataUrl: `data:image/png;base64,${png().toString('base64')}` }], imageAttachments: metadata,
    config: parseNativeConfig(createNativeConfig()), model: { baseURL: 'http://127.0.0.1:1/v1', model: 'fixture', apiKey: secret, allowLoopbackHttp: true },
    instructions: '', signal: new AbortController().signal, startedAt: performance.now(), assertOwnership: async () => { reached = true; }, onCompacting() { reached = true; }, onCommitted: async () => { reached = true; },
  }), /不同的输入/);
  assert.equal(reached, false);
});

function imageSuffix(context: ModelContext) {
  const first = context.items.findIndex(item => contextHasUserImages({ protocol: context.protocol, items: [item] }));
  assert.ok(first >= 0); return context.items.slice(first);
}
const summaryRequests = (requests: Parameters<Worker>[0][]) => requests.filter(request => request.request.configuration.purpose === 'context_summary');

for (const protocol of ['responses', 'chat-completions'] as const) {
  for (const mode of ['manual', 'automatic'] as const) test(`${protocol}: ${mode} compacts only text before the first image turn and preserves the entire suffix after restart`, async () => {
    const f = await fixture(protocol);
    try {
      assert.equal((await f.executor.send(f.id, 'Original text-only engineering goal')).success, true);
      assert.equal((await f.executor.send(f.id, 'inspect the image', [f.imagePath])).success, true);
      assert.equal((await f.executor.send(f.id, 'later text must also remain exact')).success, true);
      const before = await f.ledger(), suffix = imageSuffix(before.context!);
      assert.equal(f.executor.snapshot(f.id).nativeContextMaintenance?.canCompact, true);
      if (mode === 'manual') await f.executor.compactContext(f.id, before.records.at(-1)!.hash);
      else {
        const model = createNativeModel(f.requests.at(-1)!.model);
        const pending = { ...before.context!, items: [...before.context!.items, ...model.userItems('next')] };
        await f.configure({ autoCompact: 'before_send', maxInputTokens: Math.floor(model.estimateInputTokens(pending) / 0.95) });
        const result = await f.executor.send(f.id, 'next'); assert.equal(result.success, true, JSON.stringify(result));
      }
      const summaries = summaryRequests(f.requests); assert.equal(summaries.length, 1);
      const source = JSON.parse(summaries[0].request.input).history;
      assert.equal(contextHasUserImages(source), false); assert.doesNotMatch(summaries[0].request.input, /data:image/);
      assert.match(summaries[0].request.input, /Original text-only engineering goal/);
      assert.doesNotMatch(summaries[0].request.input, /later text must also remain exact|inspect the image/);
      const after = await f.ledger(); assert.deepEqual(imageSuffix(after.context!).slice(0, suffix.length), suffix);
      assert.deepEqual(after.records.slice(0, before.records.length), before.records);
      assert.equal(after.records.filter(record => record.event.type === 'context_compacted').length, 1);
      await f.restart(); assert.deepEqual((await f.ledger()).context, after.context);
      if (mode === 'manual') await f.executor.compactContext(f.id, before.records.at(-1)!.hash);
      assert.equal(summaryRequests(f.requests).length, 1); assert.deepEqual(f.server.errors, []);
    } finally { await f.dispose(); }
  });

  test(`${protocol}: a newly attached image does not prevent automatic text-prefix compaction`, async () => {
    const f = await fixture(protocol);
    try {
      for (const input of ['original text goal', 'recent complete text turn']) assert.equal((await f.executor.send(f.id, input)).success, true);
      const before = await f.ledger(), model = createNativeModel(f.requests.at(-1)!.model);
      const image: UserImage = { mimeType: 'image/png', dataUrl: `data:image/png;base64,${png().toString('base64')}` };
      const pending = { ...before.context!, items: [...before.context!.items, ...model.userItems('new image', [image])] };
      await f.configure({ autoCompact: 'before_send', maxInputTokens: Math.floor(model.estimateInputTokens(pending) / 0.95) });
      const result = await f.executor.send(f.id, 'new image', [f.imagePath]); assert.equal(result.success, true, JSON.stringify(result));
      assert.equal(summaryRequests(f.requests).length, 1); assert.doesNotMatch(summaryRequests(f.requests)[0].request.input, /data:image/);
      assert.equal(JSON.stringify(f.server.requests.at(-1)).includes(image.dataUrl), true);
      assert.equal(contextHasUserImages((await f.ledger()).context!), true);
    } finally { await f.dispose(); }
  });

  for (const mode of ['manual-retained', 'automatic-retained', 'automatic-source'] as const) test(`${protocol}: ${mode} budget rejection creates no summary call or reservation`, async () => {
    const f = await fixture(protocol, undefined, { firstPadding: mode === 'automatic-source' ? 2000 : 400 });
    try {
      assert.equal((await f.executor.send(f.id, 'original text goal')).success, true);
      assert.equal((await f.executor.send(f.id, 'image retained', [f.imagePath])).success, true);
      const before = await f.ledger(), model = createNativeModel(f.requests.at(-1)!.model);
      const minimum = { protocol: before.context!.protocol, items: [...model.userItems('original text goal'), ...imageSuffix(before.context!), ...model.userItems('next')] };
      const maxInputTokens = mode === 'manual-retained' ? 1024
        : model.estimateInputTokens(minimum) + (mode === 'automatic-source' ? 2000 : -1000);
      await f.configure({ autoCompact: 'before_send', maxInputTokens });
      if (mode === 'manual-retained') await assert.rejects(f.executor.compactContext(f.id, before.records.at(-1)!.hash), /必须保留.*预算/);
      else {
        const result = await f.executor.send(f.id, 'next'); assert.equal(result.success, false);
        assert.match(result.error!, mode === 'automatic-source' ? /待压缩历史超过摘要请求输入预算/ : /必须保留.*预算/);
      }
      assert.equal(summaryRequests(f.requests).length, 0); assert.equal(f.server.requests.length, 2);
      assert.deepEqual((await f.ledger()).records, before.records);
      await f.restart(); assert.deepEqual((await f.ledger()).context, before.context);
    } finally { await f.dispose(); }
  });

  test(`${protocol}: in-turn image maintenance preserves its current request and complete tool batch without sending images to the summary`, async () => {
    const f = await fixture(protocol, undefined, { inTurn: true, firstPadding: 800 });
    try {
      assert.equal((await f.executor.send(f.id, 'original text goal')).success, true);
      const before = await f.ledger(), model = createNativeModel(f.requests.at(-1)!.model);
      const image: UserImage = { mimeType: 'image/png', dataUrl: `data:image/png;base64,${png().toString('base64')}` };
      const pending = { ...before.context!, items: [...before.context!.items, ...model.userItems('inspect image and retain the result', [image])] };
      await f.configure({ autoCompact: 'before_send_and_during_run', maxInputTokens: model.estimateInputTokens(pending) + 6000 });
      const result = await f.executor.send(f.id, 'inspect image and retain the result', [f.imagePath], undefined, { requestId: 'image-in-turn' });
      assert.equal(result.success, true, JSON.stringify(result));
      const summaries = summaryRequests(f.requests); assert.equal(summaries.length, 1); assert.doesNotMatch(summaries[0].request.input, /data:image|image turn observations/);
      const after = await f.ledger();
      assert.equal(after.records.filter(record => record.event.type === 'run_context_compacted').length, 1);
      assert.equal(after.records.filter(record => record.event.type === 'context_compacted').length, 0, 'the send preflight did not summarize');
      const resumed = f.server.requests.at(-1);
      assert.equal(JSON.stringify(resumed).includes(image.dataUrl), true); assert.match(JSON.stringify(resumed), /image-read|durable image turn tool result/);
      const sourceRequest = f.server.requests.filter((request: { tools?: unknown[] }) => request.tools?.length).at(-2);
      const original = (sourceRequest.input ?? sourceRequest.messages.filter((item: { role: string }) => item.role !== 'system')) as ModelContext['items'];
      const imageInput = original.find(item => contextHasUserImages({ protocol: before.context!.protocol, items: [item] }));
      assert.deepEqual(imageSuffix(after.context!)[0], imageInput);
      assert.equal(imageSuffix(after.context!).filter(item => contextHasUserImages({ protocol: before.context!.protocol, items: [item] })).length, 1);
      assert.equal(after.runs.at(-1)!.result!.modelRequests, 3, 'one image request, one summary and one resumed model request');
      const count = f.server.requests.length;
      await f.restart(); assert.deepEqual((await f.ledger()).context, after.context);
      assert.equal((await f.executor.send(f.id, 'inspect image and retain the result', [f.imagePath], undefined, { requestId: 'image-in-turn' })).success, true);
      assert.equal(f.server.requests.length, count); assert.deepEqual(f.server.errors, []);
    } finally { await f.dispose(); }
  });

  test(`${protocol}: failed automatic image-prefix summary is charged once and never repeated after restart`, async () => {
    const f = await fixture(protocol, undefined, { invalidSummary: true });
    try {
      assert.equal((await f.executor.send(f.id, 'original text goal')).success, true);
      assert.equal((await f.executor.send(f.id, 'image retained', [f.imagePath])).success, true);
      const before = await f.ledger(), model = createNativeModel(f.requests.at(-1)!.model);
      const pending = { ...before.context!, items: [...before.context!.items, ...model.userItems('next')] };
      await f.configure({ autoCompact: 'before_send', maxInputTokens: Math.floor(model.estimateInputTokens(pending) / 0.95) });
      assert.equal((await f.executor.send(f.id, 'next', [], undefined, { requestId: 'image-summary-failure' })).success, false);
      assert.equal(summaryRequests(f.requests).length, 1); assert.deepEqual((await f.ledger()).context, before.context);
      await f.restart();
      assert.equal((await f.executor.send(f.id, 'next', [], undefined, { requestId: 'image-summary-failure' })).success, false);
      assert.equal(summaryRequests(f.requests).length, 1);
      assert.equal((await f.ledger()).records.filter(record => record.event.type === 'context_compaction_attempted').length, 1);
      assert.deepEqual((await f.ledger()).context, before.context);
    } finally { await f.dispose(); }
  });
}

for (const protocol of ['responses', 'chat-completions'] as const) {
  test(`${protocol}: an oversized retained image turn stops in-turn maintenance before summary or reservation`, async () => {
    const f = await fixture(protocol, undefined, { inTurn: true, firstPadding: 20 });
    try {
      assert.equal((await f.executor.send(f.id, 'original text goal')).success, true);
      const before = await f.ledger(), model = createNativeModel(f.requests.at(-1)!.model);
      const image: UserImage = { mimeType: 'image/png', dataUrl: `data:image/png;base64,${png().toString('base64')}` };
      const pending = { ...before.context!, items: [...before.context!.items, ...model.userItems('inspect image', [image])] };
      await f.configure({ autoCompact: 'before_send_and_during_run', maxInputTokens: model.estimateInputTokens(pending) + 2000 });
      const result = await f.executor.send(f.id, 'inspect image', [f.imagePath], undefined, { requestId: 'unhelpful-image-summary' });
      assert.equal(result.success, false); assert.equal(summaryRequests(f.requests).length, 0); assert.equal(f.server.requests.length, 2);
      const after = await f.ledger();
      assert.equal(after.runs.at(-1)!.result!.reason, 'context_maintenance_unhelpful');
      assert.equal(after.records.some(record => record.event.type === 'run_context_compaction_attempted'), false);
      assert.equal(JSON.stringify(after.context).includes(image.dataUrl), true); assert.match(JSON.stringify(after.context), /durable image turn tool result/);
      assert.deepEqual(after.records.slice(0, before.records.length), before.records);
      await f.restart(); assert.deepEqual((await f.ledger()).context, after.context);
      assert.equal((await f.executor.send(f.id, 'inspect image', [f.imagePath], undefined, { requestId: 'unhelpful-image-summary' })).success, false);
      assert.equal(f.server.requests.length, 2);
    } finally { await f.dispose(); }
  });

  test(`${protocol}: cancelling automatic image-prefix summary preserves images and cannot repeat its reserved request`, { timeout: 10000 }, async () => {
    const f = await fixture(protocol, undefined, { cancelSummary: true });
    try {
      assert.equal((await f.executor.send(f.id, 'original text goal')).success, true);
      assert.equal((await f.executor.send(f.id, 'image retained', [f.imagePath])).success, true);
      const before = await f.ledger(), model = createNativeModel(f.requests.at(-1)!.model);
      const pending = { ...before.context!, items: [...before.context!.items, ...model.userItems('next')] };
      await f.configure({ autoCompact: 'before_send', maxInputTokens: Math.floor(model.estimateInputTokens(pending) / 0.95) });
      const sending = f.executor.send(f.id, 'next', [], undefined, { requestId: 'cancel-image-summary' });
      await f.summaryStarted; await f.executor.stop(f.id); assert.equal((await sending).success, false);
      const after = await f.ledger(); assert.deepEqual(after.context, before.context);
      assert.equal(after.records.filter(record => record.event.type === 'context_compaction_attempted').length, 1);
      assert.equal(after.records.some(record => record.event.type === 'context_compacted'), false);
      await f.restart();
      assert.equal((await f.executor.send(f.id, 'next', [], undefined, { requestId: 'cancel-image-summary' })).success, false);
      assert.equal(summaryRequests(f.requests).length, 1); assert.equal(f.server.requests.length, 3);
      assert.deepEqual((await f.ledger()).context, before.context);
    } finally { await f.dispose(); }
  });
}
