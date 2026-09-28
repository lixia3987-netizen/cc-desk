import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { NativeTaskStore, type NativeTaskStoreFaultPoint } from '@cc-desk/agent-node/task-store';
import type { PreparedTool, ToolPort, ToolResult } from '@cc-desk/agent-core';
import { NativeTaskSession } from '../src/main/engines/native/task-session';

function prepared(id = 'start-1', name = 'start_command'): PreparedTool {
  return { call: { id, name, arguments: '{"executable":"node","argv":["--test"],"cwd":"."}' },
    definition: { name, risk: 'command', description: '', inputSchema: {} }, input: { executable: 'node', argv: ['--test'], cwd: '.' },
    inputDigest: 'a'.repeat(64), policyRevision: 'test', requiresApproval: true, preconditions: {} };
}
function result(output: Record<string, unknown> = {}, status: ToolResult['status'] = 'completed'): ToolResult {
  return { status, output: { exitCode: 0, signal: null, stdout: 'PASS', stderr: '', outputBytes: 4, truncated: false,
    timedOut: false, cancelled: false, cleanup: 'released', ...output } as ToolResult['output'] };
}
async function fixture(hasPlan = true) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-task-commands-'));
  const project = path.join(directory, 'project'); await fs.mkdir(project);
  const target = path.join(project, 'source.ts'); await fs.writeFile(target, 'export const value = 1;\n');
  const identity = { sessionId: randomUUID(), conversationId: randomUUID(), runId: randomUUID(), requestId: randomUUID(), workerGeneration: 1 };
  const taskId = randomUUID(), signal = new AbortController().signal;
  let fault: ((point: NativeTaskStoreFaultPoint) => void) | undefined;
  const store = await NativeTaskStore.open({ rootDirectory: path.join(directory, 'private'), sessionId: identity.sessionId,
    conversationId: identity.conversationId, fault: point => fault?.(point) });
  const session = new NativeTaskSession(store, { projectRoot: project, excludedRoots: [], assertSafe: () => {}, changed: () => {} });
  const plan = async (title = 'Implement change') => {
    const current = store.read(taskId);
    const task = await store.apply({ identity, taskId, mutationId: randomUUID(), expectedRevision: current?.revision ?? 0, mutation: { type: 'plan', plan: {
      goal: 'Update source', steps: [{ id: 'implement', title, status: 'in_progress', dependsOn: [] }],
      criteria: [{ id: 'tests', description: 'Relevant tests pass', kind: 'command', stepIds: ['implement'] }],
    } } });
    await session.planCommitted(task);
  };
  if (hasPlan) await plan();
  const start = (value = prepared()) => session.commandStarted({ taskId, identity, prepared: value, signal });
  const finish = (value = result(), callId = 'start-1') => session.commandTerminated({ taskId, identity, callId, result: value });
  return { directory, project, target, taskId, identity, signal, session, store, start, finish, plan,
    get task() { return store.read(taskId)!; },
    setFault(value: typeof fault) { fault = value; },
    async dispose() { await store.close(); await fs.rm(directory, { recursive: true, force: true }); },
  };
}

test('start/status/output/stop completions are not command evidence; only the terminal observer records the original start', async () => {
  const f = await fixture();
  try {
    const port: ToolPort = { definitions: [], prepare: async () => prepared(), validate: async () => {}, execute: async () => result({ commandId: 'handle', state: 'running' }) };
    const wrapped = f.session.wrapTools(port, f.taskId, f.identity);
    await f.start();
    for (const name of ['start_command', 'command_status', 'read_command_output', 'stop_command']) {
      const call = prepared(name === 'start_command' ? 'start-1' : name, name);
      const receipt = await wrapped.execute(call, { identity: f.identity, policyRevision: 'test', signal: f.signal, maxOutputBytes: 65536 });
      await f.session.committed(f.taskId, f.identity, { type: 'tool_completed', call: call.call, result: receipt, resultItems: [] });
      assert.equal(f.task.evidence.length, 0);
    }
    await f.finish();
    assert.equal(f.task.evidence.length, 1);
    const evidence = f.task.evidence[0];
    assert.equal(evidence.toolCallId, 'start-1'); assert.equal(evidence.source, 'command'); assert.equal(evidence.status, 'unverified');
    assert.equal(evidence.workspaceComplete, true); assert.deepEqual(evidence.stepIds, ['implement']); assert.deepEqual(evidence.criterionIds, []);
    assert.deepEqual(evidence.command, { executable: 'node', argv: ['--test'], cwd: '.' }); assert.equal(f.task.verification, 'unverified');
    await f.finish(result({ exitCode: 1 }, 'failed'));
    assert.equal(f.task.evidence.length, 1, 'duplicate terminal callback cannot replace the original receipt');
  } finally { await f.dispose(); }
});

test('terminal failure, timeout, cancellation and uncertain cleanup preserve real outcomes without passing', async () => {
  const f = await fixture();
  try {
    const cases: [ToolResult, string, boolean][] = [
      [result({ exitCode: 1, stdout: 'ALL PASSED' }, 'failed'), 'failed', true],
      [result({ timedOut: true, exitCode: null }, 'failed'), 'failed', true],
      [result({ cancelled: true, exitCode: null }, 'cancelled'), 'unverified', true],
      [result({ cleanup: 'cleanup_failed' }, 'unknown'), 'unverified', false],
    ];
    for (let index = 0; index < cases.length; index++) {
      await f.start(prepared(`terminal-${index}`)); await f.finish(cases[index][0], `terminal-${index}`);
      const evidence = f.task.evidence.at(-1)!;
      assert.equal(evidence.status, cases[index][1]); assert.equal(evidence.workspaceComplete, cases[index][2]);
      assert.notEqual(f.task.verification, 'passed');
    }
  } finally { await f.dispose(); }
});

