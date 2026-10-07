import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { NativeTaskEvidence, NativeTaskView } from '@cc-desk/contracts/native-task';
import type { ExecutionSubmission } from '../src/main/execution/ports';
import { WorkflowEngine, type WorkflowEngineOptions } from '../src/main/workflows';
import { workflowNativeReceiptSchema, workflowStateSchema, validateWorkflowState } from '../src/main/workflow-schema';
import type { WorkflowBinding, WorkflowNativeReceipt, WorkflowStageDefinition } from '../src/shared/workflows';

const at = new Date().toISOString(), fingerprint = 'a'.repeat(64);
const steps: WorkflowStageDefinition[] = [{ id: 'build', title: 'Build', instruction: 'Implement', dependsOn: [] }, { id: 'review', title: 'Review', instruction: 'Review', dependsOn: ['build'] }];
function fixture(patch: Partial<WorkflowEngineOptions> = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ccdesk-workflow-gates-'));
  const binding: WorkflowBinding = { sessionId: randomUUID(), providerId: 'native', executionMode: 'structured', projectId: randomUUID(), cwd: '/tmp/workflow-project' };
  const options: WorkflowEngineOptions = { getSession: () => binding, cancelSession: () => {}, runStage: async () => ({ success: true, summary: 'done' }), ...patch };
  const engine = new WorkflowEngine(directory, options);
  return { directory, binding, options, engine, dispose: () => fs.rmSync(directory, { recursive: true, force: true }) };
}
function receipt(binding: WorkflowBinding, submission: ExecutionSubmission, usage = { modelRequests: 2, toolCalls: 1, activeMs: 200 }): WorkflowNativeReceipt {
  return { version: 1, identity: { sessionId: binding.sessionId, conversationId: randomUUID(), runId: randomUUID(), requestId: submission.requestId, workerGeneration: 1 },
    taskId: randomUUID(), taskRevision: 1, planRevision: 1, acceptanceRevision: 1, verification: 'unverified',
    workspace: { fingerprint, complete: true, capturedAt: at },
    changes: { added: [], modified: ['src/app.ts'], removed: [], complete: true, truncated: false, attribution: 'observed_since_task_start' },
    criteria: [{ id: 'check', description: 'Check the implemented behavior', stepIds: ['build'], kind: 'command' }, { id: 'manual', description: 'Review unrelated coverage', stepIds: ['build'], kind: 'manual' }],
    evidence: [], usage, truncated: false };
}
function taskFor(value: WorkflowNativeReceipt, approved: string[] = []): NativeTaskView {
  const workspace = { fingerprint, complete: true, rootFingerprint: fingerprint, scope: ['.'], issues: [], capturedAt: at, fileCount: 1 };
  const evidence: NativeTaskEvidence[] = approved.map(id => ({ id: randomUUID(), identity: value.identity, source: 'manual', status: 'passed',
    stepIds: ['build'], criterionIds: [id], planRevision: 1, acceptanceRevision: 1, workspaceFingerprint: fingerprint, workspaceComplete: true, reason: 'Human checked coverage', createdAt: at }));
  return { schemaVersion: 1, taskId: value.taskId!, identity: value.identity, revision: 2, planRevision: 1, acceptanceRevision: 1,
    execution: 'ended', verification: 'unverified', goal: 'Implement behavior', steps: [{ id: 'build', title: 'Build', dependsOn: [], status: 'implemented' }],
    criteria: value.criteria, evidence, workspace: { baseline: workspace, current: workspace, changes: value.changes! }, history: [], createdAt: at, updatedAt: at };
}

