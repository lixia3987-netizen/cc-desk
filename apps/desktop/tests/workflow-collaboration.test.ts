import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { NativeTaskView } from '@cc-desk/contracts/native-task';
import type { NativeWorkflowQualityState } from '@cc-desk/contracts/native-workflow-quality';
import { WorkflowEngine, type WorkflowEngineOptions } from '../src/main/workflows';
import { nativeQualityFindingsForRound } from '../src/main/engines/native/workflow-quality-report';
import { newWorkflowSchema, workflowNativeReceiptSchema, workflowQualityFailure, workflowStateSchema, validateWorkflowState } from '../src/main/workflow-schema';
import type { ExecutionSubmission } from '../src/main/execution/ports';
import type { WorkflowBinding, WorkflowNativeReceipt } from '../src/shared/workflows';

const at = new Date().toISOString(), fingerprint = 'a'.repeat(64), commit = 'b'.repeat(40), tree = 'c'.repeat(40);
const deliveryDigest = createHash('sha256').update('delivery').digest('hex');
const stage = { id: 'implement', title: 'Implement', instruction: 'Implement and verify the goal' };
function fixture(patch: Partial<WorkflowEngineOptions> = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ccdesk-workflow-quality-'));
  const binding: WorkflowBinding = { sessionId: randomUUID(), providerId: 'native', executionMode: 'structured', projectId: randomUUID(), cwd: '/tmp/project' };
  const options: WorkflowEngineOptions = { getSession: () => binding, cancelSession: () => {}, runStage: async () => ({ success: true, summary: 'passed' }), ...patch };
  const engine = new WorkflowEngine(directory, options);
  return { directory, binding, options, engine, dispose: () => fs.rmSync(directory, { recursive: true, force: true }) };
}
function qualityReceipt(binding: WorkflowBinding, submission: ExecutionSubmission): WorkflowNativeReceipt {
  const value: WorkflowNativeReceipt = { version: 1, identity: { sessionId: binding.sessionId, conversationId: randomUUID(), runId: randomUUID(), requestId: submission.requestId, workerGeneration: 1 },
    taskId: randomUUID(), taskRevision: 1, planRevision: 1, acceptanceRevision: 1, verification: 'unverified', workspace: { fingerprint, complete: true, capturedAt: at },
    criteria: [], evidence: [], usage: { modelRequests: 1, toolCalls: 1, activeMs: 100 }, truncated: false };
  const roles: NativeWorkflowQualityState['rounds'][number]['roles'] = (['reviewer', 'challenger', 'verifier'] as const).map(role => {
    const identity = { sessionId: randomUUID(), conversationId: randomUUID(), runId: randomUUID(), requestId: `quality:${role}`, workerGeneration: 1 }, taskId = randomUUID();
    return { role, childId: randomUUID(), identity, taskId, cwd: `/tmp/quality-${role}`, status: 'completed', report: {
      version: 1, role, round: 1, identity, taskId, snapshotCommit: commit, workspaceFingerprint: 'd'.repeat(64), deliveryDigest, submittedAt: at,
      declaration: { verdict: 'passed', reviewedPaths: ['src/app.ts'], limitations: [], findings: [], resolutions: [],
        verification: { status: role === 'verifier' ? 'executed' : 'not_applicable', commandToolCallIds: role === 'verifier' ? ['test'] : [], reason: 'Reviewed the captured version' } },
      materialReads: [{ toolCallId: 'read', path: 'src/app.ts', fileHash: fingerprint }],
      commandReceipts: role === 'verifier' ? [{ toolCallId: 'test', exitCode: 0, successful: true }] : [],
    } };
  });
  value.workflowQuality = { version: 1, parentIdentity: value.identity, taskId: value.taskId!, collaboration: submission.nativeExecutionPolicy?.collaboration ?? 'adversarial',
    validationMode: submission.nativeExecutionPolicy?.qualityValidation ?? 'commands', status: 'passed', round: 1, maxRounds: 2, receiptPath: '/tmp/quality.json', updatedAt: at,
    rounds: [{ round: 1, status: 'passed', snapshotCommit: commit, snapshotTree: tree, parentFingerprint: fingerprint, deliveryDigest, roles, issues: [] }], findings: [],
    workspaceFingerprint: fingerprint, automaticReview: 'passed', manualAcceptance: 'not_requested' };
  if (value.workflowQuality.validationMode === 'static') for (const role of roles) {
    role.report!.declaration.verification = { status: 'not_applicable', commandToolCallIds: [], reason: 'Read-only static verification' }; role.report!.commandReceipts = [];
  }
  return value;
}
function taskFor(value: WorkflowNativeReceipt): NativeTaskView {
  const workspace = { fingerprint: value.workspace!.fingerprint, rootFingerprint: fingerprint, complete: true, capturedAt: at, scope: ['.'], issues: [], fileCount: 1 };
  return { schemaVersion: 1, taskId: value.taskId!, identity: value.identity, revision: 2, planRevision: 1, acceptanceRevision: 1, execution: 'ended', verification: 'unverified',
    goal: 'Ship', steps: [], criteria: [], evidence: [], history: [], createdAt: at, updatedAt: at,
    workspace: { baseline: workspace, current: workspace, changes: { added: [], modified: [], removed: [], complete: true, attribution: 'observed_since_task_start', truncated: false } } };
}

