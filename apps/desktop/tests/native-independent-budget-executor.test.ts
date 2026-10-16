import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runAgent } from '@cc-desk/agent-core';
import { createNativeModel } from '@cc-desk/agent-node/native-model';
import { StateStore } from '../src/main/store';
import { ExecutionEvents } from '../src/main/execution/events';
import { ConnectionStore } from '../src/main/engines/native/connections';
import { createNativeConfig } from '../src/main/engines/native/config';
import { NativeStructuredExecutor, type NativeExecutorOptions } from '../src/main/engines/native/structured-executor';
// @ts-expect-error 本地 HTTP 模型装置没有类型声明。
import { startResponsesFixture, functionCall, assistantMessage } from '../../../packages/agent-node/tests/fixtures/responses-server.mjs';

type Body = { input: Array<{ type: string; role?: string; content?: string | Array<{ text?: string }>; output?: string }> };
type Child = { childId: string; status: string; runId: string; reason?: string; recoverable?: boolean };
const output = (body: Body, name: string) => {
  const calls = body.input.filter(item => item.type === 'function_call') as unknown as Array<{ name: string; call_id: string }>;
  const call = calls.findLast(item => item.name === name);
  const result = body.input.findLast(item => item.type === 'function_call_output' && (item as unknown as { call_id: string }).call_id === call?.call_id);
  return result?.output ? JSON.parse(result.output).output : undefined;
};
const firstUser = (body: Body) => {
  const content = body.input.find(item => item.role === 'user')?.content;
  return typeof content === 'string' ? content : content?.map(item => item.text ?? '').join('') ?? '';
};

async function fixture(t: TestContext, handler: (body: Body) => unknown, overrides: Record<string, number> = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-independent-budget-'));
  const project = path.join(directory, 'project'), data = path.join(directory, 'data'); await fs.mkdir(project);
  await fs.writeFile(path.join(project, 'one.txt'), 'first evidence\n'); await fs.writeFile(path.join(project, 'two.txt'), 'second evidence\n');
  const git = (...args: string[]) => promisify(execFile)('git', ['-C', project, ...args]);
  await git('init', '-b', 'main'); await git('config', 'core.autocrlf', 'false');
  await git('config', 'user.name', 'Budget fixture'); await git('config', 'user.email', 'fixture@localhost');
  await git('add', '.'); await git('commit', '-m', 'Initial evidence');
  const server = await startResponsesFixture({ assertReplay: false, handler: ({ body }: { body: Body }) => handler(body) });
  const store = new StateStore(data), connections = new ConnectionStore(data), events = new ExecutionEvents();
  const draft = connections.upsert({ name: 'independent budget fixture', protocol: 'responses', baseURL: server.baseURL,
    model: 'fixture-model', enabled: true, allowLoopbackHttp: true, auth: { mode: 'memory' } });
  const connection = connections.setCredential({ id: draft.id, revision: draft.revision, mode: 'memory', secret: 'sk-independent-budget-fixture-only' });
  const id = randomUUID(), projectId = randomUUID(), now = new Date().toISOString();
  store.change(state => {
    state.projects.push({ id: projectId, name: 'budget project', path: project, createdAt: now });
    state.sessions.push({ id, projectId, title: 'independent budgets', kind: 'agent', cwd: project,
      execution: { providerId: 'native', mode: 'structured', conversationId: randomUUID() },
      engineConfig: createNativeConfig({ schemaVersion: 1, options: { connectionId: connection.id,
        maxModelRequests: 2, maxToolCalls: 2, maxActiveMs: 60_000, maxSubagents: 2, ...overrides } }),
      started: false, archived: false, status: 'idle', createdAt: now, updatedAt: now });
  });
  const dispatched: Parameters<NonNullable<NativeExecutorOptions['worker']>>[0][] = [];
  const worker: NonNullable<NativeExecutorOptions['worker']> = options => {
    dispatched.push(options);
    return runAgent({ ...options.request, signal: options.signal }, {
      model: createNativeModel(options.model), tools: options.tools, store: options.store, approvals: options.approvals,
      completionValidation: options.completionValidation, contextMaintenance: options.contextMaintenance,
      host: { now: Date.now, digest: value => createHash('sha256').update(value).digest('hex'), emit: options.onEvent,
        consumeBudget: options.consumeBudget,
        deadline: (ms, parent) => { const controller = new AbortController(), cancel = () => controller.abort(), timer = setTimeout(cancel, ms);
          parent.addEventListener('abort', cancel, { once: true }); if (parent.aborted) cancel();
          return { signal: controller.signal, dispose() { clearTimeout(timer); parent.removeEventListener('abort', cancel); } }; },
      },
    });
  };
  const executor = new NativeStructuredExecutor(store, connections, events, { worker }); await executor.initialize();
  t.after(async () => { await executor.shutdown(); await server.close(); store.flush(); await fs.rm(directory, { recursive: true, force: true }); });
  return { executor, id, server, dispatched, events, project };
}

