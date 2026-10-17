import type { ElectronApplication, Page, TestInfo } from '@playwright/test';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_ITEMS = 32, MAX_EVENTS = 64, MAX_LEDGER_BYTES = 256 * 1024, MAX_QUEUE_BYTES = 1024 * 1024;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const timestamp = (value: unknown) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) ? value : undefined;
const known = (value: unknown, values: string[]) => typeof value === 'string' && values.includes(value) ? value : undefined;
const id = (value: unknown) => typeof value === 'string' && value.length <= 256
  ? uuid.test(value) ? value : `sha256:${createHash('sha256').update(value).digest('hex')}` : undefined;
const identity = (value: unknown) => {
  const item = record(value);
  return { sessionId: id(item.sessionId), conversationId: id(item.conversationId), runId: id(item.runId), requestId: id(item.requestId), workerGeneration: count(item.workerGeneration) };
};
const errorCodes = ['ENOENT', 'EACCES', 'EPERM', 'EBUSY', 'ENOTDIR', 'EISDIR', 'EINVAL', 'EMFILE', 'ENFILE', 'EIO', 'ENOSPC', 'ERR_ASSERTION', 'ERR_INVALID_ARG_TYPE', 'EVIDENCE_TOO_LARGE', 'NOT_REGULAR_FILE'];
/** No exception messages, stacks, assertion values or provider responses enter attachments. */
export function nativeQueueDiagnosticError(error: unknown) {
  const item = record(error);
  return { name: known(item.name, ['Error', 'TypeError', 'SyntaxError', 'RangeError', 'AssertionError', 'TimeoutError']) ?? 'unclassified',
    code: known(item.code, errorCodes) ?? 'unclassified' };
}
export function summarizeNativeQueue(value: unknown) {
  const queue = record(value), items = Array.isArray(queue.items) ? queue.items : [], receipts = Array.isArray(queue.receipts) ? queue.receipts : [];
  return { present: Boolean(value), paused: typeof queue.paused === 'boolean' ? queue.paused : undefined, errorPresent: Boolean(queue.error),
    itemCount: items.length, items: items.slice(0, MAX_ITEMS).map(value => { const item = record(value); return {
      id: id(item.id), clientRequestId: id(item.clientRequestId), status: known(item.status, ['queued', 'sending']),
      attachmentCount: Array.isArray(item.attachments) ? item.attachments.length : count(item.attachmentCount), nativeTaskId: id(item.nativeTaskId),
    }; }), receiptCount: receipts.length, receipts: receipts.slice(-MAX_ITEMS).map(value => { const item = record(value); return { requestId: id(item.requestId), messageId: id(item.messageId) }; }) };
}
function summarizeSnapshot(value: unknown) {
  const item = record(value), version = record(item.version), pending = Array.isArray(item.pending) ? item.pending : [];
  return { sessionId: id(item.sessionId), taskState: known(item.taskState, ['idle', 'starting', 'thinking', 'waiting_approval', 'waiting_input', 'completed', 'interrupted', 'error']),
    sessionStatus: known(item.sessionStatus, ['idle', 'starting', 'running', 'stopped', 'completed', 'interrupted', 'error']), nativeRun: identity(item.nativeRun),
    version: { hostEpoch: id(version.hostEpoch), revision: count(version.revision), eventSequence: count(version.eventSequence), conversationId: id(version.conversationId), runId: id(version.runId), workerGeneration: count(version.workerGeneration) },
    messageCount: Array.isArray(item.messages) ? item.messages.length : count(item.messageCount), pendingCount: pending.length,
    errorPresent: Boolean(item.error), sourceIncomplete: typeof item.sourceIncomplete === 'boolean' ? item.sourceIncomplete : undefined, queue: summarizeNativeQueue(item.queue) };
}
function summarizeMetrics(value: unknown) {
  const source = record(value), metrics = Array.isArray(value) ? value : Array.isArray(source.processes) ? source.processes : [];
  return { processCount: count(source.processCount) ?? metrics.length, processes: metrics.slice(0, MAX_ITEMS).map(value => {
    const item = record(value), cpu = record(item.cpu), memory = record(item.memory);
    return { pid: count(item.pid), type: known(item.type, ['Browser', 'Tab', 'Utility', 'Zygote', 'Sandbox helper', 'GPU', 'Pepper Plugin', 'Pepper Plugin Broker', 'Unknown']),
      nativeAgent: item.nativeAgent === true || item.serviceName === 'cc-desk native agent' || item.name === 'cc-desk native agent', creationTime: number(item.creationTime),
      cpu: { percentCPUUsage: number(cpu.percentCPUUsage), cumulativeCPUUsage: number(cpu.cumulativeCPUUsage), idleWakeupsPerSecond: number(cpu.idleWakeupsPerSecond) },
      memory: { workingSetSize: count(memory.workingSetSize), peakWorkingSetSize: count(memory.peakWorkingSetSize) } };
  }) };
}
const eventTypes = ['conversation_created', 'startup_prepared', 'startup_closed', 'change_set_file', 'command_lifecycle', 'run_started', 'run_recovered', 'run_event',
  'context_compaction_attempted', 'context_compacted', 'run_context_compaction_attempted', 'run_context_compacted', 'run_context_compaction_failed', 'model_request_diagnostic', 'recovery_resolved'];
