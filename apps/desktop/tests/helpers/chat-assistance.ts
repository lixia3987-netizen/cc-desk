import { expect, type Page } from '@playwright/test';

export async function openChatAssistance(page: Page, kind: 'agents' | 'commands' | 'task') {
  if (kind === 'commands') {
    const button = page.getByRole('group', { name: '会话面板', exact: true }).getByRole('button', { name: '后台命令', exact: true });
    await expect(button).toBeVisible();
    if (await button.getAttribute('aria-expanded') !== 'true') await button.click();
    await expect(page.getByRole('region', { name: '后台命令面板', exact: true })).toBeVisible();
    return;
  }
  const names = { agents: /^子 Agent ·/, task: /^任务与验收 ·/ };
  const button = page.getByRole('group', { name: '执行辅助详情', exact: true }).getByRole('button', { name: names[kind] });
  await expect(button).toBeVisible();
  if (await button.getAttribute('aria-expanded') !== 'true') await button.click();
}
