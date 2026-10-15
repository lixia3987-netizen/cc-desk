import { expect, type ElectronApplication, type Page } from '@playwright/test';
import type { NewSession } from '../../src/shared/types';

export function sessionRow(page: Page, title: string) {
  return page.locator('.session-row').filter({ has: page.getByText(title, { exact: true }) });
}

export async function sessionAction(page: Page, title: string, action: string) {
  await sessionRow(page, title).click({ button: 'right' });
  await page.getByRole('menu').getByRole('menuitem', { name: action, exact: true }).click();
}

/** 创建空的历史会话，无须通过新建会话页面发送用户任务。 */
export async function createSessionFixture(page: Page, input: Partial<NewSession> & { title: string }) {
  const session = await page.evaluate(async serialized => {
    const input = JSON.parse(serialized) as Partial<NewSession> & { title: string };
    const state = (await window.desktop.snapshot()).state;
    const projectId = state.sessions.find(value => value.id === state.selectedSessionId)?.projectId ?? state.projects[0].id;
    return window.desktop.createSession({ projectId, kind: 'agent', providerId: 'claude', mode: 'structured', isolated: false, ...input });
  }, JSON.stringify(input));
  await sessionRow(page, session.title).click();
  await expect(page.getByRole('heading', { name: session.title, exact: true })).toBeVisible();
  return session;
}

/** 会话创建与 Git 使用真实实现；这些界面测试装置不运行依赖账号的 Claude 任务。 */
export async function stubChatSubmission(app: ElectronApplication) {
  // Electron 启动完成时，宿主可能尚未注册全部 IPC 处理函数。
  // 仅在启动后安装覆盖实现，否则宿主注册时可能抛出异常。
  const page = await app.firstWindow();
  await expect(page.locator('main.workspace')).toBeVisible();
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('chat:submit');
    ipcMain.handle('chat:submit', (_event, input: { requestId?: string }) => ({ messageId: input.requestId ?? 'ui-fixture-message' }));
  });
}

export async function submitNewSession(page: Page, text = 'Verify this prepared workspace') {
  const form = page.getByRole('region', { name: '新建会话', exact: true });
  await form.getByLabel('提示词编辑器', { exact: true }).fill(text);
  await form.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(form).toHaveCount(0);
}

export async function openNewSessionOptions(page: Page) {
  const options = page.getByRole('region', { name: '新建会话', exact: true }).locator('details.new-session-more-options');
  if (!(await options.evaluate(element => (element as HTMLDetailsElement).open))) await options.locator('summary').click();
}
