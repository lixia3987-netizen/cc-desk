import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ChatSnapshot } from '../src/shared/chat';
import { desktopRoot } from './helpers/paths';
import { electronLaunchArgs } from './helpers/electron-launch';
import { closeNativeApp } from './helpers/native-app-cleanup';
// @ts-expect-error The shared executable fixture has no TypeScript declaration.
import { assistantMessage, functionCall, startResponsesFixture } from '../../../packages/agent-node/tests/fixtures/responses-server.mjs';

interface Fixture { baseURL: string; errors: unknown[]; requests: unknown[]; close(): Promise<void> }
async function workspace() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ccdesk-long-command-电子 空格-'));
  const data = path.join(directory, 'data'), cwd = path.join(directory, 'project 空格'), projectId = randomUUID();
  await fs.mkdir(data); await fs.mkdir(cwd);
  await fs.writeFile(path.join(cwd, 'finite-command.cjs'), `const fs=require('node:fs');process.stdout.write('<img src=x onerror=alert(1)>\\n');process.stderr.write('separate stderr\\n');const tick=setInterval(()=>{if(fs.existsSync('finish.txt')){clearInterval(tick);process.stdout.write('command-finished\\n');}},25);`);
  await fs.writeFile(path.join(cwd, 'AGENTS.md'), 'Approve each command. Command lifecycle is separate from task acceptance.\n');
  await fs.writeFile(path.join(data, 'workspace.json'), JSON.stringify({ version: 3, projects: [{ id: projectId, name: '长命令生命周期', path: cwd, createdAt: new Date().toISOString() }],
    sessions: [], settings: { claudePath: path.join(directory, 'missing-claude'), shellPath: '', maxSessions: 4, fontSize: 14, scrollback: 8000, engineDefaults: {} } }));
  let release!: () => void;
  const modelGate = new Promise<void>(resolve => { release = resolve; });
  const fixture: Fixture = await startResponsesFixture({ handler: async ({ body }: { body: { input: Array<Record<string, unknown>> } }) => {
    if (!body.input.some(item => item.type === 'function_call_output' && item.call_id === 'start-finite')) {
      return { output: [functionCall('start-finite', 'start_command', { executable: process.execPath, argv: ['finite-command.cjs'], cwd: '.', timeoutMs: 60000 })] };
    }
    await modelGate;
    return { output: [assistantMessage('finished', '模型声称任务已验收通过。')] };
  } });
  return { directory, data, cwd, projectId, fixture, release,
    launch: () => electron.launch({ args: electronLaunchArgs(), cwd: desktopRoot, env: { ...process.env, WORKBENCH_TEST_MODE: '1', WORKBENCH_DATA_DIR: data } }),
    async dispose() { release(); await fixture.close(); await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); },
  };
}
const snapshot = (page: Page, id: string): Promise<ChatSnapshot> => page.evaluate(id => window.desktop.chatSnapshot(id), id);
const panel = (page: Page) => page.getByRole('region', { name: 'Native 长命令状态', exact: true });
async function configure(app: ElectronApplication, projectId: string, baseURL: string) {
  const page = await app.firstWindow(); await expect(page.locator('main.workspace')).toBeVisible();
  const session = await page.evaluate(async ({ projectId, baseURL }) => {
    const item = await window.desktop.nativeConnections.upsert({ name: 'Local long-command fixture', protocol: 'responses', baseURL, model: 'fixture-model', enabled: true, allowLoopbackHttp: true, auth: { mode: 'memory' } });
    const connection = await window.desktop.nativeConnections.setCredential({ id: item.id, revision: item.revision, mode: 'memory', secret: 'sk-long-command-local-fixture-only' });
    const session = await window.desktop.createSession({ projectId, title: '长命令界面验证', kind: 'agent', providerId: 'native', mode: 'structured', isolated: false, engineConfig: { schemaVersion: 1, options: { connectionId: connection.id, model: '' } } });
    await window.desktop.setSelection(session.id); return session;
  }, { projectId, baseURL });
  const editor = page.getByLabel('提示词编辑器', { exact: true });
  await editor.fill('启动有限时长命令，保留实际执行状态。'); await editor.press('Enter');
  await expect.poll(async () => (await snapshot(page, session.id)).pending[0]?.toolName).toBe('start_command');
  await expect(panel(page)).toHaveCount(0);
  await page.getByRole('region', { name: '工具审批', exact: true }).getByRole('button', { name: '允许本次', exact: true }).click();
  await expect.poll(async () => (await snapshot(page, session.id)).nativeCommands?.items[0]?.status).toBe('running');
  await expect(panel(page).locator('[data-command-status="running"]')).toBeVisible();
  return { page, session };
}

