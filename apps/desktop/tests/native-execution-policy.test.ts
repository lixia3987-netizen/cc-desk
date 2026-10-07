import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { RunResult, ToolPort, PreparedTool } from '@cc-desk/agent-core';
import { parseNativeExecutionPolicy, restrictNativeTools } from '../src/main/engines/native/execution-policy';
import { nativeExecutionReceipt, readNativeExecutionReceipt, saveNativeExecutionReceipt } from '../src/main/engines/native/execution-receipt';
import { NativeAggregateBudget } from '../src/main/engines/native/aggregate-budget';

test('read-only stages enforce a local allowlist on all three host tool entry points', async () => {
  let calls = 0;
  const port = { definitions: [
    { name: 'read_file', risk: 'read', description: '', inputSchema: {} },
    { name: 'apply_patch', risk: 'write', description: '', inputSchema: {} },
    { name: 'run_command', risk: 'command', description: '', inputSchema: {} },
    { name: 'mcp__remote__read', risk: 'read', description: '', inputSchema: {} },
  ], prepare() { calls++; }, validate() { calls++; }, execute() { calls++; } } as unknown as ToolPort;
  const restricted = restrictNativeTools(port, { toolPolicy: 'read_only' });
  assert.deepEqual(restricted.definitions.map(item => item.name), ['read_file']);
  for (const name of ['apply_patch', 'run_command', 'mcp__remote__read']) {
    assert.throws(() => restricted.prepare({ id: 'call', name, arguments: '{}' }, {} as never), /仅允许本地只读/);
    assert.throws(() => restricted.validate({ call: { name } } as PreparedTool, {} as never), /仅允许本地只读/);
    assert.throws(() => restricted.execute({ call: { name } } as PreparedTool, {} as never), /仅允许本地只读/);
  }
  assert.equal(calls, 0);
});
test('invalid stage ceilings and recursive delegation identities are rejected before execution', () => {
  assert.throws(() => parseNativeExecutionPolicy({ toolPolicy: 'read_only', budget: { maxModelRequests: 0, maxToolCalls: 10, maxActiveMs: 1000 } }));
  assert.throws(() => parseNativeExecutionPolicy({ toolPolicy: 'standard', parent: { sessionId: randomUUID(), runId: randomUUID(), taskId: randomUUID(), depth: 2 } }));
  assert.equal(parseNativeExecutionPolicy(undefined), undefined);
});
test('execution receipts remain immutable across duplicate dispatch and cannot bind a different run', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'native-receipt-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const result = { identity: { sessionId: randomUUID(), conversationId: randomUUID(), runId: randomUUID(), requestId: randomUUID(), workerGeneration: 1 },
    status: 'completed', reason: 'model_completed', modelRequests: 2, toolCalls: 1, committed: true, usage: null,
    context: { protocol: { id: 'anthropic-messages', version: 1 }, items: [] } } as RunResult;
  const receipt = nativeExecutionReceipt(result, null, 19.4);
  await saveNativeExecutionReceipt(directory, receipt);
  assert.deepEqual(await readNativeExecutionReceipt(directory, result), receipt);
  await assert.rejects(saveNativeExecutionReceipt(directory, { ...receipt, usage: { ...receipt.usage, activeMs: 999 } }), { code: 'EEXIST' });
  assert.equal((await readNativeExecutionReceipt(directory, result))?.usage.activeMs, 20);
  await assert.rejects(readNativeExecutionReceipt(directory, { ...result, identity: { ...result.identity, sessionId: randomUUID() } }), /不匹配/);
});
test('parent and parallel children cannot overdraw shared request capacity', async () => {
  const identity = { sessionId: randomUUID(), conversationId: randomUUID(), runId: randomUUID(), requestId: randomUUID(), workerGeneration: 1 };
  const child = { ...identity, sessionId: randomUUID(), conversationId: randomUUID(), runId: randomUUID() };
  const budget = new NativeAggregateBudget({ maxModelRequests: 3, maxToolCalls: 2 }, new AbortController().signal, () => 1000);
  budget.register(identity); const release = budget.register(child);
  const results = await Promise.all(Array.from({ length: 20 }, (_, index) => budget.consume('model', index % 2 ? identity : child)));
  assert.equal(results.filter(Boolean).length, 3);
  assert.equal(await budget.consume('tool', child), true);
  assert.equal(await budget.consume('tool', identity), true);
  assert.equal(await budget.consume('tool', child), false);
  assert.deepEqual(budget.snapshot(), { modelRequests: 3, toolCalls: 2 });
  release(); await assert.rejects(budget.consume('model', child), /身份已失效/);
});
test('shared deadline and parent cancellation prevent any further reservation', async () => {
  const identity = { sessionId: randomUUID(), conversationId: randomUUID(), runId: randomUUID(), requestId: randomUUID(), workerGeneration: 1 };
  const controller = new AbortController(); let remaining = 10;
  const budget = new NativeAggregateBudget({ maxModelRequests: 5, maxToolCalls: 5 }, controller.signal, () => remaining);
  budget.register(identity); remaining = 0;
  assert.equal(await budget.consume('model', identity), false);
  remaining = 10; controller.abort(); assert.equal(await budget.consume('tool', identity), false);
  assert.deepEqual(budget.snapshot(), { modelRequests: 0, toolCalls: 0 });
});