test('workflow collaboration is explicit, persisted and structured, while legacy and single-agent runs retain their behavior', async () => {
  for (const mode of [undefined, 'single_agent', 'auto', 'parallel', 'adversarial'] as const) {
    const submissions: ExecutionSubmission[] = [], prompts: string[] = [];
    let latest!: WorkflowNativeReceipt;
    const f = fixture({ runStage: async (_id, prompt, _title, submission) => { submissions.push(submission!); prompts.push(prompt); latest = qualityReceipt(f.binding, submission!); return { success: true, summary: 'read-only analysis', ...(mode && mode !== 'single_agent' ? { nativeReceipt: latest } : {}) }; },
      inspectNativeTask: async () => taskFor(latest) });
    try {
      const run = f.engine.create({ sessionId: f.binding.sessionId, goal: 'Analyze', ...(mode ? { collaboration: mode } : {}), stages: [{ ...stage, toolPolicy: 'read_only' }] });
      f.engine.start(run.id); const done = await f.engine.wait(run.id);
      assert.equal(done.status, 'completed'); assert.equal(done.collaboration, mode);
      assert.deepEqual(submissions[0].nativeExecutionPolicy, { toolPolicy: 'read_only', ...(mode ? { collaboration: mode } : {}), ...(mode && mode !== 'single_agent' ? { qualityValidation: 'static' } : {}) });
      assert.equal(new WorkflowEngine(f.directory, f.options).list()[0].collaboration, mode);
      if (mode && mode !== 'single_agent') { assert.match(prompts[0], /不要求填满上限/); assert.match(prompts[0], /仅通过宿主委派工具/); }
      assert.match(prompts[0], /不执行命令、不写入文件/);
    } finally { f.dispose(); }
  }
  assert.equal(newWorkflowSchema.parse({ sessionId: randomUUID(), goal: 'Legacy' }).collaboration, undefined);
  assert.throws(() => newWorkflowSchema.parse({ sessionId: randomUUID(), goal: 'Bad mode', collaboration: 'team' }));
  const f = fixture();
  try { f.binding.providerId = 'claude'; assert.throws(() => f.engine.create({ sessionId: f.binding.sessionId, goal: 'Ship', collaboration: 'auto' }), /仅支持/); }
  finally { f.dispose(); }
});

