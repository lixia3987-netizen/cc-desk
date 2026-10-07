import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { NativeTaskPlan } from '@cc-desk/contracts/native-task';
import { desktopRoot } from './helpers/paths';
import { electronLaunchArgs } from './helpers/electron-launch';
import { closeNativeApp } from './helpers/native-app-cleanup';
// @ts-expect-error Shared real HTTP/SSE fixture has no TypeScript declarations.
import { assistantMessage, functionCall, startResponsesFixture } from '../../../packages/agent-node/tests/fixtures/responses-server.mjs';

interface FixtureRequest { input: Array<Record<string, unknown>>; tools: Array<{ name: string }> }
interface Fixture { baseURL: string; requests: FixtureRequest[]; errors: unknown[]; close(): Promise<void> }
type FixtureHandler = (input: { body: FixtureRequest; index: number }) => unknown | Promise<unknown>;
const secret = 'sk-workflow-gates-electron-dummy-never-persist';
const goal = '核查阶段门槛，不重做已经完成的工具';

async function workspace(taskGate = false, customHandler?: FixtureHandler) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ccdesk-workflow-gates-电子 空格-'));
  const data = path.join(directory, '应用 数据'), cwd = path.join(directory, '项目 空格'), projectId = randomUUID();
  await fs.mkdir(data); await fs.mkdir(cwd);
  await fs.writeFile(path.join(cwd, 'feature.txt'), 'existing project content\n');
  await fs.writeFile(path.join(cwd, 'AGENTS.md'), 'Read feature.txt once per stage. Do not repeat a completed tool while waiting for user confirmation.\n');
  await fs.writeFile(path.join(data, 'workspace.json'), JSON.stringify({ version: 3, projects: [{ id: projectId, name: 'Native 工作流门槛项目', path: cwd, createdAt: new Date().toISOString() }],
    sessions: [], settings: { claudePath: path.join(directory, 'missing-claude'), shellPath: '', maxSessions: 4, fontSize: 14, scrollback: 8000, engineDefaults: {} } }));
  const fixture: Fixture = await startResponsesFixture({ handler: customHandler ?? (({ body }: { body: FixtureRequest }) => {
    const turn = body.input.filter(item => item.role === 'user').length, prefix = `workflow-stage-${turn}`;
    const done = new Set(body.input.filter(item => item.type === 'function_call_output').map(item => String(item.call_id)));
    if (taskGate && turn === 1 && !done.has(`${prefix}-plan`)) {
      const plan: NativeTaskPlan = { goal, steps: [{ id: 'read', title: '阅读当前项目文件', dependsOn: [], status: 'implemented' }],
        criteria: [{ id: 'content', description: '人工核对实际文件与本阶段产出', stepIds: ['read'], kind: 'manual' }] };
      return { output: [functionCall(`${prefix}-plan`, 'update_plan', { expectedRevision: 0, plan })] };
    }
    if (!done.has(`${prefix}-read`)) return { output: [functionCall(`${prefix}-read`, 'read_file', { path: 'feature.txt' })] };
    return { output: [assistantMessage(`${prefix}-final`, `第 ${turn} 阶段读取已完成，产出等待独立核查。`)] };
  }) });
  return { directory, data, cwd, projectId, fixture,
    launch: () => electron.launch({ args: electronLaunchArgs(), cwd: desktopRoot, env: { ...process.env, WORKBENCH_TEST_MODE: '1', WORKBENCH_DATA_DIR: data } }),
    async dispose() { await fixture.close(); await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); },
  };
}
async function configure(app: ElectronApplication, projectId: string, baseURL: string) {
  const page = await app.firstWindow(); await expect(page.locator('main.workspace')).toBeVisible();
  const session = await page.evaluate(async ({ projectId, baseURL, secret }) => {
    const created = await window.desktop.nativeConnections.upsert({ name: 'Native workflow local fixture', protocol: 'responses', baseURL, model: 'fixture-model',
      enabled: true, allowLoopbackHttp: true, auth: { mode: 'memory' } });
    const connection = await window.desktop.nativeConnections.setCredential({ id: created.id, revision: created.revision, mode: 'memory', secret });
    const session = await window.desktop.createSession({ projectId, title: 'Native 工作流实际界面', kind: 'agent', providerId: 'native', mode: 'structured', isolated: false,
      engineConfig: { schemaVersion: 1, options: { connectionId: connection.id, model: '' } } });
    await window.desktop.setSelection(session.id); return session;
  }, { projectId, baseURL, secret });
  await page.getByRole('button', { name: '工作流', exact: true }).click();
  const contextToggle = page.getByRole('button', { name: '上下文', exact: true });
  if (await contextToggle.getAttribute('aria-pressed') === 'true') await contextToggle.click();
  await expect(page.getByLabel('工作流目标', { exact: true })).toBeVisible();
  return { page, session };
}
async function create(page: Page, gate: 'manual' | 'native_task') {
  await page.getByLabel('工作流目标', { exact: true }).fill(goal);
  await page.getByLabel('分析与计划验收门槛', { exact: true }).selectOption(gate);
  await page.getByRole('button', { name: '创建工作流', exact: true }).click();
  const run = page.locator('.workflow-run'); await expect(run).toHaveCount(1);
  await run.getByRole('button', { name: '开始', exact: true }).click();
  return run;
}

