import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { RunIdentity } from '@cc-desk/agent-core';
import type { NativeWorkflowQualityState } from '@cc-desk/contracts/native-workflow-quality';
import { NativeRunStore } from '@cc-desk/agent-node/run-store';
import { NativeProjection } from '../src/main/engines/native/projection';
import { writeAgentReceipt } from '../src/main/engines/native/agent-artifacts';
import { ExecutionEvents } from '../src/main/execution/events';
import type { Session } from '../src/shared/types';

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'native-quality-projection-')));
  const parent: RunIdentity = { sessionId: randomUUID(), conversationId: randomUUID(), runId: randomUUID(), requestId: randomUUID(), workerGeneration: 1 };
  const store = await NativeRunStore.open({ rootDirectory: path.join(directory, 'native', 'conversations'), conversationId: parent.conversationId });
  const at = '2026-10-17T08:00:00.000Z';
  const session: Session = { id: parent.sessionId, projectId: 'project', title: 'parent', kind: 'agent', cwd: directory,
    execution: { providerId: 'native', mode: 'structured', conversationId: parent.conversationId }, started: true,
    engineConfig: { schemaVersion: 1, options: {} }, status: 'running', archived: false, createdAt: at, updatedAt: at };
  const projections: NativeProjection[] = [], errors: Error[] = [];
  const create = () => { const projection = new NativeProjection(directory, new ExecutionEvents(), () => session, () => false, (_id, error) => errors.push(error)); projections.push(projection); return projection; };
  const begin = (identity: RunIdentity) => store.beginRun({ identity, input: '实现后独立验证', inputDigest: identity.requestId,
    userItems: [{ role: 'user', content: '实现后独立验证' }], protocol: { id: 'openai-responses', version: 1 }, configuration: {}, policyRevision: 'policy' });
  const finish = (identity: RunIdentity) => store.append(identity, { type: 'run_finished', result: { identity, status: 'completed', reason: 'model_completed',
    modelRequests: 0, toolCalls: 0, usage: null, context: store.loadContext()!, committed: true } });
  const quality = (identity = parent): NativeWorkflowQualityState => ({ version: 1, parentIdentity: identity, taskId: randomUUID(), collaboration: 'auto',
    validationMode: 'commands', status: 'running', round: 1, maxRounds: 2,
    receiptPath: path.join(directory, 'native', 'workflow-quality', identity.conversationId, `${identity.runId}.json`),
    updatedAt: at, rounds: [], findings: [], automaticReview: 'pending', manualAcceptance: 'not_requested' });
  t.after(async () => { projections.forEach(value => value.flush()); await store.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { directory, parent, store, create, begin, finish, quality, errors };
}

test('live workflow quality is parent-bound, isolated from model completion and copied at the publication boundary', async t => {
  const f = await fixture(t); await f.begin(f.parent);
  const projection = f.create(); await projection.hydrate(f.parent.sessionId, f.store);
  const state = f.quality(); await writeAgentReceipt(state.receiptPath, state); projection.workflowQuality(f.parent.sessionId, state);
  state.status = 'passed';
  const snapshot = projection.snapshot(f.parent.sessionId);
  assert.equal(snapshot.nativeWorkflowQuality?.status, 'running');
  assert.equal(snapshot.nativeWorkflowQuality?.manualAcceptance, 'not_requested');
  snapshot.nativeWorkflowQuality!.status = 'passed';
  assert.equal(projection.snapshot(f.parent.sessionId).nativeWorkflowQuality?.status, 'running');
  for (const key of ['sessionId', 'conversationId', 'runId', 'requestId', 'workerGeneration'] as const) {
    const foreign = f.quality();
    Object.assign(foreign.parentIdentity = { ...foreign.parentIdentity }, { [key]: key === 'workerGeneration' ? 2 : randomUUID() });
    assert.throws(() => projection.workflowQuality(f.parent.sessionId, foreign), /当前父回合/);
  }
  assert.throws(() => projection.workflowQuality(f.parent.sessionId, { ...f.quality(), receiptPath: path.join(f.directory, 'foreign.json') }), /回执路径/);
  const latest = { ...f.quality(), updatedAt: '2026-10-17T08:01:00.000Z', status: 'blocked' as const, automaticReview: 'blocked' as const };
  await writeAgentReceipt(latest.receiptPath, latest); projection.workflowQuality(f.parent.sessionId, latest);
  projection.workflowQuality(f.parent.sessionId, f.quality());
  assert.equal(projection.snapshot(f.parent.sessionId).nativeWorkflowQuality?.status, 'blocked');
  await f.finish(f.parent); await projection.hydrate(f.parent.sessionId, f.store);
  assert.equal(projection.snapshot(f.parent.sessionId).taskState, 'completed');
  assert.equal(projection.snapshot(f.parent.sessionId).nativeWorkflowQuality?.automaticReview, 'blocked', 'model completion cannot manufacture quality approval');
  assert.deepEqual(f.errors, []);
});

test('restart restores only the exact current parent quality receipt and never lends an old verdict to a new run', async t => {
  const f = await fixture(t); await f.begin(f.parent);
  const state = { ...f.quality(), status: 'blocked' as const, automaticReview: 'blocked' as const };
  await writeAgentReceipt(state.receiptPath, state); await f.finish(f.parent);
  const restarted = f.create(); await restarted.hydrate(f.parent.sessionId, f.store);
  assert.deepEqual(restarted.snapshot(f.parent.sessionId).nativeWorkflowQuality, state);
  const next = { ...f.parent, runId: randomUUID(), requestId: randomUUID(), workerGeneration: 2 };
  await f.begin(next); await restarted.hydrate(next.sessionId, f.store);
  assert.equal(restarted.snapshot(next.sessionId).nativeWorkflowQuality, undefined);
  assert.throws(() => restarted.workflowQuality(next.sessionId, state), /当前父回合/);
  const fresh = f.create(); await fresh.hydrate(next.sessionId, f.store);
  assert.equal(fresh.snapshot(next.sessionId).nativeWorkflowQuality, undefined);
  assert.deepEqual(f.errors, []);
});

test('cold running quality receipts remain historical evidence without claiming a live review process', async t => {
  const f = await fixture(t); await f.begin(f.parent);
  const state = f.quality(); await writeAgentReceipt(state.receiptPath, state);
  const restarted = f.create(); await restarted.hydrate(f.parent.sessionId, f.store);
  const restored = restarted.snapshot(f.parent.sessionId).nativeWorkflowQuality;
  assert.equal(restored?.status, 'unknown'); assert.equal(restored?.automaticReview, 'unknown');
  assert.deepEqual(restored?.parentIdentity, f.parent); assert.equal(restored?.manualAcceptance, 'not_requested');
  const persisted = JSON.parse(await fs.readFile(state.receiptPath, 'utf8')) as NativeWorkflowQualityState;
  assert.equal(persisted.status, 'running', 'read-only restoration never rewrites durable quality evidence');
  assert.deepEqual(f.errors, []);
});

test('display-only cached metadata cannot manufacture a runtime policy or automatic quality approval', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.directory, 'chat'), { recursive: true });
  await fs.writeFile(path.join(f.directory, 'chat', `${f.parent.sessionId}.json`), JSON.stringify({ sessionId: f.parent.sessionId,
    taskState: 'completed', messages: [{ id: 'preserved', turnId: 'old', role: 'assistant', text: '仅保留展示历史', createdAt: '2026-10-17T08:00:00.000Z' }], pending: [],
    nativeAgentRuntime: { parentRunId: f.parent.runId, maxSubagents: 30, policySource: 'defaults', total: 0, active: 0, running: 0, prepared: 0, completed: 0, failed: 0, cancelled: 0, unknown: 0 },
    nativeWorkflowQuality: { ...f.quality(), status: 'passed', automaticReview: 'passed' } }));
  const projection = f.create(); await projection.hydrate(f.parent.sessionId, f.store);
  const snapshot = projection.snapshot(f.parent.sessionId);
  assert.equal(snapshot.sourceIncomplete, true); assert.equal(snapshot.messages[0].text, '仅保留展示历史');
  assert.equal(snapshot.nativeAgentRuntime, undefined); assert.equal(snapshot.nativeWorkflowQuality, undefined);
  assert.deepEqual(f.errors, []);
});

