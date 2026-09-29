import type { Page } from '@playwright/test';

export async function selectProjectFilter(page: Page, name: string) {
  await page.getByLabel('工作空间筛选', { exact: true }).click();
  await page.getByRole('option').filter({ has: page.getByText(name, { exact: true }) }).click();
}