test('a successful summary cannot complete a standard stage without independent host quality records', async () => {
  for (const collaboration of ['auto', 'parallel', 'adversarial'] as const) {
    let calls = 0;
    const f = fixture({ runStage: async () => { calls++; return { success: true, summary: 'All review and tests passed; there are no P1 issues.' }; } });
    try {
      const run = f.engine.create({ sessionId: f.binding.sessionId, goal: 'Ship', collaboration, stages: [stage, { id: 'deliver', title: 'Deliver', instruction: 'Summarize', dependsOn: [stage.id] }] });
      f.engine.start(run.id); const stopped = await f.engine.wait(run.id);
      assert.equal(stopped.status, 'failed'); assert.match(stopped.error!, /缺少宿主独立质量/);
      assert.equal(calls, 1); assert.deepEqual(stopped.stages.map(item => item.attempts), [1, 0]);
    } finally { f.dispose(); }
  }
});

test('legacy and explicit single-agent standard stages do not implicitly create a quality or inspection requirement', async () => {
  for (const collaboration of [undefined, 'single_agent'] as const) {
    const f = fixture();
    try {
      const run = f.engine.create({ sessionId: f.binding.sessionId, goal: 'Ship', stages: [stage], ...(collaboration ? { collaboration } : {}) });
      f.engine.start(run.id); assert.equal((await f.engine.wait(run.id)).status, 'completed');
      assert.equal(f.engine.list()[0].stages[0].nativeReceipts, undefined);
    } finally { f.dispose(); }
  }
});

test('read-only-only workflows require static quality exactly once at final delivery and never claim command validation', async () => {
  for (const missing of [false, true]) {
    const submissions: ExecutionSubmission[] = []; let latest!: WorkflowNativeReceipt;
    const f = fixture({ runStage: async (_id, _prompt, _title, submission) => {
      submissions.push(submission!); latest = qualityReceipt(f.binding, submission!);
      if (!submission!.nativeExecutionPolicy?.qualityValidation || missing) delete latest.workflowQuality;
      return { success: true, summary: 'Document analysis is complete', nativeReceipt: latest };
    }, inspectNativeTask: async () => taskFor(latest) });
    try {
      const run = f.engine.create({ sessionId: f.binding.sessionId, goal: 'Analyze this document against the current project', collaboration: 'adversarial', stages: [
        { id: 'read', title: 'Read', instruction: 'Read the document', toolPolicy: 'read_only' },
        { id: 'analyze', title: 'Analyze', instruction: 'Find gaps', toolPolicy: 'read_only', dependsOn: ['read'] },
      ] });
      f.engine.start(run.id); const done = await f.engine.wait(run.id);
      assert.equal(done.status, missing ? 'failed' : 'completed');
      assert.deepEqual(submissions.map(item => item.nativeExecutionPolicy?.qualityValidation), [undefined, 'static']);
      assert.ok(submissions.every(item => item.nativeExecutionPolicy?.toolPolicy === 'read_only'));
      if (missing) assert.match(done.error!, /缺少宿主独立质量/);
      else {
        assert.ok(latest.workflowQuality!.rounds[0].roles.every(role => role.report!.commandReceipts.length === 0 && role.report!.declaration.verification.status === 'not_applicable'));
        const fabricated = structuredClone(latest); fabricated.workflowQuality!.rounds[0].roles[2].report!.commandReceipts = [{ toolCallId: 'test', exitCode: 0, successful: true }];
        assert.match(workflowQualityFailure(fabricated, 'adversarial', 'static')!, /没有命令回执/);
        const bad = workflowStateSchema.parse({ version: 1, runs: [done] }); delete bad.runs[0].stages[1].nativeReceipts![0].workflowQuality;
        assert.throws(() => validateWorkflowState(bad), /只读交付独立质量记录无效/);
      }
    } finally { f.dispose(); }
  }
});