test('a newer persisted host quality callback survives a rebuild that already read an older quality receipt', async t => {
  const f = await fixture(t); await f.begin(f.parent);
  const old = f.quality(); await writeAgentReceipt(old.receiptPath, old);
  const projection = f.create(); await projection.hydrate(f.parent.sessionId, f.store);
  await f.finish(f.parent);
  let read!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { read = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const readFile = fs.readFile;
  t.mock.method(fs, 'readFile', async (...args: Parameters<typeof fs.readFile>) => {
    const value = await readFile(...args);
    if (args[0] === old.receiptPath) { read(); await held; }
    return value;
  });
  const rebuilding = projection.hydrate(f.parent.sessionId, f.store);
  try {
    await started;
    const latest = { ...old, updatedAt: '2026-10-17T08:01:00.000Z', status: 'blocked' as const, automaticReview: 'blocked' as const };
    await writeAgentReceipt(latest.receiptPath, latest); projection.workflowQuality(f.parent.sessionId, latest);
    release(); await rebuilding;
    assert.equal(projection.snapshot(f.parent.sessionId).nativeWorkflowQuality?.updatedAt, latest.updatedAt);
    assert.equal(projection.snapshot(f.parent.sessionId).nativeWorkflowQuality?.automaticReview, 'blocked');
    assert.deepEqual(f.errors, []);
  } finally { release(); await rebuilding; }
});
