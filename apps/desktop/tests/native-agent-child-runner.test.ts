import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runAgent, type ApprovalPort, type ModelPort, type ModelRequest, type ModelResponse, type RunIdentity, type ToolCall } from '@cc-desk/agent-core';
import { createNativeModel } from '@cc-desk/agent-node/native-model';
import { NativeRunStore } from '@cc-desk/agent-node/run-store';
import { NativeTaskStore } from '@cc-desk/agent-node/task-store';
import { runNativeAgentChild } from '../src/main/engines/native/agent-child-runner';
import type { NativeAgentChildInput } from '../src/main/engines/native/agent-delegation';
import { parseNativeConfig } from '../src/main/engines/native/config';
import { NativeWorkerCleanupError, type NativeWorkerOptions } from '../src/main/engines/native/worker-host';

const identity = (): RunIdentity => ({ sessionId: randomUUID(), conversationId: randomUUID(), runId: randomUUID(), requestId: randomUUID(), workerGeneration: 1 });
const approved: ApprovalPort = { request: async request => ({ binding: request.binding, decision: 'approved', expiresAt: request.expiresAt }) };
const completed = (text = '已独立检查并保留验证证据'): ModelResponse => ({ outputItems: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }], toolCalls: [], finishReason: 'completed', usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } });
function tools(...calls: ToolCall[]): ModelResponse { return { outputItems: calls.map(call => ({ type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments })),
  toolCalls: calls, finishReason: 'tool_calls', usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } }; }
const call = (name: string, input: unknown): ToolCall => ({ id: randomUUID(), name, arguments: JSON.stringify(input) });

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-native-child-runner-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const cwd = path.join(directory, 'project'), dataDirectory = path.join(directory, 'data'); await fs.mkdir(cwd);
  await fs.writeFile(path.join(cwd, 'file.txt'), 'initial\n');
  const abort = new AbortController();
  const input: NativeAgentChildInput = { identity: identity(), taskId: randomUUID(), parentIdentity: identity(), parentTaskId: randomUUID(),
    title: '审阅文件', goal: '检查 file.txt 的内容并提供证据', cwd, toolPolicy: 'read_only', signal: abort.signal,
    budget: { consume: async () => true, remainingMs: () => 60000, snapshot: () => ({ modelRequests: 0, toolCalls: 0 }) } };
  return { directory, cwd, dataDirectory, abort, input, options: { dataDirectory, model: { baseURL: 'https://example.invalid/v1', model: 'test', apiKey: 'sk-child-runner-protected' },
    config: parseNativeConfig({ schemaVersion: 1, options: { maxModelRequests: 10, maxToolCalls: 20, maxActiveMs: 60000 } }),
    forbiddenValues: ['sk-child-runner-protected'], approvals: approved, assertOwnership: async () => {} } };
}

/** Exercises the actual core and host tools/store; production uses the independent IPC worker. */
function inProcessWorker(generate: (request: ModelRequest, options: NativeWorkerOptions) => Promise<ModelResponse>) {
  return async (options: NativeWorkerOptions) => {
    const transport = createNativeModel(options.model), model: ModelPort = {
      protocol: transport.protocol, userItems: (input, images) => transport.userItems(input, images), toolResultItems: (call, result) => transport.toolResultItems(call, result),
      estimateInputTokens: context => transport.estimateInputTokens(context), generate: request => generate(request, options),
    };
    return runAgent({ ...options.request, signal: options.signal }, { model, tools: options.tools, store: options.store, approvals: options.approvals,
      host: { now: () => Date.now(), digest: input => createHash('sha256').update(input).digest('hex'),
        deadline: (milliseconds, parent) => {
          const abort = new AbortController(), cancel = () => abort.abort();
          const timer = setTimeout(cancel, milliseconds); parent.addEventListener('abort', cancel, { once: true }); if (parent.aborted) cancel();
          return { signal: abort.signal, dispose: () => { clearTimeout(timer); parent.removeEventListener('abort', cancel); } };
        }, consumeBudget: (options as NativeWorkerOptions & { consumeBudget?: (kind: 'model' | 'tool', identity: RunIdentity) => Promise<boolean> }).consumeBudget,
        emit: options.onEvent } });
  };
}

