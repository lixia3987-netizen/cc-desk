import { expect, type ElectronApplication, type Page } from '@playwright/test';
import type { NewSession } from '../../src/shared/types';

export function sessionRow(page: Page, title: string) {
  return page.locator('.session-row').filter({ has: page.getByText(title, { exact: true }) });
}

export async function sessionAction(page: Page, title: string, action: string) {
  await sessionRow(page, title).click({ button: 'right' });
  await page.getByRole('menu').getByRole('menuitem', { name: action, exact: true }).click();
}

/** Set up empty historical sessions without sending a user task through the new-session page. */
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

/** Keep session creation and Git real; these UI fixtures do not run account-dependent Claude tasks. */
export async function stubChatSubmission(app: ElectronApplication) {
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
