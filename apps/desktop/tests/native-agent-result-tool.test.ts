import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { canonicalJson, type PreparedTool, type RunIdentity, type ToolCall, type ToolExecutionContext, type ToolResult } from '@cc-desk/agent-core';
import { createAgentResultTools, type AgentResultToolOptions } from '../src/main/engines/native/agent-result-tool';
import { nativeAgentReceiptDirectory } from '../src/main/engines/native/agent-projection';
import { writeAgentReceipt } from '../src/main/engines/native/agent-artifacts';
import type { NativeDelegationReceipt } from '../src/main/engines/native/agent-delegation';

const identity = (): RunIdentity => ({ sessionId: randomUUID(), conversationId: randomUUID(), runId: randomUUID(), requestId: randomUUID(), workerGeneration: 1 });
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const call = (value: unknown, id: string = randomUUID()): ToolCall => ({ id, name: 'read_agent_result', arguments: JSON.stringify(value) });
const context = (current: RunIdentity, maxOutputBytes = 64 * 1024): ToolExecutionContext => ({ identity: current, maxOutputBytes, policyRevision: 'policy-1', signal: new AbortController().signal });
const outputBytes = (result: ToolResult) => Buffer.byteLength(canonicalJson(result.output));
type ResultOutput = { source: string; parentRunId: string; truncated?: boolean; omittedFields?: string[]; result: {
  acceptance: string; goal: string; agent: { childId: string; status: string; summary?: string; [key: string]: unknown };
  patch?: { text: string; offset: number; nextOffset: number | null; totalCharacters: number; sha256: string };
} };

async function fixture(t: { after(fn: () => Promise<void>): void }, options: { patch?: string; historical?: boolean } = {}) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'native-agent-result-tool-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const current = identity(), parent = options.historical ? { ...current, runId: randomUUID(), requestId: `历史请求：${'x'.repeat(150)}`, workerGeneration: 2 } : current;
  const child = identity(), batchId = randomUUID(), childId = randomUUID(), taskId = randomUUID();
  const file = path.join(nativeAgentReceiptDirectory(directory, parent), batchId, childId, 'receipt.json');
  const receipt: NativeDelegationReceipt = { version: 1, batchId, childId, taskId, identity: child, parentIdentity: parent, parentTaskId: 'parent-task',
    toolCallId: 'delegate-call', title: '独立审阅成果', goal: '检查变更并保留证据', mode: 'review', status: 'completed',
    createdAt: '2026-10-08T01:00:00.000Z', updatedAt: '2026-10-08T01:01:00.000Z', cwd: directory, receiptPath: file,
    result: { identity: child, taskId, status: 'completed', reason: 'model_completed', committed: true, summary: '子 Agent 建议，仍须父 Agent 验收', modelRequests: 2, toolCalls: 1 } };
  if (options.patch !== undefined) {
    receipt.mode = 'implement';
    receipt.artifact = { patchPath: path.join(path.dirname(file), 'workspace.diff.patch'), changedFiles: [{ path: 'answer.txt', status: 'A' }],
      head: 'a'.repeat(40), baseCommit: 'b'.repeat(40), sha256: hash(options.patch), bytes: Buffer.byteLength(options.patch) };
  }
  await writeAgentReceipt(file, receipt);
  if (receipt.artifact) await fs.writeFile(receipt.artifact.patchPath, options.patch!);
  const parents = new Map([[parent.runId, parent]]);
  const request = { parentRunId: parent.runId, childId };
  const port = (extra: Partial<AgentResultToolOptions> = {}) => createAgentResultTools({ dataDirectory: directory, identity: current, resolveParent: id => parents.get(id), ...extra });
  return { directory, current, parent, receipt, parents, request, port, context: context(current) };
}

