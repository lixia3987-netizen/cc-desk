import { electronLaunchArgs } from './helpers/electron-launch';
import { test, expect, _electron as electron, type Page } from '@playwright/test';
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
      { id: randomUUID(), turnId: randomUUID(), role: 'assistant', createdAt: now, text: '### 专注当前对话\n\n关闭工具窗口后，正文与代码拥有更宽的阅读空间。右侧图标栏可以随时切换上下文、工作流与项目变更。' },
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

const panelNames = ['上下文', '变更', '工作流', '诊断'] as const;
type PanelName = typeof panelNames[number];
const panel = (page: Page, name: PanelName) => page.getByRole('region', { name: `${name}面板`, exact: true });
const panelToggle = (page: Page, name: PanelName) => page.getByRole('button', { name, exact: true });
const dock = (page: Page) => page.locator('#session-inspector .inspector-dock');
const activePanelKey = 'cc-desk.inspector-active-panel';

async function expectActivePanel(page: Page, active: PanelName | null) {
  await expect(page.getByRole('complementary', { name: '会话详情', exact: true })).toBeVisible();
  for (const name of panelNames) {
    const selected = name === active;
    await expect(panelToggle(page, name)).toBeInViewport({ ratio: 1 });
    await expect(panelToggle(page, name)).toHaveAttribute('aria-pressed', String(selected));
    await expect(panelToggle(page, name)).toHaveAttribute('aria-expanded', String(selected));
    if (selected) await expect(panel(page, name)).toBeVisible();
    else await expect(panel(page, name)).toBeHidden();
  }
  if (active) await expect(dock(page)).toBeVisible();
  else await expect(dock(page)).toBeHidden();
}

test('inspector: keyboard and header close preserve drafts and mounted content, and a closed dock survives session changes and restart', async ({}, testInfo) => {
  const f = await workspace();
  let app = await f.launch();
  try {
    let page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await expect(page.getByRole('heading', { name: f.first.title, exact: true })).toBeVisible();
    await expectActivePanel(page, '上下文');
    await expect(page.getByRole('button', { name: /^(收起|展开)右侧面板$/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^(折叠|展开)(上下文|变更|工作流|诊断)面板$/ })).toHaveCount(0);
    const chat = page.locator('.chat-pane'), toggle = panelToggle(page, '上下文');
    await page.getByLabel('会话模型', { exact: true }).fill('unsaved-model');
    await page.getByLabel('提示词编辑器', { exact: true }).fill('这段提示词还没有发送。');
    const modelNode = (await page.getByLabel('会话模型', { exact: true }).elementHandle())!;
    const chatNode = (await chat.elementHandle())!;
    const initialWidth = (await chat.boundingBox())!.width;
    await page.screenshot({ path: testInfo.outputPath('tool-window-open.png') });

    await toggle.focus();
    await page.keyboard.press('Enter');
    await expectActivePanel(page, null);
    await expect(toggle).toBeFocused();
    await expect.poll(async () => (await chat.boundingBox())!.width).toBeGreaterThan(initialWidth + 200);
    // Hidden controls stay mounted but cannot steal keyboard focus from the rail.
    await modelNode.evaluate(element => (element as HTMLElement).focus());
    await expect(toggle).toBeFocused();
    expect(await modelNode.evaluate(element => element.isConnected)).toBe(true);
    expect(await chatNode.evaluate(element => element === document.querySelector('.chat-pane'))).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('tool-window-closed.png') });
    await page.keyboard.press('Space');
    await expectActivePanel(page, '上下文');
    await expect(page.getByLabel('会话模型', { exact: true })).toHaveValue('unsaved-model');
    expect(await modelNode.evaluate(element => element === document.querySelector('[aria-label="会话模型"]'))).toBe(true);
    await expect(page.getByLabel('提示词编辑器', { exact: true })).toHaveValue('这段提示词还没有发送。');
    expect((await page.evaluate(() => window.desktop.snapshot())).state.sessions.find(session => session.id === f.first.id)!.model).toBe('');

    await page.getByLabel('会话模型', { exact: true }).focus();
    await page.keyboard.press('Escape');
    await expectActivePanel(page, '上下文');
    await page.keyboard.press('Shift+Escape');
    await expectActivePanel(page, null);
    await expect(toggle).toBeFocused();
    await page.keyboard.press('Space');
    await expectActivePanel(page, '上下文');
    await expect(page.getByLabel('会话模型', { exact: true })).toHaveValue('unsaved-model');
    await page.getByRole('button', { name: '关闭上下文面板', exact: true }).click();
    await expectActivePanel(page, null);
    await expect(toggle).toBeFocused();
    for (const session of [f.second, f.first]) {
      await page.locator('.session-row').filter({ hasText: session.title }).click();
      await expect(page.getByRole('heading', { name: session.title, exact: true })).toBeVisible();
      await expectActivePanel(page, null);
    }
    await expect.poll(() => page.evaluate(key => localStorage.getItem(key), activePanelKey)).toBe('null');
    await expect(page.getByLabel('提示词编辑器', { exact: true })).toHaveValue('这段提示词还没有发送。');
    await app.close();
    app = await f.launch();
    page = await app.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    await expect(page.getByRole('heading', { name: f.first.title, exact: true })).toBeVisible();
    await expectActivePanel(page, null);
    await panelToggle(page, '上下文').click();
    await expectActivePanel(page, '上下文');
    await expect.poll(() => page.evaluate(key => localStorage.getItem(key), activePanelKey)).toBe('"context"');
    await page.reload();
    await expectActivePanel(page, '上下文');
    await expect(page.locator('.error-banner')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { await app.close(); await f.dispose(); }
});

