import { desktopRoot } from './helpers/paths';
import { electronLaunchArgs } from './helpers/electron-launch';
import { test, expect, _electron as electron, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { LegacyAppState as AppState, LegacySession as Session } from './helpers/legacy-workspace';
import type { ChatSnapshot } from '../src/shared/chat';
import { finishInspectorApp, installInspectorStopDiagnostics } from './helpers/inspector-cleanup';

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
    args: electronLaunchArgs(), cwd: desktopRoot,
    env: { ...process.env, WORKBENCH_TEST_MODE: '1', WORKBENCH_DATA_DIR: data },
  });
  return { first, second, shell, launch, dispose: () => fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) };
}

const panelNames = ['上下文', '变更', '工作流', '诊断'] as const;
type PanelName = typeof panelNames[number];
const panel = (page: Page, name: PanelName) => page.getByRole('region', { name: `${name}面板`, exact: true });
const panelToggle = (page: Page, name: PanelName) => page.getByRole('button', { name, exact: true });
const dock = (page: Page) => page.locator('#session-inspector .inspector-dock');
const openPanelsKey = 'cc-desk.inspector-selected-panel';
const panelIds: Record<PanelName, string> = { 上下文: 'context', 变更: 'git', 工作流: 'workflows', 诊断: 'diagnostics' };

async function expectOpenPanels(page: Page, open: readonly PanelName[]) {
  await expect(page.getByRole('complementary', { name: '会话详情', exact: true })).toBeVisible();
  for (const name of panelNames) {
    const selected = open.includes(name);
    await expect(panelToggle(page, name)).toBeInViewport({ ratio: 1 });
    await expect(panelToggle(page, name)).toHaveAttribute('aria-pressed', String(selected));
    await expect(panelToggle(page, name)).toHaveAttribute('aria-expanded', String(selected));
    if (selected) await expect(panel(page, name)).toBeVisible();
    else await expect(panel(page, name)).toBeHidden();
  }
  if (open.length) await expect(dock(page)).toBeVisible();
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
    await expectOpenPanels(page, ['上下文']);
    await expect(page.getByRole('button', { name: /^(收起|展开)右侧面板$/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^(折叠|展开)(上下文|变更|工作流|诊断)面板$/ })).toHaveCount(0);
    const chat = page.locator('.chat-pane'), toggle = panelToggle(page, '上下文');
    await expect(page.getByLabel('会话模型', { exact: true })).toHaveCount(0);
    await page.getByLabel('提示词编辑器', { exact: true }).fill('这段提示词还没有发送。');
    const modelNode = (await page.getByRole('button', { name: '会话设置', exact: true }).elementHandle())!;
    const chatNode = (await chat.elementHandle())!;
    const initialWidth = (await chat.boundingBox())!.width;
    await page.screenshot({ path: testInfo.outputPath('tool-window-open.png') });

    await toggle.focus();
    await page.keyboard.press('Enter');
    await expectOpenPanels(page, []);
    await expect(toggle).toBeFocused();
    await expect.poll(async () => (await chat.boundingBox())!.width).toBeGreaterThan(initialWidth + 200);
    // Hidden controls stay mounted but cannot steal keyboard focus from the rail.
    await modelNode.evaluate(element => (element as HTMLElement).focus());
    await expect(toggle).toBeFocused();
    expect(await modelNode.evaluate(element => element.isConnected)).toBe(true);
    expect(await chatNode.evaluate(element => element === document.querySelector('.chat-pane'))).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('tool-window-closed.png') });
    await page.keyboard.press('Space');
    await expectOpenPanels(page, ['上下文']);
    await expect(page.getByRole('button', { name: '会话设置', exact: true })).toBeVisible();
    expect(await modelNode.evaluate(element => element.isConnected)).toBe(true);
    await expect(page.getByLabel('提示词编辑器', { exact: true })).toHaveValue('这段提示词还没有发送。');
    expect((await page.evaluate(() => window.desktop.snapshot())).state.sessions.find(session => session.id === f.first.id)!.engineConfig.options.model).toBe('');

    await page.getByRole('button', { name: '会话设置', exact: true }).focus();
    await page.keyboard.press('Escape');
    await expectOpenPanels(page, ['上下文']);
    await page.keyboard.press('Shift+Escape');
    await expectOpenPanels(page, []);
    await expect(toggle).toBeFocused();
    await page.keyboard.press('Space');
    await expectOpenPanels(page, ['上下文']);
    await expect(page.getByRole('button', { name: '会话设置', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '关闭上下文面板', exact: true }).click();
    await expectOpenPanels(page, []);
    await expect(toggle).toBeFocused();
    for (const session of [f.second, f.first]) {
      await page.locator('.session-row').filter({ hasText: session.title }).click();
      await expect(page.getByRole('heading', { name: session.title, exact: true })).toBeVisible();
      await expectOpenPanels(page, []);
    }
    await expect.poll(() => page.evaluate(key => localStorage.getItem(key), openPanelsKey)).toBe('null');
    await expect(page.getByLabel('提示词编辑器', { exact: true })).toHaveValue('这段提示词还没有发送。');
    await app.close();
    app = await f.launch();
    page = await app.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    await expect(page.getByRole('heading', { name: f.first.title, exact: true })).toBeVisible();
    await expectOpenPanels(page, []);
    await panelToggle(page, '上下文').click();
    await expectOpenPanels(page, ['上下文']);
    await expect.poll(() => page.evaluate(key => localStorage.getItem(key), openPanelsKey)).toBe('"context"');
    await page.reload();
    await expectOpenPanels(page, ['上下文']);
    await expect(page.locator('.error-banner')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { await app.close(); await f.dispose(); }
});

