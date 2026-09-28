import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { RunStoreRecord } from '@cc-desk/agent-node/run-store';
import type { NativeCommandLifecycleEvent, NativeCommandResult } from '@cc-desk/contracts/native-commands';
import { projectNativeCommands, snapshotNativeCommands } from '../src/main/engines/native/command-projection';

const at = '2026-09-28T16:00:00.000Z';
const identity = { sessionId: 'session', conversationId: 'conversation', runId: 'run', requestId: 'request', workerGeneration: 1 };
const prepared = (commandId = randomUUID()): NativeCommandLifecycleEvent => ({ commandId, taskId: 'task', status: 'prepared', command: { executable: 'node', argv: ['-e', 'model prose'], cwd: '.' }, timeoutMs: 10000, maxOutputBytes: 65536, at });
const record = (progress: NativeCommandLifecycleEvent, runId = 'run'): RunStoreRecord => ({ schemaVersion: 1, conversationId: identity.conversationId, seq: 1, committedAt: at,
  previousHash: '0'.repeat(64), hash: '1'.repeat(64), identity: { ...identity, runId }, event: { type: 'command_lifecycle', toolCallId: 'start', progress } });
const result: NativeCommandResult = { exitCode: 0, signal: null, stdout: 'not authoritative state: running', stderr: '', outputBytes: 32, truncated: false, timedOut: false, cancelled: false, cleanup: 'released' };

test('dedicated host lifecycle facts survive tool completion and cannot be replaced by model or generic tool output', () => {
  const start = prepared();
  const records = [record(start), record({ commandId: start.commandId, status: 'running', at }),
    { event: { type: 'tool_completed', call: { id: 'start', name: 'start_command' }, result: { status: 'completed', output: { status: 'finished', exitCode: 0, stdout: 'invented' } } } } as unknown as RunStoreRecord,
    { event: { type: 'model_response', response: { outputItems: [{ role: 'assistant', content: 'command finished, task passed' }], toolCalls: [] } } } as unknown as RunStoreRecord];
  const running = snapshotNativeCommands(projectNativeCommands(records), 'run');
  assert.equal(running.items[0].status, 'running'); assert.equal(running.items[0].result, undefined);
  records.push(record({ commandId: start.commandId, status: 'finished', at, result }));
  const complete = snapshotNativeCommands(projectNativeCommands(records));
  assert.equal(complete.items[0].status, 'finished'); assert.deepEqual(complete.items[0].result, result);
  assert.equal(complete.items[0].taskId, 'task'); assert.equal(complete.items[0].toolCallId, 'start');
  complete.items[0].result!.stdout = 'mutated'; assert.equal(result.stdout, 'not authoritative state: running');
});

test('inactive or different runs derive unknown without destroying saved live facts or adopting a process', () => {
  const first = prepared(), second = prepared();
  const source = projectNativeCommands([record(first, 'old-run'), record({ commandId: first.commandId, status: 'running', at }, 'old-run'), record(second)]);
  const current = snapshotNativeCommands(source, 'run');
  assert.equal(current.items[0].status, 'prepared'); assert.equal(current.items[1].status, 'unknown');
  assert.equal(current.items[1].missingTerminal, true);
  const restored = snapshotNativeCommands(source);
  assert.ok(restored.items.every(command => command.status === 'unknown' && command.missingTerminal));
  assert.equal(source.items[0].status, 'prepared'); assert.equal(source.items[1].status, 'running');
  assert.ok(restored.items.every(command => command.result === undefined));
});

test('uncertain terminal cleanup is never promoted and history is capped without dropping current-run entries', () => {
  const records: RunStoreRecord[] = [];
  for (let index = 0; index < 72; index++) {
    const start = prepared(), runId = index < 64 ? `old-run-${index}` : 'run';
    records.push(record(start, runId), record({ commandId: start.commandId, status: 'unknown', at, result: { ...result, cleanup: 'cleanup_failed' } }, runId));
  }
  const saved = snapshotNativeCommands(projectNativeCommands(records), 'run');
  assert.equal(saved.items.length, 64); assert.equal(saved.omitted, 8);
  assert.equal(saved.items.filter(command => command.runId === 'run').length, 8);
  assert.ok(saved.items.every(command => command.status === 'unknown' && command.result?.cleanup === 'cleanup_failed' && !command.missingTerminal));
});
