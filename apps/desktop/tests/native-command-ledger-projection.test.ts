import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BeginRunRequest, PreparedTool, ToolCall } from '@cc-desk/agent-core';
import { NativeRunStore } from '@cc-desk/agent-node/run-store';
import type { NativeCommandResult } from '@cc-desk/contracts/native-commands';
import { NativeProjection } from '../src/main/engines/native/projection';
import { ExecutionEvents } from '../src/main/execution/events';
import type { Session } from '../src/shared/types';

const at = '2026-09-28T16:00:00.000Z';
async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-command-projection-'));
  const id = randomUUID(), conversationId = randomUUID(), commandId = randomUUID();
  const rootDirectory = path.join(directory, 'native');
  let store = await NativeRunStore.open({ rootDirectory, conversationId }), active = true;
  const session: Session = { id, projectId: 'project', title: 'Native', kind: 'agent', cwd: directory, execution: { providerId: 'native', mode: 'structured', conversationId },
    started: true, engineConfig: { schemaVersion: 1, options: {} }, status: 'running', archived: false, createdAt: at, updatedAt: at };
  const events = new ExecutionEvents(), errors: Error[] = [];
  const create = () => new NativeProjection(directory, events, () => session, () => active, (_id, error) => errors.push(error));
  let projection = create();
  const req: BeginRunRequest = { identity: { sessionId: id, conversationId, runId: randomUUID(), requestId: randomUUID(), workerGeneration: 1 }, input: 'test command records',
    inputDigest: 'input-digest', userItems: [{ role: 'user', content: 'test command records' }], protocol: { id: 'openai-responses', version: 1 }, configuration: { nativeTaskId: 'task-1' }, policyRevision: 'policy' };
  const command = { executable: 'node', argv: ['fixture.cjs'], cwd: '.' }, input = { ...command, timeoutMs: 10000, maxOutputBytes: 65536 };
  const call: ToolCall = { id: 'start-call', name: 'start_command', arguments: JSON.stringify(input) };
  const prepared: PreparedTool = { call, definition: { name: call.name, description: '', risk: 'command', inputSchema: {} }, input, inputDigest: 'command-digest', policyRevision: 'policy', requiresApproval: true, preconditions: {} };
  await store.beginRun(req);
  await store.append(req.identity, { type: 'model_response', response: { outputItems: [], toolCalls: [call], finishReason: 'tool_calls', usage: null } });
  await store.append(req.identity, { type: 'tool_prepared', prepared, approval: { decision: 'approved', expiresAt: Date.now() + 100000,
    binding: { ...req.identity, toolCallId: call.id, inputDigest: prepared.inputDigest, policyRevision: 'policy' } } });
  await store.recordCommandEvent(req.identity, call, { commandId, taskId: 'task-1', status: 'prepared', command, timeoutMs: 10000, maxOutputBytes: 65536, at });
  return { id, req, commandId, call, errors, get store() { return store; }, get projection() { return projection; },
    async snapshot() { await projection.hydrate(id, store); return projection.snapshot(id); },
    async running() {
      await store.recordCommandEvent(req.identity, call, { commandId, status: 'running', at });
      await store.append(req.identity, { type: 'tool_completed', call, result: { status: 'completed', output: { commandId, state: 'running' } }, resultItems: [{ type: 'function_call_output', call_id: call.id, output: 'start acknowledged' }] });
    },
    setActive(value: boolean) { active = value; },
    async reopen() { active = false; projection.flush(); await store.close(); store = await NativeRunStore.open({ rootDirectory, conversationId }); projection = create(); },
    async dispose() { projection.flush(); await store.close(); await fs.rm(directory, { recursive: true, force: true }); },
  };
}
const result: NativeCommandResult = { exitCode: 0, signal: null, stdout: 'historical output', stderr: 'separate stderr', outputBytes: 32, truncated: false, timedOut: false, cancelled: false, cleanup: 'released' };

test('real ledger projection distinguishes successful startup from final command facts and preserves terminal receipt on reopen', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.snapshot()).nativeCommands!.items[0].status, 'prepared');
    await f.running();
    const running = (await f.snapshot()).nativeCommands!.items[0];
    assert.equal(running.status, 'running'); assert.equal(running.result, undefined);
    assert.equal(running.toolCallId, f.call.id); assert.equal(running.taskId, 'task-1');
    // Even without a new ledger record, loss of host ownership removes a live-looking state.
    f.setActive(false); assert.equal(f.projection.snapshot(f.id).nativeCommands!.items[0].status, 'unknown');
    f.setActive(true); assert.equal(f.projection.snapshot(f.id).nativeCommands!.items[0].status, 'running');
    await f.store.recordCommandEvent(f.req.identity, f.call, { commandId: f.commandId, status: 'finished', at, result });
    await f.store.append(f.req.identity, { type: 'run_finished', result: { identity: f.req.identity, status: 'completed', reason: 'model_completed', modelRequests: 1, toolCalls: 1, usage: {}, context: f.store.loadContext()!, committed: true } });
    const saved = (await f.snapshot()).nativeCommands;
    assert.deepEqual(saved!.items[0].result, result); assert.equal(saved!.items[0].status, 'finished');
    await f.reopen(); assert.deepEqual((await f.snapshot()).nativeCommands, saved); assert.deepEqual(f.errors, []);
  } finally { await f.dispose(); }
});

test('reopening an acknowledged but unclosed command derives unknown without fabricating final output or a PID', async () => {
  const f = await fixture();
  try {
    await f.running(); await f.snapshot();
    await f.reopen(); const restored = (await f.snapshot()).nativeCommands!.items[0];
    assert.equal(restored.status, 'unknown'); assert.equal(restored.missingTerminal, true);
    assert.equal(restored.commandId, f.commandId); assert.equal(restored.result, undefined);
    assert.equal(Object.hasOwn(restored, 'pid'), false); assert.equal(f.store.getRecoveryReport()?.classification, 'unknown_effects');
    const recovered = f.store.replay().filter(record => record.event.type === 'command_lifecycle');
    assert.equal(recovered.length, 2, 'read projection never appends a synthetic process fact'); assert.deepEqual(f.errors, []);
  } finally { await f.dispose(); }
});
