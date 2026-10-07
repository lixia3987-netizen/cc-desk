import { expect, type Page } from '@playwright/test';

const sections = {
  model: ['模型与上下文', '模型连接'],
  context: ['模型与上下文', '上下文预算'],
  compaction: ['模型与上下文', '自动压缩'],
  limits: ['运行与权限', '运行限制'],
  recovery: ['运行与权限', '失败恢复'],
  permissions: ['运行与权限', '权限与审批'],
  tools: ['工具与扩展', '会话工具'],
} as const;

export async function openSessionSettings(page: Page, group: keyof typeof sections) {
  const dialog = page.getByRole('dialog', { name: '设置与连接', exact: true });
  if (!(await dialog.count())) await page.getByRole('button', { name: '会话设置', exact: true }).click();
  const [category, section] = sections[group];
  await dialog.getByRole('tablist', { name: '设置分类', exact: true }).getByRole('tab', { name: category, exact: true }).click();
  await dialog.getByRole('tablist', { name: category + '分类', exact: true }).getByRole('tab', { name: section, exact: true }).click();
  await dialog.getByRole('radio', { name: '当前会话', exact: true }).click();
  await expect(dialog.getByRole('radio', { name: '当前会话', exact: true })).toHaveAttribute('aria-checked', 'true');
  return dialog;
}

export async function closeSessionSettings(page: Page) {
  await page.getByRole('dialog', { name: '设置与连接', exact: true }).getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '设置与连接', exact: true })).toHaveCount(0);
}
