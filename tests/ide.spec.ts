import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AppState, Session } from '../src/shared/types';

async function workspace(configured = false) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-desk-ide-'));
  const data = path.join(directory, 'data'), now = new Date().toISOString();
  const projectPath = path.join(directory, 'base project');
  // These characters must arrive literally as one argument, without shell interpretation.
  const worktreePath = path.join(directory, process.platform === 'win32' ? 'isolated project' : "工作目录 ;$(touch injected) & 'quoted'");
  await fs.mkdir(data);
  await fs.mkdir(projectPath);
  await fs.mkdir(worktreePath);
  const project = { id: randomUUID(), name: 'IDE 测试项目', path: await fs.realpath(projectPath), createdAt: now };
  const cwd = await fs.realpath(worktreePath), log = path.join(directory, 'ide-launch.txt');
  const executable = process.platform === 'win32' ? process.execPath : path.join(directory, 'custom IDE launcher');
  if (process.platform !== 'win32') {
    const quotedLog = "'" + log.replaceAll("'", "'\\''") + "'";
    await fs.writeFile(executable, '#!/bin/sh\nprintf \'%s\\n\' "$PWD" "$#" "$1" > ' + quotedLog + '\n', { mode: 0o755 });
  }
  const session: Session = {
    id: randomUUID(), projectId: project.id, cwd, worktree: cwd, worktreeBase: project.path,
    claudeId: randomUUID(), title: 'IDE 工作树会话', kind: 'claude', adapter: 'structured',
    started: false, model: '', effort: 'default', permissionMode: 'default',
    status: 'idle', taskState: 'idle', archived: false, createdAt: now, updatedAt: now,
  };
  const state: AppState = {
    version: 1, projects: [project], sessions: [session], selectedSessionId: session.id,
    settings: { claudePath: path.join(directory, 'unavailable-claude'), shellPath: '', maxSessions: 4, fontSize: 14, scrollback: 8000, ...(configured ? { idePath: executable } : {}) },
  };
  await fs.writeFile(path.join(data, 'workspace.json'), JSON.stringify(state));
  const launch = () => electron.launch({
    args: ['.', ...(process.platform === 'linux' ? ['--no-sandbox', `--ozone-platform=${process.env.DISPLAY ? 'x11' : 'headless'}`, '--disable-gpu'] : [])],
    env: { ...process.env, WORKBENCH_TEST_MODE: '1', WORKBENCH_DATA_DIR: data },
  });
  return { directory, data, project, session, executable, log, launch, dispose: () => fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) };
}

/** Mock only the native picker; the renderer, preload and trusted IPC handler remain real. */
async function pickerResult(app: ElectronApplication, selected: string | null) {
  await app.evaluate(({ dialog }, value) => {
    dialog.showOpenDialog = (async () => ({ canceled: value === null, filePaths: value === null ? [] : [value] })) as typeof dialog.showOpenDialog;
  }, selected);
}

