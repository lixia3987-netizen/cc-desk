import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { runAgent } from '@cc-desk/agent-core';
import { createNativeModel } from '@cc-desk/agent-node/native-model';
import { NativeRunStore } from '@cc-desk/agent-node/run-store';
import { ProcessSupervisor } from '@cc-desk/agent-node/process-supervisor';
import { StateStore } from '../src/main/store';
import { ExecutionEvents } from '../src/main/execution/events';
import { ConnectionStore } from '../src/main/engines/native/connections';
import { NativeStructuredExecutor, type NativeExecutorOptions } from '../src/main/engines/native/structured-executor';
import { createNativeConfig } from '../src/main/engines/native/config';
// @ts-expect-error Local test fixture has no declarations.
import { startResponsesFixture, functionCall, assistantMessage } from '../../../packages/agent-node/tests/fixtures/responses-server.mjs';
// @ts-expect-error Local test fixture has no declarations.
import { startChatCompletionsFixture } from '../../../packages/agent-node/tests/fixtures/chat-completions-server.mjs';

type Protocol = 'responses' | 'chat-completions';
type Mode = 'normal' | 'early-final' | 'cancel' | 'deny';
type Body = { input?: any[]; messages?: any[]; tools: any[] };
const secret = 'sk-long-command-executor-fixture-secret';
const stdout = '前😀后\n';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const receipts = (body: Body): Map<string, any> => new Map((body.input ?? body.messages ?? [])
  .filter(item => item.type === 'function_call_output' || item.role === 'tool')
  .map(item => [item.call_id ?? item.tool_call_id, JSON.parse(item.output ?? item.content)]));
const inline: NonNullable<NativeExecutorOptions['worker']> = options => runAgent({ ...options.request, signal: options.signal }, {
  model: createNativeModel(options.model), tools: options.tools, store: options.store, approvals: options.approvals,
  host: { now: Date.now, digest: hash, emit: options.onEvent, deadline: (ms, parent) => {
    const controller = new AbortController(), abort = () => controller.abort(), timer = setTimeout(abort, ms);
    parent.addEventListener('abort', abort, { once: true }); if (parent.aborted) abort();
    return { signal: controller.signal, dispose() { clearTimeout(timer); parent.removeEventListener('abort', abort); } };
  } },
});