test('main exceeds configured child request/tool/time limits and old workflow caps while keeping accounting', async t => {
  let step = 0, clock = 0;
  const f = await fixture(t, () => {
    clock += 2000;
    return { output: ++step === 1 ? [functionCall('first', 'read_file', { path: 'one.txt' }), functionCall('second', 'read_file', { path: 'two.txt' })]
      : [assistantMessage('done', 'Both actual files were read.')] };
  }, { maxModelRequests: 1, maxToolCalls: 1, maxActiveMs: 1000 });
  t.mock.method(performance, 'now', () => clock);
  const result = await f.executor.send(f.id, 'Inspect the two local files.', [], undefined, { requestId: 'unlimited-parent', source: 'workflow',
    nativeExecutionPolicy: { toolPolicy: 'standard', budget: { maxModelRequests: 1, maxToolCalls: 1, maxActiveMs: 1 } } });
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(f.dispatched[0].request.budget?.unlimited, true);
  assert.equal(f.server.requests.length, 2); assert.equal(result.nativeReceipt?.usage.modelRequests, 2);
  assert.equal(result.nativeReceipt?.usage.toolCalls, 2); assert.ok(result.nativeReceipt!.usage.activeMs >= 4000);
  assert.deepEqual(f.server.errors, []);
});

test('implementation recovery preserves applied work and starts automatically while new edits retain normal approval', async t => {
  let parentStep = 0, originalStep = 0, recoveryStep = 0, retainedCwd = '';
  const f = await fixture(t, body => {
    const goal = firstUser(body);
    if (goal.startsWith('Recover implementation')) {
      if (goal.includes('Host recovery instructions')) return { output: ++recoveryStep === 1
        ? [functionCall('inspect-existing', 'read_file', { path: 'one.txt' })] : [assistantMessage('recovered', 'Preserved the applied edit and completed remaining analysis.')] };
      return { output: ++originalStep === 1 ? [functionCall('read-original', 'read_file', { path: 'one.txt' })]
        : [functionCall('apply-once', 'apply_patch', { path: 'one.txt', content: 'preserved child change\n', expectedHash: createHash('sha256').update('first evidence\n').digest('hex') })] };
    }
    parentStep++;
    if (parentStep === 1) return { output: [functionCall('implement', 'delegate_implement', { baseline: 'head', tasks: [{ title: 'Retained edit', goal: 'Recover implementation' }] })] };
    const initial = output(body, 'delegate_implement');
    if (parentStep === 2) {
      assert.equal(initial.children[0].status, 'failed'); assert.equal(initial.children[0].recoverable, true); retainedCwd = initial.children[0].cwd;
      return { output: [functionCall('inspect-initial', 'read_agent_result', { parentRunId: initial.parentRunId, childId: initial.children[0].childId })] };
    }
    if (parentStep === 3) return { output: [functionCall('recover-implementation', 'recover_agent', { childId: initial.children[0].childId })] };
    const recovered = output(body, 'recover_agent'); assert.equal(recovered.children[0].status, 'completed'); assert.equal(recovered.children[0].cwd, retainedCwd);
    return { output: [assistantMessage('finished', 'The child continued in its preserved workspace.')] };
  });
  const approvals: string[] = [], seen = new Set<string>();
  const off = f.events.subscribe(event => {
    if (event.type !== 'conversation.changed') return;
    for (const request of f.executor.snapshot(f.id).pending) if (!seen.has(request.requestId)) {
      seen.add(request.requestId); approvals.push(request.toolName);
      queueMicrotask(() => f.executor.respond(f.id, request.requestId, { behavior: 'allow' }));
    }
  });
  try {
    const result = await f.executor.send(f.id, 'Continue an isolated implementation using its retained results.');
    assert.equal(result.success, true, JSON.stringify(result)); assert.deepEqual(approvals, ['delegate_implement', 'apply_patch']);
    assert.equal(await fs.readFile(path.join(retainedCwd, 'one.txt'), 'utf8'), 'preserved child change\n');
    assert.equal(await fs.readFile(path.join(f.project, 'one.txt'), 'utf8'), 'first evidence\n');
    assert.equal(originalStep, 2); assert.equal(recoveryStep, 2); assert.deepEqual(f.server.errors, []);
  } finally { off(); }
});