const runEventTypes = ['model_request_started', 'model_request_failed', 'model_response', 'tool_prepared', 'tool_completed', 'run_finished', 'completion_rejected'];
export function summarizeNativeQueueLedger(value: unknown) {
  const item = record(value), records = Array.isArray(item.records) ? item.records : [];
  return { bytes: count(item.bytes), readBytes: count(item.readBytes), partialHead: item.partialHead === true, partialTail: item.partialTail === true,
    parsedRecords: count(item.parsedRecords), malformedLines: count(item.malformedLines), events: records.slice(-MAX_EVENTS).map(value => {
      const entry = record(value), event = record(entry.event), nested = record(event.event), diagnostic = record(event.diagnostic);
      const type = known(event.type, [...eventTypes, ...runEventTypes]) ?? 'unclassified';
      return { seq: count(entry.seq), committedAt: timestamp(entry.committedAt), type, worker: identity(entry.identity), ...(type === 'run_event' ? { runEventType: known(nested.type, runEventTypes) ?? 'unclassified' } : {}),
        ...(type === 'model_request_diagnostic' ? { diagnostic: { identity: identity(diagnostic.identity),
          phase: known(diagnostic.phase, ['started', 'request', 'dispatched', 'finished']), purpose: known(diagnostic.purpose, ['normal', 'child', 'summary_before_send', 'summary_in_run', 'summary_manual']),
          requestSent: typeof diagnostic.requestSent === 'boolean' ? diagnostic.requestSent : undefined,
          outcome: known(diagnostic.outcome, ['completed', 'failed', 'cancelled', 'unknown']) } } : {}) };
    }) };
}

type Probe = { status: 'ok'; value: unknown; elapsedMs: number } | { status: 'error'; error: ReturnType<typeof nativeQueueDiagnosticError>; elapsedMs: number } | { status: 'timeout'; elapsedMs: number };
export interface NativeQueueDiagnosticSources {
  state?(): Promise<unknown>;
  snapshot(): Promise<unknown>;
  queue(): Promise<unknown>;
  ledger(conversationId: string): Promise<unknown>;
  metrics(): Promise<unknown>;
  fixture(): { requestCount: number; errors: readonly unknown[] };
}
async function probe(work: () => Promise<unknown>, deadline: number): Promise<Probe> {
  const started = performance.now(), remaining = deadline - started;
  if (remaining <= 0) return { status: 'timeout', elapsedMs: 0 };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([
    Promise.resolve().then(work).then(value => ({ status: 'ok' as const, value, elapsedMs: performance.now() - started }),
      error => ({ status: 'error' as const, error: nativeQueueDiagnosticError(error), elapsedMs: performance.now() - started })),
    new Promise<Probe>(resolve => { timer = setTimeout(() => resolve({ status: 'timeout', elapsedMs: performance.now() - started }), remaining); }),
  ]); } finally { clearTimeout(timer); }
}
const projected = (result: Probe, summarize: (value: unknown) => unknown) => result.status === 'ok' ? { ...result, value: summarize(result.value) } : result;

