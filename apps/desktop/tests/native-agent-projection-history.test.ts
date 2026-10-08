import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { RunIdentity } from '@cc-desk/agent-core';
import { NativeRunStore } from '@cc-desk/agent-node/run-store';
import { NativeProjection } from '../src/main/engines/native/projection';
import { nativeAgentReceiptDirectory } from '../src/main/engines/native/agent-projection';
import { writeAgentReceipt } from '../src/main/engines/native/agent-artifacts';
import type { NativeDelegationReceipt } from '../src/main/engines/native/agent-delegation';
import { ExecutionEvents } from '../src/main/execution/events';
import type { Session } from '../src/shared/types';
import { nativeAgentResultSchema, registerNativeAgentResultHandlers } from '../src/main/ipc/native-agent-result-handlers';

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'native-result-history-')));
  const parent: RunIdentity = { sessionId: randomUUID(), conversationId: randomUUID(), runId: randomUUID(), requestId: randomUUID(), workerGeneration: 1 };
  const store = await NativeRunStore.open({ rootDirectory: path.join(directory, 'native', 'conversations'), conversationId: parent.conversationId });
  const at = '2026-10-08T01:00:00.000Z';
  const session: Session = { id: parent.sessionId, projectId: 'project', title: 'parent', kind: 'agent', cwd: directory,
    execution: { providerId: 'native', mode: 'structured', conversationId: parent.conversationId }, started: true,
    engineConfig: { schemaVersion: 1, options: {} }, status: 'running', archived: false, createdAt: at, updatedAt: at };
  const projections: NativeProjection[] = [], errors: Error[] = [];
  const create = () => { const projection = new NativeProjection(directory, new ExecutionEvents(), () => session, () => true, (_id, error) => errors.push(error)); projections.push(projection); return projection; };
  const begin = async (identity: RunIdentity, delegated = false) => {
    await store.beginRun({ identity, input: 'review', inputDigest: identity.requestId, userItems: [{ role: 'user', content: 'review' }],
      protocol: { id: 'openai-responses', version: 1 }, configuration: {}, policyRevision: 'policy' });
    if (delegated) {
      const call = { id: randomUUID(), name: 'delegate_review', arguments: '{"tasks":[]}' };
      await store.append(identity, { type: 'model_response', response: { outputItems: [], toolCalls: [call], finishReason: 'tool_calls', usage: null } });
      await store.append(identity, { type: 'tool_completed', call, result: { status: 'not_executed', output: {} }, resultItems: [] });
    }
  };
  const finish = (identity: RunIdentity) => store.append(identity, { type: 'run_finished', result: { identity, status: 'completed', reason: 'model_completed',
    modelRequests: 1, toolCalls: 0, usage: null, context: store.loadContext()!, committed: true } });
  const child = (identity: RunIdentity): NativeDelegationReceipt => {
    const batchId = randomUUID(), childId = randomUUID();
    return { version: 1, batchId, childId, taskId: randomUUID(), identity: { ...identity, sessionId: randomUUID(), conversationId: randomUUID(), runId: randomUUID() },
      parentIdentity: identity, parentTaskId: randomUUID(), toolCallId: 'delegate', title: 'retained child', goal: 'inspect', mode: 'review',
      status: 'running', createdAt: at, updatedAt: at, cwd: directory,
      receiptPath: path.join(nativeAgentReceiptDirectory(directory, identity), batchId, childId, 'receipt.json') };
  };
  t.after(async () => { projections.forEach(value => value.flush()); await store.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { directory, parent, store, create, begin, finish, child, errors };
}

test('a new parent run retains ledger-owned collaboration after restart without reviving old running children', async t => {
  const f = await fixture(t); await f.begin(f.parent, true);
  const retained = f.child(f.parent); await writeAgentReceipt(retained.receiptPath, retained); await f.finish(f.parent);
  const next = { ...f.parent, runId: randomUUID(), requestId: randomUUID(), workerGeneration: 2 }; await f.begin(next);
  const projection = f.create(); await projection.hydrate(next.sessionId, f.store);
  const snapshot = projection.snapshot(next.sessionId);
  assert.equal(snapshot.nativeRun?.runId, next.runId);
  assert.equal(snapshot.nativeAgents?.parentRunId, f.parent.runId);
  assert.equal(snapshot.nativeAgents?.items[0].childId, retained.childId);
  assert.equal(snapshot.nativeAgents?.items[0].status, 'unknown');
  const restarted = f.create(); await restarted.hydrate(next.sessionId, f.store);
  assert.deepEqual(restarted.snapshot(next.sessionId).nativeAgents, snapshot.nativeAgents);
  const current = f.child(next); await writeAgentReceipt(current.receiptPath, current); restarted.nativeAgent(next.sessionId, current);
  assert.equal(restarted.snapshot(next.sessionId).nativeAgents?.parentRunId, next.runId);
  assert.equal(restarted.snapshot(next.sessionId).nativeAgents?.items[0].status, 'running');
  assert.deepEqual(f.errors, []);
});

test('corrupt current collaboration is not hidden by successful historical results', async t => {
  const f = await fixture(t); await f.begin(f.parent, true);
  const retained = f.child(f.parent); await writeAgentReceipt(retained.receiptPath, retained); await f.finish(f.parent);
  const next = { ...f.parent, runId: randomUUID(), requestId: randomUUID(), workerGeneration: 2 }; await f.begin(next);
  const current = f.child(next); await fs.mkdir(path.dirname(current.receiptPath), { recursive: true }); await fs.writeFile(current.receiptPath, '{}');
  const projection = f.create(); await projection.hydrate(next.sessionId, f.store);
  assert.equal(projection.snapshot(next.sessionId).nativeAgents?.parentRunId, next.runId);
  assert.equal(projection.snapshot(next.sessionId).nativeAgents?.incomplete, true);
});

test('result IPC accepts identities and bounded pages but rejects arbitrary file access before dispatch', () => {
  const input = { id: randomUUID(), parentRunId: randomUUID(), childId: randomUUID() };
  assert.deepEqual(nativeAgentResultSchema.parse(input), input);
  for (const patch of [{ path: 'C:/secret' }, { patchOffset: -1 }, { patchCharacters: 32001 }, { expectedPatchSha256: '../receipt' }, { childId: '../child' }])
    assert.equal(nativeAgentResultSchema.safeParse({ ...input, ...patch }).success, false);
  let registered = '';
  registerNativeAgentResultHandlers((name, schema, action) => { registered = name; assert.equal(schema, nativeAgentResultSchema); assert.equal(typeof action, 'function'); }, async () => { throw new Error('not dispatched'); });
  assert.equal(registered, 'native:agent-result');
});
