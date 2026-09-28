import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { NativeTaskPlan, NativeTaskSnapshot } from '@cc-desk/contracts/native-task';
import { desktopRoot } from './helpers/paths';
import { electronLaunchArgs } from './helpers/electron-launch';
import { closeNativeApp } from './helpers/native-app-cleanup';
// @ts-expect-error Shared real HTTP/SSE fixture has no TypeScript declarations.
import { assistantMessage, functionCall, startResponsesFixture } from '../../../packages/agent-node/tests/fixtures/responses-server.mjs';

const secret = 'sk-native-task-electron-dummy-never-persist';
const before = 'preserve existing user content\n';
const after = before + 'native task implementation\n';
const locationSource = '// saved source\r\nconst html = "<img src=x onerror=alert(1)>";\r\nexport { html };\r\n';
const goal = '检查任务计划、审批与验收的真实界面';
const plan = (implemented = false): NativeTaskPlan => ({ goal,
  steps: [{ id: 'implement', title: '修改文件并检查实际内容', dependsOn: [], status: implemented ? 'implemented' : 'in_progress' }],
  criteria: [{ id: 'content', description: '文件内容检查成功', stepIds: ['implement'], kind: 'command' },
    { id: 'scope', description: '原有内容和无关文件保持完整', stepIds: ['implement'], kind: 'manual' }],
});
type ProtocolItem = Record<string, unknown>;
interface Receipt { status: string; output: { hash?: string; task?: NativeTaskSnapshot | null } }
interface Fixture { baseURL: string; requests: Array<{ input: ProtocolItem[] }>; errors: unknown[]; close(): Promise<void> }
function receipts(input: ProtocolItem[]) {
  return new Map(input.filter(item => item.type === 'function_call_output').map(item => [String(item.call_id), JSON.parse(String(item.output)) as Receipt]));
}
async function workspace(planOnly = false, locationOnly = false) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ccdesk-native-task-电子 空格-'));
  const data = path.join(directory, '应用 数据'), cwd = path.join(directory, '项目 空格'), projectId = randomUUID();
  await fs.mkdir(data); await fs.mkdir(cwd);
  await fs.writeFile(path.join(cwd, 'feature.txt'), locationOnly ? locationSource : before);
  await fs.writeFile(path.join(cwd, 'unrelated.txt'), 'user-owned unrelated content\n');
  await fs.writeFile(path.join(cwd, 'AGENTS.md'), 'Read feature.txt before editing it. Preserve existing user content. Ask permission for each write and command.\n');
  await fs.writeFile(path.join(cwd, 'CLAUDE.md'), 'Report execution separately from verification.\n');
  await fs.writeFile(path.join(data, 'workspace.json'), JSON.stringify({ version: 3, projects: [
    { id: projectId, name: 'Native 任务验收项目', path: cwd, createdAt: new Date().toISOString() },
  ], sessions: [], settings: { claudePath: path.join(directory, 'missing-claude'), shellPath: '', maxSessions: 4, fontSize: 14, scrollback: 8000, engineDefaults: {} } }));
  const fixture: Fixture = await startResponsesFixture({ handler: ({ body }: { body: { input: ProtocolItem[] } }) => {
    const turn = body.input.filter(item => item.role === 'user').length, prefix = `task-turn-${turn}`, done = receipts(body.input);
    const call = (id: string, name: string, input: unknown) => ({ output: [functionCall(`${prefix}-${id}`, name, input)] });
    if (turn > 1) return !done.has(`${prefix}-continue-read`) ? call('continue-read', 'read_task', {})
      : { output: [assistantMessage(`${prefix}-final`, '已读取明确关联的任务，没有重做旧工具。')] };
    if (!done.has(`${prefix}-plan`)) return call('plan', 'update_plan', { expectedRevision: 0, plan: plan(planOnly || locationOnly), explanation: '先保存计划，再分别执行获得批准的操作。' });
    if (planOnly) return { output: [assistantMessage(`${prefix}-final`, '任务实现声明已记录，验收尚未执行。')] };
    if (!done.has(`${prefix}-read`)) return call('read', 'read_file', { path: 'feature.txt' });
    if (locationOnly) {
      if (!done.has(`${prefix}-before-location`)) return call('before-location', 'read_task', {});
      if (!done.has(`${prefix}-location`)) return call('location', 'record_code_location', {
        expectedRevision: done.get(`${prefix}-before-location`)!.output.task!.revision,
        path: 'feature.txt', expectedHash: done.get(`${prefix}-read`)!.output.hash, startLine: 2, endLine: 3,
        stepIds: ['implement'], criterionIds: ['content'],
      });
      return { output: [assistantMessage(`${prefix}-final`, '模型声称位置记录已证明验收通过。')] };
    }
    if (!done.has(`${prefix}-patch`)) return call('patch', 'apply_patch', { path: 'feature.txt', expectedHash: done.get(`${prefix}-read`)!.output.hash, content: after });
    if (!done.has(`${prefix}-check`)) return call('check', 'run_command', { executable: process.execPath,
      argv: ['-e', `const fs=require('node:fs');if(fs.readFileSync('feature.txt','utf8')!==${JSON.stringify(after)})process.exitCode=9;else process.stdout.write('native-task-content-check-passed')`], cwd: '.',
    });
    if (!done.has(`${prefix}-read-task`)) return call('read-task', 'read_task', {});
    if (!done.has(`${prefix}-implemented`)) return call('implemented', 'update_plan', {
      expectedRevision: done.get(`${prefix}-read-task`)!.output.task!.revision, plan: plan(true), explanation: '实现和命令检查已结束，保留人工核验条件。',
    });
    // Deliberately overclaim in model prose; the UI must use host evidence instead.
    return { output: [assistantMessage(`${prefix}-final`, '模型声称任务已全部实现并且验收通过。')] };
  } });
  return { directory, data, cwd, projectId, fixture,
    launch: () => electron.launch({ args: electronLaunchArgs(), cwd: desktopRoot, env: { ...process.env, WORKBENCH_TEST_MODE: '1', WORKBENCH_DATA_DIR: data } }),
    async dispose() { await fixture.close(); await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); },
  };
}
async function ready(app: ElectronApplication) {
  const page = await app.firstWindow(); await expect(page.locator('main.workspace')).toBeVisible(); return page;
}
async function configure(page: Page, projectId: string, baseURL: string) {
  return page.evaluate(async ({ projectId, baseURL, secret }) => {
    const initial = await window.desktop.nativeConnections.upsert({ name: 'Native task local fixture', protocol: 'responses', baseURL,
      model: 'fixture-model', enabled: true, allowLoopbackHttp: true, auth: { mode: 'memory' } });
    const connection = await window.desktop.nativeConnections.setCredential({ id: initial.id, revision: initial.revision, mode: 'memory', secret });
    const session = await window.desktop.createSession({ projectId, title: 'Native 任务闭环验收', kind: 'agent', providerId: 'native', mode: 'structured', isolated: false,
      engineConfig: { schemaVersion: 1, options: { connectionId: connection.id, model: '' } } });
    await window.desktop.setSelection(session.id); return session;
  }, { projectId, baseURL, secret });
}
const snapshot = (page: Page, id: string) => page.evaluate(id => window.desktop.chatSnapshot(id), id);
const panel = (page: Page) => page.getByRole('region', { name: 'Native 任务计划与验收', exact: true });
async function submit(page: Page, text: string) {
  const editor = page.getByLabel('提示词编辑器', { exact: true });
  await editor.fill(text); await editor.press('Enter'); await expect(editor).toHaveValue('');
}
async function pending(page: Page, id: string, name: string) {
  await expect.poll(async () => (await snapshot(page, id)).pending.find(item => item.toolName === name)?.requestId).toBeTruthy();
  return (await snapshot(page, id)).pending.find(item => item.toolName === name)!.requestId;
}
async function finished(page: Page, id: string) {
  await expect.poll(async () => (await snapshot(page, id)).nativeTask?.execution).toBe('ended');
  await expect(panel(page).locator('.native-task-overview')).toContainText('本轮正常结束');
  await expect(panel(page).getByRole('button', { name: '继续此任务', exact: true })).toBeEnabled();
  return (await snapshot(page, id)).nativeTask!;
}
async function review(page: Page, id: string, criterionId: string) {
  const previous = (await snapshot(page, id)).nativeTask!;
  const form = panel(page).locator('.native-task-review');
  if (await form.getAttribute('open') === null) await form.locator('summary').click();
  await form.getByLabel('核验范围', { exact: true }).selectOption(criterionId);
  await form.getByLabel('核验依据或不适用理由（必填，最多 2000 字）', { exact: true }).fill(criterionId
    ? '已核对实际文件、保留的原内容与命令退出码，当前条件满足。' : '逐项条件和改动范围均已人工核对，确认当前版本的任务验收。');
  await form.getByRole('button', { name: criterionId ? '记录人工核验' : '确认任务验收', exact: true }).click();
  await expect.poll(async () => (await snapshot(page, id)).nativeTask!.revision).toBeGreaterThan(previous.revision);
  // A new durable revision remounts the form. Wait for that render before the
  // next review so a late snapshot cannot erase fields filled on the old form.
  await expect(form).not.toHaveAttribute('open', '');
}