test('read_agent_result is read-only, returns bound untrusted facts and never passes acceptance', async t => {
  const f = await fixture(t), port = f.port(), input = call(f.request);
  assert.equal(port.definitions.length, 1); assert.equal(port.definitions[0].risk, 'read');
  const before = await fs.readFile(f.receipt.receiptPath);
  const prepared = await port.prepare(input, f.context);
  assert.equal(prepared.requiresApproval, false); await port.validate(prepared, f.context);
  const result = await port.execute(prepared, f.context), output = result.output as unknown as ResultOutput;
  assert.equal(result.status, 'completed'); assert.equal(output.source, 'untrusted_agent_result');
  assert.equal(output.result.agent.childId, f.receipt.childId); assert.equal(output.result.agent.status, 'completed');
  assert.equal(output.result.agent.summary, f.receipt.result!.summary); assert.equal(output.result.goal, f.receipt.goal);
  assert.equal(output.result.acceptance, 'not_assessed'); assert.ok(outputBytes(result) <= f.context.maxOutputBytes);
  assert.deepEqual(await fs.readFile(f.receipt.receiptPath), before);
  output.result.goal = 'cannot mutate cached output';
  assert.equal(((await port.execute(prepared, f.context)).output as unknown as ResultOutput).result.goal, f.receipt.goal);
  assert.deepEqual(await port.prepare(input, f.context), prepared);
});

test('a later round may read a ledger-owned historical run only within its session and conversation', async t => {
  const f = await fixture(t, { historical: true }), port = f.port(), prepared = await port.prepare(call(f.request), f.context);
  assert.notEqual(f.parent.runId, f.current.runId);
  const output = (await port.execute(prepared, f.context)).output as unknown as ResultOutput;
  assert.equal(output.parentRunId, f.parent.runId); assert.equal(output.result.agent.childId, f.receipt.childId);
  for (const update of [{ sessionId: randomUUID() }, { conversationId: randomUUID() }, { runId: randomUUID() }]) {
    const foreign = f.port({ resolveParent: () => ({ ...f.parent, ...update }) });
    await assert.rejects(foreign.prepare(call(f.request), f.context), /账本/);
  }
  await assert.rejects(f.port({ resolveParent: () => undefined }).prepare(call(f.request), f.context));
});

test('forged worker identity cannot prepare, validate or execute a result capability', async t => {
  const f = await fixture(t), port = f.port(), prepared = await port.prepare(call(f.request), f.context);
  for (const key of ['sessionId', 'conversationId', 'runId', 'requestId', 'workerGeneration'] as const) {
    const altered = { ...f.current, [key]: key === 'workerGeneration' ? 2 : randomUUID() } as RunIdentity;
    const forged = { ...f.context, identity: altered };
    await assert.rejects(port.prepare(call(f.request), forged), /归属/);
    await assert.rejects(port.validate(prepared, forged), /归属/);
    assert.equal((await port.execute(prepared, forged)).status, 'not_executed');
  }
});

test('prepared references, policy and output allowance are exact bindings, not caller assertions', async t => {
  const f = await fixture(t), port = f.port(), input = call(f.request), prepared = await port.prepare(input, f.context);
  const modifications: Array<(value: PreparedTool) => void> = [
    value => { value.call.arguments = JSON.stringify({ ...f.request, patchOffset: 10 }); },
    value => { value.input.childId = randomUUID(); }, value => { value.inputDigest = 'f'.repeat(64); },
    value => { value.definition.risk = 'write'; }, value => { value.requiresApproval = true; },
    value => { value.preconditions = {}; }, value => { value.policyRevision = 'policy-2'; },
  ];
  for (const modify of modifications) {
    const altered = structuredClone(prepared); modify(altered);
    await assert.rejects(port.validate(altered, f.context));
    assert.equal((await port.execute(altered, f.context)).status, 'not_executed');
  }
  for (const altered of [{ ...f.context, policyRevision: 'policy-2' }, { ...f.context, maxOutputBytes: 2048 }]) {
    assert.equal((await port.execute(prepared, altered)).status, 'not_executed');
  }
  await assert.rejects(port.prepare(call({ ...f.request, patchOffset: 0 }, input.id), f.context), /标识已使用/);
  const tiny = await port.execute(prepared, { ...f.context, maxOutputBytes: 1 });
  assert.equal(tiny.status, 'not_executed'); assert.ok(outputBytes(tiny) <= 1);
});

