import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { desktopRoot } from './helpers/paths';
import { electronLaunchArgs } from './helpers/electron-launch';
import { captureNativeDiagnostics, closeNativeApp } from './helpers/native-app-cleanup';
import { openChatAssistance } from './helpers/chat-assistance';
import { NativeRunStore } from '@cc-desk/agent-node/run-store';
import type { NativeDelegationReceipt } from '../src/main/engines/native/agent-delegation';
import { nativeDelegationExecutionPath, type NativeDelegationExecution } from '../src/main/engines/native/agent-delegation-audit';
import { buildNativeReviewGoal } from '../src/main/engines/native/agent-prompts';
import type { ChatTurnResult } from '../src/shared/chat';
// @ts-expect-error Real HTTP/SSE fixture shared with agent-node integration tests.
import { assistantMessage, functionCall, startResponsesFixture } from '../../../packages/agent-node/tests/fixtures/responses-server.mjs';

const execute = promisify(execFile), secret = 'sk-native-task-pool-fixture-only';
const names = ['A', 'B', 'C', 'D', 'E'] as const;
interface Item { type?: string; role?: string; content?: string | Array<{ text?: string }>; call_id?: string; output?: string }
interface Body { input: Item[]; instructions: string; tools: Array<{ name: string }> }
interface Response { output?: unknown[]; hang?: boolean }
interface Fixture { baseURL: string; requests: Body[]; errors: unknown[]; close(): Promise<void> }
interface ToolResult { status: string; output: { hash?: string; content?: string; parentRunId?: string; children?: Array<{ childId: string }>; result?: { acceptance: string; agent: { status: string } } } }
const results = (body: Body) => new Map(body.input.filter(item => item.type === 'function_call_output').map(item => [item.call_id!, JSON.parse(item.output!) as ToolResult]));
const childRequest = (body: Body) => body.instructions.includes('independent delegated Native agent');
const childName = (body: Body) => {
  const goal = body.input.find(item => item.role === 'user')?.content;
  const text = typeof goal === 'string' ? goal : goal?.map(item => item.text ?? '').join('') ?? '';
  const name = /^POOL_([A-E]):/u.exec(text)?.[1];
  if (!name) throw new Error('Unexpected task-pool child goal');
  return name;
};
const call = (id: string, name: string, input: unknown): Response => ({ output: [functionCall(id, name, input)] });
const final = (id: string, text: string): Response => ({ output: [assistantMessage(id, text)] });
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
function parentResponse(body: Body): Response {
  const done = results(body);
  if (!done.has('pool-plan')) return call('pool-plan', 'update_plan', { expectedRevision: 0,
    plan: { goal: 'Review five independent questions with bounded concurrency', steps: [{ id: 'review', title: 'Review every child result', dependsOn: [], status: 'in_progress' }],
      criteria: [{ id: 'acceptance', description: 'Inspect actual child evidence before manual acceptance', stepIds: ['review'], kind: 'manual' }] } });
  if (!done.has('pool-delegate')) return call('pool-delegate', 'delegate_review', { tasks: names.map((name, index) => ({
    title: `排队审阅 ${name}`, goal: `POOL_${name}:\n` + buildNativeReviewGoal({ materials: 'file `fixture.txt`',
      version: 'Current local source; obtain its full content and actual read hash.', question: `Independent question ${index + 1}: does fixture.txt contain the marker for ${name}?`,
      scope: `Only the ${name} marker in fixture.txt`, evidence: 'No parent read evidence; obtain an actual read receipt.', exclusions: `Do not decide any other marker than ${name}.` }),
  })) });
  const delegated = done.get('pool-delegate')!;
  expect(delegated.status).toBe('completed'); expect(delegated.output.children).toHaveLength(5);
  for (let index = 0; index < names.length; index++) {
    if (!done.has(`pool-result-${index}`)) return call(`pool-result-${index}`, 'read_agent_result', { parentRunId: delegated.output.parentRunId,
      childId: delegated.output.children![index].childId });
    expect(done.get(`pool-result-${index}`)?.status).toBe('completed');
    expect(done.get(`pool-result-${index}`)?.output.result?.agent.status).toBe('completed');
    expect(done.get(`pool-result-${index}`)?.output.result?.acceptance).toBe('not_assessed');
  }
  return final('pool-final', 'Five independent saved results inspected; manual acceptance remains pending.');
}
async function workspace() {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ccdesk-native-task-pool-电子 空格-')));
  const data = path.join(directory, 'data'), cwd = path.join(directory, 'project'), projectId = randomUUID();
  await fs.mkdir(data); await fs.mkdir(cwd); await fs.writeFile(path.join(cwd, 'fixture.txt'), 'A B C D E\n');
  await execute('git', ['-C', cwd, 'init', '-b', 'main']);
  await execute('git', ['-C', cwd, 'config', 'user.name', 'Native pool fixture']);
  await execute('git', ['-C', cwd, 'config', 'user.email', 'native-pool@localhost']);
  await execute('git', ['-C', cwd, 'add', '--all']); await execute('git', ['-C', cwd, 'commit', '-m', 'Pool baseline']);
  await fs.writeFile(path.join(data, 'workspace.json'), JSON.stringify({ version: 3, projects: [{ id: projectId, name: 'Native task pool', path: cwd, createdAt: new Date().toISOString() }],
    sessions: [], settings: { claudePath: path.join(directory, 'missing-claude'), shellPath: '', maxSessions: 4, fontSize: 14, scrollback: 8000, engineDefaults: {} } }));
  return { directory, data, cwd, projectId, launch: async () => captureNativeDiagnostics(await electron.launch({ args: electronLaunchArgs(), cwd: desktopRoot,
    env: { ...process.env, WORKBENCH_TEST_MODE: '1', WORKBENCH_DATA_DIR: data } })),
  dispose: () => fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) };
}
async function ready(app: ElectronApplication) { const page = await app.firstWindow(); await expect(page.locator('main.workspace')).toBeVisible(); return page; }
async function configure(page: Page, projectId: string, baseURL: string, maxSubagents = 2) {
  return page.evaluate(async ({ projectId, baseURL, secret, maxSubagents }) => {
    const initial = await window.desktop.nativeConnections.upsert({ name: 'Task pool fixture', protocol: 'responses', baseURL,
      model: 'fixture-model', enabled: true, allowLoopbackHttp: true, auth: { mode: 'memory' } });
    const connection = await window.desktop.nativeConnections.setCredential({ id: initial.id, revision: initial.revision, mode: 'memory', secret });
    const session = await window.desktop.createSession({ projectId, title: `Native pool capacity ${maxSubagents}`, kind: 'agent', providerId: 'native', mode: 'structured', isolated: false,
      engineConfig: { schemaVersion: 1, options: { connectionId: connection.id, model: '', maxSubagents, maxModelRequests: 30, maxToolCalls: 60, maxActiveMs: 120000 } } });
    await window.desktop.setSelection(session.id); return session;
  }, { projectId, baseURL, secret, maxSubagents });
}
const snapshot = (page: Page, id: string) => page.evaluate(id => window.desktop.chatSnapshot(id), id);
const workers = (app: ElectronApplication) => app.evaluate(({ app }) => app.getAppMetrics().filter(metric =>
  metric.serviceName === 'cc-desk native agent' || metric.name === 'cc-desk native agent').length);