test('real Native workflow UI keeps manual rejection and confirmation separate from execution and continues without repeating tools', async () => {
  const f = await workspace(); let app: ElectronApplication | undefined;
  try {
    app = await f.launch(); const { page, session } = await configure(app, f.projectId, f.fixture.baseURL);
    await expect(page.getByLabel('分析与计划工具权限', { exact: true })).toHaveValue('read_only');
    await expect(page.getByLabel('实现与验证工具权限', { exact: true })).toHaveValue('standard');
    await expect(page.getByLabel('审查与交付工具权限', { exact: true })).toHaveValue('read_only');
    await page.getByLabel('模型请求总上限', { exact: true }).fill('6');
    await page.getByLabel('工具调用总上限', { exact: true }).fill('3');
    await page.getByLabel('执行总时长', { exact: true }).fill('1');
    const run = await create(page, 'manual');
    await expect(run.locator('> header .status-tag')).toHaveText('等待确认');
    await expect(run.locator('.workflow-stage.waiting_confirmation')).toHaveCount(1);
    const modelRequests = f.fixture.requests.length;
    expect(modelRequests).toBe(2);
    const saved = await page.evaluate(async id => (await window.desktop.workflows(id))[0], session.id);
    expect(saved.stages[0].nativeReceipts?.[0].usage.toolCalls).toBe(1);
    await run.getByLabel('分析与计划确认理由', { exact: true }).fill('先核对已读取文件与本阶段输出，尚需确认。');
    await run.getByRole('button', { name: '不予确认', exact: true }).click();
    await expect(run).toContainText('用户未确认此阶段');
    await expect(run.locator('> header .status-tag')).toHaveText('等待确认');
    expect(f.fixture.requests).toHaveLength(modelRequests);
    await run.getByRole('button', { name: '确认阶段产出', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath('workflow-manual-waiting.png') });
    await run.getByLabel('分析与计划确认理由', { exact: true }).fill('已核对文件内容与阶段产出，允许进入下一阶段。');
    await run.getByRole('button', { name: '确认阶段产出', exact: true }).click();
    await expect(run.locator('> header .status-tag')).toHaveText('等待继续');
    expect(f.fixture.requests).toHaveLength(modelRequests);
    await run.getByRole('button', { name: '继续', exact: true }).click();
    await expect(run.locator('.workflow-stage.completed')).toHaveCount(2);
    await expect(run.locator('> header .status-tag')).toHaveText('等待继续');
    expect(f.fixture.requests).toHaveLength(4);
    await run.getByRole('button', { name: '继续', exact: true }).click();
    await expect(run.locator('> header .status-tag')).toHaveText('已完成');
    await expect(run.locator('.workflow-stage.completed')).toHaveCount(3);
    const completed = await page.evaluate(async id => (await window.desktop.workflows(id))[0], session.id);
    expect(completed.budget).toEqual({ maxModelRequests: 6, maxToolCalls: 3, maxActiveMs: 60000 });
    expect(completed.usage?.modelRequests).toBe(6); expect(completed.usage?.toolCalls).toBe(3);
    expect(completed.stages.map(stage => stage.attempts)).toEqual([1, 1, 1]);
    expect(completed.stages.flatMap(stage => stage.nativeReceipts ?? []).map(receipt => receipt.usage.toolCalls)).toEqual([1, 1, 1]);
    expect(f.fixture.requests).toHaveLength(6); expect(f.fixture.errors).toEqual([]);
    for (const index of [0, 4]) expect(f.fixture.requests[index].tools.map(tool => tool.name)).not.toContain('run_command');
    expect(f.fixture.requests[2].tools.map(tool => tool.name)).toContain('run_command');
    expect(await fs.readFile(path.join(f.cwd, 'feature.txt'), 'utf8')).toBe('existing project content\n');
    await page.screenshot({ path: test.info().outputPath('workflow-manual-completed.png') });
  } finally { try { if (app) await closeNativeApp(app); } finally { await f.dispose(); } }
});

