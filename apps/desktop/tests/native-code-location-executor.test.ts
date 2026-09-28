import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { runAgent } from '@cc-desk/agent-core';
import { ResponsesModel } from '@cc-desk/agent-node/responses-model';
import { NativeTaskStore } from '@cc-desk/agent-node/task-store';
import { StateStore } from '../src/main/store';
import { ExecutionEvents } from '../src/main/execution/events';
import { ConnectionStore } from '../src/main/engines/native/connections';
import { NativeStructuredExecutor, type NativeExecutorOptions } from '../src/main/engines/native/structured-executor';
import { createNativeConfig } from '../src/main/engines/native/config';
// @ts-expect-error Shared local protocol fixture has no declarations.
import { startResponsesFixture, functionCall, assistantMessage } from '../../../packages/agent-node/tests/fixtures/responses-server.mjs';

const sourcePath = 'src/中文 文件.ts';
const source = '// source snapshot\r\nconst label = "位置😀";\r\nexport { label };';
const sourceHash = createHash('sha256').update(source).digest('hex');
const secret = 'sk-native-location-fixture-never-display';
const plan = {
  goal: 'Inspect source and associate the implementation with its review criterion',
  steps: [{ id: 'inspect', title: 'Inspect the implementation', dependsOn: [], status: 'in_progress' }],
  criteria: [{ id: 'scope', description: 'Human reviews the source and relevance', stepIds: ['inspect'], kind: 'manual' }],
};
type Item = { type?: string; call_id?: string; output?: string };
function outputs(body: { input: Item[] }): Map<string, any> {
  return new Map(body.input.filter(item => item.type === 'function_call_output').map(item => [item.call_id!, JSON.parse(item.output!)]));
}
const inline: NonNullable<NativeExecutorOptions['worker']> = options => runAgent({ ...options.request, signal: options.signal }, {
  model: new ResponsesModel(options.model), tools: options.tools, store: options.store, approvals: options.approvals,
  host: { now: Date.now, digest: value => createHash('sha256').update(value).digest('hex'), emit: options.onEvent, deadline: (ms, parent) => {
    const controller = new AbortController(), abort = () => controller.abort(), timer = setTimeout(abort, ms);
    parent.addEventListener('abort', abort, { once: true }); if (parent.aborted) abort();
    return { signal: controller.signal, dispose() { clearTimeout(timer); parent.removeEventListener('abort', abort); } };
  } },
});