async function receipts(directory: string): Promise<NativeDelegationReceipt[]> {
  const found: NativeDelegationReceipt[] = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith('.')) found.push(...await receipts(target));
    else if (entry.isFile() && entry.name === 'receipt.json') {
      const value = JSON.parse(await fs.readFile(target, 'utf8')) as NativeDelegationReceipt;
      if (value.version === 1 && value.childId && value.parentIdentity) found.push(value);
    }
  }
  return found;
}
async function diagnostic(page: Page, sessionId: string, fixture: Fixture, data: string) {
  const saved = await snapshot(page, sessionId).catch(() => undefined), children = await receipts(data).catch(() => []);
  const metadata = { requestActors: fixture.requests.map(body => childRequest(body) ? childName(body) : 'parent'),
    errors: fixture.errors.map(String), runtime: saved?.nativeAgentRuntime, children: children.map(child => ({ childId: child.childId,
      status: child.status, resultStatus: child.result?.status, error: child.error, runId: child.identity.runId })) };
  await test.info().attach('task-pool-metadata.json', { body: Buffer.from(JSON.stringify(metadata, null, 2).replaceAll(secret, '[redacted]')), contentType: 'application/json' });
}
function observe(pending: Promise<ChatTurnResult>) {
  let settled: ChatTurnResult | Error | undefined;
  void pending.then(value => { settled = value; }, error => { settled = error instanceof Error ? error : new Error(String(error)); });
  return () => settled;
}
async function approve(page: Page, sessionId: string, toolName: string) {
  let requestId: string | undefined;
  await expect.poll(async () => { requestId = (await snapshot(page, sessionId)).pending.find(item => item.toolName === toolName)?.requestId; return requestId; }, { timeout: 20000 }).toBeTruthy();
  const approval = page.getByRole('region', { name: '工具审批', exact: true });
  await expect(approval).toHaveAttribute('data-request-id', requestId!);
  await expect(approval).toContainText(toolName);
  await approval.getByRole('button', { name: '允许本次', exact: true }).click();
}

