import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { applyNativeTaskUpdate, type PreparedTool, type ToolExecutionContext } from '@cc-desk/agent-core';
import type { NativeTaskPlan, NativeTaskSnapshot, NativeTaskUpdate } from '@cc-desk/contracts/native-task';
import { createNativeTaskTool } from '../src/main/engines/native/task-tool';

const secret = 'sk-native-task-tool-secret-never-record';
const plan = (): NativeTaskPlan => ({ goal: '修复任务状态刷新', steps: [
  { id: 'investigate', title: '分析状态来源', dependsOn: [], status: 'in_progress' },
  { id: 'fix', title: '实现并检查状态同步', dependsOn: ['investigate'], status: 'pending' },
], criteria: [{ id: 'sync-test', description: '丢事件及乱序回归通过', stepIds: ['fix'], kind: 'command' },
  { id: 'ui-review', description: '人工核对重启后的界面状态', stepIds: ['fix'], kind: 'manual' }] });
function fixture(options: { onApply?: () => Promise<void>; onGuard?: (count: number) => void | Promise<void>; onCommitted?: (f: ReturnType<typeof fixture>) => Promise<void> } = {}) {
  const identity = { sessionId: 'session', conversationId: randomUUID(), runId: randomUUID(), requestId: 'request', workerGeneration: 1 };
  const taskId = randomUUID(), abort = new AbortController();
  const context: ToolExecutionContext = { identity, policyRevision: 'project-instructions-1', signal: abort.signal, maxOutputBytes: 64 * 1024 };
  let task: NativeTaskSnapshot | undefined, guardCount = 0, applyCount = 0;
  const updates: NativeTaskUpdate[] = [];
  const store = { read: (id: string) => id === taskId && task ? structuredClone(task) : undefined,
    async apply(update: NativeTaskUpdate) {
      applyCount++; await options.onApply?.();
      task = applyNativeTaskUpdate(task ?? null, update, new Date().toISOString());
      updates.push(structuredClone(update)); return structuredClone(task);
    },
  };
  const tool = createNativeTaskTool({ identity, taskId, forbiddenValues: [secret], store,
    assertOwnership: async () => { guardCount++; await options.onGuard?.(guardCount); },
    onCommitted: async () => { await options.onCommitted?.(f); },
  });
  const f = { identity, taskId, abort, context, tool, store, updates,
    get task() { return task; }, get guardCount() { return guardCount; }, get applyCount() { return applyCount; },
    replace(snapshot: NativeTaskSnapshot | undefined) { task = snapshot; },
    async prepare(input: unknown = { expectedRevision: 0, plan: plan() }, id = 'plan-1', name = 'update_plan') {
      return tool.prepare({ id, name, arguments: JSON.stringify(input) }, context);
    },
    async execute(input: unknown = { expectedRevision: 0, plan: plan() }, id = 'plan-1', name = 'update_plan') {
      const prepared = await f.prepare(input, id, name); await tool.validate(prepared, context); return tool.execute(prepared, context);
    },
  };
  return f;
}

test('task tools create no plan for simple reads and only persist model declarations', async () => {
  const f = fixture();
  assert.deepEqual((await f.execute({}, 'read-empty', 'read_task')).output, { task: null, expectedRevision: 0 });
  assert.equal(f.applyCount, 0); assert.equal(Boolean(f.task), false);
  const prepared = await f.prepare({ expectedRevision: 0, plan: plan(), explanation: '先稳定状态来源，再修改界面。' });
  assert.equal(prepared.requiresApproval, false); assert.equal(prepared.definition.risk, 'read');
  assert.equal(prepared.preconditions && typeof prepared.preconditions === 'object' && !Array.isArray(prepared.preconditions) ? prepared.preconditions.taskId : undefined, f.taskId);
  await f.tool.validate(prepared, f.context);
  const result = await f.tool.execute(prepared, f.context);
  assert.equal(result.status, 'completed'); assert.equal(f.applyCount, 1); assert.equal(f.task?.verification, 'unverified');
  assert.deepEqual(f.task?.identity, f.identity); assert.deepEqual(f.task?.evidence, []);
  assert.equal(f.task?.history.at(-1)?.summary, '先稳定状态来源，再修改界面。');
  const next = plan(); next.steps = next.steps.map(step => ({ ...step, status: 'implemented' }));
  assert.equal((await f.execute({ expectedRevision: 1, plan: next }, 'plan-2')).status, 'completed');
  assert.equal(f.task?.verification, 'unverified', 'implemented never fabricates test evidence');
});

