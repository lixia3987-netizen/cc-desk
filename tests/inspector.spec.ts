import { electronLaunchArgs } from './helpers/electron-launch';
import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AppState, Session } from '../src/shared/types';
import type { ChatSnapshot } from '../src/shared/chat';

async function workspace(shellSelected = false) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-desk-inspector-'));
  const data = path.join(directory, 'data'), projectPath = path.join(directory, 'project');
  await fs.mkdir(projectPath);
  await fs.mkdir(path.join(data, 'chat'), { recursive: true });
  const cwd = await fs.realpath(projectPath), now = new Date().toISOString(), projectId = randomUUID();
  const makeSession = (title: string, kind: Session['kind'] = 'agent'): Session => ({ execution: kind === 'shell' ? {providerId: 'shell', mode: 'terminal'} : { providerId: 'claude', mode: 'structured', conversationId: randomUUID() },
    id: randomUUID(), projectId, cwd,  title, kind,
     started: false, model: '', effort: 'default',
    permissionMode: 'default', status: 'idle', taskState: 'idle', archived: false, createdAt: now, updatedAt: now,
  });
  const first = makeSession('面板切换会话'), second = makeSession('另一个会话'), shell = makeSession('保留运行中的终端', 'shell');
  const state: AppState = {
    version: 2, projects: [{ id: projectId, name: '面板体验项目', path: cwd, createdAt: now }],
    sessions: [first, second, shell], selectedSessionId: shellSelected ? shell.id : first.id,
    settings: { claudePath: path.join(directory, 'unavailable-claude'), shellPath: '', maxSessions: 4, fontSize: 14, scrollback: 8000 },
  };
  const chat: ChatSnapshot = {
    sessionId: first.id, taskState: 'idle', pending: [], messages: [
      { id: randomUUID(), turnId: randomUUID(), role: 'assistant', createdAt: now, text: '### 专注当前对话\n\n收起右侧面板后，正文与代码拥有更宽的阅读空间。随时展开即可继续查看上下文、工作流与项目变更。' },
    ],
  };
  await fs.writeFile(path.join(data, 'workspace.json'), JSON.stringify(state));
  await fs.writeFile(path.join(data, 'chat', first.id + '.json'), JSON.stringify(chat));
  const launch = () => electron.launch({
    args: electronLaunchArgs(),
    env: { ...process.env, WORKBENCH_TEST_MODE: '1', WORKBENCH_DATA_DIR: data },
  });
  return { first, second, shell, launch, dispose: () => fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) };
}

