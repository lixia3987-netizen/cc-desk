import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { BeginRunRequest } from '@cc-desk/agent-core';
import { NativeRunStore } from '@cc-desk/agent-node/run-store';
import { NativeImagePreviewHost, NATIVE_IMAGE_PREVIEW_BUSY, NATIVE_IMAGE_PREVIEW_INVALID, NATIVE_IMAGE_PREVIEW_UNAVAILABLE } from '../src/main/native-image-preview';
import { registerNativeImageHandlers } from '../src/main/ipc/native-image-handlers';
import { Attachments } from '../src/main/attachments';
import { StateStore } from '../src/main/store';
import { SessionService } from '../src/main/session-service';
import { ExecutionRegistry } from '../src/main/execution/registry';
import type { NativeImagePreviewRequest } from '../src/shared/native-images';

const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');
const dataUrl = `data:image/png;base64,${bytes.toString('base64')}`;
const image = { name: 'recorded.png', mimeType: 'image/png' as const, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
const clone = <T>(value: T): T => structuredClone(value);
function fixtureRequest(protocol = 'openai-responses'): BeginRunRequest {
  const input = 'inspect the explicitly selected picture';
  return { identity: { sessionId: randomUUID(), conversationId: randomUUID(), runId: randomUUID(), requestId: randomUUID(), workerGeneration: 1 }, input,
    inputDigest: createHash('sha256').update(input).digest('hex'), protocol: { id: protocol, version: 1 }, configuration: { imageAttachments: [image] }, policyRevision: 'fixture',
    userItems: [{ role: 'user', content: protocol === 'openai-responses'
      ? [{ type: 'input_text', text: input }, { type: 'input_image', image_url: dataUrl, detail: 'auto' }]
      : [{ type: 'text', text: input }, { type: 'image_url', image_url: { url: dataUrl, detail: 'auto' } }] }],
  };
}
const previewRequest = (request: BeginRunRequest): NativeImagePreviewRequest => ({ sessionId: request.identity.sessionId, conversationId: request.identity.conversationId,
  source: { kind: 'history', runId: request.identity.runId, index: 0, sha256: image.sha256 } });
const session = (request: BeginRunRequest) => ({ id: request.identity.sessionId, kind: 'agent' as const, execution: { providerId: 'native', mode: 'structured' as const, conversationId: request.identity.conversationId } });
function previewHost(request: BeginRunRequest, extra: Partial<ConstructorParameters<typeof NativeImagePreviewHost>[0]> = {}) {
  return new NativeImagePreviewHost({ directory: '/unused', session: () => session(request), captureAdmission: () => () => {}, queueReferences: () => false,
    readSubmission: async () => clone(request), ...extra });
}
const deferred = () => { let resolve!: () => void; return { promise: new Promise<void>(done => { resolve = done; }), resolve: () => resolve() }; };
async function files(directory: string, prefix = ''): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name), absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(result, await files(absolute, relative));
    else if (entry.isFile()) result[relative] = (await fs.readFile(absolute)).toString('base64');
  }
  return result;
}

for (const protocol of ['openai-responses', 'openai-chat-completions']) test(`${protocol}: history preview reads original user bytes without a writer, model or staged file`, async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'native-preview-history-'))); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const request = fixtureRequest(protocol), rootDirectory = path.join(directory, 'native', 'conversations');
  const ledger = await NativeRunStore.open({ rootDirectory, conversationId: request.identity.conversationId });
  await ledger.beginRun(request);
  // Keep the writer active: preview may inspect a fully committed submission,
  // but cannot append an interruption/recovery event or acquire the writer.
  const before = await files(directory);
  const host = previewHost(request, { directory, readSubmission: NativeRunStore.readSubmission });
  assert.deepEqual(await host.preview(previewRequest(request)), { image, dataUrl });
  assert.deepEqual(await files(directory), before);
  await ledger.close();
  const closed = await files(directory);
  assert.deepEqual(await host.preview(previewRequest(request)), { image, dataUrl });
  assert.deepEqual(await files(directory), closed, 'preview must not recover the now-unowned active run');
});