test('quality gate rejects blocked, missing, stale, reused or unverified role evidence despite success text', async () => {
  const mutations: Array<[string, (value: WorkflowNativeReceipt) => void]> = [
    ['blocked', value => { value.workflowQuality!.status = 'blocked'; }],
    ['static only', value => { value.workflowQuality!.validationMode = 'static'; }],
    ['missing role', value => { value.workflowQuality!.rounds[0].roles.pop(); }],
    ['missing delivery', value => { delete value.workflowQuality!.rounds[0].deliveryDigest; }],
    ['delivery differs between roles', value => { value.workflowQuality!.rounds[0].roles[0].report!.deliveryDigest = 'e'.repeat(64); }],
    ['stale snapshot', value => { value.workflowQuality!.workspaceFingerprint = 'e'.repeat(64); }],
    ['incomplete workspace', value => { value.workspace!.complete = false; }],
    ['wrong parent', value => { value.workflowQuality!.parentIdentity = { ...value.identity, runId: randomUUID() }; }],
    ['wrong snapshot', value => { value.workflowQuality!.rounds[0].roles[0].report!.snapshotCommit = 'f'.repeat(40); }],
    ['reused role identity', value => { value.workflowQuality!.rounds[0].roles[1].identity = value.workflowQuality!.rounds[0].roles[0].identity; }],
    ['reused role conversation', value => { const roles = value.workflowQuality!.rounds[0].roles; roles[1].identity = { ...roles[1].identity, conversationId: roles[0].identity.conversationId }; roles[1].report!.identity = roles[1].identity; }],
    ['reused role session', value => { const roles = value.workflowQuality!.rounds[0].roles; roles[1].identity = { ...roles[1].identity, sessionId: roles[0].identity.sessionId }; roles[1].report!.identity = roles[1].identity; }],
    ['failed test', value => { value.workflowQuality!.rounds[0].roles[2].report!.commandReceipts[0].successful = false; }],
    ['startup only', value => { value.workflowQuality!.rounds[0].roles[2].report!.commandReceipts[0].exitCode = null; }],
    ['failed command omitted from declaration', value => { value.workflowQuality!.rounds[0].roles[2].report!.commandReceipts.push({ toolCallId: 'failed-test', successful: false, exitCode: 1 }); }],
    ['missing coverage', value => { value.workflowQuality!.rounds[0].roles[0].report!.declaration.limitations.push('The modified code was not read'); }],
    ['unread material', value => { value.workflowQuality!.rounds[0].roles[0].report!.materialReads = []; }],
    ['parent context reused', value => { const role = value.workflowQuality!.rounds[0].roles[0]; role.identity = { ...role.identity, conversationId: value.identity.conversationId }; role.report!.identity = role.identity; }],
    ['P1 remains', value => { value.workflowQuality!.findings.push({ id: 'P1', severity: 'high', title: 'Regression', detail: 'Data can be lost', reproduction: 'Open and send',
      evidence: [{ toolCallId: 'read', path: 'src/app.ts', fileHash: fingerprint, startLine: 1, endLine: 1 }] }); }],
  ];
  for (const [name, mutate] of mutations) {
    const f = fixture({ runStage: async (_id, _prompt, _title, submission) => { const value = qualityReceipt(f.binding, submission!); mutate(value); return { success: true, summary: 'success', nativeReceipt: value }; } });
    try {
      const run = f.engine.create({ sessionId: f.binding.sessionId, goal: 'Ship', collaboration: 'adversarial', stages: [stage] });
      f.engine.start(run.id); const stopped = await f.engine.wait(run.id);
      assert.equal(stopped.status, 'failed', name); assert.equal(stopped.stages[0].attempts, 1, name);
    } finally { f.dispose(); }
  }
});