test('task plans reject injected identity, verification, unsupported statuses, invalid dependencies and oversized content', async () => {
  const f = fixture(), base = { expectedRevision: 0, plan: plan() };
  const invalid: unknown[] = [
    { ...base, taskId: randomUUID() }, { ...base, identity: f.identity }, { ...base, verification: 'passed' },
    { ...base, plan: { ...plan(), evidence: [] } }, { ...base, expectedRevision: -1 },
    { ...base, plan: { ...plan(), goal: ' trim me ' } },
    { ...base, plan: { ...plan(), goal: secret } }, { ...base, explanation: secret },
    { ...base, plan: { ...plan(), steps: [{ ...plan().steps[0], status: 'passed' }] } },
    { ...base, plan: { ...plan(), steps: [{ ...plan().steps[0], status: 'interrupted' }] } },
    { ...base, plan: { ...plan(), steps: [{ ...plan().steps[0], status: 'blocked' }] } },
    { ...base, plan: { ...plan(), steps: [plan().steps[0], plan().steps[0]] } },
    { ...base, plan: { ...plan(), steps: [ { ...plan().steps[0], dependsOn: ['fix'] }, plan().steps[1] ] } },
    { ...base, plan: { ...plan(), steps: [ { ...plan().steps[0], dependsOn: ['missing'] }, plan().steps[1] ] } },
    { ...base, plan: { ...plan(), criteria: [{ ...plan().criteria[0], stepIds: ['missing'] }] } },
    { ...base, plan: { ...plan(), steps: Array.from({ length: 33 }, (_, i) => ({ id: `step-${i}`, title: 'x', dependsOn: [], status: 'pending' })) } },
  ];
  for (const [index, input] of invalid.entries()) await assert.rejects(f.prepare(input, `bad-${index}`));
  await assert.rejects(f.tool.prepare({ id: 'oversized', name: 'update_plan', arguments: ' '.repeat(32 * 1024 + 1) }, f.context));
  await assert.rejects(f.tool.prepare({ id: 'bad\0id', name: 'read_task', arguments: '{}' }, f.context));
  await assert.rejects(f.tool.prepare({ id: 'unknown', name: 'write_task', arguments: '{}' }, f.context));
  assert.equal(f.applyCount, 0);
});

test('stale plan revisions cannot overwrite a committed plan, including a revision changed after preparation', async () => {
  const f = fixture();
  await f.execute();
  await assert.rejects(f.prepare({ expectedRevision: 0, plan: plan() }, 'stale'), /修订/);
  const pending = await f.prepare({ expectedRevision: 1, plan: plan() }, 'will-stale');
  await f.execute({ expectedRevision: 1, plan: { ...plan(), goal: '新目标' } }, 'updated');
  await assert.rejects(f.tool.validate(pending, f.context), /修订/);
  assert.equal((await f.tool.execute(pending, f.context)).status, 'not_executed');
  assert.equal(f.task?.goal, '新目标'); assert.equal(f.task?.revision, 2); assert.equal(f.applyCount, 2);
});

test('exact call preparation and concurrent execution are idempotent, while substituted bindings fail', async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const f = fixture({ onApply: () => held }), prepared = await f.prepare();
  assert.deepEqual(await f.prepare(), prepared);
  await assert.rejects(f.prepare({ expectedRevision: 0, plan: { ...plan(), goal: '替换目标' } }), /标识/);
  for (const forged of [{ ...prepared, inputDigest: 'forged' }, { ...prepared, requiresApproval: true },
    { ...prepared, preconditions: { taskId: randomUUID() } }, { ...prepared, input: { ...prepared.input, expectedRevision: 5 } },
    { ...prepared, definition: { ...prepared.definition, description: 'forged' } }] as PreparedTool[]) {
    await assert.rejects(f.tool.validate(forged, f.context));
    assert.equal((await f.tool.execute(forged, f.context)).status, 'not_executed');
  }
  const a = f.tool.execute(prepared, f.context), b = f.tool.execute(prepared, f.context);
  release(); const results = await Promise.all([a, b]);
  assert.deepEqual(results[0], results[1]); assert.equal(f.applyCount, 1);
  assert.deepEqual(await f.tool.execute(prepared, f.context), results[0]); assert.equal(f.applyCount, 1);
  assert.equal(f.updates[0].mutationId.length <= 256, true);
});

test('ownership, project instructions, cancellation, policy and output binding are rechecked before mutation', async () => {
  const f = fixture(), prepared = await f.prepare();
  for (const context of [{ ...f.context, identity: { ...f.identity, workerGeneration: 2 } },
    { ...f.context, policyRevision: 'changed' }, { ...f.context, maxOutputBytes: 1 }]) {
    await assert.rejects(f.tool.validate(prepared, context));
    assert.equal((await f.tool.execute(prepared, context)).status, 'not_executed');
  }
  f.abort.abort();
  assert.equal((await f.tool.execute(prepared, f.context)).status, 'not_executed'); assert.equal(f.applyCount, 0);
  let changed = false;
  const g = fixture({ onGuard: () => { if (changed) throw new Error('CLAUDE.md changed'); } }), other = await g.prepare();
  changed = true;
  await assert.rejects(g.tool.validate(other, g.context), /CLAUDE/);
  assert.equal((await g.tool.execute(other, g.context)).status, 'not_executed'); assert.equal(g.applyCount, 0);
});