test('workflow active-time budget survives manual gate waiting and a long automatically queued ordinary turn', async () => {
  let releaseFirst!: () => void, enteredFirst!: () => void;
  const firstRequest = new Promise<void>(resolve => { enteredFirst = resolve; });
  const firstRelease = new Promise<void>(resolve => { releaseFirst = resolve; });
  const f = await workspace(false, async ({ body, index }) => {
    if (index === 0) { enteredFirst(); await firstRelease; }
    const queued = JSON.stringify(body.input.findLast(item => item.role === 'user')).includes('排队消息独立执行，不消耗工作流阶段预算');
    if (queued) await new Promise(resolve => setTimeout(resolve, 5500));
    return { output: [assistantMessage(`workflow-budget-${index}`, queued ? '排队消息已独立完成。' : '工作流当前阶段实际完成。')] };
  });
  let app: ElectronApplication | undefined;
  try {
    app = await f.launch(); const { page, session } = await configure(app, f.projectId, f.fixture.baseURL);
    const created = await page.evaluate(sessionId => window.desktop.createWorkflow({ sessionId, goal: '阶段执行预算与等待分开', maxAttempts: 2,
      budget: { maxModelRequests: 2, maxToolCalls: 2, maxActiveMs: 5000 }, stages: [
        { id: 'first', title: '第一阶段', instruction: '仅回复第一阶段结果。', gate: 'manual', toolPolicy: 'read_only' },
        { id: 'second', title: '第二阶段', instruction: '仅回复第二阶段结果。', dependsOn: ['first'], toolPolicy: 'read_only' },
      ] }), session.id);
    await page.evaluate(id => window.desktop.startWorkflow(id), created.id); await firstRequest;
    await page.evaluate(id => window.desktop.submitChat(id, '排队消息独立执行，不消耗工作流阶段预算', [], 'workflow-independent-queued-turn'), session.id);
    releaseFirst();
    const run = page.locator('.workflow-run');
    await expect(run.locator('> header .status-tag')).toHaveText('等待确认');
    const waiting = await page.evaluate(async id => (await window.desktop.workflows(id))[0], session.id);
    expect(waiting.usage?.modelRequests).toBe(1); expect(waiting.usage?.activeMs).toBeLessThan(5000);
    await expect.poll(() => page.evaluate(async id => (await window.desktop.chatSnapshot(id)).queue?.items.length, session.id), { timeout: 12000 }).toBe(0);
    expect(f.fixture.requests).toHaveLength(2);
    const afterQueue = await page.evaluate(async id => (await window.desktop.workflows(id))[0], session.id);
    expect(afterQueue.usage).toEqual(waiting.usage);
    await run.getByLabel('第一阶段确认理由', { exact: true }).fill('已检查阶段产出；排队等待期间未重做本阶段。');
    await run.getByRole('button', { name: '确认阶段产出', exact: true }).click();
    await expect(run.locator('> header .status-tag')).toHaveText('等待继续');
    await run.getByRole('button', { name: '继续', exact: true }).click();
    await expect(run.locator('> header .status-tag')).toHaveText('已完成');
    const complete = await page.evaluate(async id => (await window.desktop.workflows(id))[0], session.id);
    expect(complete.usage?.modelRequests).toBe(2); expect(complete.usage?.activeMs).toBeLessThan(5000);
    expect(complete.stages.map(stage => stage.attempts)).toEqual([1, 1]);
    expect(f.fixture.requests).toHaveLength(3); expect(f.fixture.errors).toEqual([]);
    await page.screenshot({ path: test.info().outputPath('workflow-budget-excludes-gate-and-queue-wait.png') });
  } finally { releaseFirst(); try { if (app) await closeNativeApp(app); } finally { await f.dispose(); } }
});