test('five physical children refill a two-slot pool in FIFO order while the first child remains active', async () => {
  test.setTimeout(120000);
  const f = await workspace(), barriers = new Map(names.map(name => [name, gate()])), started: string[] = [];
  const fixture: Fixture = await startResponsesFixture({ assertReplay: false, handler: async ({ body }: { body: Body }): Promise<Response> => {
    if (!childRequest(body)) return parentResponse(body);
    const name = childName(body), done = results(body);
    expect(body.tools.some(tool => ['delegate_review', 'delegate_implement', 'apply_patch', 'run_command'].includes(tool.name))).toBe(false);
    if (!done.has(`pool-child-${name}-read`)) {
      expect(started).not.toContain(name); started.push(name); await barriers.get(name as typeof names[number])!.promise;
      return call(`pool-child-${name}-read`, 'read_file', { path: 'fixture.txt' });
    }
    expect(done.get(`pool-child-${name}-read`)?.status).toBe('completed');
    return final(`pool-child-${name}-final`, `Marker ${name} is present in fixture.txt; actual file read completed.`);
  } });
  const app = await f.launch();
  let page: Page | undefined, sessionId = '';
  try {
    page = await ready(app); const session = await configure(page, f.projectId, fixture.baseURL); sessionId = session.id;
    const pending = page.evaluate(id => window.desktop.sendChat(id, '请使用 5 个子 agent 并行审阅 fixture.txt 的五个独立标记，最大并发为本会话设置的两个。', [], 'pool-fifo'), session.id), settled = observe(pending);
    await expect.poll(() => { if (settled()) throw new Error('Parent settled before pool launch'); return [...started].sort(); }, { timeout: 20000 }).toEqual(['A', 'B']);
    const initialOrder = [...started]; // Concurrent workers may reach HTTP in either order.
    await expect.poll(async () => { const state = (await snapshot(page!, session.id)).nativeAgentRuntime; return { active: state?.active, queued: state?.queued, total: state?.total }; }).toEqual({ active: 2, queued: 3, total: 5 });
    expect(await workers(app)).toBe(3);
    const initial = await receipts(f.data); expect(initial).toHaveLength(5);
    expect(initial.filter(child => child.status === 'queued')).toHaveLength(3);
    for (const queued of initial.filter(child => child.status === 'queued')) {
      expect(queued.result).toBeUndefined();
      expect(await fs.stat(path.join(f.data, 'native', 'conversations', queued.identity.conversationId)).then(() => true, () => false)).toBe(false);
    }
    await openChatAssistance(page, 'agents');
    const panel = page.getByRole('region', { name: 'Native Agent 协作', exact: true });
    await expect(panel).toContainText(/排队(?:中)?\s*3/u);
    await page.screenshot({ path: test.info().outputPath('native-task-pool-queued.png'), fullPage: true });
    for (const [finished, next, completed, queued] of [['B', 'C', 1, 2], ['C', 'D', 2, 1], ['D', 'E', 3, 0]] as const) {
      barriers.get(finished)!.release();
      await expect.poll(() => started, { timeout: 15000 }).toEqual([...initialOrder, ...names.slice(2, names.indexOf(next) + 1)]);
      await expect.poll(async () => { const state = (await snapshot(page!, session.id)).nativeAgentRuntime; return { active: state?.active, queued: state?.queued, completed: state?.completed }; }).toEqual({ active: 2, queued, completed });
      expect(settled()).toBeUndefined(); expect(await workers(app)).toBeLessThanOrEqual(3);
      expect((await receipts(f.data)).find(child => child.goal.startsWith('POOL_A:'))?.status).toBe('running');
    }
    barriers.get('E')!.release();
    await expect.poll(async () => { const state = (await snapshot(page!, session.id)).nativeAgentRuntime; return { active: state?.active, completed: state?.completed }; }).toEqual({ active: 1, completed: 4 });
    expect(settled()).toBeUndefined();
    barriers.get('A')!.release(); const result = await pending;
    expect(result.success).toBe(true); expect(fixture.errors).toEqual([]); expect(fixture.requests).toHaveLength(18);
    expect(result.nativeReceipt?.usage.modelRequests).toBe(18); expect(result.nativeReceipt?.usage.toolCalls).toBe(12);
    const saved = await receipts(f.data); expect(saved).toHaveLength(5);
    expect(saved.every(child => child.status === 'completed' && child.result?.committed)).toBe(true);
    expect(new Set(saved.map(child => child.identity.runId)).size).toBe(5); expect(new Set(saved.map(child => child.identity.conversationId)).size).toBe(5);
    const execution: NativeDelegationExecution = JSON.parse(await fs.readFile(nativeDelegationExecutionPath(path.join(f.data, 'native'), saved[0].parentIdentity, saved[0].batchId), 'utf8'));
    expect(execution.capacity).toBe(2);
    expect(execution.children.every(child => child.queued && child.admitted && child.started && child.settled && child.released)).toBe(true);
    const intervals = execution.children.map(child => ({ name: saved.find(receipt => receipt.childId === child.childId)!.goal.slice(5, 6), start: child.started!.monotonicMs, end: child.settled!.monotonicMs }));
    const a = intervals.find(child => child.name === 'A')!;
    for (const name of ['C', 'D', 'E']) expect(intervals.find(child => child.name === name)!.start).toBeLessThan(a.end);
    for (const interval of intervals) expect(intervals.filter(other => other.start <= interval.start && other.end > interval.start).length).toBeLessThanOrEqual(2);
    const slots = execution.children.map(child => ({ name: saved.find(receipt => receipt.childId === child.childId)!.goal.slice(5, 6),
      start: child.admitted!.monotonicMs, end: child.released!.monotonicMs }));
    expect([...slots].sort((left, right) => left.start - right.start).map(child => child.name)).toEqual(names);
    for (const slot of slots) expect(slots.filter(other => other.start <= slot.start && other.end > slot.start).length).toBeLessThanOrEqual(2);
    for (const child of execution.children) expect(child.released!.monotonicMs).toBeGreaterThanOrEqual(child.settled!.monotonicMs);
    const parent = fixture.requests.filter(body => !childRequest(body)).at(-1)!;
    expect(names.every((_, index) => results(parent).has(`pool-result-${index}`))).toBe(true);
    await expect.poll(() => workers(app)).toBe(0); expect(await fs.readFile(path.join(f.cwd, 'fixture.txt'), 'utf8')).toBe('A B C D E\n');
  } catch (error) { if (page && sessionId) await diagnostic(page, sessionId, fixture, f.data); throw error; }
  finally { for (const barrier of barriers.values()) barrier.release(); await closeNativeApp(app); await fixture.close(); await f.dispose(); }
});

