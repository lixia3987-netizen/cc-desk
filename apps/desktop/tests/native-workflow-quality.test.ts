import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runAgent, type ModelPort, type ModelResponse, type RunIdentity, type ToolCall } from '@cc-desk/agent-core';
import { createNativeModel } from '@cc-desk/agent-node/native-model';
import type { NativeQualityReportDeclaration } from '@cc-desk/contracts/native-workflow-quality';
import { createNativeWorkflowQualityController, loadNativeWorkflowQuality } from '../src/main/engines/native/workflow-quality';
import { runNativeAgentChild } from '../src/main/engines/native/agent-child-runner';
import { parseNativeConfig } from '../src/main/engines/native/config';
import type { NativeAgentChildInput, NativeAgentChildResult } from '../src/main/engines/native/agent-delegation';
import type { NativeWorkerOptions } from '../src/main/engines/native/worker-host';
import { nativeQualityDeclarationSchema, nativeQualityFindingsForRound, nativeQualityHostEvidence } from '../src/main/engines/native/workflow-quality-report';
import type { StoredRun } from '@cc-desk/agent-node/run-store';

const execute = promisify(execFile);
const identity = (): RunIdentity => ({ sessionId: randomUUID(), conversationId: randomUUID(), runId: randomUUID(), requestId: randomUUID(), workerGeneration: 1 });
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const completed = (): ModelResponse => ({ outputItems: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '独立检查已完成，具体状态以宿主结构化报告为准。' }] }], toolCalls: [], finishReason: 'completed', usage: null });
const tools = (...calls: ToolCall[]): ModelResponse => ({ outputItems: calls.map(call => ({ type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments })), toolCalls: calls, finishReason: 'tool_calls', usage: null });
const call = (name: string, input: unknown, id = randomUUID()): ToolCall => ({ id, name, arguments: JSON.stringify(input) });
type Behavior = { findingsFirstRound?: boolean; mutateVerifier?: boolean; noReport?: boolean; denied?: boolean; fakeCommand?: boolean; partialRead?: boolean; searchOnly?: boolean; omitFailedCommand?: boolean;
  chunkRead?: 'complete' | 'missing_middle' | 'missing_tail' | 'mixed_version' };