test('manual confirmation persists separately from execution, rejects stale clicks and never repeats completed work', async () => {
  let calls = 0;
  const f = fixture({ runStage: async () => { calls++; return { success: true, summary: 'actual output' }; } });
  try {
    const run = f.engine.create({ sessionId: f.binding.sessionId, goal: 'Ship', stages: [{ ...steps[0], gate: 'manual' }, steps[1]] });
    f.engine.start(run.id);
    assert.equal((await f.engine.wait(run.id)).status, 'waiting_confirmation');
    assert.equal(calls, 1);
    const restored = new WorkflowEngine(f.directory, f.options);
    assert.equal(restored.list()[0].status, 'waiting_confirmation');
    assert.throws(() => restored.continue(run.id), /暂停或中断/);
    assert.throws(() => restored.reviseStage(run.id, 'build', 'Replace accepted requirements'), /等待验收/);
    assert.throws(() => restored.confirmStage({ id: run.id, stageId: 'build', expectedAttempt: 2, decision: 'approve', reason: 'checked' }), /状态已变化/);
    restored.confirmStage({ id: run.id, stageId: 'build', expectedAttempt: 1, decision: 'reject', reason: 'Need review' });
    assert.equal(restored.list()[0].status, 'waiting_confirmation');
    assert.equal(calls, 1);
    const confirmed = restored.confirmStage({ id: run.id, stageId: 'build', expectedAttempt: 1, decision: 'approve', reason: 'Checked output' });
    assert.equal(confirmed.status, 'paused');
    restored.continue(run.id);
    assert.equal((await restored.wait(run.id)).status, 'completed');
    assert.equal(calls, 2);
    assert.deepEqual(restored.list()[0].stages.map(stage => stage.attempts), [1, 1]);
  } finally { f.dispose(); }
});

test('Native gates inspect the exact receipt and selected criteria without requiring every task criterion to pass', async () => {
  let value!: WorkflowNativeReceipt, inspected!: WorkflowNativeReceipt, calls = 0;
  const f = fixture({ runStage: async (_id, _prompt, _title, submission) => { calls++; value = receipt(f.binding, submission!); return { success: true, summary: 'Output', nativeReceipt: value }; },
    inspectNativeTask: async input => { inspected = input; return taskFor(value, ['check']); } });
  try {
    const run = f.engine.create({ sessionId: f.binding.sessionId, goal: 'Ship', stages: [{ ...steps[0], gate: 'native_task', criterionIds: ['check'] }] });
    f.engine.start(run.id);
    const waiting = await f.engine.wait(run.id);
    assert.equal(waiting.status, 'waiting_verification');
    assert.deepEqual(waiting.stages[0].executionIds, [value.identity.runId]);
    assert.equal(waiting.stages[0].taskId, value.taskId);
    const completed = await f.engine.verifyStage({ id: run.id, stageId: 'build', expectedAttempt: 1 });
    assert.equal(completed.status, 'completed');
    assert.deepEqual(inspected, value);
    assert.equal(calls, 1);
    assert.equal(completed.usage?.modelRequests, 2);
    await assert.rejects(f.engine.verifyStage({ id: run.id, stageId: 'build', expectedAttempt: 1 }), /状态已变化/);
  } finally { f.dispose(); }
});

test('Native verification waits for current conditions and blocks changed files, revisions and task identities', async () => {
  let value!: WorkflowNativeReceipt, current!: NativeTaskView;
  const f = fixture({ runStage: async (_id, _prompt, _title, submission) => { value = receipt(f.binding, submission!); current = taskFor(value, ['check']); return { success: true, summary: 'Output', nativeReceipt: value }; },
    inspectNativeTask: async () => current });
  try {
    const run = f.engine.create({ sessionId: f.binding.sessionId, goal: 'Ship', stages: [{ ...steps[0], gate: 'native_task' }] });
    f.engine.start(run.id); await f.engine.wait(run.id);
    const verify = () => f.engine.verifyStage({ id: run.id, stageId: 'build', expectedAttempt: 1 });
    assert.equal((await verify()).status, 'waiting_verification');
    current = taskFor(value, ['check', 'manual']); current.workspace!.current.fingerprint = 'b'.repeat(64);
    assert.match((await verify()).stages[0].gateReason!, /工作区/);
    current = taskFor(value, ['check', 'manual']); current.acceptanceRevision = 2;
    assert.match((await verify()).stages[0].gateReason!, /验收条件已变化/);
    current = taskFor(value, ['check', 'manual']); current.revision = 0;
    assert.match((await verify()).stages[0].gateReason!, /验收条件已变化/);
    current = taskFor(value, ['check', 'manual']); current.identity = { ...current.identity, runId: randomUUID() };
    assert.match((await verify()).stages[0].gateReason!, /身份已变化/);
    current = taskFor(value, ['check', 'manual']);
    assert.equal((await verify()).status, 'completed');
  } finally { f.dispose(); }
});