test('child runner persists a separate bound conversation/task and cannot access implementation/external/delegation tools', async t => {
  const f = await fixture(t); let count = 0;
  const result = await runNativeAgentChild(f.input, { ...f.options, worker: inProcessWorker(async (request, options) => {
    assert.deepEqual(request.identity, f.input.identity);
    assert.ok(request.context.items.every(item => !(item && typeof item === 'object' && !Array.isArray(item) && item.parentContext)));
    assert.ok(request.tools.every(tool => tool.risk === 'read'));
    for (const name of ['apply_patch', 'run_command', 'start_command', 'delegate_review', 'delegate_implement', 'ask_user']) assert.ok(!request.tools.some(tool => tool.name === name));
    await assert.rejects(async () => options.tools.prepare(call('apply_patch', { path: 'file.txt', content: 'wrong', expectedHash: null }),
      { identity: f.input.identity, policyRevision: options.request.policyRevision, signal: options.signal, maxOutputBytes: 65536 }), /只读/);
    return ++count === 1 ? tools(call('read_file', { path: 'file.txt' })) : completed();
  }) });
  assert.equal(result.status, 'completed'); assert.equal(result.committed, true); assert.equal(result.modelRequests, 2); assert.equal(result.toolCalls, 1);
  assert.match(result.summary, /独立检查/); assert.deepEqual(result.identity, f.input.identity); assert.equal(result.taskId, f.input.taskId);
  assert.equal(await fs.readFile(path.join(f.cwd, 'file.txt'), 'utf8'), 'initial\n');
  const task = await NativeTaskStore.readSnapshot({ rootDirectory: path.join(f.dataDirectory, 'native'), conversationId: f.input.identity.conversationId, sessionId: f.input.identity.sessionId });
  assert.equal(task?.taskId, f.input.taskId); assert.equal(task?.execution, 'ended'); assert.equal(task?.verification, 'unverified');
  assert.ok(await fs.stat(result.evidence!.taskSnapshotPath!)); assert.ok(await fs.stat(result.evidence!.runJournalPath!));
  const ledger = await NativeRunStore.open({ rootDirectory: path.join(f.dataDirectory, 'native', 'conversations'), conversationId: f.input.identity.conversationId });
  try { assert.deepEqual(ledger.getRun(f.input.identity.runId)?.result?.status, 'completed'); assert.equal(ledger.listRuns().length, 1); }
  finally { await ledger.close(); }
});

test('implementation uses exact write approvals and saves actual task evidence without accepting the task', async t => {
  const f = await fixture(t); f.input.toolPolicy = 'workspace_write'; let step = 0, approvalCount = 0;
  const expectedHash = createHash('sha256').update('initial\n').digest('hex');
  const result = await runNativeAgentChild(f.input, { ...f.options, approvals: { request: async request => {
    approvalCount++; assert.equal(request.tool.name, 'apply_patch'); assert.deepEqual(request.binding.runId, f.input.identity.runId);
    assert.equal(request.input.expectedHash, expectedHash); return approved.request(request, f.input.signal);
  } }, worker: inProcessWorker(async () => ++step === 1 ? tools(call('read_file', { path: 'file.txt' })) : step === 2 ?
    tools(call('apply_patch', { path: 'file.txt', content: 'child implementation\n', expectedHash })) : completed('已修改文件，等待父任务验收')) });
  assert.equal(result.status, 'completed'); assert.equal(result.toolCalls, 2); assert.equal(approvalCount, 1);
  assert.equal(await fs.readFile(path.join(f.cwd, 'file.txt'), 'utf8'), 'child implementation\n');
  const task = await NativeTaskStore.readSnapshot({ rootDirectory: path.join(f.dataDirectory, 'native'), conversationId: f.input.identity.conversationId, sessionId: f.input.identity.sessionId });
  assert.equal(task?.verification, 'unverified'); assert.equal(task?.review, undefined);
  assert.ok(task?.workspace?.changes.modified.includes('file.txt'));
});

