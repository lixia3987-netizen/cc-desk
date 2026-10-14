import { expect, type Page } from '@playwright/test';

export async function openChatAssistance(page: Page, kind: 'agents' | 'commands' | 'task') {
  const names = { agents: /^子 Agent ·/, commands: /^长命令 ·/, task: /^任务与验收 ·/ };
  const button = page.getByRole('group', { name: '执行辅助详情', exact: true }).getByRole('button', { name: names[kind] });
  await expect(button).toBeVisible();
  if (await button.getAttribute('aria-expanded') !== 'true') await button.click();
}