test('terminal captures the actual after workspace and keeps pre-command edits as the baseline', async () => {
  const f = await fixture();
  try {
    await f.start();
    const before = f.task.workspace!.current.fingerprint;
    await fs.writeFile(f.target, 'export const value = 2;\n');
    await f.finish();
    const evidence = f.task.evidence[0];
    assert.notEqual(evidence.workspaceFingerprint, before); assert.equal(evidence.workspaceFingerprint, f.task.workspace!.current.fingerprint);
    assert.equal(evidence.workspaceComplete, false); assert.equal(evidence.status, 'unverified');
    assert.deepEqual(f.task.workspace!.changes.modified, ['source.ts']);
  } finally { await f.dispose(); }
});

test('overlapping commands and a wrapped write keep workspace evidence incomplete even when final bytes match', async () => {
  const f = await fixture();
  try {
    await f.start(prepared('first')); await f.start(prepared('second'));
    await f.finish(result(), 'first'); await f.finish(result(), 'second');
    assert.ok(f.task.evidence.every(evidence => !evidence.workspaceComplete && /其他命令/.test(evidence.reason!)));
    await f.start(prepared('third'));
    const port: ToolPort = { definitions: [], prepare: async () => prepared(), validate: async () => {}, execute: async () => {
      const old = await fs.readFile(f.target); await fs.writeFile(f.target, 'temporary'); await fs.writeFile(f.target, old);
      return { status: 'completed', output: {} };
    } };
    await f.session.wrapTools(port, f.taskId, f.identity).execute(prepared('edit', 'apply_patch'), {
      identity: f.identity, policyRevision: 'test', signal: f.signal, maxOutputBytes: 65536,
    });
    await f.finish(result(), 'third'); assert.equal(f.task.evidence.at(-1)!.workspaceComplete, false);
  } finally { await f.dispose(); }
});

test('plan changes while a command runs do not attach its terminal receipt to a replacement step', async () => {
  const f = await fixture();
  try {
    await f.start(); await f.plan('New implementation scope'); await f.finish(result({ exitCode: 2 }, 'failed'));
    const evidence = f.task.evidence[0];
    assert.equal(evidence.status, 'failed'); assert.deepEqual(evidence.stepIds, []); assert.match(evidence.reason!, /计划已改变/);
  } finally { await f.dispose(); }
});

test('commands before a plan keep bounded terminal summaries and attach only after a same-run plan exists', async () => {
  const f = await fixture(false);
  try {
    await f.start(); await f.finish(result({ stdout: 'x'.repeat(64000) }));
    assert.equal(f.task, null); await f.plan();
    const evidence = f.task.evidence[0];
    assert.equal(evidence.status, 'unverified'); assert.equal(evidence.truncated, true); assert.ok(Buffer.byteLength(evidence.output!) <= 8192);
    assert.equal(evidence.outputDigest!.length, 64); assert.deepEqual(evidence.stepIds, []); assert.match(evidence.reason!, /尚无计划/);
    await f.plan(); assert.equal(f.task.evidence.length, 1);
  } finally { await f.dispose(); }
});

test('pending observation admission is bounded and a later plan releases completed slots', async () => {
  const f = await fixture(false);
  try {
    for (let index = 0; index < 32; index++) { await f.start(prepared(`pending-${index}`)); await f.finish(result(), `pending-${index}`); }
    await assert.rejects(f.start(prepared('overflow')), /上限/);
    await f.plan(); assert.equal(f.task.evidence.length, 32);
    await f.start(prepared('after-plan')); await f.finish(result(), 'after-plan'); assert.equal(f.task.evidence.length, 33);
  } finally { await f.dispose(); }
});

test('wrong task/run callbacks cannot consume a receipt or attach evidence to a continued run', async () => {
  const f = await fixture();
  try {
    await f.start();
    await f.session.commandTerminated({ taskId: randomUUID(), identity: f.identity, callId: 'start-1', result: result() });
    await f.session.commandTerminated({ taskId: f.taskId, identity: { ...f.identity, workerGeneration: 2 }, callId: 'start-1', result: result() });
    assert.equal(f.task.evidence.length, 0);
    await f.store.apply({ taskId: f.taskId, identity: f.identity, expectedRevision: f.task.revision, mutationId: randomUUID(), mutation: { type: 'finish', outcome: 'interrupted' } });
    const nextIdentity = { ...f.identity, runId: randomUUID(), requestId: randomUUID(), workerGeneration: 2 };
    await f.session.continueTask(f.taskId, nextIdentity, async () => {});
    await f.finish(); assert.equal(f.task.evidence.length, 0);
    await assert.rejects(f.start(prepared('stale-start')), /运行已改变/);
  } finally { await f.dispose(); }
});

test('task publication failure never replays or overwrites a terminal and does not block subsequent terminal observation', async () => {
  const f = await fixture();
  try {
    await f.start(prepared('first')); await f.start(prepared('second'));
    let injected = false;
    f.setFault(point => { if (point === 'before_write' && !injected) { injected = true; throw new Error('metadata write failed'); } });
    await assert.rejects(f.finish(result({ exitCode: 1 }, 'failed'), 'first'), /metadata write failed/);
    f.setFault(undefined);
    await f.finish(result(), 'first'); assert.equal(f.task.evidence.length, 0);
    await f.finish(result({ exitCode: 2 }, 'failed'), 'second');
    assert.equal(f.task.evidence.length, 1); assert.equal(f.task.evidence[0].toolCallId, 'second'); assert.equal(f.task.evidence[0].status, 'failed');
  } finally { await f.dispose(); }
});