test('history selection validates all bytes and metadata and never falls back to staging', async () => {
  const original = fixtureRequest();
  for (const mutate of [
    (value: BeginRunRequest) => { value.identity.sessionId = randomUUID(); },
    (value: BeginRunRequest) => { value.identity.conversationId = randomUUID(); },
    (value: BeginRunRequest) => { value.identity.runId = randomUUID(); },
    (value: BeginRunRequest) => { value.protocol.id = 'unknown'; },
    (value: BeginRunRequest) => { value.configuration.imageAttachments = [{ ...image, sha256: 'a'.repeat(64) }]; },
    (value: BeginRunRequest) => { value.configuration.imageAttachments = [{ ...image, bytes: image.bytes + 1 }]; },
    (value: BeginRunRequest) => { value.userItems = [{ role: 'assistant', content: [{ type: 'output_text', text: 'not an input' }] }]; },
    (value: BeginRunRequest) => { value.userItems = [{ role: 'user', content: [{ type: 'input_image', image_url: 'https://secret.invalid/image.png', detail: 'auto' }] }]; },
    (value: BeginRunRequest) => { value.configuration.imageAttachments = [image, { ...image, sha256: 'a'.repeat(64) }]; value.userItems.push(clone(value.userItems[0])); },
  ]) {
    const altered = clone(original); mutate(altered);
    const host = previewHost(original, { readSubmission: async () => altered, readDraft: async () => assert.fail('no staged fallback') });
    await assert.rejects(host.preview(previewRequest(original)), { message: NATIVE_IMAGE_PREVIEW_UNAVAILABLE });
  }
  const host = previewHost(original);
  for (const source of [{ kind: 'history' as const, runId: original.identity.runId, index: 1, sha256: image.sha256 }, { kind: 'history' as const, runId: original.identity.runId, index: 0, sha256: 'a'.repeat(64) }]) {
    await assert.rejects(host.preview({ ...previewRequest(original), source }), { message: NATIVE_IMAGE_PREVIEW_UNAVAILABLE });
  }
});

test('IPC rejects unknown fields, malformed identities and arbitrary paths with one fixed error', async () => {
  const request = fixtureRequest(); let reads = 0, call!: (value: unknown) => unknown;
  const host = previewHost(request, { readSubmission: async () => { reads++; return request; }, readDraft: async () => { reads++; return { image, dataUrl }; } });
  registerNativeImageHandlers((name, schema, action) => { assert.equal(name, 'native:image-preview'); call = value => action(schema.parse(value)); }, host);
  const valid = previewRequest(request);
  for (const value of [null, {}, { ...valid, secret: dataUrl }, { ...valid, sessionId: '../private' }, { ...valid, conversationId: 'missing' },
    { ...valid, source: { ...valid.source, index: -1 } }, { ...valid, source: { ...valid.source, index: 4 } }, { ...valid, source: { ...valid.source, index: 0.5 } },
    { ...valid, source: { ...valid.source, sha256: image.sha256.toUpperCase() } }, { ...valid, source: { ...valid.source, runId: 'file://secret' } },
    { ...valid, source: { kind: 'draft', path: '../private' } }, { ...valid, source: { kind: 'draft', path: '/private\0secret' } },
    { ...valid, source: { kind: 'draft', path: '/private', extra: true } },
  ]) await assert.rejects(Promise.resolve().then(() => call(value)), { message: NATIVE_IMAGE_PREVIEW_INVALID });
  assert.equal(reads, 0);
});

test('preview requires exact current Native structured session without consulting model configuration', async () => {
  const request = fixtureRequest(); let reads = 0;
  for (const selected of [undefined, { ...session(request), kind: 'shell' }, { ...session(request), execution: { providerId: 'claude', mode: 'structured' } },
    { ...session(request), execution: { providerId: 'native', mode: 'terminal' } }, { ...session(request), execution: { ...session(request).execution, conversationId: randomUUID() } }]) {
    const host = previewHost(request, { session: () => selected as ReturnType<typeof session>, readSubmission: async () => { reads++; return request; } });
    await assert.rejects(host.preview(previewRequest(request)), { message: NATIVE_IMAGE_PREVIEW_UNAVAILABLE });
  }
  assert.equal(reads, 0);
});