test('inspector: one detail at a time preserves workflow drafts and width across switching and restart', async ({}, testInfo) => {
  const f = await workspace(); let app = await f.launch();
  try {
    let page = await app.firstWindow();
    await expect(page.getByRole('heading', { name: f.first.title, exact: true })).toBeVisible();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1600, 1000));
    const chatWidth = (await page.locator('.chat-pane').boundingBox())!.width;
    await panelToggle(page, '工作流').click(); await expectOpenPanels(page, ['工作流']);
    await expect(page.getByLabel('工作流目标')).toBeHidden();
    await page.getByRole('button', { name: '新建工作流', exact: true }).click();
    await page.getByLabel('工作流目标').fill('切换详情和重新启动后保留草稿。');
    await page.getByLabel('最大尝试次数').selectOption('3');
    const node = (await page.getByLabel('工作流目标').elementHandle())!;
    for (const name of ['变更', '诊断', '上下文'] as const) {
      await panelToggle(page, name).click(); await expectOpenPanels(page, [name]);
      expect(await node.evaluate(element => element.isConnected)).toBe(true);
      expect((await page.locator('.chat-pane').boundingBox())!.width).toBeGreaterThanOrEqual(chatWidth - 2);
    }
    await panelToggle(page, '工作流').click(); await expect(page.getByLabel('工作流目标')).toHaveValue('切换详情和重新启动后保留草稿。');
    const resize = page.getByRole('separator', { name: '调整会话详情宽度' });
    await resize.focus(); await page.keyboard.press('ArrowLeft');
    await expect(resize).toHaveAttribute('aria-valuenow', '360');
    await page.keyboard.press('Home'); await expect(resize).toHaveAttribute('aria-valuenow', '260');
    const before = (await panel(page, '工作流').boundingBox())!.width;
    const handle = (await resize.boundingBox())!;
    await page.mouse.move(handle.x + 2, handle.y + 60); await page.mouse.down();
    await page.mouse.move(handle.x - 58, handle.y + 60); await page.mouse.up();
    await expect.poll(async () => (await panel(page, '工作流').boundingBox())!.width).toBeGreaterThan(before + 50);
    const savedWidth = await resize.getAttribute('aria-valuenow');
    await page.getByRole('button', { name: '返回列表并保留草稿' }).click();
    await expect(page.getByLabel('工作流目标')).toBeHidden();
    await page.getByRole('button', { name: '新建工作流', exact: true }).click();
    await expect(page.getByLabel('工作流目标')).toHaveValue('切换详情和重新启动后保留草稿。');
    await page.screenshot({ path: testInfo.outputPath('single-detail-workflow.png') });
    await app.close(); app = await f.launch(); page = await app.firstWindow();
    await expectOpenPanels(page, ['工作流']);
    await expect(page.getByRole('separator', { name: '调整会话详情宽度' })).toHaveAttribute('aria-valuenow', savedWidth!);
    await expect(page.getByLabel('工作流目标')).toBeHidden();
    await page.getByRole('button', { name: '新建工作流', exact: true }).click();
    await expect(page.getByLabel('工作流目标')).toHaveValue('切换详情和重新启动后保留草稿。');
    await expect(page.getByLabel('最大尝试次数')).toHaveValue('3');
    await expect(page.locator('.error-banner')).toHaveCount(0);
  } finally { await app.close(); await f.dispose(); }
});

