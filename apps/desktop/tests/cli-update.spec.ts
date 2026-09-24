import { desktopRoot } from './helpers/paths';
import { electronLaunchArgs } from './helpers/electron-launch';
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { cliUpdateFixture } from './fixtures/cli-updater';
import type { AppState, Session } from '../src/shared/types';

async function workspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccdesk-cli-ui-')), fixture = await cliUpdateFixture(root);
  const data = path.join(root, 'data'), first = path.join(root, 'project-a'), second = path.join(root, 'project-b');
  await Promise.all([fs.mkdir(data), fs.mkdir(first), fs.mkdir(second)]);
  const now = new Date().toISOString();
  const projects = [first, second].map((directory, i) => ({ id: randomUUID(), name: `Workspace ${i + 1}`, path: directory, createdAt: now }));
  const makeSession = (project: typeof projects[number], kind: Session['kind']): Session => ({ execution: kind === 'shell' ? {providerId: 'shell', mode: 'terminal'} : { providerId: 'claude', mode: 'structured', conversationId: randomUUID() },
    id: randomUUID(), projectId: project.id, title: kind === 'shell' ? 'Shell' : project.name, kind,
    cwd: project.path,  started: false, model: '', effort: 'default', permissionMode: 'default', status: 'idle', archived: false,
    createdAt: now, updatedAt: now, draft: '草稿需要保留',
  });
  const sessions = [makeSession(projects[0], 'agent'), makeSession(projects[1], 'agent'), makeSession(projects[1], 'shell')];
  const state: AppState = { version: 2, projects, sessions, selectedSessionId: sessions[0].id, settings: {
    claudePath: fixture.cli, shellPath: '', maxSessions: 4, fontSize: 14, scrollback: 8000, chatFontFamily: 'system', uiFontFamily: 'system',
  } };
  await fs.writeFile(path.join(data, 'workspace.json'), JSON.stringify(state));
  const launch = async () => {
    const app = await electron.launch({ args: electronLaunchArgs(), cwd: desktopRoot,
      env: { ...process.env, WORKBENCH_TEST_MODE: '1', WORKBENCH_DATA_DIR: data, CLAUDE_CONFIG_DIR: fixture.config } });
    await app.evaluate(() => {
      const globals = globalThis as typeof globalThis & { updateSignalErrors?: unknown[] };
      globals.updateSignalErrors = [];
      const kill = process.kill.bind(process);
      process.kill = (pid, signal) => {
        try { return kill(pid, signal); }
        catch (error) {
          globals.updateSignalErrors!.push({ pid, signal, code: (error as NodeJS.ErrnoException).code });
          throw error;
        }
      };
    });
    return app;
  };
  const calls = async () => (await fs.readFile(fixture.log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { kind: string; autoUpdater?: string });
  return { ...fixture, root, sessions, launch, calls, dispose: () => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) };
}
async function confirmation(app: ElectronApplication, response: number) {
  await app.evaluate(({ dialog }, answer) => {
    const globals = globalThis as typeof globalThis & { updateDialog?: Electron.MessageBoxOptions };
    dialog.showMessageBox = (async (_window: unknown, options: Electron.MessageBoxOptions) => { globals.updateDialog = options; return { response: answer, checkboxChecked: false }; }) as typeof dialog.showMessageBox;
  }, response);
}
async function close(app: ElectronApplication) { await confirmation(app, 1); await app.close(); }
async function updateState(app: ElectronApplication, page: Page) {
  const state = await page.evaluate(async () => (await window.desktop.snapshot()).cliUpdate);
  const signalErrors = await app.evaluate(() => (globalThis as typeof globalThis & { updateSignalErrors?: unknown[] }).updateSignalErrors);
  return { phase: state.phase, message: state.message, signalErrors };
}
const banner = (page: Page) => page.getByRole('region', { name: 'Claude Code CLI 更新' });

test('startup checks each launch; postpone and cancel never stop a live workspace or install', async () => {
  const f = await workspace(); let app = await f.launch();
  try {
    let page = await app.firstWindow();
    await expect(banner(page)).toContainText('2.1.10'); expect((await f.calls()).map(call => call.kind)).toEqual(['npm']);
    await banner(page).getByRole('button', { name: '暂不更新 CLI' }).click(); await expect(banner(page)).toHaveCount(0);
    await page.evaluate(id => window.desktop.startSession(id), f.sessions[2].id);
    await page.getByRole('button', { name: '设置与连接' }).click(); await page.getByRole('tab', { name: '连接与终端' }).click();
    await confirmation(app, 0); await banner(page).getByRole('button', { name: '更新 CLI…' }).click();
    await expect.poll(() => updateState(app, page)).toMatchObject({ phase: 'available' });
    expect(await page.evaluate(async id => (await window.desktop.snapshot()).state.sessions.find(s => s.id === id)?.status, f.sessions[2].id)).toBe('running');
    expect((await f.calls()).filter(call => call.kind === 'update')).toHaveLength(0);
    const dialog = await app.evaluate(() => (globalThis as typeof globalThis & { updateDialog: Electron.MessageBoxOptions }).updateDialog);
    expect(dialog.defaultId).toBe(0); expect(dialog.cancelId).toBe(0); expect(dialog.detail).toContain('全部 2 个工作区'); expect(dialog.detail).toContain('Shell');
    await close(app); app = await f.launch(); page = await app.firstWindow();
    await expect(banner(page)).toContainText('2.1.10'); expect((await f.calls()).filter(call => call.kind === 'npm')).toHaveLength(2);
  } finally { await close(app); await f.dispose(); }
});