async function fixture(t: { after(fn: () => Promise<void>): void }, behavior: Behavior = {}) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cc-native-quality-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const cwd = path.join(directory, 'project'), dataDirectory = path.join(directory, 'data'); await fs.mkdir(cwd); await fs.mkdir(dataDirectory);
  const originalContent = behavior.chunkRead ? Array.from({ length: 400 }, (_, index) => `${String(index + 1).padStart(4, '0')}:${'x'.repeat(75)}`).join('\n') + '\n' : 'initial\n';
  await fs.writeFile(path.join(cwd, 'file.txt'), originalContent);
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-qm', 'initial']]) await execute('git', args, { cwd });
  const parent = identity(), abort = new AbortController(), children: NativeAgentChildInput[] = [], approvals: string[] = [];
  let active = 0, maximum = 0;
  const runChild = async (input: NativeAgentChildInput): Promise<NativeAgentChildResult> => {
    children.push(input); active++; maximum = Math.max(maximum, active);
    let step = 0;
    const readId = randomUUID(), commandId = randomUUID();
    const worker = async (options: NativeWorkerOptions) => {
      const transport = createNativeModel(options.model);
      const model: ModelPort = { protocol: transport.protocol, userItems: (text, images) => transport.userItems(text, images), toolResultItems: (tool, result) => transport.toolResultItems(tool, result),
        estimateInputTokens: context => transport.estimateInputTokens(context), generate: async request => {
          step++; let phase = step;
          assert.equal(options.request.diagnosticPurpose, 'child');
          assert.notEqual(request.identity.runId, parent.runId);
          if (input.quality?.role === 'verifier' && input.quality.validationMode === 'commands') {
            assert.ok(request.tools.some(tool => tool.name === 'run_command'));
            for (const name of ['apply_patch', 'write_file', 'delegate_review', 'delegate_implement', 'recover_agent']) assert.ok(!request.tools.some(tool => tool.name === name));
          } else assert.ok(request.tools.every(tool => tool.risk === 'read'));
          if (behavior.noReport) return completed();
          const chunkCalls = (ranges: number[][]) => ranges.map(([startLine, endLine], index) => call('read_file', { path: 'file.txt', startLine, endLine }, startLine === 1 && index === 0 ? readId : randomUUID()));
          if (behavior.chunkRead && step === 1) {
            const ranges = behavior.chunkRead === 'mixed_version' ? [[1, 100]] : behavior.chunkRead === 'missing_middle' ? [[1, 100], [301, 500]] :
              behavior.chunkRead === 'missing_tail' ? [[1, 100], [101, 200], [201, 300]] : [[1, 100], [101, 200], [201, 300], [301, 500]];
            return tools(...chunkCalls(ranges));
          }
          if (behavior.chunkRead === 'mixed_version' && step === 2) {
            await fs.writeFile(path.join(input.cwd, 'file.txt'), originalContent.replace(/x/gu, 'y'));
            return tools(...chunkCalls([[101, 200], [201, 300], [301, 500]]));
          }
          if (behavior.chunkRead === 'mixed_version' && step >= 3) {
            if (step === 3) await fs.writeFile(path.join(input.cwd, 'file.txt'), originalContent);
            phase--;
          }
          if (!behavior.chunkRead && step === 1) return tools(call(behavior.searchOnly ? 'search' : 'read_file', behavior.searchOnly ? { pattern: 'initial', path: 'file.txt' } :
            { path: 'file.txt', ...(behavior.partialRead ? { startLine: 1, endLine: 1 } : {}) }, readId));
          const command = input.quality!.role === 'verifier' && input.quality!.validationMode === 'commands';
          if (step === 2 && command) return tools(call('run_command', { executable: process.execPath,
            argv: ['-e', behavior.mutateVerifier ? 'require("node:fs").writeFileSync("file.txt","changed by verifier\\n")' : behavior.omitFailedCommand ? 'process.exit(1)' : 'process.stdout.write("independent check passed")'], cwd: '.', timeoutMs: 10000, maxOutputBytes: 4096 }, behavior.omitFailedCommand ? randomUUID() : commandId));
          if (step === 3 && command && behavior.omitFailedCommand) return tools(call('run_command', { executable: process.execPath, argv: ['-e', 'process.exit(0)'], cwd: '.', timeoutMs: 10000, maxOutputBytes: 4096 }, commandId));
          if (phase === (command ? behavior.omitFailedCommand ? 4 : 3 : 2)) {
            const finding = behavior.findingsFirstRound && input.quality!.round === 1 && input.quality!.role === 'challenger';
            const evidence = { toolCallId: readId, path: 'file.txt', fileHash: hash(await fs.readFile(path.join(input.cwd, 'file.txt'), 'utf8')), startLine: 1, endLine: 1 };
            const declaration: NativeQualityReportDeclaration = { verdict: finding ? 'changes_requested' : 'passed', reviewedPaths: ['file.txt'], limitations: [],
              findings: finding ? [{ id: 'root-counterexample', severity: 'high', title: '初始内容存在反例', detail: 'file.txt 尚未应用修复。', evidence: [evidence], reproduction: '读取第一行仍为 initial。' }] : [],
              resolutions: input.quality!.previousFindings.map(row => ({ findingId: row.id, status: 'resolved', evidence: [evidence], explanation: '当前版本已读取并确认修复。' })),
              verification: { status: command ? 'executed' : 'not_applicable', commandToolCallIds: command ? [behavior.fakeCommand ? 'invented-command' : commandId] : [], reason: command ? '实际独立命令终态检查。' : '本角色仅静态审阅；不声明执行测试。' } };
            return tools(call('submit_quality_report', declaration));
          }
          return completed();
        } };
      return runAgent({ ...options.request, signal: options.signal }, { model, tools: options.tools, store: options.store, approvals: options.approvals, completionValidation: options.completionValidation,
        host: { now: () => Date.now(), digest: hash, emit: options.onEvent,
          deadline: (milliseconds, parentSignal) => { const controller = new AbortController(), cancel = () => controller.abort(), timer = setTimeout(cancel, milliseconds);
            parentSignal.addEventListener('abort', cancel, { once: true }); if (parentSignal.aborted) cancel();
            return { signal: controller.signal, dispose: () => { clearTimeout(timer); parentSignal.removeEventListener('abort', cancel); } }; } } });
    };
    try { return await runNativeAgentChild(input, { dataDirectory, model: { baseURL: 'https://example.invalid/v1', model: 'test', apiKey: 'sk-quality-private' },
      config: parseNativeConfig({ schemaVersion: 1, options: { maxModelRequests: 20, maxToolCalls: 30, maxActiveMs: 60000 } }), forbiddenValues: ['sk-quality-private'], worker,
      approvals: { request: async request => { approvals.push(request.tool.name); return { binding: request.binding, expiresAt: request.expiresAt, decision: behavior.denied ? 'denied' : 'approved' }; } }, assertOwnership: async () => {} }); }
    finally { active--; }
  };
  const controller = (validationMode: 'commands' | 'static' = 'commands', maxSubagents = 3, goal = '修改并验证 file.txt', delivery = '当前实际待交付内容：已检查 file.txt，具体证据仍需独立审阅。') => {
    const value = createNativeWorkflowQualityController({ identity: parent, parentTaskId: randomUUID(), cwd, dataDirectory, goal, materialPaths: ['file.txt'], collaboration: 'adversarial', validationMode,
      maxSubagents, signal: abort.signal, forbiddenValues: ['sk-quality-private'], assertOwnership: async () => {}, runChild, readDelivery: () => delivery,
      createChildBudget: () => ({ consume: async () => true, remainingMs: () => 60000, snapshot: () => ({ modelRequests: 0, toolCalls: 0 }) }) });
    t.after(() => value.closeAll()); return value;
  };
  const candidate = () => ({ identity: parent, attempt: 17, context: { protocol: { id: 'openai-responses', version: 1 }, items: [] }, signal: abort.signal });
  return { directory, cwd, dataDirectory, parent, abort, children, approvals, controller, candidate, maximum: () => maximum };
}