test('inspector: keyboard toggle preserves drafts and mounted content, and visibility survives session changes and restart', async ({}, testInfo) => {
  const f = await workspace();
  let app = await f.launch();
  try {
    let page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await expect(page.getByRole('heading', { name: f.first.title, exact: true })).toBeVisible();
    const aside = page.locator('#session-inspector'), chat = page.locator('.chat-pane');
    const toggle = page.getByRole('button', { name: '收起右侧面板', exact: true });
    await expect(page.getByRole('complementary', { name: '会话详情', exact: true })).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(toggle).toHaveAttribute('aria-controls', 'session-inspector');
    await page.getByLabel('会话模型', { exact: true }).fill('unsaved-model');
    await page.getByLabel('提示词编辑器', { exact: true }).fill('这段提示词还没有发送。');
    const modelNode = (await page.getByLabel('会话模型', { exact: true }).elementHandle())!;
    const chatNode = (await chat.elementHandle())!;
    const initialWidth = (await chat.boundingBox())!.width;
    await page.screenshot({ path: testInfo.outputPath('inspector-expanded.png') });

    await toggle.focus();
    await page.keyboard.press('Enter');
    const reopen = page.getByRole('button', { name: '展开右侧面板', exact: true });
    await expect(reopen).toBeFocused();
    await expect(reopen).toHaveAttribute('aria-expanded', 'false');
    await expect(aside).toBeHidden();
    await expect(aside).toHaveCount(1);
    await expect.poll(async () => (await chat.boundingBox())!.width).toBeGreaterThan(initialWidth + 200);
    // Even a programmatic focus attempt cannot focus controls inside the hidden panel.
    await modelNode.evaluate(element => (element as HTMLElement).focus());
    await expect(reopen).toBeFocused();
    expect(await modelNode.evaluate(element => element.isConnected)).toBe(true);
    expect(await chatNode.evaluate(element => element === document.querySelector('.chat-pane'))).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('inspector-collapsed.png') });
    await page.keyboard.press('Space');
    await expect(aside).toBeVisible();
    await expect(page.getByLabel('会话模型', { exact: true })).toHaveValue('unsaved-model');
    expect(await modelNode.evaluate(element => element === document.querySelector('[aria-label="会话模型"]'))).toBe(true);
    await expect(page.getByLabel('提示词编辑器', { exact: true })).toHaveValue('这段提示词还没有发送。');
    expect((await page.evaluate(() => window.desktop.snapshot())).state.sessions.find(session => session.id === f.first.id)!.model).toBe('');

    await page.getByRole('tab', { name: '工作流', exact: true }).click();
    await page.getByLabel('工作流目标', { exact: true }).fill('保留尚未创建的工作流目标。');
    await page.getByLabel('最大尝试次数', { exact: true }).selectOption('3');
    const workflowNode = (await page.getByLabel('工作流目标', { exact: true }).elementHandle())!;
    await page.getByRole('button', { name: '收起右侧面板', exact: true }).click();
    await expect(aside).toBeHidden();
    await page.getByRole('button', { name: '展开右侧面板', exact: true }).click();
    await expect(page.getByRole('tab', { name: '工作流', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByLabel('工作流目标', { exact: true })).toHaveValue('保留尚未创建的工作流目标。');
    await expect(page.getByLabel('最大尝试次数', { exact: true })).toHaveValue('3');
    expect(await workflowNode.evaluate(element => element === document.querySelector('[aria-label="工作流目标"]'))).toBe(true);

    await page.getByRole('button', { name: '收起右侧面板', exact: true }).click();
    for (const session of [f.second, f.first]) {
      await page.locator('.session-row').filter({ hasText: session.title }).click();
      await expect(page.getByRole('heading', { name: session.title, exact: true })).toBeVisible();
      await expect(aside).toBeHidden();
      await expect(page.getByRole('button', { name: '展开右侧面板', exact: true })).toHaveAttribute('aria-expanded', 'false');
    }
    expect(await page.evaluate(() => localStorage.getItem('cc-desk.inspector-open'))).toBe('false');
    await expect(page.getByLabel('提示词编辑器', { exact: true })).toHaveValue('这段提示词还没有发送。');
    await app.close();
    app = await f.launch();
    page = await app.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    await expect(page.getByRole('heading', { name: f.first.title, exact: true })).toBeVisible();
    await expect(page.locator('#session-inspector')).toBeHidden();
    await page.getByRole('button', { name: '展开右侧面板', exact: true }).click();
    expect(await page.evaluate(() => localStorage.getItem('cc-desk.inspector-open'))).toBe('true');
    await page.reload();
    await expect(page.getByRole('complementary', { name: '会话详情', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '收起右侧面板', exact: true })).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('.error-banner')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { await app.close(); await f.dispose(); }
});

test('inspector: a narrow window keeps the toggle reachable and resizes a running terminal without restarting it', async () => {
  const f = await workspace(true), app = await f.launch();
  try {
    const page = await app.firstWindow(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await expect(page.getByRole('heading', { name: f.shell.title, exact: true })).toBeVisible();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(980, 680));
    const collapse = page.getByRole('button', { name: '收起右侧面板', exact: true });
    await expect(collapse).toBeInViewport({ ratio: 1 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await page.getByRole('button', { name: '启动会话', exact: true }).click();
    await expect(page.locator('.session-header .status-tag')).toContainText('运行中');
    const terminal = (await page.locator('.terminal-host .xterm').elementHandle())!;
    await page.locator('.terminal-host').click();
    await page.keyboard.type(process.platform === 'win32' ? "$env:CC_DESK_INSPECTOR_SENTINEL='still_alive'" : "CC_DESK_INSPECTOR_SENTINEL='still_alive'");
    await page.keyboard.press('Enter');
    const screen = page.locator('.terminal-host .xterm-screen');
    const before = (await screen.boundingBox())!.width;
    await collapse.click();
    await expect(page.locator('#session-inspector')).toBeHidden();
    const reopen = page.getByRole('button', { name: '展开右侧面板', exact: true });
    await expect(reopen).toBeInViewport({ ratio: 1 });
    await expect.poll(async () => (await screen.boundingBox())!.width).toBeGreaterThan(before + 150);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    expect(await terminal.evaluate(element => element === document.querySelector('.terminal-host .xterm'))).toBe(true);
    await expect(page.locator('.session-header .status-tag')).toContainText('运行中');
    await page.locator('.terminal-host').click();
    await page.keyboard.type(process.platform === 'win32' ? "Write-Output ('INSPECTOR_COLLAPSED_' + $env:CC_DESK_INSPECTOR_SENTINEL)" : "printf '\\nINSPECTOR_COLLAPSED_%s\\n' \"$CC_DESK_INSPECTOR_SENTINEL\"");
    await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(async id => (await window.desktop.terminalSnapshot(id)).chunks.map(chunk => chunk.data).join(''), f.shell.id)).toContain('INSPECTOR_COLLAPSED_still_alive');
    await reopen.click();
    await expect.poll(async () => Math.abs((await screen.boundingBox())!.width - before)).toBeLessThan(12);
    expect(await terminal.evaluate(element => element === document.querySelector('.terminal-host .xterm'))).toBe(true);
    await expect(page.getByRole('button', { name: '收起右侧面板', exact: true })).toBeInViewport({ ratio: 1 });
    await page.locator('.terminal-host').click();
    await page.keyboard.type(process.platform === 'win32' ? "Write-Output ('INSPECTOR_EXPANDED_' + $env:CC_DESK_INSPECTOR_SENTINEL)" : "printf '\\nINSPECTOR_EXPANDED_%s\\n' \"$CC_DESK_INSPECTOR_SENTINEL\"");
    await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(async id => (await window.desktop.terminalSnapshot(id)).chunks.map(chunk => chunk.data).join(''), f.shell.id)).toContain('INSPECTOR_EXPANDED_still_alive');
    await expect(page.locator('.error-banner')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    const page = await app.firstWindow().catch(() => null);
    if (page) {
      await page.evaluate(id => window.desktop.stopSession(id), f.shell.id).catch(() => {});
      await expect.poll(() => page.evaluate(async () => (await window.desktop.snapshot()).state.sessions.every(session => !['running', 'stopping'].includes(session.status))), { timeout: 5000 }).toBe(true).catch(() => {});
    }
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); }).catch(() => {});
    await app.close();
    await f.dispose();
  }
});