test('inspector: legacy layouts migrate to a single last-opened tool and preserve hidden choices', async () => {
  const f = await workspace(), app = await f.launch();
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole('heading', { name: f.first.title, exact: true })).toBeVisible();
    const migrations: { single?: string; visible: string; open: string[]; collapsed: string[]; expected: PanelName[] }[] = [
      { single: '"workflows"', visible: 'false', open: ['context', 'git'], collapsed: [], expected: ['工作流'] },
      { single: 'null', visible: 'true', open: ['context', 'git'], collapsed: [], expected: [] },
      { visible: 'false', open: ['context', 'git', 'workflows'], collapsed: [], expected: [] },
      { visible: 'true', open: ['diagnostics', 'invalid', 'workflows', 'git', 'context', 'git'], collapsed: ['context'], expected: ['变更'] },
    ];
    for (const migration of migrations) {
      await page.evaluate(({ key, single, visible, open, collapsed }) => {
        localStorage.removeItem(key); localStorage.removeItem('cc-desk.inspector-open-panels');
        localStorage.removeItem('cc-desk.inspector-active-panel');
        if (single !== undefined) localStorage.setItem('cc-desk.inspector-active-panel', single);
        localStorage.setItem('cc-desk.inspector-open', visible);
        localStorage.setItem('cc-desk.inspector-panels', JSON.stringify({ open, collapsed }));
      }, { key: openPanelsKey, ...migration });
      await page.reload();
      await expectOpenPanels(page, migration.expected);
      await expect.poll(() => page.evaluate(key => localStorage.getItem(key), openPanelsKey)).toBe(JSON.stringify(migration.expected.length ? panelIds[migration.expected[0]] : null));
    }
    // New choices override both previous preference formats on subsequent reloads.
    await panelToggle(page, '上下文').click();
    const all: PanelName[] = ['上下文'];
    await expectOpenPanels(page, all);
    await expect.poll(() => page.evaluate(key => localStorage.getItem(key), openPanelsKey)).toBe('"context"');
    await page.reload();
    await expectOpenPanels(page, all);
    await expect(page.locator('.error-banner')).toHaveCount(0);
  } finally { await app.close(); await f.dispose(); }
});

