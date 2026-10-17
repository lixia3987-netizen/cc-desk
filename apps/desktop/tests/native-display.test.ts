import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { NativeRunStore } from '@cc-desk/agent-node/run-store';
import { NativeStructuredExecutor } from '../src/main/engines/native/structured-executor';
import { NativeProjection } from '../src/main/engines/native/projection';
import { StateStore } from '../src/main/store';
import { ConnectionStore } from '../src/main/engines/native/connections';
import { ExecutionEvents } from '../src/main/execution/events';
import type { BeginRunRequest } from '@cc-desk/agent-core';

test('Native display remains readable under an execution writer lock while authoritative hydration still refuses it', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-display-'));
  const store = new StateStore(directory), connections = new ConnectionStore(directory), events = new ExecutionEvents();
  const id = randomUUID(), conversationId = randomUUID(), projectId = randomUUID();
  store.change(state => state.sessions.push({ id, projectId, title: 'display', kind: 'agent', cwd: path.join(directory, 'project-unavailable'),
    execution: { providerId: 'native', mode: 'structured', conversationId }, engineConfig: { schemaVersion: 1, options: {} }, started: true,
    archived: false, status: 'stopped', createdAt: '', updatedAt: '' }));
  const executor = new NativeStructuredExecutor(store, connections, events);
  const ledger = await NativeRunStore.open({ rootDirectory: path.join(directory, 'native', 'conversations'), conversationId });
  try {
    const journal = path.join(directory, 'chat', id + '.jsonl');
    const message = { id: 'visible', turnId: 'historical-run', role: 'user', text: '保留的展示记录', createdAt: '', submissionId: 'accepted' };
    await fs.writeFile(journal, JSON.stringify({ nativeSchemaVersion: 1, conversationId, nativeSeq: 1, type: 'message', message }) + '\n');
    const lock = path.join(ledger.directory, '.writer-lock'), before = await fs.readFile(lock, 'utf8');
    assert.deepEqual((await executor.readDisplay(id)).messages, [message]);
    assert.deepEqual((await executor.readDisplay(id)).messages, [message]);
    assert.equal(await fs.readFile(lock, 'utf8'), before);
    await assert.rejects(executor.hydrate(id), /live writer|already has/);
    assert.equal(await fs.readFile(lock, 'utf8'), before, 'display never releases or assumes execution ownership');
    assert.equal((await executor.readDisplay(id)).messages[0].text, message.text);
  } finally { await ledger.close(); await executor.shutdown(); store.flush(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('authoritative Native projection binds cold display pages to the current conversation and same-head reads do not replay', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-display-binding-'));
  const id = randomUUID(), conversationId = randomUUID();
  const session = { id, projectId: 'project', title: 'display', kind: 'agent' as const, cwd: directory,
    execution: { providerId: 'native', mode: 'structured' as const, conversationId }, engineConfig: { schemaVersion: 1 as const, options: {} },
    started: true, archived: false, status: 'stopped' as const, createdAt: '', updatedAt: '' };
  const events = new ExecutionEvents(), projection = new NativeProjection(directory, events, () => session, () => false, () => {});
  let ledger = await NativeRunStore.open({ rootDirectory: path.join(directory, 'ledgers'), conversationId });
  const request = (conversation: string, input: string): BeginRunRequest => ({ identity: { sessionId: id, conversationId: conversation, runId: randomUUID(), requestId: randomUUID(), workerGeneration: 1 },
    input, inputDigest: 'digest', userItems: [{ role: 'user', content: input }], protocol: { id: 'openai-responses', version: 1 }, configuration: { model: 'fixture' }, policyRevision: 'test' });
  const finish = async (input: BeginRunRequest) => {
    await ledger.beginRun(input);
    await ledger.append(input.identity, { type: 'run_finished', result: { identity: input.identity, status: 'completed', reason: 'completed', modelRequests: 0, toolCalls: 0, usage: null, context: ledger.loadContext()!, committed: true } });
  };
  try {
    await finish(request(conversationId, 'old conversation'));
    await projection.hydrate(id, ledger);
    const cold = new NativeProjection(directory, events, () => session, () => false, () => {});
    assert.equal((await cold.readDisplay(id)).messages[0].text, 'old conversation');
    const replay = t.mock.method(ledger, 'replay', () => { throw new Error('same-head projection must not replay'); });
    await projection.hydrate(id, ledger);
    replay.mock.restore();
    const firstPage = await cold.readDisplay(id);
    session.execution.conversationId = randomUUID();
    const unavailable = await cold.readDisplay(id);
    assert.deepEqual(unavailable.messages, []); assert.equal(unavailable.incomplete, true);
    for (const options of [{ before: firstPage.messages[0].id }, { after: firstPage.messages[0].id }, { around: firstPage.messages[0].id }]) {
      await assert.rejects(cold.readDisplay(id, options), /会话记录正在更新/);
    }
    await ledger.close(); ledger = await NativeRunStore.open({ rootDirectory: path.join(directory, 'ledgers'), conversationId: session.execution.conversationId });
    await finish(request(session.execution.conversationId, 'new conversation'));
    await projection.hydrate(id, ledger);
    assert.deepEqual((await cold.readDisplay(id)).messages.map(message => message.text), ['new conversation']);
    assert.ok((await fs.readFile(path.join(directory, 'chat', id + '.jsonl'), 'utf8')).split('\n').filter(Boolean).every(line => JSON.parse(line).conversationId === session.execution.conversationId));
  } finally { projection.flush(); await ledger.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

for (const source of ['snapshot', 'journal'] as const) test(`authority preserves ${source} display evidence after model history loss without turning it into execution context`, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-display-preserved-'));
  const id = randomUUID(), conversationId = randomUUID();
  const session = { id, projectId: 'project', title: 'display', kind: 'agent' as const, cwd: directory,
    execution: { providerId: 'native', mode: 'structured' as const, conversationId }, engineConfig: { schemaVersion: 1 as const, options: {} },
    started: true, archived: false, status: 'stopped' as const, createdAt: '', updatedAt: '' };
  const projection = new NativeProjection(directory, new ExecutionEvents(), () => session, () => false, () => {});
  const ledger = await NativeRunStore.open({ rootDirectory: path.join(directory, 'ledgers'), conversationId });
  const message = { id: 'preserved-message', turnId: 'old-run', role: 'user', text: '原始模型记录已丢失，仍保留此展示证据', createdAt: '' };
  const file = path.join(directory, 'chat', id + (source === 'snapshot' ? '.json' : '.jsonl'));
  try {
    const original = source === 'snapshot' ? JSON.stringify({ sessionId: id, taskState: 'completed', messages: [message], pending: [] }) : JSON.stringify({ type: 'message', message }) + '\n';
    await fs.writeFile(file, original);
    assert.deepEqual((await projection.readDisplay(id)).messages, [], 'unverified old source is initially unavailable');
    await projection.hydrate(id, ledger);
    const snapshot = projection.snapshot(id);
    assert.equal(snapshot.taskState, 'error'); assert.equal(snapshot.sourceIncomplete, true);
    assert.deepEqual(snapshot.messages, [message]); assert.equal(ledger.loadContext(), null);
    const cold = new NativeProjection(directory, new ExecutionEvents(), () => session, () => false, () => {});
    const page = await cold.readDisplay(id);
    assert.deepEqual(page.messages, [message]); assert.equal(page.incomplete, true);
    assert.equal(await fs.readFile(file, 'utf8'), original, 'sidecar publication never rewrites the preserved source');
    await fs.appendFile(file, '\n');
    assert.deepEqual((await cold.readDisplay(id)).messages, [], 'changed source cannot reuse the authority-approved binding');
  } finally { projection.flush(); await ledger.close(); await fs.rm(directory, { recursive: true, force: true }); }
});
