import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ElectronApplication, Page } from '@playwright/test';
import { collectNativeQueueDiagnostics, nativeQueueDiagnosticSources, readNativeQueueLedger, summarizeNativeQueueLedger,
  withNativeQueueDiagnostics, type NativeQueueDiagnosticSources } from './helpers/native-queue-diagnostics';

const conversationId = randomUUID(), secret = 'sk-queue-diagnostic-MUST-NOT-APPEAR';
const identity = { sessionId: randomUUID(), conversationId, runId: randomUUID(), requestId: randomUUID(), workerGeneration: 1 };
function sources(overrides: Partial<NativeQueueDiagnosticSources> = {}): NativeQueueDiagnosticSources {
  return { snapshot: async () => ({ sessionId: identity.sessionId, taskState: 'thinking', nativeRun: identity, messages: [] }),
    queue: async () => ({ items: [], receipts: [], paused: false }), metrics: async () => [],
    ledger: async () => ({ records: [] }), fixture: () => ({ requestCount: 0, errors: [] }), ...overrides };
}

test('queue diagnostics preserve original read-only evidence before a potentially hydrating chatSnapshot', async () => {
  const order: string[] = []; let requests = 0, release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const pending = collectNativeQueueDiagnostics({ phase: 'first-request', conversationId, sources: sources({
    queue: async () => { order.push('queue-start'); await barrier; order.push('queue-finish'); return { items: [{ id: randomUUID(), status: 'sending', text: secret }] }; },
    ledger: async () => { order.push('ledger'); return { records: [{ seq: 1, identity, event: { type: 'run_started', request: { input: secret } } }] }; },
    metrics: async () => { order.push('metrics'); return []; },
    state: async () => { order.push('state'); return { sessionId: identity.sessionId, conversationId, status: 'running' }; },
    snapshot: async () => { order.push('snapshot'); requests++; return { nativeRun: identity, messages: [{ text: secret }] }; },
    fixture: () => ({ requestCount: requests, errors: [] }),
  }) });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.ok(order.includes('ledger')); assert.ok(order.includes('metrics')); assert.equal(order.includes('snapshot'), false);
  release(); const diagnostic = await pending;
  assert.ok(order.indexOf('queue-finish') < order.indexOf('snapshot')); assert.equal(diagnostic.snapshot.afterReadonlyEvidence, true);
  assert.equal(diagnostic.requestCountAtFailure, 0); assert.equal(diagnostic.requestCountAfterReadonlyEvidence, 0); assert.equal(diagnostic.requestCountAfterCollection, 1);
  assert.equal(JSON.stringify(diagnostic).includes(secret), false);
});

test('hung IPC and filesystem probes share a fixed total deadline while independent evidence remains visible', async () => {
  const never = () => new Promise<never>(() => {});
  const diagnostic = await collectNativeQueueDiagnostics({ phase: 'first-request', conversationId, timeoutMs: 40, sources: sources({
    snapshot: never, queue: never, metrics: async () => [{ pid: 42, type: 'Utility', serviceName: 'cc-desk native agent' }],
    ledger: async () => { throw Object.assign(new Error(`File ${secret} unavailable`), { code: 'ENOENT' }); },
  }) });
  assert.equal(diagnostic.snapshot.status, 'timeout'); assert.equal(diagnostic.diskQueue.status, 'timeout'); assert.equal(diagnostic.metrics.status, 'ok');
  assert.equal(diagnostic.ledger.status, 'error');
  if (diagnostic.ledger.status === 'error') assert.equal(diagnostic.ledger.error.code, 'ENOENT');
  assert.ok(diagnostic.elapsedMs < 2000, 'neither hung probe may hold diagnostic collection open indefinitely');
  assert.equal(JSON.stringify(diagnostic).includes(secret), false);
});

test('diagnostics whitelist bounded queue, metrics and ledger metadata without content or exception messages', async () => {
  const error = Object.assign(new Error(secret), { code: 'ERR_ASSERTION', actual: secret, expected: secret });
  const records = Array.from({ length: 100 }, (_, index) => ({ seq: index + 1, committedAt: '2026-10-17T02:16:24.000Z', identity: { ...identity, requestId: secret },
    event: { type: 'model_request_diagnostic', diagnostic: { identity, phase: 'dispatched', purpose: 'normal', requestSent: true, body: secret }, instructions: secret } }));
  const queue = { paused: true, error: secret, items: Array.from({ length: 100 }, () => ({ id: randomUUID(), status: 'sending', text: secret, attachments: [secret], clientRequestId: secret })),
    receipts: Array.from({ length: 100 }, () => ({ messageId: randomUUID(), requestId: secret })) };
  const diagnostic = await collectNativeQueueDiagnostics({ phase: 'second-request', conversationId, sources: sources({
    fixture: () => ({ requestCount: 2, errors: [error] }), queue: async () => queue,
    snapshot: async () => ({ nativeRun: identity, taskState: 'thinking', queue, messages: [{ text: secret }], pending: [], error: secret }),
    ledger: async () => ({ records }), metrics: async () => Array.from({ length: 100 }, () => ({ pid: 42, type: 'Utility', name: secret, serviceName: 'cc-desk native agent',
      cpu: { percentCPUUsage: 0.2, secret }, memory: { workingSetSize: 256, secret }, commandLine: secret })),
  }) });
  const serialized = JSON.stringify(diagnostic);
  assert.equal(serialized.includes(secret), false); assert.equal(serialized.includes('instructions'), false); assert.equal(serialized.includes('commandLine'), false);
  assert.deepEqual(diagnostic.fixtureErrorsAtFailure, [{ name: 'Error', code: 'ERR_ASSERTION' }]);
  if (diagnostic.diskQueue.status === 'ok') {
    const queue = diagnostic.diskQueue.value as { items: unknown[]; receipts: unknown[]; itemCount: number };
    assert.equal(queue.items.length, 32); assert.equal(queue.receipts.length, 32); assert.equal(queue.itemCount, 100);
  }
  if (diagnostic.ledger.status === 'ok') {
    const ledger = diagnostic.ledger.value as ReturnType<typeof summarizeNativeQueueLedger>;
    assert.equal(ledger.events.length, 64); assert.equal(ledger.events[0].seq, 37); assert.equal(ledger.events[0].committedAt, '2026-10-17T02:16:24.000Z');
  }
  if (diagnostic.metrics.status === 'ok') assert.equal((diagnostic.metrics.value as { processes: unknown[] }).processes.length, 32);
});