test('quality completion requires three fresh isolated roles, durable structured reports and a real approved successful command', async t => {
  const f = await fixture(t), controller = f.controller();
  assert.deepEqual(await controller.validate(f.candidate()), { kind: 'accept' });
  const state = controller.snapshot();
  assert.equal(state.status, 'passed'); assert.equal(state.automaticReview, 'passed'); assert.equal(state.manualAcceptance, 'not_requested');
  assert.equal(state.round, 1); assert.equal(state.rounds[0].roles.length, 3); assert.equal(new Set(f.children.map(child => child.identity.conversationId)).size, 3);
  assert.equal(new Set(f.children.map(child => child.cwd)).size, 3); assert.ok(f.children.every(child => child.cwd !== f.cwd));
  assert.deepEqual(f.approvals, ['run_command']);
  const verifier = state.rounds[0].roles.find(role => role.role === 'verifier')!;
  assert.equal(verifier.report?.commandReceipts[0].successful, true); assert.equal(verifier.report?.commandReceipts[0].exitCode, 0);
  assert.ok(state.workspaceFingerprint); assert.equal(await fs.readFile(path.join(f.cwd, 'file.txt'), 'utf8'), 'initial\n');
  assert.equal(state.rounds[0].deliveryDigest, hash('当前实际待交付内容：已检查 file.txt，具体证据仍需独立审阅。'));
  assert.ok(f.children.every(child => child.goal.includes('当前实际待交付内容') && child.quality?.deliveryDigest === state.rounds[0].deliveryDigest));
  assert.deepEqual(await loadNativeWorkflowQuality({ dataDirectory: f.dataDirectory, identity: f.parent }), state);
  assert.equal(await loadNativeWorkflowQuality({ dataDirectory: f.dataDirectory, identity: { ...f.parent, sessionId: randomUUID() } }), undefined);
});

test('challenger findings return repair feedback and the next completion uses six fresh identities plus a new snapshot and fresh resolutions', async t => {
  const f = await fixture(t, { findingsFirstRound: true }), controller = f.controller('commands', 1);
  const first = await controller.validate(f.candidate());
  assert.equal(first.kind, 'continue');
  if (first.kind !== 'continue' || first.code !== 'workflow_quality_changes_requested') throw new Error('Expected repair feedback');
  assert.match(first.feedback, /初始内容存在反例/); assert.deepEqual(first.paths, ['file.txt']);
  const firstCommit = controller.snapshot().rounds[0].snapshotCommit;
  const priorFindingId = controller.snapshot().findings[0].id;
  assert.match(priorFindingId, /^quality-[a-f0-9]{40}$/u);
  await fs.writeFile(path.join(f.cwd, 'file.txt'), 'fixed\n');
  assert.deepEqual(await controller.validate({ ...f.candidate(), attempt: 99 }), { kind: 'accept' });
  const state = controller.snapshot();
  assert.equal(state.round, 2); assert.equal(state.rounds[0].status, 'changes_requested'); assert.equal(state.rounds[1].status, 'passed');
  assert.notEqual(state.rounds[1].snapshotCommit, firstCommit); assert.equal(new Set(f.children.map(child => child.identity.runId)).size, 6);
  assert.equal(f.maximum(), 1); assert.deepEqual(state.findings, []);
  assert.ok(state.rounds[1].roles.every(role => role.report?.declaration.resolutions[0].findingId === priorFindingId));
});