test('repair quality rounds retain prior findings, require fresh evidence-backed closure and do not consume stage attempts', async () => {
  let value!: WorkflowNativeReceipt;
  const f = fixture({ runStage: async (_id, _prompt, _title, submission) => {
    value = qualityReceipt(f.binding, submission!);
    const quality = value.workflowQuality!, first = structuredClone(quality.rounds[0]), second = qualityReceipt(f.binding, submission!).workflowQuality!.rounds[0];
    first.status = 'changes_requested';
    first.roles[0].report!.declaration.verdict = 'changes_requested';
    first.roles[0].report!.declaration.findings = [{ id: 'data-loss', severity: 'high', title: 'Data loss', detail: 'Missing boundary handling', reproduction: 'Load then send',
      evidence: [{ toolCallId: 'read', path: 'src/app.ts', fileHash: fingerprint, startLine: 1, endLine: 1 }] }];
    // 各角色可独立使用相同局部编号；宿主身份必须让它们成为三个独立问题。
    for (const role of first.roles.slice(1)) role.report!.declaration.findings = structuredClone(first.roles[0].report!.declaration.findings);
    second.round = 2;
    const previous = nativeQualityFindingsForRound(first.roles); assert.equal(new Set(previous.map(finding => finding.id)).size, 3);
    for (const role of second.roles) {
      role.report!.round = 2;
      role.report!.declaration.resolutions = previous.map(finding => ({ findingId: finding.id, status: 'resolved', explanation: 'The boundary is now checked',
        evidence: [{ toolCallId: 'read', path: 'src/app.ts', fileHash: fingerprint, startLine: 1, endLine: 1 }] }));
    }
    quality.round = 2; quality.rounds = [first, second];
    return { success: true, summary: 'Fixed and independently verified', nativeReceipt: value };
  }, inspectNativeTask: async () => taskFor(value) });
  try {
    const run = f.engine.create({ sessionId: f.binding.sessionId, goal: 'Ship', collaboration: 'adversarial', stages: [stage], maxAttempts: 1 });
    f.engine.start(run.id); const done = await f.engine.wait(run.id);
    assert.equal(done.status, 'completed'); assert.equal(done.stages[0].attempts, 1);
    assert.equal(done.stages[0].nativeReceipts![0].workflowQuality!.rounds.length, 2);
    const missingResolution = structuredClone(value); missingResolution.workflowQuality!.rounds[1].roles[1].report!.declaration.resolutions = [];
    assert.match(workflowQualityFailure(missingResolution, 'adversarial')!, /阻塞问题尚未/);
    const aliased = structuredClone(value); aliased.workflowQuality!.rounds[1].roles[1].report!.declaration.resolutions = aliased.workflowQuality!.rounds[1].roles[1].report!.declaration.resolutions.slice(0, 1);
    assert.match(workflowQualityFailure(aliased, 'adversarial')!, /阻塞问题尚未/);
    const reused = structuredClone(value); reused.workflowQuality!.rounds[1].roles[0].childId = reused.workflowQuality!.rounds[0].roles[0].childId;
    assert.match(workflowQualityFailure(reused, 'adversarial')!, /新的执行身份/);
    assert.equal(new WorkflowEngine(f.directory, f.options).list()[0].stages[0].attempts, 1);
  } finally { f.dispose(); }
});

test('later legitimate standard work supersedes the earlier quality snapshot at final delivery', async () => {
  const values: WorkflowNativeReceipt[] = [], inspected: string[] = [];
  const f = fixture({ runStage: async (_id, _prompt, _title, submission) => {
    const value = qualityReceipt(f.binding, submission!);
    if (values.length) {
      const changed = 'e'.repeat(64); value.workspace!.fingerprint = changed;
      value.workflowQuality!.workspaceFingerprint = changed; value.workflowQuality!.rounds[0].parentFingerprint = changed;
    }
    values.push(value); return { success: true, summary: 'Implemented', nativeReceipt: value };
  }, inspectNativeTask: async value => { inspected.push(value.identity.runId); return taskFor(value); } });
  try {
    const run = f.engine.create({ sessionId: f.binding.sessionId, goal: 'Ship', collaboration: 'parallel', stages: [stage, { id: 'second', title: 'Second implementation', instruction: 'Finish the full goal', dependsOn: [stage.id] }] });
    f.engine.start(run.id); const done = await f.engine.wait(run.id);
    assert.equal(done.status, 'completed'); assert.deepEqual(inspected, [values[1].identity.runId]);
    assert.notEqual(values[0].workspace!.fingerprint, values[1].workspace!.fingerprint);
  } finally { f.dispose(); }
});