test('ide: configure an application through a draft, cancel safely and preserve the saved path across restart', async ({}, testInfo) => {
  const f = await workspace();
  let app = await f.launch();
  try {
    let page = await app.firstWindow();
    await expect(page.getByRole('heading', { name: 'IDE 工作树会话', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '在 IDE 中打开', exact: true }).click();
    let settings = page.getByRole('dialog', { name: '设置与连接', exact: true });
    await expect(settings).toBeVisible();
    await expect(settings.getByLabel('IDE 应用路径', { exact: true })).toBeFocused();
    await expect(settings.getByLabel('IDE 应用路径', { exact: true })).toHaveValue('');
    await pickerResult(app, f.executable);
    await settings.getByRole('button', { name: '选择 IDE 应用', exact: true }).click();
    await expect(settings.getByLabel('IDE 应用路径', { exact: true })).toHaveValue(f.executable);
    expect((await page.evaluate(() => window.desktop.snapshot())).state.settings.idePath ?? '').toBe('');
    await pickerResult(app, null);
    await settings.getByRole('button', { name: '选择 IDE 应用', exact: true }).click();
    await expect(settings.getByLabel('IDE 应用路径', { exact: true })).toHaveValue(f.executable);
    await settings.getByRole('button', { name: '关闭弹窗', exact: true }).click();
    expect((await page.evaluate(() => window.desktop.snapshot())).state.settings.idePath ?? '').toBe('');

    await page.getByRole('button', { name: '在 IDE 中打开', exact: true }).click();
    await expect(settings.getByLabel('IDE 应用路径', { exact: true })).toHaveValue('');
    await settings.getByLabel('IDE 应用路径', { exact: true }).fill(f.executable);
    await settings.getByRole('button', { name: '保存设置', exact: true }).click();
    await expect.poll(async () => (await page.evaluate(() => window.desktop.snapshot())).state.settings.idePath).toBe(f.executable);
    await expect(settings.getByRole('button', { name: '保存设置', exact: true })).toBeEnabled();
    await settings.getByLabel('IDE 应用路径', { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('ide-settings.png') });
    await settings.getByRole('button', { name: '关闭弹窗', exact: true }).click();
    await app.close();
    app = await f.launch();
    page = await app.firstWindow();
    await page.getByRole('button', { name: '设置与连接', exact: true }).click();
    settings = page.getByRole('dialog', { name: '设置与连接', exact: true });
    await expect(settings.getByLabel('IDE 应用路径', { exact: true })).toHaveValue(f.executable);
    // Editing an already saved path and closing the modal must also preserve it.
    await settings.getByLabel('IDE 应用路径', { exact: true }).fill('');
    await settings.getByRole('button', { name: '关闭弹窗', exact: true }).click();
    expect((await page.evaluate(() => window.desktop.snapshot())).state.settings.idePath).toBe(f.executable);
    expect(JSON.parse(await fs.readFile(path.join(f.data, 'workspace.json'), 'utf8')).settings.idePath).toBe(f.executable);
    await expect(page.locator('.error-banner')).toHaveCount(0);
  } finally { await app.close(); await f.dispose(); }
});

test('ide: open the current worktree as one literal argument, preserve folder opening and report a missing application', async () => {
  test.skip(process.platform === 'win32', 'The real executable capture fixture uses a POSIX shebang; settings coverage runs on Windows too.');
  const f = await workspace(true), app = await f.launch();
  try {
    const page = await app.firstWindow(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await expect(page.getByRole('heading', { name: 'IDE 工作树会话', exact: true })).toBeVisible();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(980, 680));
    const ide = page.getByRole('button', { name: '在 IDE 中打开', exact: true });
    const folder = page.getByRole('button', { name: '打开工作目录', exact: true });
    for (const button of [ide, folder]) {
      await expect(button).toBeVisible();
      const bounds = (await button.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(await page.evaluate(() => innerWidth));
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await ide.click();
    await expect.poll(() => fs.readFile(f.log, 'utf8').catch(() => '')).toBe(f.session.cwd + '\n1\n' + f.session.cwd + '\n');
    expect(f.session.cwd).not.toBe(f.project.path);
    expect(await fs.readdir(f.session.cwd)).not.toContain('injected');
    await expect(page.locator('.error-banner')).toHaveCount(0);

    await app.evaluate(({ shell }) => {
      const state = globalThis as typeof globalThis & { __ideFolderCalls: string[] };
      state.__ideFolderCalls = [];
      shell.openPath = async value => { state.__ideFolderCalls.push(value); return ''; };
    });
    await folder.click();
    await expect.poll(() => app.evaluate(() => (globalThis as typeof globalThis & { __ideFolderCalls: string[] }).__ideFolderCalls)).toEqual([f.session.cwd]);

    await fs.unlink(f.executable);
    await fs.unlink(f.log);
    await ide.click();
    await expect(page.locator('.error-banner')).toContainText(/IDE/);
    await expect(page.locator('.error-banner')).toContainText(/不存在|无法|重新选择|找不到|不可用/);
    expect(await fs.stat(f.log).then(() => true, () => false)).toBe(false);
    expect(errors).toEqual([]);
  } finally { await app.close(); await f.dispose(); }
});