/** All probes share one deadline; a hung renderer cannot hide independent on-disk or OS evidence. */
export async function collectNativeQueueDiagnostics(options: { phase: string; conversationId: string; sources: NativeQueueDiagnosticSources;
  timing?: Record<string, number | readonly number[] | undefined>; timeoutMs?: number }) {
  const started = performance.now(), deadline = started + Math.min(2000, Math.max(1, options.timeoutMs ?? 2000));
  const initialFixture = options.sources.fixture(), initialErrors = initialFixture.errors.slice(0, MAX_ITEMS).map(nativeQueueDiagnosticError), capturedAt = new Date().toISOString();
  const readonlyDeadline = started + (deadline - started) / 2;
  // chatSnapshot hydrates the conversation. Preserve the original filesystem and
  // process evidence first so hydration cannot manufacture its "before" state.
  const readonlyEvidence = await Promise.all([probe(options.sources.queue, readonlyDeadline), probe(options.sources.metrics, readonlyDeadline),
    probe(() => options.sources.ledger(options.conversationId), readonlyDeadline),
    options.sources.state ? probe(options.sources.state, readonlyDeadline) : Promise.resolve(undefined)]);
  const readonlyEvidenceElapsedMs = performance.now() - started;
  const requestCountAfterReadonlyEvidence = count(options.sources.fixture().requestCount);
  const snapshot = await probe(options.sources.snapshot, deadline);
  const item = snapshot.status === 'ok' ? record(snapshot.value) : {}, candidate = record(item.nativeRun).conversationId ?? record(item.version).conversationId;
  const actualLedger = typeof candidate === 'string' && uuid.test(candidate) && candidate !== options.conversationId
    ? { conversationId: candidate, result: await probe(() => options.sources.ledger(candidate), deadline) } : undefined;
  const finalFixture = options.sources.fixture();
  return { schemaVersion: 1, phase: options.phase, capturedAt, elapsedMs: performance.now() - started,
    requestCountAtFailure: count(initialFixture.requestCount), requestCountAfterReadonlyEvidence, requestCountAfterCollection: count(finalFixture.requestCount),
    fixtureErrorCountAtFailure: initialFixture.errors.length, fixtureErrorCountAfterCollection: finalFixture.errors.length,
    fixtureErrorsAtFailure: initialErrors, fixtureErrorsAfterCollection: finalFixture.errors.slice(0, MAX_ITEMS).map(nativeQueueDiagnosticError),
    timing: options.timing, readonlyEvidenceElapsedMs,
    snapshot: { afterReadonlyEvidence: true, ...projected(snapshot, summarizeSnapshot) }, diskQueue: projected(readonlyEvidence[0], summarizeNativeQueue), metrics: projected(readonlyEvidence[1], summarizeMetrics),
    ...(readonlyEvidence[3] ? { state: projected(readonlyEvidence[3], value => { const item = record(value); return { sessionId: id(item.sessionId),
      conversationId: id(item.conversationId), status: known(item.status, ['idle', 'starting', 'running', 'stopped', 'completed', 'error']), errorPresent: Boolean(item.error) }; }) } : {}),
    ledger: { conversationId: id(options.conversationId), ...projected(readonlyEvidence[2], summarizeNativeQueueLedger) },
    ...(actualLedger ? { actualLedger: { afterSnapshotHydration: true, conversationId: id(actualLedger.conversationId), ...projected(actualLedger.result, summarizeNativeQueueLedger) } } : {}) };
}

async function readQueue(file: string) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw Object.assign(new Error('Diagnostic queue is unavailable.'), { code: 'NOT_REGULAR_FILE' });
  if (stat.size > MAX_QUEUE_BYTES) throw Object.assign(new Error('Diagnostic queue exceeds its size limit.'), { code: 'EVIDENCE_TOO_LARGE' });
  const handle = await fs.open(file, 'r');
  try {
    const bytes = (await handle.stat()).size;
    if (bytes > MAX_QUEUE_BYTES) throw Object.assign(new Error('Diagnostic queue exceeds its size limit.'), { code: 'EVIDENCE_TOO_LARGE' });
    const buffer = Buffer.alloc(bytes), result = await handle.read(buffer, 0, bytes, 0);
    return JSON.parse(buffer.subarray(0, result.bytesRead).toString('utf8')) as unknown;
  } finally { await handle.close(); }
}
/** Tail reads never open the authoritative writer or copy model/tool/config text into diagnostics. */
export async function readNativeQueueLedger(file: string) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw Object.assign(new Error('Diagnostic journal is unavailable.'), { code: 'NOT_REGULAR_FILE' });
  const handle = await fs.open(file, 'r');
  try {
    const bytes = (await handle.stat()).size, length = Math.min(bytes, MAX_LEDGER_BYTES), buffer = Buffer.alloc(length);
    const result = await handle.read(buffer, 0, length, bytes - length), text = buffer.subarray(0, result.bytesRead).toString('utf8');
    const partialHead = bytes > length, partialTail = !text.endsWith('\n'), lines = text.split('\n');
    if (partialHead) lines.shift();
    const records: unknown[] = []; let malformedLines = 0, parsedRecords = 0;
    for (const line of lines) {
      if (!line) continue;
      try { records.push(JSON.parse(line)); parsedRecords++; if (records.length > MAX_EVENTS) records.shift(); }
      catch { malformedLines++; }
    }
    return { bytes, readBytes: result.bytesRead, partialHead, partialTail, parsedRecords, malformedLines, records };
  } finally { await handle.close(); }
}

