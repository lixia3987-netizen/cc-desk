import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NativeRunStore } from '../dist/run-store.js';
import { isNativeCommandLifecycleEvent } from '@cc-desk/contracts/native-commands';

const at = '2026-09-28T18:00:00.000Z';
const result = overrides => ({ exitCode: 0, signal: null, stdout: 'ok', stderr: '', outputBytes: 2, truncated: false, timedOut: false, cancelled: false, cleanup: 'released', ...overrides });
async function fixture(t, options = {}) {
  const rootDirectory = await mkdtemp(path.join(tmpdir(), 'native-command-ledger-')), conversationId = randomUUID();
  let store = await NativeRunStore.open({ rootDirectory, conversationId, ...options });
  const identity = { sessionId: 'session', conversationId, runId: randomUUID(), requestId: randomUUID(), workerGeneration: 1 };
  const taskId = randomUUID(), commandId = randomUUID();
  const input = { executable: 'node', argv: ['test.mjs'], cwd: '.', timeoutMs: 120_000, maxOutputBytes: 65536 };
  const call = { id: 'start', name: 'start_command', arguments: JSON.stringify(input) };
  const prepared = { call, definition: { name: call.name, description: 'Start', inputSchema: {}, risk: 'command' }, input, inputDigest: 'digest', policyRevision: 'policy', requiresApproval: true, preconditions: {} };
  const approval = { binding: { ...identity, toolCallId: call.id, inputDigest: 'digest', policyRevision: 'policy' }, decision: 'approved', expiresAt: Date.now() + 60000 };
  const intent = { commandId, status: 'prepared', taskId, command: { executable: input.executable, argv: input.argv, cwd: '.' }, timeoutMs: 120_000, maxOutputBytes: 65536, at };
  await store.beginRun({ identity, input: 'Run command', inputDigest: 'input', userItems: [{ role: 'user', content: 'Run command' }], protocol: { id: 'openai-responses', version: 1 }, configuration: { nativeTaskId: taskId }, policyRevision: 'policy' });
  const model = async calls => store.append(identity, { type: 'model_response', response: { outputItems: calls.map(item => ({ type: 'function_call', call_id: item.id, name: item.name, arguments: item.arguments })), toolCalls: calls, finishReason: calls.length ? 'tool_calls' : 'completed', usage: null } });
  await model([call]);
  t.after(async () => { await store.close().catch(() => {}); await rm(rootDirectory, { recursive: true, force: true }); });
  return { get store() { return store; }, identity, call, prepared, approval, intent, model,
    prepare: () => store.append(identity, { type: 'tool_prepared', prepared, approval }),
    record: progress => store.recordCommandEvent(identity, call, progress),
    running: () => store.recordCommandEvent(identity, call, { commandId, status: 'running', at }),
    terminal: (status = 'finished', overrides) => store.recordCommandEvent(identity, call, { commandId, status, at, result: result(overrides) }),
    complete: (output = { commandId, status: 'running' }, status = 'completed') => store.append(identity, { type: 'tool_completed', call, result: { status, output }, resultItems: [{ type: 'function_call_output', call_id: call.id, output: JSON.stringify(output) }] }),
    finish: (status = 'completed') => store.append(identity, { type: 'run_finished', result: { identity, status, reason: status, modelRequests: 1, toolCalls: 1, usage: null, context: store.loadContext(), committed: true } }),
    reopen: async () => { await store.close(); store = await NativeRunStore.open({ rootDirectory, conversationId }); },
  };
}

test('only the host can bind a command intent to its exact approved start and task', async t => {
  const f = await fixture(t);
  await assert.rejects(f.record(f.intent), { code: 'not_prepared' });
  await f.prepare();
  await assert.rejects(f.store.append(f.identity, { type: 'command_lifecycle', toolCallId: f.call.id, progress: f.intent }), { code: 'invalid_record' });
  await assert.rejects(f.store.recordCommandEvent({ ...f.identity, workerGeneration: 2 }, f.call, f.intent), { code: 'stale_owner' });
  await assert.rejects(f.store.recordCommandEvent(f.identity, { ...f.call, arguments: '{}' }, f.intent), { code: 'payload_mismatch' });
  for (const override of [{ taskId: 'other' }, { command: { ...f.intent.command, argv: ['different'] } }, { timeoutMs: 120001 }]) await assert.rejects(f.record({ ...f.intent, ...override }), { code: 'payload_mismatch' });
  await f.record(f.intent);
  await assert.rejects(f.record(f.intent), { code: 'command_already_prepared' });
  await assert.rejects(f.complete({ commandId: f.intent.commandId }), { code: 'not_prepared' });
  await f.running();
  await assert.rejects(f.complete({ commandId: randomUUID() }), { code: 'payload_mismatch' });
});