test('changing a ledger identity after preparation revokes historical access', async t => {
  const f = await fixture(t, { historical: true }), port = f.port(), prepared = await port.prepare(call(f.request), f.context);
  f.parents.set(f.parent.runId, { ...f.parent, workerGeneration: f.parent.workerGeneration + 1 });
  await assert.rejects(port.validate(prepared, f.context), /归属已改变/);
  assert.deepEqual(await port.execute(prepared, f.context), { status: 'not_executed', output: { error: 'agent_result_preconditions_changed' } });
});

test('mutating a returned preparation cannot rewrite the private parent binding', async t => {
  const f = await fixture(t), port = f.port(), prepared = await port.prepare(call(f.request), f.context), original = structuredClone(prepared);
  (prepared.preconditions as unknown as { parentIdentity: RunIdentity }).parentIdentity.workerGeneration++;
  assert.equal((await port.execute(prepared, f.context)).status, 'not_executed');
  assert.equal((await port.execute(original, f.context)).status, 'completed');
});

test('malicious or ambiguous inputs are rejected before filesystem reads', async t => {
  const f = await fixture(t), port = f.port();
  for (const input of [null, [], { ...f.request, path: f.receipt.receiptPath }, { ...f.request, parentRunId: '..' },
    { ...f.request, childId: '../receipt.json' }, { ...f.request, patchOffset: -1 }, { ...f.request, patchOffset: 1.5 },
    { ...f.request, patchOffset: Number.MAX_SAFE_INTEGER + 1 }, { ...f.request, patchCharacters: 0 },
    { ...f.request, patchCharacters: 32001 }, { ...f.request, expectedPatchSha256: 'x'.repeat(64) },
    { ...f.request, expectedPatchSha256: 1 }, { ...f.request, patchCharacters: '100' }]) {
    await assert.rejects(port.prepare(call(input), f.context));
  }
  await assert.rejects(port.prepare({ ...call(f.request), arguments: '{broken' }, f.context));
  await assert.rejects(port.prepare({ ...call(f.request), arguments: JSON.stringify(f.request).slice(0, -1) + ',"__proto__":{}}' }, f.context));
  await assert.rejects(port.prepare({ ...call(f.request), name: 'read_file' }, f.context));
  await assert.rejects(port.prepare({ ...call(f.request), id: 'bad\0id' }, f.context));
  await assert.rejects(port.prepare({ ...call(f.request), arguments: ' '.repeat(16385) }, f.context));
  for (const cap of [0, 2047, NaN, Infinity, 2048.5]) await assert.rejects(port.prepare(call(f.request), { ...f.context, maxOutputBytes: cap }));
});