test('native task UI survives approval-time reload and keeps model completion separate from reviewed, version-bound acceptance', async () => {
  const f = await workspace(); let app: ElectronApplication | undefined;
  try {
    app = await f.launch(); const page = await ready(app), session = await configure(page, f.projectId, f.fixture.baseURL);
    await submit(page, '实现工程任务并准确展示计划和验证状态。');
    const writeApproval = await pending(page, session.id, 'apply_patch');
    await expect(panel(page)).toContainText(goal); await expect(panel(page).locator('.native-task-overview')).toContainText('验证：未验证');
    expect(await fs.readFile(path.join(f.cwd, 'feature.txt'), 'utf8')).toBe(before);
    const beforeReload = (await snapshot(page, session.id)).nativeTask!;
    await page.reload(); await expect(page.locator('main.workspace')).toBeVisible();
    await expect(panel(page)).toContainText(goal);
    expect((await snapshot(page, session.id)).nativeTask?.taskId).toBe(beforeReload.taskId);
    expect(await pending(page, session.id, 'apply_patch')).toBe(writeApproval);
    await expect(page.getByRole('region', { name: '工具审批', exact: true })).toContainText('apply_patch');
    await page.getByRole('button', { name: '允许本次', exact: true }).click();
    await pending(page, session.id, 'run_command');
    await expect(page.getByRole('region', { name: '工具审批', exact: true })).toContainText('run_command');
    await page.getByRole('button', { name: '允许本次', exact: true }).click();
    const ended = await finished(page, session.id);
    expect(ended.steps[0].status).toBe('implemented'); expect(ended.verification).toBe('unverified');
    await expect(panel(page).locator('.native-task-overview')).toContainText('验证：未验证');
    await expect(panel(page).locator('[data-step-status="implemented"]')).toContainText('模型声明已实现');
    await expect(page.locator('.chat-message.assistant').last()).toContainText('模型声称任务已全部实现并且验收通过');
    expect(await fs.readFile(path.join(f.cwd, 'feature.txt'), 'utf8')).toBe(after);
    expect(await fs.readFile(path.join(f.cwd, 'unrelated.txt'), 'utf8')).toBe('user-owned unrelated content\n');
    expect(ended.evidence.filter(item => item.source === 'command')).toHaveLength(1);
    expect(ended.evidence[0].exitCode).toBe(0);
    const modelRequests = f.fixture.requests.length;
    await review(page, session.id, 'content'); await review(page, session.id, 'scope');
    expect((await snapshot(page, session.id)).nativeTask?.verification).not.toBe('passed');
    await review(page, session.id, '');
    await expect(panel(page).locator('.native-task-overview')).toContainText('验证：验收通过');
    const approved = (await snapshot(page, session.id)).nativeTask!;
    await fs.appendFile(path.join(f.cwd, 'feature.txt'), 'external edit after verification\n');
    // Exercise the registered focus-resynchronization path without a polling loop.
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(panel(page).locator('.native-task-overview')).toContainText('验证：证据已过期');
    const stale = (await snapshot(page, session.id)).nativeTask!;
    expect(stale.workspace?.current.fingerprint).not.toBe(approved.workspace?.current.fingerprint);
    expect(stale.review).toBeUndefined(); expect(stale.evidence.every(item => item.stale)).toBe(true);
    expect(f.fixture.requests).toHaveLength(modelRequests); expect(f.fixture.errors).toEqual([]);
    await page.screenshot({ path: test.info().outputPath('native-task-versioned-acceptance.png') });
  } finally { try { if (app) await closeNativeApp(app); } finally { await f.dispose(); } }
});

