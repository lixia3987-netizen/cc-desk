import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BeginRunRequest, RunIdentity } from '@cc-desk/agent-core';
import { NativeRunStore } from '@cc-desk/agent-node/run-store';
import { NativeProjection } from '../src/main/engines/native/projection';
import { loadNativeAgents, nativeAgentReceiptDirectory, NativeAgentProjection } from '../src/main/engines/native/agent-projection';
import { writeAgentReceipt } from '../src/main/engines/native/agent-artifacts';
import type { NativeDelegationReceipt } from '../src/main/engines/native/agent-delegation';
import { ExecutionEvents } from '../src/main/execution/events';
import type { Session } from '../src/shared/types';

const newIdentity = (): RunIdentity => ({ sessionId: randomUUID(), conversationId: randomUUID(), runId: randomUUID(), requestId: randomUUID(), workerGeneration: 1 });
const at = '2026-10-08T01:00:00.000Z';
function receipt(directory: string, parent: RunIdentity, update: Partial<NativeDelegationReceipt> = {}): NativeDelegationReceipt {
  const childId = randomUUID(), batchId = randomUUID(), taskId = randomUUID(), identity = newIdentity();
  return { version: 1, batchId, childId, taskId, identity, parentIdentity: parent, parentTaskId: 'parent-task', toolCallId: 'delegate-call',
    title: '独立审阅', goal: '读取当前现场并分析', mode: 'review', status: 'running', createdAt: at, updatedAt: at,
    receiptPath: path.join(nativeAgentReceiptDirectory(directory, parent), batchId, childId, 'receipt.json'), cwd: directory, ...update };
}
const complete = (value: NativeDelegationReceipt): NativeDelegationReceipt => ({ ...value, status: 'completed', updatedAt: '2026-10-08T01:01:00.000Z',
  result: { identity: value.identity, taskId: value.taskId, status: 'completed', reason: 'model_completed', committed: true, summary: '审阅结束，需人工验收', modelRequests: 2, toolCalls: 1,
    evidence: { taskSnapshotPath: path.join(value.cwd, 'native', 'tasks', value.identity.conversationId, 'tasks.json'),
      runJournalPath: path.join(value.cwd, 'native', 'conversations', value.identity.conversationId, 'journal.jsonl'), commandReceipts: [] } } });
async function temporary(t: { after(fn: () => Promise<void>): void }) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-agent-projection-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true })); return directory;
}

test('only complete bound host receipts create child state, stable identities and evidence paths', async t => {
  const directory = await temporary(t), parent = newIdentity(), child = complete(receipt(directory, parent));
  const projection = new NativeAgentProjection(parent, nativeAgentReceiptDirectory(directory, parent));
  projection.record(child);
  const saved = projection.snapshot();
  assert.equal(saved.items[0].status, 'completed'); assert.equal(saved.items[0].taskId, child.taskId);
  assert.equal(saved.items[0].identity.runId, child.identity.runId); assert.equal(saved.items[0].evidence!.runJournalPath, child.result!.evidence!.runJournalPath);
  assert.throws(() => projection.record({ ...child, parentIdentity: { ...parent, requestId: randomUUID() } }), /identity mismatch/);
  assert.throws(() => projection.record({ ...child, receiptPath: path.join(directory, 'outside.json') }), /escaped/);
  assert.throws(() => projection.record({ ...child, result: { ...child.result!, evidence: { runJournalPath: path.join(directory, 'outside.json') } } }), /evidence path/);
  assert.throws(() => projection.record({ ...child, taskId: randomUUID() }), /identity mismatch/);
  saved.items[0].title = 'cannot mutate'; projection.receipts()[0].title = 'cannot mutate';
  assert.equal(projection.snapshot().items[0].title, child.title); assert.equal(projection.receipts()[0].title, child.title);
});

