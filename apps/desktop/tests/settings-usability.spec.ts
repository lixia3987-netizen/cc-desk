import { test, expect, _electron as electron, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { desktopRoot } from './helpers/paths';
import { electronLaunchArgs } from './helpers/electron-launch';

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ccdesk-settings-usability-'));
  const data = path.join(directory, 'data'), cwd = path.join(directory, 'project');
  const sessionId = randomUUID(), projectId = randomUUID(), now = new Date().toISOString();
  await fs.mkdir(data); await fs.mkdir(cwd);
  await fs.writeFile(path.join(data, 'workspace.json'), JSON.stringify({ version: 3,
    projects: [{ id: projectId, name: '设置流程项目', path: cwd, createdAt: now }],
    sessions: [{ id: sessionId, projectId, title: '设置流程会话', kind: 'agent', cwd,
      execution: { providerId: 'native', mode: 'structured', conversationId: randomUUID() },
      engineConfig: { schemaVersion: 1, options: { connectionId: '', model: '', runtimePolicy: 'custom', inputBudgetMode: 'custom',
        maxInputTokens: 64000, maxOutputTokens: 4096, autoCompact: 'before_send', modelRetry: 'off', maxModelRequests: 12, maxToolCalls: 20, maxActiveMs: 300000 } },
      started: false, status: 'idle', archived: false, createdAt: now, updatedAt: now }], selectedSessionId: sessionId,
    settings: { claudePath: path.join(directory, 'missing-cli'), shellPath: '', maxSessions: 4, fontSize: 14, scrollback: 8000, engineDefaults: {} },
  }));
  const app = await electron.launch({ args: electronLaunchArgs(), cwd: desktopRoot, env: { ...process.env, WORKBENCH_TEST_MODE: '1', WORKBENCH_DATA_DIR: data } });
  const page = await app.firstWindow();
  await page.getByRole('button', { name: '设置与连接', exact: true }).click();
  return { app, page, sessionId, dispose: async () => { await app.close(); await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } };
}
async function models(page: Page) {
  await page.getByRole('tab', { name: '模型与上下文', exact: true }).click();
  await page.getByRole('tab', { name: '模型连接', exact: true }).click();
  return page.getByRole('region', { name: 'Native 模型连接', exact: true });
}

test('connection drafts remain visible after navigation and all close controls protect unsaved edits', async ({}, testInfo) => {
  const f = await fixture();
  try {
    const region = await models(f.page);
    await region.getByRole('button', { name: '新增模型连接', exact: true }).click();
    const name = region.getByLabel('Native 连接名称', { exact: true });
    await expect(name).toBeFocused();
    const bounds = await name.boundingBox(), content = await f.page.locator('.settings-content').boundingBox();
    expect(bounds!.y).toBeGreaterThanOrEqual(content!.y);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(content!.y + content!.height);
    await name.fill('尚未保存的连接草稿');
    await expect(f.page.locator('.settings-save-state')).toContainText('模型连接有未保存的更改');
    await expect(f.page.getByRole('button', { name: '保存设置', exact: true })).toHaveCount(0);
    await f.page.getByRole('tab', { name: '终端与CLI', exact: true }).click();
    await models(f.page);
    await expect(name).toHaveValue('尚未保存的连接草稿');
    await f.page.keyboard.press('Escape');
    const confirmation = f.page.getByRole('alert', { name: '未保存的修改', exact: true });
    await expect(confirmation).toContainText('模型连接');
    await f.page.getByRole('button', { name: '继续编辑', exact: true }).click();
    await expect(name).toHaveValue('尚未保存的连接草稿');
    await f.page.getByRole('button', { name: '关闭弹窗', exact: true }).click();
    await expect(confirmation).toBeVisible();
    await f.page.screenshot({ path: testInfo.outputPath('unsaved-settings-confirmation.png') });
    await f.page.getByRole('button', { name: '放弃未保存修改并关闭', exact: true }).click();
    await expect(f.page.getByRole('dialog', { name: '设置与连接', exact: true })).toHaveCount(0);
    expect((await f.page.evaluate(() => window.desktop.nativeConnections.list())).connections).toEqual([]);
  } finally { await f.dispose(); }
});

test('one session draft spans context, compaction and limits and saves the complete set once', async ({}, testInfo) => {
  const f = await fixture();
  try {
    await f.page.getByRole('tab', { name: '模型与上下文', exact: true }).click();
    await f.page.getByRole('tab', { name: '上下文预算', exact: true }).click();
    await f.page.getByRole('radio', { name: '当前会话', exact: true }).click();
    await expect(f.page.getByLabel('会话运行策略来源', { exact: true })).toHaveValue('custom');
    await f.page.getByLabel('会话输入预算（估算 tokens）', { exact: true }).fill('96000');
    await f.page.getByRole('tab', { name: '自动压缩', exact: true }).click();
    await f.page.getByLabel('会话自动压缩', { exact: true }).selectOption('off');
    await f.page.getByRole('tab', { name: '运行与权限', exact: true }).click();
    await f.page.getByLabel('会话每回合模型请求上限', { exact: true }).fill('18');
    await f.page.getByRole('tab', { name: '模型与上下文', exact: true }).click();
    await f.page.getByRole('tab', { name: '上下文预算', exact: true }).click();
    await expect(f.page.getByLabel('会话输入预算（估算 tokens）', { exact: true })).toHaveValue('96000');
    await expect(f.page.locator('.settings-save-state')).toContainText('当前会话有未保存的更改');
    await expect(f.page.getByRole('button', { name: '保存设置', exact: true })).toHaveCount(0);
    await f.page.getByRole('button', { name: '保存配置', exact: true }).click();
    await expect.poll(() => f.page.evaluate(async sessionId => (await window.desktop.snapshot()).state.sessions.find(item => item.id === sessionId)?.engineConfig.options, f.sessionId)).toMatchObject({ maxInputTokens: 96000, autoCompact: 'off', maxModelRequests: 18 });
    await f.page.screenshot({ path: testInfo.outputPath('session-policy-draft.png') });
    await f.page.getByRole('button', { name: '关闭', exact: true }).click();
    await expect(f.page.getByRole('dialog', { name: '设置与连接', exact: true })).toHaveCount(0);
  } finally { await f.dispose(); }
});