test('inspector: the vertical rail and single panel fit wide and narrow windows without restarting a running terminal', async ({}, testInfo) => {
  const f = await workspace(true), app = await f.launch();
  const failures: unknown[] = [];
  try {
    const page = await app.firstWindow(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await expect(page.getByRole('heading', { name: f.shell.title, exact: true })).toBeVisible();
    await app.evaluate(installInspectorStopDiagnostics, f.shell.id);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(980, 680));
    await expectOpenPanels(page, ['上下文']);
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
    await expectOpenPanels(page, []);
    await expect.poll(async () => (await screen.boundingBox())!.width).toBeGreaterThan(before + 150);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    expect(await terminal.evaluate(element => element === document.querySelector('.terminal-host .xterm'))).toBe(true);
    await expect(page.locator('.session-header .status-tag')).toContainText('运行中');
    await page.locator('.terminal-host').click();
    await page.keyboard.type(process.platform === 'win32' ? "Write-Output ('INSPECTOR_CLOSED_' + $env:CC_DESK_INSPECTOR_SENTINEL)" : "printf '\\nINSPECTOR_CLOSED_%s\\n' \"$CC_DESK_INSPECTOR_SENTINEL\"");
    await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(async id => (await window.desktop.terminalSnapshot(id)).chunks.map(chunk => chunk.data).join(''), f.shell.id)).toContain('INSPECTOR_CLOSED_still_alive');
    await panelToggle(page, '上下文').click();
    await expectOpenPanels(page, ['上下文']);
    await expect.poll(async () => Math.abs((await screen.boundingBox())!.width - before)).toBeLessThan(12);
    expect(await terminal.evaluate(element => element === document.querySelector('.terminal-host .xterm'))).toBe(true);
    await page.locator('.terminal-host').click();
    await page.keyboard.type(process.platform === 'win32' ? "Write-Output ('INSPECTOR_OPEN_' + $env:CC_DESK_INSPECTOR_SENTINEL)" : "printf '\\nINSPECTOR_OPEN_%s\\n' \"$CC_DESK_INSPECTOR_SENTINEL\"");
    await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(async id => (await window.desktop.terminalSnapshot(id)).chunks.map(chunk => chunk.data).join(''), f.shell.id)).toContain('INSPECTOR_OPEN_still_alive');
    for (const name of panelNames.slice(1)) {
      await panelToggle(page, name).click();
      await expect(page.getByRole('button', { name: `关闭${name}面板`, exact: true })).toBeInViewport({ ratio: 1 });
      await expect(panelToggle(page, name)).toBeFocused();
    }
    for (const [width, height, uiFontSize] of [[1600, 1000, 13], [980, 680, 20]]) {
      await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setSize(w, h), [width, height]);
      await page.evaluate(async size => {
        const { state } = await window.desktop.snapshot();
        await window.desktop.saveSettings({ ...state.settings, uiFontSize: size });
      }, uiFontSize);
      await expect.poll(() => page.evaluate(() => Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-font-scale')))).toBeCloseTo(uiFontSize / 13, 5);
      await expect.poll(async () => (await page.locator('.session-content').boundingBox())!.width >= 1100).toBe(width === 1600);
      await expectOpenPanels(page, ['诊断']);
      const railBoxes = await Promise.all(panelNames.map(tool => panelToggle(page, tool).boundingBox()));
      for (let index = 1; index < railBoxes.length; index++) {
        expect(Math.abs(railBoxes[index]!.x - railBoxes[0]!.x)).toBeLessThan(2);
        expect(railBoxes[index]!.y).toBeGreaterThanOrEqual(railBoxes[index - 1]!.y + railBoxes[index - 1]!.height);
      }
      expect(railBoxes[0]!.x).toBeGreaterThan((await page.evaluate(() => innerWidth)) - 100);
      for (const name of panelNames) {
        if (await panelToggle(page, name).getAttribute('aria-pressed') !== 'true') await panelToggle(page, name).click();
        const region = panel(page, name);
        expect(await region.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
        const close = page.getByRole('button', { name: `关闭${name}面板`, exact: true });
        // Center explicitly: Chromium's conditional scrolling can retain a
        // fractional clipped edge in the narrow, large-font scrolling grid.
        await close.evaluate(element => element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }));
        await expect(close).toBeInViewport({ ratio: 1 });
        await expectOpenPanels(page, [name]);
        const regionBox = (await region.boundingBox())!, terminalBox = (await page.locator('.terminal-host').boundingBox())!;
        expect(regionBox.x + regionBox.width).toBeLessThanOrEqual(railBoxes[0]!.x);
        expect(regionBox.x).toBeGreaterThanOrEqual(terminalBox.x + terminalBox.width - 1);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
      expect(await terminal.evaluate(element => element === document.querySelector('.terminal-host .xterm'))).toBe(true);
      await dock(page).evaluate(element => { element.scrollTop = 0; });
      await page.screenshot({ path: testInfo.outputPath(width === 1600 ? 'tool-panels-wide.png' : 'tool-panels-narrow-large-font.png') });
    }
    for (let index = panelNames.length - 1; index >= 0; index--) {
      const name = panelNames[index];
      if (await panelToggle(page, name).getAttribute('aria-pressed') !== 'true') await panelToggle(page, name).click();
      const close = page.getByRole('button', { name: `关闭${name}面板`, exact: true });
      await close.evaluate(element => element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }));
      await expect(close).toBeInViewport({ ratio: 1 });
      if (await panelToggle(page, name).getAttribute('aria-pressed') !== 'true') await panelToggle(page, name).click();
      await close.click();
      await expectOpenPanels(page, []);
      await expect(panelToggle(page, name)).toBeFocused();
    }
    await page.screenshot({ path: testInfo.outputPath('tool-panels-narrow-closed.png') });
    await page.locator('.terminal-host').click();
    await page.keyboard.type(process.platform === 'win32' ? "Write-Output ('INSPECTOR_LAYOUT_' + $env:CC_DESK_INSPECTOR_SENTINEL)" : "printf '\\nINSPECTOR_LAYOUT_%s\\n' \"$CC_DESK_INSPECTOR_SENTINEL\"");
    await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(async id => (await window.desktop.terminalSnapshot(id)).chunks.map(chunk => chunk.data).join(''), f.shell.id)).toContain('INSPECTOR_LAYOUT_still_alive');
    await expect(page.locator('.session-header .status-tag')).toContainText('运行中');
    await expect(page.locator('.error-banner')).toHaveCount(0);
    expect(errors).toEqual([]);
  } catch (error) { failures.push(error); }
  finally {
    await finishInspectorApp(app, f.shell.id, testInfo.attach.bind(testInfo), failures);
    await f.dispose();
  }
});