test('start acknowledgment permits model progress but run completion waits for the command receipt', async t => {
  const f = await fixture(t); await f.prepare(); await f.record(f.intent); await f.running(); await f.complete();
  await f.model([]);
  await assert.rejects(f.finish(), { code: 'recovery_required' });
  await f.terminal('finished', { stdout: 'durable output', outputBytes: 14 });
  await f.finish(); await f.reopen();
  assert.equal(f.store.recoveryRequired, false);
  const state = f.store.getToolState(f.identity.runId, f.call.id);
  assert.equal(state.completed.result.output.status, 'running', 'the original start acknowledgment remains immutable');
  assert.equal(state.commandProgress.at(-1).result.stdout, 'durable output');
  assert.equal(f.store.replay().filter(record => record.event.type === 'command_lifecycle').length, 3);
});

test('a cancelled preparation may finish without pretending a process reached running', async t => {
  const f = await fixture(t); await f.prepare(); await f.record(f.intent);
  await f.terminal('finished', { exitCode: null, stdout: '', outputBytes: 0, cancelled: true, error: 'cancelled_before_spawn' });
  await f.complete({ commandId: f.intent.commandId, status: 'finished' }, 'not_executed'); await f.finish('cancelled');
  assert.deepEqual(f.store.getToolState(f.identity.runId, f.call.id).commandProgress.map(item => item.status), ['prepared', 'finished']);
});

for (const acknowledged of [false, true]) test(`restart preserves unfinished command facts and blocks safe recovery, acknowledged=${acknowledged}`, async t => {
  const f = await fixture(t); await f.prepare(); await f.record(f.intent);
  if (acknowledged) { await f.running(); await f.complete(); }
  await f.reopen();
  const report = f.store.getRecoveryReport(); assert.equal(report.classification, 'unknown_effects'); assert.equal(report.tools[0].status, 'unknown');
  const tool = f.store.getToolState(f.identity.runId, f.call.id);
  assert.equal(tool.commandProgress.at(-1).status, acknowledged ? 'running' : 'prepared');
  assert.equal(!!tool.completed, acknowledged);
  await assert.rejects(f.store.resolveRecovery({ runId: f.identity.runId, expectedHash: report.expectedHash, resourcesVerified: true }), { code: 'unknown_effects' });
  await assert.rejects(f.terminal(), { code: 'run_not_active' });
});

test('unknown cleanup remains unknown even if a later cleanup retry could release physical resources', async t => {
  const f = await fixture(t); await f.prepare(); await f.record(f.intent); await f.running(); await f.complete();
  await f.terminal('unknown', { cleanup: 'cleanup_failed', error: 'cleanup_failed' });
  await assert.rejects(f.terminal(), { code: 'invalid_record' });
  await assert.rejects(f.finish(), { code: 'recovery_required' });
  await f.finish('recovery_required'); await f.reopen();
  assert.equal(f.store.getRecoveryReport().classification, 'unknown_effects');
});

for (const point of ['before_append', 'after_sync']) test(`terminal persistence fault at ${point} retains only committed facts`, async t => {
  let receipts = 0;
  const f = await fixture(t, { fault: (actual, type) => { if (type === 'command_lifecycle' && actual === point && ++receipts === 3) throw new Error('receipt failure'); } });
  await f.prepare(); await f.record(f.intent); await f.running(); await f.complete();
  await assert.rejects(f.terminal(), /receipt failure/);
  await assert.rejects(f.model([]), { code: 'recovery_required' });
  await f.reopen();
  assert.equal(f.store.getToolState(f.identity.runId, f.call.id).commandProgress.at(-1).status, point === 'after_sync' ? 'finished' : 'running');
  assert.equal(f.store.getRecoveryReport().classification, point === 'after_sync' ? 'safe_to_continue' : 'unknown_effects');
});