test('2048-byte pages make exact Unicode-safe forward progress and can reconstruct a patch', async t => {
  const patch = 'diff --git a/answer.txt b/answer.txt\n' + '+中文😀🧪\\"line\n'.repeat(350);
  const f = await fixture(t, { patch }), port = f.port(), scoped = context(f.current, 2048);
  f.receipt.goal = '保留目标😀'.repeat(500); f.receipt.result!.summary = '审阅建议中文😀'.repeat(1800);
  await writeAgentReceipt(f.receipt.receiptPath, f.receipt);
  let offset = 0, reconstructed = '', pages = 0;
  do {
    const prepared = await port.prepare(call({ ...f.request, patchOffset: offset, patchCharacters: 32000, expectedPatchSha256: hash(patch) }), scoped);
    const result = await port.execute(prepared, scoped), output = result.output as unknown as ResultOutput;
    assert.equal(result.status, 'completed'); assert.ok(outputBytes(result) <= scoped.maxOutputBytes);
    assert.equal(output.result.acceptance, 'not_assessed'); assert.equal(output.truncated, true); assert.equal(result.truncated, true);
    assert.ok(output.omittedFields!.length > 0); const page = output.result.patch!;
    assert.equal(page.offset, offset); assert.equal(page.sha256, hash(patch)); assert.equal(page.totalCharacters, patch.length);
    assert.ok(page.text.length > 0); assert.equal(Buffer.from(page.text).toString('utf8'), page.text);
    reconstructed += page.text; pages++;
    if (page.nextOffset === null) break;
    assert.equal(page.nextOffset, offset + page.text.length); assert.ok(page.nextOffset > offset); offset = page.nextOffset;
    assert.ok(pages < 80);
  } while (true);
  assert.ok(pages > 1); assert.equal(reconstructed, patch);
});

test('large metadata is explicitly omitted and never turns a file path into a partial reference', async t => {
  const f = await fixture(t, { patch: '+hello\n' });
  f.receipt.cwd = path.join(f.directory, 'x'.repeat(20000));
  f.receipt.artifact!.changedFiles = Array.from({ length: 128 }, (_, i) => ({ path: `src/${i}-${'中文'.repeat(200)}.txt`, status: 'M' }));
  f.receipt.result!.summary = '建议仍未验收'.repeat(2000);
  await writeAgentReceipt(f.receipt.receiptPath, f.receipt);
  const port = f.port(), scoped = context(f.current, 2048), prepared = await port.prepare(call(f.request), scoped);
  const result = await port.execute(prepared, scoped), output = result.output as unknown as ResultOutput;
  assert.equal(result.status, 'completed'); assert.ok(outputBytes(result) <= scoped.maxOutputBytes);
  assert.equal(output.result.agent.cwd, undefined); assert.ok(output.omittedFields!.includes('result.agent.cwd'));
  assert.equal(output.result.patch!.text, '+hello\n'); assert.equal(output.result.patch!.nextOffset, null);
  assert.equal(output.result.agent.status, 'completed'); assert.equal(output.result.acceptance, 'not_assessed');
});

test('patch hashes prevent changed-page replay and integrity failures retain the original files', async t => {
  const f = await fixture(t, { patch: '+original\n' }), port = f.port();
  let prepared = await port.prepare(call({ ...f.request, expectedPatchSha256: '0'.repeat(64) }), f.context);
  assert.deepEqual(await port.execute(prepared, f.context), { status: 'failed', output: { error: 'patch_revision_mismatch' } });
  prepared = await port.prepare(call({ ...f.request, expectedPatchSha256: hash('+original\n') }), f.context);
  await fs.writeFile(f.receipt.artifact!.patchPath, '+changed\n');
  assert.deepEqual(await port.execute(prepared, f.context), { status: 'failed', output: { error: 'patch_integrity_mismatch' } });
  assert.equal(await fs.readFile(f.receipt.artifact!.patchPath, 'utf8'), '+changed\n');
  assert.equal(await fs.readFile(f.receipt.receiptPath, 'utf8'), `${JSON.stringify(f.receipt, null, 2)}\n`);
});

test('credentials anywhere in the full patch or receipt block disclosure before truncation', async t => {
  const secret = 'fixture-protected-value-' + randomUUID(), patch = '+visible\n'.repeat(3000) + secret;
  const f = await fixture(t, { patch }), port = f.port({ forbiddenValues: [secret] });
  const prepared = await port.prepare(call({ ...f.request, patchCharacters: 1 }), f.context), result = await port.execute(prepared, f.context);
  assert.deepEqual(result, { status: 'failed', output: { error: 'protected_value' } }); assert.ok(!JSON.stringify(result).includes(secret));
  f.receipt.artifact = undefined; f.receipt.result!.summary = secret;
  await writeAgentReceipt(f.receipt.receiptPath, f.receipt);
  assert.deepEqual(await port.execute(await port.prepare(call(f.request), f.context), f.context), { status: 'failed', output: { error: 'protected_value' } });
});