test('two child agents each receive the full configured budget rather than sharing it with their parent', async t => {
  const childSteps = new Map<string, number>();
  const f = await fixture(t, body => {
    const goal = firstUser(body);
    if (goal.startsWith('Budget child')) {
      const step = (childSteps.get(goal) ?? 0) + 1; childSteps.set(goal, step);
      return { output: step === 1 ? [functionCall('read-evidence', 'read_file', { path: 'one.txt' })] : [assistantMessage('child-done', 'Read actual evidence.')] };
    }
    const delegated = output(body, 'delegate_review');
    if (!delegated) return { output: [functionCall('delegate', 'delegate_review', { tasks: [
      { title: 'First child', goal: 'Budget child A' }, { title: 'Second child', goal: 'Budget child B' },
    ] })] };
    assert.deepEqual(delegated.children.map((child: Child) => child.status), ['completed', 'completed']);
    return { output: [assistantMessage('parent-done', 'Both independent children completed.')] };
  });
  const result = await f.executor.send(f.id, 'Inspect using independent helpers.');
  assert.equal(result.success, true, JSON.stringify(result)); assert.equal(f.server.requests.length, 6);
  const children = f.dispatched.filter(call => call.request.diagnosticPurpose === 'child'); assert.equal(children.length, 2);
  for (const child of children) { assert.equal(child.request.budget?.unlimited, false); assert.equal(child.request.budget?.maxModelRequests, 2); }
  assert.equal(result.nativeReceipt?.usage.modelRequests, 6); assert.equal(result.nativeReceipt?.usage.toolCalls, 3);
  assert.deepEqual(f.server.errors, []);
});

for (const policy of ['standard', 'read_only'] as const) test(`${policy}: a budget-exhausted child leaves its sibling and parent running and can be recovered automatically`, async t => {
  const childSteps = new Map<string, number>(); let parentSteps = 0, originalChildId = '';
  const f = await fixture(t, body => {
    const goal = firstUser(body);
    if (goal.startsWith('Budget child')) {
      const recovery = goal.includes('Host recovery instructions');
      const key = recovery ? 'recovered' : goal;
      const step = (childSteps.get(key) ?? 0) + 1; childSteps.set(key, step);
      if (step === 1 || goal === 'Budget child A' && step === 2) return { output: [functionCall(`read-${step}`, 'read_file', { path: step === 1 ? 'one.txt' : 'two.txt' })] };
      return { output: [assistantMessage('child-done', recovery ? 'Continued after inspecting preserved work.' : 'Sibling completed.')] };
    }
    parentSteps++;
    if (parentSteps === 1) return { output: [functionCall('delegate', 'delegate_review', { tasks: [
      { title: 'Budget failure', goal: 'Budget child A' }, { title: 'Successful sibling', goal: 'Budget child B' },
    ] })] };
    const delegated = output(body, 'delegate_review');
    if (parentSteps === 2) {
      const failed = delegated.children.find((child: Child) => child.status === 'failed');
      assert.equal(delegated.children.filter((child: Child) => child.status === 'completed').length, 1);
      assert.equal(failed.reason, 'model_request_budget'); assert.equal(failed.recoverable, true); originalChildId = failed.childId;
      return { output: [functionCall('inspect-failure', 'read_agent_result', { parentRunId: delegated.parentRunId, childId: originalChildId })] };
    }
    if (parentSteps === 3) return { output: [functionCall('recover', 'recover_agent', { childId: originalChildId })] };
    const recovered = output(body, 'recover_agent'); assert.equal(recovered.children[0].status, 'completed');
    assert.notEqual(recovered.children[0].childId, originalChildId);
    return { output: [assistantMessage('parent-done', 'The failed child recovered; sibling work was retained.')] };
  });
  const result = await f.executor.send(f.id, 'Inspect with helpers and recover a failed helper as needed.', [], undefined,
    { requestId: `recover-child-${policy}`, nativeExecutionPolicy: { toolPolicy: policy } });
  assert.equal(result.success, true, JSON.stringify(result)); assert.equal(parentSteps, 4);
  assert.equal(f.dispatched.filter(call => call.request.diagnosticPurpose === 'child').length, 3);
  const recovery = f.dispatched.find(call => String(call.request.input).includes('Host recovery instructions'))!;
  assert.match(recovery.request.input, /Never replay the previous journal/); assert.equal(recovery.request.budget?.maxModelRequests, 2);
  assert.equal(f.executor.recoveryRequired(f.id), false); assert.equal(f.executor.activeCount, 0);
  assert.deepEqual(f.server.errors, []);
});