test('inspector: four rail tools switch exclusively, retain visited drafts and DOM, and restore the active tool after restart', async ({}, testInfo) => {
  const f = await workspace();
  let app = await f.launch();
  try {
    let page = await app.firstWindow();
    await expect(page.getByRole('heading', { name: f.first.title, exact: true })).toBeVisible();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1600, 1000));
    await expectActivePanel(page, '上下文');
    await page.getByLabel('会话模型', { exact: true }).fill('independent-unsaved-model');
    const modelNode = (await page.getByLabel('会话模型', { exact: true }).elementHandle())!;
    await panelToggle(page, '变更').click();
    await expectActivePanel(page, '变更');
    await panelToggle(page, '工作流').click();
    await expectActivePanel(page, '工作流');
    await page.getByLabel('工作流目标', { exact: true }).fill('工具窗口切换和重启之后仍然保留。');
    await page.getByLabel('最大尝试次数', { exact: true }).selectOption('3');
    const workflowNode = (await page.getByLabel('工作流目标', { exact: true }).elementHandle())!;
    await panelToggle(page, '诊断').click();
    await expectActivePanel(page, '诊断');
    expect(await modelNode.evaluate(element => element.isConnected)).toBe(true);
    expect(await workflowNode.evaluate(element => element.isConnected)).toBe(true);
    await modelNode.evaluate(element => (element as HTMLElement).focus());
    await expect(panelToggle(page, '诊断')).toBeFocused();

    for (const name of panelNames) {
      await panelToggle(page, name).click();
      await expectActivePanel(page, name);
      await page.getByRole('button', { name: `关闭${name}面板`, exact: true }).click();
      await expectActivePanel(page, null);
      await expect(panelToggle(page, name)).toBeFocused();
    }
    await panelToggle(page, '上下文').click();
    await expect(page.getByLabel('会话模型', { exact: true })).toHaveValue('independent-unsaved-model');
    expect(await modelNode.evaluate(element => element === document.querySelector('[aria-label="会话模型"]'))).toBe(true);
    await panelToggle(page, '工作流').click();
    await expectActivePanel(page, '工作流');
    await expect(page.getByLabel('工作流目标', { exact: true })).toHaveValue('工具窗口切换和重启之后仍然保留。');
    await expect(page.getByLabel('最大尝试次数', { exact: true })).toHaveValue('3');
    expect(await workflowNode.evaluate(element => element === document.querySelector('[aria-label="工作流目标"]'))).toBe(true);
    await panelToggle(page, '工作流').click();
    await expectActivePanel(page, null);
    await panelToggle(page, '工作流').click();
    await expect(page.getByLabel('工作流目标', { exact: true })).toHaveValue('工具窗口切换和重启之后仍然保留。');
    expect(await workflowNode.evaluate(element => element === document.querySelector('[aria-label="工作流目标"]'))).toBe(true);
    await expect.poll(() => page.evaluate(key => localStorage.getItem(key), activePanelKey)).toBe('"workflows"');
    await page.screenshot({ path: testInfo.outputPath('tool-window-workflow-wide.png') });
    await app.close();
    app = await f.launch();
    page = await app.firstWindow();
    await expect(page.getByRole('heading', { name: f.first.title, exact: true })).toBeVisible();
    await expectActivePanel(page, '工作流');
    await expect(page.getByLabel('工作流目标', { exact: true })).toHaveValue('工具窗口切换和重启之后仍然保留。');
    await expect(page.getByLabel('最大尝试次数', { exact: true })).toHaveValue('3');
    // Every tool remains reachable after restoring a different active tool.
    for (const name of ['诊断', '上下文', '变更', '工作流'] as const) {
      await panelToggle(page, name).click();
      await expectActivePanel(page, name);
    }
    await expect(page.locator('.error-banner')).toHaveCount(0);
  } finally { await app.close(); await f.dispose(); }
});

