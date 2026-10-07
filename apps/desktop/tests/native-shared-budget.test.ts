import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { fork } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import type { RunIdentity, ToolPort } from '@cc-desk/agent-core';
import { NativeRunStore } from '@cc-desk/agent-node/run-store';
import { runNativeWorker, type NativeWorkerChild, type NativeWorkerFork } from '../src/main/engines/native/worker-host';
import { NativeAggregateBudget } from '../src/main/engines/native/aggregate-budget';
// @ts-expect-error Shared loopback protocol fixture has no declarations.
import { startResponsesFixture, functionCall, assistantMessage } from '../../../packages/agent-node/tests/fixtures/responses-server.mjs';

const definition = { name: 'read_file', description: 'Read fixture state', inputSchema: { type: 'object', properties: {} }, risk: 'read' } as const;
async function fixture(t: TestContext, toolCall = false) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-shared-budget-'));
  const bundle = path.join(directory, 'worker.cjs'), shim = path.join(directory, 'parent-port.cjs');
  await build({ entryPoints: [fileURLToPath(new URL('../src/main/engines/native/worker-entry.ts', import.meta.url))], outfile: bundle,
    bundle: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'silent' });
  await fs.writeFile(shim, `const {EventEmitter}=require('node:events');
const port=new EventEmitter();port.postMessage=value=>process.send(value);
process.parentPort=port;process.on('message',data=>port.emit('message',{data}));require(process.argv[2]);\n`);
  const server = await startResponsesFixture({ assertReplay: false, handler: () => ({ output: toolCall
    ? [functionCall('read', 'read_file', {})] : [assistantMessage('done', 'Complete')] }) });
  const ledgers: NativeRunStore[] = [], children: import('node:child_process').ChildProcess[] = [];
  t.after(async () => { for (const child of children) if (child.exitCode === null) child.kill();
    for (const ledger of ledgers) await ledger.close(); await server.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const physicalFork: NativeWorkerFork = (_file, _args, options) => {
    const child = fork(shim, [bundle], { execPath: process.execPath, env: options.env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    children.push(child);
    const adapter = Object.assign(new EventEmitter(), { pid: child.pid, stdout: child.stdout, stderr: child.stderr,
      postMessage: (message: unknown) => { child.send(message as never); }, kill: () => child.kill() });
    child.on('message', message => adapter.emit('message', message)); child.on('exit', code => adapter.emit('exit', code));
    child.on('error', error => adapter.emit('error', error));
    return adapter as NativeWorkerChild;
  };
  let prepared = 0, executed = 0;
  const tools: ToolPort = { definitions: [definition], prepare: async (call, context) => { prepared++; const input = JSON.parse(call.arguments);
    return { call, definition, input, inputDigest: createHash('sha256').update(JSON.stringify(input)).digest('hex'),
      policyRevision: context.policyRevision, requiresApproval: false, preconditions: {} }; },
    validate: async () => {}, execute: async () => { executed++; return { status: 'completed', output: 'read result' }; } };
  async function worker(consumeBudget: (kind: 'model' | 'tool', identity: RunIdentity) => Promise<boolean>) {
    const identity: RunIdentity = { sessionId: randomUUID(), conversationId: randomUUID(), runId: randomUUID(), requestId: randomUUID(), workerGeneration: 1 };
    const store = await NativeRunStore.open({ rootDirectory: directory, conversationId: identity.conversationId }); ledgers.push(store);
    return { identity, store, run: () => runNativeWorker({ request: { identity, input: 'Check once', configuration: {}, policyRevision: 'policy',
        budget: { maxModelRequests: 5, maxToolCalls: 5, maxActiveMs: 10_000 } },
      model: { protocol: 'responses', baseURL: server.baseURL, model: 'fixture-model', allowLoopbackHttp: true },
      tools, store, approvals: { request: async () => { throw new Error('read operation must not ask approval'); } },
      consumeBudget, onEvent: () => {}, signal: new AbortController().signal, fork: physicalFork }) };
  }
  return { server, worker, get prepared() { return prepared; }, get executed() { return executed; } };
}

test('physical worker reserves shared model budget before its durable request marker or HTTP request', async t => {
  const f = await fixture(t), reservations: string[] = [];
  const worker = await f.worker(async kind => { reservations.push(kind); return false; });
  const result = await worker.run();
  assert.equal(result.status, 'budget_exhausted'); assert.match(result.reason, /budget/);
  assert.deepEqual(reservations, ['model']); assert.equal(f.server.requests.length, 0);
  assert.equal(worker.store.replay().some(record => record.event.type === 'model_request_started'), false);
  assert.equal(f.prepared, 0); assert.equal(f.executed, 0);
});

test('physical worker reserves shared tool budget before preparation, durable prepared markers and side effects', async t => {
  const f = await fixture(t, true), reservations: string[] = [];
  const worker = await f.worker(async kind => { reservations.push(kind); return kind === 'model'; });
  const result = await worker.run();
  assert.equal(result.status, 'budget_exhausted'); assert.match(result.reason, /budget/);
  assert.deepEqual(reservations, ['model', 'tool']); assert.equal(f.server.requests.length, 1);
  assert.equal(worker.store.replay().some(record => record.event.type === 'tool_prepared'), false);
  assert.equal(f.prepared, 0); assert.equal(f.executed, 0);
});

test('two physical workers cannot overdraw one host-owned model request allowance', async t => {
  const f = await fixture(t), budget = new NativeAggregateBudget({ maxModelRequests: 1, maxToolCalls: 5 }, new AbortController().signal, () => 10_000);
  const workers = await Promise.all([f.worker((kind, identity) => budget.consume(kind, identity)), f.worker((kind, identity) => budget.consume(kind, identity))]);
  const release = workers.map(worker => budget.register(worker.identity));
  try {
    const results = await Promise.all(workers.map(worker => worker.run()));
    assert.deepEqual(results.map(result => result.status).sort(), ['budget_exhausted', 'completed']);
    assert.equal(f.server.requests.length, 1); assert.deepEqual(budget.snapshot(), { modelRequests: 1, toolCalls: 0 });
    assert.equal(workers.flatMap(worker => worker.store.replay()).filter(record => record.event.type === 'model_request_started').length, 1);
    assert.deepEqual(f.server.errors, []);
  } finally { release.forEach(dispose => dispose()); }
});