test('result lookup refuses guessed children and forged artifact references without disclosing external data', async t => {
  const f = await fixture(t, { patch: '+safe\n' }), port = f.port();
  assert.deepEqual(await port.execute(await port.prepare(call({ ...f.request, childId: randomUUID() }), f.context), f.context),
    { status: 'failed', output: { error: 'result_not_found' } });
  const external = path.join(f.directory, 'external.patch'); await fs.writeFile(external, 'external data'); f.receipt.artifact!.patchPath = external;
  await writeAgentReceipt(f.receipt.receiptPath, f.receipt);
  const result = await port.execute(await port.prepare(call(f.request), f.context), f.context);
  assert.deepEqual(result, { status: 'failed', output: { error: 'receipt_invalid' } });
  assert.ok(!JSON.stringify(result).includes('external data')); assert.equal(await fs.readFile(external, 'utf8'), 'external data');
});

test('cancellation or lost ownership during a read prevents publishing the observed result', async t => {
  for (const mode of ['cancel', 'ownership'] as const) {
    const f = await fixture(t), abort = new AbortController(), scoped = { ...f.context, signal: abort.signal }; let checks = 0;
    const port = f.port({ assertOwnership: async () => {
      checks++; if (checks !== 4) return;
      if (mode === 'cancel') abort.abort(); else throw new Error('private ownership error');
    } });
    const prepared = await port.prepare(call(f.request), scoped), result = await port.execute(prepared, scoped);
    assert.equal(checks, 4); assert.deepEqual(result, { status: 'not_executed', output: { error: 'agent_result_preconditions_changed' } });
    assert.ok(!JSON.stringify(result).includes(f.receipt.goal)); assert.ok(!JSON.stringify(result).includes('private ownership error'));
  }
});

test('cached observations still recheck the current consumer ownership after awaiting a result', async t => {
  const f = await fixture(t); let checks = 0;
  const port = f.port({ assertOwnership: async () => { if (++checks === 6) throw new Error('lost consumer ownership'); } });
  const prepared = await port.prepare(call(f.request), f.context);
  assert.equal((await port.execute(prepared, f.context)).status, 'completed'); assert.equal(checks, 4);
  assert.deepEqual(await port.execute(prepared, f.context), { status: 'not_executed', output: { error: 'agent_result_preconditions_changed' } });
  assert.equal(checks, 6);
});

test('unknown child lifecycle stays unknown when its retained facts are successfully read', async t => {
  const f = await fixture(t); f.receipt.status = 'running'; delete f.receipt.result; await writeAgentReceipt(f.receipt.receiptPath, f.receipt);
  const port = f.port(), result = await port.execute(await port.prepare(call(f.request), f.context), f.context), output = result.output as unknown as ResultOutput;
  assert.equal(result.status, 'completed'); assert.equal(output.result.agent.status, 'unknown'); assert.equal(output.result.agent.missingTerminal, true);
  assert.equal(output.result.acceptance, 'not_assessed'); assert.equal(JSON.parse(await fs.readFile(f.receipt.receiptPath, 'utf8')).status, 'running');
});

test('concurrent preparations cannot exceed the per-worker receipt cache limit', async t => {
  const f = await fixture(t), port = f.port({ assertOwnership: async () => { await Promise.resolve(); } });
  const settled = await Promise.allSettled(Array.from({ length: 201 }, () => port.prepare(call(f.request), f.context)));
  assert.equal(settled.filter(result => result.status === 'fulfilled').length, 200);
  assert.equal(settled.filter(result => result.status === 'rejected').length, 1);
});