test('inspector: legacy hidden and multi-open preferences migrate to at most one active tool', async () => {
  const f = await workspace(), app = await f.launch();
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole('heading', { name: f.first.title, exact: true })).toBeVisible();
    for (const legacy of [
      { visible: 'false', open: ['context', 'git', 'workflows', 'diagnostics'], expected: null },
      { visible: 'true', open: ['context', 'git', 'workflows', 'diagnostics'], expected: '上下文' },
      { visible: 'true', open: [], expected: null },
    ] as const) {
      await page.evaluate(({ key, visible, open }) => {
        localStorage.removeItem(key);
        localStorage.setItem('cc-desk.inspector-open', visible);
        localStorage.setItem('cc-desk.inspector-panels', JSON.stringify({ open, collapsed: [] }));
      }, { key: activePanelKey, visible: legacy.visible, open: [...legacy.open] });
      await page.reload();
      await expectActivePanel(page, legacy.expected);
      await expect.poll(() => page.evaluate(key => localStorage.getItem(key), activePanelKey)).toBe(legacy.expected ? '"context"' : 'null');
    }
    // A subsequent selection overrides the stale legacy preference on reload.
    await panelToggle(page, '诊断').click();
    await expectActivePanel(page, '诊断');
    await expect.poll(() => page.evaluate(key => localStorage.getItem(key), activePanelKey)).toBe('"diagnostics"');
    await page.reload();
    await expectActivePanel(page, '诊断');
    await expect(page.locator('.error-banner')).toHaveCount(0);
  } finally { await app.close(); await f.dispose(); }
});