test('parent cancellation terminalizes queued work without starting workers, and restart never resumes the queue', async () => {
  const f = await workspace(), started: string[] = [];
  const fixture: Fixture = await startResponsesFixture({ assertReplay: false, handler: ({ body }: { body: Body }): Response => {
    if (!childRequest(body)) return parentResponse(body);
    started.push(childName(body)); return { hang: true };
  } });
  const app = await f.launch(); let page: Page | undefined, sessionId = '';
  try {
    page = await ready(app); const session = await configure(page, f.projectId, fixture.baseURL); sessionId = session.id;
    const pending = page.evaluate(id => window.desktop.sendChat(id, '委派五个独立只读审阅，等待全部结果。', [], 'pool-cancel'), session.id), settled = observe(pending);
    await expect.poll(() => { if (settled()) throw new Error('Parent settled before queue became observable'); return [...started].sort(); }, { timeout: 20000 }).toEqual(['A', 'B']);
    await expect.poll(async () => (await snapshot(page!, session.id)).nativeAgentRuntime?.queued).toBe(3);
    const before = await receipts(f.data), queuedIds = new Set(before.filter(child => child.status === 'queued').map(child => child.childId));
    expect(queuedIds.size).toBe(3); expect(await workers(app)).toBe(3);
    await page.evaluate(id => window.desktop.stopSession(id), session.id); expect((await pending).success).toBe(false);
    await expect.poll(() => workers(app)).toBe(0);
    const saved = await receipts(f.data); expect(saved).toHaveLength(5); expect(saved.every(child => child.status === 'cancelled')).toBe(true);
    for (const child of saved) {
      if (queuedIds.has(child.childId)) {
        expect(child.result).toBeUndefined();
        expect(await fs.stat(path.join(f.data, 'native', 'conversations', child.identity.conversationId)).then(() => true, () => false)).toBe(false);
      } else { expect(child.result?.status).toBe('cancelled'); expect(child.result?.modelRequests).toBe(1); expect(child.result?.committed).toBe(true); }
    }
    expect([...started].sort()).toEqual(['A', 'B']); expect(fixture.requests).toHaveLength(4); expect(fixture.errors).toEqual([]);
    const execution: NativeDelegationExecution = JSON.parse(await fs.readFile(nativeDelegationExecutionPath(path.join(f.data, 'native'), saved[0].parentIdentity, saved[0].batchId), 'utf8'));
    expect(execution.children.filter(child => child.started)).toHaveLength(2); expect(execution.children.filter(child => child.settled)).toHaveLength(2);
    for (const child of execution.children.filter(child => queuedIds.has(child.childId))) {
      expect(child.started).toBeUndefined(); expect(child.settled).toBeUndefined(); expect(child.admitted).toBeUndefined(); expect(child.released).toBeUndefined();
    }
    // Release the desktop's writer before independently opening its durable ledger.
    await closeNativeApp(app);
    const parent = await NativeRunStore.open({ rootDirectory: path.join(f.data, 'native', 'conversations'), conversationId: saved[0].parentIdentity.conversationId });
    try { expect(parent.getRun(saved[0].parentIdentity.runId)?.status).toBe('cancelled'); } finally { await parent.close(); }
    const reopened = await f.launch();
    try {
      const restoredPage = await ready(reopened), restored = await snapshot(restoredPage, session.id);
      expect(restored.nativeAgents?.items).toHaveLength(5); expect(restored.nativeAgents!.items.every(child => child.status === 'cancelled')).toBe(true);
      expect(restored.nativeAgentRuntime?.active).toBe(0); expect(restored.nativeAgentRuntime?.queued ?? 0).toBe(0);
      await openChatAssistance(restoredPage, 'agents'); await expect(restoredPage.getByRole('region', { name: 'Native Agent 协作', exact: true })).toBeVisible();
      expect(await workers(reopened)).toBe(0); expect([...started].sort()).toEqual(['A', 'B']); expect(fixture.requests).toHaveLength(4);
    } finally { await closeNativeApp(reopened); }
  } catch (error) { if (page && sessionId && !page.isClosed()) await diagnostic(page, sessionId, fixture, f.data); throw error; }
  finally { await closeNativeApp(app); await fixture.close(); await f.dispose(); }
});