test('prose completion without submit_quality_report fails closed after two quality rounds without manual acceptance', async t => {
  const f = await fixture(t, { noReport: true }), controller = f.controller();
  assert.equal((await controller.validate(f.candidate())).kind, 'continue');
  await assert.rejects(controller.validate(f.candidate()), /two rounds/);
  const state = controller.snapshot(); assert.equal(state.status, 'blocked'); assert.equal(state.manualAcceptance, 'not_requested');
  assert.ok(state.rounds.every(round => round.roles.every(role => role.status === 'failed' && !role.report)));
});

test('static review explicitly records not-applicable verification and never executes commands', async t => {
  const f = await fixture(t), controller = f.controller('static');
  assert.deepEqual(await controller.validate(f.candidate()), { kind: 'accept' });
  assert.deepEqual(f.approvals, []);
  assert.ok(controller.snapshot().rounds[0].roles.every(role => role.report?.declaration.verification.status === 'not_applicable' && !role.report.commandReceipts.length));
});

test('a verifier command that edits its source cannot pass or change the parent workspace', async t => {
  const f = await fixture(t, { mutateVerifier: true }), controller = f.controller();
  assert.equal((await controller.validate(f.candidate())).kind, 'continue');
  const state = controller.snapshot(), verifier = state.rounds[0].roles.find(role => role.role === 'verifier')!;
  assert.equal(verifier.status, 'failed'); assert.equal(state.automaticReview, 'blocked'); assert.equal(state.workspaceFingerprint, undefined);
  assert.equal(await fs.readFile(path.join(f.cwd, 'file.txt'), 'utf8'), 'initial\n');
});

test('denied commands and invented successful command references cannot satisfy executable verification', async t => {
  for (const behavior of [{ denied: true }, { fakeCommand: true }]) {
    const f = await fixture(t, behavior), controller = f.controller();
    assert.equal((await controller.validate(f.candidate())).kind, 'continue');
    assert.equal(controller.snapshot().rounds[0].roles.find(role => role.role === 'verifier')?.status, 'failed');
  }
});

test('cancellation and incomplete material scope do not emit a passed state or start out-of-scope agents', async t => {
  const f = await fixture(t), controller = f.controller(); f.abort.abort();
  await assert.rejects(controller.validate(f.candidate())); assert.notEqual(controller.snapshot().status, 'passed'); assert.equal(f.children.length, 0);
  const other = await fixture(t), invalid = createNativeWorkflowQualityController({ identity: other.parent, parentTaskId: randomUUID(), cwd: other.cwd, dataDirectory: other.dataDirectory,
    collaboration: 'auto', validationMode: 'commands', goal: 'invalid materials', materialPaths: ['missing.txt'], signal: other.abort.signal, forbiddenValues: [], assertOwnership: async () => {}, readDelivery: () => 'pending delivery',
    createChildBudget: () => { throw new Error('must not allocate'); }, runChild: async () => { throw new Error('must not start'); } });
  t.after(() => invalid.closeAll()); await assert.rejects(invalid.validate(other.candidate()), /scope/); assert.equal(invalid.snapshot().status, 'unknown');
});

test('partial line reads and search hits cannot masquerade as complete material coverage', async t => {
  for (const behavior of [{ partialRead: true }, { searchOnly: true }]) {
    const f = await fixture(t, behavior), controller = f.controller('static');
    assert.equal((await controller.validate(f.candidate())).kind, 'continue');
    assert.ok(controller.snapshot().rounds[0].roles.every(role => role.status === 'failed' && !role.report));
  }
});

test('a failed verifier command cannot be hidden by citing only a later trivial successful command', async t => {
  const f = await fixture(t, { omitFailedCommand: true }), controller = f.controller();
  assert.equal((await controller.validate(f.candidate())).kind, 'continue');
  assert.equal(controller.snapshot().rounds[0].roles.find(role => role.role === 'verifier')?.status, 'failed');
  assert.equal(controller.snapshot().status, 'changes_requested');
});