test('location tool survives the model/tool/task/snapshot round trip and restart; external edits expire its historical excerpt', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-location-executor-'));
  const project = path.join(directory, 'project'), data = path.join(directory, 'data');
  await fs.mkdir(path.join(project, 'src'), { recursive: true });
  await fs.writeFile(path.join(project, sourcePath), source);
  await fs.writeFile(path.join(project, 'CLAUDE.md'), 'Preserve user edits.');
  await fs.writeFile(path.join(project, 'src', 'AGENTS.md'), 'Nested source rules: preserve CRLF.');
  const server = await startResponsesFixture({ handler: ({ body }: { body: { input: Item[] } }) => {
    const done = outputs(body);
    const call = (id: string, name: string, input: unknown) => ({ output: [functionCall(id, name, input)] });
    if (!done.has('plan')) return call('plan', 'update_plan', { expectedRevision: 0, plan });
    if (!done.has('read')) return call('read', 'read_file', { path: sourcePath });
    if (!done.has('task-before')) return call('task-before', 'read_task', {});
    const input = { expectedRevision: done.get('task-before').output.task.revision, path: sourcePath,
      expectedHash: done.get('read').output.hash, startLine: 2, endLine: 3, stepIds: ['inspect'], criterionIds: ['scope'] };
    if (!done.has('wrong-hash')) return call('wrong-hash', 'record_code_location', { ...input, expectedHash: '0'.repeat(64) });
    if (!done.has('location')) return call('location', 'record_code_location', input);
    if (!done.has('task-after')) return call('task-after', 'read_task', {});
    return { output: [assistantMessage('final', '模型宣称任务已完成并通过所有验收。')] };
  } });
  const store = new StateStore(data), connections = new ConnectionStore(data), events = new ExecutionEvents();
  const initial = connections.upsert({ name: 'location fixture', protocol: 'responses', baseURL: server.baseURL,
    model: 'fixture-model', enabled: true, allowLoopbackHttp: true, auth: { mode: 'memory' } });
  const connection = connections.setCredential({ id: initial.id, revision: initial.revision, mode: 'memory', secret });
  const id = randomUUID(), conversationId = randomUUID(), projectId = randomUUID();
  store.change(state => {
    state.projects.push({ id: projectId, name: 'location project', path: project, createdAt: new Date().toISOString() });
    state.sessions.push({ id, projectId, title: 'locations', kind: 'agent', cwd: project,
      execution: { providerId: 'native', mode: 'structured', conversationId },
      engineConfig: createNativeConfig({ schemaVersion: 1, options: { connectionId: connection.id } }),
      started: false, archived: false, status: 'idle', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  });
  let executor = new NativeStructuredExecutor(store, connections, events, { worker: inline });
  try {
    await executor.initialize();
    const result = await executor.send(id, '读取实现并记录关联代码位置', [], undefined, { requestId: 'record-location' });
    assert.equal(result.success, true, JSON.stringify(result)); assert.deepEqual(server.errors, []);
    const task = executor.snapshot(id).nativeTask!;
    assert.ok(task); assert.equal(task.execution, 'ended'); assert.equal(task.verification, 'unverified');
    assert.equal(task.evidence.length, 1, 'failed observations cannot fabricate a location receipt');
    const evidence = task.evidence[0], location = evidence.location!;
    assert.equal(evidence.source, 'location'); assert.equal(evidence.status, 'unverified');
    assert.equal(evidence.identity.sessionId, id); assert.equal(evidence.identity.conversationId, conversationId);
    assert.equal(evidence.toolCallId, 'location'); assert.deepEqual(evidence.stepIds, ['inspect']);
    assert.deepEqual(evidence.criterionIds, ['scope']);
    assert.equal(location.path, sourcePath); assert.equal(location.startLine, 2); assert.equal(location.endLine, 3);
    assert.equal(location.fileHash, sourceHash); assert.equal(location.fileBytes, Buffer.byteLength(source));
    assert.equal(location.excerpt, 'const label = "位置😀";\r\nexport { label };');
    assert.equal(location.excerptHash, createHash('sha256').update(location.excerpt).digest('hex'));
    assert.equal(executor.snapshot(id).pending.length, 0);
    const recorded = outputs(server.requests.at(-1));
    assert.notEqual(recorded.get('wrong-hash').status, 'completed');
    assert.equal(recorded.get('location').status, 'completed');
    const index = recorded.get('task-after').output.task.evidence[0];
    assert.equal(index.location.path, sourcePath); assert.equal(index.location.fileHash, sourceHash);
    assert.equal(index.location.excerpt, undefined, 'read_task only includes the bounded location index');
    assert.match(JSON.stringify(recorded.get('location').output), /Nested source rules/);
    assert.equal(JSON.stringify(task).includes(secret), false);
    assert.equal(await fs.readFile(path.join(project, sourcePath), 'utf8'), source, 'recording cannot modify project files');
    const snapshots = await NativeTaskStore.readAllSnapshots({ rootDirectory: path.join(data, 'native'), conversationId, sessionId: id });
    assert.deepEqual(snapshots.at(-1)!.evidence, task.evidence, 'renderer data agrees with the durable authority');
    await executor.shutdown();
    executor = new NativeStructuredExecutor(store, connections, events, { worker: inline }); await executor.initialize();
    assert.deepEqual(executor.snapshot(id).nativeTask!.evidence, task.evidence);
    await fs.writeFile(path.join(project, sourcePath), source + '\r\n// external edit');
    await executor.hydrate(id);
    const refreshed = executor.snapshot(id).nativeTask!;
    assert.equal(refreshed.evidence[0].stale, true); assert.equal(refreshed.verification, 'stale');
    assert.equal(refreshed.evidence[0].location!.excerpt, location.excerpt, 'stale receipts retain the exact historical source');
    assert.equal(server.requests.length, 7, 'refresh and restart do not replay model calls');
  } finally {
    await executor.shutdown().catch(() => {}); await server.close(); store.flush(); await fs.rm(directory, { recursive: true, force: true });
  }
});