test('passed independent quality preserves manual acceptance and survives storage, export and dependent read-only delivery', async () => {
  let value!: WorkflowNativeReceipt, inspected = 0, calls = 0;
  const f = fixture({ runStage: async (_id, _prompt, _title, submission) => {
    calls++; if (submission!.stageId === stage.id) { value = qualityReceipt(f.binding, submission!); return { success: true, summary: 'Implemented', nativeReceipt: value }; }
    return { success: true, summary: 'Read-only delivery' };
  }, inspectNativeTask: async current => { inspected++; assert.deepEqual(current, value); return taskFor(value); } });
  try {
    const run = f.engine.create({ sessionId: f.binding.sessionId, goal: 'Ship', collaboration: 'adversarial', stages: [stage, { id: 'review', title: 'Deliver', instruction: 'Review', toolPolicy: 'read_only', dependsOn: [stage.id] }] });
    f.engine.start(run.id); const done = await f.engine.wait(run.id);
    assert.equal(done.status, 'completed'); assert.equal(inspected, 1); assert.equal(calls, 2);
    assert.equal(done.stages[0].nativeReceipts![0].verification, 'unverified'); assert.deepEqual(done.stages[0].nativeReceipts![0].evidence, []);
    assert.equal(done.stages[0].nativeReceipts![0].workflowQuality!.manualAcceptance, 'not_requested');
    assert.deepEqual(new WorkflowEngine(f.directory, f.options).list()[0].stages[0].nativeReceipts![0].workflowQuality, value.workflowQuality);
    assert.deepEqual(JSON.parse(f.engine.exportRun(run.id)).runs[0].stages[0].nativeReceipts[0].workflowQuality, value.workflowQuality);
    const badArchive = workflowStateSchema.parse({ version: 1, runs: [structuredClone(done)] });
    delete badArchive.runs[0].stages[0].nativeReceipts![0].workflowQuality;
    assert.throws(() => validateWorkflowState(badArchive), /独立质量记录无效/);
  } finally { f.dispose(); }
});

test('final delivery fails closed when inspection is unavailable or a later read-only stage changed reviewed files', async () => {
  for (const inspect of ['missing', 'changed'] as const) {
    let value!: WorkflowNativeReceipt;
    const f = fixture({ runStage: async (_id, _prompt, _title, submission) => {
      if (submission!.stageId === stage.id) { value = qualityReceipt(f.binding, submission!); return { success: true, summary: 'Implemented', nativeReceipt: value }; }
      return { success: true, summary: 'Delivered' };
    }, ...(inspect === 'changed' ? { inspectNativeTask: async () => { const task = taskFor(value); task.workspace!.current.fingerprint = 'e'.repeat(64); return task; } } : {}) });
    try {
      const run = f.engine.create({ sessionId: f.binding.sessionId, goal: 'Ship', collaboration: 'adversarial', stages: [stage, { id: 'review', title: 'Deliver', instruction: 'Review', toolPolicy: 'read_only', dependsOn: [stage.id] }] });
      f.engine.start(run.id); const stopped = await f.engine.wait(run.id);
      assert.equal(stopped.status, 'failed'); assert.match(stopped.error!, inspect === 'missing' ? /无法核查最终/ : /最终工作区版本已变化/);
      assert.equal(stopped.stages[0].status, 'completed'); assert.equal(stopped.stages[1].status, 'failed');
    } finally { f.dispose(); }
  }
});

