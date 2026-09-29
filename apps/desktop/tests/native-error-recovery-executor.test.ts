import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { runAgent } from '@cc-desk/agent-core';
import { createNativeModel } from '@cc-desk/agent-node/native-model';
import { NativeRunStore } from '@cc-desk/agent-node/run-store';
import { StateStore } from '../src/main/store';
import { ExecutionEvents } from '../src/main/execution/events';
import { ConnectionStore } from '../src/main/engines/native/connections';
import { NativeStructuredExecutor, type NativeExecutorOptions } from '../src/main/engines/native/structured-executor';
import { createNativeConfig } from '../src/main/engines/native/config';
// @ts-expect-error Local protocol fixture has no declarations.
import { startResponsesFixture, functionCall, assistantMessage, responseEvents } from '../../../packages/agent-node/tests/fixtures/responses-server.mjs';
// @ts-expect-error Local protocol fixture has no declarations.
import { startChatCompletionsFixture, chatChunk } from '../../../packages/agent-node/tests/fixtures/chat-completions-server.mjs';

type Protocol = 'responses' | 'chat-completions';
type Scenario = 'recover' | 'unavailable' | 'authentication' | 'partial' | 'repeat-read' | 'repeat-failure';
const secret = 'sk-error-recovery-fixture-only';
const unfinished = 'PARTIAL_NOT_A_COMPLETE_RESPONSE '.repeat(10);

async function fixture(protocol: Protocol, scenario: Scenario, options: { modelRetry?: 'off' | 'safe_transient'; maxModelRequests?: number; holdWait?: boolean } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-error-recovery-'));
  const project = path.join(directory, 'project'), data = path.join(directory, 'data'); await fs.mkdir(project);
  await fs.writeFile(path.join(project, 'fixture.txt'), 'unchanged source\n');
  const server = await (protocol === 'responses' ? startResponsesFixture : startChatCompletionsFixture)({ assertReplay: false,
    handler: ({ index }: { index: number }) => {
      if (scenario === 'unavailable') return { httpStatus: 503, raw: 'untrusted service body must not reach diagnostics' };
      if (scenario === 'authentication') return { httpStatus: 401, raw: secret };
      if (scenario === 'partial') return protocol === 'responses'
        ? { events: responseEvents([assistantMessage('partial', unfinished)]).slice(0, -1) }
        : { events: [chatChunk({ role: 'assistant', content: unfinished })] };
      const call = (id: string, file: string) => protocol === 'responses'
        ? { output: [functionCall(id, 'read_file', { path: file })] }
        : { message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: file }) } }] } };
      if (scenario === 'repeat-read' || scenario === 'repeat-failure') return call(`read-${index}`, scenario === 'repeat-read' ? 'fixture.txt' : 'missing.txt');
      if (index === 0 || index === 2) return { httpStatus: index === 0 ? 503 : 429, raw: 'untrusted provider details' };
      if (index === 1) return call('only-read', 'fixture.txt');
      return protocol === 'responses' ? { output: [assistantMessage('final', 'Recovery completed with one saved file read.')] }
        : { message: { role: 'assistant', content: 'Recovery completed with one saved file read.' } };
    },
  });
  const store = new StateStore(data), connections = new ConnectionStore(data), events = new ExecutionEvents();
  const initial = connections.upsert({ name: 'error recovery fixture', protocol, baseURL: server.baseURL, model: 'fixture-model', enabled: true,
    allowLoopbackHttp: true, auth: { mode: 'memory' }, pricing: { model: 'fixture-model', inputUSDPerMillion: 2, outputUSDPerMillion: 8 } });
  const connection = connections.setCredential({ id: initial.id, revision: initial.revision, mode: 'memory', secret });
  const id = randomUUID(), conversationId = randomUUID(), projectId = randomUUID();
  store.change(state => {
    state.projects.push({ id: projectId, name: 'project', path: project, createdAt: new Date().toISOString() });
    state.sessions.push({ id, projectId, title: 'error recovery', kind: 'agent', cwd: project,
      execution: { providerId: 'native', mode: 'structured', conversationId },
      engineConfig: createNativeConfig({ schemaVersion: 1, options: { connectionId: connection.id,
        ...(options.modelRetry ? { modelRetry: options.modelRetry } : {}), maxModelRequests: options.maxModelRequests ?? 10 } }),
      started: false, archived: false, status: 'idle', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  });
  const waits: number[] = []; let enteredWait!: () => void;
  const waiting = new Promise<void>(resolve => { enteredWait = resolve; });
  const worker: NonNullable<NativeExecutorOptions['worker']> = request => runAgent({ ...request.request, signal: request.signal }, {
    model: createNativeModel(request.model), tools: request.tools, store: request.store, approvals: request.approvals,
    contextMaintenance: request.contextMaintenance,
    host: { now: Date.now, digest: text => createHash('sha256').update(text).digest('hex'), emit: request.onEvent,
      deadline: (ms, parent) => {
        const controller = new AbortController(), abort = () => controller.abort(), timer = setTimeout(abort, ms);
        parent.addEventListener('abort', abort, { once: true }); if (parent.aborted) abort();
        return { signal: controller.signal, dispose() { clearTimeout(timer); parent.removeEventListener('abort', abort); } };
      },
      wait: async (ms, signal) => {
        waits.push(ms); enteredWait();
        if (options.holdWait) await new Promise<void>((_resolve, reject) => {
          const cancel = () => { signal.removeEventListener('abort', cancel); reject(new Error('cancelled')); };
          signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) cancel();
        });
      },
    },
  });
  let executor = new NativeStructuredExecutor(store, connections, events, { worker }); await executor.initialize();
  return { id, project, server, waits, waiting, get executor() { return executor; },
    send: () => executor.send(id, 'Inspect the source once; do not change files.', [], undefined, { requestId: 'error-recovery-submission' }),
    async ledger() {
      const ledger = await NativeRunStore.open({ rootDirectory: path.join(data, 'native', 'conversations'), conversationId });
      try { return { runs: ledger.listRuns(), records: ledger.replay(), context: ledger.loadContext(), recovery: ledger.getRecoveryReport() }; } finally { await ledger.close(); }
    },
    async restart() { await executor.shutdown(); executor = new NativeStructuredExecutor(store, connections, events, { worker }); await executor.initialize(); },
    async dispose() { await executor.shutdown().catch(() => {}); await server.close(); store.flush(); await fs.rm(directory, { recursive: true, force: true }); },
  };
}