test('a truncated criterion receipt cannot silently omit current task requirements', async () => {
  let value!: WorkflowNativeReceipt, current!: NativeTaskView;
  const f = fixture({ runStage: async (_id, _prompt, _title, submission) => { value = receipt(f.binding, submission!); current = taskFor(value, ['check', 'manual']); value.criteria = value.criteria.slice(0, 1); value.truncated = true; return { success: true, summary: 'Output', nativeReceipt: value }; }, inspectNativeTask: async () => current });
  try {
    const run = f.engine.create({ sessionId: f.binding.sessionId, goal: 'Ship', stages: [{ ...steps[0], gate: 'native_task' }] });
    f.engine.start(run.id); await f.engine.wait(run.id);
    const waiting = await f.engine.verifyStage({ id: run.id, stageId: 'build', expectedAttempt: 1 });
    assert.equal(waiting.status, 'waiting_verification');
    assert.match(waiting.stages[0].gateReason!, /manual/);
    assert.match(waiting.stages[0].gateReason!, /缺少完整/);
  } finally { f.dispose(); }
});

test('truncated changes or evidence permit authoritative verification when all selected criterion references remain intact', async () => {
  for (const explicit of [false, true]) {
    let value!: WorkflowNativeReceipt, current!: NativeTaskView;
    const f = fixture({ runStage: async (_id, _prompt, _title, submission) => {
      value = receipt(f.binding, submission!); current = taskFor(value, ['check', 'manual']);
      value.truncated = true; value.changes!.truncated = true; value.changes!.modified = [];
      if (explicit) value.criteria = value.criteria.slice(0, 1);
      return { success: true, summary: 'Bounded references', nativeReceipt: value };
    }, inspectNativeTask: async () => current });
    try {
      const run = f.engine.create({ sessionId: f.binding.sessionId, goal: 'Ship', stages: [{ ...steps[0], gate: 'native_task', ...(explicit ? { criterionIds: ['check'] } : {}) }] });
      f.engine.start(run.id); await f.engine.wait(run.id);
      assert.equal((await f.engine.verifyStage({ id: run.id, stageId: 'build', expectedAttempt: 1 })).status, 'completed');
    } finally { f.dispose(); }
  }
});

test('selected acceptance requires implemented referenced steps and unchanged criterion definitions without requiring unrelated steps', async () => {
  let value!: WorkflowNativeReceipt, current!: NativeTaskView;
  const f = fixture({ runStage: async (_id, _prompt, _title, submission) => { value = receipt(f.binding, submission!); current = taskFor(value, ['check']); return { success: true, summary: 'Output', nativeReceipt: value }; }, inspectNativeTask: async () => current });
  try {
    const run = f.engine.create({ sessionId: f.binding.sessionId, goal: 'Ship', stages: [{ ...steps[0], gate: 'native_task', criterionIds: ['check'] }] });
    f.engine.start(run.id); await f.engine.wait(run.id);
    for (const status of ['pending', 'in_progress', 'blocked', 'interrupted'] as const) {
      current = taskFor(value, ['check']); current.steps[0].status = status;
      assert.match((await f.engine.verifyStage({ id: run.id, stageId: 'build', expectedAttempt: 1 })).stages[0].gateReason!, /步骤尚未实现/);
    }
    current = taskFor(value, ['check']); current.criteria = structuredClone(current.criteria); current.criteria[0].description = 'Changed acceptance condition';
    assert.match((await f.engine.verifyStage({ id: run.id, stageId: 'build', expectedAttempt: 1 })).stages[0].gateReason!, /完整的验收条件引用/);
    current = taskFor(value, ['check']); current.steps.push({ id: 'unrelated', title: 'Unrelated', dependsOn: [], status: 'pending' });
    assert.equal((await f.engine.verifyStage({ id: run.id, stageId: 'build', expectedAttempt: 1 })).status, 'completed');
  } finally { f.dispose(); }
});