test('queued implementation starts only after cleanup and retains the approved dirty baseline with child approvals', async () => {
  test.setTimeout(120000);
  const f = await workspace(), barriers = new Map(['A', 'B'].map(name => [name, gate()])), started: string[] = [];
  await fs.writeFile(path.join(f.cwd, 'fixture.txt'), 'staged pool draft\n'); await execute('git', ['-C', f.cwd, 'add', 'fixture.txt']);
  await fs.writeFile(path.join(f.cwd, 'fixture.txt'), 'approved dirty pool snapshot\n');
  const parentIndex = await fs.readFile(path.join(f.cwd, '.git', 'index'));
  const fixture: Fixture = await startResponsesFixture({ assertReplay: false, handler: async ({ body }: { body: Body }): Promise<Response> => {
    const done = results(body);
    if (!childRequest(body)) {
      if (!done.has('pool-plan')) return parentResponse(body);
      if (!done.has('pool-delegate')) return call('pool-delegate', 'delegate_implement', { baseline: 'snapshot', tasks: ['A', 'B'].map(name => ({
        title: `排队实现 ${name}`, goal: `POOL_${name}: Read fixture.txt, change it independently to child ${name} implementation, and run an actual command check. Preserve the parent workspace.` })) });
      expect(done.get('pool-delegate')?.status).toBe('completed');
      for (let index = 0; index < 2; index++) if (!done.has(`pool-result-${index}`)) return call(`pool-result-${index}`, 'read_agent_result', {
        parentRunId: done.get('pool-delegate')!.output.parentRunId, childId: done.get('pool-delegate')!.output.children![index].childId });
      return final('pool-implementation-final', 'Both isolated queued implementations inspected; parent workspace preserved.');
    }
    const name = childName(body), content = `child ${name} implementation\n`;
    if (!done.has(`pool-child-${name}-read`)) {
      started.push(name); await barriers.get(name)!.promise; return call(`pool-child-${name}-read`, 'read_file', { path: 'fixture.txt' });
    }
    expect(done.get(`pool-child-${name}-read`)?.output.content).toBe('approved dirty pool snapshot\n');
    if (!done.has(`pool-child-${name}-patch`)) return call(`pool-child-${name}-patch`, 'apply_patch', { path: 'fixture.txt', content,
      expectedHash: done.get(`pool-child-${name}-read`)!.output.hash });
    if (!done.has(`pool-child-${name}-command`)) return call(`pool-child-${name}-command`, 'run_command', { executable: process.execPath, cwd: '.',
      argv: ['-e', `if(require('node:fs').readFileSync('fixture.txt','utf8')!==${JSON.stringify(content)})process.exitCode=7;else process.stdout.write('pool-${name}-verified')`], timeoutMs: 10000, maxOutputBytes: 4096 });
    expect(done.get(`pool-child-${name}-command`)?.status).toBe('completed');
    return final(`pool-child-${name}-final`, `Independent implementation ${name} and actual command verification completed.`);
  } });
  const app = await f.launch(); let page: Page | undefined, sessionId = '';
  try {
    page = await ready(app); const session = await configure(page, f.projectId, fixture.baseURL, 1); sessionId = session.id;
    const pending = page.evaluate(id => window.desktop.sendChat(id, '基于当前修改快照，委派两个隔离实现任务，依次审批各自写入和检查命令。', [], 'pool-implementation'), session.id), settled = observe(pending);
    await approve(page, session.id, 'delegate_implement');
    await expect.poll(() => { if (settled()) throw new Error('Parent settled before implementation child A'); return started; }, { timeout: 20000 }).toEqual(['A']);
    await expect.poll(async () => { const state = (await snapshot(page!, session.id)).nativeAgentRuntime; return { active: state?.active, queued: state?.queued }; }).toEqual({ active: 1, queued: 1 });
    const before = await receipts(f.data), queued = before.find(child => child.status === 'queued')!;
    expect(queued).toBeTruthy(); expect(queued.workspace).toBeUndefined(); expect(queued.result).toBeUndefined(); expect(await workers(app)).toBe(2);
    barriers.get('A')!.release(); await approve(page, session.id, 'apply_patch'); await approve(page, session.id, 'run_command');
    await expect.poll(() => started, { timeout: 20000 }).toEqual(['A', 'B']);
    const afterA = await receipts(f.data); expect(afterA.find(child => child.goal.startsWith('POOL_A:'))?.status).toBe('completed');
    expect(afterA.find(child => child.goal.startsWith('POOL_B:'))?.workspace?.baseCommit).toBe(afterA.find(child => child.goal.startsWith('POOL_A:'))?.workspace?.baseCommit);
    expect(await workers(app)).toBeLessThanOrEqual(2);
    barriers.get('B')!.release(); await approve(page, session.id, 'apply_patch'); await approve(page, session.id, 'run_command');
    const result = await pending; expect(result.success).toBe(true); expect(fixture.errors).toEqual([]);
    const saved = await receipts(f.data); expect(saved).toHaveLength(2);
    expect(new Set(saved.map(child => child.workspace!.baseCommit)).size).toBe(1); expect(new Set(saved.map(child => child.workspace!.path)).size).toBe(2);
    for (const child of saved) {
      const name = child.goal.slice(5, 6); expect(child.status).toBe('completed'); expect(child.workspaceVerified).toBe(true); expect(child.workspace?.baseline).toBe('snapshot');
      expect(await fs.readFile(path.join(child.workspace!.cwd, 'fixture.txt'), 'utf8')).toBe(`child ${name} implementation\n`);
      expect(child.result?.evidence?.commandReceipts).toHaveLength(1); expect(child.result?.evidence?.commandReceipts?.[0].exitCode).toBe(0);
    }
    const execution: NativeDelegationExecution = JSON.parse(await fs.readFile(nativeDelegationExecutionPath(path.join(f.data, 'native'), saved[0].parentIdentity, saved[0].batchId), 'utf8'));
    expect(execution.capacity).toBe(1); expect(execution.children[1].admitted!.monotonicMs).toBeGreaterThanOrEqual(execution.children[0].released!.monotonicMs);
    expect(await fs.readFile(path.join(f.cwd, 'fixture.txt'), 'utf8')).toBe('approved dirty pool snapshot\n');
    expect(await fs.readFile(path.join(f.cwd, '.git', 'index'))).toEqual(parentIndex); await expect.poll(() => workers(app)).toBe(0);
  } catch (error) { if (page && sessionId) await diagnostic(page, sessionId, fixture, f.data); throw error; }
  finally { for (const barrier of barriers.values()) barrier.release(); await closeNativeApp(app); await fixture.close(); await f.dispose(); }
});