test('record count reserves the start acknowledgment, lifecycle and final run before spawn', async t => {
  const f = await fixture(t, { limits: { maxRecords: 8 } }); await f.prepare();
  await assert.rejects(f.record(f.intent), { code: 'limit_exceeded' });
  assert.equal(f.store.getToolState(f.identity.runId, f.call.id).commandProgress, undefined);
});

test('unrelated model output cannot consume the last command receipt and run slots', async t => {
  const f = await fixture(t, { limits: { maxRecords: 9 } }); await f.prepare(); await f.record(f.intent); await f.running(); await f.complete();
  await assert.rejects(f.model([]), { code: 'limit_exceeded' });
  await f.terminal(); await f.finish(); assert.equal(f.store.usage.records, 9);
});

test('worst-case escaped bounded logs retain their byte reservation across later output', async t => {
  const f = await fixture(t, { limits: { maxRecordBytes: 512 * 1024, maxJournalBytes: 2 * 1024 * 1024 } });
  await f.prepare(); await f.record(f.intent); await f.running(); await f.complete();
  const output = 'x'.repeat(400000);
  for (;;) {
    try { await f.store.append(f.identity, { type: 'model_response', response: { outputItems: [{ role: 'assistant', content: output }], toolCalls: [], finishReason: 'completed', usage: null } }); }
    catch (error) { assert.equal(error.code, 'limit_exceeded'); break; }
  }
  await f.terminal('finished', { stdout: '\u0001'.repeat(65536), outputBytes: 65536, error: '\u0002'.repeat(2048) });
  assert.equal(f.store.getToolState(f.identity.runId, f.call.id).commandProgress.at(-1).result.stdout.length, 65536);
});

test('strict lifecycle validator rejects oversized or malformed logs and process identifiers', async () => {
  const terminal = { commandId: randomUUID(), status: 'finished', at, result: result({ stdout: '🙂'.repeat(16384), outputBytes: 65536 }) };
  assert.equal(isNativeCommandLifecycleEvent(terminal), true);
  for (const change of [{ pid: 123 }, { at: 'yesterday' }, { commandId: '123' }, { result: result({ stdout: '🙂'.repeat(16385) }) }, { result: result({ stdout: '\ud800' }) }, { result: result({ error: 'x'.repeat(2049) }) }, { result: result({ signal: 'bad signal' }) }, { result: result({ cleanup: 'cleanup_failed' }) }]) assert.equal(isNativeCommandLifecycleEvent({ ...terminal, ...change }), false);
});

test('a run has at most eight command handles and no start may reuse an earlier identity', async t => {
  const f = await fixture(t); await f.prepare(); await f.record(f.intent); await f.terminal(); await f.complete();
  for (let index = 1; index <= 8; index++) {
    const call = { ...f.call, id: `start-${index}` };
    await f.model([call]);
    const prepared = { ...f.prepared, call }, approval = { ...f.approval, binding: { ...f.approval.binding, toolCallId: call.id } };
    await f.store.append(f.identity, { type: 'tool_prepared', prepared, approval });
    await assert.rejects(f.store.recordCommandEvent(f.identity, call, f.intent), { code: 'payload_mismatch' });
    const commandId = randomUUID(), intent = { ...f.intent, commandId };
    if (index === 8) { await assert.rejects(f.store.recordCommandEvent(f.identity, call, intent), { code: 'limit_exceeded' }); break; }
    await f.store.recordCommandEvent(f.identity, call, intent);
    await f.store.recordCommandEvent(f.identity, call, { commandId, status: 'finished', at, result: result() });
    await f.store.append(f.identity, { type: 'tool_completed', call, result: { status: 'completed', output: { commandId } }, resultItems: [{ type: 'function_call_output', call_id: call.id, output: JSON.stringify({ commandId }) }] });
  }
  assert.equal(f.store.getRun(f.identity.runId).tools.filter(tool => tool.commandProgress?.length).length, 8);
});