test('cancelled verification cannot advance a stage after an asynchronous evidence read', async () => {
  let value!: WorkflowNativeReceipt, release!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), blocked = new Promise<void>(resolve => { release = resolve; });
  const f = fixture({ runStage: async (_id, _prompt, _title, submission) => { value = receipt(f.binding, submission!); return { success: true, summary: 'Output', nativeReceipt: value }; },
    inspectNativeTask: async () => { entered(); await blocked; return taskFor(value, ['check', 'manual']); } });
  try {
    const run = f.engine.create({ sessionId: f.binding.sessionId, goal: 'Ship', stages: [{ ...steps[0], gate: 'native_task' }] });
    f.engine.start(run.id); await f.engine.wait(run.id);
    const checking = f.engine.verifyStage({ id: run.id, stageId: 'build', expectedAttempt: 1 });
    await started; await f.engine.cancel(run.id); release();
    await assert.rejects(checking, /状态已变化/);
    assert.equal(f.engine.list()[0].status, 'cancelled');
  } finally { release(); f.dispose(); }
});

test('bounded Native results survive restart and enter dependent stages as host evidence references', async () => {
  let first!: WorkflowNativeReceipt, handoff = '';
  const f = fixture({ runStage: async (_id, prompt, _title, submission) => {
    if (submission!.stageId === 'build') { first = receipt(f.binding, submission!); return { success: true, summary: 'Actual summary', nativeReceipt: first }; }
    handoff = prompt; return { success: true, summary: 'reviewed', nativeReceipt: receipt(f.binding, submission!) };
  } });
  try {
    const run = f.engine.create({ sessionId: f.binding.sessionId, goal: 'Ship', stages: steps, pauseAfterEachStage: true });
    f.engine.start(run.id); await f.engine.wait(run.id);
    const restored = new WorkflowEngine(f.directory, f.options);
    restored.continue(run.id); await restored.wait(run.id);
    assert.match(handoff, /Actual summary/);
    assert.ok(handoff.includes(first.taskId!));
    assert.ok(handoff.includes(first.identity.runId));
    assert.match(handoff, /src\/app.ts/);
    assert.match(handoff, /不是自动验收结论/);
    assert.equal(restored.list()[0].usage?.recordedExecutionIds.length, 2);
  } finally { f.dispose(); }
});

test('overall budgets retain failed-attempt usage and dispatch remaining limits after restart', async () => {
  const submissions: ExecutionSubmission[] = [];
  const f = fixture({ nativePoliciesEnabled: true, runStage: async (_id, _prompt, _title, submission) => {
    submissions.push(submission!); const value = receipt(f.binding, submission!);
    return { success: submissions.length > 1, summary: 'actual partial output', nativeReceipt: value };
  } });
  try {
    const run = f.engine.create({ sessionId: f.binding.sessionId, goal: 'Ship', stages: [{ ...steps[0], toolPolicy: 'read_only' }], budget: { maxModelRequests: 5, maxToolCalls: 4, maxActiveMs: 2000 } });
    f.engine.start(run.id);
    const failed = await f.engine.wait(run.id);
    assert.equal(failed.status, 'failed'); assert.equal(failed.usage?.modelRequests, 2);
    const restored = new WorkflowEngine(f.directory, f.options);
    restored.retry(run.id);
    const done = await restored.wait(run.id);
    assert.equal(done.status, 'completed'); assert.equal(done.usage?.modelRequests, 4);
    assert.deepEqual(submissions[1].nativeExecutionPolicy, { toolPolicy: 'read_only', budget: { maxModelRequests: 3, maxToolCalls: 3, maxActiveMs: 1800 } });
    assert.equal(done.stages[0].nativeReceipts?.length, 2);
    assert.equal(new Set(done.usage?.recordedExecutionIds).size, 2);
  } finally { f.dispose(); }
});