test('cancellation during ownership recheck and a task rebound to another run never write', async () => {
  let abortOnGuard = false;
  const f = fixture({ onGuard: () => { if (abortOnGuard) f.abort.abort(); } }), prepared = await f.prepare();
  abortOnGuard = true;
  assert.equal((await f.tool.execute(prepared, f.context)).status, 'not_executed'); assert.equal(f.applyCount, 0);
  const g = fixture(); await g.execute();
  const read = await g.prepare({}, 'read', 'read_task');
  g.replace({ ...g.task!, identity: { ...g.identity, runId: randomUUID() } });
  assert.equal((await g.tool.execute(read, g.context)).status, 'not_executed'); assert.equal(g.applyCount, 1);
});

test('write or post-commit observation uncertainty stops the runtime instead of claiming success or retrying', async () => {
  const f = fixture({ onApply: async () => { throw new Error(secret); } }), prepared = await f.prepare();
  const result = await f.tool.execute(prepared, f.context);
  assert.equal(result.status, 'unknown'); assert.equal(JSON.stringify(result).includes(secret), false);
  assert.deepEqual(await f.tool.execute(prepared, f.context), result); assert.equal(f.applyCount, 1);
  const g = fixture({ onCommitted: async () => { throw new Error('projection observation failed'); } });
  assert.equal((await g.execute()).status, 'unknown'); assert.equal(g.task?.revision, 1);
});

test('update receipt reports the newest durable revision after host observation', async () => {
  const f = fixture({ onCommitted: async g => { await g.store.apply({ identity: g.identity, taskId: g.taskId,
    mutationId: 'host-observation', expectedRevision: g.task!.revision, mutation: { type: 'invalidate', reason: 'workspace changed' } }); } });
  const result = await f.execute();
  assert.equal(result.status, 'completed'); assert.equal((result.output as { revision: number }).revision, 2);
  assert.equal(f.task?.revision, 2);
});

test('read_task returns bounded evidence/history pages without copying command logs', async () => {
  const f = fixture(); await f.execute();
  const now = new Date().toISOString(), task = f.task!;
  f.replace({ ...task, evidence: Array.from({ length: 25 }, (_, i) => ({ id: `e-${i}`, identity: f.identity, stepIds: ['fix'], criterionIds: ['sync-test'],
    source: 'command', status: 'unverified', planRevision: 1, acceptanceRevision: 1, workspaceFingerprint: 'a'.repeat(64), workspaceComplete: true,
    toolCallId: `command-${i}`, output: 'PRIVATE_VERBOSE_LOG', createdAt: now })),
    history: Array.from({ length: 25 }, (_, i) => ({ revision: i + 1, mutationId: `m-${i}`, kind: 'plan', runId: f.identity.runId, at: now, summary: `step ${i}` })),
  });
  const result = await f.execute({ evidenceOffset: 10, historyOffset: 20, limit: 5 }, 'read-page', 'read_task');
  const output = result.output as { task: { evidence: { id: string }[]; history: unknown[]; nextEvidenceOffset: number; nextHistoryOffset: null } };
  assert.equal(result.status, 'completed'); assert.equal(output.task.evidence.length, 5); assert.equal(output.task.evidence[0].id, 'e-10');
  assert.equal(output.task.history.length, 5); assert.equal(output.task.nextEvidenceOffset, 15); assert.equal(output.task.nextHistoryOffset, null);
  assert.equal(JSON.stringify(result).includes('PRIVATE_VERBOSE_LOG'), false);
  await assert.rejects(f.prepare({ limit: 21 }, 'too-much', 'read_task'));
  await assert.rejects(f.prepare({ taskId: randomUUID() }, 'other-task', 'read_task'));
});

test('task tool output limits and credentials never leak snapshots or create partial writes', async () => {
  const f = fixture();
  await assert.rejects(f.tool.prepare({ id: 'tiny', name: 'update_plan', arguments: JSON.stringify({ expectedRevision: 0, plan: plan() }) }, { ...f.context, maxOutputBytes: 50 }));
  assert.equal(f.applyCount, 0);
  await f.execute();
  f.replace({ ...f.task!, goal: secret });
  const result = await f.execute({}, 'read-secret', 'read_task');
  assert.equal(result.status, 'failed'); assert.equal(JSON.stringify(result).includes(secret), false);
  f.replace({ ...f.task!, goal: 'long'.repeat(1000) });
  const small = { ...f.context, maxOutputBytes: 1024 };
  const prepared = await f.tool.prepare({ id: 'small-page', name: 'read_task', arguments: '{}' }, small);
  const limited = await f.tool.execute(prepared, small);
  assert.equal(limited.status, 'failed'); assert.match(JSON.stringify(limited), /budget/);
});

test('task metadata cache is bounded without evicting earlier exactly-once receipts', async () => {
  const f = fixture();
  for (let i = 0; i < 200; i++) await f.prepare({}, `read-${i}`, 'read_task');
  await assert.rejects(f.prepare({}, 'read-201', 'read_task'), /缓存/);
  assert.equal((await f.prepare({}, 'read-0', 'read_task')).call.id, 'read-0');
});