test('production private worktree layout allows child reads/writes while keeping sibling host metadata outside the sandbox', async t => {
  const f = await fixture(t), childRoot = path.join(f.dataDirectory, 'native', 'agent-worktrees', randomUUID());
  await fs.mkdir(childRoot, { recursive: true }); await fs.writeFile(path.join(childRoot, 'file.txt'), 'initial\n');
  const metadata = path.join(f.dataDirectory, 'native', 'conversations'); await fs.mkdir(metadata, { recursive: true });
  await fs.writeFile(path.join(metadata, 'private.txt'), 'protected host metadata');
  await fs.symlink(metadata, path.join(childRoot, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  f.input.cwd = childRoot; f.input.toolPolicy = 'workspace_write'; let step = 0, approvedWrites = 0;
  const result = await runNativeAgentChild(f.input, { ...f.options, approvals: { request: async request => {
    approvedWrites++; assert.equal(request.tool.name, 'apply_patch'); return approved.request(request, f.input.signal);
  } }, worker: inProcessWorker(async (_request, options) => {
    const context = { identity: f.input.identity, policyRevision: options.request.policyRevision, signal: options.signal, maxOutputBytes: 65536 };
    await assert.rejects(options.tools.prepare(call('read_file', { path: '../../conversations/private.txt' }), context));
    await assert.rejects(options.tools.prepare(call('read_file', { path: 'escape/private.txt' }), context));
    return ++step === 1 ? tools(call('read_file', { path: 'file.txt' })) : step === 2 ? tools(call('apply_patch', {
      path: 'file.txt', content: 'authorized private child work\n', expectedHash: createHash('sha256').update('initial\n').digest('hex'),
    })) : completed();
  }) });
  assert.equal(result.status, 'completed'); assert.equal(result.committed, true); assert.equal(approvedWrites, 1);
  assert.equal(await fs.readFile(path.join(childRoot, 'file.txt'), 'utf8'), 'authorized private child work\n');
  assert.equal(await fs.readFile(path.join(metadata, 'private.txt'), 'utf8'), 'protected host metadata');
  const task = await NativeTaskStore.readSnapshot({ rootDirectory: path.join(f.dataDirectory, 'native'), conversationId: f.input.identity.conversationId, sessionId: f.input.identity.sessionId });
  assert.equal(task?.verification, 'unverified'); assert.ok(task?.workspace?.changes.modified.includes('file.txt'));
});

test('child runner forbids conversation/context replay and releases writers after settled completion', async t => {
  const f = await fixture(t); let workers = 0;
  const options = { ...f.options, worker: inProcessWorker(async () => { workers++; return completed(); }) };
  await runNativeAgentChild(f.input, options);
  await assert.rejects(runNativeAgentChild(f.input, options), /reused|replayed/);
  assert.equal(workers, 1);
  const tasks = await NativeTaskStore.open({ rootDirectory: path.join(f.dataDirectory, 'native'), conversationId: f.input.identity.conversationId, sessionId: f.input.identity.sessionId });
  await tasks.close();
});

test('worker crash preserves its own journal and task, releases resources, and never manufactures completed', async t => {
  const f = await fixture(t);
  await assert.rejects(runNativeAgentChild(f.input, { ...f.options, worker: async options => {
    await inProcessWorker(async () => { throw new Error('simulated transport failure'); })(options);
    throw new Error('simulated worker channel failure');
  } }));
  const ledger = await NativeRunStore.open({ rootDirectory: path.join(f.dataDirectory, 'native', 'conversations'), conversationId: f.input.identity.conversationId });
  try { assert.notEqual(ledger.getRun(f.input.identity.runId)?.result?.status, 'completed'); }
  finally { await ledger.close(); }
});

test('parent cancellation yields a committed child cancellation and retained evidence', async t => {
  const f = await fixture(t); let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const pending = runNativeAgentChild(f.input, { ...f.options, worker: inProcessWorker(request => new Promise((_resolve, reject) => {
    ready(); request.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
  })) });
  await started; f.abort.abort();
  const result = await pending; assert.equal(result.status, 'cancelled'); assert.equal(result.committed, true);
  assert.ok(await fs.stat(result.evidence!.runJournalPath!));
});

test('project instruction changes invalidate host tools and prevent later writes', async t => {
  const f = await fixture(t); f.input.toolPolicy = 'workspace_write';
  await fs.writeFile(path.join(f.cwd, 'AGENTS.md'), 'Initial instructions');
  let inspected = false;
  const result = await runNativeAgentChild(f.input, { ...f.options, worker: inProcessWorker(async (_request, options) => {
    await fs.writeFile(path.join(f.cwd, 'AGENTS.md'), 'Changed instructions');
    await assert.rejects(options.tools.prepare(call('apply_patch', { path: 'file.txt', content: 'forbidden', expectedHash: createHash('sha256').update('initial\n').digest('hex') }),
      { identity: f.input.identity, policyRevision: options.request.policyRevision, signal: options.signal, maxOutputBytes: 65536 }), /instructions changed/);
    inspected = true; return completed('指令已变，未继续写入');
  }) });
  assert.equal(result.status, 'completed'); assert.equal(inspected, true); assert.equal(await fs.readFile(path.join(f.cwd, 'file.txt'), 'utf8'), 'initial\n');
});

test('protected credentials and parent/child identity collisions are rejected before worker launch', async t => {
  const f = await fixture(t); let launched = false;
  const options = { ...f.options, worker: inProcessWorker(async () => { launched = true; return completed(); }) };
  await assert.rejects(runNativeAgentChild({ ...f.input, goal: 'sk-child-runner-protected' }, options));
  await assert.rejects(runNativeAgentChild({ ...f.input, identity: f.input.parentIdentity }, options), /identity/);
  assert.equal(launched, false);
});

test('runner refuses a synthetic worker success without its actual durable terminal receipt', async t => {
  const f = await fixture(t);
  await assert.rejects(runNativeAgentChild(f.input, { ...f.options, worker: async options => ({ identity: options.request.identity, status: 'completed', reason: 'fake',
    committed: true, modelRequests: 0, toolCalls: 0, usage: null, context: { protocol: { id: 'openai-responses', version: 1 }, items: [] } }) }), /durably confirmed/);
});

test('child host surfaces the same budget gate and rejects substituted identity before consuming quota', async t => {
  const f = await fixture(t); let consumed = 0;
  f.input.budget.consume = async (_kind, run) => { assert.deepEqual(run, f.input.identity); consumed++; return true; };
  await runNativeAgentChild(f.input, { ...f.options, worker: async options => {
    const budget = (options as NativeWorkerOptions & { consumeBudget: (kind: 'model' | 'tool', run: RunIdentity) => Promise<boolean> }).consumeBudget;
    assert.equal(typeof budget, 'function'); await assert.rejects(budget('model', identity()), /identity/);
    assert.equal(await budget('model', f.input.identity), true);
    return inProcessWorker(async () => completed())(options);
  } });
  assert.ok(consumed >= 1);
});

test('child command verification has an actual exit/output receipt linked to its own journal and task evidence', async t => {
  const f = await fixture(t); f.input.toolPolicy = 'workspace_write'; let step = 0;
  const result = await runNativeAgentChild(f.input, { ...f.options, worker: inProcessWorker(async () => ++step === 1 ?
    tools(call('run_command', { executable: process.execPath, argv: ['-e', 'process.stdout.write("child check")'], cwd: '.', timeoutMs: 10000, maxOutputBytes: 4096 })) : completed()) });
  assert.equal(result.status, 'completed'); assert.equal(result.evidence!.commandReceipts!.length, 1);
  const receipt = result.evidence!.commandReceipts![0]; assert.equal(receipt.status, 'completed'); assert.equal(receipt.exitCode, 0);
  assert.equal(receipt.receiptPath, result.evidence!.runJournalPath);
  const task = await NativeTaskStore.readSnapshot({ rootDirectory: path.join(f.dataDirectory, 'native'), conversationId: f.input.identity.conversationId, sessionId: f.input.identity.sessionId });
  assert.ok(task?.evidence.some(e => e.source === 'command' && e.exitCode === 0 && e.output?.includes('child check')));
  assert.equal(task?.verification, 'unverified');
});

test('unconfirmed physical worker cleanup is propagated so the parent retains a recovery barrier', async t => {
  const f = await fixture(t);
  await assert.rejects(runNativeAgentChild(f.input, { ...f.options, worker: async () => { throw new NativeWorkerCleanupError(); } }),
    error => error instanceof NativeWorkerCleanupError && error.cleanupUnconfirmed === true);
});

test('terminal display failure cannot rewrite the already committed child outcome', async t => {
  const f = await fixture(t);
  const result = await runNativeAgentChild(f.input, { ...f.options, worker: inProcessWorker(async () => completed()),
    onEvent: event => { if (event.type === 'run_finished') throw new Error('display unavailable'); } });
  assert.equal(result.status, 'completed'); assert.equal(result.committed, true);
});