test('manual approval in a new collaboration run remains separate and final inspection never replays stage tools', async () => {
  let value!: WorkflowNativeReceipt, calls = 0, stale = true;
  const f = fixture({ runStage: async (_id, _prompt, _title, submission) => { calls++; value = qualityReceipt(f.binding, submission!); return { success: true, summary: 'Implemented', nativeReceipt: value }; },
    inspectNativeTask: async () => { const task = taskFor(value); if (stale) task.workspace!.current.fingerprint = 'e'.repeat(64); return task; } });
  try {
    const run = f.engine.create({ sessionId: f.binding.sessionId, goal: 'Ship', collaboration: 'adversarial', stages: [{ ...stage, gate: 'manual' }] });
    f.engine.start(run.id); assert.equal((await f.engine.wait(run.id)).status, 'waiting_confirmation');
    assert.equal(f.engine.confirmStage({ id: run.id, stageId: stage.id, expectedAttempt: 1, decision: 'approve', reason: 'Human accepted' }).status, 'paused');
    f.engine.continue(run.id); const blocked = await f.engine.wait(run.id);
    assert.equal(blocked.status, 'interrupted'); assert.match(blocked.error!, /最终工作区版本/); assert.equal(calls, 1);
    stale = false; f.engine.continue(run.id); assert.equal((await f.engine.wait(run.id)).status, 'completed'); assert.equal(calls, 1);
    assert.equal(f.engine.list()[0].stages[0].confirmation!.decision, 'approve'); assert.equal(value.workflowQuality!.manualAcceptance, 'not_requested');
  } finally { f.dispose(); }
});

test('cancellation during final workspace inspection wins over a late passing task and retains the consumed receipt', async () => {
  let value!: WorkflowNativeReceipt, entered!: () => void, release!: () => void;
  const inspecting = new Promise<void>(resolve => { entered = resolve; }), pending = new Promise<void>(resolve => { release = resolve; });
  const f = fixture({ runStage: async (_id, _prompt, _title, submission) => { value = qualityReceipt(f.binding, submission!); return { success: true, summary: 'Implemented', nativeReceipt: value }; },
    inspectNativeTask: async () => { entered(); await pending; return taskFor(value); } });
  try {
    const run = f.engine.create({ sessionId: f.binding.sessionId, goal: 'Ship', collaboration: 'adversarial', stages: [stage] });
    f.engine.start(run.id); await inspecting; await f.engine.cancel(run.id); release();
    const cancelled = await f.engine.wait(run.id);
    assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.stages[0].status, 'cancelled');
    assert.equal(cancelled.stages[0].nativeReceipts?.[0].identity.runId, value.identity.runId); assert.equal(cancelled.usage?.modelRequests, 1);
  } finally { release(); f.dispose(); }
});

test('quality receipt schema rejects unbounded records and fabricated manual acceptance', () => {
  const value = qualityReceipt({ sessionId: randomUUID() } as WorkflowBinding, { requestId: 'workflow:test', nativeExecutionPolicy: { toolPolicy: 'standard', collaboration: 'adversarial' } });
  assert.equal(workflowQualityFailure(workflowNativeReceiptSchema.parse(value), 'adversarial'), undefined);
  const invalid = structuredClone(value) as unknown as { workflowQuality: { manualAcceptance: string; rounds: unknown[] } };
  invalid.workflowQuality.manualAcceptance = 'passed'; assert.throws(() => workflowNativeReceiptSchema.parse(invalid));
  invalid.workflowQuality.manualAcceptance = 'not_requested'; invalid.workflowQuality.rounds.push(...invalid.workflowQuality.rounds, ...invalid.workflowQuality.rounds);
  assert.throws(() => workflowNativeReceiptSchema.parse(invalid));
  assert.equal(workflowQualityFailure(undefined, 'single_agent'), undefined);
});