test('workflow UI retries preserve consumed model budget and never dispatch a downstream stage after exhaustion', async () => {
  const f = await workspace(false, ({ index }) => index === 0
    ? { httpStatus: 400, raw: JSON.stringify({ error: { message: 'Intentional fixture validation failure', type: 'invalid_request_error' } }) }
    : { output: [assistantMessage(`workflow-retry-${index}`, '手动重试当前阶段完成。')] });
  let app: ElectronApplication | undefined;
  try {
    app = await f.launch(); const { page, session } = await configure(app, f.projectId, f.fixture.baseURL);
    const created = await page.evaluate(sessionId => window.desktop.createWorkflow({ sessionId, goal: '失败重试保留累计预算', maxAttempts: 3,
      budget: { maxModelRequests: 2, maxToolCalls: 3, maxActiveMs: 60000 }, stages: [
        { id: 'first', title: '第一阶段', instruction: '仅回复第一阶段结果。', toolPolicy: 'read_only' },
        { id: 'second', title: '第二阶段', instruction: '仅回复第二阶段结果。', dependsOn: ['first'], toolPolicy: 'read_only' },
      ] }), session.id);
    await page.evaluate(id => window.desktop.startWorkflow(id), created.id);
    const run = page.locator('.workflow-run'); await expect(run.locator('> header .status-tag')).toHaveText('失败');
    expect(f.fixture.requests).toHaveLength(1);
    expect((await page.evaluate(async id => (await window.desktop.workflows(id))[0], session.id)).usage?.modelRequests).toBe(1);
    await run.getByRole('button', { name: '重试失败阶段', exact: true }).click();
    await expect(run.locator('> header .status-tag')).toHaveText('已中断');
    await expect(run).toContainText('工作流累计预算已耗尽');
    const stopped = await page.evaluate(async id => (await window.desktop.workflows(id))[0], session.id);
    expect(stopped.usage?.modelRequests).toBe(2); expect(stopped.usage?.recordedExecutionIds).toHaveLength(2);
    expect(stopped.stages.map(stage => stage.attempts)).toEqual([2, 0]);
    expect(f.fixture.requests).toHaveLength(2); expect(f.fixture.errors).toEqual([]);
    await run.getByRole('button', { name: '继续', exact: true }).click();
    await expect(run.locator('> header .status-tag')).toHaveText('已中断');
    expect(f.fixture.requests).toHaveLength(2);
    await page.screenshot({ path: test.info().outputPath('workflow-retry-budget-exhausted.png') });
  } finally { try { if (app) await closeNativeApp(app); } finally { await f.dispose(); } }
});

test('real Native stage verification button refreshes its bound task and keeps stale workspace evidence waiting', async () => {
  const f = await workspace(true); let app: ElectronApplication | undefined;
  try {
    app = await f.launch(); const { page, session } = await configure(app, f.projectId, f.fixture.baseURL);
    const run = await create(page, 'native_task');
    await expect(run.locator('> header .status-tag')).toHaveText('等待验收');
    const taskPanel = page.getByRole('region', { name: 'Native 任务计划与验收', exact: true });
    await expect(taskPanel).toBeVisible();
    const previous = await page.evaluate(async id => (await window.desktop.chatSnapshot(id)).nativeTask!, session.id);
    const form = taskPanel.locator('.native-task-review');
    await form.locator('summary').click();
    await form.getByLabel('核验范围', { exact: true }).selectOption('content');
    await form.getByLabel('核验依据或不适用理由（必填，最多 2000 字）', { exact: true }).fill('已核对当前文件与读取结果，本阶段条件通过。');
    await form.getByRole('button', { name: '记录人工核验', exact: true }).click();
    await expect.poll(() => page.evaluate(async id => (await window.desktop.chatSnapshot(id)).nativeTask!.revision, session.id)).toBeGreaterThan(previous.revision);
    const count = f.fixture.requests.length;
    await fs.appendFile(path.join(f.cwd, 'feature.txt'), 'external edit after review\n');
    await run.getByRole('button', { name: '检查阶段验收', exact: true }).click();
    await expect(run).toContainText('工作区内容已变化或核查不完整');
    await expect(run.locator('> header .status-tag')).toHaveText('等待验收');
    await expect(taskPanel.locator('.native-task-overview')).toContainText('证据已过期');
    expect(f.fixture.requests).toHaveLength(count);
    const waiting = await page.evaluate(async id => (await window.desktop.workflows(id))[0], session.id);
    expect(waiting.stages.map(stage => stage.attempts)).toEqual([1, 0, 0]);
    expect(waiting.stages[0].taskId).toBe(previous.taskId); expect(f.fixture.errors).toEqual([]);
    await run.getByRole('button', { name: '检查阶段验收', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath('workflow-native-stale-verification.png') });
  } finally { try { if (app) await closeNativeApp(app); } finally { await f.dispose(); } }
});