test('exhausted or incomplete overall budgets block later stages without replaying effects', async () => {
  for (const missingReceipt of [false, true]) {
    let calls = 0;
    const f = fixture({ nativePoliciesEnabled: true, runStage: async (_id, _prompt, _title, submission) => {
      calls++; return { success: true, summary: 'effect exists', ...(missingReceipt ? {} : { nativeReceipt: receipt(f.binding, submission!) }) };
    } });
    try {
      const run = f.engine.create({ sessionId: f.binding.sessionId, goal: 'Ship', stages: steps, budget: { maxModelRequests: 2, maxToolCalls: 4, maxActiveMs: 2000 } });
      f.engine.start(run.id); const stopped = await f.engine.wait(run.id);
      assert.equal(stopped.status, 'interrupted'); assert.equal(calls, 1);
      assert.equal(stopped.stages[0].status, 'completed'); assert.equal(stopped.stages[1].attempts, 0);
      assert.match(stopped.error!, missingReceipt ? /用量记录不完整/ : /累计预算已耗尽/);
      f.engine.continue(run.id); await f.engine.wait(run.id);
      assert.equal(calls, 1);
    } finally { f.dispose(); }
  }
});

test('cancelled stages retain consumed usage while late results never dispatch downstream work', async () => {
  let release!: (value: import('../src/shared/workflows').WorkflowStageResult) => void, submission!: ExecutionSubmission;
  const pending = new Promise<import('../src/shared/workflows').WorkflowStageResult>(resolve => { release = resolve; });
  const f = fixture({ nativePoliciesEnabled: true, runStage: async (_id, _prompt, _title, value) => { submission = value!; return pending; } });
  try {
    const run = f.engine.create({ sessionId: f.binding.sessionId, goal: 'Ship', stages: steps, budget: { maxModelRequests: 5, maxToolCalls: 4, maxActiveMs: 2000 } });
    f.engine.start(run.id); await new Promise(resolve => setImmediate(resolve));
    await f.engine.cancel(run.id);
    release({ success: true, summary: 'late output', nativeReceipt: receipt(f.binding, submission) });
    const cancelled = await f.engine.wait(run.id);
    assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.usage?.modelRequests, 2);
    assert.equal(cancelled.stages[1].attempts, 0); assert.equal(cancelled.stages[0].artifacts.length, 0);
  } finally { f.dispose(); }
});

test('cancelled Native stages without receipts retain unknown usage even when no overall budget was configured', async () => {
  let release!: (value: import('../src/shared/workflows').WorkflowStageResult) => void;
  const pending = new Promise<import('../src/shared/workflows').WorkflowStageResult>(resolve => { release = resolve; });
  const f = fixture({ runStage: async () => pending });
  try {
    const run = f.engine.create({ sessionId: f.binding.sessionId, goal: 'Ship', stages: steps });
    f.engine.start(run.id); await new Promise(resolve => setImmediate(resolve));
    await f.engine.cancel(run.id); release({ success: false, summary: '', error: 'receipt metadata is unavailable' });
    const cancelled = await f.engine.wait(run.id);
    assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.usage?.complete, false);
    assert.equal(cancelled.stages[1].attempts, 0); assert.equal(cancelled.stages[0].artifacts.length, 0);
  } finally { f.dispose(); }
});

test('unsupported strict policies reject explicitly and legacy records keep their ordinary stage behavior', async () => {
  const f = fixture({ nativePoliciesEnabled: true });
  try {
    f.binding.providerId = 'claude';
    assert.throws(() => f.engine.create({ sessionId: f.binding.sessionId, goal: 'Ship', stages: [{ ...steps[0], toolPolicy: 'read_only' }] }), /仅支持自研/);
    assert.throws(() => f.engine.create({ sessionId: f.binding.sessionId, goal: 'Ship', stages: [{ ...steps[0], gate: 'native_task' }] }), /仅支持自研/);
    const run = f.engine.create({ sessionId: f.binding.sessionId, goal: 'Ship', stages: steps });
    const stored = JSON.parse(fs.readFileSync(f.engine.file, 'utf8'));
    for (const stage of stored.runs[0].stages) { delete stage.gate; delete stage.toolPolicy; }
    fs.writeFileSync(f.engine.file, JSON.stringify(stored));
    const legacy = new WorkflowEngine(f.directory, f.options);
    assert.equal(legacy.list()[0].stages[0].toolPolicy, undefined);
    legacy.start(run.id); assert.equal((await legacy.wait(run.id)).status, 'completed');
    const corrupt = workflowStateSchema.parse({ version: 1, runs: [{ ...legacy.list()[0], status: 'waiting_verification' }] });
    assert.throws(() => validateWorkflowState(corrupt), /等待阶段状态无效/);
  } finally { f.dispose(); }
});