for (const protocol of ['responses', 'chat-completions'] as const) test(`${protocol}: safe retry preserves context, does not repeat tools, accounts failed attempts and remains deduplicated after restart`, async () => {
  const f = await fixture(protocol, 'recover', { modelRetry: 'safe_transient' });
  try {
    const result = await f.send(); assert.equal(result.success, true, JSON.stringify(result)); assert.deepEqual(f.server.errors, []);
    assert.equal(f.server.requests.length, 4); assert.deepEqual(f.waits, [500, 1500]);
    assert.deepEqual(f.server.requests[0], f.server.requests[1]); assert.deepEqual(f.server.requests[2], f.server.requests[3]);
    const ledger = await f.ledger(), run = ledger.runs[0].result!;
    assert.equal(run.modelRequests, 4); assert.equal(run.toolCalls, 1); assert.equal(run.usage, null);
    assert.equal(ledger.records.filter(record => record.event.type === 'model_request_started').length, 4);
    assert.equal(ledger.records.filter(record => record.event.type === 'model_request_failed').length, 2);
    assert.equal(ledger.records.filter(record => record.event.type === 'tool_completed').length, 1);
    assert.equal(f.executor.snapshot(f.id).usage?.costUSD, undefined, 'unknown failed usage cannot produce a complete price');
    assert.equal(JSON.stringify(f.executor.snapshot(f.id)).includes('untrusted provider details'), false);
    assert.equal(await fs.readFile(path.join(f.project, 'fixture.txt'), 'utf8'), 'unchanged source\n');
    await f.restart(); assert.equal((await f.send()).success, true); assert.equal(f.server.requests.length, 4);
    assert.deepEqual((await f.ledger()).context, ledger.context);
  } finally { await f.dispose(); }
});