test('legal long and Unicode request IDs remain identity-bound without entering storage paths', async t => {
  const directory = await temporary(t), parent = { ...newIdentity(), requestId: `workflow:${randomUUID()}:阶段:${'x'.repeat(150)}` };
  const child = receipt(directory, parent); child.identity.requestId = '独立审阅请求：α/模型?';
  const projection = new NativeAgentProjection(parent, nativeAgentReceiptDirectory(directory, parent));
  projection.record(complete(child)); assert.equal(projection.snapshot().items[0].identity.requestId, child.identity.requestId);
  await writeAgentReceipt(child.receiptPath, complete(child));
  assert.equal((await loadNativeAgents(directory, parent)).receipts()[0].parentIdentity.requestId, parent.requestId);
  assert.ok(!child.receiptPath.includes('阶段'));
  assert.throws(() => nativeAgentReceiptDirectory(directory, { ...parent, conversationId: '..' }));
  assert.throws(() => nativeAgentReceiptDirectory(directory, { ...parent, runId: 'parent/run' }));
  assert.throws(() => nativeAgentReceiptDirectory(directory, { ...parent, requestId: 'request\0invalid' }));
});

test('at most four visible children preserve active work and retain sixteen complete recovery records', async t => {
  const directory = await temporary(t), parent = newIdentity(), projection = new NativeAgentProjection(parent, nativeAgentReceiptDirectory(directory, parent));
  const active = receipt(directory, parent); projection.record(active);
  for (let index = 1; index < 16; index++) {
    const child = complete(receipt(directory, parent, { createdAt: `2026-10-08T01:00:${String(index).padStart(2, '0')}.000Z` })); projection.record(child);
  }
  const snapshot = projection.snapshot(true);
  assert.equal(snapshot.items.length, 4); assert.equal(snapshot.omitted, 12); assert.equal(snapshot.items[0].childId, active.childId);
  assert.equal(projection.receipts().length, 16);
  projection.record(complete(receipt(directory, parent))); assert.equal(projection.receipts().length, 16); assert.equal(projection.snapshot().incomplete, true);
});

test('inactive host ownership and uncommitted completed claims derive unknown without changing durable facts', async t => {
  const directory = await temporary(t), parent = newIdentity(), projection = new NativeAgentProjection(parent, nativeAgentReceiptDirectory(directory, parent));
  const child = receipt(directory, parent); projection.record(child);
  assert.equal(projection.snapshot(true).items[0].status, 'running'); assert.equal(projection.snapshot().items[0].status, 'unknown');
  assert.equal(projection.snapshot().items[0].missingTerminal, true); assert.equal(projection.receipts()[0].status, 'running');
  const incomplete = complete(child); incomplete.result!.committed = false; projection.record(incomplete);
  assert.equal(projection.snapshot(true).items[0].status, 'unknown'); assert.equal(projection.snapshot(true).items[0].missingTerminal, true);
  const recovery = complete(child); recovery.status = 'failed'; recovery.result!.status = 'recovery_required'; projection.record(recovery);
  assert.equal(projection.snapshot(true).items[0].status, 'unknown', 'a legacy ordinary failure cannot hide a child recovery barrier');
});

test('recovery reads only current parent run and refuses forged references or directory symlinks', async t => {
  const directory = await temporary(t), parent = newIdentity(), child = complete(receipt(directory, parent));
  await writeAgentReceipt(child.receiptPath, child);
  const other = receipt(directory, newIdentity()); await writeAgentReceipt(other.receiptPath, other);
  const loaded = await loadNativeAgents(directory, parent);
  assert.deepEqual(loaded.receipts(), [child]); assert.equal(loaded.snapshot().items[0].status, 'completed');
  const unsafe = receipt(directory, parent, { receiptPath: path.join(directory, 'forged.json') });
  const unsafePath = path.join(nativeAgentReceiptDirectory(directory, parent), unsafe.batchId, unsafe.childId, 'receipt.json');
  await writeAgentReceipt(unsafePath, unsafe);
  const external = path.join(directory, 'external'); await fs.mkdir(external);
  await fs.symlink(external, path.join(nativeAgentReceiptDirectory(directory, parent), randomUUID()), process.platform === 'win32' ? 'junction' : 'dir');
  const restored = await loadNativeAgents(directory, parent);
  assert.deepEqual(restored.receipts(), [child]); assert.equal(restored.snapshot().incomplete, true);
});