test('native task UI restores a durable plan after restart and Continue only binds the next submitted instruction', async () => {
  const f = await workspace(true); let app: ElectronApplication | undefined;
  try {
    app = await f.launch(); let page = await ready(app);
    const session = await configure(page, f.projectId, f.fixture.baseURL);
    await submit(page, '只记录计划和实现声明，不执行文件或命令工具。');
    const original = await finished(page, session.id), count = f.fixture.requests.length;
    expect(original.verification).toBe('unverified'); expect(original.evidence).toEqual([]);
    await closeNativeApp(app); app = await f.launch(); page = await ready(app);
    await page.evaluate(id => window.desktop.setSelection(id), session.id);
    await expect(panel(page)).toContainText(goal);
    const restored = (await snapshot(page, session.id)).nativeTask!;
    expect(restored.taskId).toBe(original.taskId); expect(restored.revision).toBe(original.revision);
    expect(restored.identity.runId).toBe(original.identity.runId); expect(f.fixture.requests).toHaveLength(count);
    await page.evaluate(async secret => {
      const connection = (await window.desktop.nativeConnections.list()).connections[0];
      await window.desktop.nativeConnections.setCredential({ id: connection.id, revision: connection.revision, mode: 'memory', secret });
    }, secret);
    await panel(page).getByRole('button', { name: '继续此任务', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: `下一条消息将继续任务 ${original.taskId}` })).toBeVisible();
    expect(f.fixture.requests).toHaveLength(count);
    expect((await snapshot(page, session.id)).nativeTask?.identity.runId).toBe(original.identity.runId);
    await submit(page, '读取此任务的持久计划，继续核对，不重做任何已执行工具。');
    await expect.poll(async () => (await snapshot(page, session.id)).nativeTask?.identity.runId).not.toBe(original.identity.runId);
    const continued = await finished(page, session.id);
    expect(continued.taskId).toBe(original.taskId); expect(continued.revision).toBeGreaterThan(original.revision);
    expect(continued.history.some(item => item.kind === 'continue')).toBe(true);
    expect(continued.evidence).toEqual([]); expect(f.fixture.requests).toHaveLength(count + 2);
    const read = receipts(f.fixture.requests.at(-1)!.input).get('task-turn-2-continue-read');
    expect(read?.status).toBe('completed'); expect(read?.output.task?.taskId).toBe(original.taskId);
    await expect(page.getByRole('button', { name: '取消关联', exact: true })).toHaveCount(0);
    expect(await fs.readFile(path.join(f.cwd, 'feature.txt'), 'utf8')).toBe(before);
    expect(f.fixture.errors).toEqual([]);
    await page.screenshot({ path: test.info().outputPath('native-task-explicit-continuation.png') });
  } finally { try { if (app) await closeNativeApp(app); } finally { await f.dispose(); } }
});