for (const [label, scenario, options, count] of [
  ['default off', 'unavailable', {}, 1],
  ['authentication is not retryable', 'authentication', { modelRetry: 'safe_transient' }, 1],
  ['request budget blocks retry', 'unavailable', { modelRetry: 'safe_transient', maxModelRequests: 1 }, 1],
  ['whole-run retry allowance is bounded', 'unavailable', { modelRetry: 'safe_transient' }, 3],
] as const) test(label, async () => {
  const f = await fixture('responses', scenario, options);
  try {
    assert.equal((await f.send()).success, false); assert.equal(f.server.requests.length, count);
    const ledger = await f.ledger(); assert.equal(ledger.runs[0].result!.modelRequests, count);
    assert.equal(ledger.runs[0].result!.usage, null); assert.equal(ledger.recovery, null);
    assert.equal(JSON.stringify(f.executor.snapshot(f.id)).includes(secret), false);
    assert.equal(JSON.stringify(ledger).includes(secret), false);
  } finally { await f.dispose(); }
});

test('cancelling backoff closes the same run without dispatching another model request', async () => {
  const f = await fixture('responses', 'unavailable', { modelRetry: 'safe_transient', holdWait: true });
  try {
    const running = f.send(); await f.waiting; await f.executor.stop(f.id);
    const result = await running; assert.equal(result.success, false); assert.equal(result.interrupted, true);
    assert.equal(f.server.requests.length, 1); assert.deepEqual(f.waits, [500]);
    const ledger = await f.ledger(); assert.equal(ledger.runs[0].result!.status, 'cancelled'); assert.equal(ledger.recovery, null);
  } finally { await f.dispose(); }
});

for (const protocol of ['responses', 'chat-completions'] as const) test(`${protocol}: partial stream is discarded without retry or workflow text`, async () => {
  const f = await fixture(protocol, 'partial', { modelRetry: 'safe_transient' });
  try {
    const result = await f.send(); assert.equal(result.success, false); assert.equal(result.summary, '');
    assert.equal(f.server.requests.length, 1); assert.deepEqual(f.waits, []);
    const ledger = await f.ledger(); assert.equal(ledger.records.some(record => record.event.type === 'model_response'), false);
    assert.equal(JSON.stringify(ledger.context).includes('PARTIAL_NOT_A_COMPLETE_RESPONSE'), false);
    assert.equal(JSON.stringify(f.executor.snapshot(f.id)).includes('PARTIAL_NOT_A_COMPLETE_RESPONSE'), false);
    const failure = ledger.records.find(record => record.event.type === 'model_request_failed');
    assert.ok(failure && failure.event.type === 'model_request_failed' && failure.event.partial);
  } finally { await f.dispose(); }
});

for (const eventType of ['model_request_started', 'model_request_failed'] as const) test(`${eventType}: lost durable acknowledgement isolates the run and never dispatches a retry`, async () => {
  const f = await fixture('responses', 'unavailable', { modelRetry: 'safe_transient' });
  const original = NativeRunStore.prototype.append;
  NativeRunStore.prototype.append = async function (identity, event) {
    const receipt = await original.call(this, identity, event);
    if (identity.sessionId === f.id && event.type === eventType) throw new Error('Injected acknowledgement loss');
    return receipt;
  };
  try {
    assert.equal((await f.send()).success, false); assert.equal(f.server.requests.length, eventType === 'model_request_started' ? 0 : 1);
    assert.deepEqual(f.waits, []); NativeRunStore.prototype.append = original;
    const before = await f.ledger(); assert.ok(before.recovery); assert.equal(before.records.some(record => record.event.type === 'run_finished'), false);
    await f.restart(); assert.equal((await f.send()).success, false);
    assert.equal(f.server.requests.length, eventType === 'model_request_started' ? 0 : 1);
  } finally { NativeRunStore.prototype.append = original; await f.dispose(); }
});

for (const scenario of ['repeat-read', 'repeat-failure'] as const) test(`${scenario}: repeated complete batches stop with saved receipts and a human-readable reason`, async () => {
  const f = await fixture('responses', scenario);
  try {
    const result = await f.send(); assert.equal(result.success, false); assert.equal(f.server.requests.length, 3);
    const ledger = await f.ledger(); assert.equal(ledger.runs[0].result!.reason, scenario === 'repeat-read' ? 'tool_no_progress' : 'tool_failure_repeated');
    assert.equal(ledger.records.filter(record => record.event.type === 'tool_completed').length, 3);
    assert.match(result.error ?? '', /重复|进展/); assert.equal(ledger.recovery, null);
  } finally { await f.dispose(); }
});