test('invalid receipt identities leave cumulative usage unknown and prevent later budgeted execution', async () => {
  let calls = 0;
  const f = fixture({ nativePoliciesEnabled: true, runStage: async (_id, _prompt, _title, submission) => {
    calls++; const invalid = receipt(f.binding, submission!); invalid.identity.requestId = 'different-submission';
    return { success: true, summary: 'Existing effects', nativeReceipt: invalid };
  } });
  try {
    const run = f.engine.create({ sessionId: f.binding.sessionId, goal: 'Ship', stages: steps, budget: { maxModelRequests: 5, maxToolCalls: 4, maxActiveMs: 2000 } });
    f.engine.start(run.id); const stopped = await f.engine.wait(run.id);
    assert.equal(stopped.status, 'interrupted'); assert.equal(stopped.usage?.complete, false);
    assert.match(stopped.error!, /提交身份不匹配/);
    f.engine.continue(run.id); await f.engine.wait(run.id);
    assert.equal(calls, 1);
  } finally { f.dispose(); }
});

test('reusing an execution ID for a different stage leaves accounting unknown instead of silently undercounting', async () => {
  let calls = 0, first!: WorkflowNativeReceipt;
  const f = fixture({ nativePoliciesEnabled: true, runStage: async (_id, _prompt, _title, submission) => {
    calls++; const value = receipt(f.binding, submission!);
    if (calls === 1) first = value; else value.identity.runId = first.identity.runId;
    return { success: true, summary: 'Existing effects', nativeReceipt: value };
  } });
  try {
    const run = f.engine.create({ sessionId: f.binding.sessionId, goal: 'Ship', stages: steps, budget: { maxModelRequests: 10, maxToolCalls: 10, maxActiveMs: 2000 } });
    f.engine.start(run.id); const stopped = await f.engine.wait(run.id);
    assert.equal(stopped.status, 'interrupted'); assert.equal(stopped.usage?.complete, false);
    assert.equal(stopped.usage?.modelRequests, 2); assert.match(stopped.error!, /重复执行标识/);
    const restored = new WorkflowEngine(f.directory, f.options);
    restored.continue(run.id); await restored.wait(run.id);
    assert.equal(calls, 2);
  } finally { f.dispose(); }
});

test('receipt payloads and stored cumulative accounting reject oversized or duplicated data', async () => {
  let value!: WorkflowNativeReceipt;
  const f = fixture({ runStage: async (_id, _prompt, _title, submission) => { value = receipt(f.binding, submission!); return { success: true, summary: 'Output', nativeReceipt: value }; } });
  try {
    const run = f.engine.create({ sessionId: f.binding.sessionId, goal: 'Ship', stages: [steps[0]] });
    f.engine.start(run.id); const done = await f.engine.wait(run.id);
    const duplicate = workflowStateSchema.parse({ version: 1, runs: [{ ...done, usage: { ...done.usage, recordedExecutionIds: [value.identity.runId, value.identity.runId] } }] });
    assert.throws(() => validateWorkflowState(duplicate), /重复记账/);
    const oversized = structuredClone(value);
    oversized.evidence = [{ id: 'receipt', identity: value.identity, source: 'command', status: 'unverified', criterionIds: ['check'], stepIds: ['build'],
      planRevision: 1, acceptanceRevision: 1, workspaceFingerprint: fingerprint, workspaceComplete: true,
      command: { executable: 'node', cwd: '/tmp/project', argv: Array.from({ length: 32 }, () => 'x'.repeat(4096)) } }];
    assert.throws(() => workflowNativeReceiptSchema.parse(oversized), /64 KiB/);
  } finally { f.dispose(); }
});