test('oversized goals are never silently truncated and deleted source requires explicit baseline evidence', async t => {
  const f = await fixture(t), controller = f.controller('static', 3, 'a'.repeat(6500) + '末尾要求不能丢失');
  assert.equal((await controller.validate(f.candidate())).kind, 'continue');
  assert.equal(f.children.length, 0); assert.ok(controller.snapshot().rounds[0].roles.every(role => role.status === 'failed'));
  const deleted = await fixture(t), deletion = deleted.controller(); await fs.rm(path.join(deleted.cwd, 'file.txt'));
  await assert.rejects(deletion.validate(deleted.candidate()), /deleted_materials/); assert.equal(deleted.children.length, 0);
  assert.equal(deletion.snapshot().status, 'unknown');
});

test('matching model-local finding IDs from different reviewers remain distinct host findings', () => {
  const finding = { id: 'P1-1', severity: 'high' as const, title: 'different defects', detail: 'actual issue', reproduction: 'reproduce',
    evidence: [{ path: 'file.txt', fileHash: hash('initial\n'), startLine: 1, endLine: 1, toolCallId: 'read' }] };
  const roles = (['reviewer', 'challenger'] as const).map(role => ({ role, childId: randomUUID(), identity: identity(), taskId: randomUUID(), cwd: '/tmp', status: 'completed' as const,
    report: { version: 1 as const, role, round: 1, identity: identity(), taskId: randomUUID(), snapshotCommit: 'a'.repeat(40), workspaceFingerprint: 'b'.repeat(64), submittedAt: new Date().toISOString(),
      materialReads: [], commandReceipts: [], declaration: { verdict: 'changes_requested' as const, reviewedPaths: ['file.txt'], limitations: [], findings: [finding], resolutions: [],
        verification: { status: 'not_applicable' as const, commandToolCallIds: [], reason: 'static' } } } }));
  const rows = nativeQualityFindingsForRound(roles);
  assert.equal(rows.length, 2); assert.notEqual(rows[0].id, rows[1].id);
  assert.deepEqual(nativeQualityFindingsForRound(roles), rows); assert.equal(roles[0].report.declaration.findings[0].id, 'P1-1');
});