test('draft preview verifies current selected manifest and rejects queued or consumed drafts', async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'native-preview-draft-'))); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const request = fixtureRequest(), source = path.join(directory, 'recorded.png'); await fs.writeFile(source, bytes);
  const manager = new Attachments(directory), selected = (await manager.add(request.identity.sessionId, [source]))[0];
  let queued = false;
  const host = previewHost(request, { directory, queueReferences: () => queued });
  const input = { sessionId: request.identity.sessionId, conversationId: request.identity.conversationId, source: { kind: 'draft', path: selected.path } };
  const before = await files(directory); assert.deepEqual(await host.preview(input), { image, dataUrl }); assert.deepEqual(await files(directory), before);
  queued = true; await assert.rejects(host.preview(input), { message: NATIVE_IMAGE_PREVIEW_UNAVAILABLE }); assert.deepEqual(await files(directory), before);
  queued = false; await manager.markSent(request.identity.sessionId, [selected.path]);
  const consumed = await files(directory); await assert.rejects(host.preview(input), { message: NATIVE_IMAGE_PREVIEW_UNAVAILABLE }); assert.deepEqual(await files(directory), consumed);
});

for (const mutation of ['session', 'conversation', 'admission', 'queued']) test(`late preview is discarded after ${mutation} changes`, async () => {
  const request = fixtureRequest(), entered = deferred(), pending = deferred();
  let present = true, conversation = request.identity.conversationId, generation = 0, queued = false;
  const host = previewHost(request, {
    session: () => { if (!present) throw new Error('private session data'); return { ...session(request), execution: { ...session(request).execution, conversationId: conversation } }; },
    captureAdmission: () => { const initial = generation; return () => { if (initial !== generation) throw new Error('private lifecycle details'); }; },
    queueReferences: () => queued,
    readDraft: async () => { entered.resolve(); await pending.promise; return { image, dataUrl }; },
  });
  const read = host.preview({ sessionId: request.identity.sessionId, conversationId: request.identity.conversationId, source: { kind: 'draft', path: '/selected/picture.png' } });
  const rejected = assert.rejects(read, { message: NATIVE_IMAGE_PREVIEW_UNAVAILABLE }); await entered.promise;
  if (mutation === 'session') present = false;
  if (mutation === 'conversation') conversation = randomUUID();
  if (mutation === 'admission') generation++;
  if (mutation === 'queued') queued = true;
  pending.resolve(); await rejected;
});

test('preview concurrency is bounded globally and per session, releases on failure and holds no payload cache', async () => {
  const requests = [fixtureRequest(), fixtureRequest(), fixtureRequest()]; const gate = deferred();
  let fail = false, reads = 0;
  const host = previewHost(requests[0], {
    session: id => session(requests.find(item => item.identity.sessionId === id)!),
    readSubmission: async (_options, runId) => { reads++; await gate.promise; if (fail) throw new Error(dataUrl); return clone(requests.find(item => item.identity.runId === runId)); },
  });
  const first = host.preview(previewRequest(requests[0]));
  await assert.rejects(host.preview(previewRequest(requests[0])), { message: NATIVE_IMAGE_PREVIEW_BUSY });
  const second = host.preview(previewRequest(requests[1]));
  await assert.rejects(host.preview(previewRequest(requests[2])), { message: NATIVE_IMAGE_PREVIEW_BUSY });
  gate.resolve(); assert.deepEqual(await first, { image, dataUrl }); assert.deepEqual(await second, { image, dataUrl });
  fail = true; await assert.rejects(host.preview(previewRequest(requests[0])), { message: NATIVE_IMAGE_PREVIEW_UNAVAILABLE });
  fail = false; assert.deepEqual(await host.preview(previewRequest(requests[0])), { image, dataUrl }); assert.equal(reads, 4);
});