test('native command UI receives terminal host events while the model is waiting and preserves the receipt after restart', async () => {
  const f = await workspace(); let app: ElectronApplication | undefined;
  try {
    app = await f.launch(); const configured = await configure(app, f.projectId, f.fixture.baseURL); let page = configured.page; const session = configured.session;
    const commandId = (await snapshot(page, session.id)).nativeCommands!.items[0].commandId;
    await page.reload(); await expect(page.locator('main.workspace')).toBeVisible();
    await expect(panel(page).locator('[data-command-status="running"]')).toBeVisible();
    await fs.writeFile(path.join(f.cwd, 'finish.txt'), 'finish the fixture command');
    // No model/tool polling request is needed for the command's final host notification.
    await expect.poll(async () => (await snapshot(page, session.id)).nativeCommands?.items[0]?.status).toBe('finished');
    const entry = panel(page).locator(`[data-command-id="${commandId}"]`); await entry.locator('summary').first().click();
    await expect(entry).toContainText('退出码：0'); await expect(entry).toContainText('清理：已确认');
    await entry.locator('.native-command-output>summary').click();
    await expect(entry.getByLabel('命令标准输出', { exact: true })).toContainText('<img src=x onerror=alert(1)>');
    await expect(entry.getByLabel('命令标准错误', { exact: true })).toContainText('separate stderr');
    await expect(entry.locator('img')).toHaveCount(0); await expect(panel(page)).toContainText('不代表任务验收通过');
    f.release(); await expect.poll(async () => (await snapshot(page, session.id)).taskState).toBe('completed');
    const saved = (await snapshot(page, session.id)).nativeCommands, requests = f.fixture.requests.length;
    await closeNativeApp(app); app = await f.launch(); page = await app.firstWindow(); await expect(page.locator('main.workspace')).toBeVisible();
    await page.evaluate(id => window.desktop.setSelection(id), session.id);
    await expect(panel(page).locator('[data-command-status="finished"]')).toBeVisible();
    expect((await snapshot(page, session.id)).nativeCommands).toEqual(saved);
    expect(f.fixture.requests).toHaveLength(requests); expect(f.fixture.errors).toEqual([]);
    await page.screenshot({ path: test.info().outputPath('native-long-command-restored.png') });
  } finally { f.release(); try { if (app) await closeNativeApp(app); } finally { await f.dispose(); } }
});

test('interrupting a native turn closes its running command and the UI retains cancellation with confirmed cleanup', async () => {
  const f = await workspace(); let app: ElectronApplication | undefined;
  try {
    app = await f.launch(); const { page, session } = await configure(app, f.projectId, f.fixture.baseURL);
    await page.getByRole('button', { name: '中断', exact: true }).click();
    await expect.poll(async () => (await snapshot(page, session.id)).nativeCommands?.items[0]?.status).toBe('finished');
    const entry = panel(page).locator('[data-command-status="finished"]'); await entry.locator('summary').first().click();
    await expect(entry).toContainText('取消：是'); await expect(entry).toContainText('清理：已确认');
    await expect.poll(async () => (await snapshot(page, session.id)).taskState).toBe('interrupted');
    expect((await snapshot(page, session.id)).nativeCommands!.items[0].result?.cancelled).toBe(true);
    await expect(panel(page)).toContainText('不代表任务验收通过');
  } finally { f.release(); try { if (app) await closeNativeApp(app); } finally { await f.dispose(); } }
});