test('native code location links reveal saved line excerpts and retain historical context after external edits and restart', async () => {
  const f = await workspace(false, true); let app: ElectronApplication | undefined;
  try {
    app = await f.launch(); let page = await ready(app);
    const session = await configure(page, f.projectId, f.fixture.baseURL);
    await submit(page, '记录文件第 2–3 行并关联任务步骤和条件，不进行文件修改。');
    const original = await finished(page, session.id), requests = f.fixture.requests.length;
    expect(original.verification).toBe('unverified'); expect(original.evidence).toHaveLength(1);
    expect(original.evidence[0].source).toBe('location'); expect(original.evidence[0].status).toBe('unverified');
    expect(original.evidence[0].location?.excerpt).toBe(locationSource.slice(locationSource.indexOf('\n') + 1));
    expect((await snapshot(page, session.id)).pending).toEqual([]);
    const stepLink = panel(page).locator('.native-task-steps .native-task-location-links a');
    const criterionLink = panel(page).locator('.native-task-criteria .native-task-location-links a');
    expect(await stepLink.getAttribute('href')).toMatch(/^#native-task-evidence-[0-9a-f]+-[0-9a-f]+$/);
    expect(await criterionLink.getAttribute('href')).toBe(await stepLink.getAttribute('href'));
    await expect(panel(page).locator('.native-task-evidence')).toBeHidden();
    await stepLink.click();
    const evidence = panel(page).locator('.native-task-evidence');
    await expect(evidence).toBeVisible(); await expect(evidence).toHaveAttribute('open', ''); await expect(evidence).toBeFocused();
    await expect(evidence).toContainText('代码位置记录'); await expect(evidence).toContainText('并非当前文件内容');
    await expect(evidence).toContainText('步骤和条件关联由模型声明');
    expect(await evidence.locator('.native-task-line-number').allTextContents()).toEqual(['2', '3']);
    expect(await evidence.locator('.native-task-line-text').allTextContents()).toEqual(['const html = "<img src=x onerror=alert(1)>";\r\n', 'export { html };\r\n']);
    await expect(evidence.locator('img, script')).toHaveCount(0); await expect(evidence).toHaveAttribute('data-evidence-status', 'unverified');
    expect(await fs.readFile(path.join(f.cwd, 'feature.txt'), 'utf8')).toBe(locationSource);
    expect(f.fixture.requests).toHaveLength(requests);

    await fs.appendFile(path.join(f.cwd, 'feature.txt'), '// external change\r\n');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(evidence).toHaveAttribute('data-evidence-status', 'stale');
    await expect(evidence).toContainText('历史位置记录'); await expect(evidence).toContainText('不能确认当前文件仍有相同内容');
    expect((await snapshot(page, session.id)).nativeTask!.evidence[0].location).toEqual(original.evidence[0].location);
    await closeNativeApp(app); app = await f.launch(); page = await ready(app);
    await page.evaluate(id => window.desktop.setSelection(id), session.id);
    await expect(panel(page)).toContainText(goal);
    await panel(page).locator('.native-task-criteria .native-task-location-links a').click();
    const restored = panel(page).locator('.native-task-evidence');
    await expect(restored).toBeVisible(); await expect(restored).toHaveAttribute('data-evidence-status', 'stale');
    await expect(restored).toContainText('const html = "<img src=x onerror=alert(1)>";');
    await expect(restored.locator('.native-task-state.passed')).toHaveCount(0);
    expect((await snapshot(page, session.id)).nativeTask!.taskId).toBe(original.taskId);
    expect(f.fixture.requests).toHaveLength(requests); expect(f.fixture.errors).toEqual([]);
    await page.screenshot({ path: test.info().outputPath('native-task-historical-code-location.png') });
  } finally { try { if (app) await closeNativeApp(app); } finally { await f.dispose(); } }
});
