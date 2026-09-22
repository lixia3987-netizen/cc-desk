import { test, expect, _electron as electron, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { AppState, Session } from '../src/shared/types';
import type { ChatSnapshot } from '../src/shared/chat';

const choices = [
  { id: 'forest', name: '森野绿' },
  { id: 'cloud', name: '云白靛' },
  { id: 'sand', name: '暖砂陶' },
  { id: 'midnight', name: '极夜蓝' },
  { id: 'amber', name: '墨黑琥珀' },
] as const;

/** Measure rendered text against its actual opaque ancestor, not just palette tokens. */
async function textContrast(page: Page, selector: string) {
  return page.locator(selector).first().evaluate(element => {
    const rgb = (color: string) => color.match(/[\d.]+/g)!.map(Number);
    let ancestor: Element | null = element;
    let background = [255, 255, 255];
    while (ancestor) {
      const candidate = rgb(getComputedStyle(ancestor).backgroundColor);
      if (candidate.length === 3 || candidate[3] === 1) { background = candidate; break; }
      ancestor = ancestor.parentElement;
    }
    const luminance = (color: number[]) => color.slice(0, 3).reduce((sum, channel, index) => {
      const value = channel / 255;
      return sum + (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][index];
    }, 0);
    const text = luminance(rgb(getComputedStyle(element).color));
    const surface = luminance(background);
    return (Math.max(text, surface) + 0.05) / (Math.min(text, surface) + 0.05);
  });
}

test('themes: five readable themes preserve a live terminal, cancel previews and survive restart', async () => {
  test.setTimeout(90_000);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-desk-themes-'));
  const projectPath = path.join(directory, 'theme-preview');
  const dataPath = path.join(directory, 'data');
  await fs.mkdir(projectPath);
  await fs.mkdir(path.join(dataPath, 'chat'), { recursive: true });
  execFileSync('git', ['init', '--quiet'], { cwd: projectPath });
  execFileSync('git', ['config', 'user.email', 'themes@example.invalid'], { cwd: projectPath });
  execFileSync('git', ['config', 'user.name', 'Theme Verification'], { cwd: projectPath });
  await fs.writeFile(path.join(projectPath, 'theme.ts'), 'export const defaultTheme = "forest";\nexport const preserveTerminal = false;\n');
  execFileSync('git', ['add', '.'], { cwd: projectPath });
  execFileSync('git', ['commit', '--quiet', '-m', 'theme preview fixture'], { cwd: projectPath });
  await fs.writeFile(path.join(projectPath, 'theme.ts'), 'export const defaultTheme = "forest";\nexport const preserveTerminal = true;\nexport const themes = ["forest", "cloud", "sand", "midnight", "amber"];\n');
  const now = '2026-09-22T08:00:00.000Z';
  const projectId = randomUUID();
  const shellId = randomUUID();
  const chatId = randomUUID();
  const canonicalPath = await fs.realpath(projectPath);
  const common: Omit<Session, 'id' | 'title' | 'kind' | 'claudeId'> = {
    projectId, cwd: canonicalPath, started: false, model: '', effort: 'default', permissionMode: 'default',
    status: 'idle', archived: false, createdAt: now, updatedAt: now,
  };
  // A genuine pre-theme workspace verifies migration without touching the user's profile.
  const state: AppState = {
    version: 1,
    settings: { claudePath: path.join(directory, 'uninstalled-claude'), shellPath: '', maxSessions: 4, fontSize: 14, scrollback: 8000 },
    projects: [{ id: projectId, name: '界面主题工作室', path: canonicalPath, createdAt: now }],
    sessions: [
      { ...common, id: chatId, claudeId: randomUUID(), title: '五种主题 · 同样清晰', kind: 'claude', adapter: 'structured', taskState: 'completed' },
      { ...common, id: shellId, claudeId: randomUUID(), title: '持续运行的终端', kind: 'shell', adapter: 'terminal' },
    ],
    selectedSessionId: shellId,
  };
  const snapshot: ChatSnapshot = {
    sessionId: chatId, taskState: 'completed', pending: [], model: '本地展示记录',
    messages: [
      { id: 'user-1', turnId: 'turn-1', role: 'user', createdAt: now, text: '设计五套风格明显不同的主题，保持文字、代码和操作状态清晰可辨。' },
      { id: 'assistant-1', turnId: 'turn-1', role: 'assistant', createdAt: now, text: [
        '### 让专注有自己的颜色',
        '深色、明亮和暖色界面共用相同布局。正文、次要说明与操作按钮保持清晰，主题切换会保留正在运行的任务。',
        '```typescript\nconst themes = ["forest", "cloud", "sand", "midnight", "amber"];\n\nfunction selectTheme(id: ThemeId) {\n  applyTheme(id); // 保留终端连接与对话草稿\n}\n```',
        '**检查结果**：代码高亮、增删差异和键盘焦点均可辨识。',
      ].join('\n\n') },
    ],
  };
  await fs.writeFile(path.join(dataPath, 'workspace.json'), JSON.stringify(state));
  await fs.writeFile(path.join(dataPath, 'chat', chatId + '.json'), JSON.stringify(snapshot));
  await fs.mkdir('docs/themes', { recursive: true });
  const launch = () => electron.launch({
    args: ['.', ...(process.platform === 'linux' ? ['--no-sandbox', `--ozone-platform=${process.env.DISPLAY ? 'x11' : 'headless'}`, '--disable-gpu'] : [])],
    env: { ...process.env, WORKBENCH_TEST_MODE: '1', WORKBENCH_DATA_DIR: dataPath },
  });
  let app = await launch();
  const rendererErrors: string[] = [];
  try {
    let page = await app.firstWindow();
    page.on('pageerror', error => rendererErrors.push(error.message));
    await expect(page.getByRole('heading', { name: '持续运行的终端', exact: true })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'forest');
    await expect(page.evaluate(async () => {
      const { state } = await window.desktop.snapshot();
      await window.desktop.saveSettings({ ...state.settings, theme: 'not-a-theme' } as never);
    })).rejects.toThrow();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'forest');
    await page.getByRole('button', { name: '启动会话', exact: true }).click();
    await expect(page.locator('.session-header .status-tag')).toContainText('运行中');
    const terminal = await page.locator('.terminal-host .xterm').elementHandle();
    expect(terminal).not.toBeNull();
    await page.locator('.terminal-host').click();
    await page.keyboard.type(process.platform === 'win32' ? "$env:CC_DESK_THEME_SENTINEL='still_alive'" : "CC_DESK_THEME_SENTINEL='still_alive'");
    await page.keyboard.press('Enter');
    const mainBackgrounds = new Set<string>();
    for (const choice of choices) {
      await page.getByRole('button', { name: '设置与连接', exact: false }).click();
      const radio = page.getByRole('radio', { name: choice.name, exact: true });
      await radio.check();
      await expect(radio).toBeChecked();
      await expect(page.locator('html')).toHaveAttribute('data-theme', choice.id);
      await expect(page.getByRole('button', { name: '保存设置', exact: true })).toBeInViewport({ ratio: 1 });
      await radio.focus();
      await page.keyboard.press('Tab');
      await page.keyboard.press('Shift+Tab');
      await expect(radio).toBeFocused();
      // Keyboard users retain a visible focus ring in every palette.
      const focusStyle = await radio.evaluate(element => {
        const style = getComputedStyle(element);
        const parentStyle = getComputedStyle(element.parentElement!);
        return { outline: style.outlineStyle, parentOutline: parentStyle.outlineStyle, shadow: parentStyle.boxShadow };
      });
      expect(focusStyle.outline !== 'none' || focusStyle.parentOutline !== 'none' || focusStyle.shadow !== 'none').toBe(true);
      if (choice.id === 'forest') {
        for (const option of choices) await expect(page.getByRole('radio', { name: option.name, exact: true })).toBeInViewport();
        const footerBottomGap = () => page.locator('.preferences').evaluate(modal => Math.abs(modal.getBoundingClientRect().bottom - modal.querySelector('form > .modal-actions')!.getBoundingClientRect().bottom));
        await expect.poll(footerBottomGap).toBeLessThanOrEqual(2);
        await page.screenshot({ path: 'docs/themes/settings.png' });
        await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setSize(980, 680); });
        await expect(page.getByRole('button', { name: '保存设置', exact: true })).toBeInViewport({ ratio: 1 });
        await expect.poll(footerBottomGap).toBeLessThanOrEqual(2);
        await expect(page.getByRole('radio', { name: '墨黑琥珀', exact: true })).toBeInViewport();
        await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setSize(1460, 920); });
      }
      await page.getByRole('button', { name: '保存设置', exact: true }).click();
      await expect.poll(() => page.evaluate(async () => (await window.desktop.snapshot()).state.settings.theme ?? 'forest')).toBe(choice.id);
      await expect(page.getByRole('button', { name: '保存设置', exact: true })).toBeEnabled();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      expect(await terminal!.evaluate(element => element.isConnected && element === document.querySelector('.terminal-host .xterm'))).toBe(true);
      await expect(page.locator('.session-header .status-tag')).toContainText('运行中');
      await page.locator('.terminal-host').click();
      const prefix = 'THEME_' + choice.id + '_';
      await page.keyboard.type(process.platform === 'win32' ? `Write-Output ('${prefix}' + $env:CC_DESK_THEME_SENTINEL)` : `printf '\\n${prefix}%s\\n' "$CC_DESK_THEME_SENTINEL"`);
      await page.keyboard.press('Enter');
      await expect.poll(() => page.evaluate(async id => (await window.desktop.terminalSnapshot(id)).chunks.map(chunk => chunk.data).join(''), shellId)).toContain(prefix + 'still_alive');
      await page.locator('.session-row').filter({ hasText: '五种主题 · 同样清晰' }).click();
      await expect(page.locator('.message-code')).toBeVisible();
      await page.getByRole('tab', { name: '变更', exact: true }).click();
      await page.locator('.changed-files button').filter({ hasText: 'theme.ts' }).click();
      await expect(page.getByLabel('代码差异')).toContainText('+export const preserveTerminal = true;');
      await page.getByLabel('提示词编辑器').fill('请保持代码与正文易读，并保留当前任务和草稿。');
      mainBackgrounds.add(await page.locator('.workspace').evaluate(element => getComputedStyle(element).backgroundColor));
      for (const selector of ['.message-markdown p', '.session-row.active strong', '.statusbar', '.chat-meta', '.diff-view .added', '.diff-view .removed']) {
        expect(await textContrast(page, selector), `${choice.id}: ${selector}`).toBeGreaterThanOrEqual(4.5);
      }
      await expect(page.locator('.error-banner')).toHaveCount(0);
      await page.locator('.chat-scroll').evaluate(element => { element.scrollTop = 0; });
      await page.screenshot({ path: `docs/themes/${choice.id}.png` });
      await page.locator('.session-row').filter({ hasText: '持续运行的终端' }).click();
      expect(await terminal!.evaluate(element => element.isConnected && element === document.querySelector('.terminal-host .xterm'))).toBe(true);
    }
    expect(mainBackgrounds.size).toBe(5);
    await page.getByRole('button', { name: '设置与连接', exact: false }).click();
    await page.getByRole('radio', { name: '云白靛', exact: true }).check();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'cloud');
    await page.keyboard.press('Escape');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'amber');
    expect((await page.evaluate(async () => (await window.desktop.snapshot()).state.settings)).theme).toBe('amber');
    expect(rendererErrors).toEqual([]);
    await page.getByRole('button', { name: '停止', exact: true }).click();
    await expect(page.locator('.session-header .status-tag')).toContainText('已停止');
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    page.on('pageerror', error => rendererErrors.push(error.message));
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'amber');
    await expect(page.getByRole('heading', { name: '持续运行的终端', exact: true })).toBeVisible();
    await page.locator('.session-row').filter({ hasText: '五种主题 · 同样清晰' }).click();
    await expect(page.getByLabel('提示词编辑器')).toHaveValue('请保持代码与正文易读，并保留当前任务和草稿。');
    await expect(page.locator('.chat-message.assistant')).toHaveCount(1);
    expect(rendererErrors).toEqual([]);
  } finally {
    const page = await app.firstWindow().catch(() => null);
    if (page) {
      await page.evaluate(async id => { await window.desktop.stopSession(id); }, shellId).catch(() => {});
      await expect.poll(() => page.evaluate(async () => (await window.desktop.snapshot()).state.sessions.every(session => !['running', 'stopping'].includes(session.status))), { timeout: 5000 }).toBe(true).catch(() => {});
    }
    // A failing assertion must not leave an interactive quit dialog in CI.
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); }).catch(() => {});
    await app.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