test('explicit material scope cannot hide changed files outside the parent cwd', async t => {
  const f = await fixture(t), cwd = path.join(f.cwd, 'nested'); await fs.mkdir(cwd); await fs.writeFile(path.join(cwd, 'nested.txt'), 'nested source\n');
  for (const args of [['add', '.'], ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-qm', 'nested']]) await execute('git', args, { cwd: f.cwd });
  await fs.writeFile(path.join(f.cwd, 'file.txt'), 'outside-cwd change\n');
  const controller = createNativeWorkflowQualityController({ identity: f.parent, parentTaskId: randomUUID(), cwd, dataDirectory: f.dataDirectory, collaboration: 'auto', validationMode: 'static',
    goal: 'review nested', materialPaths: ['nested.txt'], readDelivery: () => 'only nested was reviewed', signal: f.abort.signal, forbiddenValues: [], assertOwnership: async () => {},
    createChildBudget: () => { throw new Error('must not allocate'); }, runChild: async () => { throw new Error('must not start'); } });
  t.after(() => controller.closeAll()); await assert.rejects(controller.validate(f.candidate()), /outside_observed_scope/); assert.equal(controller.snapshot().status, 'unknown');
});

test('the complete proposed delivery is mandatory and oversized delivery is never silently truncated', async t => {
  const empty = await fixture(t), missing = empty.controller('static', 3, 'review', '');
  await assert.rejects(missing.validate(empty.candidate()), /quality_parent_delivery_missing/); assert.equal(empty.children.length, 0);
  const huge = await fixture(t), bounded = huge.controller('static', 3, 'review', 'a'.repeat(6500) + '末尾实际结论');
  assert.equal((await bounded.validate(huge.candidate())).kind, 'continue'); assert.equal(huge.children.length, 0);
  assert.notEqual(bounded.snapshot().status, 'passed');
});

test('large real materials can be read in same-version line chunks with exact host hash and byte reconstruction', async t => {
  const f = await fixture(t, { chunkRead: 'complete' }), controller = f.controller('static');
  assert.ok((await fs.stat(path.join(f.cwd, 'file.txt'))).size > 30000);
  assert.deepEqual(await controller.validate(f.candidate()), { kind: 'accept' });
  for (const role of controller.snapshot().rounds[0].roles) {
    assert.equal(role.report?.materialReads.length, 4); assert.equal(new Set(role.report?.materialReads.map(read => read.fileHash)).size, 1);
  }
});

test('large-file chunks missing middle or tail, or crossing source versions, cannot establish complete coverage', async t => {
  for (const chunkRead of ['missing_middle', 'missing_tail', 'mixed_version'] as const) {
    const f = await fixture(t, { chunkRead }), controller = f.controller('static');
    assert.equal((await controller.validate(f.candidate())).kind, 'continue');
    assert.ok(controller.snapshot().rounds[0].roles.every(role => role.status === 'failed' && !role.report));
  }
});

test('a staged rename cannot conceal the removed source path from baseline-evidence checks', async t => {
  const f = await fixture(t); await execute('git', ['mv', 'file.txt', 'renamed.txt'], { cwd: f.cwd });
  const controller = createNativeWorkflowQualityController({ identity: f.parent, parentTaskId: randomUUID(), cwd: f.cwd, dataDirectory: f.dataDirectory,
    collaboration: 'auto', validationMode: 'static', goal: 'review renamed file', materialPaths: ['renamed.txt'], readDelivery: () => 'rename reviewed', signal: f.abort.signal,
    forbiddenValues: [], assertOwnership: async () => {}, createChildBudget: () => { throw new Error('must not allocate'); }, runChild: async () => { throw new Error('must not start'); } });
  t.after(() => controller.closeAll()); await assert.rejects(controller.validate(f.candidate()), /deleted_materials/);
  assert.ok(controller.snapshot().rounds[0].issues.includes('quality_deleted_materials_need_explicit_baseline_evidence'));
});

test('the 65th failed command cannot be hidden beyond an evidence projection limit', () => {
  const run = { tools: Array.from({ length: 65 }, (_, index) => ({ call: { id: `command-${index}`, name: 'run_command' },
    prepared: { prepared: { definition: { risk: 'command' }, input: {} } }, completed: { result: { status: index === 64 ? 'failed' : 'completed', output: {
      exitCode: index === 64 ? 1 : 0, cleanup: 'released', cancelled: false, timedOut: false, signal: null, truncated: false } } } })) } as unknown as StoredRun;
  assert.throws(() => nativeQualityHostEvidence(run), /quality_evidence_limit/);
});

test('a later version observation invalidates an earlier complete read even when the source was restored', () => {
  const read = (id: string, content: string, startLine?: number) => ({ call: { id, name: 'read_file' }, prepared: { prepared: { definition: { risk: 'read' }, input: { path: 'file.txt', ...(startLine === undefined ? {} : { startLine }) } } },
    completed: { result: { status: 'completed', output: { path: 'file.txt', hash: hash(content), content, bytes: Buffer.byteLength(content), truncated: false } } } });
  const run = { tools: [read('full-old', 'initial\n'), read('partial-new', 'changed\n', 1), read('restored', 'initial\n')] } as unknown as StoredRun;
  assert.throws(() => nativeQualityHostEvidence(run), /quality_material_version_changed/);
});

test('a single structured report cannot reuse finding IDs or resolution IDs', () => {
  const evidence = [{ toolCallId: 'read', path: 'file.txt', fileHash: hash('initial\n'), startLine: 1, endLine: 1 }];
  const finding = { id: 'P1-1', severity: 'high', title: 'finding', detail: 'issue', evidence, reproduction: 'actual reproduction' };
  const resolution = { findingId: 'quality-previous', status: 'resolved', evidence, explanation: 'actual explanation' };
  const declaration = { verdict: 'changes_requested', reviewedPaths: ['file.txt'], limitations: [], findings: [finding], resolutions: [resolution],
    verification: { status: 'not_applicable', commandToolCallIds: [], reason: 'static' } };
  assert.equal(nativeQualityDeclarationSchema.safeParse(declaration).success, true);
  assert.equal(nativeQualityDeclarationSchema.safeParse({ ...declaration, findings: [finding, { ...finding, detail: 'different issue with reused ID' }] }).success, false);
  assert.equal(nativeQualityDeclarationSchema.safeParse({ ...declaration, resolutions: [resolution, { ...resolution, explanation: 'another resolution with reused ID' }] }).success, false);
});