test('real parent ledger callbacks, terminal ownership and restart preserve child receipts without trusting model output', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-agent-projection-')), parent = newIdentity(), errors: Error[] = [], events = new ExecutionEvents();
  const session: Session = { id: parent.sessionId, projectId: 'project', title: '父 Agent', kind: 'agent', cwd: directory,
    execution: { providerId: 'native', mode: 'structured', conversationId: parent.conversationId }, started: true, engineConfig: { schemaVersion: 1, options: {} },
    status: 'running', archived: false, createdAt: at, updatedAt: at };
  let active = true;
  const create = () => new NativeProjection(directory, events, () => session, () => active, (_id, error) => errors.push(error));
  const store = await NativeRunStore.open({ rootDirectory: path.join(directory, 'native', 'conversations'), conversationId: parent.conversationId });
  t.after(async () => { await store.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const request: BeginRunRequest = { identity: parent, input: '委派只读审阅', inputDigest: 'digest', userItems: [{ role: 'user', content: '委派只读审阅' }],
    protocol: { id: 'openai-responses', version: 1 }, configuration: {}, policyRevision: 'policy' };
  await store.beginRun(request);
  const projection = create(); await projection.hydrate(parent.sessionId, store);
  const child = receipt(directory, parent); await writeAgentReceipt(child.receiptPath, child); projection.nativeAgent(parent.sessionId, child);
  assert.equal(projection.snapshot(parent.sessionId).nativeAgents!.items[0].status, 'running');
  projection.state(parent.sessionId, 'error'); assert.equal(projection.snapshot(parent.sessionId).nativeAgents!.items[0].status, 'unknown');
  const terminal = complete(child); await writeAgentReceipt(child.receiptPath, terminal); projection.nativeAgent(parent.sessionId, terminal);
  assert.equal(projection.snapshot(parent.sessionId).nativeAgents!.items[0].status, 'completed');
  await store.append(parent, { type: 'model_response', response: { outputItems: [{ role: 'assistant', content: 'All children and task passed' }], toolCalls: [], finishReason: 'completed', usage: null } });
  await store.append(parent, { type: 'run_finished', result: { identity: parent, status: 'completed', reason: 'model_completed', modelRequests: 1, toolCalls: 0, usage: {}, context: store.loadContext()!, committed: true } });
  await projection.hydrate(parent.sessionId, store);
  assert.equal(projection.snapshot(parent.sessionId).nativeAgents!.items.length, 1);
  active = false; const restored = create(); await restored.hydrate(parent.sessionId, store);
  assert.equal(restored.snapshot(parent.sessionId).nativeAgents!.items[0].status, 'completed');
  assert.equal(restored.snapshot(parent.sessionId).nativeAgents!.items[0].summary, terminal.result!.summary);
  assert.throws(() => restored.nativeAgent(parent.sessionId, { ...terminal, parentIdentity: { ...parent, runId: randomUUID() } }), /当前父回合/);
  projection.flush(); restored.flush(); assert.deepEqual(errors, []);
});

test('receipt merge keeps a newer callback while durable replay is loading older saved state', async t => {
  const directory = await temporary(t), parent = newIdentity(), child = receipt(directory, parent);
  const old = new NativeAgentProjection(parent, nativeAgentReceiptDirectory(directory, parent)), latest = new NativeAgentProjection(parent, nativeAgentReceiptDirectory(directory, parent));
  old.record(child); latest.record(complete(child)); old.merge(latest);
  assert.equal(old.snapshot().items[0].status, 'completed'); assert.equal(old.receipts()[0].result!.committed, true);
  latest.record({ ...child, updatedAt: at }); assert.equal(latest.snapshot().items[0].status, 'completed', 'old callbacks cannot regress a terminal state');
});