test('inspector: the vertical rail and single dock fit wide and narrow windows without restarting a running terminal', async ({}, testInfo) => {
  const f = await workspace(true), app = await f.launch();
  try {
    const page = await app.firstWindow(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await expect(page.getByRole('heading', { name: f.shell.title, exact: true })).toBeVisible();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(980, 680));
    await expectActivePanel(page, '上下文');
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await page.getByRole('button', { name: '启动会话', exact: true }).click();
    await expect(page.locator('.session-header .status-tag')).toContainText('运行中');
    const terminal = (await page.locator('.terminal-host .xterm').elementHandle())!;
    await page.locator('.terminal-host').click();
    await page.keyboard.type(process.platform === 'win32' ? "$env:CC_DESK_INSPECTOR_SENTINEL='still_alive'" : "CC_DESK_INSPECTOR_SENTINEL='still_alive'");
    await page.keyboard.press('Enter');
    const screen = page.locator('.terminal-host .xterm-screen');
    const before = (await screen.boundingBox())!.width;
    await panelToggle(page, '上下文').click();
    await expectActivePanel(page, null);
    await expect.poll(async () => (await screen.boundingBox())!.width).toBeGreaterThan(before + 150);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    expect(await terminal.evaluate(element => element === document.querySelector('.terminal-host .xterm'))).toBe(true);
    await expect(page.locator('.session-header .status-tag')).toContainText('运行中');
    await page.locator('.terminal-host').click();
    await page.keyboard.type(process.platform === 'win32' ? "Write-Output ('INSPECTOR_CLOSED_' + $env:CC_DESK_INSPECTOR_SENTINEL)" : "printf '\\nINSPECTOR_CLOSED_%s\\n' \"$CC_DESK_INSPECTOR_SENTINEL\"");
    await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(async id => (await window.desktop.terminalSnapshot(id)).chunks.map(chunk => chunk.data).join(''), f.shell.id)).toContain('INSPECTOR_CLOSED_still_alive');
    await panelToggle(page, '上下文').click();
    await expectActivePanel(page, '上下文');
    await expect.poll(async () => Math.abs((await screen.boundingBox())!.width - before)).toBeLessThan(12);
    expect(await terminal.evaluate(element => element === document.querySelector('.terminal-host .xterm'))).toBe(true);
    await page.locator('.terminal-host').click();
    await page.keyboard.type(process.platform === 'win32' ? "Write-Output ('INSPECTOR_OPEN_' + $env:CC_DESK_INSPECTOR_SENTINEL)" : "printf '\\nINSPECTOR_OPEN_%s\\n' \"$CC_DESK_INSPECTOR_SENTINEL\"");
    await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(async id => (await window.desktop.terminalSnapshot(id)).chunks.map(chunk => chunk.data).join(''), f.shell.id)).toContain('INSPECTOR_OPEN_still_alive');
    for (const [width, height, uiFontSize] of [[1600, 1000, 13], [980, 680, 20]]) {
      await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setSize(w, h), [width, height]);
      await page.evaluate(async size => {
        const { state } = await window.desktop.snapshot();
        await window.desktop.saveSettings({ ...state.settings, uiFontSize: size });
      }, uiFontSize);
      await expect.poll(() => page.evaluate(() => Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-font-scale')))).toBeCloseTo(uiFontSize / 13, 5);
      for (const name of panelNames) {
        if (await panelToggle(page, name).getAttribute('aria-pressed') !== 'true') await panelToggle(page, name).click();
        await expectActivePanel(page, name);
        const region = panel(page, name);
        expect(await region.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
        await expect(page.getByRole('button', { name: `关闭${name}面板`, exact: true })).toBeInViewport({ ratio: 1 });
        const boxes = await Promise.all(panelNames.map(tool => panelToggle(page, tool).boundingBox()));
        for (let index = 1; index < boxes.length; index++) {
          expect(Math.abs(boxes[index]!.x - boxes[0]!.x)).toBeLessThan(2);
          expect(boxes[index]!.y).toBeGreaterThanOrEqual(boxes[index - 1]!.y + boxes[index - 1]!.height);
        }
        const regionBox = (await region.boundingBox())!, terminalBox = (await page.locator('.terminal-host').boundingBox())!;
        expect(boxes[0]!.x).toBeGreaterThan((await page.evaluate(() => innerWidth)) - 100);
        expect(regionBox.x + regionBox.width).toBeLessThanOrEqual(boxes[0]!.x);
        expect(regionBox.x).toBeGreaterThanOrEqual(terminalBox.x + terminalBox.width - 1);
        expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
      }
      await panelToggle(page, '上下文').click();
      await expectActivePanel(page, '上下文');
      expect(await terminal.evaluate(element => element === document.querySelector('.terminal-host .xterm'))).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(width === 1600 ? 'tool-windows-wide.png' : 'tool-windows-narrow-large-font.png') });
    }
    await page.getByRole('button', { name: '关闭上下文面板', exact: true }).click();
    await expectActivePanel(page, null);
    await page.screenshot({ path: testInfo.outputPath('tool-windows-narrow-closed.png') });
    await page.locator('.terminal-host').click();
    await page.keyboard.type(process.platform === 'win32' ? "Write-Output ('INSPECTOR_LAYOUT_' + $env:CC_DESK_INSPECTOR_SENTINEL)" : "printf '\\nINSPECTOR_LAYOUT_%s\\n' \"$CC_DESK_INSPECTOR_SENTINEL\"");
    await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(async id => (await window.desktop.terminalSnapshot(id)).chunks.map(chunk => chunk.data).join(''), f.shell.id)).toContain('INSPECTOR_LAYOUT_still_alive');
    await expect(page.locator('.session-header .status-tag')).toContainText('运行中');
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