export function nativeQueueDiagnosticSources(options: { app: ElectronApplication; page: Page; dataDirectory: string; sessionId: string;
  fixture: { requests: readonly unknown[]; errors: readonly unknown[] } }): NativeQueueDiagnosticSources {
  const { app, page, dataDirectory, sessionId, fixture } = options;
  if (!uuid.test(sessionId)) throw new Error('Invalid diagnostic session.');
  return {
    state: () => page.evaluate(async id => {
      const session = (await window.desktop.snapshot()).state.sessions.find(item => item.id === id);
      return { sessionId: session?.id, conversationId: session?.execution.conversationId, status: session?.status, error: Boolean(session?.error) };
    }, sessionId),
    snapshot: () => page.evaluate(async id => {
      const snapshot = await window.desktop.chatSnapshot(id);
      return { sessionId: snapshot.sessionId, taskState: snapshot.taskState, sessionStatus: snapshot.sessionStatus, nativeRun: snapshot.nativeRun, version: snapshot.version,
        messageCount: snapshot.messages.length, pending: snapshot.pending.map(item => ({ kind: item.kind })), error: Boolean(snapshot.error), sourceIncomplete: snapshot.sourceIncomplete,
        queue: snapshot.queue ? { paused: snapshot.queue.paused, error: Boolean(snapshot.queue.error), receipts: snapshot.queue.receipts,
          items: snapshot.queue.items.map(item => ({ id: item.id, clientRequestId: item.clientRequestId, status: item.status, attachmentCount: item.attachments.length, nativeTaskId: item.nativeTaskId })) } : undefined };
    }, sessionId),
    queue: () => readQueue(path.join(dataDirectory, 'chat-queue', `${sessionId}.json`)),
    ledger: conversationId => {
      if (!uuid.test(conversationId)) return Promise.reject(new Error('Invalid diagnostic conversation.'));
      return readNativeQueueLedger(path.join(dataDirectory, 'native', 'conversations', conversationId, 'journal.jsonl'));
    },
    metrics: () => app.evaluate(({ app }) => { const metrics = app.getAppMetrics(); return { processCount: metrics.length,
      processes: metrics.sort((left, right) => Number(right.serviceName === 'cc-desk native agent' || right.name === 'cc-desk native agent')
        - Number(left.serviceName === 'cc-desk native agent' || left.name === 'cc-desk native agent')).slice(0, 32).map(item => ({ pid: item.pid, type: item.type, creationTime: item.creationTime,
        nativeAgent: item.serviceName === 'cc-desk native agent' || item.name === 'cc-desk native agent', cpu: item.cpu, memory: item.memory })) }; }),
    fixture: () => ({ requestCount: fixture.requests.length, errors: fixture.errors.slice(0, MAX_ITEMS) }),
  };
}

type Attach = TestInfo['attach'];
async function attachBounded(attach: Attach, name: string, value: unknown) {
  return await probe(() => attach(name, { body: Buffer.from(JSON.stringify(value, null, 2)), contentType: 'application/json' }), performance.now() + 1000);
}
/** The original assertion remains the failure even if evidence gathering or attaching also fails. */
export async function withNativeQueueDiagnostics<T>(action: () => Promise<T>, options: Parameters<typeof collectNativeQueueDiagnostics>[0] & { attach: Attach }) {
  try { return await action(); }
  catch (error) {
    try {
      const diagnostic = await collectNativeQueueDiagnostics(options);
      const attached = await attachBounded(options.attach, `native-queue-${options.phase}-diagnostic.json`, diagnostic);
      if (attached.status !== 'ok') console.error(JSON.stringify({ phase: 'native-queue-diagnostic-attachment', status: attached.status, ...(attached.status === 'error' ? { error: attached.error } : {}) }));
    } catch (diagnosticError) { console.error(JSON.stringify({ phase: 'native-queue-diagnostic-collection', error: nativeQueueDiagnosticError(diagnosticError) })); }
    throw error;
  }
}
export async function attachNativeQueueTiming(attach: Attach, timing: Record<string, number | readonly number[] | undefined>) {
  await attachBounded(attach, 'native-queue-timing.json', timing);
}