async function serviceFixture(t: TestContext) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'native-preview-service-')));
  const request = fixtureRequest(), store = new StateStore(directory), now = new Date().toISOString(), projectId = randomUUID();
  store.change(state => {
    state.projects.push({ id: projectId, name: 'offline project', path: directory, createdAt: now });
    state.sessions.push({ ...session(request), projectId, title: 'archived recovery history', cwd: directory, engineConfig: { schemaVersion: 1, options: {} },
      started: true, status: 'error', taskState: 'error', error: 'prior recovery barrier', archived: true, createdAt: now, updatedAt: now });
  });
  const registry = new ExecutionRegistry(id => { const item = store.state.sessions.find(value => value.id === id); if (!item) throw new Error('deleted'); return item; });
  // No engine or connection is registered. Offline preview must not consult
  // execution availability, model credentials or hydrate a writer-backed ledger.
  const service = new SessionService(store, registry, () => {}, () => null, {} as never);
  const handlers = new Map<string, (input: unknown) => unknown>();
  service.register((name, schema, action) => handlers.set(name, input => action(schema.parse(input))));
  t.after(async () => { await service.shutdown(); store.flush(); await fs.rm(directory, { recursive: true, force: true }); });
  return { directory, request, store, service, preview: (value: unknown = previewRequest(request)) => Promise.resolve(handlers.get('native:image-preview')!(value)) };
}

test('SessionService composition previews cold drafts without rewriting or restoring a queued message', async t => {
  const f = await serviceFixture(t), manager = new Attachments(f.directory), source = path.join(f.directory, 'recorded.png'); await fs.writeFile(source, bytes);
  const selected = (await manager.add(f.request.identity.sessionId, [source]))[0];
  const queueDirectory = path.join(f.directory, 'chat-queue'); await fs.mkdir(queueDirectory);
  await fs.writeFile(path.join(queueDirectory, `${f.request.identity.sessionId}.json`), JSON.stringify({ version: 1, paused: false, receipts: [], items: [{
    id: randomUUID(), text: 'pending unrelated message', attachments: ['/unrelated/file.png'], createdAt: new Date().toISOString(), status: 'sending',
  }] }));
  const before = await files(f.directory);
  assert.deepEqual(await f.preview({ sessionId: f.request.identity.sessionId, conversationId: f.request.identity.conversationId, source: { kind: 'draft', path: selected.path } }), { image, dataUrl });
  assert.deepEqual(await files(f.directory), before);
});

test('SessionService allows archived recovery history without a configured model and does not hydrate or write', async t => {
  const f = await serviceFixture(t); let reads = 0;
  t.mock.method(NativeRunStore, 'readSubmission', async () => { reads++; return clone(f.request); });
  const before = await files(f.directory);
  assert.deepEqual(await f.preview(), { image, dataUrl });
  assert.deepEqual(await files(f.directory), before); assert.equal(reads, 1);
});

for (const mutation of ['maintenance', 'delete', 'stop', 'lifecycle']) test(`SessionService rejects an in-flight preview after ${mutation}, including completed management`, async t => {
  const f = await serviceFixture(t), entered = deferred(), pending = deferred();
  t.mock.method(NativeRunStore, 'readSubmission', async () => { entered.resolve(); await pending.promise; return clone(f.request); });
  const result = f.preview(), rejected = assert.rejects(result, { message: NATIVE_IMAGE_PREVIEW_UNAVAILABLE }); await entered.promise;
  if (mutation === 'maintenance') await f.service.withEngineMaintenance('native', async () => {});
  if (mutation === 'delete') f.store.change(state => { state.sessions = state.sessions.filter(value => value.id !== f.request.identity.sessionId); });
  if (mutation === 'stop') await f.service.stop(f.request.identity.sessionId).catch(() => {});
  if (mutation === 'lifecycle') {
    const service = f.service as unknown as { beginLifecycle(id: string): void; lifecycle: Set<string> };
    service.beginLifecycle(f.request.identity.sessionId); service.lifecycle.delete(f.request.identity.sessionId);
  }
  pending.resolve(); await rejected;
});