test('confirmed update drains all workspaces, terminals, workflows and descendants; work resumes only on request', async () => {
  const f = await workspace(), app = await f.launch();
  try {
    const page = await app.firstWindow(); await expect(banner(page)).toContainText('2.1.10');
    await fs.writeFile(f.mode, 'slow');
    const workflow = await page.evaluate(async sessions => {
      void window.desktop.sendChat(sessions[0].id, 'hold a running task').catch(() => {});
      const run = await window.desktop.createWorkflow({ sessionId: sessions[1].id, goal: 'hold a workflow', pauseAfterEachStage: false, maxAttempts: 2 });
      await window.desktop.startWorkflow(run.id); await window.desktop.startSession(sessions[2].id); return run.id;
    }, f.sessions);
    await expect.poll(() => page.evaluate(async () => (await window.desktop.snapshot()).state.sessions.filter(s => s.status === 'running').length)).toBe(3);
    await confirmation(app, 1); await banner(page).getByRole('button', { name: '更新 CLI…' }).click();
    await expect.poll(() => updateState(app, page)).toMatchObject({ phase: 'updating' });
    const attempts = await page.evaluate(async id => {
      const results = await Promise.allSettled([window.desktop.startSession(id), window.desktop.updateCLI(), window.desktop.saveSettings({ ...(await window.desktop.snapshot()).state.settings, claudePath: 'different-cli' })]);
      return results.map(result => result.status);
    }, f.sessions[2].id);
    expect(attempts).toEqual(['rejected', 'rejected', 'rejected']);
    await expect.poll(() => updateState(app, page)).toMatchObject({ phase: 'updated' }); await expect(banner(page)).toContainText('2.1.10');
    const snapshot = await page.evaluate(() => window.desktop.snapshot());
    expect(snapshot.state.projects).toHaveLength(2); expect(snapshot.state.sessions).toHaveLength(3);
    expect(snapshot.state.sessions.every(session => session.status === 'stopped')).toBe(true);
    expect(snapshot.state.sessions.map(session => session.execution.conversationId)).toEqual(f.sessions.map(session => session.execution.conversationId));
    expect(snapshot.state.sessions.map(session => session.draft)).toEqual(f.sessions.map(session => session.draft));
    expect(snapshot.capabilities.version).toContain('2.1.10');
    const runs = await page.evaluate(() => window.desktop.workflows()); expect(runs.find(run => run.id === workflow)?.status).toBe('interrupted');
    expect(runs[0].stages[1].attempts).toBe(0);
    const calls = await f.calls(); expect(calls.filter(call => call.kind === 'update')).toHaveLength(1);
    expect(calls.filter(call => call.kind === 'session').every(call => call.autoUpdater === '1')).toBe(true);
    await page.evaluate(id => window.desktop.startSession(id), f.sessions[2].id);
    expect(await page.evaluate(async id => (await window.desktop.snapshot()).state.sessions.find(s => s.id === id)?.status, f.sessions[2].id)).toBe('running');
    await page.screenshot({ path: test.info().outputPath('cli-update-complete.png') });
  } finally { await close(app); await f.dispose(); }
});

for (const mode of ['fail', 'noop']) test(`updater ${mode} is reported honestly and sessions remain recoverable`, async () => {
  const f = await workspace(), app = await f.launch();
  try {
    const page = await app.firstWindow(); await expect(banner(page)).toContainText('2.1.10');
    await page.evaluate(id => window.desktop.startSession(id), f.sessions[2].id);
    await fs.writeFile(f.mode, mode); await confirmation(app, 1);
    await banner(page).getByRole('button', { name: '更新 CLI…' }).click();
    await expect.poll(() => updateState(app, page)).toMatchObject({ phase: 'error', message: expect.stringContaining('工作区保持断开') });
    await expect(banner(page)).toContainText('工作区保持断开');
    await expect(banner(page)).not.toContainText('secret');
    const snapshot = await page.evaluate(() => window.desktop.snapshot());
    expect(snapshot.capabilities.version).toContain('2.1.9'); expect(snapshot.state.sessions[2].status).toBe('stopped');
    await fs.writeFile(f.mode, 'success'); await banner(page).getByRole('button', { name: '重新检查' }).click();
    await expect.poll(() => updateState(app, page)).toMatchObject({ phase: 'available' });
    await page.evaluate(id => window.desktop.startSession(id), f.sessions[2].id);
  } finally { await close(app); await f.dispose(); }
});

test('offline startup check does not interrupt normal use and can be retried from settings', async () => {
  const f = await workspace(); await fs.writeFile(f.mode, 'offline'); const app = await f.launch();
  try {
    const page = await app.firstWindow(); await expect(page.locator('main.workspace')).toBeVisible(); await expect.poll(() => updateState(app, page)).toMatchObject({ phase: 'error' }); await expect(banner(page)).toHaveCount(0);
    await page.evaluate(id => window.desktop.startSession(id), f.sessions[2].id);
    await page.getByRole('button', { name: '设置与连接' }).click(); await page.getByRole('tab', { name: '连接与终端' }).click();
    await expect(banner(page)).toContainText('检查更新失败');
    await fs.writeFile(f.mode, 'success'); await banner(page).getByRole('button', { name: '重新检查' }).click(); await expect.poll(() => updateState(app, page)).toMatchObject({ phase: 'available' });
    await page.setViewportSize({ width: 980, height: 680 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath('cli-update-settings.png') });
    expect((await f.calls()).some(call => call.kind === 'update')).toBe(false);
  } finally { await close(app); await f.dispose(); }
});
