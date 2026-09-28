import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { runAgent } from '@cc-desk/agent-core';
import { createNativeModel } from '@cc-desk/agent-node/native-model';
import { NativeRunStore } from '@cc-desk/agent-node/run-store';
import type { NativeChangeSetFileEvent } from '@cc-desk/contracts/native-changes';
import { StateStore } from '../src/main/store';
import { ExecutionEvents } from '../src/main/execution/events';
import { ConnectionStore } from '../src/main/engines/native/connections';
import { NativeStructuredExecutor, type NativeExecutorOptions } from '../src/main/engines/native/structured-executor';
import { NativeProjection } from '../src/main/engines/native/projection';
import { createNativeConfig } from '../src/main/engines/native/config';
// @ts-expect-error Local protocol fixture has no declarations.
import { startResponsesFixture, functionCall, assistantMessage } from '../../../packages/agent-node/tests/fixtures/responses-server.mjs';
// @ts-expect-error Local protocol fixture has no declarations.
import { startChatCompletionsFixture } from '../../../packages/agent-node/tests/fixtures/chat-completions-server.mjs';

type Protocol = 'responses' | 'chat-completions';
type WireBody = { input?: Array<any>; messages?: Array<any>; tools: Array<any> };
const sentinel = 'sk-change-set-fixture-never-persist';
const beforeAlpha = 'alpha feature\nalpha user content\n', afterAlpha = 'updated alpha feature\nalpha user content\n';
const beforeBeta = 'beta feature\nbeta user content\n', afterBeta = 'updated beta feature\nbeta user content\n';
const newContent = 'new fixture file\n';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const inline: NonNullable<NativeExecutorOptions['worker']> = options => runAgent({ ...options.request, signal: options.signal }, {
  model: createNativeModel(options.model), tools: options.tools, store: options.store, approvals: options.approvals,
  host: { now: Date.now, digest, emit: options.onEvent, deadline: (ms, parent) => {
    const controller = new AbortController(), abort = () => controller.abort(), timer = setTimeout(abort, ms);
    parent.addEventListener('abort', abort, { once: true }); if (parent.aborted) abort();
    return { signal: controller.signal, dispose() { clearTimeout(timer); parent.removeEventListener('abort', abort); } };
  } },
});
function receipts(body: WireBody) {
  return new Map((body.input ?? body.messages ?? []).filter(item => item.type === 'function_call_output' || item.role === 'tool')
    .map(item => [item.call_id ?? item.tool_call_id, JSON.parse(item.output ?? item.content)]));
}
async function fixture(protocol: Protocol) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-change-set-executor-'));
  const project = path.join(directory, 'project'), data = path.join(directory, 'data'); await fs.mkdir(project);
  await fs.writeFile(path.join(project, 'AGENTS.md'), 'Preserve all pre-existing user lines.');
  await fs.writeFile(path.join(project, 'CLAUDE.md'), 'Require individual approval for the exact complete proposed change set.');
  await fs.writeFile(path.join(project, 'alpha.txt'), beforeAlpha); await fs.writeFile(path.join(project, 'beta.txt'), beforeBeta);
  await fs.writeFile(path.join(project, 'untouched.txt'), 'unrelated user work\n');
  const handler = ({ body }: { body: WireBody }) => {
    const done = receipts(body);
    const call = (id: string, name: string, input: unknown) => protocol === 'responses'
      ? { output: [functionCall(id, name, input)] }
      : { message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(input) } }] } };
    const definitions = body.tools.map(tool => tool.function ?? tool);
    assert.ok(definitions.some(tool => tool.name === 'apply_change_set'), 'group schema must reach the actual model protocol');
    if (!done.has('plan')) return call('plan', 'update_plan', { expectedRevision: 0, plan: { goal: 'Apply an exactly reviewed file group',
      steps: [{ id: 'edit', title: 'Edit the reviewed files', dependsOn: [], status: 'in_progress' }], criteria: [{ id: 'scope', description: 'Review exact changes and preserve user edits', stepIds: ['edit'], kind: 'manual' }] } });
    if (!done.has('read-alpha')) return call('read-alpha', 'read_file', { path: 'alpha.txt' });
    if (!done.has('read-beta')) return call('read-beta', 'read_file', { path: 'beta.txt' });
    if (!done.has('group')) return call('group', 'apply_change_set', { changes: [
      { path: 'alpha.txt', content: afterAlpha, expectedHash: done.get('read-alpha').output.hash },
      { path: 'beta.txt', content: afterBeta, expectedHash: done.get('read-beta').output.hash },
      { path: 'created.txt', content: newContent, expectedHash: null },
    ] });
    return protocol === 'responses' ? { output: [assistantMessage('final', '模型声称已全部修改并且验收通过。')] }
      : { message: { role: 'assistant', content: '模型声称已全部修改并且验收通过。' } };
  };
  const server = await (protocol === 'responses' ? startResponsesFixture({ handler }) : startChatCompletionsFixture({ handler }));
  const store = new StateStore(data), connections = new ConnectionStore(data), events = new ExecutionEvents();
  const connection = connections.upsert({ name: 'change set fixture', protocol, baseURL: server.baseURL, model: 'fixture-model', enabled: true, allowLoopbackHttp: true, auth: { mode: 'memory' } });
  connections.setCredential({ id: connection.id, revision: connection.revision, mode: 'memory', secret: sentinel });
  const id = randomUUID(), conversationId = randomUUID(), projectId = randomUUID();
  store.change(state => {
    state.projects.push({ id: projectId, name: 'fixture', path: project, createdAt: new Date().toISOString() });
    state.sessions.push({ id, projectId, title: 'change sets', kind: 'agent', cwd: project, execution: { providerId: 'native', mode: 'structured', conversationId },
      engineConfig: createNativeConfig({ schemaVersion: 1, options: { connectionId: connection.id } }), started: false, archived: false, status: 'idle', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  });
  let executor = new NativeStructuredExecutor(store, connections, events, { worker: inline }); await executor.initialize();
  const pending = async () => {
    for (let attempt = 0; attempt < 500; attempt++) { const value = executor.snapshot(id).pending[0]; if (value) return value; await new Promise(resolve => setTimeout(resolve, 5)); }
    throw new Error(`No change-set approval: ${JSON.stringify(executor.snapshot(id).error)} / ${server.errors.map(String).join(';')}`);
  };
  const readLedger = async () => {
    const ledger = await NativeRunStore.open({ rootDirectory: path.join(data, 'native', 'conversations'), conversationId });
    try { return { records: ledger.replay(), runs: ledger.listRuns(), recovery: ledger.getRecoveryReport() }; } finally { await ledger.close(); }
  };
  return { id, project, data, conversationId, server, pending, readLedger, get executor() { return executor; },
    async restart() { await executor.shutdown(); executor = new NativeStructuredExecutor(store, connections, events, { worker: inline }); await executor.initialize(); },
    async dispose() { await executor.shutdown().catch(() => {}); await server.close(); store.flush(); await fs.rm(directory, { recursive: true, force: true }); },
  };
}

for (const protocol of ['responses', 'chat-completions'] as const) test(`${protocol}: exact group approval applies three files, preserves unrelated edits, and never fabricates verification`, { timeout: 20000 }, async () => {
  const f = await fixture(protocol);
  try {
    const running = f.executor.send(f.id, 'Review and apply the complete file group', [], undefined, { requestId: 'group-success' });
    const approval = await f.pending(); assert.equal(approval.toolName, 'apply_change_set');
    assert.equal(approval.nativeChangeSet?.atomic, false);
    assert.equal(approval.nativeChangeSet?.files.length, 3);
    assert.match(approval.nativeChangeSet!.files[0].diff, /alpha feature/);
    assert.match(approval.nativeChangeSet!.files[0].diff, /updated alpha feature/);
    assert.deepEqual((approval.input as { changes: unknown[] }).changes, [
      { path: 'alpha.txt', content: afterAlpha, expectedHash: digest(beforeAlpha) }, { path: 'beta.txt', content: afterBeta, expectedHash: digest(beforeBeta) }, { path: 'created.txt', content: newContent, expectedHash: null },
    ]);
    assert.equal(await fs.readFile(path.join(f.project, 'alpha.txt'), 'utf8'), beforeAlpha, 'preparation must not publish any file');
    assert.equal(await fs.readFile(path.join(f.project, 'beta.txt'), 'utf8'), beforeBeta);
    await assert.rejects(fs.stat(path.join(f.project, 'created.txt')), { code: 'ENOENT' });
    f.executor.respond(f.id, approval.requestId, { behavior: 'allow' });
    const result = await running; assert.equal(result.success, true, JSON.stringify(result)); assert.deepEqual(f.server.errors, []);
    assert.equal(await fs.readFile(path.join(f.project, 'alpha.txt'), 'utf8'), afterAlpha);
    assert.equal(await fs.readFile(path.join(f.project, 'beta.txt'), 'utf8'), afterBeta);
    assert.equal(await fs.readFile(path.join(f.project, 'created.txt'), 'utf8'), newContent);
    assert.equal(await fs.readFile(path.join(f.project, 'untouched.txt'), 'utf8'), 'unrelated user work\n');
    assert.equal(receipts(f.server.requests.at(-1)).get('group').status, 'completed');
    assert.notEqual(f.executor.snapshot(f.id).nativeTask?.verification, 'passed');
    const ledger = await f.readLedger(); assert.equal(ledger.recovery, null); assert.equal(JSON.stringify(ledger).includes(sentinel), false);
    const progress = ledger.records.flatMap(record => record.event.type === 'change_set_file' ? [record.event.progress] : []);
    assert.deepEqual(progress.map(item => [item.index, item.path, item.status]), [[0, 'alpha.txt', 'prepared'], [0, 'alpha.txt', 'applied'], [1, 'beta.txt', 'prepared'], [1, 'beta.txt', 'applied'], [2, 'created.txt', 'prepared'], [2, 'created.txt', 'applied']]);
    assert.ok(progress.every(item => item.changeSetDigest === approval.nativeChangeSet!.digest));
    const projection = f.executor.snapshot(f.id).messages.find(message => message.nativeChangeSetResult);
    assert.equal(projection?.nativeChangeSetResult?.status, 'completed');
    assert.deepEqual(projection?.nativeChangeSetResult?.files.map(item => item.status), ['applied', 'applied', 'applied']);
    const count = f.server.requests.length;
    await f.restart();
    assert.equal((await f.executor.send(f.id, 'Review and apply the complete file group', [], undefined, { requestId: 'group-success' })).success, true);
    assert.equal(f.server.requests.length, count, 'duplicate submissions use only the durable receipt');
    assert.equal(f.executor.snapshot(f.id).pending.length, 0);
  } finally { await f.dispose(); }
});

for (const protocol of ['responses', 'chat-completions'] as const) test(`${protocol}: denied group approval changes no file`, { timeout: 20000 }, async () => {
  const f = await fixture(protocol);
  try {
    const running = f.executor.send(f.id, 'Deny this file group'); const approval = await f.pending();
    f.executor.respond(f.id, approval.requestId, { behavior: 'deny' });
    assert.equal((await running).success, true, 'the denial receipt still ends the model turn normally');
    assert.equal(receipts(f.server.requests.at(-1)).get('group').status, 'denied');
    assert.equal(await fs.readFile(path.join(f.project, 'alpha.txt'), 'utf8'), beforeAlpha);
    assert.equal(await fs.readFile(path.join(f.project, 'beta.txt'), 'utf8'), beforeBeta);
    await assert.rejects(fs.stat(path.join(f.project, 'created.txt')), { code: 'ENOENT' });
    assert.equal((await f.readLedger()).runs[0].tools.find(tool => tool.call.id === 'group')?.prepared, undefined);
  } finally { await f.dispose(); }
});

for (const change of ['file', 'instructions'] as const) test(`approval-time ${change} changes invalidate the entire group before its first write`, { timeout: 20000 }, async () => {
  const f = await fixture('responses');
  try {
    const running = f.executor.send(f.id, 'Keep approval bound to exact files and rules'); const approval = await f.pending();
    await fs.writeFile(path.join(f.project, change === 'file' ? 'beta.txt' : 'CLAUDE.md'), 'external user change\n');
    f.executor.respond(f.id, approval.requestId, { behavior: 'allow' });
    assert.equal((await running).success, true); assert.equal(receipts(f.server.requests.at(-1)).get('group').status, 'failed');
    assert.equal(await fs.readFile(path.join(f.project, 'alpha.txt'), 'utf8'), beforeAlpha);
    assert.equal(await fs.readFile(path.join(f.project, 'beta.txt'), 'utf8'), change === 'file' ? 'external user change\n' : beforeBeta);
    await assert.rejects(fs.stat(path.join(f.project, 'created.txt')), { code: 'ENOENT' });
    assert.equal(f.executor.recoveryRequired(f.id), false);
  } finally { await f.dispose(); }
});

test('cancelling a pending group never publishes a file or accepts a late approval', { timeout: 20000 }, async () => {
  const f = await fixture('chat-completions');
  try {
    const running = f.executor.send(f.id, 'Cancel before applying group'); const approval = await f.pending();
    await f.executor.stopAndWait(f.id); assert.equal((await running).interrupted, true);
    assert.throws(() => f.executor.respond(f.id, approval.requestId, { behavior: 'allow' }));
    assert.equal(await fs.readFile(path.join(f.project, 'alpha.txt'), 'utf8'), beforeAlpha);
    assert.equal(await fs.readFile(path.join(f.project, 'beta.txt'), 'utf8'), beforeBeta);
    await assert.rejects(fs.stat(path.join(f.project, 'created.txt')), { code: 'ENOENT' });
    const count = f.server.requests.length; await f.restart(); assert.equal(f.server.requests.length, count);
  } finally { await f.dispose(); }
});

for (const cause of ['cancel', 'external-edit', 'changed-instructions'] as const) test(`after one committed file, ${cause} preserves it and stops the remaining group without rollback`, { timeout: 20000 }, async () => {
  const f = await fixture('responses'), original = NativeRunStore.prototype.recordChangeSetEvent; let injected = false;
  try {
    NativeRunStore.prototype.recordChangeSetEvent = async function (identity, call, event) {
      const committed = await original.call(this, identity, call, event);
      if (!injected && event.index === 0 && event.status === 'applied') {
        injected = true;
        if (cause === 'cancel') f.executor.interrupt(f.id);
        else await fs.writeFile(path.join(f.project, cause === 'external-edit' ? 'beta.txt' : 'CLAUDE.md'), 'external change after first committed file\n');
      }
      return committed;
    };
    const running = f.executor.send(f.id, `Stop remaining writes on ${cause}`, [], undefined, { requestId: `partial-${cause}` });
    const approval = await f.pending(); f.executor.respond(f.id, approval.requestId, { behavior: 'allow' });
    const result = await running; assert.equal(injected, true);
    assert.equal(await fs.readFile(path.join(f.project, 'alpha.txt'), 'utf8'), afterAlpha, 'confirmed first edit is not rolled back');
    assert.equal(await fs.readFile(path.join(f.project, 'beta.txt'), 'utf8'), cause === 'external-edit' ? 'external change after first committed file\n' : beforeBeta);
    await assert.rejects(fs.stat(path.join(f.project, 'created.txt')), { code: 'ENOENT' });
    if (cause === 'cancel') assert.equal(result.interrupted, true); else assert.equal(result.success, true, 'a fully known partial receipt remains an operationally completed model turn');
    assert.equal(f.executor.recoveryRequired(f.id), false, 'known partial outcomes do not become unknown effects');
    const ledger = await f.readLedger();
    const group = ledger.runs[0].tools.find(tool => tool.call.id === 'group')!;
    assert.ok(group.completed, 'known partial outcome has a real tool receipt');
    const progress = ledger.records.flatMap(record => record.event.type === 'change_set_file' ? [record.event.progress] : []);
    assert.equal(progress.find(item => item.index === 0 && item.status === 'applied')?.afterHash, digest(afterAlpha));
    assert.equal(progress.filter(item => item.status === 'applied').length, 1);
    assert.equal(progress.some(item => item.status === 'unknown'), false);
    const message = f.executor.snapshot(f.id).messages.find(item => item.nativeChangeSetResult);
    assert.equal(message?.nativeChangeSetResult?.status, 'partial');
    assert.deepEqual(message?.nativeChangeSetResult?.files.map(item => item.status), ['applied', 'not_applied', 'not_applied']);
    const requests = f.server.requests.length;
    NativeRunStore.prototype.recordChangeSetEvent = original; await f.restart();
    const duplicate = await f.executor.send(f.id, `Stop remaining writes on ${cause}`, [], undefined, { requestId: `partial-${cause}` });
    assert.equal(duplicate.success, result.success); assert.equal(f.server.requests.length, requests);
  } finally { NativeRunStore.prototype.recordChangeSetEvent = original; await f.dispose(); }
});

for (const publication of ['rename', 'link'] as const) test(`${publication} succeeds then reports failure: the published file stays unknown and the group never replays`, { timeout: 20000 }, async () => {
  const f = await fixture('chat-completions'); let injected = false;
  const rename = fs.rename, link = fs.link;
  try {
    if (publication === 'rename') fs.rename = async (from, to) => {
      await rename(from, to);
      if (!injected && path.basename(String(to)) === 'alpha.txt') { injected = true; throw new Error('failure after successful rename publication'); }
    };
    else fs.link = async (from, to) => {
      await link(from, to);
      if (!injected && path.basename(String(to)) === 'created.txt') { injected = true; throw new Error('failure after successful hard-link publication'); }
    };
    const running = f.executor.send(f.id, `Preserve unknown ${publication} outcome`, [], undefined, { requestId: `unknown-${publication}` });
    const approval = await f.pending(); f.executor.respond(f.id, approval.requestId, { behavior: 'allow' });
    const result = await running; assert.equal(injected, true); assert.equal(result.success, false);
    assert.equal(f.executor.recoveryRequired(f.id), true);
    assert.equal(await fs.readFile(path.join(f.project, 'alpha.txt'), 'utf8'), afterAlpha);
    assert.equal(await fs.readFile(path.join(f.project, 'beta.txt'), 'utf8'), publication === 'rename' ? beforeBeta : afterBeta);
    if (publication === 'link') assert.equal(await fs.readFile(path.join(f.project, 'created.txt'), 'utf8'), newContent);
    else await assert.rejects(fs.stat(path.join(f.project, 'created.txt')), { code: 'ENOENT' });
    const ledger = await f.readLedger(); assert.equal(ledger.recovery?.classification, 'unknown_effects');
    const progress = ledger.records.flatMap(record => record.event.type === 'change_set_file' ? [record.event.progress] : []);
    assert.equal(progress.find(item => item.status === 'unknown')?.path, publication === 'rename' ? 'alpha.txt' : 'created.txt');
    const view = f.executor.snapshot(f.id).messages.find(item => item.nativeChangeSetResult)?.nativeChangeSetResult;
    assert.equal(view?.status, 'unknown'); assert.ok(view?.files.some(item => item.status === 'unknown'));
    fs.rename = rename; fs.link = link;
    const requests = f.server.requests.length; await f.restart();
    assert.equal(f.executor.recoveryRequired(f.id), true);
    assert.equal((await f.executor.send(f.id, `Preserve unknown ${publication} outcome`, [], undefined, { requestId: `unknown-${publication}` })).success, false);
    assert.equal(f.server.requests.length, requests);
    assert.equal(await fs.readFile(path.join(f.project, 'alpha.txt'), 'utf8'), afterAlpha);
  } finally { fs.rename = rename; fs.link = link; await f.dispose(); }
});

test('a per-file applied journal failure is an unknown side effect, never a swallowed task observer error', { timeout: 20000 }, async () => {
  const f = await fixture('responses'), original = NativeRunStore.prototype.recordChangeSetEvent; let injected = false;
  try {
    NativeRunStore.prototype.recordChangeSetEvent = async function (identity, call, event: NativeChangeSetFileEvent) {
      if (!injected && event.index === 0 && event.status === 'applied') { injected = true; throw new Error('injected per-file commit failure'); }
      return original.call(this, identity, call, event);
    };
    const running = f.executor.send(f.id, 'Do not lose a file-journal failure', [], undefined, { requestId: 'receipt-failure' });
    const approval = await f.pending(); f.executor.respond(f.id, approval.requestId, { behavior: 'allow' });
    const result = await running; assert.equal(injected, true); assert.equal(result.success, false); assert.equal(f.executor.recoveryRequired(f.id), true);
    assert.equal(await fs.readFile(path.join(f.project, 'alpha.txt'), 'utf8'), afterAlpha);
    assert.equal(await fs.readFile(path.join(f.project, 'beta.txt'), 'utf8'), beforeBeta);
    await assert.rejects(fs.stat(path.join(f.project, 'created.txt')), { code: 'ENOENT' });
    const ledger = await f.readLedger(); assert.equal(ledger.recovery?.classification, 'unknown_effects');
    assert.equal(ledger.records.some(record => record.event.type === 'change_set_file' && record.event.progress.index === 0 && record.event.progress.status === 'prepared'), true);
    NativeRunStore.prototype.recordChangeSetEvent = original;
    const requests = f.server.requests.length; await f.restart();
    assert.equal(f.executor.recoveryRequired(f.id), true);
    assert.equal((await f.executor.send(f.id, 'Do not lose a file-journal failure', [], undefined, { requestId: 'receipt-failure' })).success, false);
    assert.equal(f.server.requests.length, requests);
  } finally { NativeRunStore.prototype.recordChangeSetEvent = original; await f.dispose(); }
});

test('a projection refresh failure after a committed receipt cannot invent unknown file effects', { timeout: 20000 }, async () => {
  const f = await fixture('responses'), hydrate = NativeProjection.prototype.hydrate; let injected = false;
  try {
    NativeProjection.prototype.hydrate = function (id, ledger) {
      const latest = ledger.replay().at(-1)?.event;
      if (!injected && latest?.type === 'change_set_file' && latest.progress.index === 0 && latest.progress.status === 'applied') {
        injected = true; return Promise.reject(new Error('injected transient display refresh failure'));
      }
      return hydrate.call(this, id, ledger);
    };
    const running = f.executor.send(f.id, 'Keep durable receipts authoritative when display refresh fails');
    const approval = await f.pending(); f.executor.respond(f.id, approval.requestId, { behavior: 'allow' });
    assert.equal((await running).success, true); assert.equal(injected, true);
    assert.equal(f.executor.recoveryRequired(f.id), false);
    assert.deepEqual(await Promise.all(['alpha.txt', 'beta.txt', 'created.txt'].map(relative => fs.readFile(path.join(f.project, relative), 'utf8'))), [afterAlpha, afterBeta, newContent]);
    const ledger = await f.readLedger();
    const progress = ledger.records.flatMap(record => record.event.type === 'change_set_file' ? [record.event.progress] : []);
    assert.deepEqual(progress.map(item => item.status), ['prepared', 'applied', 'prepared', 'applied', 'prepared', 'applied']);
    assert.equal(f.executor.snapshot(f.id).messages.find(message => message.nativeChangeSetResult)?.nativeChangeSetResult?.status, 'completed');
    NativeProjection.prototype.hydrate = hydrate; await f.restart();
    assert.equal(f.executor.recoveryRequired(f.id), false);
    assert.equal(f.executor.snapshot(f.id).messages.find(message => message.nativeChangeSetResult)?.nativeChangeSetResult?.status, 'completed');
  } finally { NativeProjection.prototype.hydrate = hydrate; await f.dispose(); }
});