async function fixture(protocol: Protocol, mode: Mode = 'normal') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-long-command-executor-'));
  const project = path.join(directory, 'project'), data = path.join(directory, 'data'); await fs.mkdir(project);
  await fs.writeFile(path.join(project, 'AGENTS.md'), 'Preserve user files and report actual process results.');
  await fs.writeFile(path.join(project, 'CLAUDE.md'), 'Command start requires exact approval.');
  const command = { executable: process.execPath, argv: ['-e', `require('node:fs').appendFileSync('launches.txt','started\\n');process.stdout.write(${JSON.stringify(stdout)});process.stderr.write('diagnostic\\n');${mode === 'early-final' || mode === 'cancel' ? 'setInterval(()=>{},1000)' : 'setTimeout(()=>process.exit(0),150)'}`],
    cwd: '.', timeoutMs: 180000, maxOutputBytes: 4096 };
  const server = await (protocol === 'responses' ? startResponsesFixture : startChatCompletionsFixture)({ handler: ({ body }: { body: Body }) => {
    const done = receipts(body);
    const call = (id: string, name: string, input: unknown) => protocol === 'responses'
      ? { output: [functionCall(id, name, input)] }
      : { message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(input) } }] } };
    const finish = () => protocol === 'responses' ? { output: [assistantMessage('final', '模型宣称工作已经完成并通过验收。')] }
      : { message: { role: 'assistant', content: '模型宣称工作已经完成并通过验收。' } };
    const names = body.tools.map(item => (item.function ?? item).name);
    for (const name of ['start_command', 'command_status', 'read_command_output', 'stop_command']) assert.ok(names.includes(name));
    if (!done.has('plan')) return call('plan', 'update_plan', { expectedRevision: 0, plan: {
      goal: 'Run a bounded background command and inspect its actual result',
      steps: [{ id: 'check', title: 'Execute and inspect', dependsOn: [], status: 'in_progress' }],
      criteria: [{ id: 'review', description: 'Human reviews command relevance and outcome', stepIds: ['check'], kind: 'manual' }],
    } });
    if (!done.has('start')) return call('start', 'start_command', command);
    if (mode === 'deny' || done.get('start').status !== 'completed') return finish();
    const commandId = done.get('start').output.commandId;
    const polls = [...done.entries()].filter(([id]) => id.startsWith('status-'));
    if (!polls.length) return call('status-0', 'command_status', { commandId, waitMs: mode === 'normal' ? 1000 : 150 });
    if (mode === 'cancel') return { hang: true };
    if (mode === 'early-final') return finish();
    if (polls.at(-1)![1].output.state !== 'finished') {
      assert.ok(polls.length < 5, 'normal command must settle within the bounded fixture');
      return call(`status-${polls.length}`, 'command_status', { commandId, waitMs: 1000 });
    }
    if (!done.has('page-1')) return call('page-1', 'read_command_output', { commandId, stream: 'stdout', offset: 0, limit: 2 });
    if (!done.has('page-2')) return call('page-2', 'read_command_output', { commandId, stream: 'stdout', offset: done.get('page-1').output.nextOffset, limit: 4 });
    return finish();
  } });
  const store = new StateStore(data), connections = new ConnectionStore(data), events = new ExecutionEvents();
  const initial = connections.upsert({ name: 'long command fixture', protocol, baseURL: server.baseURL, model: 'fixture-model', enabled: true,
    allowLoopbackHttp: true, auth: { mode: 'memory' } });
  const connection = connections.setCredential({ id: initial.id, revision: initial.revision, mode: 'memory', secret });
  const id = randomUUID(), conversationId = randomUUID(), projectId = randomUUID();
  store.change(state => {
    state.projects.push({ id: projectId, name: 'project', path: project, createdAt: new Date().toISOString() });
    state.sessions.push({ id, projectId, title: 'long commands', kind: 'agent', cwd: project,
      execution: { providerId: 'native', mode: 'structured', conversationId },
      engineConfig: createNativeConfig({ schemaVersion: 1, options: { connectionId: connection.id } }), started: false,
      archived: false, status: 'idle', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  });
  let supervisor = new ProcessSupervisor({ maxTimeoutMs: 3600000 }), executor = new NativeStructuredExecutor(store, connections, events, { worker: inline, supervisor });
  await executor.initialize();
  return { directory, project, data, id, conversationId, server, command,
    get executor() { return executor; }, get supervisor() { return supervisor; },
    async pending() {
      for (let i = 0; i < 500; i++) { const pending = executor.snapshot(id).pending[0]; if (pending) return pending; await new Promise(resolve => setTimeout(resolve, 10)); }
      throw new Error(`No command approval: ${JSON.stringify(executor.snapshot(id))}`);
    },
    async ledger() {
      const ledger = await NativeRunStore.open({ rootDirectory: path.join(data, 'native', 'conversations'), conversationId });
      try { return { runs: ledger.listRuns(), records: ledger.replay(), recovery: ledger.getRecoveryReport() }; } finally { await ledger.close(); }
    },
    async restart() {
      await executor.shutdown(); supervisor = new ProcessSupervisor({ maxTimeoutMs: 3600000 });
      executor = new NativeStructuredExecutor(store, connections, events, { worker: inline, supervisor }); await executor.initialize();
    },
    async dispose() { await executor.shutdown().catch(() => {}); await supervisor.dispose().catch(() => {}); await server.close(); store.flush(); await fs.rm(directory, { recursive: true, force: true }); },
  };
}

for (const protocol of ['responses', 'chat-completions'] as const) test(`${protocol}: approved long command paginates stable Unicode logs, commits its terminal result, and never replays after restart`, { timeout: 20000 }, async () => {
  const f = await fixture(protocol);
  try {
    const running = f.executor.send(f.id, 'Execute and inspect the command', [], undefined, { requestId: 'long-command' });
    const approval = await f.pending(); assert.equal(approval.toolName, 'start_command');
    const { preconditions, ...approvalInput } = approval.input as typeof f.command & { preconditions: { instructions: Array<{ path: string }> } };
    assert.deepEqual(approvalInput, f.command); assert.deepEqual(preconditions.instructions.map(item => item.path).sort(), ['AGENTS.md', 'CLAUDE.md']);
    await assert.rejects(fs.stat(path.join(f.project, 'launches.txt')), { code: 'ENOENT' });
    f.executor.respond(f.id, approval.requestId, { behavior: 'allow' });
    const result = await running; assert.equal(result.success, true, JSON.stringify(result)); assert.deepEqual(f.server.errors, []);
    const done = receipts(f.server.requests.at(-1));
    assert.equal(done.get('start').status, 'completed');
    assert.equal(done.get('page-1').output.text + done.get('page-2').output.text, stdout);
    assert.equal(done.get('page-1').output.nextOffset, 1, 'a page cannot split the emoji surrogate pair');
    assert.equal(f.supervisor.activeCount, 0);
    const ledger = await f.ledger(), start = ledger.runs[0].tools.find(item => item.call.id === 'start')!;
    assert.ok(start.commandProgress); assert.equal(start.commandProgress[0].status, 'prepared');
    const terminal = start.commandProgress.at(-1)!;
    assert.equal(terminal.status, 'finished'); assert.ok('result' in terminal);
    if (!('result' in terminal)) throw new Error('missing terminal result');
    assert.equal(terminal.result.stdout, stdout); assert.equal(terminal.result.stderr, 'diagnostic\n');
    assert.equal(terminal.result.exitCode, 0); assert.equal(terminal.result.cleanup, 'released');
    assert.ok(terminal.seq < ledger.records.find(item => item.event.type === 'run_finished')!.seq); assert.equal(ledger.recovery, null);
    const evidence = f.executor.snapshot(f.id).nativeTask!.evidence.filter(item => item.source === 'command');
    assert.equal(evidence.length, 1); assert.equal(evidence[0].toolCallId, 'start'); assert.equal(evidence[0].exitCode, 0);
    assert.notEqual(f.executor.snapshot(f.id).nativeTask!.verification, 'passed');
    assert.equal(JSON.stringify(ledger).includes(secret), false);
    const requests = f.server.requests.length;
    await f.restart();
    assert.equal((await f.executor.send(f.id, 'Execute and inspect the command', [], undefined, { requestId: 'long-command' })).success, true);
    assert.equal(f.server.requests.length, requests); assert.equal(await fs.readFile(path.join(f.project, 'launches.txt'), 'utf8'), 'started\n');
  } finally { await f.dispose(); }
});

test('model completion stops unfinished commands and records cancellation before committing its operational result', { timeout: 15000 }, async () => {
  const f = await fixture('responses', 'early-final');
  try {
    const running = f.executor.send(f.id, 'Start then end the turn', [], undefined, { requestId: 'early-final' });
    const approval = await f.pending(); f.executor.respond(f.id, approval.requestId, { behavior: 'allow' });
    const result = await running; assert.equal(result.success, true, JSON.stringify(result)); assert.equal(f.supervisor.activeCount, 0);
    const ledger = await f.ledger(), run = ledger.runs[0], terminal = run.tools.find(item => item.call.id === 'start')!.commandProgress!.at(-1)!;
    assert.equal(terminal.status, 'finished'); assert.ok('result' in terminal);
    if (!('result' in terminal)) throw new Error('missing terminal result');
    assert.equal(terminal.result.cancelled, true); assert.equal(terminal.result.cleanup, 'released'); assert.ok(terminal.seq < ledger.records.find(item => item.event.type === 'run_finished')!.seq);
    assert.notEqual(f.executor.snapshot(f.id).nativeTask!.verification, 'passed');
  } finally { await f.dispose(); }
});

test('user cancellation while the model is pending stops the owned command after its start tool already returned', { timeout: 15000 }, async () => {
  const f = await fixture('responses', 'cancel');
  try {
    const running = f.executor.send(f.id, 'Wait with a live command', [], undefined, { requestId: 'cancel-command' });
    const approval = await f.pending(); f.executor.respond(f.id, approval.requestId, { behavior: 'allow' });
    for (let i = 0; i < 500 && !f.server.requests.some((body: Body) => receipts(body).has('status-0')); i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(f.server.requests.some((body: Body) => receipts(body).has('status-0'))); assert.ok(f.supervisor.activeCount > 0);
    await f.executor.stop(f.id); const result = await running;
    assert.equal(result.success, false); assert.equal(f.supervisor.activeCount, 0);
    const ledger = await f.ledger(), terminal = ledger.runs[0].tools.find(item => item.call.id === 'start')!.commandProgress!.at(-1)!;
    assert.equal(terminal.status, 'finished'); assert.ok('result' in terminal && terminal.result.cancelled && terminal.result.cleanup === 'released');
  } finally { await f.dispose(); }
});

test('denying a long command creates neither a process nor a host launch record', { timeout: 15000 }, async () => {
  const f = await fixture('responses', 'deny');
  try {
    const running = f.executor.send(f.id, 'Request an approved command', [], undefined, { requestId: 'deny-command' });
    const approval = await f.pending(); f.executor.respond(f.id, approval.requestId, { behavior: 'deny' });
    await running; assert.equal(f.supervisor.activeCount, 0);
    await assert.rejects(fs.stat(path.join(f.project, 'launches.txt')), { code: 'ENOENT' });
    const ledger = await f.ledger(); assert.equal(ledger.runs[0].tools.find(item => item.call.id === 'start')!.commandProgress, undefined);
    assert.equal(f.executor.snapshot(f.id).nativeTask!.evidence.length, 0);
  } finally { await f.dispose(); }
});