test('a differing actual worker conversation is read separately and labeled after snapshot hydration', async () => {
  const actualId = randomUUID(), reads: string[] = [];
  const diagnostic = await collectNativeQueueDiagnostics({ phase: 'first-request', conversationId, sources: sources({
    snapshot: async () => ({ nativeRun: { ...identity, conversationId: actualId } }),
    ledger: async id => { reads.push(id); return { records: [{ seq: id === conversationId ? 1 : 2, identity, event: { type: 'conversation_created' } }] }; },
  }) });
  assert.deepEqual(reads, [conversationId, actualId]); assert.equal(diagnostic.actualLedger?.conversationId, actualId);
  assert.equal(diagnostic.actualLedger?.afterSnapshotHydration, true); assert.equal(diagnostic.ledger.conversationId, conversationId);
});

test('ledger diagnostics read a bounded tail without a writer lock and preserve incomplete append evidence', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-queue-diagnostic-tail-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'journal.jsonl');
  const prefix = JSON.stringify({ seq: 1, identity, event: { type: 'model_response', content: secret.repeat(9000) } }) + '\n';
  const rows = Array.from({ length: 80 }, (_, index) => JSON.stringify({ seq: index + 2, identity, event: { type: 'model_request_started', attempt: index + 1, secret } }) + '\n').join('');
  await fs.writeFile(file, prefix + rows + '{"partial":');
  const before = await fs.stat(file), captured = await readNativeQueueLedger(file), summary = summarizeNativeQueueLedger(captured);
  assert.ok(captured.bytes > 256 * 1024); assert.ok(captured.readBytes <= 256 * 1024); assert.equal(captured.partialHead, true); assert.equal(captured.partialTail, true);
  assert.equal(captured.malformedLines, 1); assert.equal(summary.events.length, 64); assert.equal(summary.events.at(-1)?.seq, 81);
  assert.equal(JSON.stringify(summary).includes(secret), false); assert.equal((await fs.stat(file)).size, before.size); assert.deepEqual(await fs.readdir(directory), ['journal.jsonl']);
});

test('real missing journals and oversized queue files are explicit diagnostic failures', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-queue-diagnostic-files-')), sessionId = randomUUID();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.mkdir(path.join(directory, 'chat-queue'));
  const queue = await fs.open(path.join(directory, 'chat-queue', `${sessionId}.json`), 'w');
  try { await queue.truncate(1024 * 1024 + 1); } finally { await queue.close(); }
  const fake = nativeQueueDiagnosticSources({ app: { evaluate: async () => [] } as unknown as ElectronApplication,
    page: { evaluate: async () => ({}) } as unknown as Page, dataDirectory: directory, sessionId, fixture: { requests: [], errors: [] } });
  const diagnostic = await collectNativeQueueDiagnostics({ phase: 'first-request', conversationId, sources: fake });
  assert.equal(diagnostic.diskQueue.status, 'error'); assert.equal(diagnostic.ledger.status, 'error');
  if (diagnostic.diskQueue.status === 'error') assert.equal(diagnostic.diskQueue.error.code, 'EVIDENCE_TOO_LARGE');
  if (diagnostic.ledger.status === 'error') assert.equal(diagnostic.ledger.error.code, 'ENOENT');
});

test('diagnostic attachment failure never substitutes or suppresses the original 5-second assertion', async t => {
  const original = new Error('Original request-count assertion'), logged: unknown[] = [];
  t.mock.method(console, 'error', (value: unknown) => { logged.push(value); });
  await assert.rejects(withNativeQueueDiagnostics(async () => { throw original; }, { phase: 'first-request', conversationId, sources: sources(),
    attach: async () => { throw new Error(secret); } }), error => error === original);
  assert.equal(logged.length, 1); assert.equal(JSON.stringify(logged).includes(secret), false);
});

test('a hung attachment remains bounded and still rejects with the original request-count failure', async t => {
  const original = new Error('Original request-count assertion'), started = performance.now();
  t.mock.method(console, 'error', () => {});
  await assert.rejects(withNativeQueueDiagnostics(async () => { throw original; }, { phase: 'second-request', conversationId, timeoutMs: 30, sources: sources(),
    attach: () => new Promise<void>(() => {}) }), error => error === original);
  assert.ok(performance.now() - started < 2500, 'attachment must not hold cleanup open indefinitely');
});
